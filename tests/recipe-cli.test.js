"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const { cliFixture } = require("./helpers/cli-fixture.js");
const scope = { team_name: "default", region_name: "region", app_id: 22 };
function schema(name, required) { return { name, inputSchema: { type: "object", required } }; }
const tools = [
  schema("rainbond_query_components", ["enterprise_id", "app_id"]),
  schema("rainbond_get_package_upload_status", ["team_name", "region_name", "event_id"]),
  ...["image", "source", "package"].map((kind) => schema(`rainbond_create_component_from_${kind}`, ["team_name", "region_name", "app_id", "service_cname"])),
  schema("rainbond_manage_component_ports", ["team_name", "region_name", "app_id", "service_id", "operation"]),
  schema("rainbond_manage_component_storage", ["team_name", "region_name", "app_id", "service_id", "operation"]),
  schema("rainbond_manage_component_dependency", ["team_name", "region_name", "app_id", "service_id", "operation"]),
];
test("four-component CLI recipes preserve providers, source facts, upload events and audited IDs", async (t) => {
  const components = [];
  const writes = [];
  const fixture = await cliFixture(t, ({ name, arguments: args, _meta }) => {
    if (name === "rainbond_query_components") return { structuredContent: { items: components.filter((c) => c.service_cname === args.query), total: components.filter((c) => c.service_cname === args.query).length } };
    if (name === "rainbond_get_package_upload_status") return { structuredContent: { uploaded_packages: ["frontend.war"] } };
    if (args.operation === "summary") return { structuredContent: { dependencies: [], ports: { items: [] } } };
    assert(_meta["com.rainbond/rainskills"].operation_id);
    writes.push({ name, args });
    if (name.startsWith("rainbond_create_component")) {
      const value = { service_id: `verified-${components.length + 1}`, service_cname: args.service_cname, event_id: `event-${components.length + 1}` };
      components.push(value);
      return { structuredContent: value };
    }
    assert(components.some((c) => c.service_id === args.service_id));
    return { structuredContent: { service_id: args.service_id } };
  }, tools);
  for (const [name, kind, create, stateful] of [
    ["db", "image", { image: "mysql:8.4" }, true],
    ["backend", "source", { code_from: "git", git_url: "https://example.invalid/backend", code_version: "feature/exact-ref" }, false],
    ["frontend", "package", { event_id: "verified-upload" }, false],
    ["gateway", "image", { image: "nginx:stable" }, false],
  ]) {
    const request = { schema: "rainskills.component-recipe.v1.request", scope, enterprise_id: "enterprise", kind, create: { ...create, service_cname: name }, stateful, configure: [{ key: "port", tool: "rainbond_manage_component_ports", arguments: { operation: "add", port: name === "db" ? 3306 : 8080, protocol: name === "db" ? "stream" : "http" } }], ...(stateful ? { storage: { volume_name: "data", volume_type: "share-file", volume_path: "/var/lib/mysql" } } : {}) };
    const prepared = await fixture.run(["recipe", "--input", "-"], request);
    assert.equal(prepared.code, 0, prepared.stderr);
    const result = await fixture.run(["recipe", "--input", "-", "--confirm", prepared.value.confirmation_id], request);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.value.status, "succeeded");
    assert.equal(result.value.next_action, "deploy_and_verify");
    if (name === "db") assert.equal(writes[1].name, "rainbond_manage_component_storage");
    if (name === "backend") assert.equal(writes.find((w) => w.name.endsWith("from_source")).args.code_version, "feature/exact-ref");
  }
  assert.equal(components.length, 4);
  assert(writes.filter((w) => w.name.startsWith("rainbond_create_component")).every((w) => w.args.is_deploy === false));
  assert(!writes.some((w) => w.name === "rainbond_operate_app"));
  const dependency = { schema: "rainskills.confirmed-batch.v1.request", scope, steps: [{ key: "backend-to-db", tool: "rainbond_manage_component_dependency", arguments: { service_id: components[1].service_id, operation: "add", dep_service_id: components[0].service_id } }] };
  const prepared = await fixture.run(["batch", "--input", "-"], dependency);
  // Fixture has no usable dependency summary; its shape does not prove any edge.
  const result = await fixture.run(["batch", "--input", "-", "--confirm", prepared.value.confirmation_id], dependency);
  assert.equal(result.value.status, "succeeded");
  assert.equal(writes.at(-1).args.dep_service_id, components[0].service_id);
});
