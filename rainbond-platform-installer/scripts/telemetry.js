"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const DEFAULT_REPORT_URL = "https://log.rainbond.com/api/rainskills/lifecycle-events";
const DEFAULT_LEGACY_REPORT_URL = "https://log.rainbond.com/api/rainskills/installations";
const SCHEMA = "rainskills.lifecycle-event.v1";
const CLIENTS = new Set([
  "codex", "claude_code", "pi", "deepseek_harness", "workbuddy", "all", "both", "unknown",
]);
const PLATFORMS = new Set(["darwin", "linux", "win32"]);
const CONTROL_MODES = new Set(["posix", "wsl", "windows-native"]);
const TARGETS = new Set(["local-linux", "local-macos", "local-windows", "remote-linux"]);
const ACTIONS = new Set(["install", "refresh"]);
const LIFECYCLE_STATUSES = new Set(["started", "completed", "blocked", "failed", "interrupted", "skipped"]);
const LEGACY_PHASES = new Set(["started", "authorized", "configured", "failed"]);
const LEGACY_STATUSES = new Set(["started", "success", "failure"]);
const TRANSPORTS = new Set(["direct", "ssh", "wsl", "powershell"]);
const AUTH_METHODS = new Set(["device_flow", "browser_loopback", "browser_manual", "jwt_flag", "legacy_password"]);
const BLOCKED_REASONS = new Set([
  "awaiting_user_confirmation",
  "awaiting_reboot",
  "awaiting_device_authorization",
  "device_authorization_pending",
  "device_authorization_denied",
  "device_authorization_expired",
  "ssh_password_prompt",
  "manual_console_input",
  "resource_below_floor",
  "unknown",
]);
const ERROR_CODES = new Set([
  "invalid_arguments",
  "preflight_blocked",
  "user_cancelled",
  "network_unreachable",
  "download_failed",
  "ssh_auth_failed",
  "ssh_timeout",
  "wsl_not_ready",
  "docker_not_ready",
  "containerd_not_ready",
  "rainbond_deploy_failed",
  "console_unreachable",
  "authorization_failed",
  "device_authorization_pending",
  "device_authorization_denied",
  "device_authorization_expired",
  "mcp_verification_failed",
  "configuration_failed",
  "interrupted",
  "unknown",
]);

function selected(value, values, fallback = null) {
  return values.has(value) ? value : fallback;
}

function nullableString(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function defaultDirectory() {
  return path.join(os.homedir(), ".rainbond", "rainskills", "telemetry");
}

function safeMkdir(directory) {
  try {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(directory, 0o700); } catch { /* best effort */ }
    return true;
  } catch {
    return false;
  }
}

function writeLocalEvent(directory, event) {
  if (!safeMkdir(directory)) return false;
  const filePath = path.join(directory, "events.jsonl");
  try {
    fs.appendFileSync(filePath, `${JSON.stringify(event)}\n`, { encoding: "utf8", mode: 0o600 });
    try { fs.chmodSync(filePath, 0o600); } catch { /* best effort */ }
    return true;
  } catch {
    return false;
  }
}

function createLifecycleTelemetry({
  context = {},
  directory = defaultDirectory(),
  reportUrl = DEFAULT_REPORT_URL,
  legacyReportUrl = DEFAULT_LEGACY_REPORT_URL,
  fetchImpl = globalThis.fetch,
  randomUUID = crypto.randomUUID,
  now = () => new Date().toISOString(),
  timeoutMs = 1500,
  enabled = process.env.RAINSKILLS_LEGACY_TELEMETRY_ENABLED === "1",
} = {}) {
  let sequence = 0;
  const deliveries = new Set();

  function buildEvent(input = {}) {
    const lifecycleStatus = selected(input.lifecycle_status, LIFECYCLE_STATUSES, "started");
    const event = {
      schema: SCHEMA,
      event_id: randomUUID(),
      install_attempt_id: nullableString(context.install_attempt_id),
      operation_id: nullableString(context.operation_id),
      installation_id: nullableString(context.installation_id),
      parent_event_id: nullableString(input.parent_event_id),
      sequence: Number.isInteger(input.sequence) && input.sequence > 0 ? input.sequence : ++sequence,
      attempt: Number.isInteger(input.attempt) && input.attempt > 0 ? input.attempt : 1,
      resumed_from: nullableString(input.resumed_from),
      package_version: nullableString(context.package_version),
      platform: selected(context.platform, PLATFORMS, process.platform),
      control_mode: selected(context.control_mode, CONTROL_MODES),
      target: selected(context.target, TARGETS),
      client: selected(context.client, CLIENTS, "unknown"),
      eid: nullableString(context.eid),
      phase: selected(input.phase, LEGACY_PHASES),
      lifecycle_phase: nullableString(input.lifecycle_phase),
      step: nullableString(input.step),
      action: selected(context.action, ACTIONS),
      lifecycle_action: nullableString(input.lifecycle_action),
      status: selected(input.status, LEGACY_STATUSES),
      lifecycle_status: lifecycleStatus,
      duration_ms: Number.isFinite(input.duration_ms) && input.duration_ms >= 0 ? Math.floor(input.duration_ms) : null,
      error_code: selected(input.error_code, ERROR_CODES),
      error_stage: nullableString(input.error_stage),
      reason_code: selected(input.reason_code, ERROR_CODES),
      blocked_reason: selected(input.blocked_reason, BLOCKED_REASONS),
      interrupt_signal: ["SIGINT", "SIGTERM", "CTRL_C", "reboot"].includes(input.interrupt_signal)
        ? input.interrupt_signal
        : null,
      transport: selected(input.transport || context.transport, TRANSPORTS),
      auth_method: selected(input.auth_method || context.auth_method, AUTH_METHODS),
      retryable: typeof input.retryable === "boolean" ? input.retryable : null,
      exit_code: Number.isInteger(input.exit_code) ? input.exit_code : null,
      http_status: Number.isInteger(input.http_status) ? input.http_status : null,
      created_at: now(),
    };
    sequence = Math.max(sequence, event.sequence);
    return event;
  }

  function legacyProjection(event) {
    let phase = "started";
    let status = "started";
    if (event.lifecycle_status === "completed") {
      if (event.lifecycle_phase === "authorize_device_flow" || event.lifecycle_phase === "authorize_legacy") {
        phase = "authorized";
        status = "success";
      } else if (event.lifecycle_phase === "configure_mcp") {
        phase = "configured";
        status = "success";
      }
    } else if (["failed", "blocked", "interrupted"].includes(event.lifecycle_status)) {
      phase = "failed";
      status = "failure";
    }
    if ((phase === "authorized" || phase === "configured") && !event.eid) return null;
    const failureStage = {
      bootstrap: "bootstrap",
      rootfs_download: "download",
      import_distro: "download",
      prepare_runtime: "bootstrap",
      prepare_docker: "bootstrap",
      install_rainbond: "bootstrap",
      authorize_device_flow: "authorization",
      authorize_legacy: "authorization",
      configure_mcp: "configuration",
      verify_console: "verification",
      verify_mcp: "verification",
    }[event.lifecycle_phase] || "bootstrap";
    return {
      install_attempt_id: event.install_attempt_id,
      eid: event.eid || "",
      install_client: event.client || "unknown",
      action: event.action || "install",
      phase,
      status,
      failure_stage: phase === "failed" ? failureStage : "",
      failure_category: phase === "failed"
        ? (event.error_code || event.blocked_reason || "interrupted")
        : "",
    };
  }

  async function sendRequest(url, event, idempotencyKey = event.event_id) {
    if (typeof fetchImpl !== "function" || !url) return { ok: false, status: 0 };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "idempotency-key": idempotencyKey,
        },
        body: JSON.stringify(event),
        signal: controller.signal,
      });
      return { ok: Boolean(response?.ok), status: Number(response?.status || 0) };
    } catch {
      return { ok: false, status: 0 };
    } finally {
      clearTimeout(timer);
    }
  }

  async function send(event) {
    if (!enabled) return false;
    const result = await sendRequest(reportUrl, event);
    if (result.ok) return true;
    if (![400, 404, 415, 422].includes(result.status)) return false;
    const legacy = legacyProjection(event);
    if (!legacy) return false;
    const fallback = await sendRequest(legacyReportUrl, legacy, event.event_id);
    return fallback.ok;
  }

  function record(input = {}) {
    const event = buildEvent(input);
    if (!enabled) return { event, delivery: Promise.resolve(false) };
    writeLocalEvent(directory, event);
    const delivery = send(event).catch(() => false);
    deliveries.add(delivery);
    delivery.finally(() => deliveries.delete(delivery)).catch(() => {});
    return { event, delivery };
  }

  async function flush() {
    await Promise.allSettled([...deliveries]);
  }

  return { buildEvent, record, send, flush };
}

module.exports = {
  DEFAULT_LEGACY_REPORT_URL,
  DEFAULT_REPORT_URL,
  SCHEMA,
  createLifecycleTelemetry,
};
