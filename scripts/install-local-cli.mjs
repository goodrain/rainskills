#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { buildSkillManifest } from "./build-skill-manifest.mjs";

const scriptRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const requireFromInstaller = createRequire(import.meta.url);
const RUNTIME_BUNDLE_DIRECTORIES = Object.freeze([
  "bin",
  "scripts",
  "contracts",
  "marketplace",
  "rainbond-ai-assistant",
  "rainbond-app-assistant",
  "rainbond-app-version-assistant",
  "rainbond-delivery-verifier",
  "rainbond-env-sync",
  "rainbond-fullstack-bootstrap",
  "rainbond-fullstack-troubleshooter",
  "rainbond-opensource-app-deploy",
  "rainbond-platform-installer",
  "rainbond-platform-plugin-manager",
  "rainbond-platform-query",
  "rainbond-project-init",
  "rainbond-template-installer",
]);
const RUNTIME_BUNDLE_FILES = Object.freeze(["install.sh", "package.json"]);

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const option = argv[index];
    const value = argv[index + 1];
    if (!["--source-root", "--home"].includes(option) || !value) {
      throw new Error("usage: install-local-cli --source-root <path> --home <path>");
    }
    result[option.slice(2).replace(/-/g, "_")] = value;
  }
  result.source_root ||= scriptRoot;
  result.home ||= os.homedir();
  return result;
}

function assertRegularPath(absolute, expected) {
  const info = fs.lstatSync(absolute);
  if (info.isSymbolicLink() || (expected === "file" ? !info.isFile() : !info.isDirectory())) {
    throw new Error(`${expected} source is not a regular path`);
  }
}

function lstatIfPresent(file) {
  try { return fs.lstatSync(file); } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

// Capture bytes before replacing anything: source may itself be the installed CLI.
function readTree(root, { privateDirectories = false } = {}) {
  if (!lstatIfPresent(root)) return null;
  const entries = new Map();
  function visit(relative) {
    const file = path.join(root, relative);
    const info = fs.lstatSync(file);
    if (info.isSymbolicLink()) throw new Error(`symbolic link is not allowed in CLI paths: ${file}`);
    if (info.isDirectory()) {
      entries.set(relative, { kind: "directory", mode: privateDirectories ? 0o700 : info.mode & 0o777 });
      for (const name of fs.readdirSync(file).sort()) visit(path.join(relative, name));
    } else if (info.isFile()) {
      entries.set(relative, { kind: "file", mode: info.mode & 0o777, content: fs.readFileSync(file) });
    } else throw new Error(`unsupported CLI file type: ${file}`);
  }
  visit("");
  return entries;
}

function directoryTree() {
  return new Map([["", { kind: "directory", mode: 0o700 }]]);
}

function fileTree(content, mode) {
  return new Map([["", { kind: "file", mode, content: Buffer.from(content) }]]);
}

function addSource(tree, source, relative, kind, mode) {
  assertRegularPath(source, kind);
  const entries = readTree(source, { privateDirectories: true });
  if (mode !== undefined) entries.get("").mode = mode;
  for (const [name, entry] of entries) tree.set(relative ? path.join(relative, name) : name, entry);
}

function treesEqual(expected, actual) {
  if (!expected || !actual) return expected === actual;
  if (expected.size !== actual.size) return false;
  for (const [name, entry] of expected) {
    const other = actual.get(name);
    if (!other || other.kind !== entry.kind) return false;
    // Windows ACL protection is not represented by POSIX mode bits.
    if (process.platform !== "win32" && other.mode !== entry.mode) return false;
    if (entry.kind === "file" && !entry.content.equals(other.content)) return false;
  }
  return true;
}

function writeTree(root, tree) {
  for (const [relative, entry] of tree) {
    const target = path.join(root, relative);
    if (entry.kind === "directory") fs.mkdirSync(target, { mode: entry.mode });
    else fs.writeFileSync(target, entry.content, { mode: entry.mode, flag: "wx" });
    fs.chmodSync(target, entry.mode);
  }
}

function assertDestinationParents(home, destination) {
  const relative = path.relative(home, destination);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("CLI destination must be inside the selected home");
  }
  let current = home;
  for (const segment of relative.split(path.sep).slice(0, -1)) {
    current = path.join(current, segment);
    const info = lstatIfPresent(current);
    if (info && (info.isSymbolicLink() || !info.isDirectory())) {
      throw new Error(`CLI destination parent must be a regular directory, not a symbolic link: ${current}`);
    }
  }
}

function ensurePrivateDirectory(directory) {
  if (!lstatIfPresent(directory)) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  assertRegularPath(directory, "directory");
  if (process.platform !== "win32" && (fs.statSync(directory).mode & 0o777) !== 0o700) {
    fs.chmodSync(directory, 0o700);
  }
}

function safeConfigFile(file) {
  try {
    const info = fs.lstatSync(file);
    return info.isFile() && !info.isSymbolicLink() && info.size <= 4 * 1024 * 1024;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

function migratedConfig(file, original, content) {
  return [
    { destination: `${file}.rainskills-backup`, tree: fileTree(original, 0o600) },
    { destination: file, tree: fileTree(content, 0o600) },
  ];
}

function isLegacyRainskillsMcp(server) {
  if (!server || typeof server !== "object" || Array.isArray(server)) return false;
  const command = typeof server.command === "string" ? server.command : "";
  const args = Array.isArray(server.args) ? server.args.filter((value) => typeof value === "string") : [];
  return /(?:^|[\\/])npx(?:\.cmd)?$/i.test(command)
    && args.some((value) => /^rainskills@/i.test(value))
    && args.includes("mcp")
    && args.includes("serve");
}

function migrateCodex(home) {
  const file = path.join(home, ".codex", "config.toml");
  if (!safeConfigFile(file)) return [];
  const source = fs.readFileSync(file, "utf8");
  const sections = source.split(/(?=^\s*\[[^\r\n]+\]\s*$)/m);
  const filtered = sections.filter((section) => {
    if (!/^\s*\[mcp_servers\.rainbond\]\s*$/m.test(section)) return true;
    return !/command\s*=\s*["'](?:npx|npx\.cmd)["']/i.test(section)
      || !/rainskills@/i.test(section)
      || !/["']mcp["']/i.test(section)
      || !/["']serve["']/i.test(section);
  });
  const output = filtered.join("");
  if (output === source) return [];
  return migratedConfig(file, source, output);
}

function migrateClaude(home) {
  const file = path.join(home, ".claude.json");
  if (!safeConfigFile(file)) return [];
  const source = fs.readFileSync(file, "utf8");
  const payload = JSON.parse(source);
  if (!isLegacyRainskillsMcp(payload?.mcpServers?.rainbond)) return [];
  delete payload.mcpServers.rainbond;
  return migratedConfig(file, source, `${JSON.stringify(payload, null, 2)}\n`);
}

export function installLocalCli({ source_root: sourceRoot, home, warn = (message) => process.stderr.write(`${message}\n`) }) {
  const source = path.resolve(sourceRoot);
  const targetHome = path.resolve(home);
  const rainbondHome = path.join(targetHome, ".rainbond");
  const binDirectory = path.join(rainbondHome, "bin");
  const libDirectory = path.join(rainbondHome, "lib");
  let staging;
  let phase = "prepare";
  let retainBackups = false;
  const transactions = [];
  const cleanupPending = [];
  const warning = (message) => { try { warn(message); } catch { /* diagnostics cannot mask an install error */ } };
  try {
    assertRegularPath(source, "directory");
    const runtime = directoryTree();
    addSource(runtime, path.join(source, "rainbond-platform-installer", "scripts"), "scripts", "directory");
    const bundle = directoryTree();
    for (const directory of RUNTIME_BUNDLE_DIRECTORIES) addSource(bundle, path.join(source, directory), directory, "directory");
    for (const file of RUNTIME_BUNDLE_FILES) addSource(bundle, path.join(source, file), file, "file", file === "install.sh" ? 0o700 : 0o600);
    bundle.set("node_modules", { kind: "directory", mode: 0o700 });
    const yamlPackage = requireFromInstaller.resolve("yaml/package.json", { paths: [source] });
    addSource(bundle, path.dirname(yamlPackage), path.join("node_modules", "yaml"), "directory");
    const manifest = buildSkillManifest({ source_root: source });
    const plan = [
      { destination: path.join(libDirectory, "rainbond-platform-installer"), tree: runtime },
      { destination: path.join(libDirectory, "rainskills"), tree: bundle },
    ];
    const bridgeShim = `#!/usr/bin/env node
"use strict";
try {
  const bridge = require("../lib/rainskills/bin/rainskills-tools.js");
  module.exports = bridge;
  if (require.main === module) bridge.main();
} catch (_error) {
  if (require.main !== module) throw _error;
  process.stderr.write(JSON.stringify({error:"installed Rainskills CLI runtime is incomplete",code:"E_RUNTIME_INCOMPLETE",stage:"local",next_action:"repair_runtime"}) + "\\n");
  process.exitCode = 3;
}
`;
    plan.push({ destination: path.join(binDirectory, "rainskills-tools.js"), tree: fileTree(bridgeShim, 0o700) });
    for (const [name, mode] of [["delivery-probe.js", 0o600]]) {
      const tree = new Map();
      addSource(tree, path.join(source, "bin", name), "", "file", mode);
      plan.push({ destination: path.join(binDirectory, name), tree });
    }
    plan.push({ destination: path.join(binDirectory, "rainskills-skill-manifest.json"), tree: fileTree(`${JSON.stringify(manifest, null, 2)}\n`, 0o600) });
    plan.push(...migrateCodex(targetHome), ...migrateClaude(targetHome));
    const changes = plan.filter((entry) => {
      assertDestinationParents(targetHome, entry.destination);
      entry.original = readTree(entry.destination);
      return !treesEqual(entry.tree, entry.original);
    });
    for (const directory of [rainbondHome, libDirectory, binDirectory]) ensurePrivateDirectory(directory);
    if (changes.length === 0) return { binDirectory, status: "unchanged", cleanupPending };

    phase = "stage";
    staging = fs.mkdtempSync(path.join(rainbondHome, `.cli-install.${process.pid}.`));
    fs.chmodSync(staging, 0o700);
    fs.mkdirSync(path.join(staging, "new"), { mode: 0o700 });
    fs.mkdirSync(path.join(staging, "backup"), { mode: 0o700 });
    for (const [index, entry] of changes.entries()) {
      const staged = path.join(staging, "new", String(index));
      const backup = path.join(staging, "backup", String(index));
      writeTree(staged, entry.tree);
      if (!treesEqual(entry.tree, readTree(staged))) throw new Error(`staged content mismatch: ${entry.destination}`);
      transactions.push({ ...entry, staged, backup, backedUp: false, published: false });
    }
    fs.writeFileSync(path.join(staging, "transaction.json"), `${JSON.stringify({
      schema: "rainskills.cli-install-recovery.v1",
      entries: transactions.map(({ destination, staged, backup, original }) => ({
        destination, staged, backup, hadOriginal: original !== null,
      })),
    }, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    phase = "replace";
    for (const entry of transactions) {
      assertDestinationParents(targetHome, entry.destination);
      if (!treesEqual(entry.original, readTree(entry.destination))) {
        throw new Error(`CLI destination changed during preparation: ${entry.destination}`);
      }
      if (lstatIfPresent(entry.destination)) {
        fs.renameSync(entry.destination, entry.backup);
        entry.backedUp = true;
      }
      fs.renameSync(entry.staged, entry.destination);
      entry.published = true;
    }
    phase = "verify";
    for (const entry of plan) {
      if (!treesEqual(entry.tree, readTree(entry.destination))) throw new Error(`installed content mismatch: ${entry.destination}`);
    }
  } catch (error) {
    const rollbackErrors = [];
    for (const entry of [...transactions].reverse()) {
      try {
        if (entry.published) fs.renameSync(entry.destination, entry.staged);
        if (entry.backedUp) fs.renameSync(entry.backup, entry.destination);
      } catch (rollbackError) {
        rollbackErrors.push(`${entry.destination}: ${rollbackError.message}`);
      }
    }
    retainBackups = rollbackErrors.length > 0;
    const recovery = retainBackups ? `; rollback incomplete; backups retained at ${staging}: ${rollbackErrors.join("; ")}` : "";
    const failure = new Error(`[rainskills-cli][${phase}] ${error.message}${recovery}`, { cause: error });
    failure.code = error.code || "RAINSKILLS_CLI_INSTALL_FAILED";
    failure.phase = phase;
    throw failure;
  } finally {
    if (staging && !retainBackups) {
      try { fs.rmSync(staging, { recursive: true, force: true }); } catch (error) {
        cleanupPending.push(staging);
        warning(`[rainskills-cli][cleanup] 临时文件待清理，已保留 ${staging}: ${error.message}`);
      }
    }
  }
  return { binDirectory, status: "installed", cleanupPending };
}

if (path.resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) {
  try {
    installLocalCli(parseArgs(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
