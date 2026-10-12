"use strict";

const SCOPES = new Set(["runtime", "app", "component", "delivery"]);
const READ_PREFIXES = [
  "rainbond_query_", "rainbond_get_", "rainbond_list_", "rainbond_check_",
  "rainbond_describe_", "rainbond_validate_", "rainbond_verify_", "rainbond_search_",
];
const DESTRUCTIVE = /(?:delete|remove|purge|destroy|update|create|set|manage|operate|restart|deploy)/i;
const SENSITIVE_KEY = /(?:authorization|jwt|token|password|secret|credential|private[_-]?key|cookie|certificate|ssl)/i;
const LOG_OR_EVENT = /(?:log|event)/i;
const BOUND_KEYS = new Set(["cursor", "since_seconds", "tail"]);
const MAX_REQUESTS = 8;
const MAX_OUTPUT_BYTES = 96 * 1024;

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readOnlyTool(name) {
  return typeof name === "string"
    && READ_PREFIXES.some((prefix) => name.startsWith(prefix))
    && !DESTRUCTIVE.test(name);
}

function validateSnapshotInput(input) {
  if (!isPlainObject(input) || !SCOPES.has(input.scope)) throw new Error("snapshot scope is invalid");
  if (!Array.isArray(input.requests) || input.requests.length < 1 || input.requests.length > MAX_REQUESTS) {
    throw new Error("snapshot requires one to eight requests");
  }
  for (const entry of input.requests) {
    if (!isPlainObject(entry) || !readOnlyTool(entry.name) || !isPlainObject(entry.arguments)) {
      throw new Error("snapshot accepts read-only tool requests with object arguments");
    }
    if (LOG_OR_EVENT.test(entry.name) && !Object.keys(entry.arguments).some((key) => BOUND_KEYS.has(key))) {
      throw new Error("log and event reads require cursor, since_seconds, or tail bounds");
    }
  }
  return input;
}

function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (!isPlainObject(value)) return value;
  const output = {};
  for (const [key, child] of Object.entries(value)) {
    if (SENSITIVE_KEY.test(key)) continue;
    output[key] = redact(child);
  }
  return output;
}

async function executeReadSnapshot(input, {
  callTool,
  now = () => new Date().toISOString(),
} = {}) {
  validateSnapshotInput(input);
  if (typeof callTool !== "function") throw new Error("snapshot callTool is required");
  const evidence = await Promise.all(input.requests.map(async (entry) => {
    try {
      const data = redact(await callTool(entry.name, entry.arguments));
      return { tool: entry.name, available: true, data };
    } catch (_error) {
      return { tool: entry.name, available: false, unavailable_reason: "read-failed" };
    }
  }));
  const output = {
    schema: "rainskills.read-snapshot.v1",
    scope: input.scope,
    observed_at: now(),
    backend_requests: input.requests.length,
    evidence,
  };
  if (Buffer.byteLength(JSON.stringify(output), "utf8") > MAX_OUTPUT_BYTES) {
    throw new Error("snapshot output exceeds the fixed byte limit");
  }
  return output;
}

module.exports = {
  executeReadSnapshot,
  validateSnapshotInput,
};
