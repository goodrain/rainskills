"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
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
  assert.deepEqual(policy.windows.managed_ports, [80, 443, 6060, 7070]);
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
    cpuCores: 2,
    memoryBytes: 4 * 1024 ** 3,
    diskBytes: 20 * 1024 ** 3,
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
  assert.match(blockers, /4 核/);
  assert.match(blockers, /8 GB/);
  assert.match(blockers, /50 GB/);
  assert.match(blockers, /虚拟化/);
  assert.match(blockers, /NAT/);
  assert.match(blockers, /80.*7070/);
  assert.match(blockers, /未知的 RainSkills 管理对象/);
  assert.match(blockers, /可用.*\/30/);
  assert.match(blockers, /无法访问/);
  assert.match(blockers, /未获准的跳转来源/);
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
  assert.doesNotMatch(installBundle, /existing\.helper_sha256 -ne \$expectedHelperDigest/);
  assert.match(installBundle, /Copy-Item[\s\S]*Assert-FileDigest \$machineHelper \$expectedHelperDigest/);
  assert.match(source, /function Assert-UpgradableMachineBundle[\s\S]*Assert-FileDigestOneOf/);
  assert.match(source, /b2315dcec815187f3f48144981487bf2646dad5ed0de12a1125b99c45ecf18fd/);
  assert.match(source, /function Assert-ManagedMachineRoot[\s\S]*ReparsePoint/);
  const aclFunction = source.match(/function Set-MachineRootAcl[\s\S]*?\n\}/)?.[0];
  assert(aclFunction, "Set-MachineRootAcl must remain a standalone fixed action");
  assert.match(aclFunction, /\/setowner[\s\S]*S-1-5-32-544/);
  assert.match(aclFunction, /\/verify/);
  assert.doesNotMatch(aclFunction, /\s\/c(?:\s|$)/);
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
    requiredFiles: ["package.json", "install.sh", "bin/rainskills.js"],
    requiredDirectories: ["rainbond-demo"],
  });
  fs.rmSync(packageRoot, { recursive: true });
  assert.equal(verifyRecoveryBundle(destination, manifest).ok, true);
  assert(manifest.files.every((entry) => /^[a-f0-9]{64}$/.test(entry.sha256)));
  assert.deepEqual(manifest.files.map((entry) => entry.path), [...manifest.files.map((entry) => entry.path)].sort());
  const badBundleParent = fs.mkdtempSync(path.join(os.tmpdir(), "rainskills-bad-recovery-"));
  assert.throws(() => createRecoveryBundle({
    packageRoot: bundleRoot,
    bundleRoot: path.join(badBundleParent, "bad"),
    requiredFiles: ["../escape"],
    requiredDirectories: [],
  }), /相对路径|越界/);
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

test("PowerShell checks systemd without terminal-dependent ps output", () => {
  const source = readNormalizedSource(powershellPath);
  const assertSystemd = source.match(/function Assert-SystemdPidOne\(\$Request\) \{[\s\S]*?\n\}\n\nfunction Invoke-ImportDistro/)?.[0];
  assert(assertSystemd, "Assert-SystemdPidOne must remain a standalone fixed probe");
  assert.match(assertSystemd, /Invoke-NativeCapture \$wslPath/);
  assert.match(assertSystemd, /--exec[\s\S]*cat[\s\S]*\/proc\/1\/comm/);
  assert.doesNotMatch(assertSystemd, /\bps\s+-p\s+1\b/);
});

test("WSL bootstrap enables systemd and gates runtime startup on the fixed network", () => {
  const source = fs.readFileSync(wslBootstrapPath, "utf8");
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

test("Rainbond WSL bootstrap verifies artifacts, prepares Docker, emits heartbeats, and redacts logs", () => {
  const source = fs.readFileSync(wslBootstrapPath, "utf8");
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

test("Windows executes the dynamically hashed installer instead of a package-pinned digest", () => {
  const powershell = readNormalizedSource(powershellPath);
  const platformInstaller = fs.readFileSync(platformInstallerPath, "utf8");
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
    portsListening: [80, 443, 6060, 7070],
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
    portsListening: [80, 443, 6060, 7070],
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
    portsListening: [7070],
    guestAddress: "172.31.253.2",
  }, policy);
  assert.equal(failing.ok, false);
  assert.match(failing.blockers.join("\n"), /K3s|rbd-system|Windows|80.*443.*6060/);
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
