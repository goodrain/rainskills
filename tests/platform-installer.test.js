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
const secureStatePath = path.join(
  repoRoot,
  "rainbond-platform-installer",
  "scripts",
  "secure-state.js"
);

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

test("onboarding state is schema checked and must be a protected regular file", () => {
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
    assert.match(result.stdout, /^OCCUPIED_PORTS=80,443,6060,7070$/m);
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

test("remote installer invocation verifies the digest and preserves signal cleanup", () => {
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
  assert.match(skill, /Windows.*remote Linux/is);
  assert.match(skill, /SSH.*system.*ssh/is);
  assert.match(skill, /password.*will not save/is);
  assert.match(skill, /Never ask.*password.*in chat/is);
  assert.match(skill, /RAINSKILLS_USER_INPUT_REQUIRED:console_address/);
  assert.match(skill, /--console-host/);
  assert.match(skill, /IP or DNS name.*not.*URL/is);
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
