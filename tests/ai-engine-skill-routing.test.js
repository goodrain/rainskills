"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const root = path.resolve(__dirname, "..");

test("AI Engine, plugin, platform, and ordinary app intents remain mutually routed", () => {
  const result = spawnSync("python3", [path.join(root, "tests", "run_skill_routing_evals.py")], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  for (const id of [
    "install_platform_plugin",
    "deploy_model_on_cpu",
    "deploy_model_on_gpu",
    "install_rainbond_platform",
    "generic_deploy_current_project",
  ]) {
    assert.match(result.stdout, new RegExp(`PASS ${id}`));
  }
});

test("AI Engine context resolution uses the exact literal runtime contract", () => {
  const gate = require("node:fs").readFileSync(
    path.join(root, "rainbond-ai-assistant", "references", "runtime-gate.md"),
    "utf8",
  );

  assert.match(gate, /\{"required":\["enterprise","workspace"\]\}[^\n]*字面/);
  assert.match(gate, /context resolve[^\n]*(?:禁止|不得)[^\n]*--help/);
  assert.match(gate, /context resolve[^\n]*(?:禁止|不得)[^\n]*空[^\n]*\{\}/);
  assert.match(gate, /required[^\n]*(?:维度|dimensions)[^\n]*(?:不是|并非)[^\n]*(?:值|value)/);
});
