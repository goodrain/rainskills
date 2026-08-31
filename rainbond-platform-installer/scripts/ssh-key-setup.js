#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { createSecureStateStore } = require("./secure-state.js");
const { createWindowsSecureStateStore } = require("./windows-platform.js");
const { readSafeClusterSource, validateClusterTopology } = require("./host-cluster-installer.js");

const REMOTE_AUTHORIZED_KEYS_SCRIPT = [
  "set -eu",
  "umask 077",
  "if [ -L \"$HOME/.ssh\" ]; then echo 'unsafe .ssh path' >&2; exit 1; fi",
  "mkdir -p \"$HOME/.ssh\"",
  "chmod 700 \"$HOME/.ssh\"",
  "if [ -L \"$HOME/.ssh/authorized_keys\" ]; then echo 'unsafe authorized_keys path' >&2; exit 1; fi",
  "touch \"$HOME/.ssh/authorized_keys\"",
  "chmod 600 \"$HOME/.ssh/authorized_keys\"",
  "IFS= read -r rainskills_public_key",
  "grep -qxF \"$rainskills_public_key\" \"$HOME/.ssh/authorized_keys\" || printf '%s\\n' \"$rainskills_public_key\" >> \"$HOME/.ssh/authorized_keys\"",
].join("; ");

function normalizeSshTarget(value, port = 22) {
  const host = String(value || "").trim();
  const normalizedPort = Number.parseInt(String(port), 10);
  if (!/^(?:[A-Za-z0-9_.-]+@)?[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(host) || host.startsWith("-")) {
    throw new Error("SSH 地址无效，请填写 user@host 或 ~/.ssh/config 中的主机别名");
  }
  if (!Number.isInteger(normalizedPort) || normalizedPort < 1 || normalizedPort > 65535 || String(port).trim() !== String(normalizedPort)) {
    throw new Error("SSH 端口必须是 1 到 65535 之间的整数");
  }
  return { host, port: normalizedPort };
}

function parseSshPrepareArgs(argv) {
  const result = { command: argv[0] || "", ssh: "", sshPort: 22 };
  if (result.command === "prepare-cluster") {
    if (argv.length !== 3 || argv[1] !== "--cluster-config") {
      throw new Error("prepare-cluster 只接受 --cluster-config <path>");
    }
    const value = String(argv[2] || "").trim();
    if (!value || /[\0\r\n]/.test(value)) throw new Error("--cluster-config 配置路径无效");
    return { command: "prepare-cluster", clusterConfig: path.resolve(value) };
  }
  if (result.command !== "prepare") throw new Error("SSH 子命令必须是 prepare 或 prepare-cluster");
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--ssh") {
      if (!argv[index + 1]) throw new Error("--ssh 需要一个值");
      result.ssh = argv[index + 1];
      index += 1;
    } else if (argument === "--ssh-port") {
      if (!argv[index + 1]) throw new Error("--ssh-port 需要一个值");
      result.sshPort = argv[index + 1];
      index += 1;
    } else {
      throw new Error(`未知参数：${argument}`);
    }
  }
  const normalized = normalizeSshTarget(result.ssh, result.sshPort);
  return { command: "prepare", ssh: normalized.host, sshPort: normalized.port };
}

function assertSafeIdentityFile(filePath, { privateKey = false, platform = process.platform } = {}) {
  const info = fs.lstatSync(filePath);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("SSH 密钥文件不是安全的普通文件");
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
    throw new Error("SSH 密钥文件不属于当前用户");
  }
  if (platform !== "win32" && privateKey && (info.mode & 0o077) !== 0) {
    throw new Error("SSH 私钥权限必须仅当前用户可读写（0600）");
  }
}

function ensureDefaultIdentity({
  home = os.homedir(),
  platform = process.platform,
  runner = spawnSync,
} = {}) {
  const sshDirectory = path.join(home, ".ssh");
  if (fs.existsSync(sshDirectory)) {
    const info = fs.lstatSync(sshDirectory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("~/.ssh 不是安全目录");
    if (typeof process.getuid === "function" && info.uid !== process.getuid()) throw new Error("~/.ssh 不属于当前用户");
  } else {
    fs.mkdirSync(sshDirectory, { mode: 0o700 });
  }
  if (platform !== "win32") fs.chmodSync(sshDirectory, 0o700);

  const privateKeyPath = path.join(sshDirectory, "id_ed25519");
  const publicKeyPath = `${privateKeyPath}.pub`;
  const privateExists = fs.existsSync(privateKeyPath);
  const publicExists = fs.existsSync(publicKeyPath);
  if (privateExists !== publicExists) {
    throw new Error("默认 ED25519 SSH 密钥不完整，请先修复 ~/.ssh/id_ed25519 及其 .pub 文件");
  }
  if (!privateExists) {
    const generated = runner("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", privateKeyPath], {
      encoding: "utf8",
      stdio: ["inherit", "inherit", "inherit"],
    });
    if (generated.error || generated.status !== 0) throw new Error("无法创建默认 ED25519 SSH 密钥");
  }
  if (platform !== "win32") fs.chmodSync(privateKeyPath, 0o600);
  assertSafeIdentityFile(privateKeyPath, { privateKey: true, platform });
  assertSafeIdentityFile(publicKeyPath, { platform });
  const publicKey = fs.readFileSync(publicKeyPath, "utf8").trim();
  if (publicKey.length > 16384 || !/^ssh-ed25519 [A-Za-z0-9+/=]+(?: [^\r\n]*)?$/.test(publicKey)) {
    throw new Error("默认 ED25519 SSH 公钥格式无效");
  }
  return { privateKeyPath, publicKey };
}

function spawnInteractiveWithInput(command, args, { input, env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ["pipe", "inherit", "inherit"] });
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
    child.stdin.on("error", (error) => {
      if (error.code !== "EPIPE") reject(error);
    });
    child.stdin.end(input);
  });
}

function probeSshAccess(options, {
  verifier = (command, args, runOptions) => spawnSync(command, args, { ...runOptions, encoding: "utf8" }),
} = {}) {
  const target = normalizeSshTarget(options.ssh, options.sshPort);
  const result = verifier("ssh", [
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=10",
    "-p", String(target.port),
    target.host,
    "true",
  ], { timeout: 30000 });
  return !result.error && result.status === 0;
}

async function prepareSshAccess(options, {
  interactive = process.stdin.isTTY && process.stdout.isTTY,
  ensureIdentity = ensureDefaultIdentity,
  attachedRunner = spawnInteractiveWithInput,
  verifier = (command, args, runOptions) => spawnSync(command, args, { ...runOptions, encoding: "utf8" }),
  write = (value) => process.stdout.write(value),
  completionMessage = true,
} = {}) {
  const target = normalizeSshTarget(options.ssh, options.sshPort);
  if (!interactive) {
    throw new Error("SSH 准备必须在你电脑上的系统终端中运行");
  }
  const identity = ensureIdentity();
  write(`正在为 ${target.host} 准备 SSH 免密连接。接下来系统 ssh 可能要求确认指纹并输入一次服务器密码。\n`);
  const baseArgs = [
    "-i", identity.privateKeyPath,
    "-o", "IdentitiesOnly=yes",
    "-o", "ConnectTimeout=10",
    "-p", String(target.port),
    target.host,
  ];
  const installed = await attachedRunner(
    "ssh",
    ["-o", "BatchMode=no", ...baseArgs, REMOTE_AUTHORIZED_KEYS_SCRIPT],
    { interactive: true, input: `${identity.publicKey}\n`, env: process.env }
  );
  if (installed.signal) throw new Error(`SSH 准备被信号 ${installed.signal} 中断`);
  if (installed.code !== 0) throw new Error("SSH 公钥安装失败，未对服务器执行 Rainbond 安装");

  const verified = verifier("ssh", ["-o", "BatchMode=yes", ...baseArgs, "true"], { timeout: 30000 });
  if (verified.error || verified.status !== 0) throw new Error("SSH 免密连接验证失败，未对服务器执行 Rainbond 安装");
  if (completionMessage) write("SSH 连接准备完成。请回到原来的 AI 任务并回复“已完成”。\n");
  return { ok: true, target };
}

function loadClusterTopology(configPath, {
  platform = process.platform,
  home = os.homedir(),
} = {}) {
  const sourceStateStore = platform === "win32"
    ? createWindowsSecureStateStore({ home })
    : createSecureStateStore({ platform, home });
  const source = readSafeClusterSource(configPath, { platform, sourceStateStore });
  return validateClusterTopology(source.value);
}

async function prepareClusterSshAccess(options, {
  interactive = process.stdin.isTTY && process.stdout.isTTY,
  loadTopology = loadClusterTopology,
  probeAccess = probeSshAccess,
  prepareAccess = prepareSshAccess,
  write = (value) => process.stdout.write(value),
  ...accessDependencies
} = {}) {
  if (!interactive) throw new Error("集群 SSH 准备必须在你电脑上的系统终端中运行");
  const topology = loadTopology(options.clusterConfig);
  const hosts = topology.hosts || [];
  for (let index = 0; index < hosts.length; index += 1) {
    const item = hosts[index];
    const ssh = `${item.user || "root"}@${item.address}`;
    write(`\n[${index + 1}/${hosts.length}] ${item.name}：${ssh}:${item.port}\n`);
    if (probeAccess({ ssh, sshPort: item.port }, accessDependencies)) {
      write(`${item.name} 已可免密连接，跳过。\n`);
      continue;
    }
    try {
      await prepareAccess(
        { ssh, sshPort: item.port },
        { ...accessDependencies, interactive: true, write, completionMessage: false }
      );
    } catch (error) {
      throw new Error(`节点 ${item.name}（${ssh}:${item.port}）SSH 准备失败：${error.message}`);
    }
  }
  write(`\n全部 ${hosts.length} 台服务器的 SSH 连接已准备完成。请回到原来的 AI 任务并回复“已完成”。\n`);
  return { ok: true, hosts: hosts.map(({ name, address, port }) => ({ name, address, port })) };
}

async function main(argv) {
  const options = parseSshPrepareArgs(argv);
  if (options.command === "prepare-cluster") await prepareClusterSshAccess(options);
  else await prepareSshAccess(options);
}

module.exports = {
  REMOTE_AUTHORIZED_KEYS_SCRIPT,
  ensureDefaultIdentity,
  normalizeSshTarget,
  parseSshPrepareArgs,
  prepareClusterSshAccess,
  prepareSshAccess,
  probeSshAccess,
  spawnInteractiveWithInput,
};

if (require.main === module) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`错误：${error.message}\n`);
    process.exitCode = 1;
  });
}
