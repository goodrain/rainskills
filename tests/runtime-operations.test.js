"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createPortableSecureStateStore } = require("./helpers/portable-secure-state.js");
const { createEnvironmentRegistry } = require(
  "../rainbond-platform-installer/scripts/environment-registry.js"
);

const operationsPath = path.resolve(
  __dirname,
  "..",
  "rainbond-platform-installer",
  "scripts",
  "runtime-operations.js"
);

const ENV_PROD = "11111111-1111-4111-8111-111111111111";
const ENV_TEST = "22222222-2222-4222-8222-222222222222";
const OP_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OP_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function createFixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "rainskills-operations-"));
  const stateStore = createPortableSecureStateStore(home);
  const environmentIds = [ENV_PROD, ENV_TEST];
  let tick = 0;
  const now = () => `2026-08-17T00:00:${String(tick++).padStart(2, "0")}.000Z`;
  const registry = createEnvironmentRegistry({
    home,
    stateStore,
    randomUUID: () => environmentIds.shift(),
    now,
  });
  const production = registry.add({
    kind: "private",
    consoleOrigin: "https://prod.example.com",
    connectionState: "connected",
    name: "生产环境",
  }).environment;
  const testing = registry.add({
    kind: "private",
    consoleOrigin: "https://test.example.com",
    connectionState: "connected",
    name: "测试环境",
  }).environment;
  const { createRuntimeOperationStore } = require(operationsPath);
  const operations = createRuntimeOperationStore({ home, stateStore, registry, now });
  return { home, stateStore, registry, operations, production, testing, now };
}

test("two operations for the same project lock independent environments", () => {
  const { operations, production, testing } = createFixture();
  const intent = { type: "deploy", project_root: "/workspace/demo" };

  const first = operations.begin({ operationId: OP_A, intent });
  const second = operations.begin({
    operationId: OP_B,
    environmentId: testing.id,
    intent,
  });

  assert.equal(first.environment_id, production.id);
  assert.equal(second.environment_id, testing.id);
  assert.deepEqual(first.intent, second.intent);
  assert.equal(Object.hasOwn(first, "project_environment_id"), false);
});

test("changing the default or environment name never changes an active operation", () => {
  const { operations, registry, production, testing } = createFixture();
  operations.begin({ operationId: OP_A, intent: { type: "deploy" } });

  registry.setDefault(testing.id);
  registry.rename(production.id, "旧生产环境");

  assert.equal(operations.read(OP_A).environment_id, production.id);
});

test("a pending operation preserves intent and binds an environment exactly once", () => {
  const { operations, testing } = createFixture();
  const pending = operations.createPending({
    operationId: OP_A,
    intent: { type: "deploy", project_root: "/workspace/demo" },
  });
  assert.equal(pending.environment_id, null);
  assert.equal(pending.stage, "awaiting-environment");

  const bound = operations.bindEnvironment(OP_A, testing.id);
  assert.equal(bound.environment_id, testing.id);
  assert.equal(bound.stage, "active");
  assert.throws(() => operations.bindEnvironment(OP_A, ENV_PROD), /已经锁定/);
});

test("team and app ids belong only to one operation and survive process restart", () => {
  const { home, stateStore, registry, operations, testing, now } = createFixture();
  operations.begin({
    operationId: OP_A,
    environmentId: testing.id,
    intent: { type: "deploy", project_root: "/workspace/demo" },
  });
  operations.updateTargets(OP_A, {
    teamId: "team-test",
    appId: "app-demo",
    serviceId: "service-web",
  });
  const { createRuntimeOperationStore } = require(operationsPath);
  const restarted = createRuntimeOperationStore({ home, stateStore, registry, now });

  assert.equal(restarted.read(OP_A).team_id, "team-test");
  assert.equal(restarted.read(OP_A).app_id, "app-demo");
  assert.equal(restarted.read(OP_A).service_id, "service-web");
  assert.equal(registry.get(testing.id).name, "测试环境");
});

test("credential expiry has one retry while permission denial has none", () => {
  const { operations } = createFixture();
  operations.begin({ operationId: OP_A, intent: { type: "deploy" } });
  const expired = operations.recordFailure(OP_A, {
    step: "build",
    reason: "credential-expired",
  });
  assert.equal(expired.retry_budget, 1);
  assert.equal(operations.consumeRetry(OP_A).retry_count, 1);
  assert.throws(() => operations.consumeRetry(OP_A), /已用尽/);

  operations.begin({ operationId: OP_B, intent: { type: "deploy" } });
  const denied = operations.recordFailure(OP_B, {
    step: "build",
    reason: "permission-denied",
  });
  assert.equal(denied.retry_budget, 0);
  assert.throws(() => operations.consumeRetry(OP_B), /权限/);
});

test("completed operations stop blocking environment deletion", () => {
  const { operations, production } = createFixture();
  operations.begin({ operationId: OP_A, intent: { type: "deploy" } });
  assert.deepEqual(operations.activeOperationIds(production.id), [OP_A]);
  operations.complete(OP_A);
  assert.deepEqual(operations.activeOperationIds(production.id), []);
});

test("structured target references distinguish environment and team names", () => {
  const { registry } = createFixture();
  const { resolveTargetReference } = require(operationsPath);

  assert.deepEqual(resolveTargetReference({
    registry,
    explicitTeamName: "测试环境",
    teamNames: ["测试环境"],
  }), {
    kind: "team",
    environment_id: ENV_PROD,
    team_name: "测试环境",
  });
  assert.deepEqual(resolveTargetReference({
    registry,
    explicitEnvironmentName: "测试环境",
    teamNames: ["测试环境"],
  }), {
    kind: "environment",
    environment_id: ENV_TEST,
  });
  assert.equal(resolveTargetReference({
    registry,
    bareTargetName: "测试环境",
    teamNames: ["测试环境"],
  }).kind, "ambiguous");
});

test("operation files reject unknown binding fields without rewriting bytes", () => {
  const { operations } = createFixture();
  operations.begin({ operationId: OP_A, intent: { type: "deploy" } });
  const operationPath = operations.pathFor(OP_A);
  const payload = JSON.parse(fs.readFileSync(operationPath, "utf8"));
  payload.project_default_environment_id = ENV_PROD;
  fs.writeFileSync(operationPath, `${JSON.stringify(payload)}\n`, { mode: 0o600 });
  const before = fs.readFileSync(operationPath);

  assert.throws(() => operations.read(OP_A), /未知字段/);
  assert.deepEqual(fs.readFileSync(operationPath), before);
});
