#!/usr/bin/env node

"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const PACKAGE_SELECTOR_PATTERN = /^(?:latest|next|[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?)$/;

function verifyPublishedPackage(selector, {
  env = process.env,
  platform = process.platform,
  spawnImpl = spawnSync,
  temporaryDirectory,
} = {}) {
  if (!PACKAGE_SELECTOR_PATTERN.test(String(selector || ""))) {
    throw new Error("发布验证需要合法的版本号、latest 或 next");
  }

  const ownsTemporaryDirectory = !temporaryDirectory;
  const root = path.resolve(temporaryDirectory || fs.mkdtempSync(path.join(os.tmpdir(), "rainskills-published-")));
  const home = path.join(root, "home");
  const command = platform === "win32" ? "npx.cmd" : "npx";
  const verificationEnvironment = {
    ...env,
    HOME: home,
    USERPROFILE: home,
    DSH_HOME: path.join(root, "dsh"),
    WORKBUDDY_CONFIG_DIR: path.join(root, "workbuddy"),
    HERMES_HOME: path.join(root, "hermes"),
    RAINSKILLS_TELEMETRY_DISABLED: "1",
    RAINSKILLS_PACKAGE_VERSION: "test",
  };

  try {
    const result = spawnImpl(command, [
      "--yes",
      `--package=rainskills@${selector}`,
      "rainskills",
      "all",
      "--force",
      "--no-telemetry",
    ], {
      cwd: root,
      env: verificationEnvironment,
      stdio: "inherit",
    });
    if (result.error) throw result.error;
    return Number.isInteger(result.status) ? result.status : 1;
  } finally {
    if (ownsTemporaryDirectory) fs.rmSync(root, { recursive: true, force: true });
  }
}

if (require.main === module) {
  try {
    process.exitCode = verifyPublishedPackage(process.argv[2]);
  } catch (error) {
    process.stderr.write(`错误：${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { verifyPublishedPackage };
