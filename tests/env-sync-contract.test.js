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

function envSyncContract() {
  return [
    read("rainbond-env-sync/SKILL.md"),
    read("rainbond-env-sync/references/sync-policy.md"),
    read("rainbond-env-sync/references/sync-workflow.md"),
  ].join("\n");
}

test("conflict gate outranks drift reconciliation and forbids all writes", () => {
  const skill = envSyncContract();
  assert.match(skill, /conflict gate[^\n]*higher priority than drift reconciliation/i);
  assert.match(skill, /any conflict[^\n]*(?:must not write|禁止写)[^\n]*any file/i);
  assert.match(skill, /drift reconciliation[^\n]*only[^\n]*no conflicts/i);
});

test("env sync metadata uses one stable producer identifier", () => {
  const content = [
    envSyncContract(),
    read("rainbond-app-assistant/references/product-object-model.md"),
  ].join("\n");
  assert.doesNotMatch(content, /synced_by[^\n]*(?:Claude Code|env-sync v1|local-sync)/i);
  assert.match(content, /synced_by[^\n]*rainbond-env-sync/);
});

test("DB_NAME classification depends on source and ownership", () => {
  const skill = envSyncContract();
  assert.match(skill, /DB_NAME[^\n]*(?:connection_envs|dependency injection)[^\n]*runtime_metadata/i);
  assert.match(skill, /DB_NAME[^\n]*durable[^\n]*non-sensitive[^\n]*baseline[^\n]*(?:keep|persist)/i);
  assert.match(skill, /DB_NAME[^\n]*(?:unknown|unknown source)[^\n]*ambiguous[^\n]*(?:must not write|禁止写)/i);
  assert.doesNotMatch(skill, /provider connection envs and dependency-injected connection values \(`DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASS`, `DB_NAME`/);

  for (const key of ["DB_HOST", "DB_PORT", "API_HOST", "API_PORT"]) {
    assert.match(skill, new RegExp(`${key}[^\\n]*(?:always|unconditionally|无条件)[^\\n]*(?:skip|exclude|排除)`, "i"));
  }
});

test("DB_NAME source fixtures cover keep, runtime metadata, and ambiguous", () => {
  const fixture = YAML.parse(read("rainbond-env-sync/evals/db-name-source-cases.yaml"));
  assert.deepEqual(fixture.cases, [
    {
      id: "ordinary-component-db-name",
      key: "DB_NAME",
      source: "component_env",
      durable: true,
      sensitive: false,
      differs_from_baseline: true,
      expected_classification: "keep",
      persist: true,
    },
    {
      id: "provider-connection-db-name",
      key: "DB_NAME",
      source: "connection_envs",
      durable: true,
      sensitive: false,
      differs_from_baseline: true,
      expected_classification: "runtime_metadata",
      persist: false,
    },
    {
      id: "unknown-source-db-name",
      key: "DB_NAME",
      source: "unknown",
      durable: true,
      sensitive: false,
      differs_from_baseline: true,
      expected_classification: "ambiguous",
      persist: false,
    },
  ]);
});
