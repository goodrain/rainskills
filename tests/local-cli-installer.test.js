"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const repoRoot = path.resolve(__dirname, "..");
const installer = path.join(repoRoot, "scripts", "install-local-cli.mjs");

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
  const runtimeModule = path.join(
    home,
    ".rainbond",
    "lib",
    "rainbond-platform-installer",
    "scripts",
    "runtime-operations.js"
  );
  assert.equal(fs.existsSync(bridge), true);
  assert.equal(fs.existsSync(manifest), true);
  assert.equal(fs.existsSync(localCli), true);
  assert.equal(fs.existsSync(localManifest), true);
  assert.equal(require(localManifest).version, require("../package.json").version);
  const installedLauncher = require(localCli);
  const platformInvocation = installedLauncher.resolveInvocation([
    "platform", "install", "--location", "server",
  ]);
  assert.equal(platformInvocation.executable, process.execPath);
  assert.equal(fs.existsSync(platformInvocation.args[0]), true);
  assert.equal(fs.existsSync(runtimeModule), true);
  assert.equal(fs.lstatSync(bridge).isSymbolicLink(), false);
  assert.equal(fs.statSync(manifest).mode & 0o077, 0);
  assert.equal(JSON.parse(fs.readFileSync(manifest, "utf8")).schema, "rainskills.skill-manifest.v1");

  const codex = fs.readFileSync(path.join(codexDirectory, "config.toml"), "utf8");
  assert.match(codex, /mcp_servers\.keep/);
  assert.match(codex, /\[features\]/);
  assert.doesNotMatch(codex, /rainskills@0\.1\.6|mcp_servers\.rainbond/);
  const claude = JSON.parse(fs.readFileSync(path.join(home, ".claude.json"), "utf8"));
  assert.deepEqual(claude.mcpServers.keep, { url: "https://keep.example/mcp" });
  assert.equal(claude.mcpServers.rainbond, undefined);
  assert.equal(claude.theme, "dark");
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
