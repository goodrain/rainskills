#!/usr/bin/env node

const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline/promises");
const { spawn, spawnSync } = require("node:child_process");

const packageManifest = require("../../package.json");
const POLICY = require("../references/installation-policy.json");
const ONBOARDING_SCHEMA = "rainskills.onboarding.v1";
const PLATFORM_STATE_SCHEMA = "rainskills.platform-state.v1";
const PROGRESS_SCHEMA = "rainskills.platform-progress.v1";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

let activeChild = null;
let activeRequest = null;
let activeOperation = null;
let interruptedSignal = null;

function usage() {
  process.stdout.write(`Usage:
  npx rainskills platform install --onboarding-id <id> [--target <kind>] [--ssh <target>] [--ssh-port <port>] [--yes] [--no-resume]
  npx rainskills resume --onboarding-id <id>

Commands:
  platform install  Select a supported target, preflight it, and install Rainbond
  resume            Continue RainSkills authorization with the verified Console URL

Options:
  --onboarding-id ID  Resume the protected RainSkills onboarding checkpoint
  --target KIND       Use local-linux, local-macos, or remote-linux
  --ssh TARGET        Existing SSH alias or user@host for remote-linux
  --ssh-port PORT     SSH port (default: 22)
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

function assertProtectedRegularFile(filePath) {
  const info = fs.lstatSync(filePath);
  if (info.isSymbolicLink()) throw new Error(`拒绝读取符号链接状态文件：${filePath}`);
  if (!info.isFile()) throw new Error(`状态路径不是普通文件：${filePath}`);
  if ((info.mode & 0o777) !== 0o600) throw new Error(`状态文件权限必须为 0600：${filePath}`);
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
    throw new Error(`状态文件不属于当前用户：${filePath}`);
  }
}

function readOnboardingState(filePath, expectedOperationId) {
  assertProtectedRegularFile(filePath);
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
  return state;
}

function readPlatformState(filePath, expectedOperationId) {
  assertProtectedRegularFile(filePath);
  const state = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (state.schema !== PLATFORM_STATE_SCHEMA || state.version !== 1) {
    throw new Error("不支持的 Rainbond 平台安装状态版本");
  }
  if (state.operation_id !== expectedOperationId) {
    throw new Error("平台安装状态与 onboarding id 不匹配");
  }
  return state;
}

function atomicWriteJson(filePath, value) {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const directoryInfo = fs.lstatSync(directory);
  if (directoryInfo.isSymbolicLink() || !directoryInfo.isDirectory()) {
    throw new Error(`状态目录不安全：${directory}`);
  }
  if (typeof process.getuid === "function" && directoryInfo.uid !== process.getuid()) {
    throw new Error(`状态目录不属于当前用户：${directory}`);
  }
  fs.chmodSync(directory, 0o700);
  const tempPath = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(6).toString("hex")}`);
  const fd = fs.openSync(tempPath, "wx", 0o600);
  try {
    fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tempPath, filePath);
  fs.chmodSync(filePath, 0o600);
  const directoryFd = fs.openSync(directory, "r");
  try {
    fs.fsyncSync(directoryFd);
  } finally {
    fs.closeSync(directoryFd);
  }
}

function ensurePrivateOperationDirectory(directory) {
  const home = path.resolve(os.homedir());
  const target = path.resolve(directory);
  const relative = path.relative(home, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`平台安装状态必须位于当前用户目录：${target}`);
  }
  let current = home;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    if (!fs.existsSync(current)) {
      fs.mkdirSync(current, { mode: 0o700 });
    }
    const info = fs.lstatSync(current);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error(`状态路径包含不安全的目录：${current}`);
    }
    if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
      throw new Error(`状态目录不属于当前用户：${current}`);
    }
    fs.chmodSync(current, 0o700);
  }
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

function targetChoicesForPlatform(platform) {
  if (platform === "linux") {
    return [
      { value: "local-linux", label: "当前设备（推荐）" },
      { value: "remote-linux", label: "其他 Linux 服务器" },
    ];
  }
  if (platform === "darwin") {
    return [
      { value: "remote-linux", label: "Linux 服务器（推荐）" },
      { value: "local-macos", label: "当前 Mac（需要 OrbStack，准备时间较长）" },
    ];
  }
  if (platform === "win32") {
    return [{ value: "remote-linux", label: "Linux 服务器" }];
  }
  return [];
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

function sshArgs(target) {
  return [
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=10",
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
    if (platform === "win32") {
      write("Rainbond 暂不支持在 Windows 本机安装，将安装到 Linux 服务器。\n");
      requestedKind = "remote-linux";
    }

    if (!requestedKind && !interactive) {
      write("\n[RAINSKILLS_USER_INPUT_REQUIRED:platform_install_target]\n");
      for (const choice of choices) write(`- ${choice.label}\n`);
      if (platform === "linux") write("选择当前设备：--target local-linux\n");
      if (platform === "darwin") write("选择当前 Mac：--target local-macos\n");
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
  if command -v ss >/dev/null 2>&1 && ss -lntH 2>/dev/null | awk '{print $4}' | grep -Eq "(^|:)\${port}$"; then
    occupied="\${occupied}\${occupied:+,}\${port}"
  elif command -v lsof >/dev/null 2>&1 && lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    occupied="\${occupied}\${occupied:+,}\${port}"
  fi
done
if [ "$(id -u)" -eq 0 ] || sudo -n true >/dev/null 2>&1; then privilege=true; else privilege=false; fi
docker_prefix=""
if docker info >/dev/null 2>&1; then docker_ok=true
elif sudo -n docker info >/dev/null 2>&1; then docker_ok=true; docker_prefix="sudo -n "
else docker_ok=false
fi
if [ "$docker_ok" = true ] && \${docker_prefix}docker inspect rainbond >/dev/null 2>&1; then rainbond=true; else rainbond=false; fi
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

function inspectRemoteSystem(target, runner = runCommand) {
  const normalized = normalizeRemoteTarget(target.host, target.port);
  const result = runner("ssh", [...sshArgs(normalized), "bash", "-s"], {
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
  return {
    platform: values.PLATFORM || "unknown",
    arch: values.ARCH || "unknown",
    cpuCores: number("CPU_CORES"),
    memoryBytes: number("MEMORY_BYTES"),
    diskBytes: number("DISK_BYTES"),
    occupiedPorts: (values.OCCUPIED_PORTS || "").split(",").filter(Boolean).map(Number),
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

function prepareRemoteInstaller(target, operationId, installerPath, runner = runCommand) {
  const normalized = normalizeRemoteTarget(target.host, target.port);
  const workspace = remoteWorkspacePath(operationId);
  const prepareScript = [
    "set -eu",
    'workspace="$HOME/.rainbond/platform-installer/$1"',
    'mkdir -p "$workspace"',
    'chmod 700 "$HOME/.rainbond" "$HOME/.rainbond/platform-installer" "$workspace"',
    "",
  ].join("\n");
  const prepare = runner("ssh", [...sshArgs(normalized), "bash", "-s", "--", operationId], {
    timeout: 30000,
    input: prepareScript,
  });
  assertCommandResult(prepare, `无法在 ${normalized.host} 创建安装目录`);

  const copy = runner("scp", [
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=10",
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

function remoteInstallerInvocation(target, operationId, digest, primaryIp = "") {
  const normalized = normalizeRemoteTarget(target.host, target.port);
  const workspace = remoteWorkspacePath(operationId);
  if (!/^[a-f0-9]{64}$/.test(digest || "")) throw new Error("安装脚本 SHA-256 无效");
  const eip = String(primaryIp || "").trim();
  if (eip && !/^[A-Za-z0-9_.:-]+$/.test(eip)) throw new Error("远程服务器地址无效");
  return {
    command: "ssh",
    args: [...sshArgs(normalized), "bash", "-s", "--", workspace, digest, eip],
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

function verifyRemoteRainbond(target, fallbackHost, runner = runCommand) {
  const normalized = normalizeRemoteTarget(target.host, target.port);
  const result = runner("ssh", [...sshArgs(normalized), "bash", "-s"], {
    timeout: 30000,
    input: REMOTE_VERIFICATION_SCRIPT,
  });
  assertCommandResult(result, `无法验证 ${normalized.host} 上的 Rainbond`);
  const values = parseKeyValueOutput(result.stdout);
  if (values.CONTAINER_STATE !== "true") throw new Error("rainbond 容器未处于运行状态");
  if (values.NODE_READY !== "true") throw new Error("Rainbond 内置 K3s 节点尚未 Ready");
  if (values.COMPONENTS_READY !== "true") throw new Error("rbd-system 仍有未就绪组件");
  const host = values.EIP || fallbackHost || normalized.host.split("@").pop();
  if (!host || !/^[A-Za-z0-9_.:-]+$/.test(host)) throw new Error("无法从远程 Rainbond 确定 Console 地址");
  return {
    consoleUrl: `http://${host}:7070`,
    containerState: values.CONTAINER_STATE,
    nodeReady: true,
    componentsReady: true,
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
    package_version: packageManifest.version,
    updated_at: now(),
    stage: "target-selection",
    status: "pending",
    control_platform: process.platform,
    target_kind: null,
    host: null,
    ssh_port: null,
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

      const total = Number(response.headers["content-length"] || 0);
      let received = 0;
      let lastReported = -1;
      const tempPath = `${destination}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.part`;
      const output = fs.createWriteStream(tempPath, { flags: "wx", mode: 0o600 });
      response.on("data", (chunk) => {
        received += chunk.length;
        if (total > 0) {
          const percent = Math.floor((received / total) * 100);
          if (percent >= lastReported + 10 || percent === 100) {
            process.stdout.write(`下载官方安装脚本：${percent}% (${received}/${total} bytes)\n`);
            lastReported = percent;
          }
        }
      });
      response.pipe(output);
      output.on("finish", () => {
        output.close(() => {
          fs.renameSync(tempPath, destination);
          fs.chmodSync(destination, 0o600);
          activeRequest = null;
          resolve({ finalUrl: url, bytes: received });
        });
      });
      response.on("error", (error) => {
        activeRequest = null;
        reject(error);
      });
      output.on("error", (error) => {
        activeRequest = null;
        reject(error);
      });
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

function validateInstaller(filePath) {
  const digest = sha256File(filePath);
  if (digest !== POLICY.installer.sha256) {
    throw new Error(`官方安装脚本摘要发生变化，已停止执行。请升级 Rainskills 后重试（实际 ${digest}）`);
  }
  const source = fs.readFileSync(filePath, "utf8");
  if (!source.startsWith("#!/bin/bash") || !source.includes("Rainbond Installation Successful")) {
    throw new Error("下载内容不是预期的 Rainbond 安装脚本");
  }
  return digest;
}

function spawnAttached(command, args, options, logPath) {
  return new Promise((resolve, reject) => {
    const { input, ...spawnOptions } = options;
    const logFd = logPath ? fs.openSync(logPath, "a", 0o600) : null;
    const child = spawn(command, args, {
      ...spawnOptions,
      detached: process.platform !== "win32",
      stdio: [input === undefined ? "inherit" : "pipe", "pipe", "pipe"],
    });
    activeChild = child;
    if (input !== undefined) {
      child.stdin.end(input);
    }
    const forward = (stream, destination) => {
      stream.on("data", (chunk) => {
        destination.write(chunk);
        if (logFd !== null) fs.writeSync(logFd, chunk);
      });
    };
    forward(child.stdout, process.stdout);
    forward(child.stderr, process.stderr);
    child.on("error", (error) => {
      if (logFd !== null) fs.closeSync(logFd);
      activeChild = null;
      reject(error);
    });
    child.on("close", (code, signal) => {
      if (logFd !== null) {
        fs.fsyncSync(logFd);
        fs.closeSync(logFd);
        fs.chmodSync(logPath, 0o600);
      }
      activeChild = null;
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

async function runResume(onboardingId) {
  assertOperationId(onboardingId);
  ensurePrivateOperationDirectory(path.dirname(onboardingStatePath()));
  let onboarding = readOnboardingState(onboardingStatePath(), onboardingId);
  if (!onboarding.console_url || !["platform-ready", "authorizing"].includes(onboarding.stage)) {
    throw new Error("平台尚未完成验证，不能继续 RainSkills 授权");
  }

  onboarding = updateOnboarding(onboarding, { stage: "authorizing" });
  const installScript = path.resolve(__dirname, "..", "..", "install.sh");
  const args = [
    installScript,
    onboarding.target,
    "--self-hosted",
    "--rainbond-url",
    onboarding.console_url,
  ];
  if (onboarding.console_url.startsWith("http://")) args.push("--allow-insecure-http");

  process.stdout.write("\n正在恢复 RainSkills 授权流程，将在浏览器中完成登录和授权。\n");
  const result = await spawnAttached("bash", args, { env: process.env }, null);
  if (result.signal) throw new Error(`授权流程被信号 ${result.signal} 中断`);
  if (result.code !== 0) {
    process.stdout.write(`\nRainbond 已部署，授权尚未完成。稍后继续：\n  npx rainskills@${packageManifest.version} resume --onboarding-id ${onboardingId}\n`);
    throw new Error(`RainSkills 授权流程退出码为 ${result.code}`);
  }
  updateOnboarding(onboarding, { stage: "configured" });
  process.stdout.write("\nRainSkills 已连接到新部署的 Rainbond。\n");
}

async function completePlatform(onboarding, state, paths, verification, noResume) {
  state = updateState(paths.state, state, {
    stage: "platform-ready",
    status: "completed",
    console_url: verification.consoleUrl,
    verification,
  });
  appendEvent(paths, state, "platform-ready", "completed");
  onboarding = updateOnboarding(onboarding, {
    stage: "platform-ready",
    platform_state_path: paths.state,
    console_url: verification.consoleUrl,
  });
  activeOperation = null;

  process.stdout.write(`\nRainbond 部署成功\n\n部署位置：${state.host}\n运行状态：正常\nConsole 地址：${verification.consoleUrl}\n\n接下来将连接该平台并完成授权。\n`);
  if (!noResume) await runResume(onboarding.operation_id);
}

async function runInstall(options) {
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
  atomicWriteJson(paths.state, state);
  activeOperation = { paths, state, onboardingId: options.onboardingId };

  const savedTarget = state.target_kind ? {
    kind: state.target_kind,
    host: state.host,
    sshPort: state.ssh_port,
  } : null;
  const target = await selectInstallTarget({
    platform: process.platform,
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

  state = updateState(paths.state, state, { stage: "preflight", status: "running" });
  appendEvent(paths, state, "preflight", "started");
  if (remoteTarget) process.stdout.write(`\n正在通过 SSH 检查 Linux 服务器 ${remoteTarget.host}...\n`);
  const facts = remoteTarget ? inspectRemoteSystem(remoteTarget) : inspectSystem();
  if (!remoteTarget) facts.networkReachable = await probeInstallerEndpoint(POLICY.installer.url);

  if (facts.hasRainbond && state.status !== "pending") {
    try {
      const priorOutput = fs.existsSync(paths.log) ? fs.readFileSync(paths.log, "utf8") : "";
      const verification = remoteTarget
        ? verifyRemoteRainbond(remoteTarget, facts.primaryIp)
        : verifyRainbond(priorOutput);
      try {
        await probeConsole(verification.consoleUrl);
      } catch (error) {
        if (remoteTarget) throw error;
        await probeConsole("http://127.0.0.1:7070");
        verification.consoleUrl = "http://127.0.0.1:7070";
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

  const assessment = evaluatePreflight(facts);
  printPreflight(facts, assessment, target);
  if (!assessment.ok) {
    state = updateState(paths.state, state, { status: "failed", blockers: assessment.blockers });
    appendEvent(paths, state, "preflight", "failed");
    throw new Error("环境检查未通过，未执行任何安装操作");
  }

  state = updateState(paths.state, state, {
    stage: "awaiting-confirmation",
    status: "waiting_user",
    proposed_effects: assessment.effects,
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

  try {
    state = updateState(paths.state, state, { stage: "downloading", status: "running" });
    appendEvent(paths, state, "downloading", "started");
    let download;
    let digest;
    if (fs.existsSync(paths.installer)) {
      digest = validateInstaller(paths.installer);
      download = { finalUrl: state.artifact_url || POLICY.installer.url, bytes: fs.statSync(paths.installer).size };
      process.stdout.write("已复用校验通过的官方安装脚本。\n");
    } else {
      download = await downloadInstaller(POLICY.installer.url, paths.installer, paths, state);
      digest = validateInstaller(paths.installer);
    }
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
      prepareRemoteInstaller(remoteTarget, options.onboardingId, paths.installer);
      const invocation = remoteInstallerInvocation(
        remoteTarget,
        options.onboardingId,
        digest,
        facts.primaryIp || ""
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
    const verification = remoteTarget
      ? verifyRemoteRainbond(remoteTarget, facts.primaryIp)
      : verifyRainbond(fs.readFileSync(paths.log, "utf8"));
    try {
      await probeConsole(verification.consoleUrl);
    } catch (error) {
      if (remoteTarget) throw error;
      await probeConsole("http://127.0.0.1:7070");
      verification.consoleUrl = "http://127.0.0.1:7070";
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

function interruptActiveOperation(signal) {
  interruptedSignal = signal;
  if (activeRequest) {
    activeRequest.destroy(new Error(`下载被 ${signal} 中断`));
    activeRequest = null;
  }
  if (activeChild?.pid) {
    try {
      if (process.platform !== "win32") process.kill(-activeChild.pid, signal);
      else activeChild.kill(signal);
    } catch {
      // The child may already have exited.
    }
  }
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
  evaluatePreflight,
  extractConsoleUrl,
  inspectRemoteSystem,
  normalizeRemoteTarget,
  prepareRemoteInstaller,
  readOnboardingState,
  readPlatformState,
  remoteInstallerInvocation,
  selectInstallTarget,
  targetChoicesForPlatform,
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
