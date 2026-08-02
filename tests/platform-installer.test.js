const assert = require("node:assert/strict");
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

test("launcher routes platform and resume commands to the bundled helper", () => {
  const { resolveInvocation } = require(launcherPath);

  assert.deepEqual(resolveInvocation(["platform", "install", "--onboarding-id", "abc"]), {
    executable: process.execPath,
    args: [platformInstallerPath, "install", "--onboarding-id", "abc"],
  });
  assert.deepEqual(resolveInvocation(["resume", "--onboarding-id", "abc"]), {
    executable: process.execPath,
    args: [platformInstallerPath, "resume", "--onboarding-id", "abc"],
  });
});

test("onboarding state is schema checked and must be a protected regular file", () => {
  const { readOnboardingState } = require(platformInstallerPath);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rainskills-state-"));
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
    readOnboardingState(statePath, state.operation_id),
    state
  );

  fs.chmodSync(statePath, 0o644);
  assert.throws(() => readOnboardingState(statePath, state.operation_id), /0600/);
  fs.chmodSync(statePath, 0o600);
  assert.throws(() => readOnboardingState(statePath, "different-id"), /不匹配/);

  const symlinkPath = path.join(tempDir, "onboarding-link.json");
  fs.symlinkSync(statePath, symlinkPath);
  assert.throws(() => readOnboardingState(symlinkPath, state.operation_id), /符号链接/);
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
    { value: "local-linux", label: "当前设备（推荐）" },
    { value: "remote-linux", label: "其他 Linux 服务器" },
  ]);
  assert.deepEqual(targetChoicesForPlatform("darwin"), [
    { value: "remote-linux", label: "Linux 服务器（推荐）" },
    { value: "local-macos", label: "当前 Mac（需要 OrbStack，准备时间较长）" },
  ]);
  assert.deepEqual(targetChoicesForPlatform("win32"), [
    { value: "remote-linux", label: "Linux 服务器" },
  ]);
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

test("macOS offers Linux first while Windows asks only for a Linux server", async () => {
  const { selectInstallTarget } = require(platformInstallerPath);
  const macOutput = [];
  const macAnswers = ["2"];
  const mac = await selectInstallTarget({
    platform: "darwin",
    options: {},
    interactive: true,
    ask: async () => macAnswers.shift(),
    write: (value) => macOutput.push(value),
  });
  assert.equal(mac.kind, "local-macos");
  assert.match(macOutput.join(""), /Linux 服务器（推荐）/);
  assert.match(macOutput.join(""), /当前 Mac/);

  const windowsOutput = [];
  const windowsAnswers = ["rainbond-prod", ""];
  const windows = await selectInstallTarget({
    platform: "win32",
    options: {},
    interactive: true,
    ask: async (question) => {
      assert.doesNotMatch(question, /选项/);
      return windowsAnswers.shift();
    },
    write: (value) => windowsOutput.push(value),
  });
  assert.deepEqual(windows, {
    kind: "remote-linux",
    host: "rainbond-prod",
    sshPort: 22,
  });
  assert.match(windowsOutput.join(""), /Windows.*不支持.*本机安装/s);
  assert.doesNotMatch(windowsOutput.join(""), /当前 Mac/);
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

test("CLI saves target selection before preflight when the AI has no TTY", () => {
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
  const runner = (command, args, options) => {
    calls.push({ command, args, input: options.input });
    return { status: 0, stdout: "", stderr: "" };
  };

  const workspace = prepareRemoteInstaller(target, operationId, installerPath, runner);

  assert.equal(workspace, `.rainbond/platform-installer/${operationId}`);
  assert.equal(calls[0].command, "ssh");
  assert.match(calls[0].input, /chmod 700/);
  assert.deepEqual(calls[0].args.slice(-4), ["bash", "-s", "--", operationId]);
  assert.equal(calls[1].command, "scp");
  assert(calls[1].args.includes(installerPath));
  assert.equal(
    calls[1].args.at(-1),
    `rainbond-prod:.rainbond/platform-installer/${operationId}/rainbond-install.sh`
  );
});

test("remote installer invocation verifies the digest and preserves signal cleanup", () => {
  const { remoteInstallerInvocation } = require(platformInstallerPath);
  const operationId = "1d6754d6-6fb3-4bda-9a04-15c2d261d178";
  const digest = "a".repeat(64);
  const invocation = remoteInstallerInvocation(
    { host: "root@192.168.1.20", port: 22 },
    operationId,
    digest,
    "192.168.1.20"
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
  assert.match(invocation.input, /trap .*INT TERM HUP/);
  assert.match(invocation.input, /setsid/);
});

test("remote verification requires a running container, Ready node, and healthy components", () => {
  const { REMOTE_VERIFICATION_SCRIPT, verifyRemoteRainbond } = require(platformInstallerPath);
  const calls = [];
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
    }
  );

  assert.equal(calls[0].command, "ssh");
  assert.match(calls[0].input, /kubectl.*get nodes/);
  assert.match(calls[0].input, /kubectl.*get pods/);
  assert.deepEqual(verification, {
    consoleUrl: "http://192.168.1.20:7070",
    containerState: "true",
    nodeReady: true,
    componentsReady: true,
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
  assert.match(skill, /Windows.*remote Linux/is);
  assert.match(skill, /SSH.*BatchMode=yes/is);
});

test("versioned policy pins resources, source, and artifact digest", () => {
  const { POLICY } = require(platformInstallerPath);
  assert.equal(POLICY.minimums.cpu_cores, 4);
  assert.equal(POLICY.minimums.memory_bytes, 8 * 1024 ** 3);
  assert.equal(POLICY.minimums.disk_bytes, 50 * 1024 ** 3);
  assert.deepEqual(POLICY.required_ports, [80, 443, 6060, 7070]);
  assert.equal(POLICY.installer.url, "https://get.rainbond.com/");
  assert.deepEqual(POLICY.installer.allowed_origins, ["https://get.rainbond.com"]);
  assert.deepEqual(POLICY.supported_control_platforms, ["linux", "darwin", "win32"]);
  assert.match(POLICY.installer.sha256, /^[a-f0-9]{64}$/);
});

test("published guidance describes local and remote target selection", () => {
  const readme = fs.readFileSync(path.join(repoRoot, "README.md"), "utf8");
  const policy = fs.readFileSync(
    path.join(repoRoot, "rainbond-platform-installer", "references", "installation-policy.md"),
    "utf8"
  );
  assert.match(readme, /Windows.*Linux 服务器/s);
  assert.match(readme, /Linux.*当前设备.*其他 Linux 服务器/s);
  assert.match(policy, /远程 Linux/);
  assert.doesNotMatch(policy, /不支持远程 SSH/);
});

test("no download or installer execution appears before the confirmation gate", () => {
  const source = fs.readFileSync(platformInstallerPath, "utf8");
  const runInstall = source.slice(source.indexOf("async function runInstall"));
  const confirmation = runInstall.indexOf("await confirmInstall(options.yes)");
  const download = runInstall.indexOf("downloadInstaller(POLICY.installer.url");
  const execution = runInstall.indexOf("spawnAttached(command, args");
  assert(confirmation >= 0);
  assert(download > confirmation);
  assert(execution > confirmation);
});

test("atomic state writes reject a symlink directory", () => {
  const { atomicWriteJson } = require(platformInstallerPath);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rainskills-symlink-"));
  const realDir = path.join(tempDir, "real");
  const linkDir = path.join(tempDir, "link");
  fs.mkdirSync(realDir);
  fs.symlinkSync(realDir, linkDir);
  assert.throws(
    () => atomicWriteJson(path.join(linkDir, "state.json"), { ok: true }),
    /状态目录不安全/
  );
});
