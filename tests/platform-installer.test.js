const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const rootPackageVersion = require("../package.json").version;

const { createPortableSecureStateStore } = require("./helpers/portable-secure-state.js");

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
const platformRoutingPath = path.join(
  repoRoot,
  "rainbond-platform-installer",
  "scripts",
  "platform-routing.js"
);
const userMessagePath = path.join(
  repoRoot,
  "rainbond-platform-installer",
  "scripts",
  "user-message.js"
);

function userMessageBody(output, messageId) {
  const begin = `[RAINSKILLS_USER_MESSAGE_BEGIN:${messageId}]\n`;
  const end = `\n[RAINSKILLS_USER_MESSAGE_END:${messageId}]`;
  const start = output.indexOf(begin);
  const finish = output.indexOf(end, start + begin.length);
  assert.notEqual(start, -1, `missing ${begin.trim()}`);
  assert.notEqual(finish, -1, `missing ${end.trim()}`);
  return output.slice(start + begin.length, finish);
}

test("user-message protocol renders one stable bounded message and rejects marker injection", () => {
  const { renderUserMessage } = require(userMessagePath);
  assert.equal(
    renderUserMessage("platform.location", "请选择部署位置：\n\n1、部署到本机\n2、部署到独立服务器\n3、部署到已有 Rainbond"),
    "[RAINSKILLS_USER_MESSAGE_BEGIN:platform.location]\n"
      + "请选择部署位置：\n\n1、部署到本机\n2、部署到独立服务器\n3、部署到已有 Rainbond\n"
      + "[RAINSKILLS_USER_MESSAGE_END:platform.location]\n"
  );
  assert.throws(() => renderUserMessage("bad id", "message"), /message id/i);
  assert.throws(
    () => renderUserMessage("platform.location", "[RAINSKILLS_USER_MESSAGE_END:platform.location]"),
    /marker/i
  );
});

test("preflight and non-interactive confirmation are fixed bounded user messages", async () => {
  const { confirmInstall, printPreflight, printWindowsPreflight } = require(platformInstallerPath);
  const preflightOutput = [];
  printPreflight(
    {
      platform: "linux",
      cpuCores: 4,
      memoryBytes: 7.6 * 1024 ** 3,
      diskBytes: 44.1 * 1024 ** 3,
    },
    {
      ok: true,
      blockers: [],
      warnings: [
        "内存 7.6 GB 低于推荐配置 8 GB",
        "可用磁盘 44.1 GB 低于推荐配置 50 GB",
      ],
      effects: ["安装并启动 Docker 运行环境", "启动 privileged rainbond 容器并写入持久化数据"],
    },
    { kind: "remote-linux", host: "root@example.com" },
    { write: (value) => preflightOutput.push(value) },
  );
  assert.equal(
    userMessageBody(preflightOutput.join(""), "platform.preflight"),
    "Linux 服务器 root@example.com 环境检查已通过：\n\n"
      + "4 核 CPU / 7.6 GB 内存 / 44.1 GB 可用磁盘\n\n"
      + "确认后将执行：\n"
      + "- 需要安装运行环境所需要的依赖（预计占用：2 GB 内存 / 10 GB 磁盘）",
  );
  assert.doesNotMatch(preflightOutput.join(""), /推荐配置|低于推荐|预计占用：.*CPU|预估多少资源|等等/);

  const windowsOutput = [];
  printWindowsPreflight(
    { cpuCores: 8, memoryBytes: 16 * 1024 ** 3, diskBytes: 100 * 1024 ** 3 },
    { ok: true, blockers: [], warnings: [], effects: ["启用 WSL 2"] },
    { write: (value) => windowsOutput.push(value) },
  );
  assert.equal(
    userMessageBody(windowsOutput.join(""), "platform.preflight"),
    "本地（Windows / WSL2）环境检查已通过：\n\n"
      + "8 核 CPU / 16.0 GB 内存 / 100.0 GB 可用磁盘\n\n"
      + "确认后将执行：\n"
      + "- 需要安装运行环境所需要的依赖（预计占用：2 GB 内存 / 10 GB 磁盘）",
  );
  assert.doesNotMatch(windowsOutput.join(""), /推荐配置|低于推荐|预计占用：.*CPU|预估多少资源|等等/);

  const confirmationOutput = [];
  assert.equal(await confirmInstall(false, {
    interactive: false,
    write: (value) => confirmationOutput.push(value),
  }), false);
  assert.equal(
    userMessageBody(confirmationOutput.join(""), "platform.install-confirmation"),
    "是否开始安装 Rainbond？请回复 y 或 n。",
  );
});

test("platform branch handoffs and completion text are fixed by the helper", async () => {
  const {
    platformCompletionMessage,
    waitForExistingKubernetesConfiguration,
    waitForHostClusterConfiguration,
  } = require(platformInstallerPath);
  const hostOutput = [];
  assert.deepEqual(
    await waitForHostClusterConfiguration({ write: (value) => hostOutput.push(value) }),
    { waiting: true },
  );
  assert.equal(
    userMessageBody(hostOutput.join(""), "platform.host-cluster-configuration"),
    "多节点主机集群模式已选择。Rainskills 将生成受保护的 cluster.yaml 示例文件，编辑完成后会一次检查全部节点和集群拓扑。",
  );

  const kubernetesOutput = [];
  assert.deepEqual(
    await waitForExistingKubernetesConfiguration({ write: (value) => kubernetesOutput.push(value) }),
    { waiting: true },
  );
  assert.equal(
    userMessageBody(kubernetesOutput.join(""), "platform.existing-kubernetes-configuration"),
    "已有 Kubernetes 集群模式已选择。请继续提供目标 context 和安装参数。",
  );

  assert.equal(
    platformCompletionMessage({
      deploymentLocation: "root@example.com",
      consoleUrl: "http://example.com:7070",
    }),
    "Rainbond 运行环境部署成功\n\n"
      + "部署位置：root@example.com\n"
      + "运行状态：正常\n"
      + "Console 地址：http://example.com:7070\n\n"
      + "接下来将连接该平台并完成授权。",
  );
});

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
  const sshSetupPath = path.join(
    repoRoot,
    "rainbond-platform-installer",
    "scripts",
    "ssh-key-setup.js"
  );

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
  assert.deepEqual(resolveInvocation(["ssh", "prepare", "--ssh", "root@example.com", "--ssh-port", "22"], {
    control: {
      mode: "windows-native",
      hostPlatform: "win32",
      controlPlatform: "win32",
    },
    execPath: fakeNode,
  }), {
    executable: fakeNode,
    args: [sshSetupPath, "prepare", "--ssh", "root@example.com", "--ssh-port", "22"],
  });
  assert.deepEqual(resolveInvocation(["ssh", "prepare-cluster", "--cluster-config", "/protected/cluster.yaml"], {
    control: {
      mode: "windows-native",
      hostPlatform: "win32",
      controlPlatform: "win32",
    },
    execPath: fakeNode,
  }), {
    executable: fakeNode,
    args: [sshSetupPath, "prepare-cluster", "--cluster-config", "/protected/cluster.yaml"],
  });
});

test("host cluster parser canonicalizes an explicit cluster config path", () => {
  const { parseArgs } = require(platformInstallerPath);
  const parsed = parseArgs([
    "install",
    "--onboarding-id", "1d6754d6-6fb3-4bda-9a04-15c2d261d178",
    "--location", "server",
    "--mode", "host-cluster",
    "--cluster-config", "./fixtures/cluster.yaml",
  ]);
  assert.equal(parsed.clusterConfig, path.resolve("./fixtures/cluster.yaml"));
  assert.throws(() => parseArgs(["install", "--cluster-config", " bad\npath "]), /cluster-config|配置路径/i);
  assert.throws(() => parseArgs(["install", "--mode", "single-node", "--cluster-config", "./cluster.yaml"]), /cluster-config.*host-cluster|host-cluster.*cluster-config/i);
});

test("onboarding reads validate and canonicalize the stored intent", () => {
  const { readOnboardingState } = require(platformInstallerPath);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "rainskills-onboarding-intent-"));
  const stateStore = require("./helpers/portable-secure-state.js").createPortableSecureStateStore(home);
  const operationId = "1d6754d6-6fb3-4bda-9a04-15c2d261d178";
  const statePath = path.join(home, ".rainbond", "rainskills-onboarding-v1.json");
  stateStore.atomicWriteJson(statePath, {
    schema: "rainskills.onboarding.v1",
    version: 1,
    operation_id: operationId,
    stage: "awaiting-platform",
    target: "codex",
    deployment_mode: "self-hosted",
    control_mode: "posix",
    intent: { type: "query", operation: "summary", app_id: "app-1" },
  });

  assert.deepEqual(readOnboardingState(statePath, operationId, stateStore).intent, {
    type: "query",
    operation: "summary",
    app_id: "app-1",
  });

  const unsafe = JSON.parse(fs.readFileSync(statePath, "utf8"));
  unsafe.intent.access_token = "must-not-be-read";
  stateStore.atomicWriteJson(statePath, unsafe);
  assert.throws(() => readOnboardingState(statePath, operationId, stateStore), /credential|凭据/i);
});

test("platform dispatch rejects existing-app intent before driver side effects", async () => {
  const { runInstallOperation } = require(platformInstallerPath);
  const operationId = "1d6754d6-6fb3-4bda-9a04-15c2d261d178";
  const calls = [];
  const onboarding = {
    schema: "rainskills.onboarding.v1",
    version: 1,
    operation_id: operationId,
    stage: "awaiting-platform",
    target: "codex",
    deployment_mode: "self-hosted",
    control_mode: "posix",
    intent: { type: "query", operation: "summary", app_id: "app-1" },
  };

  await assert.rejects(() => runInstallOperation({ onboardingId: operationId }, {
    onboardingPathResolver: () => "/protected/onboarding.json",
    ensurePrivateDirectory: () => {},
    onboardingReader: () => onboarding,
    pathsResolver: () => { calls.push("paths"); throw new Error("must not resolve driver paths"); },
    targetSelector: async () => { calls.push("target"); throw new Error("must not select target"); },
  }), /existing|已有|现有/i);
  assert.deepEqual(calls, []);
});

test("platform resume uses the fixed runtime connect launcher on every control mode", () => {
  const {
    controlHostPlatform,
    resumeInvocationForOnboarding,
  } = require(platformInstallerPath);
  const launcherPath = path.join(repoRoot, "bin", "rainskills.js");
  const base = {
    target: "codex",
    console_url: "http://127.0.0.1:7070",
    operation_id: "1d6754d6-6fb3-4bda-9a04-15c2d261d178",
    intent: { type: "deploy", project_root: "/workspace/app", source_kind: "local" },
  };

  assert.deepEqual(resumeInvocationForOnboarding({
    ...base,
    control_mode: "windows-native",
  }, "/fake/node"), {
    executable: "/fake/node",
    args: [
      launcherPath, "runtime", "connect", "codex", "--rainbond-url",
      "http://127.0.0.1:7070", "--allow-insecure-http", "--onboarding-id",
      base.operation_id, "--intent-json", JSON.stringify(base.intent),
    ],
  });
  assert.deepEqual(resumeInvocationForOnboarding({
    ...base,
    control_mode: "posix",
  }, "/fake/node"), {
    executable: "/fake/node",
    args: [
      launcherPath, "runtime", "connect", "codex", "--rainbond-url",
      "http://127.0.0.1:7070", "--allow-insecure-http", "--onboarding-id",
      base.operation_id, "--intent-json", JSON.stringify(base.intent),
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
    executable: "/fake/node",
    args: [
      launcherPath, "runtime", "connect", "codex", "--rainbond-url",
      "http://172.31.253.2:7070", "--allow-insecure-http", "--onboarding-id",
      base.operation_id, "--intent-json", JSON.stringify(base.intent),
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
      credentialReader: () => ({
        token: "nextHeader.nextPayload.nextSignature",
        origin: "http://127.0.0.1:7070",
      }),
      attachedRunner: async (executable, args) => {
        events.push({ type: "spawn", executable, args });
        return { code: 0, signal: null };
      },
      write() {},
    });

    assert.deepEqual(events.map((event) => event.type), [
      "keep-wsl-running",
      "console-ready",
      "authorizing",
      "spawn",
      "spawn",
      "finalize",
      "configured",
      "stop-wsl-lease",
    ], `resume stage ${stage}`);
    assert.deepEqual(events[4], {
      type: "spawn",
      executable: process.execPath,
      args: [
        path.join(repoRoot, "bin", "rainskills.js"),
        "intent", "resume", "--onboarding-id", operationId,
      ],
    });
    assert.deepEqual(events[5].options, {
      operationId,
      installationId,
      payload: { status: "success" },
    });
  }
});

test("platform resume keeps recovery state when fixed intent continuation fails", async () => {
  const { runResume } = require(platformInstallerPath);
  const operationId = "1d6754d6-6fb3-4bda-9a04-15c2d261d178";
  const updates = [];
  const output = [];
  let runs = 0;
  let finalized = false;

  await assert.rejects(runResume(operationId, {
    onboardingPath: () => "/protected/onboarding.json",
    ensurePrivateDirectory() {},
    onboardingReader: () => ({
      operation_id: operationId,
      target: "codex",
      deployment_mode: "self-hosted",
      stage: "platform-ready",
      console_url: "http://127.0.0.1:7070",
      platform_state_path: "/protected/state.json",
      control_mode: "windows-native",
    }),
    pathsResolver: () => ({ root: "/protected", state: "/protected/state.json" }),
    assertFilesSafe() {},
    platformStateReader: () => ({
      operation_id: operationId,
      installation_id: "f1805132-20ad-4a20-9f88-43fe41e50813",
      target_kind: "local-windows",
      stage: "platform-ready",
    }),
    windowsAdapterFactory: () => ({
      async finalize() { finalized = true; },
    }),
    windowsRuntimeLease: async () => ({ stop() {} }),
    consoleReadiness: async () => {},
    onboardingUpdater(onboarding, values) {
      updates.push(values.stage);
      return { ...onboarding, ...values };
    },
    invocationBuilder: () => ({ executable: "node", args: ["connect.js"] }),
    credentialReader: () => ({
      token: "nextHeader.nextPayload.nextSignature",
      origin: "http://127.0.0.1:7070",
    }),
    attachedRunner: async () => ({ code: runs++ === 0 ? 0 : 31, signal: null }),
    write(value) { output.push(value); },
  }), /intent|恢复|退出码.*31/i);

  assert.deepEqual(updates, ["authorizing"]);
  assert.equal(finalized, false);
  assert.match(output.join(""), new RegExp(
    `npx rainskills@[^ ]+ resume --onboarding-id ${operationId}`
  ));
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
    credentialReader: () => ({
      token: "nextHeader.nextPayload.nextSignature",
      origin: "http://127.0.0.1:7070",
    }),
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

test("POSIX platform resume reloads the persisted credential before the intent child", async () => {
  const { runResume } = require(platformInstallerPath);
  const operationId = "1d6754d6-6fb3-4bda-9a04-15c2d261d178";
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "rainskills-resume-credential-posix-"));
  const origin = "http://10.0.0.8:7070";
  const oldJwt = "oldHeader.oldPayload.oldSignature";
  const nextJwt = "nextHeader.nextPayload.nextSignature";
  const expectedPath = path.join(home, "expected-credential.txt");
  fs.writeFileSync(expectedPath, nextJwt, { mode: 0o600 });
  const stages = [];

  await runResume(operationId, {
    onboardingPath: () => "/protected/onboarding.json",
    ensurePrivateDirectory() {},
    onboardingReader: () => ({
      operation_id: operationId,
      target: "codex",
      deployment_mode: "self-hosted",
      stage: "platform-ready",
      console_url: origin,
      control_mode: "posix",
    }),
    onboardingUpdater(onboarding, values) {
      stages.push(values.stage);
      return { ...onboarding, ...values };
    },
    environment: {
      HOME: home,
      PATH: process.env.PATH,
      RAINBOND_JWT: oldJwt,
      TEST_NEXT_JWT: nextJwt,
      TEST_EXPECTED_ORIGIN: origin,
    },
    credentialHome: home,
    invocationBuilder: () => ({ executable: process.execPath, args: ["-e", "process.exit(0)"] }),
    credentialReader: () => ({ token: nextJwt, origin }),
    intentInvocationBuilder: () => ({
      executable: process.execPath,
      args: ["-e", [
        "const fs = require('node:fs');",
        "process.exit(process.env.RAINBOND_JWT === fs.readFileSync(process.argv[1], 'utf8') ? 0 : 41);",
      ].join("\n"), expectedPath],
    }),
    write() {},
  });

  assert.deepEqual(stages, ["authorizing", "configured"]);
});

test("Windows platform resume reloads the user credential through a silent helper before intent", async () => {
  const { runResume } = require(platformInstallerPath);
  const { readWindowsRuntimeCredential } = require(path.join(
    repoRoot, "rainbond-platform-installer", "scripts", "runtime-credentials.js"
  ));
  const operationId = "1d6754d6-6fb3-4bda-9a04-15c2d261d178";
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "rainskills-resume-credential-windows-"));
  const origin = "https://rainbond.example.com";
  const nextJwt = "nextHeader.nextPayload.nextSignature";
  const stateStore = createPortableSecureStateStore(home);
  const expectedPath = path.join(home, "expected-credential.txt");
  fs.writeFileSync(expectedPath, nextJwt, { mode: 0o600 });

  await runResume(operationId, {
    onboardingPath: () => "/protected/onboarding.json",
    ensurePrivateDirectory() {},
    onboardingReader: () => ({
      operation_id: operationId,
      target: "codex",
      deployment_mode: "self-hosted",
      stage: "platform-ready",
      console_url: origin,
      control_mode: "windows-native",
    }),
    onboardingUpdater: (onboarding, values) => ({ ...onboarding, ...values }),
    environment: {
      PATH: process.env.PATH,
      RAINBOND_JWT: "oldHeader.oldPayload.oldSignature",
      TEST_NEXT_JWT: nextJwt,
    },
    invocationBuilder: () => ({ executable: process.execPath, args: ["-e", "process.exit(0)"] }),
    credentialReader({ expectedOrigin }) {
      return readWindowsRuntimeCredential({
        home,
        expectedOrigin,
        stateStore,
        spawnImpl(command, args, options) {
          return spawnSync(process.execPath, ["-e", [
            "const fs = require('node:fs');",
            "fs.writeFileSync(process.env.RAINSKILLS_CREDENTIAL_OUTPUT_PATH, JSON.stringify({",
            "token: fs.readFileSync(process.argv[1], 'utf8'), origin: process.argv[2]",
            "}));",
          ].join("\n"), expectedPath, origin], {
            env: { RAINSKILLS_CREDENTIAL_OUTPUT_PATH: options.env.RAINSKILLS_CREDENTIAL_OUTPUT_PATH },
            stdio: "ignore",
          });
        },
      });
    },
    intentInvocationBuilder: () => ({
      executable: process.execPath,
      args: ["-e", [
        "const fs = require('node:fs');",
        "process.exit(process.env.RAINBOND_JWT === fs.readFileSync(process.argv[1], 'utf8') ? 0 : 42);",
      ].join("\n"), expectedPath],
    }),
    write() {},
  });
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

test("platform CLI accepts fixed location and mode flags while preserving explicit single-node targets", () => {
  const { parseArgs } = require(platformInstallerPath);
  const routed = parseArgs([
    "install",
    "--onboarding-id", "1d6754d6-6fb3-4bda-9a04-15c2d261d178",
    "--location", "server",
    "--mode", "host-cluster",
  ]);
  assert.equal(routed.location, "server");
  assert.equal(routed.mode, "host-cluster");

  const legacy = parseArgs([
    "install",
    "--target", "remote-linux",
    "--ssh", "root@192.168.1.20",
  ]);
  assert.equal(legacy.target, "remote-linux");
  assert.equal(legacy.location, "");
  assert.equal(legacy.mode, "");
  assert.equal(legacy.sshPort, null);
  assert.throws(() => parseArgs(["install", "--location", "cluster"]), /--location/);
  assert.throws(() => parseArgs(["install", "--mode", "automatic"]), /--mode/);
});

test("resuming a saved single-node server route preserves its SSH port when no override is supplied", async () => {
  const { parseArgs, selectInstallTarget } = require(platformInstallerPath);
  const options = parseArgs([
    "install",
    "--location", "server",
    "--mode", "single-node",
  ]);
  const route = await selectInstallTarget({
    platform: "linux",
    options,
    savedTarget: {
      location: "server",
      mode: "single-node",
      kind: "remote-linux",
      host: "root@192.168.1.20",
      sshPort: 2202,
    },
    interactive: false,
    write: () => {},
  });
  assert.equal(route.sshPort, 2202);
});

test("platform CLI accepts a complete Rainbond image override", () => {
  const { normalizeRainbondImage, parseArgs } = require(platformInstallerPath);
  const image = "registry.cn-hangzhou.aliyuncs.com/goodrain/rainbond:v6.9.7-devs";
  assert.equal(parseArgs([
    "install",
    "--onboarding-id", "1d6754d6-6fb3-4bda-9a04-15c2d261d178",
    "--rainbond-image", image,
  ]).rainbondImage, image);
  assert.equal(normalizeRainbondImage(image), image);
  assert.throws(
    () => normalizeRainbondImage("registry.example/rainbond:tag;touch /tmp/pwned"),
    /镜像地址无效/
  );
});

test("trusted Rainbond installer can be explicitly materialized with a complete image", () => {
  const { prepareInstallerForRainbondImage } = require(platformInstallerPath);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rainskills-installer-image-"));
  const installerPath = path.join(tempDir, "rainbond-install.sh");
  fs.writeFileSync(installerPath, [
    "#!/bin/bash",
    "set -euo pipefail",
    "RBD_IMAGE=\"${IMGHUB_MIRROR}/rainbond:${RAINBOND_VERSION}-k3s\"",
    "echo \"$RBD_IMAGE\"",
    "",
  ].join("\n"), { mode: 0o600 });
  const image = "registry.cn-hangzhou.aliyuncs.com/goodrain/rainbond:v6.9.7-devs";
  const first = prepareInstallerForRainbondImage(installerPath, image);
  const content = fs.readFileSync(installerPath, "utf8");
  assert.equal(first.overridden, true);
  assert.match(content, new RegExp(`# RainSkills image override: ${image.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}`));
  assert.match(content, /RBD_IMAGE='registry\.cn-hangzhou\.aliyuncs\.com\/goodrain\/rainbond:v6\.9\.7-devs'/);
  const second = prepareInstallerForRainbondImage(installerPath, image);
  assert.deepEqual(second, { sha256: first.sha256, overridden: true });
});

test("official Rainbond installer is the default with an explicit bundled override", () => {
  const { bundledInstallerPath, useBundledInstaller, validateInstaller } = require(platformInstallerPath);
  const installerPath = bundledInstallerPath();
  const content = fs.readFileSync(installerPath, "utf8");
  assert.match(content, /RAINBOND_VERSION=\$\{VERSION:-'v6\.9\.7-devs'\}/);
  assert.equal(validateInstaller(installerPath, { skipSyntaxCheck: false }), crypto.createHash("sha256").update(content).digest("hex"));
  const previous = process.env.RAINSKILLS_USE_BUNDLED_RAINBOND_INSTALLER;
  delete process.env.RAINSKILLS_USE_BUNDLED_RAINBOND_INSTALLER;
  assert.equal(useBundledInstaller(), false);
  process.env.RAINSKILLS_USE_BUNDLED_RAINBOND_INSTALLER = "1";
  assert.equal(useBundledInstaller(), true);
  if (previous === undefined) delete process.env.RAINSKILLS_USE_BUNDLED_RAINBOND_INSTALLER;
  else process.env.RAINSKILLS_USE_BUNDLED_RAINBOND_INSTALLER = previous;
});

test("official installer mode replaces a cached bundled installer", async () => {
  const https = require("node:https");
  const { ensureTrustedInstaller } = require(platformInstallerPath);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rainskills-installer-source-"));
  const destination = path.join(tempDir, "rainbond-install.sh");
  const oldInstaller = fs.readFileSync(path.join(repoRoot, "rainbond-platform-installer", "assets", "install-rainbond.sh"));
  fs.writeFileSync(destination, oldInstaller, { mode: 0o600 });
  const officialInstaller = Buffer.from("#!/bin/bash\nset -eu\nprintf 'official\\n'\n");
  const originalGet = https.get;
  const previous = process.env.RAINSKILLS_USE_BUNDLED_RAINBOND_INSTALLER;
  delete process.env.RAINSKILLS_USE_BUNDLED_RAINBOND_INSTALLER;
  https.get = (url, options, callback) => {
    const request = new (require("node:events").EventEmitter)();
    request.setTimeout = () => {};
    const response = new (require("node:events").EventEmitter)();
    response.statusCode = 200;
    response.headers = { "content-length": String(officialInstaller.length) };
    queueMicrotask(() => {
      callback(response);
      response.emit("data", officialInstaller);
      response.emit("end");
    });
    return request;
  };
  try {
    const result = await ensureTrustedInstaller(
      destination,
      { installer: destination },
      { artifact_url: "bundled://rainbond-console/script/install-rainbond.sh" },
      { skipSyntaxCheck: false }
    );
    assert.equal(result.reused, false);
    assert.equal(fs.readFileSync(destination, "utf8"), officialInstaller.toString("utf8"));
    assert.equal(fs.readdirSync(tempDir).some((name) => name.startsWith("rainbond-install.sh.invalid-")), true);
  } finally {
    https.get = originalGet;
    if (previous === undefined) delete process.env.RAINSKILLS_USE_BUNDLED_RAINBOND_INSTALLER;
    else process.env.RAINSKILLS_USE_BUNDLED_RAINBOND_INSTALLER = previous;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
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

  fs.writeFileSync(statePath, `${JSON.stringify({ ...state, target: "openclaw" })}\n`, { mode: 0o600 });
  assert.throws(
    () => readOnboardingState(statePath, state.operation_id, stateStore),
    /安装目标无效/
  );
  fs.writeFileSync(statePath, `${JSON.stringify(state)}\n`, { mode: 0o600 });

  fs.chmodSync(statePath, 0o644);
  assert.throws(() => readOnboardingState(statePath, state.operation_id, stateStore), /0600/);
  fs.chmodSync(statePath, 0o600);
  assert.throws(() => readOnboardingState(statePath, "different-id", stateStore), /不匹配/);

  const symlinkPath = path.join(tempDir, "onboarding-link.json");
  fs.symlinkSync(statePath, symlinkPath);
  assert.throws(() => readOnboardingState(symlinkPath, state.operation_id, stateStore), /符号链接/);
});

test("platform state rejects tampered location and mode combinations", () => {
  const { readPlatformState } = require(platformInstallerPath);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rainskills-platform-route-state-"));
  const stateStore = createPortableSecureStateStore(tempDir);
  const operationId = "1d6754d6-6fb3-4bda-9a04-15c2d261d178";
  const statePath = path.join(tempDir, "state.json");
  const state = {
    schema: "rainskills.platform-state.v1",
    version: 1,
    operation_id: operationId,
    location: "local",
    mode: "host-cluster",
    target_kind: "local-linux",
  };
  stateStore.atomicWriteJson(statePath, state);
  assert.throws(
    () => readPlatformState(statePath, operationId, stateStore),
    /本地.*host-cluster|location.*mode|路由/i
  );

  stateStore.atomicWriteJson(statePath, { ...state, location: "internet", mode: "single-node" });
  assert.throws(
    () => readPlatformState(statePath, operationId, stateStore),
    /路由.*无效|状态.*无效/i
  );
});

test("persisted route tuples accept only the complete new-schema state machine", () => {
  const { validatePersistedRouteTuple } = require(platformRoutingPath);
  const valid = [
    { location: null, mode: null, target_kind: null },
    { location: "server", mode: null, target_kind: null },
    { location: "local", mode: "single-node", target_kind: "local-linux" },
    { location: "local", mode: "single-node", target_kind: "local-macos" },
    { location: "local", mode: "single-node", target_kind: "local-windows" },
    { location: "server", mode: "single-node", target_kind: "remote-linux", host: null },
    { location: "server", mode: "host-cluster", target_kind: "host-cluster" },
    { location: "server", mode: "existing-kubernetes", target_kind: "existing-kubernetes" },
  ];
  for (const state of valid) {
    assert.equal(validatePersistedRouteTuple(state), state);
  }
  const legacyValid = [
    {
      state: { target_kind: null, host: null, ssh_port: null },
      options: {},
    },
    {
      state: { target_kind: "local-linux", host: "linux-host", ssh_port: null },
      options: { controlPlatform: "linux" },
    },
    {
      state: { target_kind: "local-macos", host: "mac-host", ssh_port: null },
      options: { controlPlatform: "darwin" },
    },
    {
      state: { target_kind: "local-windows", host: "windows-host", ssh_port: null },
      options: { controlPlatform: "win32" },
    },
    {
      state: { target_kind: "remote-linux", host: "root@server", ssh_port: 2202 },
      options: { controlPlatform: "darwin" },
    },
  ];
  for (const { state, options } of legacyValid) {
    assert.equal(validatePersistedRouteTuple(state, options), state);
  }

  for (const { state, options } of [
    { state: { target_kind: "evil", host: null, ssh_port: null }, options: {} },
    { state: { target_kind: "host-cluster", host: null, ssh_port: null }, options: {} },
    { state: { target_kind: "existing-kubernetes", host: null, ssh_port: null }, options: {} },
    {
      state: { target_kind: "local-macos", host: "mac-host", ssh_port: null },
      options: { controlPlatform: "linux" },
    },
    {
      state: { target_kind: "local-linux", host: "root@local-host", ssh_port: null },
      options: { controlPlatform: "linux" },
    },
    {
      state: { target_kind: "local-linux", host: "linux-host", ssh_port: 22 },
      options: { controlPlatform: "linux" },
    },
    {
      state: { target_kind: "remote-linux", host: null, ssh_port: 22 },
      options: {},
    },
    {
      state: { target_kind: "remote-linux", host: "root@server", ssh_port: 0 },
      options: {},
    },
  ]) {
    assert.throws(() => validatePersistedRouteTuple(state, options), /旧版.*状态.*无效|路由.*无效/i);
  }

  for (const state of [
    { location: "server", mode: null, target_kind: "host-cluster" },
    { location: "local", mode: "single-node", target_kind: "local-evil" },
    { location: "server", mode: "single-node", target_kind: null },
    { location: null, mode: null, target_kind: "remote-linux" },
  ]) {
    assert.throws(() => validatePersistedRouteTuple(state), /路由.*无效|状态.*无效/i);
  }
  assert.throws(() => validatePersistedRouteTuple({
    location: "local",
    mode: "single-node",
    target_kind: "local-macos",
  }, { controlPlatform: "linux" }), /控制端|本地.*目标/i);
});

test("a saved server location without a mode remains unresolved on resume", () => {
  const { savedRouteFromState } = require(platformInstallerPath);
  assert.deepEqual(savedRouteFromState({
    location: "server",
    mode: null,
    target_kind: null,
    host: null,
    ssh_port: null,
  }), {
    location: "server",
    mode: null,
    kind: null,
    host: null,
    sshPort: null,
  });
});

test("preflight treats below-recommended resources as advisory", () => {
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
  assert.deepEqual(passing.warnings, []);
  assert.match(passing.effects.join("\n"), /Docker/);

  const advisory = evaluatePreflight({
    platform: "linux",
    arch: "x64",
    cpuCores: 2,
    memoryBytes: 4 * 1024 ** 3,
    diskBytes: 30 * 1024 ** 3,
    occupiedPorts: [],
    hasPrivilege: true,
    hasDocker: true,
    hasRainbond: false,
    hasOrbStack: false,
    firewall: "active",
    swapEnabled: true,
  });
  assert.equal(advisory.ok, true);
  assert.deepEqual(advisory.blockers, []);
  assert.match(advisory.warnings.join("\n"), /低于推荐配置/);

  const failing = evaluatePreflight({
    platform: "linux",
    arch: "x64",
    cpuCores: 1,
    memoryBytes: 3 * 1024 ** 3,
    diskBytes: 29 * 1024 ** 3,
    occupiedPorts: [80, 7070],
    hasPrivilege: false,
    hasDocker: true,
    hasRainbond: false,
    hasOrbStack: false,
    firewall: "active",
    swapEnabled: true,
  });
  assert.equal(failing.ok, false);
  assert.match(failing.blockers.join("\n"), /最低.*2 核/);
  assert.match(failing.blockers.join("\n"), /最低.*4 GB/);
  assert.match(failing.blockers.join("\n"), /最低.*30 GB/);
  assert.match(failing.blockers.join("\n"), /80.*7070/);
  assert.match(failing.blockers.join("\n"), /root.*sudo -n/);
});

test("target choices follow the detected control machine", () => {
  const { targetChoicesForPlatform } = require(platformInstallerPath);

  assert.deepEqual(targetChoicesForPlatform("linux"), [
    { value: "local-linux", label: "部署到本机" },
    { value: "remote-linux", label: "部署到独立服务器" },
  ]);
  assert.deepEqual(targetChoicesForPlatform("darwin"), [
    { value: "local-macos", label: "部署到本机" },
    { value: "remote-linux", label: "部署到独立服务器" },
  ]);
  assert.deepEqual(targetChoicesForPlatform("win32"), [
    { value: "local-windows", label: "部署到本机" },
    { value: "remote-linux", label: "部署到独立服务器" },
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
      platform: "linux",
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

test("SSH session always pauses for the fixed system-terminal key setup flow", async () => {
  const { establishSshSession } = require(platformInstallerPath);
  const attachedCalls = [];
  const output = [];
  const session = await establishSshSession(
    { host: "root@192.168.1.20", port: 22 },
    {
      platform: "linux",
      interactive: true,
      runner: () => ({
        status: 255,
        stdout: "",
        stderr: "Permission denied (publickey,password).",
      }),
      attachedRunner: async (command, args, options) => {
        attachedCalls.push({ command, args, options });
        return { code: 0, signal: null };
      },
      write: (value) => output.push(value),
    }
  );

  assert.equal(session, null);
  assert.equal(attachedCalls.length, 0, "agent task must never read the SSH password");
  const message = userMessageBody(output.join(""), "platform.ssh-authentication");
  assert.match(message, /系统终端/);
  assert.match(message, /只准备 SSH 连接，不会安装 Rainbond/);
  assert(message.includes(`npx --yes rainskills@${rootPackageVersion} ssh prepare --ssh root@192.168.1.20 --ssh-port 22`));
  assert.match(message, /完成后回到这里回复“已完成”/);
});

test("host-cluster SSH probing can defer per-node authentication messages", async () => {
  const { establishSshSession } = require(platformInstallerPath);
  const output = [];
  const session = await establishSshSession(
    { host: "root@192.168.1.20", port: 22 },
    {
      interactive: false,
      deferAuthenticationMessage: true,
      runner: () => ({ status: 255, stdout: "", stderr: "Permission denied (publickey,password)." }),
      write: (value) => output.push(value),
    }
  );
  assert.equal(session, null);
  assert.deepEqual(output, []);
});

test("Windows SSH authentication also uses the same fixed external preparation flow", async () => {
  const { establishSshSession } = require(platformInstallerPath);
  const attachedCalls = [];
  const output = [];
  const session = await establishSshSession(
    { host: "root@192.168.1.20", port: 22 },
    {
      platform: "win32",
      interactive: true,
      runner: () => ({
        status: 255,
        stdout: "",
        stderr: "Permission denied (publickey,password).",
      }),
      attachedRunner: async (command, args, options) => {
        attachedCalls.push({ command, args, options });
        return { code: 0, signal: null };
      },
      createTempDirectory: () => assert.fail("Windows must not create a ControlMaster socket"),
      write: (value) => output.push(value),
    }
  );

  assert.equal(session, null);
  assert.equal(attachedCalls.length, 0);
  assert(userMessageBody(output.join(""), "platform.ssh-authentication").includes(
    `npx --yes rainskills@${rootPackageVersion} ssh prepare --ssh root@192.168.1.20 --ssh-port 22`
  ));
});

test("interactive SSH commands inherit terminal input without piping scripts to stdin", () => {
  const { runCommand } = require(platformInstallerPath);
  let receivedOptions;
  const result = runCommand(
    "ssh",
    ["root@example.com", "true"],
    { interactive: true, input: "must-not-be-piped" },
    (command, args, options) => {
      receivedOptions = { command, args, options };
      return { status: 0, stdout: "", stderr: "" };
    }
  );

  assert.equal(result.status, 0);
  assert.deepEqual(receivedOptions.options.stdio, ["inherit", "pipe", "inherit"]);
  assert.equal(Object.hasOwn(receivedOptions.options, "input"), false);
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
  assert.equal(
    userMessageBody(output.join(""), "platform.ssh-authentication"),
    [
      "当前还不能通过 SSH 免密连接服务器。",
      "",
      "请打开你电脑上的系统终端，执行下面这一条命令：",
      "npx --yes rainskills@0.1.5 ssh prepare --ssh root@192.168.1.20 --ssh-port 22",
      "",
      "这一步只准备 SSH 连接，不会安装 Rainbond。服务器指纹确认和 SSH 密码只会由系统 ssh 读取。",
      "完成后回到这里回复“已完成”，我会在当前任务中继续安装，不会重新选择流程。",
    ].join("\n"),
  );
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
  assert.equal(
    userMessageBody(output.join(""), "platform.console-address"),
    "Rainbond 已启动，但自动发现运行环境地址不可访问：\n"
      + "- http://172.16.0.65:7070：Console 健康检查超时\n\n"
      + "请提供服务器公网 IP 或域名，并在原命令后添加 --console-host <IP或域名>。",
  );
});

test("location is the first explicit choice and local resolves directly without server modes", async () => {
  const { selectPlatformRoute } = require(platformRoutingPath);
  const output = [];
  const questions = [];
  const route = await selectPlatformRoute({
    platform: "linux",
    options: {},
    interactive: true,
    ask: async (question) => {
      questions.push(question);
      return "1";
    },
    hostname: () => "developer-machine",
    write: (value) => output.push(value),
  });

  assert.deepEqual(route, {
    waiting: false,
    location: "local",
    mode: "single-node",
    kind: "local-linux",
    host: "developer-machine",
    sshPort: null,
  });
  assert.equal(questions.length, 1);
  assert.match(output.join(""), /部署到本机/);
  assert.match(output.join(""), /部署到独立服务器/);
  assert.doesNotMatch(output.join(""), /多节点|Kubernetes|host-cluster|existing-kubernetes/i);
});

test("server location reveals a separate explicit server mode choice", async () => {
  const { selectPlatformRoute } = require(platformRoutingPath);
  const output = [];
  const answers = ["2", "2"];
  const route = await selectPlatformRoute({
    platform: "darwin",
    options: {},
    interactive: true,
    ask: async () => answers.shift(),
    write: (value) => output.push(value),
  });

  assert.deepEqual(route, {
    waiting: false,
    location: "server",
    mode: "host-cluster",
    kind: "host-cluster",
    host: null,
    sshPort: null,
  });
  assert.match(output.join(""), /单台服务器（Linux）/);
  assert.match(output.join(""), /三台及以上服务器（Linux）/);
  assert.match(output.join(""), /已有 Kubernetes 集群/);
});

test("non-interactive routing emits stable missing-input actions and never defaults", async () => {
  const { selectPlatformRoute } = require(platformRoutingPath);
  const locationOutput = [];
  const missingLocation = await selectPlatformRoute({
    platform: "linux",
    options: {},
    interactive: false,
    ask: async () => assert.fail("must not prompt without a TTY"),
    write: (value) => locationOutput.push(value),
  });
  assert.deepEqual(missingLocation, {
    waiting: true,
    missing: "location",
    location: null,
    mode: null,
    kind: null,
    host: null,
    sshPort: null,
  });
  assert.match(locationOutput.join(""), /RAINSKILLS_USER_INPUT_REQUIRED:platform_install_location/);
  assert.equal(
    userMessageBody(locationOutput.join(""), "platform.location"),
    "请选择部署位置：\n\n"
      + "1、部署到本机\n"
      + "2、部署到独立服务器\n"
      + "3、部署到已有 Rainbond"
  );
  assert.doesNotMatch(locationOutput.join(""), /--location/);
  assert.doesNotMatch(locationOutput.join(""), /host-cluster|existing-kubernetes|Kubernetes|多节点/i);

  const modeOutput = [];
  const missingMode = await selectPlatformRoute({
    platform: "linux",
    options: { location: "server" },
    interactive: false,
    ask: async () => assert.fail("must not prompt without a TTY"),
    write: (value) => modeOutput.push(value),
  });
  assert.equal(missingMode.waiting, true);
  assert.equal(missingMode.missing, "mode");
  assert.equal(missingMode.location, "server");
  assert.equal(missingMode.mode, null);
  assert.match(modeOutput.join(""), /RAINSKILLS_USER_INPUT_REQUIRED:platform_install_server_mode/);
  assert.equal(
    userMessageBody(modeOutput.join(""), "platform.server-mode"),
    "请选择服务器类型：\n"
      + "1、单台服务器（Linux）\n"
      + "2、三台及以上服务器（Linux）\n"
      + "3、已有 Kubernetes 集群"
  );
  assert.doesNotMatch(modeOutput.join(""), /--location|--mode/);
});

test("non-interactive SSH selection is a fixed bounded user message", async () => {
  const { selectPlatformRoute } = require(platformRoutingPath);
  const output = [];
  const result = await selectPlatformRoute({
    platform: "linux",
    options: { location: "server", mode: "single-node" },
    interactive: false,
    write: (value) => output.push(value),
  });
  assert.equal(result.missing, "ssh");
  assert.equal(
    userMessageBody(output.join(""), "platform.server-ssh"),
    "请提供单机服务器 SSH 地址后重新执行：--location server --mode single-node --ssh <user@host> [--ssh-port 22]"
  );
});

test("routing rejects invalid combinations and never infers a mode from node count", async () => {
  const { selectPlatformRoute, validateRoutingRequest } = require(platformRoutingPath);
  assert.throws(
    () => validateRoutingRequest({
      platform: "linux",
      options: { location: "local", mode: "host-cluster" },
    }),
    /本地安装只能使用单机模式/i
  );
  assert.throws(
    () => validateRoutingRequest({
      platform: "linux",
      options: { location: "local", mode: "existing-kubernetes" },
    }),
    /本地安装只能使用单机模式/i
  );
  assert.throws(
    () => validateRoutingRequest({
      platform: "linux",
      options: { target: "remote-linux", location: "local" },
    }),
    /冲突|conflict/i
  );
  assert.throws(
    () => validateRoutingRequest({
      platform: "darwin",
      options: { target: "local-linux" },
    }),
    /安装目标与当前控制端不匹配/i
  );
  assert.throws(
    () => validateRoutingRequest({
      platform: "linux",
      options: { target: "local-linux", ssh: "root@server" },
    }),
    /冲突|单机服务器/i
  );

  await assert.rejects(() => selectPlatformRoute({
    platform: "linux",
    options: { mode: "host-cluster" },
    interactive: true,
    ask: async () => "1",
    write: () => {},
  }), /本地安装只能使用单机模式/i);

  const output = [];
  const result = await selectPlatformRoute({
    platform: "linux",
    options: { location: "server", nodeCount: 3 },
    interactive: false,
    write: (value) => output.push(value),
  });
  assert.equal(result.missing, "mode");
  assert.equal(result.mode, null);
  assert.match(output.join(""), /platform_install_server_mode/);
});

test("interactive target selection explicitly chooses Linux local or another server", async () => {
  const { selectInstallTarget } = require(platformInstallerPath);

  const localQuestions = [];
  const local = await selectInstallTarget({
    platform: "linux",
    options: {},
    interactive: true,
    ask: async (question) => {
      localQuestions.push(question);
      return "1";
    },
    write: () => {},
  });
  assert.deepEqual(local, {
    waiting: false,
    location: "local",
    mode: "single-node",
    kind: "local-linux",
    host: os.hostname(),
    sshPort: null,
  });
  assert.equal(localQuestions.length, 1);

  const answers = ["2", "1", "root@192.168.1.20", "2202"];
  const remote = await selectInstallTarget({
    platform: "linux",
    options: {},
    interactive: true,
    ask: async () => answers.shift(),
    write: () => {},
  });
  assert.deepEqual(remote, {
    waiting: false,
    location: "server",
    mode: "single-node",
    kind: "remote-linux",
    host: "root@192.168.1.20",
    sshPort: 2202,
  });
});

test("macOS and Windows explicitly choose local while still offering a Linux server", async () => {
  const { selectInstallTarget } = require(platformInstallerPath);
  const macOutput = [];
  const macAnswers = ["1"];
  const mac = await selectInstallTarget({
    platform: "darwin",
    options: {},
    interactive: true,
    ask: async () => macAnswers.shift(),
    write: (value) => macOutput.push(value),
  });
  assert.equal(mac.kind, "local-macos");
  assert.match(macOutput.join(""), /部署到本机/);
  assert.match(macOutput.join(""), /部署到独立服务器/);
  assert.doesNotMatch(macOutput.join(""), /推荐/);

  const windowsOutput = [];
  const windowsAnswers = ["1"];
  const windows = await selectInstallTarget({
    platform: "win32",
    options: {},
    interactive: true,
    ask: async () => windowsAnswers.shift(),
    write: (value) => windowsOutput.push(value),
  });
  assert.deepEqual(windows, {
    waiting: false,
    location: "local",
    mode: "single-node",
    kind: "local-windows",
    host: os.hostname(),
    sshPort: null,
  });
  assert.match(windowsOutput.join(""), /部署到本机/);
  assert.match(windowsOutput.join(""), /部署到独立服务器/);
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

  assert.equal(selection.waiting, true);
  assert.equal(selection.missing, "location");
  assert.match(output.join(""), /RAINSKILLS_USER_INPUT_REQUIRED:platform_install_location/);
  assert.match(output.join(""), /1、部署到本机/);
  assert.match(output.join(""), /2、部署到独立服务器/);
  assert.match(output.join(""), /3、部署到已有 Rainbond/);
  assert.doesNotMatch(output.join(""), /--location/);
});

test("interactive target selection uses the same third option for an existing Rainbond", async () => {
  const { selectPlatformRoute } = require(platformRoutingPath);
  const output = [];
  const route = await selectPlatformRoute({
    platform: "darwin",
    options: {},
    interactive: true,
    ask: async () => "3",
    write: (value) => output.push(value),
  });

  assert.deepEqual(route, {
    waiting: true,
    missing: "existing-rainbond",
    location: null,
    mode: null,
    kind: null,
    host: null,
    sshPort: null,
  });
  assert.equal(
    userMessageBody(output.join(""), "platform.location"),
    "请选择部署位置：\n\n"
      + "1、部署到本机\n"
      + "2、部署到独立服务器\n"
      + "3、部署到已有 Rainbond"
  );
  assert.doesNotMatch(output.join(""), /请选择服务器类型/);
});

test("host cluster dispatch persists routing, calls only ROI, and completes verified platform", async () => {
  const { runInstallOperation } = require(platformInstallerPath);
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "rainskills-platform-routing-state-"));
  const operationId = "1d6754d6-6fb3-4bda-9a04-15c2d261d178";
  const root = path.join(tempHome, ".rainbond", "platform-installer", operationId);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const paths = {
    root,
    state: path.join(root, "state.json"),
    events: path.join(root, "events.jsonl"),
    log: path.join(root, "install.log"),
    installer: path.join(root, "rainbond-install.sh"),
  };
  const calls = [];
  const stateStore = createPortableSecureStateStore(tempHome);
  const writeState = (filePath, value) => stateStore.atomicWriteJson(filePath, value);
  const updateState = (filePath, state, values) => {
    const next = { ...state, ...values, updated_at: new Date().toISOString() };
    writeState(filePath, next);
    return next;
  };

  await runInstallOperation({
    onboardingId: operationId,
    location: "server",
    mode: "host-cluster",
  }, {
    onboardingPathResolver: () => path.join(tempHome, ".rainbond", "onboarding.json"),
    ensurePrivateDirectory: () => {},
    onboardingReader: () => ({
      schema: "rainskills.onboarding.v1",
      version: 1,
      operation_id: operationId,
      stage: "awaiting-platform",
      target: "codex",
      deployment_mode: "self-hosted",
      control_mode: "posix",
      intent: { type: "deploy", project_root: "/workspace/app", source_kind: "local" },
    }),
    pathsResolver: () => paths,
    stateWriter: writeState,
    stateUpdater: updateState,
    hostClusterInstaller: async ({ state }) => {
      calls.push("host-cluster");
      const durable = JSON.parse(fs.readFileSync(paths.state, "utf8"));
      assert.equal(durable.location, "server");
      assert.equal(durable.mode, "host-cluster");
      assert.equal(state.location, "server");
      assert.equal(state.mode, "host-cluster");
      return { verification: { consoleUrl: "http://10.0.0.1:7070", location: "host-cluster (2 nodes)" } };
    },
    existingKubernetesInstaller: async () => assert.fail("must not dispatch Kubernetes"),
    platformCompleter: async (onboarding, state, durablePaths, verification, noResume) => {
      calls.push("complete");
      assert.equal(onboarding.operation_id, operationId);
      assert.equal(state.mode, "host-cluster");
      assert.equal(durablePaths.state, paths.state);
      assert.equal(verification.consoleUrl, "http://10.0.0.1:7070");
      assert.equal(Boolean(noResume), false);
    },
  });

  assert.deepEqual(calls, ["host-cluster", "complete"]);
  const state = JSON.parse(fs.readFileSync(paths.state, "utf8"));
  assert.equal(state.stage, "mode-configuration");
  assert.equal(state.status, "running");
  assert.equal(state.target_kind, "host-cluster");
});

test("host cluster configuration waiting stage is mirrored by the platform state", async () => {
  const { runInstallOperation } = require(platformInstallerPath);
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "rainskills-host-config-waiting-"));
  const operationId = "1d6754d6-6fb3-4bda-9a04-15c2d261d178";
  const root = path.join(tempHome, ".rainbond", "platform-installer", operationId);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const paths = {
    root,
    state: path.join(root, "state.json"),
    events: path.join(root, "events.jsonl"),
    log: path.join(root, "install.log"),
    installer: path.join(root, "rainbond-install.sh"),
  };
  const stateStore = createPortableSecureStateStore(tempHome);
  const writeState = (filePath, value) => stateStore.atomicWriteJson(filePath, value);
  const updateState = (filePath, current, values) => {
    const next = { ...current, ...values };
    writeState(filePath, next);
    return next;
  };
  await runInstallOperation({ onboardingId: operationId, location: "server", mode: "host-cluster" }, {
    onboardingPathResolver: () => path.join(tempHome, "onboarding.json"),
    ensurePrivateDirectory: () => {},
    onboardingReader: () => ({
      operation_id: operationId,
      stage: "awaiting-platform",
      target: "codex",
      deployment_mode: "self-hosted",
      control_mode: "posix",
      intent: { type: "deploy", project_root: "/workspace/app", source_kind: "local" },
    }),
    pathsResolver: () => paths,
    stateWriter: writeState,
    stateUpdater: updateState,
    hostClusterInstaller: async () => ({
      waiting: true,
      waitingStage: "waiting-host-cluster-config",
      configPath: path.join(root, "host-cluster", "cluster.yaml"),
    }),
    existingKubernetesInstaller: async () => assert.fail("must not dispatch Kubernetes"),
  });
  const state = stateStore.readProtectedJson(paths.state);
  assert.equal(state.stage, "waiting-host-cluster-config");
  assert.equal(state.status, "waiting_user");
});

test("existing Kubernetes dispatch calls only Helm driver with shared abort and completes verified platform", async () => {
  delete require.cache[require.resolve(platformInstallerPath)];
  const { runInstallOperation } = require(platformInstallerPath);
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "rainskills-k8s-dispatch-"));
  const operationId = "1d6754d6-6fb3-4bda-9a04-15c2d261d178";
  const root = path.join(tempHome, ".rainbond", "platform-installer", operationId);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const paths = { root, state: path.join(root, "state.json"), events: path.join(root, "events.jsonl"), log: path.join(root, "install.log"), installer: path.join(root, "installer") };
  const stateStore = createPortableSecureStateStore(tempHome);
  const writeState = (filePath, value) => stateStore.atomicWriteJson(filePath, value);
  const updateState = (filePath, value, patch) => { const next = { ...value, ...patch }; writeState(filePath, next); return next; };
  const calls = [];
  await runInstallOperation({ onboardingId: operationId, location: "server", mode: "existing-kubernetes", kubeContext: "production" }, {
    onboardingPathResolver: () => path.join(tempHome, "onboarding.json"), ensurePrivateDirectory: () => {},
    onboardingReader: () => ({ schema: "rainskills.onboarding.v1", version: 1, operation_id: operationId, stage: "awaiting-platform", target: "codex", deployment_mode: "self-hosted", control_mode: "posix", intent: { type: "deploy", project_root: "/workspace/app", source_kind: "local" } }),
    pathsResolver: () => paths, stateWriter: writeState, stateUpdater: updateState,
    hostClusterInstaller: async () => assert.fail("must not dispatch ROI"),
    existingKubernetesInstaller: async (context) => {
      calls.push("helm");
      assert(context.abortState, "existing Kubernetes must share the platform abort token");
      assert.equal(context.options.kubeContext, "production");
      return { verification: { consoleUrl: "http://10.0.0.20:7070", location: "existing-kubernetes" } };
    },
    platformCompleter: async (...args) => {
      calls.push("complete");
      assert.equal(args[3].consoleUrl, "http://10.0.0.20:7070");
      assert.equal(args[5].abortState.aborted, false);
    },
  });
  assert.deepEqual(calls, ["helm", "complete"]);
});

test("existing Kubernetes CLI accepts protected target inputs only in its mode", () => {
  const { parseArgs } = require(platformInstallerPath);
  const parsed = parseArgs(["install", "--location", "server", "--mode", "existing-kubernetes", "--kubeconfig", "./kubeconfig", "--kube-context", "production", "--values", "./values.yaml", "--chart-version", "2.17.0"]);
  assert.equal(parsed.kubeContext, "production");
  assert.equal(parsed.chartVersion, "2.17.0");
  assert(path.isAbsolute(parsed.kubeconfig));
  assert(path.isAbsolute(parsed.values));
  assert.throws(() => parseArgs(["install", "--mode", "single-node", "--kube-context", "production"]), /existing-kubernetes/i);
  assert.throws(() => parseArgs(["install", "--mode", "existing-kubernetes", "--kube-context", "bad\ncontext"]), /context|无效/i);
});

test("production host-cluster driver injects the shared SSH session and active-child signal chain", async () => {
  delete require.cache[require.resolve(platformInstallerPath)];
  const { runHostClusterDriver, interruptActiveOperation } = require(platformInstallerPath);
  const context = {
    state: { operation_id: "1d6754d6-6fb3-4bda-9a04-15c2d261d178" },
    options: {},
  };
  const established = [];
  const closed = [];
  const killed = [];
  let captured;
  const result = await runHostClusterDriver(context, {
    installer: async (value, dependencies) => {
      captured = dependencies;
      const session = await dependencies.sessionFactory({ address: "10.0.0.1", port: 22 }, { interactive: true, write: () => {} });
      dependencies.closeSession(session);
      return { waiting: true };
    },
    establishSession: async (target, options) => {
      established.push({ target, options });
      return { target, controlPath: "/protected/control" };
    },
    closeSession: (session) => closed.push(session),
    packageVersion: "0.1.0-test",
  });
  assert.equal(result.waiting, true);
  assert.deepEqual(established[0].target, { host: "root@10.0.0.1", port: 22 });
  assert.equal(established[0].options.interactive, true);
  assert.equal(closed.length, 1);
  assert.equal(captured.packageVersion, "0.1.0-test");

  for (const signal of ["SIGINT", "SIGTERM"]) {
    const child = { pid: 4242, kill: (received) => killed.push(received) };
    captured.registerChild(child, false);
    interruptActiveOperation(signal);
  }
  assert.deepEqual(killed, ["SIGINT", "SIGTERM"]);
});

test("host-cluster abort remains active after driver resolution and blocks platform completion", async () => {
  delete require.cache[require.resolve(platformInstallerPath)];
  const { runInstallOperation, interruptActiveOperation } = require(platformInstallerPath);
  const operationId = "1d6754d6-6fb3-4bda-9a04-15c2d261d178";
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rainskills-host-abort-after-driver-"));
  const paths = {
    root,
    state: path.join(root, "state.json"),
    events: path.join(root, "events.jsonl"),
    log: path.join(root, "install.log"),
    installer: path.join(root, "installer"),
  };
  let completions = 0;
  await runInstallOperation({ onboardingId: operationId, location: "server", mode: "host-cluster" }, {
    onboardingPathResolver: () => path.join(root, "onboarding.json"),
    ensurePrivateDirectory: () => {},
    onboardingReader: () => ({
      schema: "rainskills.onboarding.v1",
      version: 1,
      operation_id: operationId,
      stage: "awaiting-platform",
      target: "codex",
      deployment_mode: "self-hosted",
      control_mode: "posix",
      intent: { type: "deploy", project_root: "/workspace/app", source_kind: "local" },
    }),
    pathsResolver: () => paths,
    targetSelector: async () => ({ location: "server", mode: "host-cluster", kind: "host-cluster", host: null, sshPort: null }),
    stateWriter: (filePath, value) => fs.writeFileSync(filePath, `${JSON.stringify(value)}\n`, { mode: 0o600 }),
    stateUpdater: (filePath, value, patch) => {
      const updated = { ...value, ...patch };
      fs.writeFileSync(filePath, `${JSON.stringify(updated)}\n`, { mode: 0o600 });
      return updated;
    },
    hostClusterInstaller: async (context) => {
      assert(context.abortState, "runInstallOperation must own the host abort token");
      interruptActiveOperation("SIGINT");
      assert.equal(context.abortState.aborted, true);
      return { verification: { consoleUrl: "http://10.0.0.1:7070", location: "host-cluster" } };
    },
    platformCompleter: async () => { completions += 1; },
  });
  assert.equal(completions, 0);
  const state = JSON.parse(fs.readFileSync(paths.state, "utf8"));
  assert.equal(state.status, "interrupted");
  assert.notEqual(state.stage, "platform-ready");
});

test("a conflicting saved route fails before state rewrite or driver selection", async () => {
  const { runInstallOperation } = require(platformInstallerPath);
  const operationId = "1d6754d6-6fb3-4bda-9a04-15c2d261d178";
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rainskills-saved-route-conflict-"));
  const paths = {
    root,
    state: path.join(root, "state.json"),
    events: path.join(root, "events.jsonl"),
    log: path.join(root, "install.log"),
    installer: path.join(root, "rainbond-install.sh"),
  };
  fs.writeFileSync(paths.state, "{}\n", { mode: 0o600 });
  const savedState = {
    schema: "rainskills.platform-state.v1",
    version: 1,
    operation_id: operationId,
    installation_id: "3d6754d6-6fb3-4bda-9a04-15c2d261d178",
    stage: "target-selection",
    status: "waiting_user",
    location: "local",
    mode: "single-node",
    target_kind: process.platform === "darwin" ? "local-macos" : process.platform === "win32" ? "local-windows" : "local-linux",
    host: "developer-machine",
    ssh_port: null,
  };
  let writes = 0;

  await assert.rejects(() => runInstallOperation({
    onboardingId: operationId,
    location: "server",
    mode: "host-cluster",
  }, {
    onboardingPathResolver: () => path.join(root, "onboarding.json"),
    ensurePrivateDirectory: () => {},
    onboardingReader: () => ({
      operation_id: operationId,
      stage: "awaiting-platform",
      target: "codex",
      deployment_mode: "self-hosted",
      control_mode: "posix",
    }),
    pathsResolver: () => paths,
    platformStateReader: () => savedState,
    stateWriter: () => { writes += 1; },
    targetSelector: async () => assert.fail("must fail before selection"),
  }), /已保存.*冲突|冲突.*已保存/);
  assert.equal(writes, 0);
  assert.equal(fs.readFileSync(paths.state, "utf8"), "{}\n");
});

test("SSH input cannot rewrite a saved local or clustered route", async () => {
  const { runInstallOperation } = require(platformInstallerPath);
  const operationId = "1d6754d6-6fb3-4bda-9a04-15c2d261d178";
  const cases = [
    {
      name: "local",
      location: "local",
      mode: "single-node",
      kind: process.platform === "darwin" ? "local-macos" : process.platform === "win32" ? "local-windows" : "local-linux",
      host: "developer-machine",
    },
    {
      name: "host-cluster",
      location: "server",
      mode: "host-cluster",
      kind: "host-cluster",
      host: null,
    },
    {
      name: "existing-kubernetes",
      location: "server",
      mode: "existing-kubernetes",
      kind: "existing-kubernetes",
      host: null,
    },
  ];

  for (const route of cases) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `rainskills-saved-${route.name}-ssh-`));
    const paths = {
      root,
      state: path.join(root, "state.json"),
      events: path.join(root, "events.jsonl"),
      log: path.join(root, "install.log"),
      installer: path.join(root, "rainbond-install.sh"),
    };
    const originalBytes = `${JSON.stringify({ route: route.name })}\n`;
    fs.writeFileSync(paths.state, originalBytes, { mode: 0o600 });
    let writes = 0;
    let selections = 0;
    let drivers = 0;

    await assert.rejects(() => runInstallOperation({
      onboardingId: operationId,
      ssh: "root@new-server",
      sshPort: null,
    }, {
      onboardingPathResolver: () => path.join(root, "onboarding.json"),
      ensurePrivateDirectory: () => {},
      onboardingReader: () => ({
        operation_id: operationId,
        stage: "awaiting-platform",
        target: "codex",
        deployment_mode: "self-hosted",
        control_mode: "posix",
      }),
      pathsResolver: () => paths,
      platformStateReader: () => ({
        schema: "rainskills.platform-state.v1",
        version: 1,
        operation_id: operationId,
        installation_id: "3d6754d6-6fb3-4bda-9a04-15c2d261d178",
        stage: "target-selection",
        status: "waiting_user",
        location: route.location,
        mode: route.mode,
        target_kind: route.kind,
        host: route.host,
        ssh_port: null,
      }),
      stateWriter: () => { writes += 1; },
      targetSelector: async () => { selections += 1; return null; },
      hostClusterInstaller: async () => { drivers += 1; },
      existingKubernetesInstaller: async () => { drivers += 1; },
    }), /已保存|冲突|不能.*SSH|SSH.*不能/i, route.name);

    assert.equal(writes, 0, `${route.name} must not rewrite state`);
    assert.equal(selections, 0, `${route.name} must fail before selection`);
    assert.equal(drivers, 0, `${route.name} must fail before driver dispatch`);
    assert.equal(fs.readFileSync(paths.state, "utf8"), originalBytes);
  }
});

test("unsafe raw route inputs are redacted and rejected before writes, selection, or drivers", async () => {
  const { runInstallOperation } = require(platformInstallerPath);
  const operationId = "1d6754d6-6fb3-4bda-9a04-15c2d261d178";
  const cases = [
    {
      name: "target-control",
      sentinel: "LEAK_TARGET",
      options: { target: "local-linux\nLEAK_TARGET", mode: "not-a-mode" },
      state: null,
    },
    {
      name: "ssh-ansi",
      sentinel: "LEAK_ANSI",
      options: { ssh: "root@server\u001b[31mLEAK_ANSI" },
      state: null,
    },
    {
      name: "ssh-token",
      sentinel: "ghp_SUPERSECRET_ROUTE_TOKEN_1234567890",
      options: { ssh: "ghp_SUPERSECRET_ROUTE_TOKEN_1234567890" },
      state: null,
    },
    {
      name: "ssh-whitelist",
      sentinel: "LEAK_SHELL",
      options: { ssh: "root@server;LEAK_SHELL" },
      state: null,
    },
    {
      name: "saved-host-token",
      sentinel: "ghp_SAVED_SUPERSECRET_ROUTE_TOKEN_123456",
      options: { location: "server", mode: "single-node" },
      state: {
        location: "server",
        mode: "single-node",
        target_kind: "remote-linux",
        host: "ghp_SAVED_SUPERSECRET_ROUTE_TOKEN_123456",
        ssh_port: 22,
      },
    },
    {
      name: "saved-host-whitelist",
      sentinel: "LEAK_SAVED_SHELL",
      options: { location: "server", mode: "single-node" },
      state: {
        location: "server",
        mode: "single-node",
        target_kind: "remote-linux",
        host: "root@server;LEAK_SAVED_SHELL",
        ssh_port: 22,
      },
    },
    {
      name: "invalid-waiting-tuple",
      sentinel: "host-cluster",
      options: {},
      state: {
        location: "server",
        mode: null,
        target_kind: "host-cluster",
        host: null,
        ssh_port: null,
      },
    },
    {
      name: "invalid-local-kind",
      sentinel: "local-evil",
      options: {},
      state: {
        location: "local",
        mode: "single-node",
        target_kind: "local-evil",
        host: "developer-machine",
        ssh_port: null,
      },
    },
    {
      name: "invalid-legacy-cluster",
      sentinel: "host-cluster",
      options: {},
      state: {
        target_kind: "host-cluster",
        host: null,
        ssh_port: null,
      },
    },
    {
      name: "invalid-legacy-wrong-local",
      sentinel: process.platform === "darwin" ? "local-linux" : "local-macos",
      options: {},
      state: {
        target_kind: process.platform === "darwin" ? "local-linux" : "local-macos",
        host: "other-host",
        ssh_port: null,
      },
    },
    {
      name: "invalid-legacy-remote-port",
      sentinel: "65536",
      options: {},
      state: {
        target_kind: "remote-linux",
        host: "root@server",
        ssh_port: 65536,
      },
    },
  ];

  for (const item of cases) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `rainskills-unsafe-${item.name}-`));
    const paths = {
      root,
      state: path.join(root, "state.json"),
      events: path.join(root, "events.jsonl"),
      log: path.join(root, "install.log"),
      installer: path.join(root, "rainbond-install.sh"),
    };
    const originalBytes = item.state ? `${JSON.stringify({ preserved: item.name })}\n` : null;
    if (originalBytes) fs.writeFileSync(paths.state, originalBytes, { mode: 0o600 });
    const output = [];
    let writes = 0;
    let selections = 0;
    let drivers = 0;
    let failure;
    try {
      await runInstallOperation({ onboardingId: operationId, ...item.options }, {
        onboardingPathResolver: () => path.join(root, "onboarding.json"),
        ensurePrivateDirectory: () => {},
        onboardingReader: () => ({
          operation_id: operationId,
          stage: "awaiting-platform",
          target: "codex",
          deployment_mode: "self-hosted",
          control_mode: "posix",
        }),
        pathsResolver: () => paths,
        platformStateReader: () => ({
          schema: "rainskills.platform-state.v1",
          version: 1,
          operation_id: operationId,
          installation_id: "3d6754d6-6fb3-4bda-9a04-15c2d261d178",
          stage: "target-selection",
          status: "waiting_user",
          ...(item.state || {}),
        }),
        stateWriter: () => { writes += 1; },
        targetSelector: async ({ write }) => {
          selections += 1;
          write?.(item.sentinel);
          return null;
        },
        hostClusterInstaller: async () => { drivers += 1; },
        existingKubernetesInstaller: async () => { drivers += 1; },
      });
      assert.fail(`${item.name} must reject unsafe input`);
    } catch (error) {
      failure = error;
    }

    const visible = `${failure?.message || ""}\n${output.join("")}`;
    assert.doesNotMatch(visible, new RegExp(item.sentinel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.equal(writes, 0, `${item.name} must not rewrite state`);
    assert.equal(selections, 0, `${item.name} must fail before selection`);
    assert.equal(drivers, 0, `${item.name} must fail before driver dispatch`);
    if (originalBytes) assert.equal(fs.readFileSync(paths.state, "utf8"), originalBytes);
    else assert.equal(fs.existsSync(paths.state), false);
  }
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
  assert.match(result.stdout, /RAINSKILLS_USER_INPUT_REQUIRED:platform_install_location/);
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

test("remote preparation remains non-interactive even if a legacy session says interactive", () => {
  const { prepareRemoteInstaller } = require(platformInstallerPath);
  const calls = [];
  const operationId = "1d6754d6-6fb3-4bda-9a04-15c2d261d178";
  const runner = (command, args, options) => {
    calls.push({ command, args, options });
    return { status: 0, stdout: "", stderr: "" };
  };

  prepareRemoteInstaller(
    { host: "rainbond-prod", port: 2202 },
    operationId,
    "C:\\tmp\\rainbond-install.sh",
    runner,
    { interactive: true }
  );

  assert.equal(calls[0].options.interactive, undefined);
  assert.equal(calls[0].options.timeout, 30000);
  assert.match(calls[0].options.input, /chmod 700/);
  assert(calls[1].args.includes("BatchMode=yes"));
  assert.equal(calls[1].options.interactive, undefined);
  assert.equal(calls[1].options.timeout, 120000);
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

test("remote installer invocation never reopens SSH password authentication", () => {
  const { remoteInstallerInvocation } = require(platformInstallerPath);
  const operationId = "1d6754d6-6fb3-4bda-9a04-15c2d261d178";
  const digest = "b".repeat(64);
  const invocation = remoteInstallerInvocation(
    { host: "root@192.168.1.20", port: 22 },
    operationId,
    digest,
    "192.168.1.20",
    { interactive: true }
  );

  assert.equal(invocation.interactive, false);
  assert.match(invocation.input, /set -euo pipefail/);
  assert(invocation.args.includes("BatchMode=yes"));
  assert(invocation.args.some((argument) => argument.includes(operationId)));
  assert(invocation.args.includes(digest));
  assert(!invocation.args.includes("ControlMaster=yes"));
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
  assert.match(skill, /Windows.*同一份三项部署位置消息/is);
  assert.match(skill, /local-windows/);
  assert.match(skill, /UAC/);
  assert.doesNotMatch(skill, /推荐/);
  assert.match(skill, /ssh prepare/);
  assert.match(skill, /TTY availability must not change this behavior/);
  assert.match(skill, /BatchMode=yes/);
  assert.match(skill, /同一 `onboarding-id`/);
  assert.match(skill, /授权仅.*一次/s);
  assert.doesNotMatch(skill, /later steps may ask for the password again/i);
  assert.match(skill, /Never ask.*password.*in chat/is);
  assert.match(skill, /RAINSKILLS_USER_INPUT_REQUIRED:console_address/);
  assert.match(skill, /--console-host/);
  assert.match(skill, /IP or DNS name.*not.*URL/is);
});

test("official installer policy trusts only the fixed HTTPS origin and bounds mutable content", () => {
  const { POLICY } = require(platformInstallerPath);
  assert.equal(POLICY.schema, "rainskills.platform-installation-policy.v2");
  assert.equal(POLICY.recommended.cpu_cores, 4);
  assert.equal(POLICY.recommended.memory_bytes, 8 * 1024 ** 3);
  assert.equal(POLICY.recommended.disk_bytes, 50 * 1024 ** 3);
  assert.equal(POLICY.minimums.cpu_cores, 2);
  assert.equal(POLICY.minimums.memory_bytes, 4 * 1024 ** 3);
  assert.equal(POLICY.minimums.disk_bytes, 30 * 1024 ** 3);
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
  assert.match(readme, /云端环境（免费体验）.*私有环境（去对接）.*部署到本机.*部署到独立服务器.*部署到已有 Rainbond/s);
  assert.match(readme, /部署到本机.*部署到独立服务器.*部署到已有 Rainbond/s);
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
