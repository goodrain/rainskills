#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  let sourceRoot = scriptRoot;
  let check = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--check") {
      check = true;
      continue;
    }
    if (argument === "--source-root" && argv[index + 1]) {
      sourceRoot = path.resolve(argv[index + 1]);
      index += 1;
      continue;
    }
    throw new Error(
      "Usage: node scripts/sync-runtime-version.mjs [--source-root <path>] [--check]"
    );
  }
  return { sourceRoot, check };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function writeAtomically(filePath, content) {
  const temporaryPath = `${filePath}.tmp-${process.pid}`;
  const mode = fs.statSync(filePath).mode;
  fs.writeFileSync(temporaryPath, content, { encoding: "utf8", mode });
  fs.renameSync(temporaryPath, filePath);
}

function canonicalFiles(sourceRoot, manifest) {
  const files = new Set(["SKILL.md"]);
  for (const entry of manifest.files || []) {
    const normalized = String(entry).replace(/\\/g, "/");
    const match = normalized.match(/^(rainbond-[^/]+)\/$/);
    if (match) {
      const skillRoot = match[1];
      const runtimeGate = `${skillRoot}/references/runtime-gate.md`;
      files.add(
        fs.existsSync(path.join(sourceRoot, runtimeGate))
          ? runtimeGate
          : `${skillRoot}/SKILL.md`
      );
    }
  }
  const installedVersion =
    "rainbond-platform-installer/scripts/installed-version.js";
  if (fs.existsSync(path.join(sourceRoot, installedVersion))) {
    files.add(installedVersion);
  }
  return [...files].sort();
}

function expectedContent(relativePath, content, packageName, version) {
  if (relativePath.endsWith("installed-version.js")) {
    const matches = [...content.matchAll(/\bversion:\s*["']([^"']+)["']/g)];
    if (matches.length !== 1) {
      throw new Error(`${relativePath} must contain exactly one installed version`);
    }
    return content.replace(
      /\bversion:\s*(["'])[^"']+\1/,
      `version: "${version}"`
    );
  }

  const escapedName = escapeRegExp(packageName);
  const pinnedLauncher = new RegExp(
    `${escapedName}@(?!latest\\b)[0-9]+\\.[0-9]+\\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\\+[0-9A-Za-z.-]+)?`,
    "g"
  );
  const matches = content.match(pinnedLauncher) || [];
  if (matches.length === 0) {
    throw new Error(`${relativePath} must contain at least one pinned ${packageName} launcher`);
  }
  return content.replace(pinnedLauncher, `${packageName}@${version}`);
}

function run() {
  const { sourceRoot, check } = parseArgs(process.argv.slice(2));
  const manifestPath = path.join(sourceRoot, "package.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const packageName = manifest.name;
  const version = manifest.version;
  if (!packageName || !version) {
    throw new Error("package.json must define name and version");
  }

  const outputs = [];
  for (const relativePath of canonicalFiles(sourceRoot, manifest)) {
    const filePath = path.join(sourceRoot, relativePath);
    if (!fs.existsSync(filePath)) {
      throw new Error(`Missing release file: ${relativePath}`);
    }
    const current = fs.readFileSync(filePath, "utf8");
    const expected = expectedContent(relativePath, current, packageName, version);
    outputs.push({ relativePath, filePath, current, expected });
  }

  const stale = outputs.filter(({ current, expected }) => current !== expected);
  if (check) {
    if (stale.length > 0) {
      for (const { relativePath } of stale) {
        console.error(
          `Runtime version is not current for ${packageName}@${version}: ${relativePath}`
        );
      }
      process.exitCode = 1;
    }
    return;
  }

  for (const { filePath, current, expected } of stale) {
    if (current !== expected) {
      writeAtomically(filePath, expected);
    }
  }
}

try {
  run();
} catch (error) {
  console.error(`Runtime version synchronization failed: ${error.message}`);
  process.exitCode = 2;
}
