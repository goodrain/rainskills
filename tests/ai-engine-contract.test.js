"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const vendored = path.join(root, "contracts", "ai-engine-skills-prerequisites-v1.json");
const authoritativeRoot = process.env.RAINBOND_AI_ENGINE_ROOT || path.resolve(root, "..", "rainbond-ai-engine");
const authoritative = path.join(authoritativeRoot, "contracts", "skills-prerequisites-v1.json");

test("vendored AI Engine prerequisite contract matches the authoritative contract", () => {
  assert.equal(fs.existsSync(vendored), true, "vendored contract is missing");
  const snapshot = JSON.parse(fs.readFileSync(vendored, "utf8"));
  assert.equal(snapshot.schema, "rainbond.ai-engine.skills-prerequisites.v1");
  assert.deepEqual(snapshot.deployment.terminal_instance_statuses, ["Running", "Failed", "Stopped"]);
  assert.deepEqual(snapshot.gpu.allocation_modes, [
    "standard_whole_gpu",
    "hami_shared_auto",
    "hami_whole_gpu_fallback",
  ]);
  assert.deepEqual(snapshot.gpu.request_units, ["physical_gpu", "hami_vgpu"]);
  assert.equal(snapshot.gpu.usage_sources.includes("unavailable"), true);

  if (fs.existsSync(authoritative)) {
    assert.deepEqual(snapshot, JSON.parse(fs.readFileSync(authoritative, "utf8")));
  }
});

test("vendored MCP names remain present in the adjacent Console Tool Catalog", () => {
  const consoleRoot = process.env.RAINBOND_CONSOLE_ROOT || path.resolve(root, "..", "rainbond-console");
  const aiTools = path.join(consoleRoot, "console", "services", "mcp_ai_engine_tools.py");
  const pluginTools = path.join(consoleRoot, "console", "services", "mcp_platform_plugin_tools.py");
  if (!fs.existsSync(aiTools) || !fs.existsSync(pluginTools)) return;

  const contract = JSON.parse(fs.readFileSync(vendored, "utf8"));
  const aiSource = fs.readFileSync(aiTools, "utf8");
  for (const toolName of Object.values(contract.mcp_tools)) {
    assert.match(aiSource, new RegExp(`['\"]${toolName}['\"]`), toolName);
  }
  const pluginSource = fs.readFileSync(pluginTools, "utf8");
  assert.match(pluginSource, /["']rainbond_list_platform_plugins["']/);
  assert.match(pluginSource, /["']rainbond_install_platform_plugin["']/);
});

test("transport-neutral references route every AI Engine Tool by its stable name", () => {
  const references = fs.readdirSync(path.join(root, "rainbond-ai-assistant", "references"))
    .filter((name) => name.endsWith(".md") && name !== "runtime-gate.md")
    .map((name) => fs.readFileSync(path.join(root, "rainbond-ai-assistant", "references", name), "utf8"))
    .join("\n");
  const consoleRoot = process.env.RAINBOND_CONSOLE_ROOT || path.resolve(root, "..", "rainbond-console");
  const consoleTools = path.join(consoleRoot, "console", "services", "mcp_ai_engine_tools.py");
  if (!fs.existsSync(consoleTools)) return;
  const source = fs.readFileSync(consoleTools, "utf8");
  const names = [...source.matchAll(/["'](rainbond_(?:get|list|search|create|update|delete)_ai_engine_[a-z_]+)["']\s*:/g)]
    .map((match) => match[1]);
  for (const name of new Set(names)) assert.match(references, new RegExp(`\\b${name}\\b`), name);
});
