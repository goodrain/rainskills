"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createLifecycleTelemetry } = require("../rainbond-platform-installer/scripts/telemetry.js");
const {
  createResultTelemetry,
  ensureInstallationId,
  normalizeAgent,
  readConfiguredAgent,
} = require("../rainbond-platform-installer/scripts/result-telemetry.js");

test("lifecycle telemetry creates a fixed-schema event and sends it fail-open", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "rainskills-telemetry-"));
  const requests = [];
  const telemetry = createLifecycleTelemetry({
    enabled: true,
    directory,
    context: {
      install_attempt_id: "11111111-1111-4111-8111-111111111111",
      operation_id: "22222222-2222-4222-8222-222222222222",
      installation_id: "33333333-3333-4333-8333-333333333333",
      package_version: "1.0.0",
      platform: "win32",
      control_mode: "windows-native",
      target: "local-windows",
      client: "codex",
      action: "install",
    },
    randomUUID: () => "44444444-4444-4444-8444-444444444444",
    now: () => "2026-08-07T00:00:00.000Z",
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      throw new Error("telemetry server unavailable");
    },
  });

  const { event, delivery } = telemetry.record({
    lifecycle_phase: "verify_console",
    step: "verify_console",
    lifecycle_action: "verify_deployment",
    lifecycle_status: "failed",
    error_code: "console_unreachable",
    error_stage: "verify_console",
    reason_code: "console_unreachable",
    retryable: true,
    exit_code: 7,
    http_status: 502,
    raw_error: "Bearer secret-token http://user:password@example.invalid/path?token=secret",
  });
  await delivery;

  assert.equal(event.schema, "rainskills.lifecycle-event.v1");
  assert.equal(event.event_id, "44444444-4444-4444-8444-444444444444");
  assert.equal(event.sequence, 1);
  assert.equal(event.lifecycle_status, "failed");
  assert.equal(event.error_code, "console_unreachable");
  assert.equal(Object.hasOwn(event, "raw_error"), false);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://log.rainbond.com/api/rainskills/lifecycle-events");

  const lines = fs.readFileSync(path.join(directory, "events.jsonl"), "utf8").trim().split("\n");
  assert.equal(lines.length, 1);
  assert.doesNotMatch(lines[0], /Bearer|password|secret-token/);
});

test("retrying the same lifecycle event reuses its event id", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "rainskills-telemetry-retry-"));
  const bodies = [];
  const telemetry = createLifecycleTelemetry({
    enabled: true,
    directory,
    context: {
      install_attempt_id: "11111111-1111-4111-8111-111111111111",
      platform: "linux",
      control_mode: "posix",
      target: "local-linux",
      client: "unknown",
      action: "install",
    },
    randomUUID: (() => {
      let count = 0;
      return () => `55555555-5555-4555-8555-55555555555${++count}`;
    })(),
    fetchImpl: async (_url, options) => {
      bodies.push(options.body);
      return { ok: true, status: 200 };
    },
  });

  const first = telemetry.record({
    lifecycle_phase: "preflight",
    step: "resource_check",
    lifecycle_action: "preflight",
    lifecycle_status: "started",
  });
  await first.delivery;
  await telemetry.send(first.event);
  assert.equal(bodies.length, 2);
  assert.equal(JSON.parse(bodies[0]).event_id, JSON.parse(bodies[1]).event_id);
});

test("only explicit lifecycle compatibility responses use the legacy summary endpoint", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "rainskills-telemetry-fallback-"));
  const requests = [];
  const telemetry = createLifecycleTelemetry({
    enabled: true,
    directory,
    context: {
      install_attempt_id: "11111111-1111-4111-8111-111111111111",
      platform: "linux",
      control_mode: "posix",
      target: "local-linux",
      client: "codex",
      action: "install",
    },
    randomUUID: () => "66666666-6666-4666-8666-666666666666",
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return { ok: url.endsWith("/installations"), status: url.endsWith("/installations") ? 200 : 404 };
    },
  });
  const { event, delivery } = telemetry.record({
    lifecycle_phase: "preflight",
    step: "resource_check",
    lifecycle_action: "preflight",
    lifecycle_status: "started",
  });
  await delivery;
  assert.equal(requests.length, 2);
  assert.match(requests[1].url, /\/api\/rainskills\/installations$/);
  assert.equal(JSON.parse(requests[1].options.body).install_attempt_id, event.install_attempt_id);
  assert.equal(Object.hasOwn(JSON.parse(requests[1].options.body), "raw_error"), false);

  requests.length = 0;
  const timeoutTelemetry = createLifecycleTelemetry({
    enabled: true,
    directory: fs.mkdtempSync(path.join(os.tmpdir(), "rainskills-telemetry-no-fallback-")),
    context: {
      install_attempt_id: "11111111-1111-4111-8111-111111111111",
      platform: "linux",
      control_mode: "posix",
      target: "local-linux",
      client: "codex",
      action: "install",
    },
    fetchImpl: async (url) => {
      requests.push(url);
      throw new Error("timeout");
    },
  });
  const failed = timeoutTelemetry.record({
    lifecycle_phase: "preflight",
    step: "resource_check",
    lifecycle_action: "preflight",
    lifecycle_status: "failed",
    error_code: "network_unreachable",
  });
  await failed.delivery;
  assert.deepEqual(requests, ["https://log.rainbond.com/api/rainskills/lifecycle-events"]);
});

test("lifecycle telemetry honors an explicit disabled override", async () => {
  const directory = path.join(os.tmpdir(), `rainskills-legacy-disabled-${process.pid}-${Date.now()}`);
  let requests = 0;
  const telemetry = createLifecycleTelemetry({
    enabled: false,
    directory,
    context: { install_attempt_id: "11111111-1111-4111-8111-111111111111" },
    fetchImpl: async () => {
      requests += 1;
      return { ok: true, status: 200 };
    },
  });

  const result = telemetry.record({ lifecycle_phase: "bootstrap", lifecycle_status: "started" });
  await result.delivery;
  assert.equal(requests, 0);
  assert.equal(fs.existsSync(directory), false);
});

test("lifecycle telemetry is enabled by default and follows the global opt-out", { concurrency: false }, async () => {
  const previous = process.env.RAINSKILLS_TELEMETRY_DISABLED;
  delete process.env.RAINSKILLS_TELEMETRY_DISABLED;
  try {
    let requests = 0;
    const enabledTelemetry = createLifecycleTelemetry({
      directory: fs.mkdtempSync(path.join(os.tmpdir(), "rainskills-lifecycle-default-")),
      context: {
        install_attempt_id: "11111111-1111-4111-8111-111111111111",
        platform: "linux",
        control_mode: "posix",
        target: "local-linux",
        client: "codex",
        action: "install",
      },
      fetchImpl: async () => {
        requests += 1;
        return { ok: true, status: 200 };
      },
    });
    await enabledTelemetry.record({ lifecycle_phase: "bootstrap", lifecycle_status: "started" }).delivery;
    assert.equal(requests, 1);

    process.env.RAINSKILLS_TELEMETRY_DISABLED = "1";
    const disabledDirectory = path.join(os.tmpdir(), `rainskills-lifecycle-optout-${process.pid}-${Date.now()}`);
    const disabledTelemetry = createLifecycleTelemetry({
      directory: disabledDirectory,
      context: { install_attempt_id: "22222222-2222-4222-8222-222222222222" },
      fetchImpl: async () => {
        requests += 1;
        return { ok: true, status: 200 };
      },
    });
    await disabledTelemetry.record({ lifecycle_phase: "bootstrap", lifecycle_status: "started" }).delivery;
    assert.equal(requests, 1);
    assert.equal(fs.existsSync(disabledDirectory), false);
  } finally {
    if (previous === undefined) delete process.env.RAINSKILLS_TELEMETRY_DISABLED;
    else process.env.RAINSKILLS_TELEMETRY_DISABLED = previous;
  }
});

test("lifecycle telemetry preserves platform installation targets", () => {
  const telemetry = createLifecycleTelemetry({
    enabled: false,
    context: {
      install_attempt_id: "11111111-1111-4111-8111-111111111111",
      platform: "linux",
      control_mode: "posix",
      target: "host-cluster",
      client: "hermes_agent",
      action: "install",
    },
  });

  const event = telemetry.buildEvent({
    lifecycle_phase: "target_selection",
    lifecycle_status: "completed",
  });
  assert.equal(event.target, "host-cluster");
  assert.equal(event.client, "hermes_agent");
});

test("result telemetry keeps a stable anonymous installation id", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "rainskills-result-id-"));
  const first = ensureInstallationId(directory, () => "11111111-1111-4111-8111-111111111111");
  const second = ensureInstallationId(directory, () => "22222222-2222-4222-8222-222222222222");

  assert.equal(first, "11111111-1111-4111-8111-111111111111");
  assert.equal(second, first);
  assert.equal(fs.statSync(path.join(directory, "installation-id")).mode & 0o777, 0o600);
});

test("result telemetry sends only the fixed v2 fields", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "rainskills-result-fixed-"));
  const requests = [];
  const telemetry = createResultTelemetry({
    directory,
    installationId: "11111111-1111-4111-8111-111111111111",
    packageVersion: "1.0.0",
    agentType: "codex",
    randomUUID: () => "22222222-2222-4222-8222-222222222222",
    now: () => new Date("2026-08-28T00:00:00.000Z"),
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return { ok: true, status: 200 };
    },
  });

  const result = telemetry.record({
    event_type: "install_result",
    install_attempt_id: "33333333-3333-4333-8333-333333333333",
    action: "install",
    os_type: "darwin",
    os_arch: "arm64",
    execution_environment: "native",
    status: "failed",
    error_stage: "install",
    error_code: "permission_denied",
    raw_error: "Bearer secret-token /Users/alice/private",
  });
  assert.equal(result.recorded, true);
  await result.delivery;

  assert.equal(requests.length, 1);
  const event = JSON.parse(requests[0].options.body);
  assert.equal(event.schema, "rainskills.telemetry-event.v2");
  assert.equal(event.event_type, "install_result");
  assert.equal(event.installation_id, "11111111-1111-4111-8111-111111111111");
  assert.equal(event.error_code, "permission_denied");
  assert.equal(Object.hasOwn(event, "agent_type"), false);
  assert.equal(Object.hasOwn(event, "raw_error"), false);
  assert.doesNotMatch(JSON.stringify(event), /Bearer|secret-token|Users\/alice/);
});

test("first use and daily activity are locally deduplicated", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "rainskills-result-once-"));
  const requests = [];
  let sequence = 0;
  let current = new Date("2026-08-28T15:59:00.000Z");
  const telemetry = createResultTelemetry({
    directory,
    installationId: "11111111-1111-4111-8111-111111111111",
    packageVersion: "1.0.0",
    agentType: "codex",
    randomUUID: () => `22222222-2222-4222-8222-${String(++sequence).padStart(12, "0")}`,
    now: () => current,
    fetchImpl: async (_url, options) => {
      requests.push(JSON.parse(options.body));
      return { ok: true, status: 200 };
    },
  });

  const firstFailure = telemetry.recordFirstUse("failed", {
    error_stage: "first_use",
    error_code: "tool_call_failed",
  });
  const repeatedFailure = telemetry.recordFirstUse("failed", {
    error_stage: "first_use",
    error_code: "tool_call_failed",
  });
  const firstSuccess = telemetry.recordFirstUse("success");
  const repeatedSuccess = telemetry.recordFirstUse("success");
  const firstActive = telemetry.recordActiveDaily();
  const repeatedActive = telemetry.recordActiveDaily();
  await Promise.all([firstFailure.delivery, firstSuccess.delivery, firstActive.delivery]);

  assert.equal(firstFailure.recorded, true);
  assert.equal(repeatedFailure.recorded, false);
  assert.equal(firstSuccess.recorded, true);
  assert.equal(repeatedSuccess.recorded, false);
  assert.equal(firstActive.recorded, true);
  assert.equal(repeatedActive.recorded, false);
  assert.equal(requests.length, 3);

  current = new Date("2026-08-28T16:01:00.000Z");
  const nextDay = telemetry.recordActiveDaily();
  await nextDay.delivery;
  assert.equal(nextDay.recorded, true);
  assert.equal(requests.length, 4);
});

test("runtime connection telemetry records only minimal v3 environment results", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "rainskills-runtime-connect-"));
  const requests = [];
  let sequence = 0;
  const telemetry = createResultTelemetry({
    directory,
    installationId: "11111111-1111-4111-8111-111111111111",
    packageVersion: "1.0.0",
    agentType: "codex",
    randomUUID: () => `33333333-3333-4333-8333-${String(++sequence).padStart(12, "0")}`,
    now: () => new Date("2026-08-31T00:00:00.000Z"),
    fetchImpl: async (_url, options) => {
      requests.push(JSON.parse(options.body));
      return { ok: true, status: 200 };
    },
  });

  const success = telemetry.recordRuntimeConnect("success", { environment_kind: "saas" });
  const repeated = telemetry.recordRuntimeConnect("success", { environment_kind: "saas" });
  const failure = telemetry.recordRuntimeConnect("failed", {
    environment_kind: "private",
    error_stage: "authorization",
    error_code: "authorization_failed",
    console_origin: "https://must-not-be-sent.example.com",
    token: "must-not-be-sent",
    eid: "must-not-be-sent",
  });
  await Promise.all([success.delivery, failure.delivery]);

  assert.equal(success.recorded, true);
  assert.equal(repeated.recorded, false);
  assert.equal(failure.recorded, true);
  assert.equal(requests.length, 2);
  assert.deepEqual(requests.map((event) => ({
    schema: event.schema,
    event_type: event.event_type,
    environment_kind: event.environment_kind,
    status: event.status,
  })), [
    { schema: "rainskills.telemetry-event.v3", event_type: "runtime_connect_result", environment_kind: "saas", status: "success" },
    { schema: "rainskills.telemetry-event.v3", event_type: "runtime_connect_result", environment_kind: "private", status: "failed" },
  ]);
  assert(requests.every((event) => event.agent_type === "codex"));
  assert.doesNotMatch(JSON.stringify(requests), /must-not-be-sent|console_origin|token|eid/);
});

test("runtime connection telemetry rejects unsupported environment kinds", () => {
  const telemetry = createResultTelemetry({
    directory: fs.mkdtempSync(path.join(os.tmpdir(), "rainskills-runtime-invalid-")),
    installationId: "11111111-1111-4111-8111-111111111111",
    packageVersion: "1.0.0",
    agentType: "codex",
    fetchImpl: async () => ({ ok: true, status: 200 }),
  });

  assert.equal(telemetry.recordRuntimeConnect("success", { environment_kind: "unknown" }).recorded, false);
  assert.equal(telemetry.recordRuntimeConnect("completed", { environment_kind: "saas" }).recorded, false);
  assert.equal(telemetry.recordRuntimeConnect("failed", {
    environment_kind: "private",
    error_stage: "authorization",
    error_code: "raw server error",
  }).recorded, false);
});

test("disabled result telemetry performs no writes or requests", async () => {
  const directory = path.join(os.tmpdir(), `rainskills-disabled-${process.pid}-${Date.now()}`);
  let requests = 0;
  const telemetry = createResultTelemetry({
    directory,
    installationId: "11111111-1111-4111-8111-111111111111",
    packageVersion: "1.0.0",
    agentType: "codex",
    disabled: true,
    fetchImpl: async () => {
      requests += 1;
      return { ok: true, status: 200 };
    },
  });

  const result = telemetry.recordFirstUse("success");
  await result.delivery;
  assert.equal(result.recorded, false);
  assert.equal(requests, 0);
  assert.equal(fs.existsSync(directory), false);
});

test("configured agent is only attributed when exactly one target is known", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "rainskills-agent-state-"));
  fs.writeFileSync(path.join(directory, "configured-agents.json"), JSON.stringify(["codex"]), { mode: 0o600 });
  assert.equal(readConfiguredAgent(directory), "codex");

  fs.writeFileSync(path.join(directory, "configured-agents.json"), JSON.stringify(["codex", "pi"]), { mode: 0o600 });
  assert.equal(readConfiguredAgent(directory), "unknown");
});

test("Hermes telemetry uses one stable agent identifier", () => {
  assert.equal(normalizeAgent("hermes"), "hermes_agent");
  assert.equal(normalizeAgent("hermes-agent"), "hermes_agent");
  assert.equal(normalizeAgent("hermes_agent"), "hermes_agent");
});
