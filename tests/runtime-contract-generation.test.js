"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const YAML = require("yaml");

const repoRoot = path.resolve(__dirname, "..");
const syncScript = path.join(repoRoot, "scripts", "sync-runtime-contracts.mjs");
const skillIds = [
  "rainbond-ai-assistant",
  "rainbond-app-assistant",
  "rainbond-app-version-assistant",
  "rainbond-delivery-verifier",
  "rainbond-env-sync",
  "rainbond-fullstack-bootstrap",
  "rainbond-fullstack-troubleshooter",
  "rainbond-opensource-app-deploy",
  "rainbond-platform-plugin-manager",
  "rainbond-platform-query",
  "rainbond-project-init",
  "rainbond-scheduled-task",
  "rainbond-template-installer",
];
const overlayKeys = [
  "command_set",
  "invariants",
  "missing_runtime_mode",
  "profiles",
  "resume_target",
  "schema",
  "scope_discriminator",
  "skill_id",
  "version_guard",
];

function generatedPath(root, skillId) {
  return path.join(root, skillId, "references", "generated", "runtime-gate.md");
}

function generatedRoutingPath(root, skillId) {
  return path.join(root, skillId, "references", "generated", "runtime-routing.md");
}

function extractContract(content) {
  const match = content.match(/```json\n([\s\S]*?)\n```/);
  assert(match, "generated CLI Runtime Gate must contain its fixed JSON contract");
  return JSON.parse(match[1]);
}

test("Runtime Gate sources and overlays are canonical, strict, and complete", () => {
  for (const source of ["cli-base.md", "embedded-base.md", "overlay.schema.json"]) {
    assert(fs.existsSync(path.join(repoRoot, "contracts", "runtime", source)), source);
  }

  for (const skillId of skillIds) {
    const overlayPath = path.join(repoRoot, "contracts", "runtime", "skills", `${skillId}.yaml`);
    const overlay = YAML.parse(fs.readFileSync(overlayPath, "utf8"));
    assert.deepEqual(Object.keys(overlay).filter((key) => key !== "cli_only_commands").sort(), overlayKeys, skillId);
    if (overlay.cli_only_commands) {
      assert(overlay.cli_only_commands.every((command) => overlay.command_set.includes(command)));
    }
    assert.equal(overlay.schema, "rainskills.runtime-overlay.v1", skillId);
    assert.equal(overlay.skill_id, skillId, skillId);
    assert(overlay.profiles.includes("cli"), skillId);
    assert(overlay.profiles.every((profile) => ["cli", "embedded"].includes(profile)), skillId);
    assert(Array.isArray(overlay.command_set) && overlay.command_set.length > 0, skillId);
    assert(Array.isArray(overlay.invariants) && overlay.invariants.length >= 1, skillId);
  }
});

test("source entrypoints load one generated Runtime Gate without embedding the full block", () => {
  for (const skillId of skillIds) {
    const entrypoint = fs.readFileSync(path.join(repoRoot, skillId, "SKILL.md"), "utf8");
    assert.doesNotMatch(entrypoint, /<!-- rainskills-runtime-gate:start -->/, skillId);
    assert.match(entrypoint, /references\/generated\/runtime-gate\.md/, skillId);
    assert.match(entrypoint, /本会话.*一次|once.*session/i, skillId);
    assert.equal(
      fs.existsSync(path.join(repoRoot, skillId, "references", "runtime-gate.md")),
      false,
      `${skillId} must not retain an editable legacy Runtime Gate`,
    );
  }
});

test("generated CLI references are current, source-digested, and preserve command boundaries", () => {
  const result = spawnSync(process.execPath, [syncScript, "--check"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);

  for (const skillId of skillIds) {
    const content = fs.readFileSync(generatedPath(repoRoot, skillId), "utf8");
    assert.match(content, /generated-by: scripts\/sync-runtime-contracts\.mjs/);
    assert.match(content, /source-sha256: [a-f0-9]{64}/);
    assert.match(content, /profile: cli/);
    assert.match(content, /rainskills\.runtime-connect-result\.v1/);
    assert.match(content, /write_stdin/);
    assert.match(content, /403/);
    const contract = extractContract(content);
    assert.equal(contract.package_version, `rainskills@${require("../package.json").version}`, skillId);
    for (const command of Object.values(contract.input_commands)) {
      assert(command.argv.includes("--skill-id"), skillId);
      assert(command.argv.includes(skillId), skillId);
    }
  }

  assert.deepEqual(
    Object.keys(extractContract(fs.readFileSync(generatedPath(repoRoot, "rainbond-platform-query"), "utf8")).input_commands),
    ["query"],
  );
  assert("delivery_probe" in extractContract(
    fs.readFileSync(generatedPath(repoRoot, "rainbond-delivery-verifier"), "utf8"),
  ).input_commands);
  assert("package_upload" in extractContract(
    fs.readFileSync(generatedPath(repoRoot, "rainbond-fullstack-bootstrap"), "utf8"),
  ).input_commands);
});

test("renderer is deterministic, rejects unknown overlay keys, and binds source changes", async () => {
  const runtime = await import("../scripts/lib/runtime-contracts.mjs");
  const overlay = runtime.readRuntimeOverlay(repoRoot, "rainbond-app-assistant");
  const first = runtime.renderRuntimeGate({
    sourceRoot: repoRoot,
    packageVersion: "0.1.43",
    overlay,
    profile: "cli",
  });
  const second = runtime.renderRuntimeGate({
    sourceRoot: repoRoot,
    packageVersion: "0.1.43",
    overlay,
    profile: "cli",
  });
  assert.equal(first, second);

  const changed = runtime.renderRuntimeGate({
    sourceRoot: repoRoot,
    packageVersion: "0.1.43",
    overlay: { ...overlay, invariants: [...overlay.invariants, "changed fixture invariant"] },
    profile: "cli",
  });
  assert.notEqual(first, changed);

  assert.throws(
    () => runtime.validateRuntimeOverlay({ ...overlay, unknown_key: true }, overlay.skill_id),
    /unknown overlay key/i,
  );
});

test("embedded profile receives generated embedded gates with no CLI-only transport markers", () => {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), "rainskills-runtime-generated-"));
  const result = spawnSync(process.execPath, [
    path.join(repoRoot, "scripts", "build-skill-profile.mjs"),
    "--profile", "embedded",
    "--source-root", repoRoot,
    "--output", output,
    "--revision", "runtime-contract-test",
  ], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);

  for (const skillId of skillIds.filter((id) => fs.existsSync(path.join(output, id)))) {
    const content = fs.readFileSync(generatedPath(output, skillId), "utf8");
    assert.match(content, /profile: embedded/);
    assert.match(content, /rainbond_\*/);
    assert.doesNotMatch(
      content,
      /rainskills-tools\.js|rainskills\.js|Device Flow|write_stdin|require_escalated|npm root -g/,
      skillId,
    );
  }
});

test("source entrypoints use generated Runtime Routing with no editable routing blocks", () => {
  assert(fs.existsSync(path.join(repoRoot, "contracts", "runtime", "routing-modes.yaml")));
  for (const skillId of skillIds) {
    const entrypoint = fs.readFileSync(path.join(repoRoot, skillId, "SKILL.md"), "utf8");
    assert.doesNotMatch(entrypoint, /<!-- rainskills-runtime-routing:start -->/, skillId);
    assert.match(entrypoint, /references\/generated\/runtime-routing\.md/, skillId);
    assert.equal(
      fs.existsSync(path.join(repoRoot, skillId, "references", "runtime-routing.md")),
      false,
      `${skillId} must not retain editable Runtime Routing`,
    );
    const generated = fs.readFileSync(generatedRoutingPath(repoRoot, skillId), "utf8");
    assert.match(generated, /generated-by: scripts\/sync-runtime-contracts\.mjs/);
    assert.match(generated, /source-sha256: [a-f0-9]{64}/);
    assert.match(generated, /profile: cli/);
  }
});

test("generated Runtime Routing preserves flattened new-app and bounded existing-app choices", () => {
  const newApp = fs.readFileSync(generatedRoutingPath(repoRoot, "rainbond-app-assistant"), "utf8");
  assert.match(newApp, /new-application-environment/);
  assert.match(
    newApp,
    /1\) Rainbond Cloud云端环境（推荐）——最快体验，不需要准备服务器\s+2\) 独立服务器——适合长期运行，在你的服务器上安装开源 Rainbond\s+3\) 本机环境——适合本地验证，在当前电脑上准备运行环境\s+4\) 已有 Rainbond——连接现有 Rainbond 环境并继续部署/,
  );
  assert.doesNotMatch(newApp, /私有环境（去对接）/);

  for (const skillId of [
    "rainbond-ai-assistant",
    "rainbond-app-version-assistant",
    "rainbond-delivery-verifier",
    "rainbond-env-sync",
    "rainbond-fullstack-troubleshooter",
    "rainbond-platform-plugin-manager",
    "rainbond-platform-query",
  ]) {
    const existing = fs.readFileSync(generatedRoutingPath(repoRoot, skillId), "utf8");
    assert.match(existing, /Rainbond Cloud/);
    assert.match(existing, /已有私有 Rainbond/);
    assert.doesNotMatch(existing, /本机环境|独立服务器|install_private/, skillId);
  }
});

test("embedded profile receives server-owned Runtime Routing without client menus", () => {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), "rainskills-routing-generated-"));
  const result = spawnSync(process.execPath, [
    path.join(repoRoot, "scripts", "build-skill-profile.mjs"),
    "--profile", "embedded",
    "--source-root", repoRoot,
    "--output", output,
    "--revision", "runtime-routing-test",
  ], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  for (const skillId of skillIds.filter((id) => fs.existsSync(path.join(output, id)))) {
    const content = fs.readFileSync(generatedRoutingPath(output, skillId), "utf8");
    assert.match(content, /profile: embedded/);
    assert.match(content, /Agent 管理员|服务端 Rainbond 连接/);
    assert.doesNotMatch(content, /runtime connect|Device Flow|本机环境|独立服务器|new-application-environment/);
  }
});
