"use strict";

const { createHash } = require("node:crypto");

const SCHEMA = "rainskills.handoff-context.v1";
const PROFILE = new Set(["cli", "embedded"]);
const SOURCE_KIND = new Set(["source", "image", "package", "template", null]);
const RUNTIME_STATE = new Set([
  "topology_missing", "topology_building", "runtime_unhealthy", "runtime_healthy",
  "capacity_blocked", "code_or_build_handoff_needed",
]);
const NEXT_PHASE = new Set(["init", "bootstrap", "troubleshoot", "verify", "stop"]);
const CONTEXT_KEYS = Object.freeze([
  "schema", "producer", "profile", "observed_at", "enterprise_id", "team_id",
  "team_name", "region_name", "app_id", "app_name", "runtime_fingerprint",
  "identity_fingerprint", "snapshot_revision", "source_kind", "runtime_state",
  "next_phase", "invalidation_reason",
]);
const CREATE_KEYS = new Set([
  "producer", "profile", "observed_at", "enterprise_id", "team_id", "team_name",
  "region_name", "app_id", "app_name", "endpoint", "runtime_revision",
  "snapshot_revision", "source_kind", "runtime_state", "next_phase", "invalidation_reason",
]);
const SENSITIVE_KEY = /(?:jwt|token|password|secret|credential|confirmation|raw.?log|tool.?output)/i;
const SHA256 = /^[a-f0-9]{64}$/;
const SKILL_ID = /^rainbond-[a-z0-9-]+$/;

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function fingerprint(value) {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

function assertString(value, label, nullable = false) {
  if (nullable && value === null) return;
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be a non-empty string`);
}

function runtimeIdentity(value) {
  return {
    profile: value.profile,
    endpoint: value.endpoint,
    runtime_revision: value.runtime_revision,
  };
}

function workspaceIdentity(value) {
  return {
    enterprise_id: value.enterprise_id,
    team_id: value.team_id,
    region_name: value.region_name,
    app_id: value.app_id,
  };
}

function validateCreationInput(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("handoff input must be an object");
  for (const key of Object.keys(value)) {
    if (SENSITIVE_KEY.test(key)) throw new Error("sensitive handoff fields are forbidden");
    if (!CREATE_KEYS.has(key)) throw new Error(`unknown handoff field: ${key}`);
  }
  if (!SKILL_ID.test(value.producer || "")) throw new Error("producer is invalid");
  if (!PROFILE.has(value.profile)) throw new Error("profile is invalid");
  if (!Number.isFinite(Date.parse(value.observed_at))) throw new Error("observed_at is invalid");
  for (const key of ["enterprise_id", "team_id", "team_name", "region_name", "endpoint", "runtime_revision"]) assertString(value[key], key);
  if (!(value.app_id === null || (Number.isInteger(value.app_id) && value.app_id > 0))) throw new Error("app_id is invalid");
  assertString(value.app_name, "app_name", true);
  assertString(value.snapshot_revision, "snapshot_revision", true);
  if (!SOURCE_KIND.has(value.source_kind)) throw new Error("source_kind is invalid");
  if (!RUNTIME_STATE.has(value.runtime_state)) throw new Error("runtime_state is invalid");
  if (!NEXT_PHASE.has(value.next_phase)) throw new Error("next_phase is invalid");
  assertString(value.invalidation_reason, "invalidation_reason", true);
}

function validateContextShape(context) {
  if (!context || typeof context !== "object" || Array.isArray(context)) throw new Error("context must be an object");
  const keys = Object.keys(context).sort();
  if (JSON.stringify(keys) !== JSON.stringify([...CONTEXT_KEYS].sort())) throw new Error("context fields are invalid");
  if (context.schema !== SCHEMA || !SKILL_ID.test(context.producer || "") || !PROFILE.has(context.profile)) throw new Error("context identity is invalid");
  if (!Number.isFinite(Date.parse(context.observed_at))) throw new Error("context observed_at is invalid");
  for (const key of ["enterprise_id", "team_id", "team_name", "region_name"]) assertString(context[key], key);
  if (!(context.app_id === null || (Number.isInteger(context.app_id) && context.app_id > 0))) throw new Error("context app_id is invalid");
  assertString(context.app_name, "app_name", true);
  if (!SHA256.test(context.runtime_fingerprint) || !SHA256.test(context.identity_fingerprint)) throw new Error("context fingerprint is invalid");
  assertString(context.snapshot_revision, "snapshot_revision", true);
  if (!SOURCE_KIND.has(context.source_kind) || !RUNTIME_STATE.has(context.runtime_state) || !NEXT_PHASE.has(context.next_phase)) throw new Error("context state is invalid");
  assertString(context.invalidation_reason, "invalidation_reason", true);
}

function createHandoffContext(value) {
  validateCreationInput(value);
  return {
    schema: SCHEMA,
    producer: value.producer,
    profile: value.profile,
    observed_at: new Date(value.observed_at).toISOString(),
    enterprise_id: value.enterprise_id,
    team_id: value.team_id,
    team_name: value.team_name,
    region_name: value.region_name,
    app_id: value.app_id,
    app_name: value.app_name,
    runtime_fingerprint: fingerprint(runtimeIdentity(value)),
    identity_fingerprint: fingerprint(workspaceIdentity(value)),
    snapshot_revision: value.snapshot_revision,
    source_kind: value.source_kind,
    runtime_state: value.runtime_state,
    next_phase: value.next_phase,
    invalidation_reason: value.invalidation_reason,
  };
}

function validateHandoffContext(context, { current, signal = null, now = Date.now(), maxAgeMs = 30_000 } = {}) {
  try {
    validateContextShape(context);
    validateCreationInput({
      producer: context.producer,
      observed_at: context.observed_at,
      team_name: context.team_name,
      app_name: context.app_name,
      snapshot_revision: context.snapshot_revision,
      source_kind: context.source_kind,
      runtime_state: context.runtime_state,
      next_phase: context.next_phase,
      invalidation_reason: context.invalidation_reason,
      ...current,
    });
  } catch (_error) {
    return { valid: false, reason: "invalid-context" };
  }
  const signalReasons = new Set(["runtime-reconnect", "unauthorized-401", "forbidden-403", "not-found", "revision-conflict"]);
  if (signal && signalReasons.has(signal)) return { valid: false, reason: signal };
  if (fingerprint(runtimeIdentity(current)) !== context.runtime_fingerprint) return { valid: false, reason: "runtime-identity-changed" };
  if (fingerprint(workspaceIdentity(current)) !== context.identity_fingerprint) return { valid: false, reason: "workspace-identity-changed" };
  if (current.source_kind !== context.source_kind) return { valid: false, reason: "source-strategy-changed" };
  if (current.snapshot_revision !== context.snapshot_revision) return { valid: false, reason: "snapshot-revision-changed" };
  if (now - Date.parse(context.observed_at) > maxAgeMs) return { valid: false, reason: "mutable-state-stale" };
  if (context.invalidation_reason) return { valid: false, reason: context.invalidation_reason };
  return { valid: true, reason: null };
}

module.exports = {
  createHandoffContext,
  validateHandoffContext,
};
