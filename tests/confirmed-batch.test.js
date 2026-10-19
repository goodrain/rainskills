"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const { validateBatch, executeBatch } = require("../bin/confirmed-batch.js");
const request = () => ({
  schema: "rainskills.confirmed-batch.v1.request",
  scope: { team_name: "default", region_name: "region", app_id: 22 },
  steps: ["one", "two", "three"].map((key) => ({ key, tool: "rainbond_manage_component_connection_envs", arguments: { service_id: "db", operation: "create", attr_name: key, attr_value: "secret-not-returned" } })),
});
test("batch rejects scope expansion, destructive actions, arbitrary bindings, and oversized requests", () => {
  const valid = request();
  assert.equal(validateBatch(valid)[0].arguments.app_id, 22);
  for (const mutate of [
    (v) => { v.steps[1].arguments.app_id = 23; },
    (v) => { v.steps[1].arguments.operation = "delete"; },
    (v) => { v.steps[1].tool = "rainbond_create_app"; },
    (v) => { v.steps[1].key = "one"; },
    (v) => { v.steps[1].result_ref = "arbitrary.path"; },
    (v) => { v.scope.app_id = 0; },
    (v) => { v.steps[1].arguments.attr_value = "a".repeat(132000); },
  ]) {
    const value = request(); mutate(value); assert.throws(() => validateBatch(value));
  }
});
test("batch validates all steps before the first mutation", async () => {
  let writes = 0;
  await assert.rejects(executeBatch(request(), {
    validate: async (_tool, args) => { if (args.attr_name === "two") throw new Error("invalid schema"); },
    call: async () => { writes += 1; },
  }));
  assert.equal(writes, 0);
});
test("batch stops at unknown results and returns no raw arguments or credentials", async () => {
  const seen = [];
  const result = await executeBatch(request(), {
    validate: async () => {},
    call: async (_tool, args) => {
      seen.push(args.attr_name);
      if (args.attr_name === "two") throw Object.assign(new Error("secret-not-returned"), { exitCode: 4, code: "E_WRITE_RESULT_UNKNOWN" });
      return { service_id: "db", request_body: "secret-not-returned", password: "secret-not-returned" };
    },
  });
  assert.deepEqual(seen, ["one", "two"]);
  assert.equal(result.status, "unknown");
  assert.deepEqual(result.steps.map((s) => s.status), ["succeeded", "unknown", "not_executed"]);
  assert.doesNotMatch(JSON.stringify(result), /secret-not-returned|request_body|password/);
});
test("batch distinguishes partial failure, success, and cancellation", async () => {
  const partial = await executeBatch(request(), {
    validate: async () => {},
    call: async (_t, args) => { if (args.attr_name === "two") throw Object.assign(new Error("rejected"), { exitCode: 5 }); return {}; },
  });
  assert.equal(partial.status, "partial");
  assert.equal(partial.completed, 1);
  const success = await executeBatch(request(), { validate: async () => {}, call: async () => ({}) });
  assert.equal(success.status, "succeeded");
  const controller = new AbortController(); controller.abort();
  const cancelled = await executeBatch(request(), { validate: async () => {}, signal: controller.signal, call: async () => { throw new Error("must not run"); } });
  assert.equal(cancelled.blocker.code, "E_CANCELLED");
});

test("satisfied configurations are skipped and wide successful metadata stays bounded", async () => {
  let writes = 0;
  const skipped = await executeBatch(request(), { validate: async () => {}, isSatisfied: async () => true, call: async () => { writes += 1; } });
  assert.equal(skipped.skipped, 3);
  assert.equal(writes, 0);
  assert(skipped.steps.every((step) => step.status === "skipped"));
  const wide = request(); wide.steps = Array.from({ length: 32 }, (_v, i) => ({ ...wide.steps[0], key: `step-${i}` }));
  const result = await executeBatch(wide, { validate: async () => {}, call: async () => ({ service_id: "界".repeat(128), event_id: "界".repeat(128), status: "running" }) });
  assert(Buffer.byteLength(JSON.stringify(result)) <= 8192);
  assert.equal(result.completed, 32);
  assert(result.steps.every((step) => step.status === "succeeded"));
});

test("configuration diffs preserve inner-port requests and do not compare redacted secrets", () => {
  const { configurationSatisfied } = require("../bin/confirmed-batch.js");
  const ports = { ports: { items: [{ container_port: 80, protocol: "http", is_inner_service: false, is_outer_service: false, port_alias: "WEB" }] } };
  assert.equal(configurationSatisfied("rainbond_manage_component_ports", { operation: "add", ports: [{ port: 80, protocol: "http", enable_inner: true }] }, ports), false);
  assert.equal(configurationSatisfied("rainbond_manage_component_ports", { operation: "disable_outer", port: 80 }, ports), true);
  assert.equal(configurationSatisfied("rainbond_manage_component_ports", { operation: "update_alias", port: 80, port_alias: "WEB" }, ports), true);
  assert.equal(configurationSatisfied("rainbond_manage_component_ports", { operation: "update_alias", port: 80, port_alias: "WEB", k8s_service_name: "new-service-name" }, ports), false);
  assert.equal(configurationSatisfied("rainbond_manage_component_dependency", { operation: "add", dep_service_id: "db" }, { dependencies: [{ service_id: "db" }] }), true);
  assert.equal(configurationSatisfied("rainbond_manage_component_dependency", { operation: "add", dep_service_id: "db", open_inner: true }, { dependencies: ["db"] }), false);
  assert.equal(configurationSatisfied("rainbond_manage_component_envs", { operation: "upsert", envs: [{ attr_name: "PORT", attr_value: "8080" }] }, { custom_envs: { items: [{ attr_name: "PORT", attr_value: "8080" }] } }), true);
  assert.equal(configurationSatisfied("rainbond_manage_component_connection_envs", { operation: "create", attr_name: "PASSWORD", attr_value: "[REDACTED]" }, { connection_envs: { items: [{ attr_name: "PASSWORD", attr_value: "[REDACTED]" }] } }), false);
});
