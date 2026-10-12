"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const YAML = require("yaml");

const root = path.resolve(__dirname, "..");

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

function schema() {
  return YAML.parse(read("rainbond-project-init/schemas/project-init-result.schema.yaml"));
}

function acceptsAppId(node, value) {
  return node.anyOf.some((option) => {
    if (option.type === "null") return value === null;
    if (option.type !== "integer" || !Number.isInteger(value)) return false;
    return option.minimum === undefined || value >= option.minimum;
  });
}

test("ProjectInitResult schema owns app_id and next_action vocabulary", () => {
  const current = schema();
  const appId = current.properties.project.properties.identity.properties.app_id;
  assert.deepEqual(appId, {
    anyOf: [
      { type: "integer", minimum: 1 },
      { type: "null" },
    ],
  });
  assert.equal(acceptsAppId(appId, 123), true);
  assert.equal(acceptsAppId(appId, null), true);
  for (const value of ["123", "app-123", 0, -1, 1.5, ""]) {
    assert.equal(acceptsAppId(appId, value), false, `must reject ${JSON.stringify(value)}`);
  }

  assert.deepEqual(current.properties.next_action.enum, [
    "stop",
    "bootstrap",
    "template_install",
    "reconnect_transport",
    "ask_identity",
    "ask_manifest_review",
  ]);
});

test("Project Init links the canonical schema instead of copying it", () => {
  const skill = read("rainbond-project-init/SKILL.md");
  const output = read("rainbond-project-init/references/output-contract.md");
  assert.match(skill, /schemas\/project-init-result\.schema\.yaml/);
  assert.match(output, /\.\.\/schemas\/project-init-result\.schema\.yaml/);
  assert.doesNotMatch(skill, /Proposed schema:/);
  assert.doesNotMatch(output, /Proposed schema:/);
  assert.doesNotMatch(skill, /app_id:\s*string \| null/);
  assert.doesNotMatch(skill, /reconnect_mcp/);
  assert.doesNotMatch(skill, /(?:app_id:\s*app-|"app_id":\s*"app-)/);
  assert.match(skill, /reject[^\n]*app-123/i);
});

test("local binding writes one canonical platform server path", () => {
  const projectInit = [
    read("rainbond-project-init/SKILL.md"),
    read("rainbond-project-init/references/manifest-rules.md"),
    read("rainbond-app-assistant/references/product-object-model.md"),
  ].join("\n");
  assert.match(projectInit, /binding\.platform\.server_name/);
  assert.match(
    projectInit,
    /historical[^\n]*mcp\.server_name[^\n]*(?:migration alias|迁移别名)[^\n]*(?:rewrite|重写)[^\n]*binding\.platform\.server_name/i,
  );
  assert.doesNotMatch(projectInit, /^\s*-\s+platform\.server_name\s*$/m);
  assert.doesNotMatch(projectInit, /^\s*-\s+mcp\.server_name\s*$/m);
  assert.doesNotMatch(projectInit, /"app_id":\s*"\d+"/);
});

test("template initialization hands off deterministically without entering bootstrap", () => {
  const projectInit = [
    read("rainbond-project-init/SKILL.md"),
    read("rainbond-project-init/references/manifest-rules.md"),
    read("rainbond-project-init/references/workflow-and-verification.md"),
    read("rainbond-project-init/references/operational-reference.md"),
    read("rainbond-project-init/references/output-contract.md"),
  ].join("\n");
  assert.doesNotMatch(projectInit, /reserved schema option|template-install support is implemented|template 尚未实现|仅预留/i);
  assert.match(projectInit, /next_action\s*=\s*`?template_install`?/i);
  assert.match(projectInit, /app_model_id/);
  assert.match(projectInit, /app_model_version/);
  assert.match(projectInit, /market_name/);
  assert.match(projectInit, /incomplete[^\n]*`?ask_manifest_review`?/i);

  const bootstrap = [
    read("rainbond-fullstack-bootstrap/SKILL.md"),
    read("rainbond-fullstack-bootstrap/modules/20-scope-and-boundaries.md"),
  ].join("\n");
  assert.match(bootstrap, /(?:must not|never|不得|禁止)[^\n]*template/i);
});
