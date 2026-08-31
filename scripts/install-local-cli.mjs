#!/usr/bin/env node

import crypto from "node:crypto";
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
  "rainbond-app-assistant",
  "rainbond-app-version-assistant",
  "rainbond-delivery-verifier",
  "rainbond-env-sync",
  "rainbond-fullstack-bootstrap",
  "rainbond-fullstack-troubleshooter",
  "rainbond-opensource-app-deploy",
  "rainbond-platform-installer",
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

function copyTree(source, destination) {
  assertRegularPath(source, "directory");
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    const info = fs.lstatSync(from);
    if (info.isSymbolicLink()) throw new Error("runtime bundle cannot contain symbolic links");
    if (info.isDirectory()) copyTree(from, to);
    else if (info.isFile()) fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
    else throw new Error("runtime bundle contains an unsupported file type");
  }
}

function replaceDirectory(staged, destination) {
  const previous = `${destination}.previous.${process.pid}`;
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  if (fs.existsSync(destination)) fs.renameSync(destination, previous);
  try {
    fs.renameSync(staged, destination);
  } catch (error) {
    if (fs.existsSync(previous)) fs.renameSync(previous, destination);
    throw error;
  }
  if (fs.existsSync(previous)) fs.rmSync(previous, { recursive: true, force: true });
}

function installRuntimeBundle(source, stagedBundle) {
  fs.mkdirSync(stagedBundle, { mode: 0o700 });
  for (const directory of RUNTIME_BUNDLE_DIRECTORIES) {
    copyTree(path.join(source, directory), path.join(stagedBundle, directory));
  }
  for (const file of RUNTIME_BUNDLE_FILES) {
    atomicCopy(path.join(source, file), path.join(stagedBundle, file), file === "install.sh" ? 0o700 : 0o600);
  }
  const yamlPackage = requireFromInstaller.resolve("yaml/package.json", { paths: [source] });
  copyTree(path.dirname(yamlPackage), path.join(stagedBundle, "node_modules", "yaml"));
}

function atomicCopy(source, destination, mode) {
  assertRegularPath(source, "file");
  const parent = path.dirname(destination);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const temporary = path.join(parent, `.${path.basename(destination)}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`);
  try {
    fs.copyFileSync(source, temporary, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(temporary, mode);
    fs.renameSync(temporary, destination);
    fs.chmodSync(destination, mode);
  } catch (error) {
    try { fs.rmSync(temporary, { force: true }); } catch { /* keep original error */ }
    throw error;
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

function writeMigratedConfig(file, content) {
  const temporary = `${file}.rainskills.${process.pid}.${crypto.randomBytes(5).toString("hex")}.tmp`;
  const backup = `${file}.rainskills-backup`;
  fs.copyFileSync(file, backup);
  fs.chmodSync(backup, 0o600);
  try {
    fs.writeFileSync(temporary, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
    fs.renameSync(temporary, file);
    fs.chmodSync(file, 0o600);
  } catch (error) {
    try { fs.rmSync(temporary, { force: true }); } catch { /* keep original error */ }
    throw error;
  }
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
  if (!safeConfigFile(file)) return false;
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
  if (output === source) return false;
  writeMigratedConfig(file, output);
  return true;
}

function migrateClaude(home) {
  const file = path.join(home, ".claude.json");
  if (!safeConfigFile(file)) return false;
  const source = fs.readFileSync(file, "utf8");
  const payload = JSON.parse(source);
  if (!isLegacyRainskillsMcp(payload?.mcpServers?.rainbond)) return false;
  delete payload.mcpServers.rainbond;
  writeMigratedConfig(file, `${JSON.stringify(payload, null, 2)}\n`);
  return true;
}

export function installLocalCli({ source_root: sourceRoot, home }) {
  const source = path.resolve(sourceRoot);
  const targetHome = path.resolve(home);
  assertRegularPath(source, "directory");
  const rainbondHome = path.join(targetHome, ".rainbond");
  const binDirectory = path.join(rainbondHome, "bin");
  const libDirectory = path.join(rainbondHome, "lib");
  fs.mkdirSync(rainbondHome, { recursive: true, mode: 0o700 });
  fs.chmodSync(rainbondHome, 0o700);
  const staging = path.join(rainbondHome, `.cli-install.${process.pid}.${crypto.randomBytes(6).toString("hex")}`);
  fs.mkdirSync(staging, { mode: 0o700 });
  try {
    const stagedRuntime = path.join(staging, "rainbond-platform-installer", "scripts");
    copyTree(path.join(source, "rainbond-platform-installer", "scripts"), stagedRuntime);
    const stagedBundle = path.join(staging, "rainskills");
    installRuntimeBundle(source, stagedBundle);
    const runtimeTarget = path.join(libDirectory, "rainbond-platform-installer");
    fs.mkdirSync(libDirectory, { recursive: true, mode: 0o700 });
    replaceDirectory(path.join(staging, "rainbond-platform-installer"), runtimeTarget);
    replaceDirectory(stagedBundle, path.join(libDirectory, "rainskills"));

    const stagedManifest = path.join(staging, "rainskills-skill-manifest.json");
    buildSkillManifest({ source_root: source, output: stagedManifest });
    atomicCopy(path.join(source, "bin", "rainskills-tools.js"), path.join(binDirectory, "rainskills-tools.js"), 0o700);
    atomicCopy(stagedManifest, path.join(binDirectory, "rainskills-skill-manifest.json"), 0o600);
    migrateCodex(targetHome);
    migrateClaude(targetHome);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
  return { binDirectory };
}

if (path.resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) {
  try {
    installLocalCli(parseArgs(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
