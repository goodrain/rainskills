"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createEnvironmentRegistry } = require(
  "../rainbond-platform-installer/scripts/environment-registry.js"
);

const localRuntime = path.resolve(
  __dirname,
  "../rainbond-platform-installer/scripts/local-runtime.js"
);

function isolatedHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "rainskills-local-runtime-"));
}

function runLocal(home, args) {
  return spawnSync(process.execPath, [localRuntime, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      PATH: "",
      npm_config_registry: "http://127.0.0.1:9",
    },
    timeout: 5000,
  });
}

test("local environment discovery returns an empty registry without npm or network", () => {
  const result = runLocal(isolatedHome(), ["environment", "list", "--json"]);

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    schema: "rainskills.environment-list.v1",
    default_environment_id: null,
    environments: [],
  });
});

test("local runtime renders onboarding copy without npm or network", () => {
  const result = runLocal(isolatedHome(), [
    "runtime", "message", "--id", "new-application-environment",
  ]);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /不过目前还没有可用的应用运行环境/);
  assert.match(result.stdout, /请选择应用要运行的环境/);
});

test("local runtime begins and completes an operation using a connected local record", () => {
  const home = isolatedHome();
  const registry = createEnvironmentRegistry({ home });
  const { environment } = registry.add({
    kind: "private",
    consoleOrigin: "https://console.example.com",
    connectionState: "connected",
    name: "测试环境",
  });
  const operationId = "1d6754d6-6fb3-4bda-9a04-15c2d261d178";
  const intent = JSON.stringify({
    type: "deploy",
    project_root: "/workspace/demo-2048",
    source_kind: "local",
  });

  const begin = runLocal(home, [
    "operation", "begin",
    "--operation-id", operationId,
    "--environment-id", environment.id,
    "--intent-json", intent,
  ]);
  assert.equal(begin.status, 0, begin.stderr);
  assert.deepEqual(JSON.parse(begin.stdout), {
    schema: "rainskills.operation-begin-result.v1",
    operation_id: operationId,
    environment_id: environment.id,
    intent: JSON.parse(intent),
    stage: "active",
  });

  const complete = runLocal(home, [
    "operation", "complete", "--operation-id", operationId,
  ]);
  assert.equal(complete.status, 0, complete.stderr);
  assert.equal(JSON.parse(complete.stdout).stage, "completed");
});
