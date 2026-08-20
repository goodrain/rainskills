"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createPortableSecureStateStore } = require("./helpers/portable-secure-state.js");

const registryPath = path.resolve(
  __dirname,
  "..",
  "rainbond-platform-installer",
  "scripts",
  "environment-registry.js"
);

const IDS = [
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
  "33333333-3333-4333-8333-333333333333",
];

function createFixture({ activeOperationIds = () => [] } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "rainskills-environments-"));
  const stateStore = createPortableSecureStateStore(home);
  const generated = [...IDS];
  let tick = 0;
  const { createEnvironmentRegistry } = require(registryPath);
  const registry = createEnvironmentRegistry({
    home,
    stateStore,
    randomUUID: () => generated.shift(),
    now: () => `2026-08-17T00:00:0${tick++}.000Z`,
    activeOperationIds,
  });
  return { home, registry };
}

test("the first environment becomes default and later environments preserve it", () => {
  const { registry } = createFixture();

  const first = registry.add({
    kind: "private",
    consoleOrigin: "https://prod.example.com/",
    connectionState: "connected",
  });
  const second = registry.add({
    kind: "private",
    consoleOrigin: "https://test.example.com",
    connectionState: "connected",
  });

  assert.equal(first.created, true);
  assert.equal(first.environment.name, "私有环境-prod.example.com");
  assert.equal(second.environment.name, "私有环境-test.example.com");
  assert.equal(registry.read().default_environment_id, first.environment.id);
  assert.equal(registry.list().length, 2);
});

test("automatic names use a deterministic suffix when host-derived names collide", () => {
  const { registry } = createFixture();

  const first = registry.add({
    kind: "private",
    consoleOrigin: "https://example.com:8443",
    connectionState: "connected",
  });
  const second = registry.add({
    kind: "private",
    consoleOrigin: "https://example.com:9443",
    connectionState: "connected",
  });

  assert.equal(first.environment.name, "私有环境-example.com");
  assert.equal(second.environment.name, "私有环境-example.com-2");
});

test("adding the same canonical origin returns the existing immutable environment", () => {
  const { registry } = createFixture();
  const first = registry.add({
    kind: "saas",
    consoleOrigin: "https://run.rainbond.com/",
    connectionState: "connected",
  });
  const second = registry.add({
    kind: "saas",
    consoleOrigin: "https://run.rainbond.com",
    connectionState: "needs-reconnect",
  });

  assert.equal(first.environment.name, "Rainbond Cloud");
  assert.equal(second.created, false);
  assert.equal(second.environment.id, first.environment.id);
  assert.equal(registry.list().length, 1);
});

test("rename keeps the immutable id and rejects normalized duplicate names", () => {
  const { registry } = createFixture();
  const production = registry.add({
    kind: "private",
    consoleOrigin: "https://prod.example.com",
    connectionState: "connected",
  }).environment;
  const testing = registry.add({
    kind: "private",
    consoleOrigin: "https://test.example.com",
    connectionState: "connected",
  }).environment;

  const renamed = registry.rename(production.id, " 生产环境 ");
  assert.equal(renamed.id, production.id);
  assert.equal(renamed.name, "生产环境");
  assert.throws(
    () => registry.rename(testing.id, "生产环境"),
    /环境名称已存在/
  );
});

test("set-default only changes future selection and default removal is refused", () => {
  const { registry } = createFixture();
  const first = registry.add({
    kind: "private",
    consoleOrigin: "https://prod.example.com",
    connectionState: "connected",
  }).environment;
  const second = registry.add({
    kind: "private",
    consoleOrigin: "https://test.example.com",
    connectionState: "connected",
  }).environment;

  registry.setDefault(second.id);
  assert.equal(registry.read().default_environment_id, second.id);
  assert.throws(() => registry.remove(second.id), /默认环境/);
  const removed = registry.remove(first.id);
  assert.equal(removed.id, first.id);
  assert.deepEqual(registry.list().map(({ id }) => id), [second.id]);
});

test("an environment used by an active operation cannot be removed and bytes stay unchanged", () => {
  let activeId = "";
  const { registry } = createFixture({
    activeOperationIds: (environmentId) => environmentId === activeId ? [IDS[2]] : [],
  });
  const first = registry.add({
    kind: "private",
    consoleOrigin: "https://prod.example.com",
    connectionState: "connected",
  }).environment;
  const second = registry.add({
    kind: "private",
    consoleOrigin: "https://test.example.com",
    connectionState: "connected",
  }).environment;
  registry.setDefault(second.id);
  activeId = first.id;
  const before = fs.readFileSync(registry.path);

  assert.throws(() => registry.remove(first.id), /活动操作/);
  assert.deepEqual(fs.readFileSync(registry.path), before);
});

test("stored registry rejects unknown fields without rewriting the protected file", () => {
  const { registry } = createFixture();
  registry.add({
    kind: "private",
    consoleOrigin: "https://prod.example.com",
    connectionState: "connected",
  });
  const payload = JSON.parse(fs.readFileSync(registry.path, "utf8"));
  payload.token = "must-not-be-accepted";
  fs.writeFileSync(registry.path, `${JSON.stringify(payload)}\n`, { mode: 0o600 });
  const before = fs.readFileSync(registry.path);

  assert.throws(() => registry.read(), /未知字段/);
  assert.deepEqual(fs.readFileSync(registry.path), before);
});

test("registry refuses a symlink state path", { skip: process.platform === "win32" }, () => {
  const { home, registry } = createFixture();
  const directory = path.dirname(registry.path);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const outside = path.join(home, "outside.json");
  fs.writeFileSync(outside, "{}\n", { mode: 0o600 });
  fs.symlinkSync(outside, registry.path);

  assert.throws(() => registry.read(), /符号链接/);
});
