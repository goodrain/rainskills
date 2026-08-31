#!/usr/bin/env node
"use strict";

const { spawn } = require("node:child_process");
const os = require("node:os");

const autoUpdate = require("./auto-update.js");
const { version: installedVersion } = require("./installed-version.js");

const UPDATE_ENTRY = Object.freeze(["runtime", "status", "--json"]);
const DEFAULT_DELEGATE_TIMEOUT_MS = 30_000;
function backgroundUpdateEnvironment(source = process.env) {
  return autoUpdate.sanitizeAutoUpdateEnvironment(source);
}

function terminateChild(child, platform, signal = "SIGTERM") {
  try {
    if (platform !== "win32" && Number.isInteger(child.pid)) {
      process.kill(-child.pid, signal);
    } else {
      child.kill(signal);
    }
  } catch {
    try { child.kill(signal); } catch { /* already stopped */ }
  }
}

function runBoundedChild(invocation, environment, {
  platform = process.platform,
  timeoutMs = DEFAULT_DELEGATE_TIMEOUT_MS,
  spawnFn = spawn,
} = {}) {
  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    let forceTimer = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (forceTimer) clearTimeout(forceTimer);
      resolve(result);
    };
    let child;
    try {
      child = spawnFn(invocation.executable, invocation.args, {
        detached: platform !== "win32",
        env: environment,
        shell: false,
        stdio: "ignore",
        windowsHide: true,
      });
    } catch {
      resolve({ code: 1, signal: null });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      terminateChild(child, platform);
      forceTimer = setTimeout(() => {
        terminateChild(child, platform, "SIGKILL");
        finish({ code: 1, signal: "TIMEOUT" });
      }, 1000);
    }, timeoutMs);
    child.once("error", () => finish({ code: 1, signal: null }));
    child.once("close", (code, signal) => finish({
      code: timedOut ? 1 : (code ?? 1),
      signal: timedOut ? "TIMEOUT" : (signal || null),
    }));
  });
}

async function runBackgroundAutoUpdate({
  currentVersion = installedVersion,
  env = backgroundUpdateEnvironment(),
  home = os.homedir(),
  platform = process.platform,
  updateState = autoUpdate.createAutoUpdateState({ home, platform }),
  checkForUpdate = autoUpdate.checkForStableUpdate,
  acquireArtifact = autoUpdate.acquireStableUpdateArtifact,
  activeOperationDetector = () => autoUpdate.hasActiveOperation({ home, platform }),
  runDelegated = (invocation, environment) => runBoundedChild(
    invocation,
    environment,
    { platform }
  ),
} = {}) {
  let lease;
  let artifact;
  try {
    lease = updateState.acquireLease?.() || null;
  } catch {
    return { action: "continue", reason: "update-busy" };
  }
  try {
    const decision = await checkForUpdate({
      args: UPDATE_ENTRY,
      currentVersion,
      env,
      home,
      platform,
      activeOperationDetector,
      updateState,
    });
    if (decision.action !== "delegate") return decision;
    artifact = await acquireArtifact(decision, { home, platform });
    if (activeOperationDetector()) return { action: "continue", reason: "active-operation" };
    const invocation = autoUpdate.buildStableUpdateInvocation(
      decision,
      UPDATE_ENTRY,
      { platform, artifactPath: artifact.path }
    );
    const environment = autoUpdate.buildStableUpdateEnvironment(env, {
      fromVersion: currentVersion,
      targetVersion: decision.version,
      registry: decision.registry,
    });
    const result = await runDelegated(invocation, environment);
    if (result.code !== 0 || result.signal) {
      try { updateState.recordFailure?.(); } catch { /* best effort */ }
      return { action: "continue", reason: "delegated-update-failed" };
    }
    return { action: "continue", reason: "updated" };
  } catch {
    try { updateState.recordFailure?.(); } catch { /* best effort */ }
    return { action: "continue", reason: "update-failed" };
  } finally {
    try { artifact?.cleanup(); } catch { /* protected cleanup is best effort */ }
    lease?.release();
  }
}

async function main() {
  await runBackgroundAutoUpdate();
}

if (require.main === module) {
  main().catch(() => {
    process.exitCode = 0;
  });
}

module.exports = {
  backgroundUpdateEnvironment,
  main,
  runBackgroundAutoUpdate,
  runBoundedChild,
};
