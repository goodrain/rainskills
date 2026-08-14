"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const { normalizeConsoleOrigin } = require("./console-origin.js");
const { createSecureStateStore } = require("./secure-state.js");
const { looksLikeJwt } = require("./windows-auth.js");

const MAX_CREDENTIAL_FILE_BYTES = 16384;

function assertProtectedPosixDirectory(directory) {
  const info = fs.lstatSync(directory);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error("Rainbond 凭据目录必须是受保护的普通目录");
  }
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
    throw new Error("Rainbond 凭据目录 owner 不匹配");
  }
  if ((info.mode & 0o777) !== 0o700) {
    throw new Error("Rainbond 凭据目录权限必须为 0700");
  }
}

function validateCredentialPayload(payload, expectedOrigin) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Rainbond 运行凭据无效");
  }
  if (Object.keys(payload).sort().join(",") !== "origin,token") {
    throw new Error("Rainbond 运行凭据字段无效");
  }
  if (!looksLikeJwt(payload.token)) throw new Error("Rainbond 运行凭据格式无效");
  const origin = normalizeConsoleOrigin(payload.origin);
  if (origin !== normalizeConsoleOrigin(expectedOrigin)) {
    throw new Error("Rainbond 运行凭据 origin 与 onboarding 不匹配");
  }
  return { token: payload.token, origin };
}

function readPosixRuntimeCredential({
  home = os.homedir(),
  expectedOrigin,
  stateStore = createSecureStateStore({ platform: process.platform, home }),
} = {}) {
  const directory = path.join(home, ".rainbond");
  const credentialPath = path.join(directory, "mcp.env");
  assertProtectedPosixDirectory(directory);
  stateStore.assertProtectedRegularFile(credentialPath);
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
  const fd = fs.openSync(credentialPath, flags);
  let content;
  try {
    const info = fs.fstatSync(fd);
    if (!info.isFile()) throw new Error("Rainbond 凭据路径不是普通文件");
    if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
      throw new Error("Rainbond 凭据文件 owner 不匹配");
    }
    if ((info.mode & 0o777) !== 0o600) throw new Error("Rainbond 凭据文件权限必须为 0600");
    if (info.size > MAX_CREDENTIAL_FILE_BYTES) throw new Error("Rainbond 凭据文件过大");
    content = fs.readFileSync(fd, "utf8");
  } finally {
    fs.closeSync(fd);
  }
  const match = content.match(
    /^export RAINBOND_JWT='([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)'\nexport RAINBOND_URL='([^'\r\n]+)'\n?$/
  );
  if (!match) throw new Error("Rainbond 凭据文件语法无效");
  return validateCredentialPayload({ token: match[1], origin: match[2] }, expectedOrigin);
}

function windowsReaderEnvironment(outputPath, source = process.env) {
  const environment = { RAINSKILLS_CREDENTIAL_OUTPUT_PATH: outputPath };
  for (const key of [
    "SystemRoot", "WINDIR", "PATH", "COMSPEC", "TEMP", "TMP", "USERPROFILE",
  ]) {
    if (typeof source[key] === "string") environment[key] = source[key];
  }
  return environment;
}

function readWindowsRuntimeCredential({
  home = process.env.USERPROFILE || os.homedir(),
  expectedOrigin,
  stateStore,
  spawnImpl = spawnSync,
  helperPath = path.join(__dirname, "windows-read-user-environment.ps1"),
  randomUUID = crypto.randomUUID,
} = {}) {
  const store = stateStore || require("./windows-platform.js")
    .createWindowsSecureStateStore({ home });
  const directory = store.ensurePrivateDirectory(path.join(home, ".rainbond", "rainskills"));
  const outputPath = store.assertInsideHome(
    path.join(directory, `.credential-read-${randomUUID()}.json`),
    "凭据读取文件"
  );
  let fd;
  try {
    fd = fs.openSync(outputPath, "wx", 0o600);
    fs.closeSync(fd);
    fd = undefined;
    store.protectRegularFile(outputPath);
    const result = spawnImpl("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-File",
      helperPath,
    ], {
      env: windowsReaderEnvironment(outputPath),
      stdio: ["ignore", "ignore", "ignore"],
      windowsHide: true,
    });
    if (result?.error || result?.signal || result?.status !== 0) {
      throw new Error("无法安全读取 Windows 用户级 Rainbond 凭据");
    }
    store.assertProtectedRegularFile(outputPath);
    const info = fs.lstatSync(outputPath);
    if (info.size > MAX_CREDENTIAL_FILE_BYTES) throw new Error("Rainbond 凭据文件过大");
    let payload;
    try {
      payload = JSON.parse(fs.readFileSync(outputPath, "utf8"));
    } catch {
      throw new Error("Windows 用户级 Rainbond 凭据无效");
    }
    return validateCredentialPayload(payload, expectedOrigin);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try {
      fs.unlinkSync(outputPath);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}

function readRuntimeCredential({ platform = process.platform, ...options } = {}) {
  return platform === "win32"
    ? readWindowsRuntimeCredential(options)
    : readPosixRuntimeCredential(options);
}

module.exports = {
  readPosixRuntimeCredential,
  readRuntimeCredential,
  readWindowsRuntimeCredential,
  validateCredentialPayload,
  windowsReaderEnvironment,
};
