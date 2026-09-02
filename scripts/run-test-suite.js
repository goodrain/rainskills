#!/usr/bin/env node

"use strict";

const { spawnSync } = require("node:child_process");

const TEST_SCRIPTS = Object.freeze([
  "test:test-runner",
  "test:runtime-version",
  "test:runtime-contracts",
  "test:auto-update",
  "test:launcher",
  "test:api-bridge",
  "test:console-contract",
  "test:skill-profile",
  "test:marketplace",
  "test:runtime-routing",
  "test:telemetry",
  "test:platform",
  "test:windows",
  "test:package-upload",
  "test:package",
  "test:installer",
  "test:signal",
  "test:npx-pty",
]);

function runTestSuite({
  env = process.env,
  platform = process.platform,
  spawnImpl = spawnSync,
} = {}) {
  const command = platform === "win32" ? "npm.cmd" : "npm";
  const testEnvironment = {
    ...env,
    RAINSKILLS_TELEMETRY_DISABLED: "1",
    RAINSKILLS_PACKAGE_VERSION: "test",
  };

  for (const script of TEST_SCRIPTS) {
    const result = spawnImpl(command, ["run", script], {
      env: testEnvironment,
      stdio: "inherit",
    });
    if (result.error) throw result.error;
    if (result.status !== 0) return Number.isInteger(result.status) ? result.status : 1;
  }
  return 0;
}

if (require.main === module) {
  process.exitCode = runTestSuite();
}

module.exports = {
  TEST_SCRIPTS,
  runTestSuite,
};
