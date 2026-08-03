#!/usr/bin/env node

const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline/promises");
const { spawn, spawnSync } = require("node:child_process");
const { createSecureStateStore } = require("./secure-state.js");
const {
  createRecoveryBundle,
  createWindowsPlatformAdapter,
  createWindowsSecureStateStore,
  ensurePinnedArtifact,
  evaluateWindowsDeployment,
  managedNetworkFromCidr,
  resolveWindowsUserSid,
  validateWindowsStageTransition,
  verifyRecoveryBundle,
} = require("./windows-platform.js");

const packageManifest = require("../../package.json");
const POLICY = require("../references/installation-policy.json");
const ONBOARDING_SCHEMA = "rainskills.onboarding.v1";
const PLATFORM_STATE_SCHEMA = "rainskills.platform-state.v1";
const PROGRESS_SCHEMA = "rainskills.platform-progress.v1";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

let activeChild = null;
let activeChildDetached = false;
let activeRequest = null;
let activeOperation = null;
let activeSshSession = null;
let interruptedSignal = null;

function usage() {
  process.stdout.write(`Usage:
  npx rainskills platform install --onboarding-id <id> [--target <kind>] [--ssh <target>] [--ssh-port <port>] [--console-host <host>] [--yes] [--no-resume]
  npx rainskills resume --onboarding-id <id>

Commands:
  platform install  Select a supported target, preflight it, and install Rainbond
  resume            Continue RainSkills authorization with the verified Console URL

Options:
  --onboarding-id ID  Resume the protected RainSkills onboarding checkpoint
  --target KIND       Use local-linux, local-macos, local-windows, or remote-linux
  --ssh TARGET        Existing SSH alias or user@host for remote-linux
  --ssh-port PORT     SSH port (default: 22)
  --console-host HOST Public IP or DNS name used to reach Console on port 7070
  --yes               Confirm the displayed installation effects non-interactively
  --no-resume         Stop after verified platform installation
  -h, --help          Show this help
`);
}

function parseArgs(argv) {
  const result = {
    command: argv[0] || "",
    onboardingId: "",
    target: "",
    ssh: "",
    sshPort: 22,
    consoleHost: "",
    yes: false,
    noResume: false,
  };
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--onboarding-id") {
      if (!argv[index + 1]) throw new Error("--onboarding-id 需要一个值");
      result.onboardingId = argv[index + 1];
      index += 1;
    } else if (argument === "--target") {
      if (!argv[index + 1]) throw new Error("--target 需要一个值");
      result.target = argv[index + 1];
      index += 1;
    } else if (argument === "--ssh") {
      if (!argv[index + 1]) throw new Error("--ssh 需要一个值");
      result.ssh = argv[index + 1];
      index += 1;
    } else if (argument === "--ssh-port") {
      if (!argv[index + 1]) throw new Error("--ssh-port 需要一个值");
      result.sshPort = argv[index + 1];
      index += 1;
    } else if (argument === "--console-host") {
      if (!argv[index + 1]) throw new Error("--console-host 需要一个值");
      result.consoleHost = normalizeConsoleHost(argv[index + 1]);
      index += 1;
    } else if (argument === "--yes") {
      result.yes = true;
    } else if (argument === "--no-resume") {
      result.noResume = true;
    } else if (argument === "-h" || argument === "--help") {
      result.help = true;
    } else {
      throw new Error(`未知参数：${argument}`);
    }
  }
  return result;
}

function assertOperationId(operationId) {
  if (!UUID_PATTERN.test(operationId || "")) {
    throw new Error("onboarding id 不是有效的 UUID");
  }
}

const secureStateStore = process.platform === "win32"
  ? createWindowsSecureStateStore()
  : createSecureStateStore();

function assertProtectedRegularFile(filePath) {
  secureStateStore.assertProtectedRegularFile(filePath);
}

function readOnboardingState(filePath, expectedOperationId, stateStore = secureStateStore) {
  stateStore.assertProtectedRegularFile(filePath);
  const state = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (state.schema !== ONBOARDING_SCHEMA || state.version !== 1) {
    throw new Error("不支持的 RainSkills onboarding 状态版本");
  }
  if (state.operation_id !== expectedOperationId) {
    throw new Error("onboarding id 与状态文件不匹配");
  }
  if (!UUID_PATTERN.test(state.operation_id || "")) {
    throw new Error("状态文件中的 operation_id 无效");
  }
  if (!["codex", "claude", "all"].includes(state.target)) {
    throw new Error("状态文件中的安装目标无效");
  }
  if (state.deployment_mode !== "self-hosted") {
    throw new Error("状态文件不是私有化部署流程");
  }
  if (state.control_mode !== undefined) {
    if (!["windows-native", "wsl", "posix"].includes(state.control_mode)) {
      throw new Error("状态文件中的 control_mode 无效");
    }
    const distro = state.control_distro;
    if (state.control_mode === "wsl") {
      if (typeof distro !== "string" || !distro.trim() || /[\u0000-\u001f\u007f-\u009f]/u.test(distro)) {
        throw new Error("状态文件中的 control_distro 无效");
      }
    } else if (distro !== null && distro !== undefined) {
      throw new Error("非 WSL 状态不能包含 control_distro");
    }
  }
  return state;
}

function readPlatformState(filePath, expectedOperationId, stateStore = secureStateStore) {
  stateStore.assertProtectedRegularFile(filePath);
  const state = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (state.schema !== PLATFORM_STATE_SCHEMA || state.version !== 1) {
    throw new Error("不支持的 Rainbond 平台安装状态版本");
  }
  if (state.operation_id !== expectedOperationId) {
    throw new Error("平台安装状态与 onboarding id 不匹配");
  }
  return state;
}

function atomicWriteJson(filePath, value, stateStore = secureStateStore) {
  stateStore.atomicWriteJson(filePath, value);
}

function ensurePrivateOperationDirectory(directory) {
  secureStateStore.ensurePrivateDirectory(directory);
}

function assertOperationFilesSafe(paths) {
  for (const filePath of [paths.state, paths.events, paths.log, paths.installer]) {
    let info;
    try {
      info = fs.lstatSync(filePath);
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new Error(`操作文件不是安全的普通文件：${filePath}`);
    }
    if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
      throw new Error(`操作文件不属于当前用户：${filePath}`);
    }
  }
}

function runCommand(command, args, options = {}) {
  return spawnSync(command, args, {
    encoding: "utf8",
    timeout: options.timeout || 10000,
    env: options.env || process.env,
    input: options.input,
  });
}

function normalizeWindowsExecutableForControl(command, controlMode) {
  if (controlMode !== "wsl") return command;
  if (path.win32.basename(String(command)).toLowerCase() === "whoami.exe") return "whoami.exe";
  return command;
}

function translateWslPathToWindows(filePath, runner = runCommand) {
  const value = String(filePath || "");
  if (/^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\")) return value;
  if (!path.posix.isAbsolute(value)) throw new Error(`WSL 路径必须是绝对路径：${value}`);
  const execution = runner("wslpath", ["-w", value]);
  if (execution?.error || execution?.status !== 0) {
    throw new Error(`无法把 WSL 路径转换为 Windows 路径：${String(execution?.stderr || execution?.error?.message || "").trim()}`);
  }
  const translated = String(execution.stdout || "").trim().replace(/\r/g, "");
  if (!path.win32.isAbsolute(translated) && !translated.startsWith("\\\\")) {
    throw new Error(`wslpath 返回了无效的 Windows 路径：${translated}`);
  }
  return translated;
}

function prepareWslHelperResult(filePath) {
  const info = fs.lstatSync(filePath);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Windows helper 结果不是安全的普通文件：${filePath}`);
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
    throw new Error(`Windows helper 结果不属于当前 WSL 用户：${filePath}`);
  }
  fs.chmodSync(filePath, 0o600);
}

function createSshTempDirectory() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "rainskills-ssh-"));
  fs.chmodSync(directory, 0o700);
  return directory;
}

function removeSshTempDirectory(directory) {
  if (!directory) return;
  const resolved = path.resolve(directory);
  const tempRoot = path.resolve(os.tmpdir());
  if (path.dirname(resolved) !== tempRoot || !path.basename(resolved).startsWith("rainskills-ssh-")) {
    throw new Error(`拒绝清理非 Rainskills SSH 临时目录：${resolved}`);
  }
  fs.rmSync(resolved, { recursive: true, force: true });
}

function sshSessionOptions(session) {
  return session?.controlPath ? ["-o", `ControlPath=${session.controlPath}`] : [];
}

function closeSshSession(session, runner = runCommand) {
  if (!session || session.closed) return;
  session.closed = true;
  if (session.controlPath) {
    runner("ssh", [
      "-o", `ControlPath=${session.controlPath}`,
      "-O", "exit",
      "-p", String(session.target.port),
      session.target.host,
    ], { timeout: 10000 });
  }
  removeSshTempDirectory(session.tempDirectory);
}

async function establishSshSession(target, {
  interactive = process.stdin.isTTY && process.stdout.isTTY,
  runner = runCommand,
  attachedRunner = spawnAttached,
  createTempDirectory = createSshTempDirectory,
  write = (value) => process.stdout.write(value),
} = {}) {
  const normalized = normalizeRemoteTarget(target.host, target.port);
  const probe = runner("ssh", [...sshArgs(normalized), "true"], { timeout: 30000 });
  if (probe.error) throw new Error(`无法启动 SSH：${probe.error.message}`);
  if (probe.status === 0) {
    return {
      target: normalized,
      controlPath: null,
      tempDirectory: null,
      multiplexed: false,
      closed: false,
    };
  }

  const detail = String(probe.stderr || probe.stdout || "连接失败").trim();
  if (/REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(detail)) {
    throw new Error(`SSH 主机密钥已发生变化，已停止连接 ${normalized.host}。请先核对服务器指纹并修复 known_hosts`);
  }
  if (!/(Permission denied|Host key verification failed|authentication failed|no supported authentication methods)/i.test(detail)) {
    throw new Error(`无法通过 SSH 连接 ${normalized.host}：${detail}`);
  }
  if (!interactive) {
    write("\n[RAINSKILLS_USER_INPUT_REQUIRED:ssh_authentication]\n");
    write("该服务器需要确认主机指纹或输入 SSH 密码，请在交互终端继续。\n");
    return null;
  }

  const tempDirectory = createTempDirectory();
  fs.chmodSync(tempDirectory, 0o700);
  const controlPath = path.join(tempDirectory, "control");
  write("\n首次连接可能需要确认服务器指纹，并输入一次 SSH 密码。\n");
  write("密码由系统 ssh 直接读取，Rainskills 不会保存。完成后安装将自动继续。\n\n");
  const result = await attachedRunner(
    "ssh",
    [
      "-o", "ControlMaster=yes",
      "-o", "ControlPersist=600",
      "-o", `ControlPath=${controlPath}`,
      "-o", "BatchMode=no",
      "-o", "ConnectTimeout=10",
      "-p", String(normalized.port),
      normalized.host,
      "true",
    ],
    { env: process.env, interactive: true },
    null
  );
  if (result.signal || result.code !== 0) {
    removeSshTempDirectory(tempDirectory);
    if (result.signal) throw new Error(`SSH 认证被信号 ${result.signal} 中断`);
    throw new Error(`SSH 认证未完成，无法连接 ${normalized.host}`);
  }
  return {
    target: normalized,
    controlPath,
    tempDirectory,
    multiplexed: true,
    closed: false,
  };
}

function targetChoicesForPlatform(platform) {
  if (platform === "linux") {
    return [
      { value: "local-linux", label: "安装到本地" },
      { value: "remote-linux", label: "安装到 Linux 服务器" },
    ];
  }
  if (platform === "darwin") {
    return [
      { value: "local-macos", label: "安装到本地" },
      { value: "remote-linux", label: "安装到 Linux 服务器" },
    ];
  }
  if (platform === "win32") {
    return [
      { value: "local-windows", label: "安装到本地" },
      { value: "remote-linux", label: "安装到 Linux 服务器" },
    ];
  }
  return [];
}

function controlHostPlatform(onboarding, fallbackPlatform = process.platform) {
  if (onboarding?.control_mode === "windows-native" || onboarding?.control_mode === "wsl") {
    return "win32";
  }
  return fallbackPlatform;
}

function normalizeRemoteTarget(host, port = 22) {
  const normalizedHost = String(host || "").trim();
  const normalizedPort = Number.parseInt(String(port), 10);
  if (!/^(?:[A-Za-z0-9_.-]+@)?[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(normalizedHost) || normalizedHost.startsWith("-")) {
    throw new Error("SSH 地址无效，请填写 user@host 或 ~/.ssh/config 中的主机别名");
  }
  if (!Number.isInteger(normalizedPort) || normalizedPort < 1 || normalizedPort > 65535 || String(port).trim() !== String(normalizedPort)) {
    throw new Error("SSH 端口必须是 1 到 65535 之间的整数");
  }
  return { host: normalizedHost, port: normalizedPort };
}

function normalizeConsoleHost(value) {
  let host = String(value || "").trim();
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  if (net.isIP(host)) return host;
  if (/^[0-9.]+$/.test(host)) {
    throw new Error("Console 地址无效，请填写 IP 或域名，不要包含协议、端口或路径");
  }
  const validDomain = host.length <= 253
    && host.split(".").every((label) => (
      label.length >= 1
      && label.length <= 63
      && /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label)
    ));
  if (!validDomain) {
    throw new Error("Console 地址无效，请填写 IP 或域名，不要包含协议、端口或路径");
  }
  return host.toLowerCase();
}

function consoleUrlForHost(host) {
  const normalized = normalizeConsoleHost(host);
  const urlHost = net.isIP(normalized) === 6 ? `[${normalized}]` : normalized;
  return `http://${urlHost}:7070`;
}

function sshTargetHost(target) {
  return String(target || "").split("@").pop();
}

function resolveSshHostname(target, runner = runCommand) {
  const normalized = normalizeRemoteTarget(target.host, target.port);
  const result = runner("ssh", ["-G", "-p", String(normalized.port), normalized.host], {
    timeout: 10000,
  });
  if (!result.error && result.status === 0) {
    const hostnameLine = String(result.stdout || "")
      .split("\n")
      .find((line) => /^hostname\s+/i.test(line.trim()));
    if (hostnameLine) {
      const hostname = hostnameLine.trim().split(/\s+/, 2)[1];
      try {
        return normalizeConsoleHost(hostname);
      } catch {
        // Fall back to the literal SSH target below.
      }
    }
  }
  return normalizeConsoleHost(sshTargetHost(normalized.host));
}

function buildRemoteConsoleCandidates({
  explicitHost = "",
  effectiveSshHost = "",
  sshTarget = "",
  reportedEip = "",
  primaryIp = "",
} = {}) {
  const candidates = [];
  const seen = new Set();
  const values = [
    { value: explicitHost, required: Boolean(explicitHost) },
    { value: effectiveSshHost, required: false },
    { value: sshTarget ? sshTargetHost(sshTarget) : "", required: false },
    { value: reportedEip, required: false },
    { value: primaryIp, required: false },
  ];
  for (const { value, required } of values) {
    if (!value) continue;
    let url;
    try {
      url = consoleUrlForHost(value);
    } catch (error) {
      if (required) throw error;
      continue;
    }
    if (!seen.has(url)) {
      seen.add(url);
      candidates.push(url);
    }
  }
  return candidates;
}

function selectRemoteInstallationEip({
  explicitHost = "",
  effectiveSshHost = "",
  primaryIp = "",
} = {}) {
  for (const host of [explicitHost, effectiveSshHost, primaryIp]) {
    if (!host) continue;
    try {
      return normalizeConsoleHost(host);
    } catch {
      // Try the next evidence-backed host.
    }
  }
  return "";
}

async function selectReachableConsole(candidates, probe = probeConsole) {
  const attempts = [];
  for (const url of candidates) {
    try {
      const statusCode = await probe(url);
      attempts.push({ url, ok: true, statusCode });
      return { consoleUrl: url, attempts };
    } catch (error) {
      attempts.push({ url, ok: false, error: error.message });
    }
  }
  return { consoleUrl: null, attempts };
}

async function resolveRemoteConsole({
  candidates,
  interactive = process.stdin.isTTY && process.stdout.isTTY,
  ask,
  write = (value) => process.stdout.write(value),
  probe = probeConsole,
}) {
  const automatic = await selectReachableConsole(candidates, probe);
  if (automatic.consoleUrl) return automatic;

  write("\nRainbond 已启动，但自动发现的 Console 地址不可访问：\n");
  for (const attempt of automatic.attempts) {
    write(`- ${attempt.url}：${attempt.error || "访问失败"}\n`);
  }
  if (!interactive) {
    write("\n[RAINSKILLS_USER_INPUT_REQUIRED:console_address]\n");
    write("请提供服务器公网 IP 或域名，并在原命令后添加 --console-host <IP或域名>。\n");
    return null;
  }

  let prompt;
  let ownsPrompt = false;
  if (!ask) {
    prompt = readline.createInterface({ input: process.stdin, output: process.stdout });
    ownsPrompt = true;
    ask = (question) => prompt.question(question);
  }
  try {
    const answer = await ask("请输入服务器公网 IP 或域名: ");
    const consoleUrl = consoleUrlForHost(answer);
    const statusCode = await probe(consoleUrl);
    write(`已选择 Console 地址：${consoleUrl}\n`);
    return {
      consoleUrl,
      attempts: [...automatic.attempts, { url: consoleUrl, ok: true, statusCode }],
    };
  } catch (error) {
    throw new Error(`提供的 Console 地址不可访问：${error.message}`);
  } finally {
    if (ownsPrompt) prompt.close();
  }
}

function sshArgs(target, session = null) {
  return [
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=10",
    ...sshSessionOptions(session),
    "-p", String(target.port),
    target.host,
  ];
}

async function selectInstallTarget({
  platform,
  options = {},
  savedTarget = null,
  interactive = process.stdin.isTTY && process.stdout.isTTY,
  ask,
  write = (value) => process.stdout.write(value),
}) {
  if (savedTarget?.kind) return savedTarget;

  const choices = targetChoicesForPlatform(platform);
  if (choices.length === 0) {
    throw new Error(`不支持当前控制端系统 ${platform}`);
  }

  let prompt;
  let ownsPrompt = false;
  if (!ask && interactive) {
    prompt = readline.createInterface({ input: process.stdin, output: process.stdout });
    ownsPrompt = true;
    ask = (question) => prompt.question(question);
  }

  try {
    let requestedKind = options.target || (options.ssh ? "remote-linux" : "");
    if (requestedKind && !choices.some((choice) => choice.value === requestedKind)) {
      throw new Error(`当前 ${platform} 不能使用安装目标 ${requestedKind}`);
    }

    write(`\n检测到当前设备为 ${platform === "darwin" ? "macOS" : platform === "win32" ? "Windows" : "Linux"}。\n`);
    if (!requestedKind && !interactive) {
      write("\n[RAINSKILLS_USER_INPUT_REQUIRED:platform_install_target]\n");
      for (const choice of choices) write(`- ${choice.label}\n`);
      if (platform === "linux") write("选择当前设备：--target local-linux\n");
      if (platform === "darwin") write("选择当前 Mac：--target local-macos\n");
      if (platform === "win32") write("选择当前 Windows 设备：--target local-windows\n");
      write("选择 Linux 服务器：--target remote-linux --ssh <user@host> [--ssh-port 22]\n");
      return null;
    }

    if (!requestedKind) {
      write("\n请选择 Rainbond 安装位置：\n");
      choices.forEach((choice, index) => write(`  ${index + 1}) ${choice.label}\n`));
      while (!requestedKind) {
        const answer = (await ask(`请输入选项 [1-${choices.length}，回车默认 1]: `)).trim();
        const index = answer === "" ? 0 : Number.parseInt(answer, 10) - 1;
        if (Number.isInteger(index) && choices[index]) requestedKind = choices[index].value;
        else write(`请输入 1 到 ${choices.length} 之间的选项。\n`);
      }
    }

    if (requestedKind !== "remote-linux") {
      return { kind: requestedKind, host: os.hostname(), sshPort: null };
    }

    if (!options.ssh && !interactive) {
      write("\n[RAINSKILLS_USER_INPUT_REQUIRED:platform_install_target]\n");
      write("请提供 Linux SSH 地址，并重新执行：--target remote-linux --ssh <user@host> [--ssh-port 22]\n");
      return null;
    }

    let remoteHost = options.ssh || "";
    while (!remoteHost) {
      remoteHost = (await ask("Linux SSH 地址（例如 root@192.168.1.20 或主机别名）: ")).trim();
      if (!remoteHost) write("SSH 地址不能为空。\n");
    }
    let remotePort = options.sshPort ?? 22;
    if (!options.ssh && interactive) {
      const answer = (await ask("SSH 端口 [回车默认 22]: ")).trim();
      remotePort = answer || 22;
    }
    const remote = normalizeRemoteTarget(remoteHost, remotePort);
    return { kind: "remote-linux", host: remote.host, sshPort: remote.port };
  } finally {
    if (ownsPrompt) prompt.close();
  }
}

const REMOTE_INSPECTION_SCRIPT = String.raw`set -u
platform="$(uname -s 2>/dev/null | tr '[:upper:]' '[:lower:]')"
case "$platform" in linux) platform=linux ;; *) platform="$platform" ;; esac
arch="$(uname -m 2>/dev/null)"
case "$arch" in x86_64|amd64) arch=x64 ;; aarch64|arm64) arch=arm64 ;; esac
cpu="$(getconf _NPROCESSORS_ONLN 2>/dev/null || nproc 2>/dev/null || echo 0)"
memory_kb="$(awk '/^MemTotal:/ { print $2; exit }' /proc/meminfo 2>/dev/null || echo 0)"
memory_bytes="$((memory_kb * 1024))"
disk_kb="$(df -Pk "$HOME" 2>/dev/null | awk 'END { print $4 }')"
disk_bytes="$((disk_kb * 1024))"
occupied=""
for port in 80 443 6060 7070; do
  if command -v ss >/dev/null 2>&1 && ss -lntH 2>/dev/null | awk '{print $4}' | grep -Eq "(^|:)$port$"; then
    if [ -n "$occupied" ]; then occupied="$occupied,$port"; else occupied="$port"; fi
  elif command -v lsof >/dev/null 2>&1 && lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    if [ -n "$occupied" ]; then occupied="$occupied,$port"; else occupied="$port"; fi
  fi
done
if [ "$(id -u)" -eq 0 ] || sudo -n true >/dev/null 2>&1; then privilege=true; else privilege=false; fi
if docker info >/dev/null 2>&1; then
  docker_ok=true
  if docker inspect rainbond >/dev/null 2>&1; then rainbond=true; else rainbond=false; fi
elif sudo -n docker info >/dev/null 2>&1; then
  docker_ok=true
  if sudo -n docker inspect rainbond >/dev/null 2>&1; then rainbond=true; else rainbond=false; fi
else
  docker_ok=false
  rainbond=false
fi
if systemctl is-active --quiet firewalld 2>/dev/null; then firewall=firewalld
elif command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -qi 'Status: active'; then firewall=ufw
else firewall=inactive
fi
if awk 'NR > 1 { found=1 } END { exit !found }' /proc/swaps 2>/dev/null; then swap=true; else swap=false; fi
primary_ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
if command -v curl >/dev/null 2>&1 && curl -fsSI --max-time 10 https://get.rainbond.com/ >/dev/null 2>&1; then network=true
elif command -v wget >/dev/null 2>&1 && wget -q --spider --timeout=10 https://get.rainbond.com/ >/dev/null 2>&1; then network=true
else network=false
fi
printf 'PLATFORM=%s\n' "$platform"
printf 'ARCH=%s\n' "$arch"
printf 'CPU_CORES=%s\n' "$cpu"
printf 'MEMORY_BYTES=%s\n' "$memory_bytes"
printf 'DISK_BYTES=%s\n' "$disk_bytes"
printf 'OCCUPIED_PORTS=%s\n' "$occupied"
printf 'HAS_PRIVILEGE=%s\n' "$privilege"
printf 'HAS_DOCKER=%s\n' "$docker_ok"
printf 'HAS_RAINBOND=%s\n' "$rainbond"
printf 'FIREWALL=%s\n' "$firewall"
printf 'SWAP_ENABLED=%s\n' "$swap"
printf 'PRIMARY_IP=%s\n' "$primary_ip"
printf 'NETWORK_REACHABLE=%s\n' "$network"
`;

function parseKeyValueOutput(output) {
  const values = {};
  for (const line of String(output || "").split("\n")) {
    const separator = line.indexOf("=");
    if (separator > 0) values[line.slice(0, separator)] = line.slice(separator + 1);
  }
  return values;
}

function inspectRemoteSystem(target, runner = runCommand, session = null) {
  const normalized = normalizeRemoteTarget(target.host, target.port);
  const result = runner("ssh", [...sshArgs(normalized, session), "bash", "-s"], {
    timeout: 30000,
    input: REMOTE_INSPECTION_SCRIPT,
  });
  if (result.error) throw new Error(`无法启动 SSH：${result.error.message}`);
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || "连接失败").trim();
    throw new Error(`无法通过 SSH 连接 ${normalized.host}：${detail}`);
  }
  const values = parseKeyValueOutput(result.stdout);
  const number = (key) => Number.parseInt(values[key] || "0", 10);
  const boolean = (key) => values[key] === "true";
  const occupiedPorts = (values.OCCUPIED_PORTS || "")
    .split(",")
    .filter(Boolean)
    .map((value) => Number(value));
  if (occupiedPorts.some((port) => !Number.isInteger(port) || port < 1 || port > 65535)) {
    throw new Error("远程端口检查结果无效，请重新执行安装");
  }
  return {
    platform: values.PLATFORM || "unknown",
    arch: values.ARCH || "unknown",
    cpuCores: number("CPU_CORES"),
    memoryBytes: number("MEMORY_BYTES"),
    diskBytes: number("DISK_BYTES"),
    occupiedPorts,
    hasPrivilege: boolean("HAS_PRIVILEGE"),
    hasDocker: boolean("HAS_DOCKER"),
    hasRainbond: boolean("HAS_RAINBOND"),
    hasOrbStack: false,
    firewall: values.FIREWALL || "inactive",
    swapEnabled: boolean("SWAP_ENABLED"),
    primaryIp: values.PRIMARY_IP || null,
    networkReachable: boolean("NETWORK_REACHABLE"),
  };
}

function assertCommandResult(result, action) {
  if (result.error) throw new Error(`${action}：${result.error.message}`);
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || "执行失败").trim();
    throw new Error(`${action}：${detail}`);
  }
}

function remoteWorkspacePath(operationId) {
  assertOperationId(operationId);
  return `.rainbond/platform-installer/${operationId}`;
}

function prepareRemoteInstaller(target, operationId, installerPath, runner = runCommand, session = null) {
  const normalized = normalizeRemoteTarget(target.host, target.port);
  const workspace = remoteWorkspacePath(operationId);
  const prepareScript = [
    "set -eu",
    'workspace="$HOME/.rainbond/platform-installer/$1"',
    'mkdir -p "$workspace"',
    'chmod 700 "$HOME/.rainbond" "$HOME/.rainbond/platform-installer" "$workspace"',
    "",
  ].join("\n");
  const prepare = runner("ssh", [...sshArgs(normalized, session), "bash", "-s", "--", operationId], {
    timeout: 30000,
    input: prepareScript,
  });
  assertCommandResult(prepare, `无法在 ${normalized.host} 创建安装目录`);

  const copy = runner("scp", [
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=10",
    ...sshSessionOptions(session),
    "-P", String(normalized.port),
    installerPath,
    `${normalized.host}:${workspace}/rainbond-install.sh`,
  ], { timeout: 120000 });
  assertCommandResult(copy, `无法把官方安装脚本传输到 ${normalized.host}`);
  return workspace;
}

const REMOTE_INSTALL_SCRIPT = [
  "set -euo pipefail",
  'workspace="$HOME/$1"',
  'expected_digest="$2"',
  'eip="$3"',
  'installer="$workspace/rainbond-install.sh"',
  'log="$workspace/install.log"',
  "if command -v sha256sum >/dev/null 2>&1; then",
  '  actual_digest="$(sha256sum "$installer" | awk \'{print $1}\')"',
  "elif command -v shasum >/dev/null 2>&1; then",
  '  actual_digest="$(shasum -a 256 "$installer" | awk \'{print $1}\')"',
  "else",
  '  echo "远程服务器缺少 SHA-256 校验工具" >&2',
  "  exit 1",
  "fi",
  'if [ "$actual_digest" != "$expected_digest" ]; then',
  '  echo "远程官方安装脚本摘要不匹配，已停止执行" >&2',
  "  exit 1",
  "fi",
  'if ! bash -n "$installer"; then',
  '  echo "远程官方安装脚本 Bash 语法检查失败，已停止执行" >&2',
  "  exit 1",
  "fi",
  'chmod 600 "$installer"',
  'child_pid=""',
  "cleanup() {",
  '  if [ -n "$child_pid" ] && kill -0 "$child_pid" 2>/dev/null; then',
  '    if [ "$(id -u)" -eq 0 ]; then kill -TERM -- "-$child_pid" 2>/dev/null || true',
  '    else sudo -n kill -TERM -- "-$child_pid" 2>/dev/null || true',
  "    fi",
  "  fi",
  "}",
  "trap cleanup INT TERM HUP",
  'export RAINBOND_INSTALL_LANG="zh"',
  'if [ -n "$eip" ]; then export EIP="$eip"; fi',
  'if [ "$(id -u)" -eq 0 ]; then',
  '  if command -v setsid >/dev/null 2>&1; then setsid bash "$installer" > >(tee -a "$log") 2>&1 &',
  '  else bash "$installer" > >(tee -a "$log") 2>&1 &',
  "  fi",
  "else",
  '  if command -v setsid >/dev/null 2>&1; then sudo -n env RAINBOND_INSTALL_LANG="$RAINBOND_INSTALL_LANG" EIP="${EIP:-}" setsid bash "$installer" > >(tee -a "$log") 2>&1 &',
  '  else sudo -n env RAINBOND_INSTALL_LANG="$RAINBOND_INSTALL_LANG" EIP="${EIP:-}" bash "$installer" > >(tee -a "$log") 2>&1 &',
  "  fi",
  "fi",
  'child_pid="$!"',
  "set +e",
  'wait "$child_pid"',
  'status="$?"',
  "set -e",
  "trap - INT TERM HUP",
  'exit "$status"',
  "",
].join("\n");

function remoteInstallerInvocation(target, operationId, digest, primaryIp = "", session = null) {
  const normalized = normalizeRemoteTarget(target.host, target.port);
  const workspace = remoteWorkspacePath(operationId);
  if (!/^[a-f0-9]{64}$/.test(digest || "")) throw new Error("安装脚本 SHA-256 无效");
  const eip = String(primaryIp || "").trim();
  if (eip && !/^[A-Za-z0-9_.:-]+$/.test(eip)) throw new Error("远程服务器地址无效");
  return {
    command: "ssh",
    args: [...sshArgs(normalized, session), "bash", "-s", "--", workspace, digest, eip],
    input: REMOTE_INSTALL_SCRIPT,
  };
}

const REMOTE_VERIFICATION_SCRIPT = [
  "set -u",
  'docker_prefix=""',
  "if docker info >/dev/null 2>&1; then :",
  'elif sudo -n docker info >/dev/null 2>&1; then docker_prefix="sudo -n "',
  "else echo 'CONTAINER_STATE=false'; exit 0",
  "fi",
  'container_state="$(${docker_prefix}docker inspect rainbond --format \'{{.State.Running}}\' 2>/dev/null || echo false)"',
  'nodes="$(${docker_prefix}docker exec rainbond /bin/k3s kubectl get nodes --no-headers 2>/dev/null || true)"',
  "if printf '%s\\n' \"$nodes\" | grep -qE '\\bReady\\b' && ! printf '%s\\n' \"$nodes\" | grep -qE '\\bNotReady\\b'; then node_ready=true; else node_ready=false; fi",
  'pods="$(${docker_prefix}docker exec rainbond /bin/k3s kubectl get pods -n rbd-system --no-headers 2>/dev/null || true)"',
  "if [ -z \"$pods\" ]; then components_ready=false; elif printf '%s\\n' \"$pods\" | awk 'NF { split($2, ready, \"/\"); if ($3 != \"Completed\" && $3 != \"Succeeded\" && ($3 != \"Running\" || ready[1] != ready[2])) bad=1 } END { exit bad }'; then components_ready=true; else components_ready=false; fi",
  'eip="$(${docker_prefix}docker inspect rainbond --format \'{{range .Config.Env}}{{println .}}{{end}}\' 2>/dev/null | awk -F= \'/^EIP=/ { sub(/^EIP=/, ""); print; exit }\')"',
  "printf 'CONTAINER_STATE=%s\\n' \"$container_state\"",
  "printf 'NODE_READY=%s\\n' \"$node_ready\"",
  "printf 'COMPONENTS_READY=%s\\n' \"$components_ready\"",
  "printf 'EIP=%s\\n' \"$eip\"",
  "",
].join("\n");

function verifyRemoteRainbond(target, fallbackHost, runner = runCommand, session = null) {
  const normalized = normalizeRemoteTarget(target.host, target.port);
  const result = runner("ssh", [...sshArgs(normalized, session), "bash", "-s"], {
    timeout: 30000,
    input: REMOTE_VERIFICATION_SCRIPT,
  });
  assertCommandResult(result, `无法验证 ${normalized.host} 上的 Rainbond`);
  const values = parseKeyValueOutput(result.stdout);
  if (values.CONTAINER_STATE !== "true") throw new Error("rainbond 容器未处于运行状态");
  if (values.NODE_READY !== "true") throw new Error("Rainbond 内置 K3s 节点尚未 Ready");
  if (values.COMPONENTS_READY !== "true") throw new Error("rbd-system 仍有未就绪组件");
  return {
    containerState: values.CONTAINER_STATE,
    nodeReady: true,
    componentsReady: true,
    reportedEip: values.EIP || fallbackHost || null,
  };
}

async function verifyRemoteDeployment({
  target,
  fallbackHost = "",
  explicitHost = "",
  effectiveSshHost = "",
  session = null,
  runner = runCommand,
  probe = probeConsole,
  interactive = process.stdin.isTTY && process.stdout.isTTY,
  ask,
  write = (value) => process.stdout.write(value),
}) {
  const runtime = verifyRemoteRainbond(target, fallbackHost, runner, session);
  const candidates = buildRemoteConsoleCandidates({
    explicitHost,
    effectiveSshHost,
    sshTarget: target.host,
    reportedEip: runtime.reportedEip,
    primaryIp: fallbackHost,
  });
  const selection = await resolveRemoteConsole({
    candidates,
    interactive,
    ask,
    write,
    probe,
  });
  if (!selection) return null;
  return {
    ...runtime,
    consoleUrl: selection.consoleUrl,
    consoleAttempts: selection.attempts,
  };
}

function commandSucceeds(command, args) {
  const result = runCommand(command, args);
  return result.status === 0;
}

function dockerCommand(args) {
  let result = runCommand("docker", args, { timeout: 20000 });
  if (result.status === 0 || process.platform !== "linux" || process.getuid?.() === 0) return result;
  result = runCommand("sudo", ["-n", "docker", ...args], { timeout: 20000 });
  return result;
}

function availableDiskBytes(targetPath) {
  const result = runCommand("df", ["-Pk", targetPath]);
  if (result.status !== 0) return 0;
  const lines = result.stdout.trim().split("\n");
  const fields = (lines[lines.length - 1] || "").trim().split(/\s+/);
  const availableKb = Number.parseInt(fields[3], 10);
  return Number.isFinite(availableKb) ? availableKb * 1024 : 0;
}

function occupiedPorts() {
  const ports = new Set();
  const ss = runCommand("ss", ["-lntH"]);
  if (ss.status === 0) {
    for (const line of ss.stdout.split("\n")) {
      const match = line.match(/(?:^|\s)(?:\[[^\]]+\]|[^\s:]+):(\d+)\s/);
      if (match) ports.add(Number(match[1]));
    }
  } else {
    const lsof = runCommand("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN"]);
    for (const match of (lsof.stdout || "").matchAll(/TCP\s+\S+:(\d+)\s+\(LISTEN\)/g)) {
      ports.add(Number(match[1]));
    }
  }
  return POLICY.required_ports.filter((port) => ports.has(port));
}

function detectFirewall() {
  if (process.platform !== "linux") return "not-applicable";
  if (commandSucceeds("systemctl", ["is-active", "--quiet", "firewalld"])) return "firewalld";
  const ufw = runCommand("ufw", ["status"]);
  if (ufw.status === 0 && /Status:\s+active/i.test(ufw.stdout)) return "ufw";
  return "inactive";
}

function detectSwap() {
  if (process.platform !== "linux") return false;
  try {
    return fs.readFileSync("/proc/swaps", "utf8").trim().split("\n").length > 1;
  } catch {
    return false;
  }
}

function detectPrimaryIp() {
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const address of addresses || []) {
      if (address.family === "IPv4" && !address.internal && address.address !== "0.0.0.0") {
        return address.address;
      }
    }
  }
  return null;
}

function inspectSystem() {
  const dockerInfo = dockerCommand(["info", "--format", "{{.ServerVersion}}"]);
  const rainbondInfo = dockerCommand(["inspect", "rainbond", "--format", "{{.State.Status}}"]);
  const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
  const hasPrivilege = process.platform !== "linux" || isRoot || commandSucceeds("sudo", ["-n", "true"]);
  const hasOrbStack = commandSucceeds("orb", ["version"]) ||
    fs.existsSync("/Applications/OrbStack.app") ||
    fs.existsSync(path.join(os.homedir(), "Applications", "OrbStack.app"));

  return {
    platform: process.platform,
    arch: process.arch,
    cpuCores: os.cpus().length,
    memoryBytes: os.totalmem(),
    diskBytes: availableDiskBytes(os.homedir()),
    occupiedPorts: occupiedPorts(),
    hasPrivilege,
    hasDocker: dockerInfo.status === 0,
    hasRainbond: rainbondInfo.status === 0,
    hasOrbStack,
    firewall: detectFirewall(),
    swapEnabled: detectSwap(),
    primaryIp: detectPrimaryIp(),
    networkReachable: true,
  };
}

function gibibytes(bytes) {
  return bytes / 1024 ** 3;
}

function evaluatePreflight(facts) {
  const blockers = [];
  const effects = [];
  const minimums = POLICY.minimums;
  if (!POLICY.supported_platforms.includes(facts.platform)) {
    blockers.push(`不支持当前系统 ${facts.platform}，首版仅支持 Linux 和 macOS`);
  }
  if (!POLICY.supported_architectures.includes(facts.arch)) {
    blockers.push(`不支持当前架构 ${facts.arch}，仅支持 x64 和 arm64`);
  }
  if (facts.cpuCores < minimums.cpu_cores) blockers.push(`CPU 至少需要 ${minimums.cpu_cores} 核，当前 ${facts.cpuCores} 核`);
  if (facts.memoryBytes < minimums.memory_bytes) blockers.push(`内存至少需要 8 GB，当前 ${gibibytes(facts.memoryBytes).toFixed(1)} GB`);
  if (facts.diskBytes < minimums.disk_bytes) blockers.push(`可用磁盘至少需要 50 GB，当前 ${gibibytes(facts.diskBytes).toFixed(1)} GB`);
  if (facts.occupiedPorts.length > 0) blockers.push(`端口 ${facts.occupiedPorts.join("、")} 已被占用`);
  if (facts.platform === "linux" && !facts.hasPrivilege) blockers.push("Linux 安装需要 root 或已配置可用的 sudo -n 权限");
  if (facts.hasRainbond) blockers.push("检测到已有 rainbond 容器，请返回并选择“已经有，填写平台地址”");
  if (facts.networkReachable === false) blockers.push("无法访问 Rainbond 官方安装地址，请检查网络或代理");

  if (facts.platform === "linux") {
    if (!facts.hasDocker) effects.push("安装并启动 Docker 运行环境");
    if (facts.firewall === "firewalld") effects.push("停止并禁用 firewalld");
    if (facts.firewall === "ufw") effects.push("停止并禁用 ufw");
    if (facts.swapEnabled) effects.push("关闭 swap 并更新 /etc/fstab");
    effects.push("加载并持久化 Rainbond 所需的内核模块");
  } else if (facts.platform === "darwin" && !facts.hasOrbStack) {
    effects.push("下载、安装并启动 OrbStack");
  }
  effects.push("启动 privileged rainbond 容器并写入持久化数据");

  return { ok: blockers.length === 0, blockers, effects };
}

function extractConsoleUrl(output) {
  const matches = output.match(/https?:\/\/[^\s'"<>]+/g) || [];
  for (const candidate of matches) {
    try {
      const parsed = new URL(candidate.replace(/[),.;]+$/, ""));
      if (parsed.port === "7070") {
        parsed.pathname = "/";
        parsed.search = "";
        parsed.hash = "";
        return parsed.toString().replace(/\/$/, "");
      }
    } catch {
      // Ignore malformed output from the wrapped installer.
    }
  }
  return null;
}

function onboardingStatePath() {
  return path.join(os.homedir(), ".rainbond", "rainskills-onboarding-v1.json");
}

function operationPaths(operationId) {
  const root = path.join(os.homedir(), ".rainbond", "platform-installer", operationId);
  return {
    root,
    state: path.join(root, "state.json"),
    events: path.join(root, "events.jsonl"),
    log: path.join(root, "install.log"),
    installer: path.join(root, "rainbond-install.sh"),
  };
}

function now() {
  return new Date().toISOString();
}

function createPlatformState(operationId, paths) {
  return {
    schema: PLATFORM_STATE_SCHEMA,
    version: 1,
    operation_id: operationId,
    installation_id: crypto.randomUUID(),
    package_version: packageManifest.version,
    updated_at: now(),
    stage: "target-selection",
    status: "pending",
    control_platform: process.platform,
    target_kind: null,
    host: null,
    ssh_port: null,
    effective_ssh_host: null,
    console_host: null,
    remote_workspace: null,
    artifact_url: null,
    artifact_sha256: null,
    detected_rainbond_version: POLICY.installer.tested_rainbond_version,
    approved_effects: [],
    console_url: null,
    log_path: paths.log,
  };
}

function updateState(filePath, state, values) {
  const next = { ...state, ...values, updated_at: now() };
  atomicWriteJson(filePath, next);
  return next;
}

function appendEvent(paths, state, stage, status, extra = {}) {
  const sequence = (state.last_sequence || 0) + 1;
  const event = {
    schema: PROGRESS_SCHEMA,
    operation_id: state.operation_id,
    sequence,
    timestamp: now(),
    stage,
    status,
    ...extra,
  };
  fs.appendFileSync(paths.events, `${JSON.stringify(event)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.chmodSync(paths.events, 0o600);
  try {
    fs.writeSync(3, `${JSON.stringify(event)}\n`);
  } catch {
    // FD 3 is optional and normally absent in a human terminal.
  }
  state.last_sequence = sequence;
  atomicWriteJson(paths.state, state);
}

function updateOnboarding(state, values) {
  const next = { ...state, ...values, updated_at: now() };
  atomicWriteJson(onboardingStatePath(), next);
  return next;
}

function allowedInstallerUrl(url) {
  const parsed = new URL(url);
  return parsed.protocol === "https:" && POLICY.installer.allowed_origins.includes(parsed.origin);
}

function probeInstallerEndpoint(url, redirectCount = 0) {
  return new Promise((resolve) => {
    if (!allowedInstallerUrl(url) || redirectCount > 3) {
      resolve(false);
      return;
    }
    const request = https.request(
      url,
      {
        method: "HEAD",
        headers: { "user-agent": `rainskills/${packageManifest.version}` },
      },
      (response) => {
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          response.resume();
          const redirected = new URL(response.headers.location, url).toString();
          probeInstallerEndpoint(redirected, redirectCount + 1).then(resolve);
          return;
        }
        response.resume();
        resolve(response.statusCode >= 200 && response.statusCode < 400);
      }
    );
    request.setTimeout(10000, () => request.destroy());
    request.on("error", () => resolve(false));
    request.end();
  });
}

function downloadInstaller(url, destination, paths, state, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (!allowedInstallerUrl(url)) {
      reject(new Error(`官方脚本跳转到了未允许的来源：${url}`));
      return;
    }
    if (redirectCount > 3) {
      reject(new Error("官方安装脚本重定向次数过多"));
      return;
    }
    const request = https.get(url, { headers: { "user-agent": `rainskills/${packageManifest.version}` } }, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        const redirected = new URL(response.headers.location, url).toString();
        downloadInstaller(redirected, destination, paths, state, redirectCount + 1).then(resolve, reject);
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`官方安装脚本下载失败，HTTP ${response.statusCode}`));
        return;
      }

      const declaredLength = Number(response.headers["content-length"] || 0);
      const total = Number.isSafeInteger(declaredLength) && declaredLength > 0 ? declaredLength : 0;
      if (total > POLICY.installer.max_bytes) {
        response.resume();
        reject(new Error(`官方安装脚本大小超出限制（最大 ${POLICY.installer.max_bytes} bytes）`));
        return;
      }
      let received = 0;
      let lastReported = -1;
      const chunks = [];
      let settled = false;
      const fail = (error) => {
        if (settled) return;
        settled = true;
        activeRequest = null;
        reject(error);
      };
      response.on("data", (chunk) => {
        received += chunk.length;
        if (received > POLICY.installer.max_bytes) {
          response.destroy(new Error(`官方安装脚本大小超出限制（最大 ${POLICY.installer.max_bytes} bytes）`));
          return;
        }
        chunks.push(chunk);
        if (total > 0) {
          const percent = Math.floor((received / total) * 100);
          if (percent >= lastReported + 10 || percent === 100) {
            process.stdout.write(`下载官方安装脚本：${percent}% (${received}/${total} bytes)\n`);
            lastReported = percent;
          }
        }
      });
      response.on("end", () => {
        if (settled) return;
        const tempPath = `${destination}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.part`;
        try {
          fs.writeFileSync(tempPath, Buffer.concat(chunks), { flag: "wx", mode: 0o600 });
          fs.renameSync(tempPath, destination);
          fs.chmodSync(destination, 0o600);
          settled = true;
          activeRequest = null;
          resolve({ finalUrl: url, bytes: received });
        } catch (error) {
          try {
            if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
          } catch {
            // The original write error is more useful than cleanup failure.
          }
          fail(error);
        }
      });
      response.on("error", fail);
    });
    activeRequest = request;
    request.setTimeout(30000, () => request.destroy(new Error("下载官方安装脚本超时")));
    request.on("error", (error) => {
      activeRequest = null;
      reject(error);
    });
  });
}

function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function validateInstaller(filePath, {
  skipSyntaxCheck = process.platform === "win32",
  syntaxRunner = spawnSync,
} = {}) {
  const info = fs.lstatSync(filePath);
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error("下载内容不是安全的普通文件");
  }
  if (info.size <= 0 || info.size > POLICY.installer.max_bytes) {
    throw new Error(`官方安装脚本大小超出限制（最大 ${POLICY.installer.max_bytes} bytes）`);
  }
  const content = fs.readFileSync(filePath);
  if (content.includes(0)) {
    throw new Error("下载内容不是预期的 Bash 安装脚本");
  }
  const firstLine = content.toString("utf8", 0, Math.min(content.length, 128)).split("\n", 1)[0].replace(/\r$/, "");
  if (firstLine !== "#!/bin/bash" && firstLine !== "#!/usr/bin/env bash") {
    throw new Error("下载内容不是预期的 Bash 安装脚本");
  }
  if (!skipSyntaxCheck) {
    const syntax = syntaxRunner("bash", ["-n", filePath], {
      encoding: "utf8",
      timeout: 10000,
    });
    if (syntax.error || syntax.status !== 0) {
      throw new Error("Rainbond 官方安装脚本 Bash 语法检查失败");
    }
  }
  return crypto.createHash("sha256").update(content).digest("hex");
}

function quarantineInstaller(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const info = fs.lstatSync(filePath);
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error(`安装脚本缓存不是安全的普通文件：${filePath}`);
  }
  const quarantine = `${filePath}.invalid-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
  fs.renameSync(filePath, quarantine);
  return quarantine;
}

async function ensureTrustedInstaller(destination, paths, state, options = {}) {
  if (fs.existsSync(destination)) {
    try {
      const sha256 = validateInstaller(destination, options);
      return {
        reused: true,
        finalUrl: state.artifact_url || POLICY.installer.url,
        bytes: fs.statSync(destination).size,
        sha256,
      };
    } catch (error) {
      quarantineInstaller(destination);
      process.stderr.write(`已隔离未通过检查的安装脚本缓存：${error.message}\n`);
    }
  }
  const download = await downloadInstaller(POLICY.installer.url, destination, paths, state);
  try {
    return {
      ...download,
      reused: false,
      sha256: validateInstaller(destination, options),
    };
  } catch (error) {
    quarantineInstaller(destination);
    throw error;
  }
}

function spawnAttached(command, args, options, logPath) {
  return new Promise((resolve, reject) => {
    const { input, interactive = false, ...spawnOptions } = options;
    const logFd = logPath ? fs.openSync(logPath, "a", 0o600) : null;
    const detached = !interactive && process.platform !== "win32";
    const child = spawn(command, args, {
      ...spawnOptions,
      detached,
      stdio: interactive
        ? "inherit"
        : [input === undefined ? "inherit" : "pipe", "pipe", "pipe"],
    });
    activeChild = child;
    activeChildDetached = detached;
    if (input !== undefined) {
      child.stdin.end(input);
    }
    const forward = (stream, destination) => {
      stream.on("data", (chunk) => {
        destination.write(chunk);
        if (logFd !== null) fs.writeSync(logFd, chunk);
      });
    };
    if (!interactive) {
      forward(child.stdout, process.stdout);
      forward(child.stderr, process.stderr);
    }
    child.on("error", (error) => {
      if (logFd !== null) fs.closeSync(logFd);
      activeChild = null;
      activeChildDetached = false;
      reject(error);
    });
    child.on("close", (code, signal) => {
      if (logFd !== null) {
        fs.fsyncSync(logFd);
        fs.closeSync(logFd);
        fs.chmodSync(logPath, 0o600);
      }
      activeChild = null;
      activeChildDetached = false;
      resolve({ code, signal });
    });
  });
}

function dockerVerify(args) {
  const result = dockerCommand(args);
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || `docker ${args.join(" ")} 失败`).trim());
  }
  return result.stdout.trim();
}

function consoleUrlFromContainer(output) {
  const envOutput = dockerVerify(["inspect", "rainbond", "--format", "{{range .Config.Env}}{{println .}}{{end}}"]);
  const eipLine = envOutput.split("\n").find((line) => line.startsWith("EIP="));
  if (eipLine && eipLine.slice(4)) return `http://${eipLine.slice(4)}:7070`;
  return extractConsoleUrl(output);
}

function verifyRainbond(output) {
  const containerState = dockerVerify(["inspect", "rainbond", "--format", "{{.State.Running}}"]);
  if (containerState !== "true") throw new Error("rainbond 容器未处于运行状态");

  const nodes = dockerVerify(["exec", "rainbond", "/bin/k3s", "kubectl", "get", "nodes", "--no-headers"]);
  if (!/\bReady\b/.test(nodes) || /\bNotReady\b/.test(nodes)) throw new Error("Rainbond 内置 K3s 节点尚未 Ready");

  const pods = dockerVerify(["exec", "rainbond", "/bin/k3s", "kubectl", "get", "pods", "-n", "rbd-system", "--no-headers"]);
  const unhealthy = pods.split("\n").filter(Boolean).filter((line) => {
    const fields = line.trim().split(/\s+/);
    if (fields[2] === "Completed" || fields[2] === "Succeeded") return false;
    const [ready, total] = (fields[1] || "0/1").split("/");
    return fields[2] !== "Running" || ready !== total;
  });
  if (unhealthy.length > 0) throw new Error(`rbd-system 仍有未就绪组件：${unhealthy.slice(0, 3).join(" | ")}`);

  const consoleUrl = consoleUrlFromContainer(output);
  if (!consoleUrl) throw new Error("无法从已验证容器中确定 Console 地址");
  return { consoleUrl, containerState, nodeReady: true, componentsReady: true };
}

function probeConsole(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith("https:") ? https : http;
    const request = client.get(url, { timeout: 10000 }, (response) => {
      response.resume();
      if (response.statusCode >= 200 && response.statusCode < 500) resolve(response.statusCode);
      else reject(new Error(`Console 健康检查返回 HTTP ${response.statusCode}`));
    });
    request.on("timeout", () => request.destroy(new Error("Console 健康检查超时")));
    request.on("error", reject);
  });
}

function printPreflight(facts, assessment, target) {
  const location = target.kind === "remote-linux"
    ? `Linux 服务器 ${target.host}`
    : facts.platform === "darwin" ? "当前 Mac" : "当前 Linux 设备";
  process.stdout.write(`\n${location} 环境检查${assessment.ok ? "已通过" : "未通过"}：\n\n`);
  process.stdout.write(`${facts.cpuCores} 核 CPU / ${gibibytes(facts.memoryBytes).toFixed(1)} GB 内存 / ${gibibytes(facts.diskBytes).toFixed(1)} GB 可用磁盘\n`);
  if (facts.platform === "darwin") process.stdout.write("macOS 安装依赖 OrbStack，首次准备时间通常比 Linux 更长。\n");
  if (!assessment.ok) {
    process.stdout.write("\n需要先处理：\n");
    for (const blocker of assessment.blockers) process.stdout.write(`- ${blocker}\n`);
    return;
  }
  process.stdout.write("\n确认后将执行：\n");
  for (const effect of assessment.effects) process.stdout.write(`- ${effect}\n`);
}

function printWindowsPreflight(facts, assessment) {
  process.stdout.write(`\n本地（Windows / WSL2）环境检查${assessment.ok ? "已通过" : "未通过"}：\n\n`);
  process.stdout.write(`${facts.cpuCores} 核 CPU / ${gibibytes(facts.memoryBytes).toFixed(1)} GB 内存 / ${gibibytes(facts.diskBytes).toFixed(1)} GB 可用磁盘\n`);
  if (!assessment.ok) {
    process.stdout.write("\n需要先处理：\n");
    for (const blocker of assessment.blockers) process.stdout.write(`- ${blocker}\n`);
    return;
  }
  process.stdout.write("\n确认后将执行：\n");
  for (const effect of assessment.effects) process.stdout.write(`- ${effect}\n`);
}

async function confirmInstall(assumeYes) {
  if (assumeYes) return true;
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stdout.write("\n[RAINSKILLS_USER_INPUT_REQUIRED:platform_install_confirmation]\n");
    process.stdout.write("确认上述系统变更后，重新执行相同命令并添加 --yes。\n");
    return false;
  }
  const prompt = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await prompt.question("\n是否开始安装 Rainbond？[y/N]: ");
    return /^(y|yes)$/i.test(answer.trim());
  } finally {
    prompt.close();
  }
}

async function confirmWindowsRestart() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stdout.write("\n[RAINSKILLS_USER_INPUT_REQUIRED:windows_restart]\n");
    process.stdout.write("Windows 组件已准备完成。请在交互终端重新执行相同命令，并确认一次系统重启。\n");
    return false;
  }
  const prompt = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await prompt.question("\n需要重启 Windows 才能继续，是否现在重启？[y/N]: ");
    return /^(y|yes)$/i.test(answer.trim());
  } finally {
    prompt.close();
  }
}

function windowsRecoveryBundle(paths) {
  const packageRoot = path.resolve(__dirname, "..", "..");
  const bundleRoot = path.join(paths.root, "recovery-v1");
  if (fs.existsSync(path.join(bundleRoot, "manifest.json"))) {
    const verification = verifyRecoveryBundle(bundleRoot);
    return { packageRoot, bundleRoot, manifest: verification.manifest };
  }
  const skillDirectories = fs.readdirSync(packageRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("rainbond-"))
    .map((entry) => entry.name)
    .sort();
  const manifest = createRecoveryBundle({
    packageRoot,
    bundleRoot,
    requiredFiles: ["package.json", "install.sh", "bin/rainskills.js"],
    requiredDirectories: skillDirectories,
  });
  return { packageRoot, bundleRoot, manifest };
}

async function prepareWindowsWsl({ adapter, onboarding, options, paths, state }) {
  const installationId = state.installation_id;
  const recovery = windowsRecoveryBundle(paths);
  const recoveryManifestPath = path.join(recovery.bundleRoot, "manifest.json");
  const helperPath = path.join(recovery.packageRoot, "rainbond-platform-installer", "scripts", "windows-platform.ps1");
  const bootstrapPath = path.join(recovery.packageRoot, "rainbond-platform-installer", "scripts", "wsl-bootstrap.sh");
  const recoveryEntry = path.join(recovery.bundleRoot, "bin", "rainskills.js");
  const common = { operationId: options.onboardingId, installationId };

  state = updateState(paths.state, state, { stage: "enabling-wsl", status: "running" });
  appendEvent(paths, state, "enabling-wsl", "started");
  process.stdout.write("\n接下来会弹出一次 Windows 管理员确认；WSL 准备进度会显示在管理员窗口。\n");
  const prepared = await adapter.prepareWsl({
    ...common,
    payload: {
      helper_path: helperPath,
      helper_sha256: sha256File(helperPath),
      bootstrap_path: bootstrapPath,
      bootstrap_sha256: sha256File(bootstrapPath),
      recovery_root: recovery.bundleRoot,
      recovery_manifest_sha256: sha256File(recoveryManifestPath),
      recovery_entry: recoveryEntry,
      node_path: process.execPath,
      control_mode: onboarding.control_mode || "windows-native",
      control_distro: onboarding.control_mode === "wsl" ? onboarding.control_distro : null,
      control_recovery_entry: onboarding.control_mode === "wsl" ? recoveryEntry : null,
      control_node_path: onboarding.control_mode === "wsl" ? process.execPath : null,
    },
  });
  if (prepared.facts.rebootPending) {
    validateWindowsStageTransition({
      from: "enabling-wsl",
      to: "reboot-required",
      facts: {
        installationId,
        observedAt: now(),
        rebootPending: true,
        recoveryTasksVerified: Boolean(prepared.facts.recoveryTasksVerified && prepared.facts.finalizerTaskVerified),
      },
      expectedInstallationId: installationId,
    });
    state = updateState(paths.state, state, {
      stage: "reboot-required",
      status: "waiting_user",
      finalizer_nonce: prepared.facts.finalizerNonce,
    });
    appendEvent(paths, state, "reboot-required", "waiting_user");
    if (!(await confirmWindowsRestart())) {
      process.stdout.write(`\n安装进度已经保存。继续时执行：\n  npx rainskills@${packageManifest.version} platform install --onboarding-id ${options.onboardingId} --target local-windows\n`);
      return { state, waiting: true };
    }
    await adapter.requestReboot({ ...common, payload: { recovery_tasks_verified: true }, interactive: true, confirmed: true });
    return { state, waiting: true };
  }

  if (!prepared.facts.wslVerified) throw new Error("WSL 2 尚未通过完整验证");
  validateWindowsStageTransition({
    from: "enabling-wsl",
    to: "downloading-rootfs",
    facts: {
      installationId,
      observedAt: now(),
      rebootPending: false,
      wslVerified: true,
      wslDefaultVersion: prepared.facts.wslDefaultVersion,
    },
    expectedInstallationId: installationId,
  });
  state = updateState(paths.state, state, { stage: "downloading-rootfs", status: "running" });
  appendEvent(paths, state, "downloading-rootfs", "started");
  return { state, waiting: false, adapter, onboarding };
}

function printWindowsDownloadProgress({ current, total }) {
  const currentMiB = current / 1024 ** 2;
  if (Number.isFinite(total) && total > 0) {
    const percent = Math.min(100, Math.floor((current / total) * 100));
    const filled = Math.floor(percent / 5);
    process.stdout.write(`\r下载 Ubuntu 根文件系统 [${"#".repeat(filled)}${"-".repeat(20 - filled)}] ${percent}% (${currentMiB.toFixed(1)} MB)`);
  } else {
    process.stdout.write(`\r下载 Ubuntu 根文件系统 ${currentMiB.toFixed(1)} MB`);
  }
}

async function provisionWindowsDistroAndNetwork({ adapter, options, paths, state }) {
  const installationId = state.installation_id;
  if (!["downloading-rootfs", "importing-distro", "preparing-runtime", "installing-rainbond", "configuring-windows-access", "verifying"].includes(state.stage)) {
    throw new Error(`当前 Windows 安装阶段不能准备发行版：${state.stage}`);
  }
  const common = { operationId: options.onboardingId, installationId };
  const rootfsPath = path.join(paths.root, "ubuntu-jammy-rootfs.tar.gz");
  let lastProgressAt = 0;
  let lastProgressEventAt = 0;
  const rootfs = await ensurePinnedArtifact({
    destination: rootfsPath,
    url: POLICY.windows.ubuntu_rootfs.url,
    sha256: POLICY.windows.ubuntu_rootfs.sha256,
    allowedOrigins: POLICY.windows.preflight_allowed_origins,
    onProgress(progress) {
      const currentTime = Date.now();
      if (currentTime - lastProgressAt >= 250 || progress.current === progress.total) {
        lastProgressAt = currentTime;
        printWindowsDownloadProgress(progress);
      }
      if (currentTime - lastProgressEventAt >= 5000 || progress.current === progress.total) {
        lastProgressEventAt = currentTime;
        appendEvent(paths, state, "downloading-rootfs", "progress", {
          current: progress.current,
          total: progress.total,
          unit: "bytes",
        });
      }
    },
  });
  process.stdout.write(rootfs.reused ? "已复用校验通过的 Ubuntu 根文件系统。\n" : "\nUbuntu 根文件系统下载并校验完成。\n");
  if (state.stage === "downloading-rootfs") {
    validateWindowsStageTransition({
      from: "downloading-rootfs",
      to: "importing-distro",
      facts: { installationId, observedAt: now(), rootfsDigestVerified: true },
      expectedInstallationId: installationId,
    });
    state = updateState(paths.state, state, {
      stage: "importing-distro",
      status: "running",
      rootfs_path: rootfsPath,
      rootfs_sha256: POLICY.windows.ubuntu_rootfs.sha256,
    });
    appendEvent(paths, state, "importing-distro", "started");
  }

  const localAppData = state.windows_local_app_data
    || process.env.LOCALAPPDATA
    || path.win32.join(os.homedir(), "AppData", "Local");
  const distroRoot = path.win32.join(localAppData, "RainSkills", "Distros", installationId);
  const installer = await ensureTrustedInstaller(paths.installer, paths, state, {
    skipSyntaxCheck: true,
  });
  process.stdout.write(installer.reused ? "已复用检查通过的 Rainbond 安装脚本。\n" : "Rainbond 安装脚本下载并检查完成。\n");
  state = updateState(paths.state, state, {
    artifact_url: installer.finalUrl,
    artifact_sha256: installer.sha256,
    rootfs_path: rootfsPath,
    rootfs_sha256: POLICY.windows.ubuntu_rootfs.sha256,
    distro_root: distroRoot,
  });

  const network = managedNetworkFromCidr(state.windows_subnet);
  process.stdout.write("\n接下来会弹出一次 Windows 管理员确认；发行版、Docker 和 Rainbond 的安装进度会显示在管理员窗口。\n");
  const provisioned = await adapter.provisionRainbond({
    ...common,
    payload: {
      rootfs_path: rootfsPath,
      distro_root: distroRoot,
      subnet: network.cidr,
      host_address: network.hostAddress,
      guest_address: network.guestAddress,
      installer_path: paths.installer,
      installer_sha256: installer.sha256,
    },
  });
  const stageFacts = () => ({
    ...provisioned.facts,
    installationId,
    observedAt: now(),
  });
  state = updateState(paths.state, state, {
    status: "running",
    windows_network_ready: true,
    managed_subnet: network.cidr,
    host_address: network.hostAddress,
    guest_address: network.guestAddress,
  });

  if (state.stage === "importing-distro") {
    validateWindowsStageTransition({
      from: "importing-distro",
      to: "preparing-runtime",
      facts: stageFacts(),
      expectedInstallationId: installationId,
    });
    state = updateState(paths.state, state, {
      stage: "preparing-runtime",
      status: "running",
      distro_root: distroRoot,
    });
    appendEvent(paths, state, "preparing-runtime", "started");
  }

  if (state.stage === "preparing-runtime") {
    validateWindowsStageTransition({
      from: "preparing-runtime",
      to: "installing-rainbond",
      facts: stageFacts(),
      expectedInstallationId: installationId,
    });
    appendEvent(paths, state, "preparing-runtime", "completed", {
      location: "local-windows",
      guest_address: network.guestAddress,
    });
    state = updateState(paths.state, state, { stage: "installing-rainbond", status: "running" });
    appendEvent(paths, state, "installing-rainbond", "started");
  }
  if (state.stage === "installing-rainbond") {
    validateWindowsStageTransition({
      from: "installing-rainbond",
      to: "configuring-windows-access",
      facts: stageFacts(),
      expectedInstallationId: installationId,
    });
    state = updateState(paths.state, state, { stage: "configuring-windows-access", status: "running" });
    appendEvent(paths, state, "installing-rainbond", "completed");
  }
  if (state.stage === "configuring-windows-access") {
    validateWindowsStageTransition({
      from: "configuring-windows-access",
      to: "verifying",
      facts: stageFacts(),
      expectedInstallationId: installationId,
    });
    state = updateState(paths.state, state, { stage: "verifying", status: "running" });
    appendEvent(paths, state, "verifying", "started");
  }
  return { state, network, verifiedFacts: provisioned.facts };
}

async function installWindowsRainbond({ adapter, onboarding, options, paths, state, verifiedFacts = null }) {
  const installationId = state.installation_id;
  if (state.stage !== "verifying") {
    throw new Error(`当前 Windows 安装阶段不能安装 Rainbond：${state.stage}`);
  }
  if (!verifiedFacts) throw new Error("缺少组合安装返回的 Windows 双侧验证结果");
  const common = { operationId: options.onboardingId, installationId };
  const verified = { facts: verifiedFacts };
  const delivery = evaluateWindowsDeployment({
    ...verified.facts,
    expectedInstallationId: installationId,
    controlMode: onboarding.control_mode || "windows-native",
  }, POLICY);
  if (!delivery.ok) throw new Error(`Rainbond 双侧验证未通过：${delivery.blockers.join("；")}`);
  validateWindowsStageTransition({
    from: "verifying",
    to: "platform-ready",
    facts: {
      installationId,
      observedAt: now(),
      wslHealthVerified: Boolean(verified.facts.containerRunning && verified.facts.nodeReady && verified.facts.componentsReady && verified.facts.wslConsoleReachable),
      windowsHealthVerified: Boolean(verified.facts.windowsConsoleReachable),
    },
    expectedInstallationId: installationId,
  });
  const verification = {
    consoleUrl: delivery.consoleUrl,
    containerState: "running",
    nodeReady: true,
    componentsReady: true,
    location: delivery.location,
    guestAddress: verified.facts.guestAddress,
    controlConsoleUrl: delivery.controlConsoleUrl,
  };
  await completePlatform(onboarding, state, paths, verification, options.noResume);
  process.stdout.write("\n最后会弹出一次 Windows 管理员确认，用于清理自动恢复任务。\n");
  await adapter.finalize({ ...common, payload: { status: "success" } });
  return { state, verification };
}

function resumeInvocationForOnboarding(onboarding, execPath = process.execPath) {
  const args = [
    onboarding.target,
    "--self-hosted",
    "--rainbond-url",
    onboarding.console_url,
  ];
  if (onboarding.console_url.startsWith("http://")) args.push("--allow-insecure-http");
  if (onboarding.control_mode === "windows-native") {
    return {
      executable: execPath,
      args: [path.resolve(__dirname, "windows-onboarding.js"), ...args],
    };
  }
  return {
    executable: "bash",
    args: [path.resolve(__dirname, "..", "..", "install.sh"), ...args],
  };
}

async function runResume(onboardingId) {
  assertOperationId(onboardingId);
  ensurePrivateOperationDirectory(path.dirname(onboardingStatePath()));
  let onboarding = readOnboardingState(onboardingStatePath(), onboardingId);
  if (!onboarding.console_url || !["platform-ready", "authorizing"].includes(onboarding.stage)) {
    throw new Error("平台尚未完成验证，不能继续 RainSkills 授权");
  }

  onboarding = updateOnboarding(onboarding, { stage: "authorizing" });
  const invocation = resumeInvocationForOnboarding(onboarding);

  process.stdout.write("\n正在恢复 RainSkills 授权流程，将在浏览器中完成登录和授权。\n");
  const result = await spawnAttached(
    invocation.executable,
    invocation.args,
    { env: process.env },
    null
  );
  if (result.signal) throw new Error(`授权流程被信号 ${result.signal} 中断`);
  if (result.code !== 0) {
    process.stdout.write(`\nRainbond 已部署，授权尚未完成。稍后继续：\n  npx rainskills@${packageManifest.version} resume --onboarding-id ${onboardingId}\n`);
    throw new Error(`RainSkills 授权流程退出码为 ${result.code}`);
  }
  updateOnboarding(onboarding, { stage: "configured" });
  process.stdout.write("\nRainSkills 已连接到新部署的 Rainbond。\n");
}

async function completePlatform(onboarding, state, paths, verification, noResume) {
  const controlConsoleUrl = verification.controlConsoleUrl || verification.consoleUrl;
  state = updateState(paths.state, state, {
    stage: "platform-ready",
    status: "completed",
    console_url: verification.consoleUrl,
    control_console_url: controlConsoleUrl,
    verification,
  });
  appendEvent(paths, state, "platform-ready", "completed");
  onboarding = updateOnboarding(onboarding, {
    stage: "platform-ready",
    platform_state_path: paths.state,
    console_url: controlConsoleUrl,
    display_console_url: verification.consoleUrl,
  });
  activeOperation = null;

  const deploymentLocation = verification.location || state.host;
  process.stdout.write(`\nRainbond 部署成功\n\n部署位置：${deploymentLocation}\n运行状态：正常\nConsole 地址：${verification.consoleUrl}\n\n接下来将连接该平台并完成授权。\n`);
  if (!noResume) await runResume(onboarding.operation_id);
}

async function runInstallOperation(options) {
  assertOperationId(options.onboardingId);
  ensurePrivateOperationDirectory(path.dirname(onboardingStatePath()));
  let onboarding = readOnboardingState(onboardingStatePath(), options.onboardingId);
  if (!["awaiting-platform", "platform-ready", "authorizing"].includes(onboarding.stage)) {
    throw new Error(`当前 onboarding 阶段不能安装平台：${onboarding.stage}`);
  }
  if (onboarding.stage === "platform-ready" || onboarding.stage === "authorizing") {
    if (!options.noResume) await runResume(options.onboardingId);
    return;
  }

  const paths = operationPaths(options.onboardingId);
  ensurePrivateOperationDirectory(paths.root);
  assertOperationFilesSafe(paths);
  let state = fs.existsSync(paths.state)
    ? readPlatformState(paths.state, options.onboardingId)
    : createPlatformState(options.onboardingId, paths);
  if (!UUID_PATTERN.test(state.installation_id || "")) {
    state = { ...state, installation_id: crypto.randomUUID() };
  }
  atomicWriteJson(paths.state, state);
  activeOperation = { paths, state, onboardingId: options.onboardingId };

  const savedTarget = state.target_kind ? {
    kind: state.target_kind,
    host: state.host,
    sshPort: state.ssh_port,
  } : null;
  const target = await selectInstallTarget({
    platform: controlHostPlatform(onboarding),
    options,
    savedTarget,
  });
  if (!target) {
    state = updateState(paths.state, state, {
      stage: "target-selection",
      status: "waiting_user",
    });
    activeOperation.state = state;
    return;
  }
  const remoteTarget = target.kind === "remote-linux"
    ? { host: target.host, port: target.sshPort }
    : null;
  state = updateState(paths.state, state, {
    target_kind: target.kind,
    host: target.host,
    ssh_port: target.sshPort,
    remote_workspace: remoteTarget ? remoteWorkspacePath(options.onboardingId) : null,
  });
  activeOperation.state = state;

  const isWindowsLocal = target.kind === "local-windows";
  const controlMode = onboarding.control_mode || (process.platform === "win32" ? "windows-native" : "posix");
  const windowsRunner = (command, args) => runCommand(
    normalizeWindowsExecutableForControl(command, controlMode),
    args,
    { timeout: 30 * 60 * 1000 }
  );
  const windowsAdapter = isWindowsLocal
    ? createWindowsPlatformAdapter({
      runner: windowsRunner,
      stateStore: secureStateStore,
      policy: POLICY,
      userSid: resolveWindowsUserSid(windowsRunner),
      pathTranslator: controlMode === "wsl"
        ? (filePath) => translateWslPathToWindows(filePath, runCommand)
        : (filePath) => filePath,
      prepareResultForRead: controlMode === "wsl" ? prepareWslHelperResult : null,
    })
    : null;
  if (isWindowsLocal && state.stage === "enabling-wsl") {
    const prepared = await prepareWindowsWsl({
      adapter: windowsAdapter,
      onboarding,
      options,
      paths,
      state,
    });
    activeOperation.state = prepared.state;
    if (!prepared.waiting) {
      const provisioned = await provisionWindowsDistroAndNetwork({
        adapter: windowsAdapter,
        options,
        paths,
        state: prepared.state,
      });
      activeOperation.state = provisioned.state;
      await installWindowsRainbond({
        adapter: windowsAdapter,
        onboarding,
        options,
        paths,
        state: provisioned.state,
        verifiedFacts: provisioned.verifiedFacts,
      });
    }
    return;
  }
  if (isWindowsLocal && state.stage === "reboot-required") {
    const verified = await windowsAdapter.verifyWsl({
      operationId: options.onboardingId,
      installationId: state.installation_id,
      payload: { after_reboot: true },
    });
    if (!verified.facts.wslVerified) {
      state = updateState(paths.state, state, { status: "waiting_user" });
      process.stdout.write("Windows 重启后 WSL 2 尚未就绪，请完成系统更新或再次重启后继续。\n");
      return;
    }
    validateWindowsStageTransition({
      from: "reboot-required",
      to: "downloading-rootfs",
      facts: {
        installationId: state.installation_id,
        observedAt: now(),
        rebootPending: false,
        wslVerified: true,
        wslDefaultVersion: verified.facts.wslDefaultVersion,
      },
      expectedInstallationId: state.installation_id,
    });
    state = updateState(paths.state, state, { stage: "downloading-rootfs", status: "running" });
    appendEvent(paths, state, "downloading-rootfs", "started");
    activeOperation.state = state;
    process.stdout.write("WSL 2 已在重启后通过验证，正在继续准备 Rainbond 专用环境。\n");
    const provisioned = await provisionWindowsDistroAndNetwork({
      adapter: windowsAdapter,
      options,
      paths,
      state,
    });
    activeOperation.state = provisioned.state;
    await installWindowsRainbond({
      adapter: windowsAdapter,
      onboarding,
      options,
      paths,
      state: provisioned.state,
      verifiedFacts: provisioned.verifiedFacts,
    });
    return;
  }
  if (isWindowsLocal && ["downloading-rootfs", "importing-distro", "preparing-runtime", "installing-rainbond", "configuring-windows-access", "verifying"].includes(state.stage)) {
    const provisioned = await provisionWindowsDistroAndNetwork({
      adapter: windowsAdapter,
      options,
      paths,
      state,
    });
    activeOperation.state = provisioned.state;
    await installWindowsRainbond({
      adapter: windowsAdapter,
      onboarding,
      options,
      paths,
      state: provisioned.state,
      verifiedFacts: provisioned.verifiedFacts,
    });
    return;
  }

  state = updateState(paths.state, state, { stage: "preflight", status: "running" });
  appendEvent(paths, state, "preflight", "started");
  let sshSession = null;
  let effectiveSshHost = "";
  if (remoteTarget) {
    process.stdout.write(`\n正在连接 Linux 服务器 ${remoteTarget.host}...\n`);
    try {
      sshSession = await establishSshSession(remoteTarget);
    } catch (error) {
      state = updateState(paths.state, state, { status: "failed", blocker: error.message });
      appendEvent(paths, state, "ssh-authentication", "failed");
      throw error;
    }
    if (!sshSession) {
      state = updateState(paths.state, state, {
        stage: "ssh-authentication",
        status: "waiting_user",
      });
      appendEvent(paths, state, "ssh-authentication", "waiting_user");
      process.stdout.write(`请在交互终端继续：\n  npx rainskills@${packageManifest.version} platform install --onboarding-id ${options.onboardingId} --target remote-linux --ssh ${remoteTarget.host} --ssh-port ${remoteTarget.port}\n`);
      return;
    }
    activeSshSession = sshSession;
    effectiveSshHost = resolveSshHostname(remoteTarget);
    state = updateState(paths.state, state, {
      effective_ssh_host: effectiveSshHost,
      console_host: options.consoleHost || state.console_host || null,
    });
    activeOperation.state = state;
    process.stdout.write(`正在通过 SSH 检查 Linux 服务器 ${remoteTarget.host}...\n`);
  }
  let windowsPreflight = null;
  const facts = isWindowsLocal
    ? (windowsPreflight = await windowsAdapter.preflight({
      operationId: options.onboardingId,
      installationId: state.installation_id,
    })).facts
    : remoteTarget ? inspectRemoteSystem(remoteTarget, runCommand, sshSession) : inspectSystem();
  if (!remoteTarget && !isWindowsLocal) facts.networkReachable = await probeInstallerEndpoint(POLICY.installer.url);

  if (facts.hasRainbond && state.status !== "pending") {
    try {
      const priorOutput = fs.existsSync(paths.log) ? fs.readFileSync(paths.log, "utf8") : "";
      let verification;
      if (remoteTarget) {
        verification = await verifyRemoteDeployment({
          target: remoteTarget,
          fallbackHost: facts.primaryIp,
          explicitHost: options.consoleHost || state.console_host || "",
          effectiveSshHost,
          session: sshSession,
        });
        if (!verification) {
          state = updateState(paths.state, state, {
            stage: "verifying",
            status: "waiting_user",
            blocker: null,
          });
          appendEvent(paths, state, "verifying", "waiting_user");
          activeOperation.state = state;
          return;
        }
      } else {
        verification = verifyRainbond(priorOutput);
        try {
          await probeConsole(verification.consoleUrl);
        } catch (error) {
          await probeConsole("http://127.0.0.1:7070");
          verification.consoleUrl = "http://127.0.0.1:7070";
        }
      }
      process.stdout.write("\n检测到中断前启动的 Rainbond 已经就绪，将从验证结果继续。\n");
      await completePlatform(onboarding, state, paths, verification, options.noResume);
      return;
    } catch (error) {
      state = updateState(paths.state, state, {
        status: "failed",
        blocker: `检测到已有 rainbond 容器，但尚未通过完整验证：${error.message}`,
      });
      appendEvent(paths, state, "verifying", "failed");
      throw new Error(`${state.blocker}。未重复执行安装脚本，请查看日志：${paths.log}`);
    }
  }

  const assessment = isWindowsLocal ? windowsPreflight.assessment : evaluatePreflight(facts);
  if (isWindowsLocal) printWindowsPreflight(facts, assessment);
  else printPreflight(facts, assessment, target);
  if (!assessment.ok) {
    state = updateState(paths.state, state, { status: "failed", blockers: assessment.blockers });
    appendEvent(paths, state, "preflight", "failed");
    throw new Error("环境检查未通过，未执行任何安装操作");
  }

  state = updateState(paths.state, state, {
    stage: "awaiting-confirmation",
    status: "waiting_user",
    proposed_effects: assessment.effects,
    windows_subnet: isWindowsLocal ? facts.availableSubnet : state.windows_subnet,
    windows_local_app_data: isWindowsLocal ? facts.localAppData : state.windows_local_app_data,
  });
  appendEvent(paths, state, "awaiting-confirmation", "waiting_user");
  if (!(await confirmInstall(options.yes))) {
    process.stdout.write(`\n安装尚未开始。继续时执行：\n  npx rainskills@${packageManifest.version} platform install --onboarding-id ${options.onboardingId}\n`);
    return;
  }

  state = updateState(paths.state, state, {
    approved_effects: assessment.effects,
    status: "running",
  });

  if (isWindowsLocal) {
    const prepared = await prepareWindowsWsl({
      adapter: windowsAdapter,
      onboarding,
      options,
      paths,
      state,
    });
    activeOperation.state = prepared.state;
    if (!prepared.waiting) {
      process.stdout.write("WSL 2 已准备完成，正在继续安装 Rainbond。\n");
      const provisioned = await provisionWindowsDistroAndNetwork({
        adapter: windowsAdapter,
        options,
        paths,
        state: prepared.state,
      });
      activeOperation.state = provisioned.state;
      await installWindowsRainbond({
        adapter: windowsAdapter,
        onboarding,
        options,
        paths,
        state: provisioned.state,
        verifiedFacts: provisioned.verifiedFacts,
      });
    }
    return;
  }

  try {
    state = updateState(paths.state, state, { stage: "downloading", status: "running" });
    appendEvent(paths, state, "downloading", "started");
    const download = await ensureTrustedInstaller(paths.installer, paths, state);
    const digest = download.sha256;
    if (download.reused) process.stdout.write("已复用检查通过的官方安装脚本。\n");
    state = updateState(paths.state, state, {
      artifact_url: download.finalUrl,
      artifact_sha256: digest,
    });
    appendEvent(paths, state, "downloading", "completed", { current: download.bytes, total: download.bytes, unit: "bytes" });

    state = updateState(paths.state, state, { stage: "starting", status: "running" });
    appendEvent(paths, state, "starting", "started");
    process.stdout.write("\n[1/4] 运行环境准备中\n[2/4] 下载并启动 Rainbond 组件\n");
    let result;
    if (remoteTarget) {
      prepareRemoteInstaller(remoteTarget, options.onboardingId, paths.installer, runCommand, sshSession);
      const installationEip = selectRemoteInstallationEip({
        explicitHost: options.consoleHost || state.console_host || "",
        effectiveSshHost,
        primaryIp: facts.primaryIp || "",
      });
      const invocation = remoteInstallerInvocation(
        remoteTarget,
        options.onboardingId,
        digest,
        installationEip,
        sshSession
      );
      result = await spawnAttached(
        invocation.command,
        invocation.args,
        { env: process.env, input: invocation.input },
        paths.log
      );
    } else {
      const installerEnv = {
        ...process.env,
        RAINBOND_INSTALL_LANG: "zh",
        RAINBOND_AUTO_INSTALL_ORBSTACK: process.platform === "darwin" ? "true" : process.env.RAINBOND_AUTO_INSTALL_ORBSTACK,
      };
      if (facts.primaryIp && !installerEnv.EIP) installerEnv.EIP = facts.primaryIp;
      const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
      const command = process.platform === "linux" && !isRoot ? "sudo" : "bash";
      const args = command === "sudo" ? ["-n", "bash", paths.installer] : [paths.installer];
      result = await spawnAttached(command, args, { cwd: paths.root, env: installerEnv }, paths.log);
    }
    if (result.signal) throw new Error(`Rainbond 安装被信号 ${result.signal} 中断`);
    if (result.code !== 0) throw new Error(`Rainbond 官方安装脚本退出码为 ${result.code}，日志：${paths.log}`);

    process.stdout.write("[3/4] Rainbond 组件就绪检查\n");
    state = updateState(paths.state, state, { stage: "verifying", status: "running" });
    appendEvent(paths, state, "verifying", "started");
    let verification;
    if (remoteTarget) {
      verification = await verifyRemoteDeployment({
        target: remoteTarget,
        fallbackHost: facts.primaryIp,
        explicitHost: options.consoleHost || state.console_host || "",
        effectiveSshHost,
        session: sshSession,
      });
      if (!verification) {
        state = updateState(paths.state, state, {
          stage: "verifying",
          status: "waiting_user",
          blocker: null,
        });
        appendEvent(paths, state, "verifying", "waiting_user");
        activeOperation.state = state;
        return;
      }
    } else {
      verification = verifyRainbond(fs.readFileSync(paths.log, "utf8"));
      try {
        await probeConsole(verification.consoleUrl);
      } catch (error) {
        await probeConsole("http://127.0.0.1:7070");
        verification.consoleUrl = "http://127.0.0.1:7070";
      }
    }
    process.stdout.write("[4/4] Console 健康检查通过\n");
    await completePlatform(onboarding, state, paths, verification, options.noResume);
  } catch (error) {
    if (!interruptedSignal) {
      state = updateState(paths.state, state, { status: "failed", blocker: error.message });
      appendEvent(paths, state, state.stage, "failed");
    }
    throw error;
  }
}

async function runInstall(options) {
  try {
    await runInstallOperation(options);
  } finally {
    closeSshSession(activeSshSession);
    activeSshSession = null;
  }
}

function interruptActiveOperation(signal) {
  interruptedSignal = signal;
  if (activeRequest) {
    activeRequest.destroy(new Error(`下载被 ${signal} 中断`));
    activeRequest = null;
  }
  if (activeChild?.pid) {
    try {
      if (activeChildDetached && process.platform !== "win32") process.kill(-activeChild.pid, signal);
      else activeChild.kill(signal);
    } catch {
      // The child may already have exited.
    }
  }
  closeSshSession(activeSshSession);
  activeSshSession = null;
  if (activeOperation) {
    const { paths } = activeOperation;
    try {
      const state = JSON.parse(fs.readFileSync(paths.state, "utf8"));
      const interrupted = updateState(paths.state, state, { status: "interrupted" });
      appendEvent(paths, interrupted, interrupted.stage, "interrupted");
      process.stderr.write(`\n安装已中断，状态已保留。继续时执行：\n  npx rainskills@${packageManifest.version} platform install --onboarding-id ${activeOperation.onboardingId}\n`);
    } catch (error) {
      process.stderr.write(`\n保存中断状态失败：${error.message}\n`);
    }
  }
}

async function main(argv) {
  const options = parseArgs(argv);
  if (options.help || !options.command) {
    usage();
    return;
  }
  if (!options.onboardingId) throw new Error("必须提供 --onboarding-id");
  if (options.command === "install") await runInstall(options);
  else if (options.command === "resume") await runResume(options.onboardingId);
  else throw new Error(`未知命令：${options.command}`);
}

module.exports = {
  POLICY,
  REMOTE_INSPECTION_SCRIPT,
  REMOTE_INSTALL_SCRIPT,
  REMOTE_VERIFICATION_SCRIPT,
  atomicWriteJson,
  buildRemoteConsoleCandidates,
  closeSshSession,
  controlHostPlatform,
  establishSshSession,
  evaluatePreflight,
  extractConsoleUrl,
  inspectRemoteSystem,
  normalizeConsoleHost,
  normalizeRemoteTarget,
  normalizeWindowsExecutableForControl,
  parseArgs,
  prepareRemoteInstaller,
  readOnboardingState,
  readPlatformState,
  remoteInstallerInvocation,
  resolveRemoteConsole,
  resumeInvocationForOnboarding,
  resolveSshHostname,
  selectInstallTarget,
  selectReachableConsole,
  selectRemoteInstallationEip,
  targetChoicesForPlatform,
  translateWslPathToWindows,
  validateInstaller,
  verifyRemoteDeployment,
  verifyRemoteRainbond,
};

if (require.main === module) {
  process.on("SIGINT", () => {
    interruptActiveOperation("SIGINT");
    process.exitCode = 130;
  });
  process.on("SIGTERM", () => {
    interruptActiveOperation("SIGTERM");
    process.exitCode = 143;
  });
  main(process.argv.slice(2)).catch((error) => {
    if (!interruptedSignal) {
      process.stderr.write(`错误：${error.message}\n`);
      process.exitCode = 1;
    }
  });
}
