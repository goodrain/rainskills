"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { randomUUID: defaultRandomUUID } = require("node:crypto");

const SCHEMA = "rainskills.telemetry-event.v2";
const RUNTIME_CONNECT_SCHEMA = "rainskills.telemetry-event.v3";
const DEFAULT_REPORT_URL = "https://log.rainbond.com/api/rainskills/events";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const AGENTS = new Set(["codex", "pi", "claude_code", "deepseek", "workbuddy", "hermes_agent", "other", "unknown"]);
const RUNTIME_CONNECT_ERROR_CODES = new Set([
  "authorization_failed", "verification_failed", "network_unreachable", "user_cancelled", "unknown",
]);
const MAX_PENDING_EVENTS = 100;
const MAX_PENDING_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function defaultDirectory() {
  return path.join(os.homedir(), ".rainbond", "rainskills", "telemetry");
}

function safeMkdir(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(directory, 0o700); } catch { /* best effort */ }
}

function readPrivateText(file) {
  try {
    const info = fs.lstatSync(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024) return null;
    return fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function writePrivateFile(file, content) {
  safeMkdir(path.dirname(file));
  const temporary = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${process.pid}.${defaultRandomUUID()}.tmp`
  );
  try {
    fs.writeFileSync(temporary, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
    fs.renameSync(temporary, file);
    fs.chmodSync(file, 0o600);
  } finally {
    try { fs.rmSync(temporary, { force: true }); } catch { /* keep original error */ }
  }
}

function ensureInstallationId(directory = defaultDirectory(), randomUUID = defaultRandomUUID) {
  const file = path.join(directory, "installation-id");
  const existing = (readPrivateText(file) || "").trim();
  if (UUID_PATTERN.test(existing)) return existing;
  const generated = randomUUID();
  if (!UUID_PATTERN.test(generated)) throw new Error("telemetry installation id must be a UUID");
  writePrivateFile(file, `${generated}\n`);
  return generated;
}

function normalizeAgent(value) {
  const aliases = {
    claude: "claude_code",
    dsh: "deepseek",
    deepseek_harness: "deepseek",
    hermes: "hermes_agent",
    "hermes-agent": "hermes_agent",
  };
  const normalized = aliases[value] || value;
  return AGENTS.has(normalized) ? normalized : "unknown";
}

function readConfiguredAgent(directory = defaultDirectory()) {
  try {
    const raw = readPrivateText(path.join(directory, "configured-agents.json"));
    const agents = JSON.parse(raw || "[]").map(normalizeAgent);
    const unique = [...new Set(agents.filter((agent) => agent !== "unknown"))];
    return unique.length === 1 ? unique[0] : "unknown";
  } catch {
    return "unknown";
  }
}

function writeConfiguredAgents(directory, agents) {
  let existing = [];
  try {
    existing = JSON.parse(readPrivateText(path.join(directory, "configured-agents.json")) || "[]");
  } catch { /* replace invalid state with the validated targets */ }
  const normalized = [...new Set([...existing, ...(agents || [])]
    .map(normalizeAgent)
    .filter((agent) => agent !== "unknown"))].sort();
  writePrivateFile(path.join(directory, "configured-agents.json"), `${JSON.stringify(normalized)}\n`);
  return normalized;
}

function loadState(directory) {
  try {
    const raw = readPrivateText(path.join(directory, "v2-state.json"));
    const parsed = JSON.parse(raw || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function saveState(directory, state) {
  writePrivateFile(path.join(directory, "v2-state.json"), `${JSON.stringify(state)}\n`);
}

function pendingDirectory(directory) {
  return path.join(directory, "pending-v2");
}

function prunePending(directory, nowMs) {
  const pending = pendingDirectory(directory);
  let entries;
  try {
    entries = fs.readdirSync(pending)
      .filter((name) => name.endsWith(".json"))
      .map((name) => {
        const file = path.join(pending, name);
        return { file, mtimeMs: fs.lstatSync(file).mtimeMs };
      })
      .sort((left, right) => left.mtimeMs - right.mtimeMs);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  const expired = entries.filter((entry) => nowMs - entry.mtimeMs > MAX_PENDING_AGE_MS);
  const remaining = entries.filter((entry) => nowMs - entry.mtimeMs <= MAX_PENDING_AGE_MS);
  const overflow = remaining.slice(0, Math.max(0, remaining.length - MAX_PENDING_EVENTS + 1));
  for (const entry of [...expired, ...overflow]) {
    try { fs.rmSync(entry.file, { force: true }); } catch { /* best effort */ }
  }
}

function buildEvent({ installationId, packageVersion, agentType, randomUUID, now }, input) {
  const event = {
    schema: input.event_type === "runtime_connect_result" ? RUNTIME_CONNECT_SCHEMA : SCHEMA,
    event_id: randomUUID(),
    event_type: input.event_type,
    installation_id: installationId,
    package_version: packageVersion,
    occurred_at: now().toISOString(),
  };
  const fields = [
    "install_attempt_id", "action", "agent_type", "os_type", "os_arch",
    "execution_environment", "environment_kind", "status", "error_stage", "error_code",
  ];
  for (const field of fields) {
    const usesDefaultAgent = ["runtime_connect_result", "first_use_result", "active_daily"].includes(input.event_type);
    const value = field === "agent_type"
      ? (input[field] || (usesDefaultAgent ? agentType : ""))
      : input[field];
    if (typeof value === "string" && value.length > 0) event[field] = value;
  }
  if (event.agent_type) event.agent_type = normalizeAgent(event.agent_type);
  return event;
}

function createResultTelemetry({
  directory = defaultDirectory(),
  reportUrl = process.env.RAINSKILLS_TELEMETRY_REPORT_URL || DEFAULT_REPORT_URL,
  fetchImpl = globalThis.fetch,
  randomUUID = defaultRandomUUID,
  now = () => new Date(),
  timeoutMs = 1500,
  installationId,
  packageVersion = "unknown",
  agentType,
  disabled = process.env.RAINSKILLS_TELEMETRY_DISABLED === "1",
} = {}) {
  const resolvedAgent = normalizeAgent(agentType || readConfiguredAgent(directory));
  const resolvedInstallationId = installationId || (disabled ? null : ensureInstallationId(directory, randomUUID));

  async function send(event, file) {
    if (typeof fetchImpl !== "function" || !reportUrl) return false;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(reportUrl, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "idempotency-key": event.event_id,
        },
        body: JSON.stringify(event),
        signal: controller.signal,
      });
      const status = Number(response?.status || 0);
      const shouldDiscard = Boolean(response?.ok)
        || (status >= 400 && status < 500 && status !== 429);
      if (shouldDiscard && file) {
        try { fs.rmSync(file, { force: true }); } catch { /* best effort */ }
      }
      return Boolean(response?.ok);
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  function skippedResult() {
    return { event: null, delivery: Promise.resolve(false), recorded: false };
  }

  function record(input, onceKey = null) {
    if (disabled) return skippedResult();
    const state = loadState(directory);
    if (onceKey && state[onceKey]) return skippedResult();

    const event = buildEvent({
      installationId: resolvedInstallationId,
      packageVersion,
      agentType: resolvedAgent,
      randomUUID,
      now,
    }, input);
    const pending = pendingDirectory(directory);
    safeMkdir(pending);
    prunePending(directory, now().getTime());
    const file = path.join(pending, `${event.event_id}.json`);
    writePrivateFile(file, `${JSON.stringify(event)}\n`);
    if (onceKey) saveState(directory, { ...state, [onceKey]: event.event_id });
    return { event, delivery: send(event, file), recorded: true };
  }

  function recordFirstUse(status, error = {}) {
    if (!new Set(["success", "failed"]).has(status)) return skippedResult();
    return record({
      event_type: "first_use_result",
      status,
      ...(status === "failed" ? {
        error_stage: error.error_stage,
        error_code: error.error_code,
      } : {}),
    }, `first_use:${resolvedAgent}:${status}`);
  }

  function recordActiveDaily() {
    const activeDate = formatBeijingDate(now());
    return record({ event_type: "active_daily" }, `active:${resolvedAgent}:${activeDate}`);
  }

  function recordRuntimeConnect(status, details = {}) {
    if (!["success", "failed"].includes(status)) return skippedResult();
    if (!["saas", "private"].includes(details.environment_kind)) return skippedResult();
    if (status === "failed" && ![
      "authorization", "verification",
    ].includes(details.error_stage)) return skippedResult();
    if (status === "failed" && !RUNTIME_CONNECT_ERROR_CODES.has(details.error_code)) return skippedResult();
    return record({
      event_type: "runtime_connect_result",
      environment_kind: details.environment_kind,
      status,
      ...(status === "failed" ? {
        error_stage: details.error_stage,
        error_code: details.error_code,
      } : {}),
    }, `runtime-connect:${resolvedAgent}:${details.environment_kind}:${status}`);
  }

  async function flushPending(limit = MAX_PENDING_EVENTS) {
    if (disabled) return;
    let files;
    try {
      files = fs.readdirSync(pendingDirectory(directory))
        .filter((name) => name.endsWith(".json"))
        .sort()
        .slice(0, Math.max(0, Math.min(limit, MAX_PENDING_EVENTS)))
        .map((name) => path.join(pendingDirectory(directory), name));
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    for (const file of files) {
      try {
        const event = JSON.parse(readPrivateText(file));
        await send(event, file);
      } catch {
        try { fs.rmSync(file, { force: true }); } catch { /* best effort */ }
      }
    }
  }

  return {
    installationId: resolvedInstallationId,
    agentType: resolvedAgent,
    record,
    recordRuntimeConnect,
    recordFirstUse,
    recordActiveDaily,
    flushPending,
  };
}

function formatBeijingDate(value) {
  const shifted = new Date(value.getTime() + 8 * 60 * 60 * 1000);
  return shifted.toISOString().slice(0, 10);
}

module.exports = {
  DEFAULT_REPORT_URL,
  RUNTIME_CONNECT_SCHEMA,
  SCHEMA,
  createResultTelemetry,
  ensureInstallationId,
  normalizeAgent,
  readConfiguredAgent,
  writeConfiguredAgents,
};
