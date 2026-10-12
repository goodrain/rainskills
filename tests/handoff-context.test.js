"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const YAML = require("yaml");

const root = path.resolve(__dirname, "..");
const cli = path.join(root, "bin", "rainskills-tools.js");
const handoff = require("../bin/handoff-context.js");
const handoffSkills = [
  "rainbond-app-assistant",
  "rainbond-project-init",
  "rainbond-fullstack-bootstrap",
  "rainbond-fullstack-troubleshooter",
  "rainbond-delivery-verifier",
  "rainbond-template-installer",
];

function input(overrides = {}) {
  return {
    producer: "rainbond-project-init",
    profile: "cli",
    observed_at: "2026-10-08T00:00:00.000Z",
    enterprise_id: "enterprise-1",
    team_id: "team-1",
    team_name: "dev-team",
    region_name: "cn",
    app_id: 42,
    app_name: "shop",
    endpoint: "https://console.example.com",
    runtime_revision: "runtime-revision-1",
    snapshot_revision: "snapshot-1",
    source_kind: "source",
    runtime_state: "topology_missing",
    next_phase: "bootstrap",
    invalidation_reason: null,
    ...overrides,
  };
}

test("HandoffContext schema is transport-neutral and excludes sensitive state", () => {
  const schema = YAML.parse(fs.readFileSync(
    path.join(root, "contracts", "handoff-context.schema.yaml"),
    "utf8",
  ));
  assert.equal(schema.$id, "rainskills.handoff-context.v1");
  assert.equal(schema.additionalProperties, false);
  for (const forbidden of ["jwt", "token", "password", "confirmation_id", "raw_logs", "tool_output"]) {
    assert.equal(Object.hasOwn(schema.properties, forbidden), false);
  }
});

test("every handoff Skill ships a generated copy of the canonical schema", () => {
  const canonical = fs.readFileSync(path.join(root, "contracts", "handoff-context.schema.yaml"), "utf8");
  for (const skillId of handoffSkills) {
    const generated = fs.readFileSync(
      path.join(root, skillId, "schemas", "generated", "handoff-context.schema.yaml"),
      "utf8",
    );
    assert.match(generated, /^# generated-by: scripts\/sync-shared-contracts\.mjs\n# source-sha256: [a-f0-9]{64}\n/);
    assert.equal(generated.split("\n").slice(2).join("\n"), canonical);
    assert.match(
      fs.readFileSync(path.join(root, skillId, "SKILL.md"), "utf8"),
      /schemas\/generated\/handoff-context\.schema\.yaml/,
      skillId,
    );
  }
});

test("protected adapter creates deterministic runtime and identity fingerprints", () => {
  const first = handoff.createHandoffContext(input());
  const second = handoff.createHandoffContext(input());
  assert.deepEqual(first, second);
  assert.match(first.runtime_fingerprint, /^[a-f0-9]{64}$/);
  assert.match(first.identity_fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(first.schema, "rainskills.handoff-context.v1");
  assert.equal(first.endpoint, undefined);
  assert.equal(first.runtime_revision, undefined);
  assert.doesNotMatch(JSON.stringify(first), /token|password|confirmation/i);
});

test("handoff validation reuses stable identity and bounds mutable state freshness", () => {
  const context = handoff.createHandoffContext(input());
  const current = {
    profile: "cli",
    endpoint: "https://console.example.com",
    runtime_revision: "runtime-revision-1",
    enterprise_id: "enterprise-1",
    team_id: "team-1",
    region_name: "cn",
    app_id: 42,
    source_kind: "source",
    snapshot_revision: "snapshot-1",
  };
  assert.equal(handoff.validateHandoffContext(context, {
    current,
    now: Date.parse("2026-10-08T00:00:29.000Z"),
  }).valid, true);
  assert.deepEqual(handoff.validateHandoffContext(context, {
    current,
    now: Date.parse("2026-10-08T00:00:31.000Z"),
  }), { valid: false, reason: "mutable-state-stale" });
  assert.equal(handoff.validateHandoffContext(context, {
    current: { ...current, snapshot_revision: "snapshot-2" },
    now: Date.parse("2026-10-08T00:00:01.000Z"),
  }).reason, "snapshot-revision-changed");
});

test("explicit runtime, identity, source, and authorization changes invalidate reuse", () => {
  const context = handoff.createHandoffContext(input());
  const current = {
    profile: "cli",
    endpoint: "https://console.example.com",
    runtime_revision: "runtime-revision-1",
    enterprise_id: "enterprise-1",
    team_id: "team-1",
    region_name: "cn",
    app_id: 42,
    source_kind: "source",
    snapshot_revision: "snapshot-1",
  };
  for (const [field, value, reason] of [
    ["profile", "embedded", "runtime-identity-changed"],
    ["endpoint", "https://other.example.com", "runtime-identity-changed"],
    ["team_id", "team-2", "workspace-identity-changed"],
    ["app_id", 43, "workspace-identity-changed"],
    ["source_kind", "image", "source-strategy-changed"],
  ]) {
    assert.equal(handoff.validateHandoffContext(context, {
      current: { ...current, [field]: value },
      now: Date.parse("2026-10-08T00:00:01.000Z"),
    }).reason, reason, field);
  }
  for (const signal of ["runtime-reconnect", "unauthorized-401", "forbidden-403", "not-found", "revision-conflict"]) {
    assert.equal(handoff.validateHandoffContext(context, {
      current,
      signal,
      now: Date.parse("2026-10-08T00:00:01.000Z"),
    }).valid, false, signal);
  }
});

test("five-stage deterministic chain resolves runtime and context once", () => {
  let runtimeStatusCalls = 0;
  let contextResolveCalls = 0;
  runtimeStatusCalls += 1;
  contextResolveCalls += 1;
  const context = handoff.createHandoffContext(input());
  const current = {
    profile: "cli",
    endpoint: "https://console.example.com",
    runtime_revision: "runtime-revision-1",
    enterprise_id: "enterprise-1",
    team_id: "team-1",
    region_name: "cn",
    app_id: 42,
    source_kind: "source",
    snapshot_revision: "snapshot-1",
  };
  for (let stage = 0; stage < 4; stage += 1) {
    assert.equal(handoff.validateHandoffContext(context, {
      current,
      now: Date.parse("2026-10-08T00:00:01.000Z") + stage,
    }).valid, true);
  }
  assert.deepEqual({ runtimeStatusCalls, contextResolveCalls }, {
    runtimeStatusCalls: 1,
    contextResolveCalls: 1,
  });
});

test("CLI creates and validates HandoffContext without loading runtime credentials", () => {
  const create = spawnSync(process.execPath, [
    cli, "handoff", "create", "--input", "-", "--skill-id", "rainbond-project-init",
  ], { input: JSON.stringify(input()), encoding: "utf8", env: {} });
  assert.equal(create.status, 0, create.stderr);
  const context = JSON.parse(create.stdout);
  const validate = spawnSync(process.execPath, [
    cli, "handoff", "validate", "--input", "-", "--skill-id", "rainbond-fullstack-bootstrap",
  ], {
    input: JSON.stringify({
      context,
      current: {
        profile: "cli",
        endpoint: "https://console.example.com",
        runtime_revision: "runtime-revision-1",
        enterprise_id: "enterprise-1",
        team_id: "team-1",
        region_name: "cn",
        app_id: 42,
        source_kind: "source",
        snapshot_revision: "snapshot-1",
      },
      now: Date.parse("2026-10-08T00:00:01.000Z"),
    }),
    encoding: "utf8",
    env: {},
  });
  assert.equal(validate.status, 0, validate.stderr);
  assert.deepEqual(JSON.parse(validate.stdout), { valid: true, reason: null });
});
