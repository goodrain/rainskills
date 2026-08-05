const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const repoRoot = path.resolve(__dirname, "..");
const launcherPath = path.join(repoRoot, "bin", "rainskills.js");
const platformInstallerPath = path.join(
  repoRoot,
  "rainbond-platform-installer",
  "scripts",
  "platform-installer.js"
);
const secureStatePath = path.join(
  repoRoot,
  "rainbond-platform-installer",
  "scripts",
  "secure-state.js"
);

function readNormalizedSource(filePath) {
  return fs.readFileSync(filePath, "utf8").replace(/\r\n?/g, "\n");
}

function createRecoveryPackageFixture(version) {
  const packageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rainskills-recovery-package-"));
  fs.mkdirSync(path.join(packageRoot, "bin"), { recursive: true });
  fs.mkdirSync(path.join(packageRoot, "rainbond-demo"), { recursive: true });
  fs.writeFileSync(path.join(packageRoot, "package.json"), `${JSON.stringify({ version })}\n`);
  fs.writeFileSync(path.join(packageRoot, "install.sh"), "#!/bin/sh\n");
  fs.writeFileSync(path.join(packageRoot, "bin", "rainskills.js"), "#!/usr/bin/env node\n");
  fs.writeFileSync(path.join(packageRoot, "rainbond-demo", "SKILL.md"), "---\nname: demo\ndescription: demo\n---\n");
  return packageRoot;
}

function writeLegacyRecoveryBundle(bundleRoot) {
  const relative = "bin/rainskills.js";
  const content = "#!/usr/bin/env node\n// rc.40 legacy recovery\n";
  fs.mkdirSync(path.join(bundleRoot, "bin"), { recursive: true });
  fs.writeFileSync(path.join(bundleRoot, relative), content);
  const manifest = {
    schema: "rainskills.windows-recovery-bundle.v1",
    version: 1,
    files: [{
      path: relative,
      sha256: crypto.createHash("sha256").update(content).digest("hex"),
      size: Buffer.byteLength(content),
    }],
  };
  fs.writeFileSync(path.join(bundleRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

test("launcher routes platform and resume commands to the bundled helper", () => {
  const { resolveInvocation } = require(launcherPath);
  const fakeNode = path.join(repoRoot, "fake-node");

  assert.deepEqual(resolveInvocation(["platform", "install", "--onboarding-id", "abc"], {
    control: {
      mode: "windows-native",
      hostPlatform: "win32",
      controlPlatform: "win32",
    },
    execPath: fakeNode,
  }), {
    executable: fakeNode,
    args: [platformInstallerPath, "install", "--onboarding-id", "abc"],
  });
  assert.deepEqual(resolveInvocation(["resume", "--onboarding-id", "abc"], {
    control: {
      mode: "wsl",
      hostPlatform: "win32",
      controlPlatform: "linux",
      controlDistro: "Ubuntu",
    },
    execPath: fakeNode,
  }), {
    executable: fakeNode,
    args: [platformInstallerPath, "resume", "--onboarding-id", "abc"],
  });
});

test("platform resume selects native Node or POSIX Bash from onboarding control mode", () => {
  const {
    controlHostPlatform,
    resumeInvocationForOnboarding,
  } = require(platformInstallerPath);
  const windowsOnboardingPath = path.join(
    repoRoot,
    "rainbond-platform-installer",
    "scripts",
    "windows-onboarding.js"
  );
  const installScriptPath = path.join(repoRoot, "install.sh");
  const base = {
    target: "codex",
    console_url: "http://127.0.0.1:7070",
  };

  assert.deepEqual(resumeInvocationForOnboarding({
    ...base,
    control_mode: "windows-native",
  }, "/fake/node"), {
    executable: "/fake/node",
    args: [
      windowsOnboardingPath,
      "codex",
      "--self-hosted",
      "--rainbond-url",
      "http://127.0.0.1:7070",
      "--allow-insecure-http",
    ],
  });
  assert.deepEqual(resumeInvocationForOnboarding({
    ...base,
    control_mode: "posix",
  }, "/fake/node"), {
    executable: "bash",
    args: [
      installScriptPath,
      "codex",
      "--self-hosted",
      "--rainbond-url",
      "http://127.0.0.1:7070",
      "--allow-insecure-http",
    ],
  });
  assert.equal(controlHostPlatform({ control_mode: "wsl", control_distro: "Ubuntu" }, "linux"), "win32");
  assert.equal(controlHostPlatform({ control_mode: "posix" }, "linux"), "linux");
  assert.equal(controlHostPlatform({}, "darwin"), "darwin");

  assert.deepEqual(resumeInvocationForOnboarding({
    ...base,
    control_mode: "wsl",
    control_distro: "Ubuntu",
    console_url: "http://172.31.253.2:7070",
    display_console_url: "http://127.0.0.1:7070",
  }, "/fake/node"), {
    executable: "bash",
    args: [
      installScriptPath,
      "codex",
      "--self-hosted",
      "--rainbond-url",
      "http://172.31.253.2:7070",
      "--allow-insecure-http",
    ],
  });
});

test("Windows authorization lease starts a fixed Rainbond WSL process and can stop it", async () => {
  const { startWindowsRuntimeLease } = require(platformInstallerPath);
  const calls = [];
  const child = new EventEmitter();
  child.exitCode = null;
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    return true;
  };

  const leasePromise = startWindowsRuntimeLease({
    controlMode: "windows-native",
    systemRoot: "C:\\Windows",
    spawnFn(command, args, options) {
      calls.push({ command, args, options });
      queueMicrotask(() => child.emit("spawn"));
      return child;
    },
  });
  const lease = await leasePromise;

  assert.deepEqual(calls, [{
    command: "C:\\Windows\\System32\\wsl.exe",
    args: ["-d", "Rainbond", "-u", "root", "--exec", "/bin/sleep", "infinity"],
    options: { stdio: "ignore", windowsHide: true },
  }]);
  assert.equal(lease.hasExited(), false);
  lease.stop();
  assert.equal(child.killed, true);
});

test("Windows authorization waits only until the existing Console responds", async () => {
  const { waitForWindowsConsole } = require(platformInstallerPath);
  let attempts = 0;
  let sleeps = 0;

  await waitForWindowsConsole({
    consoleUrl: "http://127.0.0.1:7070",
    lease: { hasExited: () => false },
    probe: async () => {
      attempts += 1;
      return attempts === 3;
    },
    sleep: async () => { sleeps += 1; },
    now: () => 0,
    timeoutMs: 60_000,
  });

  assert.equal(attempts, 3);
  assert.equal(sleeps, 2);
});

test("combined Windows provisioning has no parent timeout", () => {
  const {
    runCommand,
    windowsHelperRunOptions,
  } = require(platformInstallerPath);
  assert.equal(typeof runCommand, "function");
  assert.equal(typeof windowsHelperRunOptions, "function");
  assert.deepEqual(windowsHelperRunOptions(["-Action", "ProvisionRainbond"]), { timeout: null });
  assert.deepEqual(windowsHelperRunOptions(["-Action", "Preflight"]), { timeout: 30 * 60 * 1000 });

  let spawnOptions = null;
  const execution = runCommand("powershell.exe", [], { timeout: null }, (command, args, options) => {
    spawnOptions = options;
    return { status: 0, stdout: "", stderr: "" };
  });
  assert.equal(execution.status, 0);
  assert.equal(Object.hasOwn(spawnOptions, "timeout"), false);
});

test("Windows machine bundle payload pins the current helper and bootstrap", () => {
  const { buildWindowsMachineBundlePayload } = require(platformInstallerPath);
  assert.equal(typeof buildWindowsMachineBundlePayload, "function");
  const packageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rainskills-current-package-"));
  const bundleRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rainskills-recovery-bundle-"));
  const scriptsRoot = path.join(packageRoot, "rainbond-platform-installer", "scripts");
  const recoveryEntry = path.join(bundleRoot, "bin", "rainskills.js");
  const recoveryManifest = path.join(bundleRoot, "manifest.json");
  fs.mkdirSync(scriptsRoot, { recursive: true });
  fs.mkdirSync(path.dirname(recoveryEntry), { recursive: true });
  fs.writeFileSync(path.join(scriptsRoot, "windows-platform.ps1"), "# current helper\n");
  fs.writeFileSync(path.join(scriptsRoot, "wsl-bootstrap.sh"), "#!/bin/bash\n# current bootstrap\n");
  fs.writeFileSync(recoveryEntry, "#!/usr/bin/env node\n");
  fs.writeFileSync(recoveryManifest, "{}\n");

  const payload = buildWindowsMachineBundlePayload({
    recovery: { packageRoot, bundleRoot },
    onboarding: { control_mode: "windows-native" },
    nodePath: "C:\\Program Files\\nodejs\\node.exe",
  });

  assert.equal(payload.helper_path, path.join(scriptsRoot, "windows-platform.ps1"));
  assert.equal(payload.bootstrap_path, path.join(scriptsRoot, "wsl-bootstrap.sh"));
  assert.equal(payload.helper_sha256, crypto.createHash("sha256").update("# current helper\n").digest("hex"));
  assert.equal(payload.bootstrap_sha256, crypto.createHash("sha256").update("#!/bin/bash\n# current bootstrap\n").digest("hex"));
  assert.equal(payload.recovery_manifest_sha256, crypto.createHash("sha256").update("{}\n").digest("hex"));
  assert.equal(payload.package_version, require(path.join(repoRoot, "package.json")).version);
  assert.equal(payload.recovery_entry, recoveryEntry);
  assert.equal(payload.node_path, "C:\\Program Files\\nodejs\\node.exe");
  assert.equal(payload.control_mode, "windows-native");
});

test("resumed Windows provisioning refreshes the protected machine bundle", () => {
  const source = readNormalizedSource(platformInstallerPath);
  const provision = source.match(/async function provisionWindowsDistroAndNetwork[\s\S]*?\n\}\n\nasync function installWindowsRainbond/)?.[0];
  assert(provision, "provisionWindowsDistroAndNetwork must remain a standalone operation");
  assert.match(provision, /windowsRecoveryBundle\(paths\)/);
  assert.match(provision, /buildWindowsMachineBundlePayload/);
  assert.match(provision, /adapter\.provisionRainbond\([\s\S]*\.\.\.machineBundlePayload/);
  assert.match(provision, /if \(!provisioned\.facts\.machineBundleVerified\)/);
  assert.match(provision, /machine_bundle_helper_sha256: machineBundlePayload\.helper_sha256/);
  assert.match(provision, /machine_bundle_bootstrap_sha256: machineBundlePayload\.bootstrap_sha256/);
  assert.match(provision, /machine_bundle_recovery_manifest_sha256: machineBundlePayload\.recovery_manifest_sha256/);
  assert.match(provision, /package_version: machineBundlePayload\.package_version/);
});

test("Windows recovery bundles are package-versioned and do not reuse a verified legacy bundle", () => {
  const { windowsRecoveryBundle } = require(platformInstallerPath);
  assert.equal(typeof windowsRecoveryBundle, "function");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rainskills-recovery-root-"));
  const packageVersion = "0.1.0-rc.41";
  const packageRoot = createRecoveryPackageFixture(packageVersion);
  const legacyRoot = path.join(root, "recovery-v1");
  const legacyManifest = writeLegacyRecoveryBundle(legacyRoot);

  const recovery = windowsRecoveryBundle({ root }, { packageRoot, packageVersion });

  assert.equal(recovery.bundleRoot, path.join(root, "recovery-v2", packageVersion));
  assert.notEqual(recovery.bundleRoot, legacyRoot);
  assert.equal(recovery.manifest.version, 2);
  assert.equal(recovery.manifest.package_version, packageVersion);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(legacyRoot, "manifest.json"), "utf8")), legacyManifest);

  const currentManifestPath = path.join(recovery.bundleRoot, "manifest.json");
  fs.writeFileSync(currentManifestPath, `${JSON.stringify({
    ...recovery.manifest,
    package_version: "0.1.0-rc.42",
  }, null, 2)}\n`);
  const rebuilt = windowsRecoveryBundle({ root }, { packageRoot, packageVersion });
  assert.equal(rebuilt.manifest.version, 2);
  assert.equal(rebuilt.manifest.package_version, packageVersion);
});

test("Windows recovery bundle rejects package versions that can escape the recovery root", () => {
  const { windowsRecoveryBundle } = require(platformInstallerPath);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rainskills-recovery-safe-root-"));
  const packageRoot = createRecoveryPackageFixture("0.1.0-rc.41");

  for (const packageVersion of ["", "../escape", "nested/version", "nested\\version", "bad\u0000version"]) {
    assert.throws(
      () => windowsRecoveryBundle({ root }, { packageRoot, packageVersion }),
      /package version|版本|安全/i
    );
  }
});

test("Windows recovery bundle retries after partial final and stale staging directories", () => {
  const { windowsRecoveryBundle } = require(platformInstallerPath);
  const { verifyRecoveryBundle } = require(path.join(
    repoRoot,
    "rainbond-platform-installer",
    "scripts",
    "windows-platform.js"
  ));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rainskills-recovery-retry-root-"));
  const packageVersion = "0.1.0-rc.41";
  const packageRoot = createRecoveryPackageFixture(packageVersion);
  const recoveryRoot = path.join(root, "recovery-v2");
  const bundleRoot = path.join(recoveryRoot, packageVersion);
  const stagingRoot = path.join(recoveryRoot, `.${packageVersion}.staging`);
  fs.mkdirSync(bundleRoot, { recursive: true });
  fs.writeFileSync(path.join(bundleRoot, "partial-copy"), "interrupted final\n");
  fs.mkdirSync(stagingRoot, { recursive: true });
  fs.writeFileSync(path.join(stagingRoot, "partial-copy"), "interrupted staging\n");

  const recovery = windowsRecoveryBundle({ root }, { packageRoot, packageVersion });

  assert.equal(recovery.bundleRoot, bundleRoot);
  assert.equal(verifyRecoveryBundle(bundleRoot).ok, true);
  assert.equal(fs.existsSync(path.join(bundleRoot, "partial-copy")), false);
  assert.equal(fs.existsSync(stagingRoot), false);
});

test("Windows recovery cleanup refuses a final-directory junction and leaves its target untouched", () => {
  const { windowsRecoveryBundle } = require(platformInstallerPath);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rainskills-recovery-junction-root-"));
  const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rainskills-recovery-outside-"));
  const packageVersion = "0.1.0-rc.41";
  const packageRoot = createRecoveryPackageFixture(packageVersion);
  const recoveryRoot = path.join(root, "recovery-v2");
  const bundleRoot = path.join(recoveryRoot, packageVersion);
  const outsideMarker = path.join(outsideRoot, "must-remain");
  fs.mkdirSync(recoveryRoot, { recursive: true });
  fs.writeFileSync(outsideMarker, "outside\n");
  fs.symlinkSync(outsideRoot, bundleRoot, "junction");

  assert.throws(
    () => windowsRecoveryBundle({ root }, { packageRoot, packageVersion }),
    /符号链接|reparse point/i
  );
  assert.equal(fs.readFileSync(outsideMarker, "utf8"), "outside\n");
});

test("Windows recovery cleanup also refuses a dangling final-directory junction", () => {
  const { windowsRecoveryBundle } = require(platformInstallerPath);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rainskills-recovery-dangling-root-"));
  const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rainskills-recovery-dangling-target-"));
  const packageVersion = "0.1.0-rc.41";
  const packageRoot = createRecoveryPackageFixture(packageVersion);
  const recoveryRoot = path.join(root, "recovery-v2");
  const bundleRoot = path.join(recoveryRoot, packageVersion);
  fs.mkdirSync(recoveryRoot, { recursive: true });
  fs.symlinkSync(outsideRoot, bundleRoot, "junction");
  fs.rmSync(outsideRoot, { recursive: true });

  assert.throws(
    () => windowsRecoveryBundle({ root }, { packageRoot, packageVersion }),
    /符号链接|reparse point/i
  );
});

test("Windows authorization convergence runs on every entry and persists current facts", async () => {
  const { ensureWindowsPlatformConverged } = require(platformInstallerPath);
  assert.equal(typeof ensureWindowsPlatformConverged, "function");

  const packageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rainskills-resume-package-"));
  const bundleRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rainskills-resume-recovery-"));
  const scriptsRoot = path.join(packageRoot, "rainbond-platform-installer", "scripts");
  const recoveryEntry = path.join(bundleRoot, "bin", "rainskills.js");
  fs.mkdirSync(scriptsRoot, { recursive: true });
  fs.mkdirSync(path.dirname(recoveryEntry), { recursive: true });
  fs.writeFileSync(path.join(scriptsRoot, "windows-platform.ps1"), "# upgraded helper\n");
  fs.writeFileSync(path.join(scriptsRoot, "wsl-bootstrap.sh"), "#!/bin/bash\n# upgraded bootstrap\n");
  fs.writeFileSync(recoveryEntry, "#!/usr/bin/env node\n");
  fs.writeFileSync(path.join(bundleRoot, "manifest.json"), "{}\n");

  const operationId = "1d6754d6-6fb3-4bda-9a04-15c2d261d178";
  const installationId = "f1805132-20ad-4a20-9f88-43fe41e50813";
  const calls = [];
  const writes = [];
  const containerStartedAt = "2026-08-05T02:03:04.000000000Z";
  const adapter = {
    async convergeInstalledPlatform(options) {
      calls.push(options);
      return {
        facts: {
          installationId,
          machineBundleVerified: true,
          networkManifestVerified: true,
          portproxyVerified: true,
          recoveryTasksVerified: true,
          containerRunning: true,
          nodeReady: true,
          componentsReady: true,
          wslConsoleReachable: true,
          windowsConsoleReachable: true,
          portsListening: [80, 443, 7070],
          subnet: "172.31.253.0/30",
          hostAddress: "172.31.253.1",
          guestAddress: "172.31.253.2",
          windowsConsoleUrl: "http://127.0.0.1:7070",
          controlConsoleUrl: "http://127.0.0.1:7070",
          stableProbeCount: 3,
          containerStartedAt,
          deviceFlowHttpReachable: true,
        },
      };
    },
  };
  const stateUpdater = (filePath, current, values) => {
    writes.push({ filePath, values });
    return { ...current, ...values };
  };
  const input = {
    adapter,
    onboarding: { control_mode: "windows-native" },
    operationId,
    paths: { state: "/protected/state.json" },
    recovery: { packageRoot, bundleRoot },
    write() {},
    state: {
      operation_id: operationId,
      installation_id: installationId,
      target_kind: "local-windows",
      stage: "platform-ready",
      windows_subnet: "172.31.253.0/30",
      managed_subnet: "172.31.252.0/30",
      host_address: "172.31.253.1",
      guest_address: "172.31.253.2",
    },
    stateUpdater,
  };

  const converged = await ensureWindowsPlatformConverged(input);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].operationId, operationId);
  assert.equal(calls[0].installationId, installationId);
  assert.equal(calls[0].payload.bootstrap_path, path.join(scriptsRoot, "wsl-bootstrap.sh"));
  assert.equal(calls[0].payload.subnet, "172.31.253.0/30");
  assert.equal(calls[0].payload.host_address, "172.31.253.1");
  assert.equal(calls[0].payload.guest_address, "172.31.253.2");
  assert.equal(writes.length, 1);
  assert.equal(writes[0].filePath, input.paths.state);
  assert.equal(writes[0].values.machine_bundle_helper_sha256, calls[0].payload.helper_sha256);
  assert.equal(writes[0].values.machine_bundle_bootstrap_sha256, calls[0].payload.bootstrap_sha256);
  assert.equal(writes[0].values.machine_bundle_recovery_manifest_sha256, calls[0].payload.recovery_manifest_sha256);
  assert.equal(writes[0].values.package_version, calls[0].payload.package_version);
  assert.equal(writes[0].values.stable_probe_count, 3);
  assert.equal(writes[0].values.container_started_at, containerStartedAt);
  assert.equal(writes[0].values.device_flow_http_reachable, true);
  assert.deepEqual(writes[0].values.windows_convergence_facts, calls.length && adapter ? {
    installationId,
    machineBundleVerified: true,
    networkManifestVerified: true,
    portproxyVerified: true,
    recoveryTasksVerified: true,
    containerRunning: true,
    nodeReady: true,
    componentsReady: true,
    wslConsoleReachable: true,
    windowsConsoleReachable: true,
    portsListening: [80, 443, 7070],
    subnet: "172.31.253.0/30",
    hostAddress: "172.31.253.1",
    guestAddress: "172.31.253.2",
    windowsConsoleUrl: "http://127.0.0.1:7070",
    controlConsoleUrl: "http://127.0.0.1:7070",
    stableProbeCount: 3,
    containerStartedAt,
    deviceFlowHttpReachable: true,
  } : null);

  await ensureWindowsPlatformConverged({
    ...input,
    state: converged.state,
  });
  assert.equal(calls.length, 2, "persisted convergence facts must never skip a later real convergence");
  assert.equal(writes.length, 2);
});

test("authorization resume keeps Windows WSL alive, waits for Console, then finalizes on success", async () => {
  const { runResume } = require(platformInstallerPath);
  assert.equal(typeof runResume, "function");
  const operationId = "1d6754d6-6fb3-4bda-9a04-15c2d261d178";
  const installationId = "f1805132-20ad-4a20-9f88-43fe41e50813";

  for (const stage of ["platform-ready", "authorizing"]) {
    const events = [];
    const adapter = {
      async finalize(options) {
        events.push({ type: "finalize", options });
        return { facts: { finalized: true } };
      },
    };
    await runResume(operationId, {
      onboardingPath: () => "/protected/onboarding.json",
      ensurePrivateDirectory() {},
      onboardingReader: () => ({
        operation_id: operationId,
        target: "codex",
        deployment_mode: "self-hosted",
        stage,
        console_url: "http://127.0.0.1:7070",
        platform_state_path: "/protected/state.json",
        control_mode: "windows-native",
      }),
      pathsResolver: () => ({ root: "/protected", state: "/protected/state.json" }),
      assertFilesSafe() {},
      platformStateReader: () => ({
        operation_id: operationId,
        installation_id: installationId,
        target_kind: "local-windows",
        stage: "platform-ready",
      }),
      windowsAdapterFactory: () => adapter,
      async windowsRuntimeLease() {
        events.push({ type: "keep-wsl-running" });
        return {
          stop() {
            events.push({ type: "stop-wsl-lease" });
          },
        };
      },
      async consoleReadiness({ consoleUrl }) {
        assert.equal(consoleUrl, "http://127.0.0.1:7070");
        events.push({ type: "console-ready" });
      },
      onboardingUpdater: (onboarding, values) => {
        events.push({ type: values.stage });
        return { ...onboarding, ...values };
      },
      invocationBuilder: () => ({ executable: "node", args: ["authorize.js"] }),
      attachedRunner: async () => {
        events.push({ type: "spawn" });
        return { code: 0, signal: null };
      },
      write() {},
    });

    assert.deepEqual(events.map((event) => event.type), [
      "keep-wsl-running",
      "console-ready",
      "authorizing",
      "spawn",
      "finalize",
      "configured",
      "stop-wsl-lease",
    ], `resume stage ${stage}`);
    assert.deepEqual(events[4].options, {
      operationId,
      installationId,
      payload: { status: "success" },
    });
  }
});

test("failed Windows authorization releases the WSL lease, preserves recovery tasks, and leaves non-Windows unchanged", async () => {
  const { runResume } = require(platformInstallerPath);
  const operationId = "1d6754d6-6fb3-4bda-9a04-15c2d261d178";
  const installationId = "f1805132-20ad-4a20-9f88-43fe41e50813";
  const base = {
    onboardingPath: () => "/protected/onboarding.json",
    ensurePrivateDirectory() {},
    onboardingReader: () => ({
      operation_id: operationId,
      target: "codex",
      deployment_mode: "self-hosted",
      stage: "platform-ready",
      console_url: "http://127.0.0.1:7070",
      platform_state_path: "/protected/state.json",
    }),
    pathsResolver: () => ({ root: "/protected", state: "/protected/state.json" }),
    assertFilesSafe() {},
    onboardingUpdater: (onboarding, values) => ({ ...onboarding, ...values }),
    invocationBuilder: () => ({ executable: "node", args: ["authorize.js"] }),
    write() {},
  };

  let finalized = false;
  let leaseStopped = false;
  await assert.rejects(runResume(operationId, {
    ...base,
    platformStateReader: () => ({
      operation_id: operationId,
      installation_id: installationId,
      target_kind: "local-windows",
      stage: "platform-ready",
    }),
    windowsAdapterFactory: () => ({
      async finalize() { finalized = true; },
    }),
    windowsRuntimeLease: async () => ({
      stop() { leaseStopped = true; },
    }),
    consoleReadiness: async () => {},
    attachedRunner: async () => ({ code: 23, signal: null }),
  }), /退出码为 23/);
  assert.equal(finalized, false, "authorization failure must preserve recovery tasks");
  assert.equal(leaseStopped, true, "authorization failure must release its temporary WSL lease");

  let adapterCreated = false;
  let leaseCreated = false;
  await runResume(operationId, {
    ...base,
    platformStateReader: () => ({
      operation_id: operationId,
      installation_id: installationId,
      target_kind: "local-linux",
      stage: "platform-ready",
    }),
    windowsAdapterFactory() {
      adapterCreated = true;
      throw new Error("Windows adapter must not be created");
    },
    windowsRuntimeLease: async () => {
      leaseCreated = true;
      throw new Error("Windows WSL lease must not start");
    },
    consoleReadiness: async () => assert.fail("Windows Console readiness must not run"),
    attachedRunner: async () => ({ code: 0, signal: null }),
  });
  assert.equal(adapterCreated, false);
  assert.equal(leaseCreated, false);
});

test("authorization resume waits only for Windows Console before authorizing and fresh completion has no second finalize", () => {
  const source = readNormalizedSource(platformInstallerPath);
  const resume = source.match(/async function runResume[\s\S]*?\n\}\n\nasync function completePlatform/)?.[0];
  assert(resume, "runResume must remain a standalone operation");
  const keepWslRunning = resume.indexOf("startWindowsRuntimeLease");
  const waitForConsole = resume.indexOf("waitForWindowsConsole");
  const authorize = resume.indexOf('stage: "authorizing"');
  const spawn = resume.indexOf("attachedRunner(");
  assert(keepWslRunning >= 0, "runResume must keep the installed Windows WSL running");
  assert(waitForConsole > keepWslRunning, "runResume must wait for the existing Console after starting WSL");
  assert(authorize > waitForConsole, "authorization must start as soon as the existing Console is reachable");
  assert(spawn > authorize, "the authorization client must start after the state transition");
  assert.doesNotMatch(resume, /ensureWindowsPlatformConverged|convergeInstalledPlatform/);
  const installWindows = source.match(/async function installWindowsRainbond[\s\S]*?\n\}\n\nfunction resumeInvocationForOnboarding/)?.[0];
  assert(installWindows, "installWindowsRainbond must remain a standalone operation");
  assert.doesNotMatch(installWindows, /adapter\.finalize/, "fresh success must finalize only inside runResume");
});

test("WSL control paths bridge to Windows without parsing shell text", () => {
  const {
    normalizeWindowsExecutableForControl,
    translateWslPathToWindows,
  } = require(platformInstallerPath);
  const calls = [];
  const translated = translateWslPathToWindows("/home/user/.rainbond/state.json", (command, args) => {
    calls.push({ command, args });
    return { status: 0, stdout: "C:\\Users\\user\\state.json\r\n", stderr: "" };
  });

  assert.equal(translated, "C:\\Users\\user\\state.json");
  assert.deepEqual(calls, [{ command: "wslpath", args: ["-w", "/home/user/.rainbond/state.json"] }]);
  assert.equal(normalizeWindowsExecutableForControl("C:\\Windows\\System32\\whoami.exe", "wsl"), "whoami.exe");
  assert.equal(normalizeWindowsExecutableForControl("powershell.exe", "wsl"), "powershell.exe");
  assert.equal(normalizeWindowsExecutableForControl("C:\\Windows\\System32\\whoami.exe", "windows-native"), "C:\\Windows\\System32\\whoami.exe");
});

test("platform CLI accepts an explicit Console host without accepting a URL", () => {
  const { parseArgs } = require(platformInstallerPath);
  const options = parseArgs([
    "install",
    "--onboarding-id", "1d6754d6-6fb3-4bda-9a04-15c2d261d178",
    "--console-host", "console.example.com",
  ]);

  assert.equal(options.consoleHost, "console.example.com");
  assert.throws(
    () => parseArgs(["install", "--console-host", "http://example.com:7070"]),
    /IP 或域名/
  );
});

test("onboarding state is schema checked and must be a protected regular file", {
  skip: process.platform === "win32",
}, () => {
  const { readOnboardingState } = require(platformInstallerPath);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rainskills-state-"));
  const { createSecureStateStore } = require(secureStatePath);
  const stateStore = createSecureStateStore({ platform: "linux", home: tempDir });
  const statePath = path.join(tempDir, "onboarding.json");
  const state = {
    schema: "rainskills.onboarding.v1",
    version: 1,
    operation_id: "1d6754d6-6fb3-4bda-9a04-15c2d261d178",
    package_version: "0.1.0-test",
    updated_at: "2026-08-02T00:00:00Z",
    stage: "awaiting-platform",
    target: "codex",
    deployment_mode: "self-hosted",
    platform_state_path: null,
    console_url: null,
  };

  fs.writeFileSync(statePath, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  assert.deepEqual(
    readOnboardingState(statePath, state.operation_id, stateStore),
    state
  );

  fs.chmodSync(statePath, 0o644);
  assert.throws(() => readOnboardingState(statePath, state.operation_id, stateStore), /0600/);
  fs.chmodSync(statePath, 0o600);
  assert.throws(() => readOnboardingState(statePath, "different-id", stateStore), /不匹配/);

  const symlinkPath = path.join(tempDir, "onboarding-link.json");
  fs.symlinkSync(statePath, symlinkPath);
  assert.throws(() => readOnboardingState(symlinkPath, state.operation_id, stateStore), /符号链接/);
});

test("preflight enforces the versioned single-node resource baseline", () => {
  const { evaluatePreflight } = require(platformInstallerPath);
  const passing = evaluatePreflight({
    platform: "linux",
    arch: "x64",
    cpuCores: 4,
    memoryBytes: 8 * 1024 ** 3,
    diskBytes: 50 * 1024 ** 3,
    occupiedPorts: [],
    hasPrivilege: true,
    hasDocker: false,
    hasRainbond: false,
    hasOrbStack: false,
    firewall: "inactive",
    swapEnabled: false,
  });
  assert.equal(passing.ok, true);
  assert.deepEqual(passing.blockers, []);
  assert.match(passing.effects.join("\n"), /Docker/);

  const failing = evaluatePreflight({
    platform: "linux",
    arch: "x64",
    cpuCores: 2,
    memoryBytes: 4 * 1024 ** 3,
    diskBytes: 20 * 1024 ** 3,
    occupiedPorts: [80, 7070],
    hasPrivilege: false,
    hasDocker: true,
    hasRainbond: false,
    hasOrbStack: false,
    firewall: "active",
    swapEnabled: true,
  });
  assert.equal(failing.ok, false);
  assert.match(failing.blockers.join("\n"), /4 核/);
  assert.match(failing.blockers.join("\n"), /8 GB/);
  assert.match(failing.blockers.join("\n"), /50 GB/);
  assert.match(failing.blockers.join("\n"), /80.*7070/);
  assert.match(failing.blockers.join("\n"), /root.*sudo -n/);
});

test("target choices follow the detected control machine", () => {
  const { targetChoicesForPlatform } = require(platformInstallerPath);

  assert.deepEqual(targetChoicesForPlatform("linux"), [
    { value: "local-linux", label: "安装到本地" },
    { value: "remote-linux", label: "安装到 Linux 服务器" },
  ]);
  assert.deepEqual(targetChoicesForPlatform("darwin"), [
    { value: "local-macos", label: "安装到本地" },
    { value: "remote-linux", label: "安装到 Linux 服务器" },
  ]);
  assert.deepEqual(targetChoicesForPlatform("win32"), [
    { value: "local-windows", label: "安装到本地" },
    { value: "remote-linux", label: "安装到 Linux 服务器" },
  ]);
  for (const platform of ["linux", "darwin", "win32"]) {
    assert.doesNotMatch(JSON.stringify(targetChoicesForPlatform(platform)), /推荐/);
  }
});

test("remote Linux targets accept SSH aliases but reject shell input", () => {
  const { normalizeRemoteTarget } = require(platformInstallerPath);

  assert.deepEqual(normalizeRemoteTarget("root@192.168.1.20", "22"), {
    host: "root@192.168.1.20",
    port: 22,
  });
  assert.deepEqual(normalizeRemoteTarget("rainbond-prod", 2202), {
    host: "rainbond-prod",
    port: 2202,
  });
  assert.throws(() => normalizeRemoteTarget("root@host; reboot", 22), /SSH 地址/);
  assert.throws(() => normalizeRemoteTarget("-oProxyCommand=bad", 22), /SSH 地址/);
  assert.throws(() => normalizeRemoteTarget("root@host", 70000), /SSH 端口/);
});

test("remote inspection uses non-interactive SSH and parses Linux facts", () => {
  const { inspectRemoteSystem } = require(platformInstallerPath);
  const calls = [];
  const result = inspectRemoteSystem(
    { host: "rainbond-prod", port: 2202 },
    (command, args, options) => {
      calls.push({ command, args, input: options.input });
      return {
        status: 0,
        stdout: [
          "PLATFORM=linux",
          "ARCH=x64",
          "CPU_CORES=8",
          `MEMORY_BYTES=${16 * 1024 ** 3}`,
          `DISK_BYTES=${96 * 1024 ** 3}`,
          "OCCUPIED_PORTS=",
          "HAS_PRIVILEGE=true",
          "HAS_DOCKER=false",
          "HAS_RAINBOND=false",
          "FIREWALL=inactive",
          "SWAP_ENABLED=false",
          "PRIMARY_IP=192.168.1.20",
          "NETWORK_REACHABLE=true",
          "",
        ].join("\n"),
        stderr: "",
      };
    }
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "ssh");
  assert.deepEqual(calls[0].args.slice(0, 8), [
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=10",
    "-p", "2202",
    "rainbond-prod", "bash",
  ]);
  assert.match(calls[0].input, /PLATFORM=/);
  assert.equal(result.platform, "linux");
  assert.equal(result.cpuCores, 8);
  assert.equal(result.memoryBytes, 16 * 1024 ** 3);
  assert.equal(result.diskBytes, 96 * 1024 ** 3);
  assert.equal(result.hasPrivilege, true);
  assert.equal(result.primaryIp, "192.168.1.20");
});

test("remote inspection script expands occupied ports and detects an existing Rainbond", () => {
  const { REMOTE_INSPECTION_SCRIPT } = require(platformInstallerPath);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rainskills-remote-inspection-"));
  const binDir = path.join(tempDir, "bin");
  fs.mkdirSync(binDir);
  const writeCommand = (name, body) => {
    const commandPath = path.join(binDir, name);
    fs.writeFileSync(commandPath, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  };

  writeCommand("lsof", "exit 0");
  writeCommand("docker", "exit 0");
  writeCommand("curl", "exit 0");
  writeCommand("systemctl", "exit 1");

  try {
    const result = spawnSync("bash", ["-s"], {
      input: REMOTE_INSPECTION_SCRIPT,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH}`,
      },
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^OCCUPIED_PORTS=80,443,7070$/m);
    assert.match(result.stdout, /^HAS_RAINBOND=true$/m);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("remote inspection rejects malformed occupied-port output instead of returning NaN", () => {
  const { inspectRemoteSystem } = require(platformInstallerPath);

  assert.throws(
    () => inspectRemoteSystem(
      { host: "rainbond-prod", port: 22 },
      () => ({
        status: 0,
        stdout: [
          "PLATFORM=linux",
          "ARCH=x64",
          "CPU_CORES=8",
          `MEMORY_BYTES=${16 * 1024 ** 3}`,
          `DISK_BYTES=${96 * 1024 ** 3}`,
          "OCCUPIED_PORTS=${occupied},${port}",
          "HAS_PRIVILEGE=true",
          "HAS_DOCKER=true",
          "HAS_RAINBOND=false",
          "FIREWALL=inactive",
          "SWAP_ENABLED=false",
          "PRIMARY_IP=192.168.1.20",
          "NETWORK_REACHABLE=true",
          "",
        ].join("\n"),
        stderr: "",
      })
    ),
    /远程端口检查结果无效/
  );
});

test("SSH session reuses existing non-interactive authentication", async () => {
  const { establishSshSession } = require(platformInstallerPath);
  const calls = [];
  const session = await establishSshSession(
    { host: "root@192.168.1.20", port: 22 },
    {
      interactive: true,
      runner: (command, args) => {
        calls.push({ command, args });
        return { status: 0, stdout: "", stderr: "" };
      },
      attachedRunner: async () => assert.fail("working key authentication must not prompt"),
      write: () => {},
    }
  );

  assert.equal(session.controlPath, null);
  assert.equal(session.multiplexed, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "ssh");
  assert(calls[0].args.includes("BatchMode=yes"));
});

test("SSH session falls back to one native interactive authentication and reuses it", async () => {
  const {
    closeSshSession,
    establishSshSession,
    inspectRemoteSystem,
  } = require(platformInstallerPath);
  const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "rainskills-ssh-test-"));
  const probeCalls = [];
  const attachedCalls = [];
  const output = [];
  const session = await establishSshSession(
    { host: "root@192.168.1.20", port: 22 },
    {
      interactive: true,
      runner: (command, args) => {
        probeCalls.push({ command, args });
        return {
          status: 255,
          stdout: "",
          stderr: "Permission denied (publickey,password).",
        };
      },
      attachedRunner: async (command, args, options) => {
        attachedCalls.push({ command, args, options });
        return { code: 0, signal: null };
      },
      createTempDirectory: () => tempDirectory,
      write: (value) => output.push(value),
    }
  );

  assert.equal(session.controlPath, path.join(tempDirectory, "control"));
  assert.equal(session.multiplexed, true);
  assert.equal(attachedCalls.length, 1);
  assert.equal(attachedCalls[0].command, "ssh");
  assert(attachedCalls[0].args.includes("ControlMaster=yes"));
  assert(attachedCalls[0].args.includes("ControlPersist=600"));
  assert(attachedCalls[0].args.includes("BatchMode=no"));
  assert.equal(attachedCalls[0].options.interactive, true);
  assert.match(output.join(""), /一次 SSH 密码/);
  assert.match(output.join(""), /不会保存/);

  const commandCalls = [];
  inspectRemoteSystem(
    { host: "root@192.168.1.20", port: 22 },
    (command, args) => {
      commandCalls.push({ command, args });
      return {
        status: 0,
        stdout: [
          "PLATFORM=linux",
          "ARCH=x64",
          "CPU_CORES=8",
          `MEMORY_BYTES=${16 * 1024 ** 3}`,
          `DISK_BYTES=${96 * 1024 ** 3}`,
          "HAS_PRIVILEGE=true",
          "HAS_DOCKER=false",
          "HAS_RAINBOND=false",
          "FIREWALL=inactive",
          "SWAP_ENABLED=false",
          "NETWORK_REACHABLE=true",
          "",
        ].join("\n"),
        stderr: "",
      };
    },
    session
  );
  assert(commandCalls[0].args.includes(`ControlPath=${session.controlPath}`));

  const closeCalls = [];
  closeSshSession(session, (command, args) => {
    closeCalls.push({ command, args });
    return { status: 0, stdout: "", stderr: "" };
  });
  assert.equal(closeCalls[0].command, "ssh");
  assert(closeCalls[0].args.includes("exit"));
  assert.equal(fs.existsSync(tempDirectory), false);
});

test("SSH authentication pauses cleanly when no interactive terminal is available", async () => {
  const { establishSshSession } = require(platformInstallerPath);
  const output = [];
  const session = await establishSshSession(
    { host: "root@192.168.1.20", port: 22 },
    {
      interactive: false,
      runner: () => ({
        status: 255,
        stdout: "",
        stderr: "Permission denied (publickey,password).",
      }),
      attachedRunner: async () => assert.fail("non-interactive execution must not request a password"),
      write: (value) => output.push(value),
    }
  );

  assert.equal(session, null);
  assert.match(output.join(""), /RAINSKILLS_USER_INPUT_REQUIRED:ssh_authentication/);
  assert.match(output.join(""), /交互终端/);
});

test("SSH session refuses a changed host key without opening authentication", async () => {
  const { establishSshSession } = require(platformInstallerPath);
  await assert.rejects(
    establishSshSession(
      { host: "root@192.168.1.20", port: 22 },
      {
        interactive: true,
        runner: () => ({
          status: 255,
          stdout: "",
          stderr: "WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!\nHost key verification failed.",
        }),
        attachedRunner: async () => assert.fail("changed host keys must fail closed"),
        write: () => {},
      }
    ),
    /主机密钥已发生变化/
  );
});

test("remote Console candidates prefer the effective SSH host over a private reported EIP", () => {
  const {
    buildRemoteConsoleCandidates,
    resolveSshHostname,
  } = require(platformInstallerPath);
  const calls = [];
  const effectiveSshHost = resolveSshHostname(
    { host: "root@rainbond-prod", port: 2202 },
    (command, args) => {
      calls.push({ command, args });
      return {
        status: 0,
        stdout: "host rainbond-prod\nhostname 14.103.55.132\nport 2202\nuser root\n",
        stderr: "",
      };
    }
  );

  assert.equal(effectiveSshHost, "14.103.55.132");
  assert.equal(calls[0].command, "ssh");
  assert(calls[0].args.includes("-G"));
  assert.deepEqual(
    buildRemoteConsoleCandidates({
      effectiveSshHost,
      sshTarget: "root@rainbond-prod",
      reportedEip: "172.16.0.65",
      primaryIp: "172.16.0.65",
    }),
    [
      "http://14.103.55.132:7070",
      "http://rainbond-prod:7070",
      "http://172.16.0.65:7070",
    ]
  );
});

test("new remote installations prefer an explicit or effective SSH host for EIP", () => {
  const { selectRemoteInstallationEip } = require(platformInstallerPath);

  assert.equal(selectRemoteInstallationEip({
    explicitHost: "console.example.com",
    effectiveSshHost: "14.103.55.132",
    primaryIp: "172.16.0.65",
  }), "console.example.com");
  assert.equal(selectRemoteInstallationEip({
    effectiveSshHost: "14.103.55.132",
    primaryIp: "172.16.0.65",
  }), "14.103.55.132");
  assert.equal(selectRemoteInstallationEip({
    primaryIp: "172.16.0.65",
  }), "172.16.0.65");
});

test("Console host input accepts only an IP or DNS name", () => {
  const { normalizeConsoleHost } = require(platformInstallerPath);

  assert.equal(normalizeConsoleHost("14.103.55.132"), "14.103.55.132");
  assert.equal(normalizeConsoleHost("rainbond.example.com"), "rainbond.example.com");
  assert.equal(normalizeConsoleHost("[2001:db8::10]"), "2001:db8::10");
  assert.throws(() => normalizeConsoleHost("http://14.103.55.132:7070"), /IP 或域名/);
  assert.throws(() => normalizeConsoleHost("user@example.com"), /IP 或域名/);
  assert.throws(() => normalizeConsoleHost("example.com/path"), /IP 或域名/);
  assert.throws(() => normalizeConsoleHost("example.com:8080"), /IP 或域名/);
  assert.throws(() => normalizeConsoleHost("host; reboot"), /IP 或域名/);
});

test("remote Console selection uses the first candidate reachable from the control machine", async () => {
  const { selectReachableConsole } = require(platformInstallerPath);
  const calls = [];
  const selection = await selectReachableConsole(
    ["http://14.103.55.132:7070", "http://172.16.0.65:7070"],
    async (url) => {
      calls.push(url);
      if (url.includes("14.103.55.132")) return 200;
      throw new Error("Console 健康检查超时");
    }
  );

  assert.equal(selection.consoleUrl, "http://14.103.55.132:7070");
  assert.deepEqual(calls, ["http://14.103.55.132:7070"]);
  assert.deepEqual(selection.attempts, [
    { url: "http://14.103.55.132:7070", ok: true, statusCode: 200 },
  ]);
});

test("remote Console selection asks for one validated host after automatic candidates fail", async () => {
  const { resolveRemoteConsole } = require(platformInstallerPath);
  const output = [];
  const asked = [];
  const result = await resolveRemoteConsole({
    candidates: ["http://172.16.0.65:7070"],
    interactive: true,
    ask: async (question) => {
      asked.push(question);
      return "console.example.com";
    },
    write: (value) => output.push(value),
    probe: async (url) => {
      if (url === "http://console.example.com:7070") return 302;
      throw new Error("Console 健康检查超时");
    },
  });

  assert.equal(result.consoleUrl, "http://console.example.com:7070");
  assert.equal(asked.length, 1);
  assert.match(output.join(""), /172\.16\.0\.65.*超时/s);
  assert.match(output.join(""), /已选择.*console\.example\.com/s);
});

test("remote Console selection pauses for an AI when every candidate fails without a TTY", async () => {
  const { resolveRemoteConsole } = require(platformInstallerPath);
  const output = [];
  const result = await resolveRemoteConsole({
    candidates: ["http://172.16.0.65:7070"],
    interactive: false,
    ask: async () => assert.fail("non-interactive selection must not prompt"),
    write: (value) => output.push(value),
    probe: async () => {
      throw new Error("Console 健康检查超时");
    },
  });

  assert.equal(result, null);
  assert.match(output.join(""), /RAINSKILLS_USER_INPUT_REQUIRED:console_address/);
  assert.match(output.join(""), /--console-host/);
});

test("interactive target selection defaults Linux to local but supports another server", async () => {
  const { selectInstallTarget } = require(platformInstallerPath);

  const localQuestions = [];
  const local = await selectInstallTarget({
    platform: "linux",
    options: {},
    interactive: true,
    ask: async (question) => {
      localQuestions.push(question);
      return "";
    },
    write: () => {},
  });
  assert.deepEqual(local, { kind: "local-linux", host: os.hostname(), sshPort: null });
  assert.equal(localQuestions.length, 1);

  const answers = ["2", "root@192.168.1.20", "2202"];
  const remote = await selectInstallTarget({
    platform: "linux",
    options: {},
    interactive: true,
    ask: async () => answers.shift(),
    write: () => {},
  });
  assert.deepEqual(remote, {
    kind: "remote-linux",
    host: "root@192.168.1.20",
    sshPort: 2202,
  });
});

test("macOS and Windows default to local while still offering a Linux server", async () => {
  const { selectInstallTarget } = require(platformInstallerPath);
  const macOutput = [];
  const macAnswers = [""];
  const mac = await selectInstallTarget({
    platform: "darwin",
    options: {},
    interactive: true,
    ask: async () => macAnswers.shift(),
    write: (value) => macOutput.push(value),
  });
  assert.equal(mac.kind, "local-macos");
  assert.match(macOutput.join(""), /安装到本地/);
  assert.match(macOutput.join(""), /安装到 Linux 服务器/);
  assert.doesNotMatch(macOutput.join(""), /推荐/);

  const windowsOutput = [];
  const windowsAnswers = [""];
  const windows = await selectInstallTarget({
    platform: "win32",
    options: {},
    interactive: true,
    ask: async () => windowsAnswers.shift(),
    write: (value) => windowsOutput.push(value),
  });
  assert.deepEqual(windows, {
    kind: "local-windows",
    host: os.hostname(),
    sshPort: null,
  });
  assert.match(windowsOutput.join(""), /安装到本地/);
  assert.match(windowsOutput.join(""), /安装到 Linux 服务器/);
  assert.doesNotMatch(windowsOutput.join(""), /推荐/);
});

test("non-interactive target selection pauses for the AI instead of choosing for the user", async () => {
  const { selectInstallTarget } = require(platformInstallerPath);
  const output = [];
  const selection = await selectInstallTarget({
    platform: "linux",
    options: {},
    interactive: false,
    ask: async () => assert.fail("non-interactive selection must not prompt"),
    write: (value) => output.push(value),
  });

  assert.equal(selection, null);
  assert.match(output.join(""), /RAINSKILLS_USER_INPUT_REQUIRED:platform_install_target/);
  assert.match(output.join(""), /--target local-linux/);
  assert.match(output.join(""), /--target remote-linux --ssh/);
});

test("CLI saves target selection before preflight when the AI has no TTY", {
  skip: process.platform === "win32",
}, () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "rainskills-target-cli-"));
  const stateDir = path.join(tempHome, ".rainbond");
  const operationId = "1d6754d6-6fb3-4bda-9a04-15c2d261d178";
  fs.mkdirSync(stateDir, { mode: 0o700 });
  fs.writeFileSync(
    path.join(stateDir, "rainskills-onboarding-v1.json"),
    `${JSON.stringify({
      schema: "rainskills.onboarding.v1",
      version: 1,
      operation_id: operationId,
      package_version: "0.1.0-test",
      updated_at: "2026-08-02T00:00:00Z",
      stage: "awaiting-platform",
      target: "codex",
      deployment_mode: "self-hosted",
      platform_state_path: null,
      console_url: null,
    })}\n`,
    { mode: 0o600 }
  );

  const result = spawnSync(
    process.execPath,
    [platformInstallerPath, "install", "--onboarding-id", operationId],
    {
      encoding: "utf8",
      env: { ...process.env, HOME: tempHome },
      timeout: 10000,
    }
  );

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /RAINSKILLS_USER_INPUT_REQUIRED:platform_install_target/);
  const platformState = JSON.parse(fs.readFileSync(
    path.join(stateDir, "platform-installer", operationId, "state.json"),
    "utf8"
  ));
  assert.equal(platformState.stage, "target-selection");
  assert.equal(platformState.status, "waiting_user");
  assert.equal(platformState.target_kind, null);
});

test("remote preparation creates a protected workspace and copies the verified artifact", () => {
  const { prepareRemoteInstaller } = require(platformInstallerPath);
  const calls = [];
  const operationId = "1d6754d6-6fb3-4bda-9a04-15c2d261d178";
  const installerPath = "/tmp/rainbond install.sh";
  const target = { host: "rainbond-prod", port: 2202 };
  const session = { controlPath: "/tmp/rainskills-ssh-test/control" };
  const runner = (command, args, options) => {
    calls.push({ command, args, input: options.input });
    return { status: 0, stdout: "", stderr: "" };
  };

  const workspace = prepareRemoteInstaller(target, operationId, installerPath, runner, session);

  assert.equal(workspace, `.rainbond/platform-installer/${operationId}`);
  assert.equal(calls[0].command, "ssh");
  assert.match(calls[0].input, /chmod 700/);
  assert.deepEqual(calls[0].args.slice(-4), ["bash", "-s", "--", operationId]);
  assert(calls[0].args.includes(`ControlPath=${session.controlPath}`));
  assert.equal(calls[1].command, "scp");
  assert(calls[1].args.includes(`ControlPath=${session.controlPath}`));
  assert(calls[1].args.includes(installerPath));
  assert.equal(
    calls[1].args.at(-1),
    `rainbond-prod:.rainbond/platform-installer/${operationId}/rainbond-install.sh`
  );
});

test("remote installer invocation verifies the transferred digest and Bash syntax", () => {
  const { remoteInstallerInvocation } = require(platformInstallerPath);
  const operationId = "1d6754d6-6fb3-4bda-9a04-15c2d261d178";
  const digest = "a".repeat(64);
  const session = { controlPath: "/tmp/rainskills-ssh-test/control" };
  const invocation = remoteInstallerInvocation(
    { host: "root@192.168.1.20", port: 22 },
    operationId,
    digest,
    "192.168.1.20",
    session
  );

  assert.equal(invocation.command, "ssh");
  assert.deepEqual(invocation.args.slice(-6), [
    "bash",
    "-s",
    "--",
    `.rainbond/platform-installer/${operationId}`,
    digest,
    "192.168.1.20",
  ]);
  assert.match(invocation.input, /sha256sum/);
  assert.match(invocation.input, /摘要不匹配/);
  assert.match(invocation.input, /bash -n "\$installer"/);
  assert.match(invocation.input, /trap .*INT TERM HUP/);
  assert.match(invocation.input, /setsid/);
  assert(invocation.args.includes(`ControlPath=${session.controlPath}`));
});

test("remote verification requires a running container, Ready node, and healthy components", () => {
  const { REMOTE_VERIFICATION_SCRIPT, verifyRemoteRainbond } = require(platformInstallerPath);
  const calls = [];
  const session = { controlPath: "/tmp/rainskills-ssh-test/control" };
  const verification = verifyRemoteRainbond(
    { host: "rainbond-prod", port: 22 },
    "192.168.1.20",
    (command, args, options) => {
      calls.push({ command, args, input: options.input });
      return {
        status: 0,
        stdout: [
          "CONTAINER_STATE=true",
          "NODE_READY=true",
          "COMPONENTS_READY=true",
          "EIP=192.168.1.20",
          "",
        ].join("\n"),
        stderr: "",
      };
    },
    session
  );

  assert.equal(calls[0].command, "ssh");
  assert.match(calls[0].input, /kubectl.*get nodes/);
  assert.match(calls[0].input, /kubectl.*get pods/);
  assert(calls[0].args.includes(`ControlPath=${session.controlPath}`));
  assert.deepEqual(verification, {
    containerState: "true",
    nodeReady: true,
    componentsReady: true,
    reportedEip: "192.168.1.20",
  });

  assert.throws(
    () => verifyRemoteRainbond(
      { host: "rainbond-prod", port: 22 },
      "192.168.1.20",
      () => ({
        status: 0,
        stdout: "CONTAINER_STATE=true\nNODE_READY=false\nCOMPONENTS_READY=true\n",
        stderr: "",
      })
    ),
    /K3s 节点/
  );
  assert.match(
    REMOTE_VERIFICATION_SCRIPT,
    /\[ -z "\$pods" \].*components_ready=false/s,
    "an empty rbd-system pod list must fail verification"
  );
});

test("remote deployment verification keeps runtime evidence but selects a reachable public Console", async () => {
  const { verifyRemoteDeployment } = require(platformInstallerPath);
  const probed = [];
  const verification = await verifyRemoteDeployment({
    target: { host: "root@14.103.55.132", port: 22 },
    fallbackHost: "172.16.0.65",
    effectiveSshHost: "14.103.55.132",
    interactive: false,
    runner: () => ({
      status: 0,
      stdout: [
        "CONTAINER_STATE=true",
        "NODE_READY=true",
        "COMPONENTS_READY=true",
        "EIP=172.16.0.65",
        "",
      ].join("\n"),
      stderr: "",
    }),
    probe: async (url) => {
      probed.push(url);
      if (url === "http://14.103.55.132:7070") return 200;
      throw new Error("Console 健康检查超时");
    },
    write: () => {},
  });

  assert.equal(verification.reportedEip, "172.16.0.65");
  assert.equal(verification.consoleUrl, "http://14.103.55.132:7070");
  assert.deepEqual(probed, ["http://14.103.55.132:7070"]);
  assert.equal(verification.consoleAttempts[0].ok, true);
});

test("verification extracts only an HTTP Console URL on port 7070", () => {
  const { extractConsoleUrl } = require(platformInstallerPath);
  assert.equal(
    extractConsoleUrl("Console: http://192.168.1.20:7070\n"),
    "http://192.168.1.20:7070"
  );
  assert.equal(
    extractConsoleUrl("Detected URL: https://rainbond.example.com:7070/path\n"),
    "https://rainbond.example.com:7070"
  );
  assert.equal(extractConsoleUrl("token=secret\nhttp://example.com:8080"), null);
});

test("skill routes platform setup but excludes application delivery", () => {
  const skill = fs.readFileSync(
    path.join(repoRoot, "rainbond-platform-installer", "SKILL.md"),
    "utf8"
  );
  assert.match(skill, /name: rainbond-platform-installer/);
  assert.match(skill, /internal Rainskills onboarding capability/i);
  assert.match(skill, /Do not use it to deploy an application/i);
  assert.match(skill, /rainbond-app-assistant/);
  assert.match(skill, /explicit confirmation/i);
  assert.match(skill, /Windows.*安装到本地.*安装到 Linux 服务器/is);
  assert.match(skill, /local-windows/);
  assert.match(skill, /UAC/);
  assert.doesNotMatch(skill, /推荐/);
  assert.match(skill, /SSH.*system.*ssh/is);
  assert.match(skill, /password.*will not save/is);
  assert.match(skill, /Never ask.*password.*in chat/is);
  assert.match(skill, /RAINSKILLS_USER_INPUT_REQUIRED:console_address/);
  assert.match(skill, /--console-host/);
  assert.match(skill, /IP or DNS name.*not.*URL/is);
});

test("official installer policy trusts only the fixed HTTPS origin and bounds mutable content", () => {
  const { POLICY } = require(platformInstallerPath);
  assert.equal(POLICY.minimums.cpu_cores, 4);
  assert.equal(POLICY.minimums.memory_bytes, 8 * 1024 ** 3);
  assert.equal(POLICY.minimums.disk_bytes, 50 * 1024 ** 3);
  assert.deepEqual(POLICY.required_ports, [80, 443, 7070]);
  assert.equal(POLICY.installer.url, "https://get.rainbond.com/");
  assert.deepEqual(POLICY.installer.allowed_origins, ["https://get.rainbond.com"]);
  assert.equal(POLICY.installer.trust, "https-origin+runtime-validation");
  assert.equal(POLICY.installer.max_bytes, 2 * 1024 * 1024);
  assert.deepEqual(POLICY.supported_control_platforms, ["linux", "darwin", "win32"]);
  assert.equal(Object.hasOwn(POLICY.installer, "sha256"), false);
});

test("mutable official installer content is validated and hashed at download time", {
  skip: process.platform === "win32",
}, () => {
  const { POLICY, validateInstaller } = require(platformInstallerPath);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rainskills-installer-validation-"));
  const installerPath = path.join(tempDir, "install.sh");
  const first = "#!/bin/bash\nset -eu\nprintf 'first release\\n'\n";
  const second = "#!/usr/bin/env bash\nset -eu\nprintf 'optimized release\\n'\n";

  fs.writeFileSync(installerPath, first, { mode: 0o600 });
  assert.equal(
    validateInstaller(installerPath),
    crypto.createHash("sha256").update(first).digest("hex")
  );

  fs.writeFileSync(installerPath, second, { mode: 0o600 });
  assert.equal(
    validateInstaller(installerPath),
    crypto.createHash("sha256").update(second).digest("hex")
  );

  fs.writeFileSync(installerPath, "<html>not a script</html>\n", { mode: 0o600 });
  assert.throws(() => validateInstaller(installerPath), /Bash 安装脚本/);

  fs.writeFileSync(installerPath, "#!/bin/bash\nif then\n", { mode: 0o600 });
  assert.throws(() => validateInstaller(installerPath), /语法检查失败/);

  fs.writeFileSync(installerPath, Buffer.alloc(POLICY.installer.max_bytes + 1, 0x61), { mode: 0o600 });
  assert.throws(() => validateInstaller(installerPath), /大小超出限制/);
});

test("published guidance describes local and remote target selection", () => {
  const readme = fs.readFileSync(path.join(repoRoot, "README.md"), "utf8");
  const policy = fs.readFileSync(
    path.join(repoRoot, "rainbond-platform-installer", "references", "installation-policy.md"),
    "utf8"
  );
  assert.match(readme, /Windows.*本地.*Linux 服务器/s);
  assert.match(readme, /Windows 10.*19041.*Windows 11/s);
  assert.match(readme, /UAC/);
  const troubleshooting = fs.readFileSync(
    path.join(repoRoot, "rainbond-platform-installer", "references", "troubleshooting.md"),
    "utf8"
  );
  for (const blocker of ["19041", "虚拟化", "NAT", "端口", "UAC", "计划任务", "摘要"]) {
    assert.match(troubleshooting, new RegExp(blocker));
  }
  assert.match(readme, /安装到本地.*安装到 Linux 服务器/s);
  assert.match(policy, /远程 Linux/);
  assert.doesNotMatch(policy, /不支持远程 SSH/);
});

test("no download or installer execution appears before the confirmation gate", () => {
  const source = readNormalizedSource(platformInstallerPath);
  const runInstall = source.slice(source.indexOf("async function runInstall"));
  const confirmation = runInstall.indexOf("await confirmInstall(options.yes)");
  const download = runInstall.indexOf("ensureTrustedInstaller(paths.installer");
  const execution = runInstall.indexOf("spawnAttached(command, args");
  assert(confirmation >= 0);
  assert(download > confirmation);
  assert(execution > confirmation);
});

test("Windows installation batches privileged work and explains the elevated progress window", () => {
  const source = readNormalizedSource(platformInstallerPath);
  assert.match(source, /adapter\.prepareWsl\(/);
  assert.match(source, /adapter\.provisionRainbond\(/);
  assert.match(source, /管理员窗口.*进度/s);
  assert.doesNotMatch(source, /adapter\.(?:enableWsl|registerResume|registerFinalize|importDistro|prepareRuntime|configureNetwork|verifyNetwork|prepareDocker|installRainbond|verifyDeployment)\(/);
});

test("platform progress never writes to an unreserved file descriptor", () => {
  const source = readNormalizedSource(platformInstallerPath);
  assert.match(source, /appendFileSync\(paths\.events/);
  assert.doesNotMatch(source, /writeSync\(3\s*,/);
});

test("Windows preflight reports progress before invoking the blocking helper", () => {
  const source = readNormalizedSource(platformInstallerPath);
  const runInstall = source.slice(source.indexOf("async function runInstall"));
  const progress = runInstall.indexOf("正在检查 Windows 环境");
  const preflight = runInstall.indexOf("windowsAdapter.preflight");
  assert(progress >= 0);
  assert(preflight > progress);
});

test("platform install holds the onboarding lock until the operation finishes", async () => {
  const { runInstall } = require(platformInstallerPath);
  assert.equal(typeof runInstall, "function");
  const events = [];
  const options = { onboardingId: "1d6754d6-6fb3-4bda-9a04-15c2d261d178" };
  const stateStore = {
    acquireOperationLock({ operationId }) {
      events.push(`acquire:${operationId}`);
      return {
        release() {
          events.push(`release:${operationId}`);
        },
      };
    },
  };

  await runInstall(options, {
    stateStore,
    installOperation: async () => {
      events.push("operation");
    },
  });

  assert.deepEqual(events, [
    `acquire:${options.onboardingId}`,
    "operation",
    `release:${options.onboardingId}`,
  ]);
});

test("atomic state writes reject a symlink directory", {
  skip: process.platform === "win32",
}, () => {
  const { atomicWriteJson } = require(platformInstallerPath);
  const { createSecureStateStore } = require(secureStatePath);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rainskills-symlink-"));
  const stateStore = createSecureStateStore({ platform: "linux", home: tempDir });
  const realDir = path.join(tempDir, "real");
  const linkDir = path.join(tempDir, "link");
  fs.mkdirSync(realDir);
  fs.symlinkSync(realDir, linkDir);
  assert.throws(
    () => atomicWriteJson(path.join(linkDir, "state.json"), { ok: true }, stateStore),
    /符号链接|状态目录不安全/
  );
});
