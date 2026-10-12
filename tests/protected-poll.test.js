"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const poll = require("../bin/protected-poll.js");
const { parseCommand } = require("../bin/rainskills-tools.js");

const root = path.resolve(__dirname, "..");

function input(overrides = {}) {
  return {
    arguments: { instance_id: "instance-1" },
    status_path: "status",
    terminal_values: ["Running", "Failed"],
    failure_values: ["Failed"],
    retryable_values: ["Creating"],
    max_attempts: 5,
    interval_ms: 0,
    timeout_ms: 60_000,
    ...overrides,
  };
}

test("poll input is bounded and read-only", () => {
  assert.throws(() => poll.validatePollInput("rainbond_create_instance", input()), /read-only/i);
  assert.throws(() => poll.validatePollInput("rainbond_get_instance", input({ max_attempts: 13 })), /max_attempts/i);
  assert.throws(() => poll.validatePollInput("rainbond_get_instance", input({ interval_ms: 10_001 })), /interval/i);
  assert.throws(() => poll.validatePollInput("rainbond_get_instance", input({ timeout_ms: 60_001 })), /timeout/i);
  assert.throws(() => poll.validatePollInput("rainbond_get_instance", input({ status_path: "__proto__.x" })), /status_path/i);
  assert.doesNotThrow(() => poll.validatePollInput("rainbond_get_instance", input()));
});

test("component convergence policies return after one sixty-second wait", () => {
  for (const relativePath of [
    "contracts/runtime/cli-base.md",
    "rainbond-app-assistant/references/workflow-rules.md",
    "rainbond-fullstack-bootstrap/modules/44-source-build-rules.md",
    "rainbond-fullstack-bootstrap/modules/45-package-rules.md",
    "rainbond-opensource-app-deploy/references/deployment-workflow.md",
  ]) {
    const content = fs.readFileSync(path.join(root, relativePath), "utf8");
    assert.match(content, /rainbond_wait_for_build_completion\(timeout=60\)/, relativePath);
    assert.match(content, /status=running/, relativePath);
    assert.match(content, /结束当前回复|end the current turn/i, relativePath);
    assert.match(content, /不得[^\n]*(?:再次等待|手工轮询|继续轮询)/, relativePath);
  }
});

test("poll keeps unchanged states inside CLI and emits only transitions", async () => {
  const statuses = ["Creating", "Creating", "Creating", "Running"];
  let index = 0;
  const result = await poll.executeProtectedPoll("rainbond_get_instance", input(), {
    callTool: async () => ({ status: statuses[index++] }),
    sleep: async () => {},
    now: (() => { let value = 0; return () => value += 10; })(),
  });
  assert.equal(index, 4);
  assert.deepEqual(result.transitions.map(({ state }) => state), ["Creating", "Running"]);
  assert.equal(result.unchanged_omitted, 2);
  assert.equal(result.final_state, "Running");
  assert.equal(result.completed, true);
  assert.equal(result.blocker, null);
});

test("failure terminal state preserves blocker and retryability", async () => {
  const result = await poll.executeProtectedPoll("rainbond_get_instance", input({
    retryable_values: ["Failed"],
  }), {
    callTool: async () => ({ status: "Failed", blocker: "image-pull" }),
    sleep: async () => {},
    now: (() => { let value = 0; return () => value += 5; })(),
  });
  assert.equal(result.completed, false);
  assert.equal(result.final_state, "Failed");
  assert.equal(result.blocker, "image-pull");
  assert.equal(result.retryable, true);
});

test("read failure, timeout, and cancellation stop without hidden retries", async () => {
  let calls = 0;
  const failed = await poll.executeProtectedPoll("rainbond_get_instance", input(), {
    callTool: async () => { calls += 1; throw new Error("network"); },
    sleep: async () => {},
    now: () => 1,
  });
  assert.equal(calls, 1);
  assert.equal(failed.blocker, "read-failed");

  const timedOut = await poll.executeProtectedPoll("rainbond_get_instance", input({ timeout_ms: 1 }), {
    callTool: async () => ({ status: "Creating" }),
    sleep: async () => {},
    now: (() => { let value = 0; return () => value += 2; })(),
  });
  assert.equal(timedOut.blocker, "timeout");

  const controller = new AbortController();
  controller.abort();
  const cancelled = await poll.executeProtectedPoll("rainbond_get_instance", input(), {
    callTool: async () => ({ status: "Creating" }),
    sleep: async () => {},
    now: () => 0,
    signal: controller.signal,
  });
  assert.equal(cancelled.blocker, "cancelled");
});

test("CLI parser exposes one stdin-only poll invocation", () => {
  assert.deepEqual(parseCommand([
    "poll", "rainbond_get_ai_engine_instance", "--input", "-", "--skill-id", "rainbond-ai-assistant",
  ]), {
    command: "poll",
    toolName: "rainbond_get_ai_engine_instance",
    input: "-",
    skillId: "rainbond-ai-assistant",
  });
});
