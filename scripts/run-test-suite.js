#!/usr/bin/env node

"use strict";

const { spawnSync } = require("node:child_process");

const TEST_SCRIPTS = Object.freeze([
  "test:test-runner",
  "test:published-verifier",
  "test:runtime-version",
  "test:runtime-contracts",
  "test:runtime-contract-generation",
  "test:shared-contract-generation",
  "test:tool-references",
  "test:skill-performance-repository",
  "test:codex-host-evals",
  "test:effect-evals",
  "test:skill-description-budget",
  "test:skill-entrypoint-budget",
  "test:project-init-contract",
  "test:bootstrap-contract",
  "test:troubleshooter-contract",
  "test:env-sync-contract",
  "test:handoff-context",
  "test:read-snapshot",
  "test:protected-poll",
  "test:delivery-probe",
  "test:auto-update",
  "test:launcher",
  "test:api-bridge",
  "test:console-contract",
  "test:ai-engine",
  "test:skill-profile",
  "test:marketplace",
  "test:dsh-bundle",
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
