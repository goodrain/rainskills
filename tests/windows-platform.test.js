"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { Readable, Writable } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const test = require("node:test");

const repoRoot = path.resolve(__dirname, "..");
const policy = require(path.join(
  repoRoot,
  "rainbond-platform-installer",
  "references",
  "installation-policy.json"
));
const windowsPlatformPath = path.join(
  repoRoot,
  "rainbond-platform-installer",
  "scripts",
  "windows-platform.js"
);
const platformInstallerPath = path.join(
  repoRoot,
  "rainbond-platform-installer",
  "scripts",
  "platform-installer.js"
);
const powershellPath = path.join(
  repoRoot,
  "rainbond-platform-installer",
  "scripts",
  "windows-platform.ps1"
);
const wslBootstrapPath = path.join(
  repoRoot,
  "rainbond-platform-installer",
  "scripts",
  "wsl-bootstrap.sh"
);
const { createPortableSecureStateStore } = require("./helpers/portable-secure-state.js");

const OPERATION_ID = "1d6754d6-6fb3-4bda-9a04-15c2d261d178";
const INSTALLATION_ID = "a72d3cf0-3f8f-4c24-99de-7bd76c65c3a1";
const USER_SID = "S-1-5-21-111-222-333-1001";

function normalizeLineEndings(value) {
  return String(value).replace(/\r\n?/g, "\n");
}

function readNormalizedSource(filePath) {
  return normalizeLineEndings(fs.readFileSync(filePath, "utf8"));
}

test("PowerShell source assertions treat CRLF and LF identically", () => {
  assert.equal(normalizeLineEndings("first\r\nsecond\r\n"), "first\nsecond\n");
});

test("Windows lifecycle telemetry stays in the outer Node process and carries the persisted attempt", () => {
  const source = fs.readFileSync(platformInstallerPath, "utf8");
  assert.match(source, /createLifecycleTelemetry/);
  assert.match(source, /RAINSKILLS_INSTALL_ATTEMPT_ID: resumeState\.install_attempt_id/);
  assert.match(source, /lifecycleTransportForState\(state\)/);
  assert.doesNotMatch(readNormalizedSource(powershellPath), /lifecycle-event|log\.rainbond\.com/);
});

function passingFacts(overrides = {}) {
  return {
    productType: "workstation",
    buildNumber: 22631,
    architecture: "x64",
    currentUserSid: USER_SID,
    isAdministrator: true,
    uacEnabled: true,
    cpuCores: 8,
    memoryBytes: 16 * 1024 ** 3,
    diskBytes: 120 * 1024 ** 3,
    virtualizationEnabled: true,
    wslFeatureState: "Disabled",
    virtualMachinePlatformFeatureState: "Disabled",
    rebootPending: false,
    wslInstalled: false,
    wslDefaultVersion: null,
    wslNetworkingMode: "nat",
    occupiedPorts: [],
    unknownManagedObjects: [],
    availableSubnet: "172.31.255.0/30",
    originChecks: policy.windows.preflight_allowed_origins.map((origin) => ({
      origin,
      reachable: true,
      redirectOrigins: [],
    })),
    ...overrides,
  };
}

function createFixture({ mutateResult } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "rainskills-windows-platform-"));
  const stateStore = createPortableSecureStateStore(home);
  const calls = [];
  const requests = [];
  const runner = async (command, args) => {
    calls.push({ command, args: [...args] });
    const valueAfter = (name) => args[args.indexOf(name) + 1];
    const requestPath = valueAfter("-RequestPath");
    const resultPath = valueAfter("-ResultPath");
    const request = stateStore.readProtectedJson(requestPath);
    requests.push({ request, requestPath, resultPath });
    const result = {
      schema: "rainskills.windows-result.v1",
      action: request.action,
      operation_id: request.operation_id,
      installation_id: request.installation_id,
      nonce: request.nonce,
      status: "ok",
      facts: passingFacts(),
    };
    stateStore.atomicWriteJson(resultPath, mutateResult ? mutateResult(result) : result);
    return { status: 0, stdout: "", stderr: "" };
  };
  return { calls, home, requests, runner, stateStore };
}

test("Windows policy pins supported hosts and trusted artifacts", () => {
  assert.equal(policy.windows.minimum_build, 19041);
  assert.deepEqual(policy.windows.supported_architectures, ["x64"]);
  assert.deepEqual(policy.windows.supported_product_types, ["workstation"]);
  assert.equal(policy.windows.distro_name, "Rainbond");
  assert.deepEqual(policy.windows.networking_modes, ["nat"]);
  assert.deepEqual(policy.windows.managed_ports, [80, 443, 7070]);
  assert.deepEqual(policy.windows.ubuntu_rootfs, {
    urls: [
      "https://mirror.nju.edu.cn/ubuntu-cloud-images/wsl/jammy/20250318/ubuntu-jammy-wsl-amd64-ubuntu22.04lts.rootfs.tar.gz",
      "https://mirrors.tuna.tsinghua.edu.cn/ubuntu-cloud-images/wsl/jammy/20250318/ubuntu-jammy-wsl-amd64-ubuntu22.04lts.rootfs.tar.gz",
      "https://cloud-images.ubuntu.com/wsl/jammy/20250318/ubuntu-jammy-wsl-amd64-ubuntu22.04lts.rootfs.tar.gz",
    ],
    max_bytes: 536870912,
    trust: "https-origin+wsl-import-validation",
  });
  assert.deepEqual(policy.windows.legacy_wsl_kernel, {
    url: "https://wslstorestorage.blob.core.windows.net/wslblob/wsl_update_x64.msi",
    sha256: "4d09c776c8d45f70a202281d18e19be1118f53159b0c217a5274a31ce18525fe",
    trust: "sha256-pinned+authenticode",
  });
  assert.deepEqual(policy.windows.wsl_web_update, { trust: "os-signed-update" });
  assert.deepEqual(policy.windows.preflight_allowed_origins, [
    "https://wslstorestorage.blob.core.windows.net",
    "https://mirror.nju.edu.cn",
    "https://mirrors.tuna.tsinghua.edu.cn",
    "https://cloud-images.ubuntu.com",
    "https://get.rainbond.com",
    "https://registry.cn-hangzhou.aliyuncs.com",
  ]);
});

test("Windows adapter sends only a fixed nonce-bound preflight request", async () => {
  const { createWindowsPlatformAdapter, FIXED_ACTIONS } = require(windowsPlatformPath);
  assert(FIXED_ACTIONS.includes("Preflight"));
  assert.equal(Object.isFrozen(FIXED_ACTIONS), true);
  const fixture = createFixture();
  const adapter = createWindowsPlatformAdapter({
    runner: fixture.runner,
    stateStore: fixture.stateStore,
    policy,
    userSid: USER_SID,
    home: fixture.home,
  });

  const first = await adapter.preflight({ operationId: OPERATION_ID, installationId: INSTALLATION_ID });
  const second = await adapter.preflight({ operationId: OPERATION_ID, installationId: INSTALLATION_ID });

  assert.equal(first.facts.productType, "workstation");
  assert.equal(fixture.calls.length, 2);
  for (const call of fixture.calls) {
    assert.equal(call.command, "powershell.exe");
    assert.deepEqual(call.args.slice(0, 4), ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass"]);
    assert.equal(call.args[call.args.indexOf("-Action") + 1], "Preflight");
    assert.equal(call.args[call.args.indexOf("-File") + 1], powershellPath);
    assert(!call.args.includes("-Command"));
  }
  assert.notEqual(fixture.requests[0].request.nonce, fixture.requests[1].request.nonce);
  for (const { request, requestPath, resultPath } of fixture.requests) {
    assert.deepEqual(Object.keys(request).sort(), [
      "action",
      "installation_id",
      "nonce",
      "operation_id",
      "policy",
      "schema",
      "user_sid",
    ]);
    assert.equal(request.action, "Preflight");
    assert.equal(request.operation_id, OPERATION_ID);
    assert.equal(request.installation_id, INSTALLATION_ID);
    assert.equal(request.user_sid, USER_SID);
    assert(!Object.hasOwn(request, "command"));
    assert(!Object.hasOwn(request, "script"));
    const operationRoot = path.join(fixture.home, ".rainbond", "platform-installer", OPERATION_ID, "windows");
    assert.equal(path.relative(operationRoot, requestPath).startsWith(".."), false);
    assert.equal(path.relative(operationRoot, resultPath).startsWith(".."), false);
  }
});

test("Windows adapter protects an externally created result before reading it", async () => {
  const { createWindowsPlatformAdapter } = require(windowsPlatformPath);
  const fixture = createFixture();
  const protectedResults = new Set();
  const stateStore = {
    ...fixture.stateStore,
    protectRegularFile(filePath) {
      protectedResults.add(filePath);
    },
    readProtectedJson(filePath) {
      if (path.basename(filePath).startsWith("result-") && !protectedResults.has(filePath)) {
        throw new Error(`Windows 状态路径 owner 不匹配：${filePath}`);
      }
      return fixture.stateStore.readProtectedJson(filePath);
    },
  };
  const adapter = createWindowsPlatformAdapter({
    runner: fixture.runner,
    stateStore,
    policy,
    userSid: USER_SID,
    home: fixture.home,
  });

  const result = await adapter.preflight({
    operationId: OPERATION_ID,
    installationId: INSTALLATION_ID,
  });

  assert.equal(result.facts.productType, "workstation");
  assert.equal(protectedResults.size, 1);
});

test("Windows adapter translates only host filesystem payload paths for a WSL control shell", () => {
  const { translateWindowsPayloadPaths } = require(windowsPlatformPath);
  const seen = [];
  const translated = translateWindowsPayloadPaths({
    helper_path: "/home/user/package/windows-platform.ps1",
    recovery_root: "/home/user/.rainbond/recovery-v1",
    recovery_entry: "/home/user/.rainbond/recovery-v1/bin/rainskills.js",
    node_path: "/usr/bin/node",
    installer_path: "/home/user/.rainbond/rainbond-install.sh",
    control_node_path: "/usr/bin/node",
    control_recovery_entry: "/home/user/.rainbond/recovery-v1/bin/rainskills.js",
    control_distro: "Ubuntu",
  }, (value) => {
    seen.push(value);
    return `WIN:${value}`;
  });

  assert.deepEqual(seen, [
    "/home/user/package/windows-platform.ps1",
    "/home/user/.rainbond/recovery-v1",
    "/home/user/.rainbond/recovery-v1/bin/rainskills.js",
    "/usr/bin/node",
    "/home/user/.rainbond/rainbond-install.sh",
  ]);
  assert.equal(translated.helper_path, "WIN:/home/user/package/windows-platform.ps1");
  assert.equal(translated.control_node_path, "/usr/bin/node");
  assert.equal(translated.control_recovery_entry, "/home/user/.rainbond/recovery-v1/bin/rainskills.js");
  assert.equal(translated.control_distro, "Ubuntu");
});

test("Windows adapter rejects invalid identifiers, mismatched results, and command injection fields", async () => {
  const { createWindowsPlatformAdapter } = require(windowsPlatformPath);
  const invalid = createFixture();
  const invalidAdapter = createWindowsPlatformAdapter({
    runner: invalid.runner,
    stateStore: invalid.stateStore,
    policy,
    userSid: USER_SID,
    home: invalid.home,
  });
  await assert.rejects(
    invalidAdapter.preflight({ operationId: "../escape", installationId: INSTALLATION_ID }),
    /operation id/i
  );
  await assert.rejects(
    invalidAdapter.preflight({ operationId: OPERATION_ID, installationId: "not-a-uuid" }),
    /installation id/i
  );

  for (const mutateResult of [
    (result) => ({ ...result, nonce: "wrong" }),
    (result) => ({ ...result, operation_id: crypto.randomUUID() }),
    (result) => ({ ...result, command: "Remove-Item C:\\" }),
    (result) => ({ ...result, script: "arbitrary" }),
    (result) => ({ ...result, facts: { ...result.facts, command: "whoami" } }),
    (result) => ({
      ...result,
      status: "error",
      facts: { failedAction: "PrepareWsl", failureMessage: "wrong action" },
    }),
    (result) => ({
      ...result,
      status: "error",
      facts: { failedAction: "Preflight", failureMessage: "unsafe\u0000message" },
    }),
  ]) {
    const fixture = createFixture({ mutateResult });
    const adapter = createWindowsPlatformAdapter({
      runner: fixture.runner,
      stateStore: fixture.stateStore,
      policy,
      userSid: USER_SID,
      home: fixture.home,
    });
    await assert.rejects(
      adapter.preflight({ operationId: OPERATION_ID, installationId: INSTALLATION_ID }),
      /结果|nonce|字段|匹配/i
    );
  }
});

test("Windows preflight assessment explains every unsupported condition", () => {
  const { evaluateWindowsPreflight } = require(windowsPlatformPath);
  const facts = passingFacts({
    productType: "server",
    buildNumber: 18363,
    architecture: "arm64",
    currentUserSid: "S-1-5-21-other",
    isAdministrator: false,
    uacEnabled: false,
    cpuCores: 1,
    memoryBytes: 3 * 1024 ** 3,
    diskBytes: 29 * 1024 ** 3,
    virtualizationEnabled: false,
    wslInstalled: true,
    wslNetworkingMode: "mirrored",
    occupiedPorts: [80, 7070],
    unknownManagedObjects: ["distro:Rainbond"],
    availableSubnet: null,
    originChecks: [
      { origin: policy.windows.preflight_allowed_origins[0], reachable: false, redirectOrigins: [] },
      {
        origin: policy.windows.preflight_allowed_origins[1],
        reachable: true,
        redirectOrigins: ["https://untrusted.example"],
      },
    ],
  });
  const assessment = evaluateWindowsPreflight(facts, policy, USER_SID);
  const blockers = assessment.blockers.join("\n");

  assert.equal(assessment.ok, false);
  assert.match(blockers, /Windows 工作站/);
  assert.match(blockers, /19041/);
  assert.match(blockers, /x64/);
  assert.match(blockers, /当前用户 SID/);
  assert.match(blockers, /Administrators/);
  assert.match(blockers, /UAC/);
  assert.match(blockers, /最低.*2 核/);
  assert.match(blockers, /最低.*4 GB/);
  assert.match(blockers, /最低.*30 GB/);
  assert.match(blockers, /虚拟化/);
  assert.match(blockers, /NAT/);
  assert.match(blockers, /80.*7070/);
  assert.match(blockers, /未知的 RainSkills 管理对象/);
  assert.match(blockers, /可用.*\/30/);
  assert.match(blockers, /无法访问/);
  assert.match(blockers, /未获准的跳转来源/);
});

test("Windows preflight allows below-recommended resources with warnings", () => {
  const { evaluateWindowsPreflight } = require(windowsPlatformPath);
  const assessment = evaluateWindowsPreflight(passingFacts({
    cpuCores: 2,
    memoryBytes: 4 * 1024 ** 3,
    diskBytes: 30 * 1024 ** 3,
  }), policy, USER_SID);

  assert.equal(assessment.ok, true);
  assert.deepEqual(assessment.blockers, []);
  assert.match(assessment.warnings.join("\n"), /低于推荐配置/);
});

test("passing Windows preflight lists the exact user-visible effects", () => {
  const { evaluateWindowsPreflight } = require(windowsPlatformPath);
  const assessment = evaluateWindowsPreflight(passingFacts(), policy, USER_SID);

  assert.equal(assessment.ok, true);
  assert.deepEqual(assessment.effects, [
    "启用 WSL 2 和虚拟机平台组件（可能需要重启 Windows）",
    "安装或更新经过验证的 WSL 运行时",
    "下载 Ubuntu 22.04 根文件系统",
    "创建专用的 Rainbond WSL 发行版",
    "配置本机 NAT 网络和 127.0.0.1 端口转发",
    "在专用 WSL 环境中安装并验证 Rainbond",
  ]);
});

test("Windows preflight requires only one reachable configured rootfs source", () => {
  const { evaluateWindowsPreflight } = require(windowsPlatformPath);
  const rootfsOrigins = new Set(policy.windows.ubuntu_rootfs.urls.map((url) => new URL(url).origin));
  const facts = passingFacts({
    originChecks: policy.windows.preflight_allowed_origins.map((origin) => ({
      origin,
      reachable: !rootfsOrigins.has(origin) || origin === new URL(policy.windows.ubuntu_rootfs.urls[0]).origin,
      redirectOrigins: [],
    })),
  });

  assert.equal(evaluateWindowsPreflight(facts, policy, USER_SID).ok, true);
});

test("PowerShell preflight is a fixed read-only action with structured output", () => {
  const source = readNormalizedSource(powershellPath);
  const preflight = source.match(/function Invoke-Preflight\(\$Request\) \{[\s\S]*?\n\}/)?.[0];
  assert(preflight, "Invoke-Preflight must remain a standalone fixed action");
  assert.match(source, /ValidateSet\("Preflight",/);
  assert.match(source, /rainskills\.windows-request\.v1/);
  assert.match(source, /rainskills\.windows-result\.v1/);
  assert.match(preflight, /Get-CimInstance/);
  assert.match(preflight, /Get-NetTCPConnection/);
  assert.match(source, /Get-NetRoute/);
  assert.doesNotMatch(preflight, /Get-WindowsOptionalFeature/);
  assert.match(source, /function Get-WslRuntimeFacts[\s\S]*Get-WindowsOptionalFeature/);
  assert.doesNotMatch(source, /Invoke-Expression/);
  assert.doesNotMatch(source, /ScriptBlock/);
});

test("PowerShell preflight handles transport failures without an HTTP response", () => {
  const source = readNormalizedSource(powershellPath);
  const probe = source.match(/function Test-OriginReachability\(\[string\]\$Origin, \[string\[\]\]\$AllowedOrigins\) \{[\s\S]*?\n\}/)?.[0];
  assert(probe, "Test-OriginReachability must remain a standalone fixed probe");
  assert.match(probe, /PSObject\.Properties\["Response"\]/);
  assert.doesNotMatch(probe, /\$_\.Exception\.Response/);
});

test("PowerShell helper emits UTF-8 diagnostics for the Node launcher", () => {
  const source = readNormalizedSource(powershellPath);
  assert.match(source, /\[Console\]::OutputEncoding = \$utf8Encoding/);
  assert.match(source, /\$OutputEncoding = \$utf8Encoding/);
});

test("PowerShell treats unsupported WSL probe commands as facts instead of terminating errors", () => {
  const source = readNormalizedSource(powershellPath);
  const runtimeFacts = source.match(/function Get-WslRuntimeFacts \{[\s\S]*?\n\}\n\nfunction Install-LegacyWslKernel/)?.[0];
  assert(runtimeFacts, "Get-WslRuntimeFacts must remain a standalone fixed probe");
  assert.match(source, /function Invoke-NativeCapture/);
  assert.match(runtimeFacts, /Invoke-NativeCapture \$wslPath @\("--version"\)/);
  assert.match(runtimeFacts, /Invoke-NativeCapture \$wslPath @\("--status"\)/);
  assert.doesNotMatch(runtimeFacts, /& \$wslPath --(?:version|status) 2>&1/);
});

test("PowerShell returns a nonce-bound structured result when an elevated action fails", () => {
  const source = readNormalizedSource(powershellPath);
  assert.match(source, /function Write-ActionErrorResult/);
  assert.match(source, /Write-ActionResult[\s\S]*"error"/);
  assert.match(source, /failedAction/);
  assert.match(source, /failureMessage/);
  assert.match(source, /Invoke-ElevatedSelf[\s\S]*Read-ActionResult/);
  assert.match(source, /\$resultIdentityValidated = \$true/);
  assert.match(source, /if \(\$resultIdentityValidated -and \$null -ne \$request\)/);
});

test("PowerShell reads every persisted JSON document as UTF-8", () => {
  const source = readNormalizedSource(powershellPath);
  const jsonReads = source.match(/Get-Content -LiteralPath[^\n]*ConvertFrom-Json/g) || [];
  assert(jsonReads.length >= 6, "expected all persisted Windows JSON read sites");
  for (const read of jsonReads) assert.match(read, /-Encoding UTF8/);
});

test("PowerShell upgrades only a verified machine bundle from the same installation", () => {
  const source = readNormalizedSource(powershellPath);
  const installBundle = source.match(/function Invoke-InstallMachineBundle\(\$Request\) \{[\s\S]*?\n\}\n\nfunction Get-TrustedWslPath/)?.[0];
  assert(installBundle, "Invoke-InstallMachineBundle must remain a standalone fixed action");
  assert.match(installBundle, /Assert-ManagedMachineRoot \$machineRoot \$Request\.installation_id/);
  assert.match(installBundle, /Set-MachineRootAcl \$machineRoot \$Request\.user_sid[\s\S]*Assert-MachineManifestIdentity \$Request/);
  assert.match(installBundle, /Assert-UpgradableMachineBundle/);
  assert.match(installBundle, /Get-PropertyValue \$payload "package_version"/);
  assert.match(installBundle, /Assert-SafePackageVersion \$packageVersion/);
  assert.match(installBundle, /package_version = \$packageVersion/);
  assert.match(installBundle, /Publish-MachineBundleTransaction/);
  assert.doesNotMatch(installBundle, /existing\.helper_sha256 -ne \$expectedHelperDigest/);
  assert.doesNotMatch(installBundle, /Copy-Item/);
  assert.match(source, /function Assert-UpgradableMachineBundle[\s\S]*Assert-FileDigestOneOf/);
  assert.match(source, /b2315dcec815187f3f48144981487bf2646dad5ed0de12a1125b99c45ecf18fd/);
  assert.match(source, /function Assert-ManagedMachineRoot[\s\S]*ReparsePoint/);
  const aclFunction = source.match(/function Set-MachineRootAcl[\s\S]*?\n\}/)?.[0];
  assert(aclFunction, "Set-MachineRootAcl must remain a standalone fixed action");
  assert.match(aclFunction, /\/setowner[\s\S]*S-1-5-32-544/);
  assert.match(aclFunction, /\/verify/);
  assert.doesNotMatch(aclFunction, /\s\/c(?:\s|$)/);

  const identity = source.match(/function Assert-MachineManifestIdentity[\s\S]*?\n\}/)?.[0];
  const verifiedManifest = source.match(/function Assert-MachineManifest\(\$Request\)[\s\S]*?\n\}/)?.[0];
  const packageVersionValidator = source.match(/function Assert-SafePackageVersion[\s\S]*?\n\}/)?.[0];
  assert(identity, "machine identity verification must remain independently reusable for legacy upgrades");
  assert(verifiedManifest, "current machine manifest verification must remain a standalone operation");
  assert(packageVersionValidator, "package version validation must remain a standalone fixed operation");
  assert.match(packageVersionValidator, /IsNullOrWhiteSpace/);
  assert.match(packageVersionValidator, /Length -gt 128/);
  assert.match(packageVersionValidator, /-notmatch '\^\[0-9A-Za-z\]/);
  assert.doesNotMatch(identity, /Assert-SafePackageVersion/);
  assert.match(verifiedManifest, /Assert-SafePackageVersion/);
  assert(
    installBundle.indexOf("Assert-MachineManifestIdentity") < installBundle.indexOf("Assert-UpgradableMachineBundle")
      && installBundle.indexOf("Assert-UpgradableMachineBundle") < installBundle.indexOf("package_version = $packageVersion"),
    "a legacy manifest must pass identity and digest checks before it is upgraded"
  );
});

test("PowerShell stages and rolls back the protected machine bundle as one transaction", () => {
  const source = readNormalizedSource(powershellPath);
  const installBundle = source.match(/function Invoke-InstallMachineBundle\(\$Request\) \{[\s\S]*?\n\}\n\nfunction Get-TrustedWslPath/)?.[0];
  const transaction = source.match(/function Publish-MachineBundleTransaction[\s\S]*?\n\}\n\nfunction Invoke-InstallMachineBundle/)?.[0];
  const rollback = source.match(/function Restore-MachineBundleFile[\s\S]*?\n\}/)?.[0];
  const regularFileCheck = source.match(/function Test-RegularMachineBundleFile[\s\S]*?\n\}/)?.[0];
  assert(installBundle, "Invoke-InstallMachineBundle must remain a standalone fixed action");
  assert(transaction, "machine bundle publication must remain a standalone transaction");
  assert(rollback, "machine bundle rollback must remain a standalone fixed operation");
  assert(regularFileCheck, "machine bundle file validation must remain a standalone fixed operation");

  assert.match(transaction, /Copy-Item -LiteralPath \$SourceHelper -Destination \$helperStage/);
  assert.match(transaction, /Copy-Item -LiteralPath \$BootstrapSource -Destination \$bootstrapStage/);
  const helperVerified = transaction.indexOf("Assert-FileDigest $helperStage $ExpectedHelperDigest");
  const bootstrapVerified = transaction.indexOf("Assert-FileDigest $bootstrapStage $BootstrapDigest");
  const firstSwitch = Math.min(
    ...[transaction.indexOf("[IO.File]::Replace"), transaction.indexOf("[IO.File]::Move")]
      .filter((index) => index >= 0)
  );
  assert(helperVerified >= 0 && bootstrapVerified >= 0, "both staged files must be digest verified");
  assert(firstSwitch > helperVerified && firstSwitch > bootstrapVerified, "both staged files must verify before any final path changes");
  assert.match(transaction, /ConvertFrom-Json/);
  assert.match(transaction, /helperBackup/);
  assert.match(transaction, /bootstrapBackup/);
  assert.match(transaction, /manifestBackup/);
  assert.match(transaction, /catch \{[\s\S]*Restore-MachineBundleFile \$ManifestPath[\s\S]*Restore-MachineBundleFile \$MachineBootstrap[\s\S]*Restore-MachineBundleFile \$MachineHelper/);
  assert.match(rollback, /Test-RegularMachineBundleFile/);
  assert.match(regularFileCheck, /ReparsePoint/);
  assert.match(rollback, /\[IO\.File\]::Replace/);
  assert.match(rollback, /\[IO\.File\]::Move/);
  assert.doesNotMatch(installBundle, /Copy-Item[^\n]*-Destination \$(?:machineHelper|machineBootstrap)/);
  assert.match(installBundle, /\$machineRootCreated = \$false/);
  assert.match(installBundle, /catch \{[\s\S]*\$machineRootCreated[\s\S]*Get-ChildItem -LiteralPath \$machineRoot -Force[\s\S]*Remove-Item -LiteralPath \$machineRoot -Force/);
  assert.match(installBundle, /Set-MachineRootAcl \$machineRoot \$Request\.user_sid[\s\S]*Assert-MachineManifest \$Request/);
});

test("PowerShell rebuilds an effective ACL on every existing machine item", () => {
  const source = readNormalizedSource(powershellPath);
  const itemAcl = source.match(/function Set-MachineItemAcl[\s\S]*?\n\}/)?.[0];
  assert(itemAcl, "Set-MachineItemAcl must remain a standalone fixed operation");
  assert.match(itemAcl, /DirectorySecurity/);
  assert.match(itemAcl, /FileSecurity/);
  assert.match(itemAcl, /SetAccessRuleProtection\(\$true, \$false\)/);
  assert.match(itemAcl, /S-1-5-18/);
  assert.match(itemAcl, /S-1-5-32-544/);
  assert.match(itemAcl, /ReadAndExecute/);
  assert.match(itemAcl, /FullControl/);
  const aclFunction = source.match(/function Set-MachineRootAcl[\s\S]*?\n\}/)?.[0];
  assert.match(aclFunction, /takeown\.exe/);
  assert.match(aclFunction, /Get-ChildItem[^\n]*-Recurse/);
  assert.match(aclFunction, /Set-MachineItemAcl/);
  assert(
    aclFunction.indexOf("takeown.exe") < aclFunction.indexOf("Set-MachineItemAcl"),
    "each inaccessible item must be owned by the elevated user before its ACL is rebuilt"
  );
  assert(
    aclFunction.indexOf("Set-MachineItemAcl") < aclFunction.indexOf("/setowner"),
    "the Administrators owner must be restored only after the ACL is usable"
  );
  assert.doesNotMatch(aclFunction, /\/grant:r/);
});

test("PowerShell identifies the failing PrepareWsl substep", () => {
  const source = readNormalizedSource(powershellPath);
  const prepareWsl = source.match(/function Invoke-PrepareWsl\(\$Request\) \{[\s\S]*?\n\}\n\nfunction Invoke-ProvisionRainbond/)?.[0];
  assert(prepareWsl, "Invoke-PrepareWsl must remain a standalone fixed action");
  assert.match(prepareWsl, /InstallMachineBundle failed/);
  assert.match(prepareWsl, /EnableWsl failed/);
});

test("combined provisioning upgrades the machine bundle before invoking WSL", () => {
  const source = readNormalizedSource(powershellPath);
  const provision = source.match(/function Invoke-ProvisionRainbond\(\$Request\) \{[\s\S]*?\n\}\n\n\$request =/)?.[0];
  assert(provision, "Invoke-ProvisionRainbond must remain a standalone fixed action");
  const bundleUpgrade = provision.indexOf("Invoke-InstallMachineBundle $Request");
  const importDistro = provision.indexOf("Invoke-ImportDistro $Request");
  assert(bundleUpgrade >= 0, "ProvisionRainbond must refresh the persisted helper and bootstrap");
  assert(importDistro > bundleUpgrade, "the machine bundle must be refreshed before any WSL action");
  assert.match(provision, /InstallMachineBundle failed/);
});

test("PowerShell replaces a stale regular machine lease instead of overwriting it in place", () => {
  const source = readNormalizedSource(powershellPath);
  const leaseWriter = source.match(/function Write-MachineLease[\s\S]*?\n\}/)?.[0];
  assert(leaseWriter, "Write-MachineLease must remain a standalone fixed operation");
  assert.match(leaseWriter, /ReparsePoint/);
  assert.match(leaseWriter, /PSIsContainer/);
  assert.match(leaseWriter, /IsReadOnly = \$false/);
  assert.match(leaseWriter, /Remove-Item[^\n]*-Force/);
  assert.match(leaseWriter, /WriteAllText/);
  const installBundle = source.match(/function Invoke-InstallMachineBundle\(\$Request\) \{[\s\S]*?\n\}\n\nfunction Get-TrustedWslPath/)?.[0];
  assert.match(installBundle, /Write-MachineLease \$machineRoot \$Request/);
  assert.doesNotMatch(installBundle, /WriteAllText\(\(Join-Path \$machineRoot "lease\.json"\)/);
});

test("native Windows state storage hardens and inspects every path without command strings", () => {
  const { createWindowsSecureStateStore } = require(windowsPlatformPath);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "rainskills-windows-acl-"));
  const aclByPath = new Map();
  const calls = [];
  const runner = (command, args) => {
    calls.push({ command, args: [...args] });
    if (path.win32.basename(command).toLowerCase() === "whoami.exe") {
      return { status: 0, stdout: `"DESKTOP\\user","${USER_SID}"\r\n`, stderr: "" };
    }
    const valueAfter = (name) => args[args.indexOf(name) + 1];
    const action = valueAfter("-Action");
    const targetPath = valueAfter("-TargetPath");
    if (action === "ProtectState") {
      aclByPath.set(path.resolve(targetPath), {
        ownerSid: USER_SID,
        writableSids: [USER_SID, "S-1-5-18", "S-1-5-32-544"],
        readableSids: [USER_SID, "S-1-5-18", "S-1-5-32-544"],
        reparsePoint: false,
      });
      return { status: 0, stdout: "", stderr: "" };
    }
    if (action === "InspectState") {
      return { status: 0, stdout: JSON.stringify(aclByPath.get(path.resolve(targetPath))), stderr: "" };
    }
    assert.fail(`unexpected action ${action}`);
  };
  const stateStore = createWindowsSecureStateStore({ home, runner });
  const statePath = path.join(home, ".rainbond", "state.json");
  stateStore.atomicWriteJson(statePath, { ok: true });
  assert.deepEqual(stateStore.readProtectedJson(statePath), { ok: true });
  assert(calls.some((call) => call.args.includes("ProtectState")));
  assert(calls.some((call) => call.args.includes("InspectState")));
  for (const call of calls) assert(!call.args.includes("-Command"));
  const helperSource = fs.readFileSync(powershellPath, "utf8");
  assert.match(helperSource, /readableSids/);
  assert.match(helperSource, /ReadData|ReadAndExecute|GenericRead/);
  assert.match(helperSource, /fileIdentity/);
  assert.match(helperSource, /SHA256|ComputeHash/);
  assert.match(helperSource, /CreateFileW/);
  assert.match(helperSource, /FILE_FLAG_OPEN_REPARSE_POINT/);
  assert.match(helperSource, /GetFileInformationByHandle/);
  assert.match(helperSource, /GetSecurityInfo/);
  assert.match(helperSource, /SafeFileHandle/);
  const sourceInspector = helperSource.match(/public static SourceFileFacts Inspect[\s\S]*?\n  \}/)?.[0];
  assert(sourceInspector, "InspectSourceFile must use a fixed Win32 handle inspector");
  assert.match(sourceInspector, /CreateFileW[\s\S]*GetFileInformationByHandle[\s\S]*GetSecurityInfo[\s\S]*FileStream[\s\S]*ComputeHash/);
  assert.doesNotMatch(sourceInspector, /Get-Item|Get-StateAcl|GetAccessControl/);
  const inspectAction = helperSource.match(/if \(\$Action -eq "InspectState"[\s\S]*?exit 0/)?.[0];
  assert.match(inspectAction, /InspectSourceFile[\s\S]*SourceFileInspector\]::Inspect/);
});

test("Windows stages advance only in order with fresh matching evidence", () => {
  const { validateWindowsStageTransition } = require(windowsPlatformPath);
  const observedAt = new Date().toISOString();
  const base = { installationId: INSTALLATION_ID, observedAt };
  const transitions = [
    ["target-selection", "preflight", { ...base, targetKind: "local-windows" }],
    ["preflight", "awaiting-confirmation", { ...base, preflightPassed: true }],
    ["awaiting-confirmation", "enabling-wsl", { ...base, confirmed: true, refreshedPreflightPassed: true }],
    ["enabling-wsl", "reboot-required", { ...base, rebootPending: true, recoveryTasksVerified: true }],
    ["reboot-required", "downloading-rootfs", { ...base, rebootPending: false, wslVerified: true, wslDefaultVersion: 2 }],
    ["downloading-rootfs", "importing-distro", { ...base, rootfsArtifactReady: true }],
    ["importing-distro", "preparing-runtime", { ...base, distroIdentityVerified: true }],
    ["preparing-runtime", "installing-rainbond", { ...base, systemdReady: true, networkGateReady: true, dockerReady: true }],
    ["installing-rainbond", "configuring-windows-access", { ...base, rainbondRuntimeVerified: true }],
    ["configuring-windows-access", "verifying", { ...base, networkManifestVerified: true, portproxyVerified: true }],
    ["verifying", "platform-ready", { ...base, wslHealthVerified: true, windowsHealthVerified: true }],
    ["platform-ready", "authorizing", { ...base, consoleReachable: true }],
    ["authorizing", "configured", { ...base, clientsConfigured: true, mcpVerified: true }],
  ];
  for (const [from, to, facts] of transitions) {
    assert.doesNotThrow(() => validateWindowsStageTransition({
      from,
      to,
      facts,
      expectedInstallationId: INSTALLATION_ID,
    }), `${from} -> ${to}`);
  }
  assert.throws(() => validateWindowsStageTransition({
    from: "preflight",
    to: "enabling-wsl",
    facts: { ...base, confirmed: true },
    expectedInstallationId: INSTALLATION_ID,
  }), /阶段/);
  assert.throws(() => validateWindowsStageTransition({
    from: "preflight",
    to: "awaiting-confirmation",
    facts: { ...base, installationId: crypto.randomUUID(), preflightPassed: true },
    expectedInstallationId: INSTALLATION_ID,
  }), /installation_id/);
  assert.throws(() => validateWindowsStageTransition({
    from: "preflight",
    to: "awaiting-confirmation",
    facts: { ...base, observedAt: "2020-01-01T00:00:00.000Z", preflightPassed: true },
    expectedInstallationId: INSTALLATION_ID,
  }), /过期/);
});

test("machine actions are fixed and reboot requires an interactive explicit confirmation", async () => {
  const {
    FIXED_ACTIONS,
    MACHINE_ACTIONS,
    USER_ACTIONS,
    createWindowsPlatformAdapter,
  } = require(windowsPlatformPath);
  assert.deepEqual(MACHINE_ACTIONS, [
    "PrepareWsl",
    "ProvisionRainbond",
    "ConvergeInstalledPlatform",
    "InstallMachineBundle",
    "EnableWsl",
    "UpdateWsl",
    "VerifyWsl",
    "RegisterResume",
    "RegisterFinalize",
    "RequestReboot",
    "Finalize",
    "ImportDistro",
    "PrepareRuntime",
    "ConfigureNetwork",
    "VerifyNetwork",
    "PrepareDocker",
    "InstallRainbond",
    "VerifyDeployment",
  ]);
  assert.deepEqual(USER_ACTIONS, ["Preflight"]);
  assert.equal(new Set(FIXED_ACTIONS).size, FIXED_ACTIONS.length);
  assert(Object.isFrozen(MACHINE_ACTIONS));
  assert(Object.isFrozen(USER_ACTIONS));

  const fixture = createFixture();
  const adapter = createWindowsPlatformAdapter({
    runner: fixture.runner,
    stateStore: fixture.stateStore,
    policy,
    userSid: USER_SID,
    home: fixture.home,
  });
  const before = fixture.calls.length;
  await assert.rejects(adapter.requestReboot({
    operationId: OPERATION_ID,
    installationId: INSTALLATION_ID,
    interactive: false,
    confirmed: true,
  }), /交互终端/);
  await assert.rejects(adapter.requestReboot({
    operationId: OPERATION_ID,
    installationId: INSTALLATION_ID,
    interactive: true,
    confirmed: false,
  }), /明确确认/);
  assert.equal(fixture.calls.length, before);

  await adapter.enableWsl({
    operationId: OPERATION_ID,
    installationId: INSTALLATION_ID,
    payload: { machine_bundle_verified: true },
  });
  const machineCall = fixture.calls.at(-1);
  const machineRequest = fixture.requests.at(-1).request;
  assert.equal(machineCall.args[machineCall.args.indexOf("-Action") + 1], "EnableWsl");
  assert.equal(machineRequest.action, "EnableWsl");
  assert.deepEqual(machineRequest.payload, { machine_bundle_verified: true });
  assert(!JSON.stringify(machineRequest).includes('"command"'));
  assert(!JSON.stringify(machineRequest).includes('"script"'));

  await adapter.prepareWsl({
    operationId: OPERATION_ID,
    installationId: INSTALLATION_ID,
    payload: { helper_path: "/tmp/windows-platform.ps1" },
  });
  assert.equal(fixture.requests.at(-1).request.action, "PrepareWsl");
  await adapter.provisionRainbond({
    operationId: OPERATION_ID,
    installationId: INSTALLATION_ID,
    payload: { rootfs_path: "/tmp/rootfs.tar.gz" },
  });
  assert.equal(fixture.requests.at(-1).request.action, "ProvisionRainbond");
  await adapter.convergeInstalledPlatform({
    operationId: OPERATION_ID,
    installationId: INSTALLATION_ID,
    payload: { subnet: "172.31.253.0/30" },
  });
  assert.equal(fixture.requests.at(-1).request.action, "ConvergeInstalledPlatform");
});

test("installed-platform convergence is exposed only through fixed Windows and WSL actions", () => {
  const powershell = readNormalizedSource(powershellPath);
  const bootstrap = readNormalizedSource(wslBootstrapPath);
  const validateSet = powershell.match(/\[ValidateSet\([^\n]+\)\]/)?.[0];
  const machineAllowlist = powershell.match(/\$machineActions = @\([^\n]+\)/)?.[0];
  const dispatch = powershell.match(/switch \(\$Action\) \{[\s\S]*?default \{ throw "Unsupported fixed action" \}\n  \}/)?.[0];
  assert(validateSet, "PowerShell action validation must remain fixed");
  assert(machineAllowlist, "PowerShell elevated machine allowlist must remain explicit");
  assert(dispatch, "PowerShell fixed-action dispatch must remain explicit");
  assert.match(validateSet, /"ConvergeInstalledPlatform"/);
  assert.match(machineAllowlist, /"ConvergeInstalledPlatform"/);
  assert.match(dispatch, /"ConvergeInstalledPlatform" \{ \$facts = Invoke-ConvergeInstalledPlatform \$request \}/);
  assert.match(bootstrap, /PrepareRuntime\|ConfigureGuestNetwork\|PrepareDocker\|InstallRainbond\|VerifyRainbond\|ProbeRainbond\|ConvergeInstalledRainbond/);
  assert.match(bootstrap, /ConvergeInstalledRainbond\)\n    converge_installed_rainbond/);
});

test("Windows adapter reports the elevated action's structured failure", async () => {
  const { createWindowsPlatformAdapter } = require(windowsPlatformPath);
  const fixture = createFixture();
  const runner = async (command, args) => {
    const valueAfter = (name) => args[args.indexOf(name) + 1];
    const requestPath = valueAfter("-RequestPath");
    const resultPath = valueAfter("-ResultPath");
    const request = fixture.stateStore.readProtectedJson(requestPath);
    fixture.stateStore.atomicWriteJson(resultPath, {
      schema: "rainskills.windows-result.v1",
      action: request.action,
      operation_id: request.operation_id,
      installation_id: request.installation_id,
      nonce: request.nonce,
      status: "error",
      facts: {
        failedAction: "PrepareWsl",
        failureMessage: "WSL --version is unavailable before the runtime update",
      },
    });
    return { status: 1, stdout: "", stderr: "Elevated Windows helper failed with exit code 1" };
  };
  const adapter = createWindowsPlatformAdapter({
    runner,
    stateStore: fixture.stateStore,
    policy,
    userSid: USER_SID,
    home: fixture.home,
  });

  await assert.rejects(adapter.prepareWsl({
    operationId: OPERATION_ID,
    installationId: INSTALLATION_ID,
    payload: {},
  }), /PrepareWsl.*WSL --version is unavailable/);
});

test("Windows adapter reports a helper timeout as a timeout", async () => {
  const { createWindowsPlatformAdapter } = require(windowsPlatformPath);
  const fixture = createFixture();
  const timeout = Object.assign(new Error("spawnSync powershell.exe ETIMEDOUT"), { code: "ETIMEDOUT" });
  const adapter = createWindowsPlatformAdapter({
    runner: () => ({ status: null, stdout: "", stderr: "", error: timeout }),
    stateStore: fixture.stateStore,
    policy,
    userSid: USER_SID,
    home: fixture.home,
  });

  await assert.rejects(adapter.preflight({
    operationId: OPERATION_ID,
    installationId: INSTALLATION_ID,
  }), /Windows Preflight 等待超时/);
});

test("PowerShell machine actions enforce UAC, signed WSL setup, protected tasks, and fixed reboot", () => {
  const source = readNormalizedSource(powershellPath);
  assert.match(source, /InstallMachineBundle/);
  assert.match(source, /Enable-WindowsOptionalFeature[\s\S]*-NoRestart/);
  assert.match(source, /--update[\s\S]*--web-download/);
  assert.match(source, /Get-AuthenticodeSignature/);
  assert.match(source, /Microsoft/);
  assert.match(source, /ProgramData/);
  assert.match(source, /New-ScheduledTaskPrincipal/);
  assert.match(source, /Interactive/);
  assert.match(source, /RunLevel[\s\S]*Highest/);
  assert.match(source, /Start-Process[\s\S]*-Verb[\s\S]*RunAs/);
  assert.match(source, /Restart-Computer/);
  assert.match(source, /function Invoke-PrepareWsl[\s\S]*Invoke-InstallMachineBundle[\s\S]*Invoke-EnableWsl/);
  assert.match(source, /function Invoke-ProvisionRainbond[\s\S]*Invoke-ImportDistro[\s\S]*Invoke-ConfigureNetwork[\s\S]*Invoke-PrepareDocker[\s\S]*Invoke-InstallRainbond[\s\S]*Invoke-VerifyDeployment/);
  assert.match(source, /control_mode[\s\S]*wsl/);
  assert.match(source, /wslExecutable[\s\S]*wsl\.exe/);
  assert.match(source, /New-ScheduledTaskAction[\s\S]*-Execute \$wslExecutable/);
  assert.match(source, /--exec/);
  assert.doesNotMatch(source, /Assert-FileDigest \$rootfsPath/);
  assert.doesNotMatch(source, /\$gzipFirst|\$gzipSecond|Ubuntu rootfs is not a gzip file/);
  assert.doesNotMatch(source, /Invoke-Expression/);
});

test("recovery bundle is explicit, digest-verified, and independent of the package cache", () => {
  const { createRecoveryBundle, verifyRecoveryBundle } = require(windowsPlatformPath);
  const packageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rainskills-package-"));
  const bundleRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rainskills-recovery-parent-"));
  fs.mkdirSync(path.join(packageRoot, "bin"), { recursive: true });
  fs.mkdirSync(path.join(packageRoot, "rainbond-demo", "scripts"), { recursive: true });
  fs.writeFileSync(path.join(packageRoot, "package.json"), "{}\n");
  fs.writeFileSync(path.join(packageRoot, "install.sh"), "#!/bin/sh\n");
  fs.writeFileSync(path.join(packageRoot, "bin", "rainskills.js"), "#!/usr/bin/env node\n");
  fs.writeFileSync(path.join(packageRoot, "rainbond-demo", "SKILL.md"), "---\nname: demo\ndescription: demo\n---\n");
  fs.writeFileSync(path.join(packageRoot, "rainbond-demo", "scripts", "resume.js"), "module.exports = true;\n");

  const destination = path.join(bundleRoot, "recovery");
  const manifest = createRecoveryBundle({
    packageRoot,
    bundleRoot: destination,
    packageVersion: "0.1.0-rc.41",
    requiredFiles: ["package.json", "install.sh", "bin/rainskills.js"],
    requiredDirectories: ["rainbond-demo"],
  });
  fs.rmSync(packageRoot, { recursive: true });
  assert.equal(verifyRecoveryBundle(destination, manifest).ok, true);
  assert.equal(manifest.version, 2);
  assert.equal(manifest.package_version, "0.1.0-rc.41");
  assert(manifest.files.every((entry) => /^[a-f0-9]{64}$/.test(entry.sha256)));
  assert.deepEqual(manifest.files.map((entry) => entry.path), [...manifest.files.map((entry) => entry.path)].sort());
  const badBundleParent = fs.mkdtempSync(path.join(os.tmpdir(), "rainskills-bad-recovery-"));
  assert.throws(() => createRecoveryBundle({
    packageRoot: bundleRoot,
    bundleRoot: path.join(badBundleParent, "bad"),
    packageVersion: "0.1.0-rc.41",
    requiredFiles: ["../escape"],
    requiredDirectories: [],
  }), /相对路径|越界/);
});

test("recovery verification accepts legacy v1 manifests only for upgrade compatibility", () => {
  const { verifyRecoveryBundle } = require(windowsPlatformPath);
  const bundleRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rainskills-legacy-recovery-"));
  const relative = "bin/rainskills.js";
  const content = "#!/usr/bin/env node\n";
  fs.mkdirSync(path.join(bundleRoot, "bin"), { recursive: true });
  fs.writeFileSync(path.join(bundleRoot, relative), content);
  const legacyManifest = {
    schema: "rainskills.windows-recovery-bundle.v1",
    version: 1,
    files: [{
      path: relative,
      sha256: crypto.createHash("sha256").update(content).digest("hex"),
      size: Buffer.byteLength(content),
    }],
  };
  fs.writeFileSync(path.join(bundleRoot, "manifest.json"), `${JSON.stringify(legacyManifest, null, 2)}\n`);

  assert.equal(verifyRecoveryBundle(bundleRoot).manifest.version, 1);
  assert.throws(
    () => verifyRecoveryBundle(bundleRoot, { ...legacyManifest, version: 2 }),
    /package version|版本/i
  );
});

test("Windows rootfs delegates archive validation to WSL import without inspecting the file header", async () => {
  const { ensureRootfsArtifact } = require(windowsPlatformPath);
  assert.equal(typeof ensureRootfsArtifact, "function");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rainskills-rootfs-unpinned-"));
  const destination = path.join(root, "ubuntu-rootfs.tar.gz");
  const downloaded = Buffer.from("downloaded-rootfs-is-validated-by-wsl-import");

  const result = await ensureRootfsArtifact({
    destination,
    urls: policy.windows.ubuntu_rootfs.urls.slice(0, 1),
    maximumBytes: policy.windows.ubuntu_rootfs.max_bytes,
    allowedOrigins: policy.windows.preflight_allowed_origins,
    download: async ({ partialPath, url }) => {
      fs.writeFileSync(partialPath, downloaded);
      return { finalUrl: url, bytes: downloaded.length };
    },
  });

  assert.equal(result.reused, false);
  assert.equal(result.bytes, downloaded.length);
  assert.deepEqual(fs.readFileSync(destination), downloaded);
});

test("Windows rootfs replaces cache contaminated by legacy progress JSON", async () => {
  const { ensureRootfsArtifact } = require(windowsPlatformPath);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rainskills-rootfs-progress-"));
  const destination = path.join(root, "ubuntu-rootfs.tar.gz");
  fs.writeFileSync(destination, Buffer.concat([
    Buffer.from('{"schema":"rainskills.platform-progress.v1","sequence":1}\n'),
    Buffer.from([0x1f, 0x8b, 0x08, 0x00]),
  ]));
  const downloaded = Buffer.from("clean-rootfs-delegated-to-wsl");
  let downloads = 0;

  const result = await ensureRootfsArtifact({
    destination,
    urls: policy.windows.ubuntu_rootfs.urls.slice(0, 1),
    maximumBytes: policy.windows.ubuntu_rootfs.max_bytes,
    allowedOrigins: policy.windows.preflight_allowed_origins,
    download: async ({ partialPath, url }) => {
      downloads += 1;
      fs.writeFileSync(partialPath, downloaded);
      return { finalUrl: url, bytes: downloaded.length };
    },
  });

  assert.equal(result.reused, false);
  assert.equal(downloads, 1);
  assert.deepEqual(fs.readFileSync(destination), downloaded);
});

test("pinned rootfs artifacts are reused only after digest verification", async () => {
  const { ensurePinnedArtifact } = require(windowsPlatformPath);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rainskills-rootfs-"));
  const destination = path.join(root, "ubuntu-rootfs.tar.gz");
  const expectedBytes = Buffer.from("verified-rootfs");
  const expectedDigest = crypto.createHash("sha256").update(expectedBytes).digest("hex");
  let downloads = 0;
  const download = async ({ partialPath, onProgress }) => {
    downloads += 1;
    fs.writeFileSync(partialPath, expectedBytes);
    onProgress?.({ current: expectedBytes.length, total: expectedBytes.length });
    return { finalUrl: policy.windows.ubuntu_rootfs.urls[0], bytes: expectedBytes.length };
  };

  const first = await ensurePinnedArtifact({
    destination,
    urls: policy.windows.ubuntu_rootfs.urls,
    expectedBytes: expectedBytes.length,
    sha256: expectedDigest,
    allowedOrigins: policy.windows.preflight_allowed_origins,
    download,
  });
  const second = await ensurePinnedArtifact({
    destination,
    urls: policy.windows.ubuntu_rootfs.urls,
    expectedBytes: expectedBytes.length,
    sha256: expectedDigest,
    allowedOrigins: policy.windows.preflight_allowed_origins,
    download,
  });
  assert.equal(first.reused, false);
  assert.equal(second.reused, true);
  assert.equal(downloads, 1);

  fs.writeFileSync(destination, "tampered");
  await ensurePinnedArtifact({
    destination,
    urls: policy.windows.ubuntu_rootfs.urls,
    expectedBytes: expectedBytes.length,
    sha256: expectedDigest,
    allowedOrigins: policy.windows.preflight_allowed_origins,
    download,
  });
  assert.equal(downloads, 2);
  assert(fs.readdirSync(root).some((name) => name.startsWith("ubuntu-rootfs.tar.gz.invalid-")));
});

test("pinned rootfs artifacts must match the published byte size", async () => {
  const { ensurePinnedArtifact } = require(windowsPlatformPath);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rainskills-rootfs-size-"));
  const destination = path.join(root, "ubuntu-rootfs.tar.gz");
  const artifact = Buffer.from("verified-rootfs");
  const expectedDigest = crypto.createHash("sha256").update(artifact).digest("hex");
  let downloads = 0;

  await assert.rejects(ensurePinnedArtifact({
    destination,
    urls: policy.windows.ubuntu_rootfs.urls.slice(0, 2),
    expectedBytes: artifact.length + 1,
    sha256: expectedDigest,
    allowedOrigins: policy.windows.preflight_allowed_origins,
    download: async ({ partialPath }) => {
      downloads += 1;
      fs.writeFileSync(partialPath, artifact);
      return { finalUrl: policy.windows.ubuntu_rootfs.urls[downloads - 1], bytes: artifact.length };
    },
  }), /实际 15 bytes.*期望 16 bytes/);

  assert.equal(downloads, 2);
});

test("pinned rootfs removes appended bytes only when the fixed prefix digest matches", async () => {
  const { ensurePinnedArtifact } = require(windowsPlatformPath);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rainskills-rootfs-appended-"));
  const destination = path.join(root, "ubuntu-rootfs.tar.gz");
  const artifact = Buffer.from("verified-rootfs");
  const appended = Buffer.from("unexpected-trailer");
  const expectedDigest = crypto.createHash("sha256").update(artifact).digest("hex");

  const result = await ensurePinnedArtifact({
    destination,
    urls: policy.windows.ubuntu_rootfs.urls.slice(0, 1),
    expectedBytes: artifact.length,
    sha256: expectedDigest,
    allowedOrigins: policy.windows.preflight_allowed_origins,
    download: async ({ partialPath }) => {
      fs.writeFileSync(partialPath, Buffer.concat([artifact, appended]));
      throw new Error("下载源发送的数据超过固定版本大小");
    },
  });

  assert.equal(result.reused, false);
  assert.equal(result.trimmedBytes, appended.length);
  assert.equal(fs.readFileSync(destination, "utf8"), artifact.toString("utf8"));
  assert.equal(fs.statSync(destination).size, artifact.length);
});

test("pinned rootfs rejects an oversized file whose fixed prefix digest differs", async () => {
  const { ensurePinnedArtifact } = require(windowsPlatformPath);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rainskills-rootfs-bad-prefix-"));
  const destination = path.join(root, "ubuntu-rootfs.tar.gz");
  const artifact = Buffer.from("verified-rootfs");
  const expectedDigest = crypto.createHash("sha256").update(artifact).digest("hex");

  await assert.rejects(ensurePinnedArtifact({
    destination,
    urls: policy.windows.ubuntu_rootfs.urls.slice(0, 1),
    expectedBytes: artifact.length,
    sha256: expectedDigest,
    allowedOrigins: policy.windows.preflight_allowed_origins,
    download: async ({ partialPath }) => {
      fs.writeFileSync(partialPath, Buffer.concat([Buffer.alloc(artifact.length, 0x78), Buffer.from("trailer")]));
      throw new Error("下载源发送的数据超过固定版本大小");
    },
  }), /SHA-256 校验失败/);

  assert.equal(fs.existsSync(destination), false);
});

test("pinned rootfs gives every source an isolated partial file", async () => {
  const { ensurePinnedArtifact } = require(windowsPlatformPath);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rainskills-rootfs-isolated-"));
  const destination = path.join(root, "ubuntu-rootfs.tar.gz");
  const legacyPartial = `${destination}.partial`;
  const artifact = Buffer.from("verified-rootfs");
  const expectedDigest = crypto.createHash("sha256").update(artifact).digest("hex");
  const partialPaths = [];
  fs.writeFileSync(legacyPartial, "legacy-concurrent-writer");

  const result = await ensurePinnedArtifact({
    destination,
    urls: policy.windows.ubuntu_rootfs.urls.slice(0, 2),
    expectedBytes: artifact.length,
    sha256: expectedDigest,
    allowedOrigins: policy.windows.preflight_allowed_origins,
    download: async ({ partialPath, url }) => {
      partialPaths.push(partialPath);
      fs.writeFileSync(partialPath, partialPaths.length === 1 ? Buffer.alloc(artifact.length, 0x78) : artifact);
      return { finalUrl: url, bytes: artifact.length };
    },
  });

  assert.equal(result.reused, false);
  assert.equal(partialPaths.length, 2);
  assert.notEqual(partialPaths[0], legacyPartial);
  assert.notEqual(partialPaths[1], legacyPartial);
  assert.notEqual(partialPaths[0], partialPaths[1]);
  assert.equal(fs.readFileSync(destination, "utf8"), artifact.toString("utf8"));
});

test("rootfs resume accepts only a matching Content-Range", () => {
  const { resolveArtifactDownloadResponse } = require(windowsPlatformPath);
  assert.equal(typeof resolveArtifactDownloadResponse, "function");
  assert.deepEqual(resolveArtifactDownloadResponse({
    statusCode: 206,
    headers: {
      "content-length": "341119807",
      "content-range": "bytes 11156-341130962/341130963",
    },
    existingBytes: 11156,
  }), {
    append: true,
    startingBytes: 11156,
    total: 341130963,
  });
  assert.throws(() => resolveArtifactDownloadResponse({
    statusCode: 206,
    headers: {
      "content-length": "341130963",
      "content-range": "bytes 0-341130962/341130963",
    },
    existingBytes: 11156,
  }), /断点续传响应与本地缓存不匹配/);
  assert.throws(() => resolveArtifactDownloadResponse({
    statusCode: 200,
    headers: { "content-length": "341130962" },
    existingBytes: 0,
    expectedBytes: 341130963,
  }), /文件大小与固定版本不匹配/);
});

test("rootfs byte limiter stops a source that sends more than the pinned size", async () => {
  const { createArtifactByteLimiter } = require(windowsPlatformPath);
  assert.equal(typeof createArtifactByteLimiter, "function");
  const limiter = createArtifactByteLimiter({ startingBytes: 2, expectedBytes: 5 });
  const output = [];
  const sink = new Writable({
    write(chunk, encoding, callback) {
      output.push(chunk);
      callback();
    },
  });

  await assert.rejects(pipeline(
    Readable.from([Buffer.from("abc"), Buffer.from("x")]),
    limiter,
    sink
  ), /超过固定版本大小/);
  assert.equal(Buffer.concat(output).toString("utf8"), "abc");
});

test("pinned rootfs switches sources after a checksum failure with a fresh partial", async () => {
  const { ensurePinnedArtifact } = require(windowsPlatformPath);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rainskills-rootfs-retry-"));
  const destination = path.join(root, "ubuntu-rootfs.tar.gz");
  const expectedBytes = Buffer.from("verified-rootfs");
  const expectedDigest = crypto.createHash("sha256").update(expectedBytes).digest("hex");
  let downloads = 0;
  const retries = [];
  const requestedUrls = [];
  const partialPaths = [];
  const download = async ({ partialPath: currentPartial, url }) => {
    downloads += 1;
    requestedUrls.push(url);
    partialPaths.push(currentPartial);
    if (downloads === 1) {
      fs.writeFileSync(currentPartial, Buffer.alloc(expectedBytes.length, 0x78));
    } else {
      assert.equal(fs.existsSync(currentPartial), false);
      fs.writeFileSync(currentPartial, expectedBytes);
    }
    return { finalUrl: url, bytes: fs.statSync(currentPartial).size };
  };

  const result = await ensurePinnedArtifact({
    destination,
    urls: policy.windows.ubuntu_rootfs.urls.slice(0, 2),
    expectedBytes: expectedBytes.length,
    sha256: expectedDigest,
    allowedOrigins: policy.windows.preflight_allowed_origins,
    download,
    onRetry: (details) => retries.push(details),
  });

  assert.equal(result.reused, false);
  assert.equal(downloads, 2);
  assert.deepEqual(requestedUrls, policy.windows.ubuntu_rootfs.urls.slice(0, 2));
  assert.notEqual(partialPaths[0], partialPaths[1]);
  assert.equal(retries.length, 1);
  assert.equal(retries[0].expectedSha256, expectedDigest);
  assert.equal(retries[0].actualBytes, expectedBytes.length);
  assert.match(retries[0].actualSha256, /^[a-f0-9]{64}$/);
  assert.equal(fs.readFileSync(destination, "utf8"), expectedBytes.toString("utf8"));
  assert(fs.readdirSync(root).some((name) => name.includes(".partial.") && name.includes(".invalid-")));
});

test("artifact redirects and managed subnets reject untrusted or overlapping networks", () => {
  const {
    selectManagedSubnet,
    validateArtifactRedirect,
  } = require(windowsPlatformPath);
  assert.equal(
    validateArtifactRedirect(
      policy.windows.ubuntu_rootfs.urls[0],
      "https://cloud-images.ubuntu.com/wsl/jammy/rootfs.tar.gz",
      policy.windows.preflight_allowed_origins
    ),
    true
  );
  assert.throws(() => validateArtifactRedirect(
    policy.windows.ubuntu_rootfs.urls[0],
    "https://downloads.example/rootfs.tar.gz",
    policy.windows.preflight_allowed_origins
  ), /跳转来源/);

  const selected = selectManagedSubnet([
    "172.31.255.0/24",
    "172.31.254.0/30",
    "10.0.0.0/8",
    "192.168.0.0/16",
  ]);
  assert.equal(selected.cidr, "172.31.253.0/30");
  assert.equal(selected.hostAddress, "172.31.253.1");
  assert.equal(selected.guestAddress, "172.31.253.2");
  assert.throws(() => selectManagedSubnet(["0.0.0.0/1", "128.0.0.0/1"]), /可用.*\/30/);
});

test("Windows distro and network actions are fixed to Rainbond ownership and loopback access", () => {
  const source = readNormalizedSource(powershellPath);
  assert.match(source, /--import[\s\S]*Rainbond[\s\S]*--version[\s\S]*2/);
  assert.match(source, /rainskills-installation-id/);
  assert.match(source, /--terminate/);
  assert.match(source, /PID 1[\s\S]*systemd|systemd[\s\S]*PID 1/i);
  assert.match(source, /wslpath[\s\S]*-u/);
  assert.match(source, /networkingMode[\s\S]*nat/i);
  assert.match(source, /127\.0\.0\.1/);
  assert.match(source, /portproxy/);
  assert.match(source, /managed-network\.json/);
  assert.doesNotMatch(source, /(?:Set-Content|WriteAllText)[^\n]*\.wslconfig/);
});

test("PowerShell removes only obsolete portproxy rules recorded by the verified manifest", () => {
  const source = readNormalizedSource(powershellPath);
  const configureNetwork = source.match(/function Invoke-ConfigureNetwork\(\$Request\) \{[\s\S]*?\n\}\n\nfunction Invoke-VerifyNetwork/)?.[0];
  assert(configureNetwork, "Invoke-ConfigureNetwork must remain a standalone fixed action");
  assert(configureNetwork.indexOf("Assert-NetworkManifestDigest") < configureNetwork.indexOf("obsoletePortProxies"));
  assert.match(configureNetwork, /\$existing\.portproxy/);
  assert.match(configureNetwork, /obsoletePortProxies[\s\S]*listenAddress[\s\S]*connectAddress[\s\S]*guestAddress/);
  assert.match(configureNetwork, /portproxy delete v4tov4/);
});

test("PowerShell resolves the WSL adapter from the managed distro default gateway", () => {
  const source = readNormalizedSource(powershellPath);
  const getAdapter = source.match(/function Get-WslAdapter \{[\s\S]*?\n\}\n\nfunction Get-WslHnsNetworkId/)?.[0];
  assert(getAdapter, "Get-WslAdapter must remain a standalone fixed probe");
  assert.match(getAdapter, /Invoke-NativeCapture \$wslPath/);
  assert.match(getAdapter, /--exec[\s\S]*ip[\s\S]*-4[\s\S]*route[\s\S]*show[\s\S]*default/);
  assert.match(getAdapter, /Get-NetIPAddress[\s\S]*-IPAddress \$gateway/);
  assert.match(getAdapter, /Get-NetAdapter[\s\S]*-InterfaceIndex/);
  assert.doesNotMatch(getAdapter, /Get-NetAdapter\s+-IncludeHidden/);
  assert.doesNotMatch(getAdapter, /Unable to identify exactly one active WSL NAT adapter/);
});

test("PowerShell passes Windows paths to wslpath without a Linux shell", () => {
  const source = readNormalizedSource(powershellPath);
  const convertPath = source.match(/function Convert-WindowsPathForDistro\(\[string\]\$WindowsPath\) \{[\s\S]*?\n\}\n\nfunction Invoke-DistroBootstrap/)?.[0];
  assert(convertPath, "Convert-WindowsPathForDistro must remain a standalone fixed helper");
  assert.match(convertPath, /--exec\s+wslpath\s+-u\s+\$WindowsPath/);
  assert.doesNotMatch(convertPath, /-u\s+root\s+--\s+wslpath/);
});

test("PowerShell rolls back a distro when first-run bootstrap fails", () => {
  const source = readNormalizedSource(powershellPath);
  const importDistro = source.match(/function Invoke-ImportDistro\(\$Request\) \{[\s\S]*?\n\}\n\nfunction Invoke-PrepareRuntime/)?.[0];
  assert(importDistro, "Invoke-ImportDistro must remain a standalone fixed action");
  assert.match(importDistro, /Invoke-DistroBootstrap[\s\S]*catch[\s\S]*--unregister[\s\S]*Rainbond/);
  assert.match(importDistro, /--unregister[\s\S]*Remove-Item -LiteralPath \$distroRoot/);
});

test("PowerShell refreshes the WSL runtime when resuming an existing managed distro", () => {
  const source = readNormalizedSource(powershellPath);
  const importDistro = source.match(/function Invoke-ImportDistro\(\$Request\) \{[\s\S]*?\n\}\n\nfunction Invoke-PrepareRuntime/)?.[0];
  assert(importDistro, "Invoke-ImportDistro must remain a standalone fixed action");
  const existingDistro = importDistro.match(/if \(\$distroNames -contains "Rainbond"\) \{[\s\S]*?\n  \} else \{/)?.[0];
  assert(existingDistro, "existing managed distro branch must remain explicit");
  assert.match(existingDistro, /Invoke-DistroBootstrap \$Request "PrepareRuntime"/);
});

test("PowerShell checks systemd without terminal-dependent ps output", () => {
  const source = readNormalizedSource(powershellPath);
  const assertSystemd = source.match(/function Assert-SystemdPidOne\(\$Request\) \{[\s\S]*?\n\}\n\nfunction Invoke-ImportDistro/)?.[0];
  assert(assertSystemd, "Assert-SystemdPidOne must remain a standalone fixed probe");
  assert.match(assertSystemd, /Invoke-NativeCapture \$wslPath/);
  assert.match(assertSystemd, /--exec[\s\S]*cat[\s\S]*\/proc\/1\/comm/);
  assert.doesNotMatch(assertSystemd, /\bps\s+-p\s+1\b/);
});

test("WSL bootstrap enables systemd and gates runtime startup on the fixed network", () => {
  const source = readNormalizedSource(wslBootstrapPath);
  assert.match(source, /^#!\/usr\/bin\/env bash/);
  assert.match(source, /PrepareRuntime/);
  assert.match(source, /ConfigureGuestNetwork/);
  assert.match(source, /\[boot\][\s\S]*systemd=true/);
  assert.match(source, /rainskills-network-ready\.service/);
  assert.match(source, /Before=docker\.service/);
  assert.match(source, /ConditionPathExists/);
  assert.match(source, /rainskills-installation-id/);
  assert.doesNotMatch(source, /eval\s/);
});

test("WSL network gate restores persistent addresses on every distro boot", () => {
  const source = readNormalizedSource(wslBootstrapPath);
  const installHelpers = source.match(/install_network_helpers\(\) \{[\s\S]*?\n\}\n\nprepare_runtime\(\)/)?.[0];
  const prepareRuntime = source.match(/prepare_runtime\(\) \{[\s\S]*?\n\}\n\nconfigure_guest_network\(\)/)?.[0];
  const configureNetwork = source.match(/configure_guest_network\(\) \{[\s\S]*?\n\}\n\nverify_installer\(\)/)?.[0];
  assert(installHelpers, "network helper and unit installation must remain reusable");
  assert(prepareRuntime, "prepare_runtime must remain a standalone fixed action");
  assert(configureNetwork, "configure_guest_network must remain a standalone fixed action");
  assert.match(prepareRuntime, /install_network_helpers/);
  assert.match(installHelpers, /\/usr\/local\/libexec\/rainskills-restore-network/);
  assert.match(installHelpers, /ExecStart=\/usr\/local\/libexec\/rainskills-restore-network/);
  assert.doesNotMatch(installHelpers, /until test -f \/run\/rainskills\/network-ready/);
  const restoreHelper = installHelpers.match(/<<'SCRIPT'\n([\s\S]*?)\nSCRIPT/)?.[1];
  assert(restoreHelper, "the fixed network restore helper must be embedded verbatim");
  const syntax = spawnSync("bash", ["-n"], { input: restoreHelper, encoding: "utf8" });
  assert.equal(syntax.status, 0, syntax.stderr);
  assert.match(configureNetwork, /host-address/);
  assert.match(configureNetwork, /guest-address/);
  assert.match(configureNetwork, /systemctl is-active --quiet rainskills-network-ready\.service/);
  assert.match(configureNetwork, /"\$RESTORE_NETWORK_HELPER"/);
  assert.match(configureNetwork, /systemctl start rainskills-network-ready\.service/);
  assert.doesNotMatch(configureNetwork, /systemctl restart rainskills-network-ready\.service/);
});

test("WSL network convergence replaces strong runtime dependencies before restoring the address", () => {
  const source = readNormalizedSource(wslBootstrapPath);
  const installHelpers = source.match(/install_network_helpers\(\) \{[\s\S]*?\n\}\n\nprepare_runtime\(\)/)?.[0];
  const configureNetwork = source.match(/configure_guest_network\(\) \{[\s\S]*?\n\}\n\nverify_installer\(\)/)?.[0];
  assert(installHelpers, "network helper and unit installation must remain reusable");
  assert(configureNetwork, "configure_guest_network must remain a standalone fixed action");
  const dropIn = installHelpers.match(/docker\.service\.d\/10-rainskills-network\.conf <<'UNIT'\n([\s\S]*?)\nUNIT/)?.[1];
  assert(dropIn, "Docker and containerd must share a fixed managed network drop-in");
  assert.match(dropIn, /^Wants=rainskills-network-ready\.service$/m);
  assert.match(dropIn, /^After=rainskills-network-ready\.service$/m);
  assert.doesNotMatch(dropIn, /^Requires=/m);
  assert.match(installHelpers, /containerd\.service\.d\/10-rainskills-network\.conf/);

  const installIndex = configureNetwork.indexOf("install_network_helpers");
  const activeIndex = configureNetwork.indexOf("systemctl is-active --quiet rainskills-network-ready.service");
  const restoreIndex = configureNetwork.indexOf('"$RESTORE_NETWORK_HELPER"');
  assert(installIndex >= 0 && installIndex < activeIndex && activeIndex < restoreIndex,
    "current helpers and units must be installed before an in-place active-service restore");
  assert.match(configureNetwork, /else\n    systemctl start rainskills-network-ready\.service/);
  assert.doesNotMatch(configureNetwork, /systemctl (?:restart|stop) rainskills-network-ready\.service/);
});

test("WSL installed Rainbond convergence preserves Docker and the owned outer container", () => {
  const source = readNormalizedSource(wslBootstrapPath);
  const converge = source.match(/converge_installed_rainbond\(\) \{[\s\S]*?\n\}\n\nverify_rainbond\(\)/)?.[0];
  assert(converge, "converge_installed_rainbond must remain a standalone fixed action");
  assert.match(converge, /systemctl is-active --quiet docker[\s\S]*systemctl start docker/);
  assert.match(converge, /rainbond-installation-id/);
  assert.match(converge, /\[\[ "\$ownership" == "\$INSTALLATION_ID" \]\]/);
  assert.match(converge, /docker inspect rainbond/);
  assert.match(converge, /State\.Status/);
  assert.match(converge, /case "\$status" in[\s\S]*?running\)[\s\S]*?;;[\s\S]*?created\|exited\)[\s\S]*?docker start rainbond[\s\S]*?;;[\s\S]*?\*\)[\s\S]*?safe_status[\s\S]*?exit 1[\s\S]*?;;[\s\S]*?esac/);
  assert.match(converge, /safe_status="\$\{status\/\/\$'\\r'\/ \}"[\s\S]*safe_status="\$\{safe_status\/\/\$'\\n'\/ \}"/);
  assert.match(converge, /safe_status="\$\{safe_status\/\/\[\^A-Za-z0-9_\.\-\]\/\?\}"/);
  assert.match(converge, /safe_status="\$\{safe_status:0:80\}"/);
  assert.match(converge, /safe_status="\$\{safe_status:\-<empty>\}"/);
  assert.match(converge, /Managed rainbond container state is not safely startable: %s/);
  assert.doesNotMatch(converge, /if \[\[ "\$status" != "running" \]\]; then[\s\S]*docker start rainbond/);
  for (const forbidden of [
    /verify_installer/,
    /INSTALLER_PATH/,
    /docker rm/,
    /systemctl restart docker/,
    /systemctl stop docker/,
    /systemctl restart rainskills-network-ready/,
  ]) {
    assert.doesNotMatch(converge, forbidden);
  }
});

test("WSL forwards the fixed guest address through Docker and verifies Console on loopback", () => {
  const source = readNormalizedSource(wslBootstrapPath);
  const installHelpers = source.match(/install_network_helpers\(\) \{[\s\S]*?\n\}\n\nprepare_runtime\(\)/)?.[0];
  const prepareRuntime = source.match(/prepare_runtime\(\) \{[\s\S]*?\n\}\n\nconfigure_guest_network\(\)/)?.[0];
  const prepareDocker = source.match(/prepare_docker\(\) \{[\s\S]*?\n\}\n\ninstall_rainbond\(\)/)?.[0];
  const verifyRainbond = source.match(/verify_rainbond\(\) \{[\s\S]*?\n\}\n\ncase "\$ACTION"/)?.[0];
  assert(installHelpers, "network helper and unit installation must remain reusable");
  assert(prepareRuntime, "prepare_runtime must remain a standalone fixed action");
  assert(prepareDocker, "prepare_docker must remain a standalone fixed action");
  assert(verifyRainbond, "verify_rainbond must remain a standalone fixed action");
  assert.match(prepareRuntime, /install_network_helpers/);
  assert.match(installHelpers, /rainskills-forward-docker-ports/);
  assert.match(installHelpers, /After=docker\.service rainskills-network-ready\.service/);
  assert.match(installHelpers, /for chain in PREROUTING OUTPUT/);
  assert.match(installHelpers, /iptables -t nat -C "\$chain" -d "\$guest_address\/32" -j DOCKER/);
  const forwardHelper = installHelpers.match(/cat > "\$FORWARD_DOCKER_HELPER" <<'SCRIPT'\n([\s\S]*?)\nSCRIPT/)?.[1];
  assert(forwardHelper, "the fixed Docker forwarding helper must be embedded verbatim");
  const syntax = spawnSync("bash", ["-n"], { input: forwardHelper, encoding: "utf8" });
  assert.equal(syntax.status, 0, syntax.stderr);
  assert.match(prepareDocker, /systemctl restart rainskills-docker-forwarding\.service/);
  assert.match(verifyRainbond, /http:\/\/127\.0\.0\.1:7070\//);
  assert.doesNotMatch(verifyRainbond, /http:\/\/\$GUEST_ADDRESS:7070\//);
});

test("PowerShell keeps WSL alive through the protected helper instead of a direct scheduled wsl.exe action", () => {
  const source = readNormalizedSource(powershellPath);
  const registerMaintenance = source.match(/function Register-NetworkMaintenance\(\$Request, \$Manifest\) \{[\s\S]*?\n\}\n\nfunction Test-ExpectedPortProxy/)?.[0];
  const assertKeepalive = source.match(/function Assert-WslKeepaliveTask\(\$Request\) \{[\s\S]*?\n\}\n\nfunction Test-ExpectedPortProxy/)?.[0];
  const invokeKeepalive = source.match(/function Invoke-WslKeepalive\(\$Request\) \{[\s\S]*?\n\}\n\nfunction Invoke-ProvisionRainbond/)?.[0];
  const waitForKeepalive = source.match(/function Wait-ScheduledTaskRunning\([\s\S]*?\n\}\n\nfunction Register-NetworkMaintenance/)?.[0];
  const taskContract = source.match(/function Get-ScheduledTaskContractMismatches\([^\n]+\) \{[\s\S]*?\n\}\n\nfunction Assert-ScheduledTaskContract/)?.[0];
  const finalize = source.match(/function Invoke-Finalize\(\$Request\) \{[\s\S]*?\n\}\n\nfunction Invoke-PrepareWsl/)?.[0];
  const validateSet = source.match(/\[ValidateSet\([^\n]+\)\]/)?.[0];
  const machineAllowlist = source.match(/\$machineActions = @\([^\n]+\)/)?.[0];
  const dispatch = source.match(/switch \(\$Action\) \{[\s\S]*?default \{ throw "Unsupported fixed action" \}\n  \}/)?.[0];
  assert(registerMaintenance, "Register-NetworkMaintenance must remain a standalone fixed helper");
  assert(assertKeepalive, "Assert-WslKeepaliveTask must remain a standalone fixed helper");
  assert(invokeKeepalive, "persistent WSL ownership must remain a standalone fixed helper action");
  assert(waitForKeepalive, "managed keepalive startup must have a bounded running-state check");
  assert(taskContract, "scheduled task metadata must be normalized in one fixed helper");
  assert(finalize, "Invoke-Finalize must remain a standalone fixed action");
  assert.match(registerMaintenance, /RainSkills-Keepalive-\$\(\$Request\.installation_id\)/);
  assert.match(registerMaintenance, /WindowsPowerShell\\v1\.0\\powershell\.exe/);
  assert.match(registerMaintenance, /-Action WslKeepalive/);
  assert.match(registerMaintenance, /request-\$keepaliveNonce\.json/);
  assert.match(registerMaintenance, /result-\$keepaliveNonce\.json/);
  assert.doesNotMatch(registerMaintenance, /New-ScheduledTaskAction[\s\S]*?-Execute "\$env:SystemRoot\\System32\\wsl\.exe"/);
  assert.match(registerMaintenance, /Get-ScheduledTaskContractMismatches/);
  assert.match(registerMaintenance, /\$reuseKeepalive/);
  assert.match(registerMaintenance, /Stop-ScheduledTask/);
  assert(
    registerMaintenance.indexOf("Get-ScheduledTaskContractMismatches") <
      registerMaintenance.indexOf("Register-VerifiedTask $keepaliveTaskName"),
    "an already-running verified wrapper must be reused before replacing the task definition"
  );
  assert.match(registerMaintenance, /New-ScheduledTaskSettingsSet[\s\S]*ExecutionTimeLimit[\s\S]*Zero/);
  assert.match(registerMaintenance, /AllowStartIfOnBatteries/);
  assert.match(registerMaintenance, /DontStopIfGoingOnBatteries/);
  assert.match(registerMaintenance, /StartWhenAvailable/);
  assert.match(registerMaintenance, /New-ScheduledTaskPrincipal[^\n]*RunLevel Highest/);
  assert.match(registerMaintenance, /Start-ScheduledTask[\s\S]*keepalive/);
  assert.match(registerMaintenance, /Wait-ScheduledTaskRunning \$keepaliveTaskName 15 \$keepaliveResult/);
  assert.match(waitForKeepalive, /Get-ScheduledTaskInfo/);
  assert.match(waitForKeepalive, /State[\s\S]*Running/);
  assert.match(waitForKeepalive, /runtimeLeaseReady/);
  assert.match(waitForKeepalive, /failureMessage/);
  assert.match(waitForKeepalive, /LastTaskResult/);
  assert.match(waitForKeepalive, /throw/);
  assert(
    waitForKeepalive.indexOf('$readiness.status -eq "error"') <
      waitForKeepalive.indexOf('[string]$task.State -eq "Running"'),
    "a completed wrapper failure must be reported even after the scheduled task returns to Ready"
  );
  assert.match(invokeKeepalive, /Start-WslRuntimeLease/);
  assert.match(invokeKeepalive, /Remove-Item -LiteralPath \$ResultPath/);
  assert(
    invokeKeepalive.indexOf("Remove-Item -LiteralPath $ResultPath") <
      invokeKeepalive.indexOf("Start-WslRuntimeLease"),
    "each keepalive launch must clear stale readiness before starting a new WSL lease"
  );
  assert.match(invokeKeepalive, /Write-ActionResult[\s\S]*runtimeLeaseReady\s*=\s*\$true/);
  assert.match(invokeKeepalive, /WaitForExit\(\)/);
  assert.match(invokeKeepalive, /exited unexpectedly/);
  assert.match(taskContract, /Convert-IdentityToSid/);
  assert.match(source, /function Normalize-ScheduledTaskExecutable[\s\S]*ExpandEnvironmentVariables/);
  assert.match(taskContract, /OrdinalIgnoreCase/);
  assert.match(assertKeepalive, /Assert-ScheduledTaskContract/);
  assert.match(assertKeepalive, /WindowsPowerShell\\v1\.0\\powershell\.exe/);
  assert.match(assertKeepalive, /-Action WslKeepalive/);
  assert.match(assertKeepalive, /Wait-ScheduledTaskRunning \$taskName 15 \$keepaliveResult/);
  assert.match(source, /read-back mismatch: \$\(\$mismatches -join/);
  assert.match(validateSet, /"WslKeepalive"/);
  assert.match(machineAllowlist, /"WslKeepalive"/);
  assert.match(dispatch, /"WslKeepalive" \{ \$facts = Invoke-WslKeepalive \$request \}/);
  assert.doesNotMatch(finalize, /RainSkills-Keepalive|RainSkills-Network/);
});

test("combined Windows provisioning holds WSL across runtime and loopback verification", () => {
  const source = readNormalizedSource(powershellPath);
  const startLease = source.match(/function Start-WslRuntimeLease\(\) \{[\s\S]*?\n\}\n\nfunction Stop-WslRuntimeLease/)?.[0];
  const stopLease = source.match(/function Stop-WslRuntimeLease\([^\n]+\) \{[\s\S]*?\n\}/)?.[0];
  const provision = source.match(/function Invoke-ProvisionRainbond\(\$Request\) \{[\s\S]*?\n\}\n\n\$request =/)?.[0];
  assert(startLease, "fresh provisioning must have an installer-owned WSL runtime lease");
  assert(stopLease, "fresh provisioning must release its temporary WSL runtime lease");
  assert(provision, "Invoke-ProvisionRainbond must remain a standalone fixed action");
  assert.match(startLease, /Get-TrustedWslPath/);
  assert.match(startLease, /\/bin\/sleep[\s\S]*infinity/);
  assert.match(startLease, /Diagnostics\.ProcessStartInfo/);
  assert.match(startLease, /UseShellExecute\s*=\s*\$false/);
  assert.match(startLease, /CreateNoWindow\s*=\s*\$true/);
  assert.match(startLease, /RedirectStandardError\s*=\s*\$true/);
  assert.match(startLease, /ReadToEndAsync\(\)/);
  assert.doesNotMatch(startLease, /Start-Process/);
  assert.match(startLease, /HasExited/);
  assert.match(provision, /Invoke-ImportDistro[\s\S]*Start-WslRuntimeLease[\s\S]*Invoke-VerifyDeployment/);
  assert.match(provision, /finally[\s\S]*Stop-WslRuntimeLease/);
});

test("PowerShell renders seven ordered provisioning stages without premature completion", () => {
  const source = readNormalizedSource(powershellPath);
  const stageRunner = source.match(/function Invoke-ProvisionStage\([^\n]+\) \{[\s\S]*?\n\}\n\nfunction/)?.[0];
  const provision = source.match(/function Invoke-ProvisionRainbond\(\$Request\) \{[\s\S]*?\n\}\n\n\$request =/)?.[0];
  assert(stageRunner, "numbered Windows stages must share one progress wrapper");
  assert(provision, "Invoke-ProvisionRainbond must remain a standalone fixed action");
  assert.match(stageRunner, /Diagnostics\.Stopwatch/);
  assert.match(stageRunner, /\[\.\.\][\s\S]*\$StageNumber[\s\S]*\$StageCount/);
  assert.match(stageRunner, /\[OK\][\s\S]*\$StageNumber[\s\S]*\$StageCount/);
  assert.match(stageRunner, /& \$StageAction/);
  assert(
    stageRunner.indexOf("& $StageAction") < stageRunner.indexOf("[OK]"),
    "a stage must complete only after its action succeeds"
  );
  const stageOffsets = Array.from({ length: 7 }, (_, index) =>
    provision.indexOf(`Invoke-ProvisionStage ${index + 1} 7`)
  );
  assert(stageOffsets.every((offset) => offset >= 0), "all seven fixed provisioning stages must be rendered");
  assert.deepEqual(stageOffsets, [...stageOffsets].sort((left, right) => left - right));
  assert.match(provision, /Invoke-ImportDistro[\s\S]*Start-WslRuntimeLease[\s\S]*Invoke-VerifyDeployment/);
  assert.match(provision, /finally[\s\S]*Stop-WslRuntimeLease/);
});

test("PowerShell separates fixed progress events from protected diagnostic output", () => {
  const source = readNormalizedSource(powershellPath);
  const sanitizer = source.match(/function ConvertTo-SafeDiagnosticLine\([^\n]+\) \{[\s\S]*?\n\}/)?.[0];
  const logInitializer = source.match(/function Initialize-OperationDiagnosticLog\([^\n]+\) \{[\s\S]*?\n\}/)?.[0];
  const logWriter = source.match(/function Write-OperationDiagnosticLine\([^\n]+\) \{[\s\S]*?\n\}/)?.[0];
  const progressParser = source.match(/function ConvertFrom-PlatformProgressEvent\([^\n]+\) \{[\s\S]*?\n\}/)?.[0];
  const invokeBootstrap = source.match(/function Invoke-DistroBootstrap\([^\n]+\) \{[\s\S]*?\n\}\n\nfunction Get-DistroIdentity/)?.[0];
  assert(sanitizer, "diagnostic output must have one centralized sanitizer");
  assert(logInitializer, "each Windows operation must initialize a protected diagnostic log");
  assert(logWriter, "every diagnostic append must enforce centralized sanitization");
  assert(progressParser, "WSL progress JSON must be parsed by a fixed-schema helper");
  assert(invokeBootstrap, "Invoke-DistroBootstrap must remain a standalone fixed action");
  assert.match(sanitizer, /Authorization|Bearer/);
  assert.match(sanitizer, /password/i);
  assert(sanitizer.includes("device[_-]?code"));
  assert(sanitizer.includes("access[_-]?token"));
  assert(sanitizer.includes("refresh[_-]?token"));
  assert.match(invokeBootstrap, /ConvertTo-SafeDiagnosticLine \$line 240/);
  assert.match(logInitializer, /operation_id/);
  assert.match(logInitializer, /logs/);
  assert.match(logInitializer, /ReparsePoint/);
  assert.match(logInitializer, /Set-MachineRootAcl/);
  assert.match(logInitializer, /GetFullPath/);
  assert.match(logWriter, /ConvertTo-SafeDiagnosticLine/);
  assert.match(progressParser, /ConvertFrom-Json/);
  assert.match(progressParser, /ErrorAction Stop/);
  assert.match(progressParser, /rainskills\.platform-progress\.v1/);
  assert.match(progressParser, /preparing-docker/);
  assert.match(progressParser, /installing-rainbond/);
  assert.match(progressParser, /verifying-rainbond/);
  assert.match(progressParser, /started/);
  assert.match(progressParser, /heartbeat/);
  assert.match(progressParser, /completed/);
  assert.match(progressParser, /timestamp/);
  assert.match(progressParser, /PSObject\.Properties/);
  assert.doesNotMatch(invokeBootstrap, /Write-Host \$_/);
  assert.match(invokeBootstrap, /Diagnostic log:/);
});

test("PowerShell WSL import drains native output while reporting elapsed heartbeats", () => {
  const source = readNormalizedSource(powershellPath);
  const importRunner = source.match(/function Invoke-WslImportWithProgress\([^\n]+\) \{[\s\S]*?\n\}/)?.[0];
  const importDistro = source.match(/function Invoke-ImportDistro\(\$Request\) \{[\s\S]*?\n\}\n\nfunction Invoke-PrepareRuntime/)?.[0];
  assert(importRunner, "wsl --import must use a heartbeat-aware native process runner");
  assert(importDistro, "Invoke-ImportDistro must remain a standalone fixed action");
  assert.match(importRunner, /RedirectStandardOutput\s*=\s*\$true/);
  assert.match(importRunner, /RedirectStandardError\s*=\s*\$true/);
  assert.match(importRunner, /ReadToEndAsync\(\)/);
  assert.match(importRunner, /WaitForExit\(10000\)/);
  assert(
    importRunner.indexOf("ReadToEndAsync()") < importRunner.indexOf("WaitForExit(10000)"),
    "redirected native streams must drain before waiting for process completion"
  );
  assert.match(importRunner, /Write-StageHeartbeat/);
  assert.match(importRunner, /ExitCode/);
  assert.match(importDistro, /Invoke-WslImportWithProgress/);
  assert.doesNotMatch(importDistro, /--import Rainbond[^\n]*\| ForEach-Object \{ Write-Host \$_ \}/);
});

test("Rainbond WSL bootstrap verifies artifacts, prepares Docker, emits heartbeats, and redacts logs", () => {
  const source = readNormalizedSource(wslBootstrapPath);
  assert.match(source, /PrepareDocker/);
  assert.match(source, /InstallRainbond/);
  assert.match(source, /VerifyRainbond/);
  assert.match(source, /sha256sum/);
  assert.match(source, /bash -n "\$INSTALLER_PATH"/);
  assert.match(source, /EIP="?\$GUEST_ADDRESS"?/);
  assert(source.indexOf("docker info") < source.indexOf('bash "$INSTALLER_PATH"'));
  assert.match(source, /heartbeat/);
  assert.match(source, /rainskills\.platform-progress\.v1/);
  assert.match(source, /Authorization|Bearer/);
  assert(source.includes("device[_-]?code"));
  assert.match(source, /password/i);
  assert.match(source, /kubectl[\s\S]*rbd-system/);
  assert.match(source, /curl[\s\S]*7070/);
});

test("Docker preparation emits heartbeats while package installation is running", () => {
  const source = readNormalizedSource(wslBootstrapPath);
  const prepareDocker = source.match(/prepare_docker\(\) \{[\s\S]*?\n\}\n\ninstall_rainbond\(\)/)?.[0];
  assert(prepareDocker, "prepare_docker must remain a standalone action");
  assert.match(prepareDocker, /apt-get update[\s\S]*&/);
  assert.match(prepareDocker, /kill -0[\s\S]*preparing-docker heartbeat/);
  assert.match(prepareDocker, /wait "\$[A-Za-z_]+"/);
  assert(
    prepareDocker.indexOf("preparing-docker heartbeat") < prepareDocker.indexOf("preparing-docker completed"),
    "Docker completion must follow its heartbeat loop"
  );
});

test("Rainbond WSL installation forces CPU mode and rebuilds its owned stopped container", () => {
  const source = readNormalizedSource(wslBootstrapPath);
  const installRainbond = source.match(/install_rainbond\(\) \{[\s\S]*?\n\}\n\nverify_rainbond\(\)/)?.[0];
  assert(installRainbond, "install_rainbond must remain a standalone fixed action");
  assert.match(installRainbond, /rainbond-installation-id[\s\S]*State\.Status[\s\S]*return[\s\S]*docker rm rainbond/);
  assert.doesNotMatch(installRainbond, /docker rm\s+-f/);
  assert.doesNotMatch(installRainbond, /existing_gpu_mode|ENABLE_GPU=true/);
  assert.match(installRainbond, /setsid env[\s\S]*ENABLE_GPU=false[\s\S]*bash "\$INSTALLER_PATH"/);
});

test("Rainbond WSL verification uses the bundled K3s CLI and waits for readiness", () => {
  const source = readNormalizedSource(wslBootstrapPath);
  const verifyRainbond = source.match(/verify_rainbond\(\) \{[\s\S]*?\n\}\n\ncase "\$ACTION"/)?.[0];
  assert(verifyRainbond, "verify_rainbond must remain a standalone fixed action");
  assert.match(verifyRainbond, /docker exec rainbond \/bin\/k3s kubectl get nodes/);
  assert.match(verifyRainbond, /docker exec rainbond \/bin\/k3s kubectl get pods -n rbd-system/);
  assert.doesNotMatch(verifyRainbond, /docker exec rainbond kubectl/);
  assert.match(verifyRainbond, /VERIFY_TIMEOUT_SECONDS/);
  assert.match(verifyRainbond, /emit_progress verifying-rainbond heartbeat/);
  assert.match(verifyRainbond, /Completed[\s\S]*Succeeded/);
  assert.match(verifyRainbond, /Last check:/);
  assert.doesNotMatch(verifyRainbond, /6060/);
});

test("PowerShell returns the concrete managed WSL bootstrap failure", () => {
  const source = readNormalizedSource(powershellPath);
  const invokeBootstrap = source.match(/function Invoke-DistroBootstrap\([^\n]+\) \{[\s\S]*?\n\}\n\nfunction Get-DistroIdentity/)?.[0];
  assert(invokeBootstrap, "Invoke-DistroBootstrap must remain a standalone fixed action");
  assert.match(invokeBootstrap, /lastMeaningfulOutput/);
  assert.match(invokeBootstrap, /Managed WSL bootstrap action failed: \$\{BootstrapAction\}: \$lastMeaningfulOutput/);
  assert.doesNotMatch(invokeBootstrap, /\$BootstrapAction:/);
});

test("PowerShell does not promote managed WSL stderr to a terminating error", () => {
  const source = readNormalizedSource(powershellPath);
  const invokeBootstrap = source.match(/function Invoke-DistroBootstrap\([^\n]+\) \{[\s\S]*?\n\}\n\nfunction Get-DistroIdentity/)?.[0];
  assert(invokeBootstrap, "Invoke-DistroBootstrap must remain a standalone fixed action");
  assert.match(invokeBootstrap, /\$previousPreference = \$ErrorActionPreference/);
  assert.match(invokeBootstrap, /try \{[\s\S]*\$ErrorActionPreference = "Continue"[\s\S]*& \$wslPath @arguments 2>&1/);
  assert.match(invokeBootstrap, /\$exitCode = \$LASTEXITCODE[\s\S]*\} finally \{[\s\S]*\$ErrorActionPreference = \$previousPreference/);
});

test("Windows PowerShell parses the complete helper without syntax errors", {
  skip: process.platform !== "win32",
}, () => {
  const command = [
    "$tokens = $null",
    "$errors = $null",
    "[Management.Automation.Language.Parser]::ParseFile($env:RAINSKILLS_PS_PATH, [ref]$tokens, [ref]$errors) | Out-Null",
    "if ($errors.Count -gt 0) { $errors | ForEach-Object { [Console]::Error.WriteLine($_.Message) }; exit 1 }",
  ].join("; ");
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
    encoding: "utf8",
    env: { ...process.env, RAINSKILLS_PS_PATH: powershellPath },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("Windows source inspector executes the fixed no-follow handle path", {
  skip: process.platform !== "win32",
}, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rainskills-source-handle-"));
  const sourcePath = path.join(root, "cluster.yaml");
  fs.writeFileSync(sourcePath, "hosts: []\n", "utf8");
  const sid = spawnSync("whoami.exe", ["/user", "/fo", "csv", "/nh"], { encoding: "utf8" })
    .stdout.match(/"(S-[^"]+)"/)?.[1];
  assert(sid, "current user SID must be available");
  const result = spawnSync("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", powershellPath,
    "-Action", "InspectSourceFile", "-TargetPath", sourcePath, "-ExpectedKind", "file",
    "-UserSid", sid, "-UserHome", os.homedir(),
  ], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const facts = JSON.parse(result.stdout.trim());
  assert.equal(facts.reparsePoint, false);
  assert.equal(facts.fileIdentity, `sha256:${crypto.createHash("sha256").update(fs.readFileSync(sourcePath)).digest("hex")}:${fs.statSync(sourcePath).size}`);
  assert.equal(facts.ownerSid, sid);
});

test("Windows executes the dynamically hashed installer instead of a package-pinned digest", () => {
  const powershell = readNormalizedSource(powershellPath);
  const platformInstaller = readNormalizedSource(platformInstallerPath);
  assert.match(powershell, /installer_sha256/);
  assert.doesNotMatch(powershell, /policy\.installer\.sha256/);
  assert.doesNotMatch(platformInstaller, /POLICY\.installer\.sha256/);
});

test("secret redaction removes credentials before output or persistence", () => {
  const { redactSensitiveText } = require(windowsPlatformPath);
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.signaturevalue";
  const raw = [
    `Authorization: Bearer ${jwt}`,
    `password=plain-secret`,
    `device_code=device-secret`,
    `https://example.test/callback?access_token=${jwt}&safe=ok`,
  ].join("\n");
  const redacted = redactSensitiveText(raw);
  assert.doesNotMatch(redacted, /plain-secret|device-secret|signaturevalue/);
  assert.match(redacted, /\[REDACTED\]/);
  assert.match(redacted, /safe=ok/);
});

test("Windows delivery requires WSL and Windows-side health evidence", () => {
  const { evaluateWindowsDeployment } = require(windowsPlatformPath);
  const passing = evaluateWindowsDeployment({
    installationId: INSTALLATION_ID,
    expectedInstallationId: INSTALLATION_ID,
    containerRunning: true,
    nodeReady: true,
    componentsReady: true,
    wslConsoleReachable: true,
    windowsConsoleReachable: true,
    portsListening: [80, 443, 7070],
    guestAddress: "172.31.253.2",
  }, policy);
  assert.equal(passing.ok, true);
  assert.equal(passing.location, "本地（Windows / WSL2）");
  assert.equal(passing.consoleUrl, "http://127.0.0.1:7070");
  assert.equal(passing.controlConsoleUrl, "http://127.0.0.1:7070");

  const wslControl = evaluateWindowsDeployment({
    installationId: INSTALLATION_ID,
    expectedInstallationId: INSTALLATION_ID,
    controlMode: "wsl",
    containerRunning: true,
    nodeReady: true,
    componentsReady: true,
    wslConsoleReachable: true,
    windowsConsoleReachable: true,
    portsListening: [80, 443, 7070],
    guestAddress: "172.31.253.2",
  }, policy);
  assert.equal(wslControl.consoleUrl, "http://127.0.0.1:7070");
  assert.equal(wslControl.controlConsoleUrl, "http://172.31.253.2:7070");

  const failing = evaluateWindowsDeployment({
    installationId: INSTALLATION_ID,
    expectedInstallationId: INSTALLATION_ID,
    containerRunning: true,
    nodeReady: false,
    componentsReady: false,
    wslConsoleReachable: true,
    windowsConsoleReachable: false,
    portsListening: [],
    guestAddress: "172.31.253.2",
  }, policy);
  assert.equal(failing.ok, false);
  assert.match(failing.blockers.join("\n"), /K3s|rbd-system|Windows|80.*443.*7070/);
});

test("PowerShell exposes fixed Rainbond install and dual-side verification actions", () => {
  const source = readNormalizedSource(powershellPath);
  assert.match(source, /PrepareDocker/);
  assert.match(source, /InstallRainbond/);
  assert.match(source, /VerifyDeployment/);
  assert.match(source, /Invoke-WebRequest[\s\S]*127\.0\.0\.1:7070/);
  assert.match(source, /containerRunning/);
  assert.match(source, /nodeReady/);
  assert.match(source, /componentsReady/);
  assert.match(source, /windowsConsoleReachable/);
});

test("PowerShell converges an installed platform without importing or reinstalling Rainbond", () => {
  const source = readNormalizedSource(powershellPath);
  const converge = source.match(/function Invoke-ConvergeInstalledPlatform\(\$Request\) \{[\s\S]*?\n\}\n\nfunction Invoke-ProvisionRainbond/)?.[0];
  assert(converge, "Invoke-ConvergeInstalledPlatform must remain a standalone fixed action");
  const steps = [
    "Invoke-InstallMachineBundle $Request",
    "Invoke-ConfigureNetwork $Request",
    'Invoke-DistroBootstrap $Request "ConvergeInstalledRainbond"',
    "Invoke-RegisterResume $Request",
    "Invoke-StableDeployment $Request",
  ];
  let previous = -1;
  for (const step of steps) {
    const current = converge.indexOf(step);
    assert(current > previous, `${step} must run in convergence order`);
    previous = current;
  }
  for (const forbidden of [
    /Invoke-ImportDistro/,
    /Invoke-InstallRainbond/,
    /--import/,
    /installer_path/,
    /installer_sha256/,
  ]) {
    assert.doesNotMatch(converge, forbidden);
  }
  for (const fact of [
    "machineBundleVerified",
    "distroIdentityVerified",
    "systemdReady",
    "networkGateReady",
    "dockerReady",
    "rainbondRuntimeVerified",
    "networkManifestVerified",
    "portproxyVerified",
    "recoveryTasksVerified",
    "containerRunning",
    "nodeReady",
    "componentsReady",
    "wslConsoleReachable",
    "windowsConsoleReachable",
    "portsListening",
    "subnet",
    "hostAddress",
    "guestAddress",
  ]) {
    assert.match(converge, new RegExp(`\\b${fact}\\b`), `convergence facts must include ${fact}`);
  }
});

test("PowerShell convergence bounds three stable rounds and checks Device Flow exactly once", () => {
  const source = readNormalizedSource(powershellPath);
  const stable = source.match(/function Invoke-StableDeployment\(\$Request\) \{[\s\S]*?\n\}/)?.[0];
  const deviceFlow = source.match(/function Invoke-DeviceFlowReadiness\(\$Request\) \{[\s\S]*?\n\}/)?.[0];
  const converge = source.match(/function Invoke-ConvergeInstalledPlatform\(\$Request\) \{[\s\S]*?\n\}\n\nfunction Invoke-ProvisionRainbond/)?.[0];
  assert(stable, "stable deployment sampling must remain a standalone fixed operation");
  assert(deviceFlow, "Device Flow readiness must remain a standalone fixed operation");
  assert(converge, "Invoke-ConvergeInstalledPlatform must remain a standalone fixed action");

  assert.match(stable, /AddSeconds\(120\)/);
  assert.match(stable, /for \(\$round = 1; \$round -le 3; \$round\+\+\)/);
  assert.match(stable, /for \(\$probe = 1; \$probe -le 3; \$probe\+\+\)/);
  assert.match(stable, /Invoke-ProbeDeployment \$Request \$deadline/);
  assert.match(stable, /Start-Sleep -Seconds 5/);
  assert.match(stable, /containerStartedAt/);
  assert.match(stable, /Select-Object -Unique/);
  assert.match(stable, /RAINBOND_RUNTIME_UNSTABLE:/);
  assert.match(stable, /stableProbeCount = 3/);

  assert.match(deviceFlow, /http:\/\/127\.0\.0\.1:7070\/console\/mcp\/device\/code/);
  assert.match(deviceFlow, /-Method Post/);
  assert.match(deviceFlow, /client_id=rainskills&scope=mcp/);
  assert.match(deviceFlow, /-TimeoutSec 15/);
  assert.match(deviceFlow, /StatusCode -lt 200|StatusCode -ge 300/);
  assert.match(deviceFlow, /device_code/);
  assert.match(deviceFlow, /\[23456789BCDFGHJKMNPQRTVWXY\]/);
  assert.match(deviceFlow, /expires_in/);
  assert.match(deviceFlow, /interval/);
  assert.match(deviceFlow, /CONSOLE_DEVICE_FLOW_UNAVAILABLE:/);
  assert.match(deviceFlow, /deviceFlowHttpReachable = \$true/);
  assert.doesNotMatch(deviceFlow, /Write-(?:Host|Output)[^\n]*(?:device_code|user_code|Content)/i);

  assert.equal((converge.match(/Invoke-DeviceFlowReadiness \$Request/g) || []).length, 1);
  assert(
    converge.indexOf("Invoke-StableDeployment $Request") < converge.indexOf("Invoke-DeviceFlowReadiness $Request"),
    "Device Flow readiness must be checked only after a stable deployment round"
  );
  assert.match(converge, /deviceFlowHttpReachable = \[bool\]\$deviceFlow\.deviceFlowHttpReachable/);
  assert.match(converge, /stableProbeCount = \[int\]\$stability\.stableProbeCount/);
  assert.match(converge, /containerStartedAt = \[string\]\$stability\.containerStartedAt/);
  assert.doesNotMatch(converge, /device_code|user_code|response\.Content/i);
});

test("each stable sample uses a fixed bounded readiness probe and captures container StartedAt", () => {
  const powershell = readNormalizedSource(powershellPath);
  const bootstrap = readNormalizedSource(wslBootstrapPath);
  const bounded = powershell.match(/function Invoke-BoundedDistroBootstrap[\s\S]*?\n\}/)?.[0];
  const probe = powershell.match(/function Invoke-ProbeDeployment\(\$Request, \[DateTime\]\$Deadline\) \{[\s\S]*?\n\}/)?.[0];
  const verify = powershell.match(/function Invoke-VerifyDeployment\(\$Request\) \{[\s\S]*?\n\}/)?.[0];
  const guestProbe = bootstrap.match(/probe_rainbond\(\) \{[\s\S]*?\n\}/)?.[0];
  assert(bounded, "WSL stability probes must use a host-bounded invocation");
  assert(probe, "each stability sample must remain a standalone deployment probe");
  assert(verify, "Invoke-VerifyDeployment must remain a standalone fixed action");
  assert(guestProbe, "ProbeRainbond must remain a standalone fixed WSL operation");

  assert.match(bounded, /WaitForExit\(/);
  assert.match(bounded, /Kill\(\)/);
  assert.match(bounded, /Timed out/);
  assert.match(probe, /Invoke-BoundedDistroBootstrap \$Request "ProbeRainbond"/);
  assert.match(probe, /docker", "inspect", "rainbond", "--format", "\{\{\.State\.StartedAt\}\}"/);
  assert.match(probe, /containerStartedAt/);
  assert.match(probe, /Invoke-WebRequest[\s\S]*127\.0\.0\.1:7070[\s\S]*-TimeoutSec/);
  assert.match(probe, /Get-NetTCPConnection/);
  assert.match(verify, /containerStartedAt/);

  assert.match(bootstrap, /PrepareRuntime\|ConfigureGuestNetwork\|PrepareDocker\|InstallRainbond\|VerifyRainbond\|ProbeRainbond\|ConvergeInstalledRainbond/);
  assert.match(bootstrap, /ProbeRainbond\)\n    probe_rainbond/);
  for (const command of [
    /timeout 10 docker inspect rainbond/,
    /timeout 15 docker exec rainbond \/bin\/k3s kubectl get nodes/,
    /timeout 15 docker exec rainbond \/bin\/k3s kubectl get pods/,
    /curl -fsS --max-time 10/,
  ]) {
    assert.match(guestProbe, command);
  }
  assert.doesNotMatch(guestProbe, /while|sleep|VERIFY_TIMEOUT_SECONDS/);
});

test("Windows adapter preserves stable convergence error prefixes without fetch text", async () => {
  const { createWindowsPlatformAdapter } = require(windowsPlatformPath);
  const fixture = createFixture();
  const runner = async (command, args) => {
    const valueAfter = (name) => args[args.indexOf(name) + 1];
    const requestPath = valueAfter("-RequestPath");
    const resultPath = valueAfter("-ResultPath");
    const request = fixture.stateStore.readProtectedJson(requestPath);
    fixture.stateStore.atomicWriteJson(resultPath, {
      schema: "rainskills.windows-result.v1",
      action: request.action,
      operation_id: request.operation_id,
      installation_id: request.installation_id,
      nonce: request.nonce,
      status: "error",
      facts: {
        failedAction: request.action,
        failureMessage: "CONSOLE_DEVICE_FLOW_UNAVAILABLE: windows-loopback request failed",
      },
    });
    return { status: 1, stdout: "", stderr: "" };
  };
  const adapter = createWindowsPlatformAdapter({
    runner,
    stateStore: fixture.stateStore,
    policy,
    userSid: USER_SID,
    home: fixture.home,
  });

  await assert.rejects(adapter.convergeInstalledPlatform({
    operationId: OPERATION_ID,
    installationId: INSTALLATION_ID,
    payload: {},
  }), (error) => {
    assert.match(error.message, /CONSOLE_DEVICE_FLOW_UNAVAILABLE:/);
    assert.doesNotMatch(error.message, /fetch failed/i);
    return true;
  });
});
