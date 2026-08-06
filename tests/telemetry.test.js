"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createLifecycleTelemetry } = require("../rainbond-platform-installer/scripts/telemetry.js");

test("lifecycle telemetry creates a fixed-schema event and sends it fail-open", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "rainskills-telemetry-"));
  const requests = [];
  const telemetry = createLifecycleTelemetry({
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
