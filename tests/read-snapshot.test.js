"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const snapshot = require("../bin/read-snapshot.js");
const { parseCommand } = require("../bin/rainskills-tools.js");

function request(name, args = {}) {
  return { name, arguments: args };
}

test("snapshot input is bounded and accepts only read-classified tools", () => {
  assert.throws(() => snapshot.validateSnapshotInput({ scope: "app", requests: [] }), /one to eight/i);
  assert.throws(() => snapshot.validateSnapshotInput({
    scope: "app",
    requests: [request("rainbond_update_app")],
  }), /read-only/i);
  assert.throws(() => snapshot.validateSnapshotInput({
    scope: "unknown",
    requests: [request("rainbond_get_app_detail")],
  }), /scope/i);
  assert.doesNotThrow(() => snapshot.validateSnapshotInput({
    scope: "app",
    requests: [request("rainbond_get_app_detail", { app_id: 1 })],
  }));
});

test("snapshot aggregates two backend reads into one fixed model-visible result", async () => {
  const calls = [];
  const output = await snapshot.executeReadSnapshot({
    scope: "delivery",
    requests: [
      request("rainbond_get_app_detail", { app_id: 1 }),
      request("rainbond_get_app_health_overview", { app_id: 1 }),
    ],
  }, {
    now: () => "2026-10-08T00:00:00.000Z",
    callTool: async (name, args) => {
      calls.push({ name, args });
      return name.endsWith("detail")
        ? { app_id: 1, app_name: "shop", password: "secret" }
        : { state: "runtime_healthy", authorization: "hidden" };
    },
  });
  assert.equal(calls.length, 2);
  assert.equal(output.schema, "rainskills.read-snapshot.v1");
  assert.equal(output.scope, "delivery");
  assert.equal(output.backend_requests, 2);
  assert.equal(output.evidence.length, 2);
  assert.doesNotMatch(JSON.stringify(output), /secret|hidden/);
});

test("log and event reads require explicit server-side bounds", () => {
  for (const name of ["rainbond_get_component_logs", "rainbond_list_component_events"]) {
    assert.throws(() => snapshot.validateSnapshotInput({
      scope: "component",
      requests: [request(name, { service_id: "svc" })],
    }), /cursor|since_seconds|tail/i);
    assert.doesNotThrow(() => snapshot.validateSnapshotInput({
      scope: "component",
      requests: [request(name, { service_id: "svc", tail: 100 })],
    }));
  }
});

test("snapshot preserves unavailable evidence and never retries failed reads", async () => {
  let calls = 0;
  const output = await snapshot.executeReadSnapshot({
    scope: "app",
    requests: [
      request("rainbond_get_app_detail", { app_id: 1 }),
      request("rainbond_get_app_health_overview", { app_id: 1 }),
    ],
  }, {
    now: () => "2026-10-08T00:00:00.000Z",
    callTool: async (name) => {
      calls += 1;
      if (name.endsWith("detail")) throw new Error("unavailable");
      return { state: "runtime_healthy" };
    },
  });
  assert.equal(calls, 2);
  assert.deepEqual(output.evidence[0], {
    tool: "rainbond_get_app_detail",
    available: false,
    unavailable_reason: "read-failed",
  });
});

test("CLI parser exposes one stdin-only snapshot invocation", () => {
  assert.deepEqual(parseCommand([
    "snapshot", "delivery", "--input", "-", "--skill-id", "rainbond-delivery-verifier",
  ]), {
    command: "snapshot",
    scope: "delivery",
    input: "-",
    skillId: "rainbond-delivery-verifier",
  });
  assert.throws(() => parseCommand([
    "snapshot", "delivery", "--input", "payload.json", "--skill-id", "rainbond-delivery-verifier",
  ]), /invalid command/i);
});
