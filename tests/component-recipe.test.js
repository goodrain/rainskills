"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const { prepareRecipe, executeRecipe } = require("../bin/component-recipe.js");
const request = (kind = "image") => ({ schema: "rainskills.component-recipe.v1.request", scope: { team_name: "default", region_name: "region", app_id: 22 }, enterprise_id: "enterprise", kind, create: { service_cname: "backend", ...(kind === "image" ? { image: "example:1" } : kind === "source" ? { git_url: "https://example.invalid/repo", code_from: "git", code_version: "main" } : { event_id: "uploaded-event" }) }, configure: [{ key: "port", tool: "rainbond_manage_component_ports", arguments: { operation: "add", port: 5000, protocol: "http" } }] });
test("recipes retain exact source facts and configure only the returned service ID", async () => {
  for (const kind of ["image", "source", "package"]) {
    const seen = [];
    const result = await executeRecipe(request(kind), {
      validate: async () => {}, read: async (name) => name === "rainbond_query_components" ? { list: [], total: 0 } : { uploaded_packages: ["app.war"] },
      call: async (name, args) => { seen.push([name, args]); return { service_id: "verified-id", event_id: "build-event" }; },
    });
    assert.equal(result.status, "succeeded");
    assert.equal(seen[0][1].is_deploy, false);
    assert.equal(seen[1][1].service_id, "verified-id");
    assert.equal(result.next_action, "deploy_and_verify");
    if (kind === "source") assert.equal(seen[0][1].git_url, request(kind).create.git_url);
  }
});
test("recipe rejects unsupported strategy, premature deployment, scope changes, and missing persistent storage", () => {
  for (const change of [
    (v) => { v.kind = "template"; }, (v) => { v.create.is_deploy = true; },
    (v) => { v.create.app_id = 23; }, (v) => { v.stateful = true; },
    (v) => { v.configure[0].arguments.service_id = "guessed"; },
  ]) { const value = request(); change(value); assert.throws(() => prepareRecipe(value)); }
});
test("recipe refuses empty uploads and duplicate names before mutation", async () => {
  let writes = 0;
  for (const [input, read] of [
    [request("package"), async (name) => name === "rainbond_query_components" ? { list: [], total: 0 } : { uploaded_packages: [] }],
    [request(), async () => ({ list: [{ service_cname: "backend", service_id: "existing" }], total: 1 })],
  ]) await assert.rejects(executeRecipe(input, { validate: async () => {}, read, call: async () => { writes += 1; } }));
  assert.equal(writes, 0);
});
test("unknown creation stops without a second create or configuration", async () => {
  let writes = 0;
  await assert.rejects(executeRecipe(request(), {
    validate: async () => {}, read: async () => ({ list: [], total: 0 }),
    call: async () => { writes += 1; throw Object.assign(new Error("unknown"), { exitCode: 4 }); },
  }));
  assert.equal(writes, 1);
});

test("platform status cannot overwrite an uncertain storage result", async () => {
  const value = { ...request(), stateful: true, storage: { volume_name: "data", volume_type: "share-file", volume_path: "/data" } };
  const result = await executeRecipe(value, {
    validate: async () => {}, read: async () => ({ items: [], total: 0 }),
    call: async (name) => {
      if (name.includes("create_component")) return { service_id: "db", status: "created" };
      throw Object.assign(new Error("response lost"), { exitCode: 4 });
    },
  });
  assert.equal(result.status, "unknown");
  assert.equal(result.next_action, "query_state");
});

test("cancellation after creation retains the resource but sends no configuration or storage write", async () => {
  const controller = new AbortController();
  const value = { ...request(), stateful: true, storage: { volume_name: "data", volume_type: "share-file", volume_path: "/data" } };
  let writes = 0;
  const result = await executeRecipe(value, {
    signal: controller.signal, onCreated: async () => controller.abort(),
    validate: async () => {}, read: async () => ({ items: [], total: 0 }),
    call: async () => { writes += 1; return { service_id: "db" }; },
  });
  assert.equal(writes, 1);
  assert.equal(result.status, "partial");
  assert.equal(result.blocker.code, "E_CANCELLED");
});

test("incomplete discovery and malformed configuration stop before creating, while later configuration failure preserves the new resource", async () => {
  assert.throws(() => prepareRecipe({ ...request(), configure: [null] }), (error) => error.exitCode === 2);
  assert.throws(() => prepareRecipe({ ...request(), unexpected: true }), (error) => error.exitCode === 2);
  let writes = 0;
  await assert.rejects(executeRecipe(request(), {
    validate: async () => {}, read: async () => ({ items: [], total: 21 }),
    call: async () => { writes += 1; },
  }));
  assert.equal(writes, 0);
  const result = await executeRecipe(request(), {
    validate: async () => {}, read: async () => ({ items: [], total: 0 }),
    call: async (name) => {
      if (name.includes("create_component")) return { service_id: "created-id" };
      throw Object.assign(new Error("configuration rejected"), { exitCode: 5 });
    },
  });
  assert.equal(result.service_id, "created-id");
  assert.equal(result.status, "partial");
  assert.equal(result.next_action, "query_state");
});
