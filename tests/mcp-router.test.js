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
const { createEnvironmentCredentialStore } = require(
  "../rainbond-platform-installer/scripts/environment-credentials.js"
);
const { createRuntimeOperationStore } = require(
  "../rainbond-platform-installer/scripts/runtime-operations.js"
);

const routerPath = path.resolve(
  __dirname,
  "..",
  "rainbond-platform-installer",
  "scripts",
  "mcp-router.js"
);

const ENV_PROD = "11111111-1111-4111-8111-111111111111";
const ENV_TEST = "22222222-2222-4222-8222-222222222222";
const OP_PROD = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OP_TEST = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function createFixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "rainskills-mcp-router-"));
  const stateStore = createPortableSecureStateStore(home);
  const ids = [ENV_PROD, ENV_TEST];
  const registry = createEnvironmentRegistry({
    home,
    stateStore,
    randomUUID: () => ids.shift(),
    now: () => "2026-08-17T00:00:00.000Z",
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
  const credentials = createEnvironmentCredentialStore({ home, stateStore });
  credentials.write({
    environmentId: production.id,
    origin: production.console_origin,
    token: "prod.payload.signature",
  });
  credentials.write({
    environmentId: testing.id,
    origin: testing.console_origin,
    token: "test.payload.signature",
  });
  const operations = createRuntimeOperationStore({
    home,
    stateStore,
    registry,
    now: () => "2026-08-17T00:00:01.000Z",
  });
  operations.begin({ operationId: OP_PROD, intent: { type: "deploy" } });
  operations.begin({
    operationId: OP_TEST,
    environmentId: testing.id,
    intent: { type: "deploy" },
  });
  return { credentials, operations, production, registry, testing };
}

function fakeClientFactory(calls, { failureByOrigin = {} } = {}) {
  return async ({ environment, credential }) => ({
    async listTools() {
      return {
        tools: [{
          name: "rainbond_echo",
          description: `Echo on ${environment.name}`,
          inputSchema: {
            type: "object",
            properties: { message: { type: "string" } },
            required: ["message"],
            additionalProperties: false,
          },
        }],
      };
    },
    async callTool(request) {
      calls.push({
        origin: environment.console_origin,
        token: credential.token,
        request,
      });
      if (failureByOrigin[environment.console_origin]) {
        throw failureByOrigin[environment.console_origin];
      }
      return {
        content: [{ type: "text", text: `${environment.name}:${request.arguments.message}` }],
      };
    },
    async close() {},
  });
}

test("tool discovery adds one required operation id without mutating remote schemas", async () => {
  const fixture = createFixture();
  const calls = [];
  const { createMcpRouter } = require(routerPath);
  const router = createMcpRouter({
    registry: fixture.registry,
    operationStore: fixture.operations,
    credentialStore: fixture.credentials,
    clientFactory: fakeClientFactory(calls),
  });

  const tools = await router.refreshTools();
  assert.equal(tools.length, 1);
  assert.deepEqual(tools[0].inputSchema.required.sort(), [
    "message", "rainskills_operation_id",
  ]);
  assert.deepEqual(tools[0].inputSchema.properties.rainskills_operation_id, {
    type: "string",
    format: "uuid",
    description: "Rainskills protected operation id",
  });
  assert.equal(tools[0].inputSchema.additionalProperties, false);
  assert.equal(calls.length, 0);
});

test("concurrent calls route by operation id and strip the reserved argument", async () => {
  const fixture = createFixture();
  const calls = [];
  const { createMcpRouter } = require(routerPath);
  const router = createMcpRouter({
    registry: fixture.registry,
    operationStore: fixture.operations,
    credentialStore: fixture.credentials,
    clientFactory: fakeClientFactory(calls),
  });
  await router.refreshTools();

  const [production, testing] = await Promise.all([
    router.callTool("rainbond_echo", {
      rainskills_operation_id: OP_PROD,
      message: "one",
    }),
    router.callTool("rainbond_echo", {
      rainskills_operation_id: OP_TEST,
      message: "two",
    }),
  ]);

  assert.deepEqual(production.content, [{ type: "text", text: "生产环境:one" }]);
  assert.deepEqual(testing.content, [{ type: "text", text: "测试环境:two" }]);
  assert.deepEqual(calls.map(({ origin, token, request }) => ({ origin, token, request })), [
    {
      origin: "https://prod.example.com",
      token: "prod.payload.signature",
      request: { name: "rainbond_echo", arguments: { message: "one" } },
    },
    {
      origin: "https://test.example.com",
      token: "test.payload.signature",
      request: { name: "rainbond_echo", arguments: { message: "two" } },
    },
  ]);
});

test("missing, unknown, and completed operations fail before upstream access", async () => {
  const fixture = createFixture();
  const calls = [];
  const { createMcpRouter } = require(routerPath);
  const router = createMcpRouter({
    registry: fixture.registry,
    operationStore: fixture.operations,
    credentialStore: fixture.credentials,
    clientFactory: fakeClientFactory(calls),
  });
  await router.refreshTools();

  await assert.rejects(
    () => router.callTool("rainbond_echo", { message: "missing" }),
    /operation id/
  );
  await assert.rejects(
    () => router.callTool("rainbond_echo", {
      rainskills_operation_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      message: "unknown",
    }),
    /不存在/
  );
  fixture.operations.complete(OP_PROD);
  await assert.rejects(
    () => router.callTool("rainbond_echo", {
      rainskills_operation_id: OP_PROD,
      message: "completed",
    }),
    /已完成/
  );
  assert.equal(calls.length, 0);
});

test("environment rename does not change operation routing", async () => {
  const fixture = createFixture();
  const calls = [];
  const { createMcpRouter } = require(routerPath);
  const router = createMcpRouter({
    registry: fixture.registry,
    operationStore: fixture.operations,
    credentialStore: fixture.credentials,
    clientFactory: fakeClientFactory(calls),
  });
  await router.refreshTools();
  fixture.registry.rename(fixture.testing.id, "新的测试名称");

  await router.callTool("rainbond_echo", {
    rainskills_operation_id: OP_TEST,
    message: "still-test",
  });
  assert.equal(calls[0].origin, "https://test.example.com");
});

test("one unreachable environment does not hide tools from another connected environment", async () => {
  const fixture = createFixture();
  const calls = [];
  const { createMcpRouter } = require(routerPath);
  const workingFactory = fakeClientFactory(calls);
  const router = createMcpRouter({
    registry: fixture.registry,
    operationStore: fixture.operations,
    credentialStore: fixture.credentials,
    clientFactory: async (input) => {
      if (input.environment.id === fixture.production.id) {
        throw new Error("unreachable production endpoint");
      }
      return workingFactory(input);
    },
  });

  const tools = await router.refreshTools();
  assert.deepEqual(tools.map(({ name }) => name), ["rainbond_echo"]);
  const result = await router.callTool("rainbond_echo", {
    rainskills_operation_id: OP_TEST,
    message: "available",
  });
  assert.deepEqual(result.content, [{ type: "text", text: "测试环境:available" }]);
  assert.equal(calls.length, 1);
});

test("401 records one environment-scoped retry and 403 never retries or leaks credentials", async () => {
  const fixture = createFixture();
  const calls = [];
  const unauthorized = new Error("upstream credential rejected");
  unauthorized.status = 401;
  const forbidden = new Error("upstream permission rejected");
  forbidden.status = 403;
  const { createMcpRouter } = require(routerPath);
  const router = createMcpRouter({
    registry: fixture.registry,
    operationStore: fixture.operations,
    credentialStore: fixture.credentials,
    clientFactory: fakeClientFactory(calls, {
      failureByOrigin: {
        "https://prod.example.com": unauthorized,
        "https://test.example.com": forbidden,
      },
    }),
  });
  await router.refreshTools();

  await assert.rejects(() => router.callTool("rainbond_echo", {
    rainskills_operation_id: OP_PROD,
    message: "unauthorized",
  }), /需要重新连接/);
  await assert.rejects(() => router.callTool("rainbond_echo", {
    rainskills_operation_id: OP_TEST,
    message: "forbidden",
  }), /权限不足/);
  assert.equal(fixture.operations.read(OP_PROD).retry_budget, 1);
  assert.equal(fixture.operations.read(OP_TEST).retry_budget, 0);
  const serialized = JSON.stringify(calls.map(({ request }) => request));
  assert.doesNotMatch(serialized, /prod\.payload|test\.payload/);
});
