"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { cliFixture } = require("./helpers/cli-fixture.js");
const tool = { name: "rainbond_manage_component_connection_envs", inputSchema: { type: "object", properties: { operation: { enum: ["create", "update"] } }, required: ["team_name", "region_name", "app_id", "service_id", "operation", "attr_name", "attr_value"] } };
const input = () => ({ schema: "rainskills.confirmed-batch.v1.request", scope: { team_name: "default", region_name: "region", app_id: 22 }, steps: ["first", "second"].map((key) => ({ key, tool: tool.name, arguments: { service_id: "db", operation: "create", attr_name: key, attr_value: "private-value-123" } })) });
test("CLI batch preflights once, audits each write, and cannot replay a confirmation", async (t) => {
  const fixture = await cliFixture(t, () => ({ structuredContent: { service_id: "db", password: "private-value-123", request_body: "private-value-123" } }), [tool]);
  const before = await fixture.run(["batch", "--input", "-"], input());
  assert.equal(before.code, 0, before.stderr);
  assert.equal(fixture.requests.filter((r) => r.method === "tools/call").length, 0);
  const args = ["batch", "--input", "-", "--confirm", before.value.confirmation_id];
  const result = await fixture.run(args, input());
  assert.equal(result.value.status, "succeeded", result.stderr);
  const writes = fixture.requests.filter((r) => r.method === "tools/call");
  assert.equal(writes.length, 2);
  assert(writes.every((r) => r.params._meta["com.rainbond/rainskills"].skill.id === "rainbond-fullstack-bootstrap"));
  assert.doesNotMatch(result.stdout, /private-value-123|request_body|password/);
  const replay = await fixture.run(args, input());
  assert.equal(replay.code, 2);
  assert.equal(fixture.requests.filter((r) => r.method === "tools/call").length, 2);
  const journals = fs.readdirSync(path.join(fixture.home, ".rainbond/operations")).filter((n) => n.endsWith(".json")).map((n) => fs.readFileSync(path.join(fixture.home, ".rainbond/operations", n), "utf8")).join("");
  assert.doesNotMatch(journals, /private-value-123/);
});
test("CLI batch binds scope and stops on an uncertain write", async (t) => {
  let calls = 0;
  const fixture = await cliFixture(t, (_params, res) => {
    calls += 1; if (calls === 1) { res.destroy(); return undefined; }
    return { structuredContent: {} };
  }, [tool]);
  const before = await fixture.run(["batch", "--input", "-"], input());
  const args = ["batch", "--input", "-", "--confirm", before.value.confirmation_id];
  const changed = input(); changed.scope.app_id = 23;
  assert.equal((await fixture.run(args, changed)).code, 2);
  const result = await fixture.run(args, input());
  assert.equal(result.value.status, "unknown", result.stderr);
  assert.equal(calls, 1);
});

test("CLI preflight reads configuration and skips unchanged connection values", async (t) => {
  let writes = 0;
  const summaryTool = { ...tool, inputSchema: { type: "object", properties: { operation: { enum: ["summary", "create", "update"] } }, required: ["team_name", "region_name", "app_id", "service_id", "operation"] } };
  const value = input(); value.steps = [value.steps[0]];
  const fixture = await cliFixture(t, (params) => {
    if (params.arguments.operation !== "summary") writes += 1;
    return { structuredContent: { connection_envs: { items: [{ attr_name: "first", attr_value: "public-value" }] } } };
  }, [summaryTool]);
  value.steps[0].arguments.attr_value = "public-value";
  const prepared = await fixture.run(["batch", "--input", "-"], value);
  assert.equal(prepared.value.steps[0].status, "skipped");
  const result = await fixture.run(["batch", "--input", "-", "--confirm", prepared.value.confirmation_id], value);
  assert.equal(result.value.skipped, 1);
  assert.equal(writes, 0);
});

test("waits stay read-only and event request bodies never enter query output", async (t) => {
  const fixture = await cliFixture(t, () => ({ structuredContent: { status: "success", recent_events: [{ event_id: "event", request_body: '{"MYSQL_PASSWORD":"leaked-value"}' }] } }), []);
  const invalid = await fixture.run(["read", "rainbond_wait_for_build_completion", "--input", "-"], { timeout: 61 });
  assert.equal(invalid.code, 2);
  assert.equal(fixture.requests.length, 0);
  const valid = await fixture.run(["read", "rainbond_wait_for_build_completion", "--input", "-"], { timeout: 60 });
  assert.equal(valid.code, 0, valid.stderr);
  assert.equal(valid.value.status, "success");
  assert.doesNotMatch(valid.stdout, /leaked-value|request_body|confirmation_id/);
});

test("cancelling during internal preflight cannot start its confirmed write", async () => {
  const { executeConfirmedToolCall } = require("../bin/rainskills-tools.js");
  const controller = new AbortController();
  let calls = 0;
  await assert.rejects(executeConfirmedToolCall({ skillId: "rainbond-fullstack-bootstrap", signal: controller.signal }, {}, tool.name, {}, async () => {
    calls += 1; controller.abort(); return { requires_confirmation: true, confirmation_id: "not-consumed" };
  }), (error) => error.code === "E_CANCELLED");
  assert.equal(calls, 1);
});

test("ordered writes invalidate later no-op decisions for the same resource", async (t) => {
  let protocol = "http";
  const ports = { name: "rainbond_manage_component_ports", inputSchema: { type: "object", properties: { operation: { enum: ["summary", "update_protocol"] }, protocol: { enum: ["http", "stream"] } }, required: ["service_id", "operation"] } };
  const fixture = await cliFixture(t, ({ arguments: args }) => {
    if (args.operation === "summary") return { structuredContent: { ports: { items: [{ container_port: 80, protocol }] } } };
    protocol = args.protocol; return { structuredContent: { service_id: "web" } };
  }, [ports]);
  const value = { schema: "rainskills.confirmed-batch.v1.request", scope: input().scope, steps: ["stream", "http"].map((p) => ({ key: p, tool: ports.name, arguments: { service_id: "web", operation: "update_protocol", port: 80, protocol: p } })) };
  const prepared = await fixture.run(["batch", "--input", "-"], value);
  assert.equal(prepared.value.steps[1].status, "planned");
  const result = await fixture.run(["batch", "--input", "-", "--confirm", prepared.value.confirmation_id], value);
  assert.equal(result.value.status, "succeeded");
  assert.equal(protocol, "http");
  assert.equal(result.value.completed, 2);
});
