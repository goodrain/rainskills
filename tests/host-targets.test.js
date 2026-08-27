const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const {
  HOST_TARGETS,
  destinationsForHostTarget,
  isHostTarget,
  telemetryClientForTarget,
} = require("../rainbond-platform-installer/scripts/host-targets.js");

test("host target registry exposes every first-class Rainskills host", () => {
  assert.deepEqual(HOST_TARGETS, [
    "codex", "claude", "pi", "dsh", "workbuddy", "all",
  ]);
  for (const target of HOST_TARGETS) assert.equal(isHostTarget(target), true);
  assert.equal(isHostTarget("openclaw"), false);
  assert.equal(telemetryClientForTarget("claude"), "claude_code");
  assert.equal(telemetryClientForTarget("dsh"), "deepseek_harness");
  assert.equal(telemetryClientForTarget("workbuddy"), "workbuddy");
});

test("DeepSeek Harness and WorkBuddy destinations honor their config homes", () => {
  const home = path.resolve("/tmp/rainskills-host-home");
  const env = {
    DSH_HOME: path.join(home, "custom-dsh"),
    WORKBUDDY_CONFIG_DIR: path.join(home, "custom-workbuddy"),
  };
  assert.deepEqual(destinationsForHostTarget("dsh", home, env), [
    path.join(home, "custom-dsh", "skills"),
  ]);
  assert.deepEqual(destinationsForHostTarget("workbuddy", home, env), [
    path.join(home, "custom-workbuddy", "skills"),
  ]);
  assert.deepEqual(destinationsForHostTarget("all", home, env), [
    path.join(home, ".claude", "skills"),
    path.join(home, ".codex", "skills"),
    path.join(home, ".pi", "agent", "skills"),
    path.join(home, "custom-dsh", "skills"),
    path.join(home, "custom-workbuddy", "skills"),
  ]);
});
