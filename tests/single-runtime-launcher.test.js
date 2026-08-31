"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  parseRuntimeConnectArgs,
  runBuiltin,
} = require("../bin/rainskills.js");

test("runtime connect no longer carries a business intent or environment operation", () => {
  assert.deepEqual(parseRuntimeConnectArgs([
    "runtime", "connect", "codex", "--saas",
  ]), {
    targetClient: "codex",
    environmentChoice: "saas",
    rainbondUrl: "",
    allowInsecureHttp: false,
    privateLocation: undefined,
  });

  assert.throws(() => parseRuntimeConnectArgs([
    "runtime", "connect", "codex", "--saas",
    "--intent-json", JSON.stringify({ type: "deploy" }),
  ]), /unknown|unsupported|不再支持/i);
});

test("launcher no longer exposes environment registry or runtime operation commands", async () => {
  assert.equal(await runBuiltin(["environment", "list", "--json"], {
    write() {},
  }), false);
  assert.equal(await runBuiltin([
    "operation", "begin", "--operation-id", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  ], { write() {} }), false);
});

test("connected credential is persisted into the one runtime store", async () => {
  const writes = [];
  const operationId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const manager = {
    read: () => ({
      state: "connecting",
      operation_id: operationId,
      environment_kind: "private",
      console_origin: "https://rainbond.example.com",
    }),
  };

  assert.equal(await runBuiltin([
    "runtime", "persist-connect-credential", "--onboarding-id", operationId,
  ], {
    runtimeStateManager: manager,
    singleRuntimeStore: {
      write(value) { writes.push(value); },
    },
    credentialEnvironment: {
      RAINBOND_JWT: "header.payload.signature",
    },
  }), true);

  assert.deepEqual(writes, [{
    consoleOrigin: "https://rainbond.example.com",
    kind: "private",
    token: "header.payload.signature",
    allowInsecureHttp: false,
  }]);
});

test("connection state contains no business intent or retry state", () => {
  const source = fs.readFileSync(path.resolve(
    __dirname,
    "../rainbond-platform-installer/scripts/runtime-state.js"
  ), "utf8");
  assert.doesNotMatch(source, /failed_step|retry_budget|last_failure_category/);
  assert.doesNotMatch(source, /validateIntent|createIntentContinuation/);
});
