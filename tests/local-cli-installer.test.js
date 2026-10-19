"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const { pathToFileURL } = require("node:url");

const repoRoot = path.resolve(__dirname, "..");
const installer = path.join(repoRoot, "scripts", "install-local-cli.mjs");

async function installationFixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "rainskills-cli-refresh-"));
  t.after(() => {
    t.mock.restoreAll();
    fs.rmSync(home, { recursive: true, force: true });
  });
  const { installLocalCli } = await import(pathToFileURL(installer).href);
  const warnings = [];
  const install = () => installLocalCli({ source_root: repoRoot, home, warn: (message) => warnings.push(message) });
  install();
  const root = path.join(home, ".rainbond");
  const files = [
    "lib/rainbond-platform-installer/scripts/installed-version.js",
    "lib/rainskills/bin/rainskills.js",
    "bin/rainskills-tools.js",
    "bin/delivery-probe.js",
    "bin/rainskills-skill-manifest.json",
  ].map((name) => path.join(root, name));
  return { home, root, files, warnings, install };
}

test("installed compatibility bridge loads handoff helpers from the complete bundle", async (t) => {
  const { root } = await installationFixture(t);
  const input = {
    producer: "rainbond-app-assistant", profile: "cli", observed_at: "2026-10-19T00:00:00Z",
    enterprise_id: "enterprise", team_id: "team", team_name: "default", region_name: "region",
    app_id: null, app_name: "example", endpoint: "https://example.invalid", runtime_revision: "test",
    snapshot_revision: null, source_kind: "image", runtime_state: "topology_missing",
    next_phase: "init", invalidation_reason: null,
  };
  const bridge = path.join(root, "bin", "rainskills-tools.js");
  const run = (value) => spawnSync(process.execPath, [bridge, "handoff", "create", "--input", "-", "--skill-id", "rainbond-app-assistant"], {
    input: JSON.stringify(value), encoding: "utf8", cwd: os.tmpdir(),
  });
  const result = run(input);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).schema, "rainskills.handoff-context.v1");
  const invalid = run({ ...input, app_id: -1, app_name: "do-not-echo-this-value" });
  assert.equal(invalid.status, 2, invalid.stderr);
  assert.equal(JSON.parse(invalid.stderr).code, "E_INPUT_INVALID");
  assert.doesNotMatch(invalid.stderr, /do-not-echo-this-value/);
  fs.unlinkSync(path.join(root, "lib", "rainskills", "bin", "handoff-context.js"));
  const broken = run(input);
  assert.equal(broken.status, 3, broken.stderr);
  assert.equal(JSON.parse(broken.stderr).code, "E_RUNTIME_INCOMPLETE");
});

test("installed handoff, snapshot and poll execute through the compatibility entrypoint", async (t) => {
  const { home, root } = await installationFixture(t);
  const { smokeInstalledRuntime } = require(path.join(root, "lib/rainskills/bin/runtime-smoke.js"));
  assert.deepEqual(await smokeInstalledRuntime(home), { status: "ok", checked: ["handoff", "snapshot", "poll"] });
});

function snapshot(directory) {
  return fs.readdirSync(directory).sort().flatMap((name) => {
    const file = path.join(directory, name);
    const info = fs.lstatSync(file);
    return info.isDirectory()
      ? [[name, "directory"], ...snapshot(file).map(([child, ...rest]) => [path.join(name, child), ...rest])]
      : [[name, info.mode, fs.readFileSync(file).toString("base64")]];
  });
}

test("identical CLI reinstall performs no staging, replacement, or cleanup writes", async (t) => {
  const { install, files } = await installationFixture(t);
  const before = files.map((file) => fs.statSync(file).mtimeMs);
  for (const method of ["mkdirSync", "writeFileSync", "copyFileSync", "renameSync", "rmSync", "chmodSync"]) {
    t.mock.method(fs, method, () => { throw new Error(`unexpected ${method}`); });
  }
  assert.equal(install().status, "unchanged");
  assert.deepEqual(files.map((file) => fs.statSync(file).mtimeMs), before);
});

test("same-version CLI repairs changed, missing, and unexpected files", async (t) => {
  const { install, root, files } = await installationFixture(t);
  const expected = files.map((file) => fs.readFileSync(file));
  fs.writeFileSync(files[0], "damaged runtime\n");
  fs.unlinkSync(files[1]);
  fs.writeFileSync(files[2], "damaged bridge\n");
  fs.writeFileSync(files[4], "damaged manifest\n");
  const extra = path.join(root, "lib", "rainskills", "unexpected.js");
  fs.writeFileSync(extra, "stale file\n");
  assert.equal(install().status, "installed");
  assert.deepEqual(files.map((file) => fs.readFileSync(file)), expected);
  assert.equal(fs.existsSync(extra), false);
});

test("failed replacement rolls back earlier CLI targets and preserves the original error when cleanup fails", async (t) => {
  const { install, root, files, warnings } = await installationFixture(t);
  for (const file of files) fs.writeFileSync(file, `previous ${path.basename(file)}\n`);
  const beforeLib = snapshot(path.join(root, "lib"));
  const beforeBin = snapshot(path.join(root, "bin"));
  const rename = fs.renameSync;
  let failed = false;
  t.mock.method(fs, "renameSync", (from, to) => {
    if (to === files[3] && !failed) {
      failed = true;
      throw new Error("SIMULATED_SANDBOX_REPLACE_DENIED");
    }
    return rename(from, to);
  });
  t.mock.method(fs, "rmSync", () => { throw new Error("SIMULATED_SAFE_DELETE_CONFIRM_REQUIRED"); });
  assert.throws(install, (error) => {
    assert.match(error.message, /replace.*SIMULATED_SANDBOX_REPLACE_DENIED/);
    return true;
  });
  assert.deepEqual(snapshot(path.join(root, "lib")), beforeLib);
  assert.deepEqual(snapshot(path.join(root, "bin")), beforeBin);
  assert(warnings.some((message) => /cleanup.*SIMULATED_SAFE_DELETE_CONFIRM_REQUIRED/.test(message)));
});

test("verified installation succeeds with deferred cleanup and a later unchanged install leaves it alone", async (t) => {
  const { install, root, files, warnings } = await installationFixture(t);
  fs.writeFileSync(files[0], "old runtime\n");
  t.mock.method(fs, "rmSync", () => { throw new Error("SIMULATED_SAFE_DELETE_CONFIRM_REQUIRED"); });
  const result = install();
  assert.equal(result.status, "installed");
  assert.equal(result.cleanupPending.length, 1);
  assert(result.cleanupPending[0].startsWith(path.join(root, ".cli-install.")));
  assert.equal(fs.existsSync(result.cleanupPending[0]), true);
  assert(warnings.some((message) => message.includes("SIMULATED_SAFE_DELETE_CONFIRM_REQUIRED")));
  assert.equal(install().status, "unchanged");
});

test("verification failure restores the original CLI files", async (t) => {
  const { install, root, files } = await installationFixture(t);
  fs.writeFileSync(files[2], "original bridge\n");
  const before = snapshot(path.join(root, "bin"));
  const rename = fs.renameSync;
  let corrupted = false;
  t.mock.method(fs, "renameSync", (from, to) => {
    rename(from, to);
    if (to === files[2] && !corrupted) {
      corrupted = true;
      fs.writeFileSync(to, "corrupted after publication\n");
    }
  });
  assert.throws(install, /verify/);
  assert.deepEqual(snapshot(path.join(root, "bin")), before);
});

test("staging failure leaves every installed target intact even when cleanup is denied", async (t) => {
  const { install, root, files } = await installationFixture(t);
  fs.writeFileSync(files[0], "original runtime\n");
  const before = snapshot(path.join(root, "lib"));
  t.mock.method(fs, "writeFileSync", () => { throw new Error("SIMULATED_STAGE_WRITE_DENIED"); });
  t.mock.method(fs, "rmSync", () => { throw new Error("SIMULATED_CLEANUP_DENIED"); });
  assert.throws(install, /stage.*SIMULATED_STAGE_WRITE_DENIED/);
  assert.deepEqual(snapshot(path.join(root, "lib")), before);
});

test("rollback failure retains recoverable backups and reports both failures", async (t) => {
  const { install, root, files } = await installationFixture(t);
  fs.writeFileSync(files[0], "original runtime\n");
  fs.writeFileSync(files[2], "original bridge\n");
  const runtime = path.join(root, "lib", "rainbond-platform-installer");
  const rename = fs.renameSync;
  let replacing = true;
  t.mock.method(fs, "renameSync", (from, to) => {
    if (replacing && to === files[2]) {
      replacing = false;
      throw new Error("SIMULATED_REPLACE_DENIED");
    }
    if (!replacing && to === runtime) throw new Error("SIMULATED_ROLLBACK_DENIED");
    return rename(from, to);
  });
  t.mock.method(fs, "rmSync", () => { assert.fail("recovery backups must not be deleted"); });
  assert.throws(install, (error) => {
    assert.match(error.message, /replace.*SIMULATED_REPLACE_DENIED/);
    assert.match(error.message, /rollback incomplete.*SIMULATED_ROLLBACK_DENIED/);
    return true;
  });
  const retained = fs.readdirSync(root).find((name) => name.startsWith(".cli-install."));
  assert(retained);
  const journal = JSON.parse(fs.readFileSync(path.join(root, retained, "transaction.json"), "utf8"));
  const entry = journal.entries.find((item) => item.destination === runtime);
  assert.equal(fs.readFileSync(path.join(entry.backup, "scripts", "installed-version.js"), "utf8"), "original runtime\n");
});

test("legacy configuration migration failure also rolls back CLI publication", async (t) => {
  const { install, root, files, home } = await installationFixture(t);
  fs.writeFileSync(files[2], "original bridge\n");
  const config = path.join(home, ".claude.json");
  const content = JSON.stringify({ mcpServers: { rainbond: { command: "npx", args: ["rainskills@0.1.6", "mcp", "serve"] } } });
  fs.writeFileSync(config, content);
  const before = snapshot(path.join(root, "bin"));
  const rename = fs.renameSync;
  let failed = false;
  t.mock.method(fs, "renameSync", (from, to) => {
    if (to === config && !failed) {
      failed = true;
      throw new Error("SIMULATED_CONFIG_REPLACE_DENIED");
    }
    return rename(from, to);
  });
  assert.throws(install, /replace.*SIMULATED_CONFIG_REPLACE_DENIED/);
  assert.equal(fs.readFileSync(config, "utf8"), content);
  assert.equal(fs.existsSync(`${config}.rainskills-backup`), false);
  assert.deepEqual(snapshot(path.join(root, "bin")), before);
});

test("unsafe CLI destination links are rejected without modifying their targets", { skip: process.platform === "win32" }, async (t) => {
  const { install, root, files, home } = await installationFixture(t);
  const external = path.join(home, "external.js");
  fs.writeFileSync(external, "untouched\n");
  fs.unlinkSync(files[2]);
  fs.symlinkSync(external, files[2]);
  assert.throws(install, /symbolic|symlink/i);
  assert.equal(fs.readFileSync(external, "utf8"), "untouched\n");
  assert(fs.lstatSync(files[2]).isSymbolicLink());
  assert(!fs.readdirSync(root).some((name) => name.startsWith(".cli-install.")));
});

test("local CLI installer publishes a protected stable bridge and removes only legacy Rainskills MCP entries", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "rainskills-local-cli-"));
  const codexDirectory = path.join(home, ".codex");
  fs.mkdirSync(codexDirectory, { recursive: true });
  fs.writeFileSync(path.join(codexDirectory, "config.toml"), [
    "[mcp_servers.keep]",
    "url = \"https://keep.example/mcp\"",
    "",
    "[mcp_servers.rainbond]",
    "command = \"npx\"",
    "args = [\"--yes\", \"rainskills@0.1.6\", \"mcp\", \"serve\", \"--client\", \"codex\"]",
    "",
    "[features]",
    "web_search = true",
    "",
  ].join("\n"));
  fs.writeFileSync(path.join(home, ".claude.json"), `${JSON.stringify({
    mcpServers: {
      rainbond: {
        command: "npx",
        args: ["--yes", "rainskills@0.1.6", "mcp", "serve", "--client", "claude"],
      },
      keep: { url: "https://keep.example/mcp" },
    },
    theme: "dark",
  }, null, 2)}\n`);

  const result = spawnSync(process.execPath, [
    installer,
    "--source-root", repoRoot,
    "--home", home,
  ], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);

  const binDirectory = path.join(home, ".rainbond", "bin");
  const bridge = path.join(binDirectory, "rainskills-tools.js");
  const deliveryProbe = path.join(binDirectory, "delivery-probe.js");
  const manifest = path.join(binDirectory, "rainskills-skill-manifest.json");
  const localCli = path.join(
    home,
    ".rainbond",
    "lib",
    "rainskills",
    "bin",
    "rainskills.js"
  );
  const localManifest = path.join(
    home,
    ".rainbond",
    "lib",
    "rainskills",
    "package.json"
  );
  const localRootSkill = path.join(
    home,
    ".rainbond",
    "lib",
    "rainskills",
    "marketplace",
    "rainskills",
    "skills",
    "rainskills",
    "SKILL.md"
  );
  const runtimeModule = path.join(
    home,
    ".rainbond",
    "lib",
    "rainbond-platform-installer",
    "scripts",
    "single-runtime.js"
  );
  assert.equal(fs.existsSync(bridge), true);
  assert.equal(fs.existsSync(deliveryProbe), true);
  assert.equal(fs.existsSync(manifest), true);
  assert.equal(fs.existsSync(localCli), true);
  assert.equal(fs.existsSync(localManifest), true);
  assert.equal(fs.existsSync(localRootSkill), true);
  assert.equal(require(localManifest).version, require("../package.json").version);
  const installedLauncher = require(localCli);
  const platformInvocation = installedLauncher.resolveInvocation([
    "platform", "install", "--location", "server",
  ]);
  assert.equal(platformInvocation.executable, process.execPath);
  assert.equal(fs.existsSync(platformInvocation.args[0]), true);
  assert.equal(fs.existsSync(runtimeModule), true);
  assert.equal(fs.lstatSync(bridge).isSymbolicLink(), false);
  assert.equal(fs.lstatSync(deliveryProbe).isSymbolicLink(), false);
  assert.equal(fs.statSync(deliveryProbe).mode & 0o077, 0);
  assert.equal(fs.statSync(manifest).mode & 0o077, 0);
  assert.equal(JSON.parse(fs.readFileSync(manifest, "utf8")).schema, "rainskills.skill-manifest.v1");
  const probeResult = spawnSync(process.execPath, [
    bridge,
    "delivery", "probe", "--input", "-",
    "--skill-id", "rainbond-delivery-verifier",
  ], {
    encoding: "utf8",
    input: JSON.stringify({
      policy_version: "rainskills.delivery-probe-policy.v1",
      url: "file:///etc/passwd",
      method: "GET",
    }),
  });
  assert.equal(probeResult.status, 0, probeResult.stderr);
  assert.equal(JSON.parse(probeResult.stdout).status, "rejected");

  const codex = fs.readFileSync(path.join(codexDirectory, "config.toml"), "utf8");
  assert.match(codex, /mcp_servers\.keep/);
  assert.match(codex, /\[features\]/);
  assert.doesNotMatch(codex, /rainskills@0\.1\.6|mcp_servers\.rainbond/);
  const claude = JSON.parse(fs.readFileSync(path.join(home, ".claude.json"), "utf8"));
  assert.deepEqual(claude.mcpServers.keep, { url: "https://keep.example/mcp" });
  assert.equal(claude.mcpServers.rainbond, undefined);
  assert.equal(claude.theme, "dark");

  const workBuddySkills = path.join(home, ".workbuddy", "skills");
  const repair = spawnSync(process.execPath, [
    localCli,
    "workbuddy",
    "--force",
    "--non-interactive",
    "--no-telemetry",
  ], {
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: home,
      RAINSKILLS_TELEMETRY_DISABLED: "1",
      WORKBUDDY_CONFIG_DIR: "",
    },
  });
  assert.equal(repair.status, 0, repair.stderr || repair.stdout);
  assert.equal(
    fs.existsSync(path.join(workBuddySkills, "rainskills", "SKILL.md")),
    true
  );
});

test("migration preserves direct Rainbond MCP entries that were not owned by Rainskills", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "rainskills-direct-mcp-"));
  fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
  const direct = [
    "[mcp_servers.rainbond]",
    "url = \"https://console.example/console/mcp/query\"",
    "bearer_token_env_var = \"RAINBOND_JWT\"",
    "",
  ].join("\n");
  fs.writeFileSync(path.join(home, ".codex", "config.toml"), direct);
  fs.writeFileSync(path.join(home, ".claude.json"), `${JSON.stringify({
    mcpServers: { rainbond: { url: "https://console.example/console/mcp/query" } },
  })}\n`);

  const result = spawnSync(process.execPath, [
    installer,
    "--source-root", repoRoot,
    "--home", home,
  ], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(path.join(home, ".codex", "config.toml"), "utf8"), direct);
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(home, ".claude.json"), "utf8")).mcpServers.rainbond.url,
    "https://console.example/console/mcp/query"
  );
});
