#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const https = require("node:https");
const os = require("node:os");
const path = require("node:path");
const { Transform, pipeline } = require("node:stream");
const { spawnSync } = require("node:child_process");
const { createSecureStateStore } = require("./secure-state.js");

const REQUEST_SCHEMA = "rainskills.windows-request.v1";
const RESULT_SCHEMA = "rainskills.windows-result.v1";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const USER_ACTIONS = Object.freeze(["Preflight"]);
const MACHINE_ACTIONS = Object.freeze([
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
const STATE_ACTIONS = Object.freeze(["InspectState", "ProtectState"]);
const FIXED_ACTIONS = Object.freeze([...USER_ACTIONS, ...MACHINE_ACTIONS, ...STATE_ACTIONS]);
const WINDOWS_STAGES = Object.freeze([
  "target-selection",
  "preflight",
  "awaiting-confirmation",
  "enabling-wsl",
  "reboot-required",
  "downloading-rootfs",
  "importing-distro",
  "preparing-runtime",
  "installing-rainbond",
  "configuring-windows-access",
  "verifying",
  "platform-ready",
  "authorizing",
  "configured",
]);
const RESULT_KEYS = new Set([
  "schema",
  "action",
  "operation_id",
  "installation_id",
  "nonce",
  "status",
  "facts",
]);
const HOST_PATH_PAYLOAD_KEYS = new Set([
  "helper_path",
  "bootstrap_path",
  "recovery_root",
  "recovery_entry",
  "node_path",
  "rootfs_path",
  "distro_root",
  "installer_path",
]);

function defaultRunner(command, args) {
  return spawnSync(command, args, {
    encoding: "utf8",
    windowsHide: true,
    timeout: 120000,
  });
}

function assertUuid(value, label) {
  if (!UUID_PATTERN.test(String(value || ""))) {
    throw new Error(`${label} 不是有效的 UUID`);
  }
}

function assertSuccessfulExecution(execution, label) {
  if (execution?.error) throw new Error(`${label}：${execution.error.message}`);
  const status = execution?.status ?? execution?.code ?? 0;
  if (status !== 0) {
    throw new Error(`${label}（退出码 ${status}）：${String(execution?.stderr || execution?.stdout || "").trim()}`);
  }
  return execution;
}

function translateWindowsPayloadPaths(payload, pathTranslator = (value) => value) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
  return Object.fromEntries(Object.entries(payload).map(([key, value]) => [
    key,
    HOST_PATH_PAYLOAD_KEYS.has(key) && typeof value === "string" && value
      ? pathTranslator(value)
      : value,
  ]));
}

function resolveWindowsUserSid(runner = defaultRunner, systemRoot = process.env.SystemRoot || "C:\\Windows") {
  const executable = path.win32.join(systemRoot, "System32", "whoami.exe");
  const execution = assertSuccessfulExecution(
    runner(executable, ["/user", "/fo", "csv", "/nh"]),
    "无法读取当前 Windows 用户 SID"
  );
  const match = String(execution.stdout || "").match(/S-\d-(?:\d+-)+\d+/i);
  if (!match) throw new Error("whoami 未返回有效的当前 Windows 用户 SID");
  return match[0].toUpperCase();
}

function createWindowsSecureStateStore({
  home = os.homedir(),
  runner = defaultRunner,
  powershell = "powershell.exe",
  helperPath = path.join(__dirname, "windows-platform.ps1"),
  currentSid = resolveWindowsUserSid(runner),
  ...options
} = {}) {
  function invokeStateAction(action, targetPath, expectedKind) {
    if (!STATE_ACTIONS.includes(action)) throw new Error(`不允许的 Windows 状态 action：${action}`);
    const args = [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      helperPath,
      "-Action",
      action,
      "-TargetPath",
      targetPath,
      "-ExpectedKind",
      expectedKind,
      "-UserSid",
      currentSid,
      "-UserHome",
      home,
    ];
    return assertSuccessfulExecution(
      runner(powershell, args),
      `Windows 状态 ACL ${action} 失败`
    );
  }

  return createSecureStateStore({
    ...options,
    platform: "win32",
    home,
    currentSid,
    inspectWindowsAcl(targetPath, expectedKind) {
      const execution = invokeStateAction("InspectState", targetPath, expectedKind);
      try {
        return JSON.parse(String(execution.stdout || "").trim());
      } catch {
        throw new Error(`Windows 状态 ACL 检查未返回有效 JSON：${targetPath}`);
      }
    },
    hardenWindowsAcl(targetPath, expectedKind) {
      invokeStateAction("ProtectState", targetPath, expectedKind);
    },
  });
}

const TRANSITION_REQUIREMENTS = new Map([
  ["target-selection:preflight", [(facts) => facts.targetKind === "local-windows"]],
  ["preflight:awaiting-confirmation", ["preflightPassed"]],
  ["awaiting-confirmation:enabling-wsl", ["confirmed", "refreshedPreflightPassed"]],
  ["enabling-wsl:reboot-required", ["rebootPending", "recoveryTasksVerified"]],
  ["enabling-wsl:downloading-rootfs", ["wslVerified", (facts) => facts.wslDefaultVersion === 2, (facts) => !facts.rebootPending]],
  ["reboot-required:downloading-rootfs", ["wslVerified", (facts) => facts.wslDefaultVersion === 2, (facts) => !facts.rebootPending]],
  ["downloading-rootfs:importing-distro", ["rootfsArtifactReady"]],
  ["importing-distro:preparing-runtime", ["distroIdentityVerified"]],
  ["preparing-runtime:installing-rainbond", ["systemdReady", "networkGateReady", "dockerReady"]],
  ["installing-rainbond:configuring-windows-access", ["rainbondRuntimeVerified"]],
  ["configuring-windows-access:verifying", ["networkManifestVerified", "portproxyVerified"]],
  ["verifying:platform-ready", ["wslHealthVerified", "windowsHealthVerified"]],
  ["platform-ready:authorizing", ["consoleReachable"]],
  ["authorizing:configured", ["clientsConfigured", "mcpVerified"]],
]);

function validateWindowsStageTransition({
  from,
  to,
  facts,
  expectedInstallationId,
  now = Date.now(),
  maximumFactAgeMs = 5 * 60 * 1000,
}) {
  assertUuid(expectedInstallationId, "installation id");
  if (!facts || facts.installationId !== expectedInstallationId) {
    throw new Error("阶段事实中的 installation_id 与当前安装不匹配");
  }
  const observedAt = Date.parse(facts.observedAt || "");
  if (!Number.isFinite(observedAt) || observedAt > now + 30000 || now - observedAt > maximumFactAgeMs) {
    throw new Error("阶段事实已经过期，必须重新检查系统状态");
  }
  const requirements = TRANSITION_REQUIREMENTS.get(`${from}:${to}`);
  if (!requirements) throw new Error(`不允许的 Windows 安装阶段跳转：${from} -> ${to}`);
  const missing = requirements.find((requirement) => (
    typeof requirement === "function" ? !requirement(facts) : facts[requirement] !== true
  ));
  if (missing) throw new Error(`Windows 安装阶段 ${from} -> ${to} 缺少最新系统事实`);
  return true;
}

function assertSafeRelativePath(relativePath) {
  if (typeof relativePath !== "string" || !relativePath || path.isAbsolute(relativePath)) {
    throw new Error(`恢复包路径必须是安全的相对路径：${relativePath}`);
  }
  const normalized = path.normalize(relativePath);
  if (normalized === ".." || normalized.startsWith(`..${path.sep}`)) {
    throw new Error(`恢复包路径越界：${relativePath}`);
  }
  return normalized;
}

function hashFile(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function hashFilePrefix(filePath, expectedBytes) {
  const hash = crypto.createHash("sha256");
  const file = fs.openSync(filePath, "r");
  const buffer = Buffer.allocUnsafe(Math.min(expectedBytes, 1024 * 1024));
  let offset = 0;
  try {
    while (offset < expectedBytes) {
      const bytesRead = fs.readSync(file, buffer, 0, Math.min(buffer.length, expectedBytes - offset), offset);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
  } finally {
    fs.closeSync(file);
  }
  if (offset !== expectedBytes) throw new Error(`下载文件提前结束（实际 ${offset} bytes，期望 ${expectedBytes} bytes）`);
  return hash.digest("hex");
}

function verifyPinnedArtifact(filePath, expectedBytes, expectedSha256) {
  const info = fs.statSync(filePath);
  const prefixSha256 = info.size >= expectedBytes
    ? hashFilePrefix(filePath, expectedBytes)
    : hashFile(filePath);
  if (info.size >= expectedBytes && prefixSha256 === expectedSha256) {
    const trimmedBytes = info.size - expectedBytes;
    if (trimmedBytes > 0) {
      const file = fs.openSync(filePath, "r+");
      try {
        fs.ftruncateSync(file, expectedBytes);
        fs.fsyncSync(file);
      } finally {
        fs.closeSync(file);
      }
    }
    return { verified: true, actualBytes: info.size, actualSha256: prefixSha256, trimmedBytes };
  }
  return {
    verified: false,
    actualBytes: info.size,
    actualSha256: info.size === expectedBytes ? prefixSha256 : hashFile(filePath),
    trimmedBytes: 0,
  };
}

function collectRecoveryFiles(packageRoot, requiredFiles, requiredDirectories) {
  const files = new Set(requiredFiles.map(assertSafeRelativePath));
  function visit(relativeDirectory) {
    const safeDirectory = assertSafeRelativePath(relativeDirectory);
    const absoluteDirectory = path.join(packageRoot, safeDirectory);
    const info = fs.lstatSync(absoluteDirectory);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error(`恢复包目录必须是普通目录，不能是 reparse point：${safeDirectory}`);
    }
    for (const entry of fs.readdirSync(absoluteDirectory, { withFileTypes: true })) {
      const relative = path.join(safeDirectory, entry.name);
      const absolute = path.join(packageRoot, relative);
      const childInfo = fs.lstatSync(absolute);
      if (childInfo.isSymbolicLink()) throw new Error(`恢复包拒绝符号链接或 reparse point：${relative}`);
      if (childInfo.isDirectory()) visit(relative);
      else if (childInfo.isFile()) files.add(relative);
      else throw new Error(`恢复包包含不支持的文件类型：${relative}`);
    }
  }
  for (const directory of requiredDirectories) visit(directory);
  return [...files].sort();
}

function createRecoveryBundle({ packageRoot, bundleRoot, requiredFiles, requiredDirectories }) {
  const sourceRoot = path.resolve(packageRoot);
  const destinationRoot = path.resolve(bundleRoot);
  if (destinationRoot === sourceRoot || destinationRoot.startsWith(`${sourceRoot}${path.sep}`)) {
    throw new Error("恢复包目标不能位于 npm 包目录内部");
  }
  if (fs.existsSync(destinationRoot) && fs.readdirSync(destinationRoot).length > 0) {
    throw new Error(`恢复包目标目录必须为空：${destinationRoot}`);
  }
  fs.mkdirSync(destinationRoot, { recursive: true, mode: 0o700 });
  fs.chmodSync(destinationRoot, 0o700);
  const relativeFiles = collectRecoveryFiles(sourceRoot, requiredFiles, requiredDirectories);
  const entries = [];
  for (const relative of relativeFiles) {
    const source = path.join(sourceRoot, relative);
    const info = fs.lstatSync(source);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error(`恢复包文件必须是普通文件：${relative}`);
    const destination = path.join(destinationRoot, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
    fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(destination, 0o600);
    entries.push({ path: relative.split(path.sep).join("/"), sha256: hashFile(destination), size: info.size });
  }
  const manifest = {
    schema: "rainskills.windows-recovery-bundle.v1",
    version: 1,
    files: entries,
  };
  fs.writeFileSync(path.join(destinationRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  return manifest;
}

function verifyRecoveryBundle(bundleRoot, suppliedManifest = null) {
  const root = path.resolve(bundleRoot);
  const manifestPath = path.join(root, "manifest.json");
  const manifest = suppliedManifest || JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (manifest.schema !== "rainskills.windows-recovery-bundle.v1" || manifest.version !== 1 || !Array.isArray(manifest.files)) {
    throw new Error("恢复包 manifest 版本无效");
  }
  const expected = new Set(["manifest.json"]);
  for (const entry of manifest.files) {
    const relative = assertSafeRelativePath(entry.path);
    const target = path.join(root, relative);
    const info = fs.lstatSync(target);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error(`恢复包文件无效：${entry.path}`);
    if (info.size !== entry.size || hashFile(target) !== entry.sha256) {
      throw new Error(`恢复包摘要不匹配：${entry.path}`);
    }
    expected.add(relative.split(path.sep).join("/"));
  }
  const actual = new Set();
  function visit(directory, relativeDirectory = "") {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const relative = path.join(relativeDirectory, entry.name);
      const target = path.join(directory, entry.name);
      const info = fs.lstatSync(target);
      if (info.isSymbolicLink()) throw new Error(`恢复包拒绝符号链接或 reparse point：${relative}`);
      if (info.isDirectory()) visit(target, relative);
      else if (info.isFile()) actual.add(relative.split(path.sep).join("/"));
      else throw new Error(`恢复包包含不支持的文件类型：${relative}`);
    }
  }
  visit(root);
  const extra = [...actual].filter((relative) => !expected.has(relative));
  const missing = [...expected].filter((relative) => !actual.has(relative));
  if (extra.length || missing.length) throw new Error(`恢复包文件清单不匹配：extra=${extra.join(",")} missing=${missing.join(",")}`);
  return { ok: true, manifest };
}

function gibibytes(bytes) {
  return Number(bytes || 0) / 1024 ** 3;
}

function normalizedOrigin(value) {
  try {
    return new URL(value).origin;
  } catch {
    return "";
  }
}

function validateArtifactRedirect(currentUrl, nextUrl, allowedOrigins) {
  const allowed = new Set((allowedOrigins || []).map(normalizedOrigin));
  let current;
  let next;
  try {
    current = new URL(currentUrl);
    next = new URL(nextUrl, current);
  } catch {
    throw new Error("下载地址或跳转地址无效");
  }
  if (current.protocol !== "https:" || next.protocol !== "https:") {
    throw new Error("Windows 安装产物只允许 HTTPS 下载");
  }
  if (!allowed.has(current.origin) || !allowed.has(next.origin)) {
    throw new Error(`下载出现未获准的跳转来源：${next.origin}`);
  }
  return true;
}

function resolveArtifactDownloadResponse({ statusCode, headers = {}, existingBytes = 0, expectedBytes }) {
  const responseBytes = Number.parseInt(headers["content-length"] || "0", 10);
  if (statusCode === 200) {
    if (expectedBytes && responseBytes > 0 && responseBytes !== expectedBytes) {
      throw new Error(`下载服务器返回的文件大小与固定版本不匹配（实际 ${responseBytes} bytes，期望 ${expectedBytes} bytes）`);
    }
    return {
      append: false,
      startingBytes: 0,
      total: responseBytes > 0 ? responseBytes : null,
    };
  }
  if (statusCode !== 206 || existingBytes <= 0) {
    throw new Error("下载服务器返回了无效的断点续传响应");
  }
  const match = String(headers["content-range"] || "").match(/^bytes (\d+)-(\d+)\/(\d+)$/i);
  if (!match) throw new Error("下载服务器缺少有效的 Content-Range");
  const start = Number(match[1]);
  const end = Number(match[2]);
  const total = Number(match[3]);
  const rangeBytes = end - start + 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || !Number.isSafeInteger(total) ||
      start !== existingBytes || end < start || end !== total - 1 ||
      (responseBytes > 0 && responseBytes !== rangeBytes)) {
    throw new Error("下载服务器的断点续传响应与本地缓存不匹配");
  }
  if (expectedBytes && total !== expectedBytes) {
    throw new Error(`下载服务器返回的文件大小与固定版本不匹配（实际 ${total} bytes，期望 ${expectedBytes} bytes）`);
  }
  return { append: true, startingBytes: existingBytes, total };
}

function createArtifactByteLimiter({ startingBytes = 0, expectedBytes, maximumBytes = expectedBytes, totalBytes = expectedBytes, onProgress }) {
  let current = startingBytes;
  const exactSizeRequired = Number.isSafeInteger(expectedBytes) && expectedBytes > 0;
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes <= 0) throw new Error("下载文件大小上限无效");
  return new Transform({
    transform(chunk, encoding, callback) {
      const next = current + chunk.length;
      if (next > maximumBytes) {
        callback(new Error(exactSizeRequired
          ? `下载源发送的数据超过固定版本大小（超过 ${expectedBytes} bytes）`
          : `下载文件超过大小上限（超过 ${maximumBytes} bytes）`));
        return;
      }
      current = next;
      onProgress?.({ current, total: totalBytes });
      callback(null, chunk);
    },
    flush(callback) {
      if (exactSizeRequired && current !== expectedBytes) {
        callback(new Error(`下载源提前结束（实际 ${current} bytes，期望 ${expectedBytes} bytes）`));
        return;
      }
      callback();
    },
  });
}

function defaultArtifactDownload({ url, partialPath, allowedOrigins, expectedBytes, maximumBytes = expectedBytes, onProgress, maximumRedirects = 5 }) {
  return new Promise((resolve, reject) => {
    function requestUrl(currentUrl, redirectsRemaining) {
      const existingBytes = fs.existsSync(partialPath) ? fs.statSync(partialPath).size : 0;
      const request = https.get(currentUrl, {
        headers: existingBytes > 0 ? { Range: `bytes=${existingBytes}-` } : {},
        timeout: 30000,
      }, (response) => {
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          response.resume();
          if (redirectsRemaining <= 0) return reject(new Error("下载跳转次数过多"));
          const nextUrl = new URL(response.headers.location, currentUrl).toString();
          try {
            validateArtifactRedirect(currentUrl, nextUrl, allowedOrigins);
          } catch (error) {
            reject(error);
            return;
          }
          requestUrl(nextUrl, redirectsRemaining - 1);
          return;
        }
        if (![200, 206].includes(response.statusCode)) {
          response.resume();
          reject(new Error(`下载失败，HTTP ${response.statusCode}`));
          return;
        }
        let responseMode;
        try {
          responseMode = resolveArtifactDownloadResponse({
            statusCode: response.statusCode,
            headers: response.headers,
            existingBytes,
            expectedBytes,
          });
        } catch (error) {
          response.resume();
          reject(error);
          return;
        }
        const { append, startingBytes, total } = responseMode;
        if (Number.isSafeInteger(maximumBytes) && total && total > maximumBytes) {
          response.resume();
          reject(new Error(`下载文件超过大小上限（实际 ${total} bytes，上限 ${maximumBytes} bytes）`));
          return;
        }
        const output = fs.createWriteStream(partialPath, { flags: append ? "a" : "w", mode: 0o600 });
        const limiter = createArtifactByteLimiter({
          startingBytes,
          expectedBytes,
          maximumBytes,
          totalBytes: total || null,
          onProgress,
        });
        pipeline(response, limiter, output, (error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve({ finalUrl: currentUrl, bytes: fs.statSync(partialPath).size });
        });
      });
      request.on("timeout", () => request.destroy(new Error("下载连接超时")));
      request.on("error", reject);
    }
    requestUrl(url, maximumRedirects);
  });
}

function hasLegacyProgressPrefix(filePath) {
  const prefix = Buffer.from('{"schema":"rainskills.platform-progress.v1"');
  const header = Buffer.alloc(prefix.length);
  const file = fs.openSync(filePath, "r");
  try {
    return fs.readSync(file, header, 0, header.length, 0) === header.length
      && header.equals(prefix);
  } finally {
    fs.closeSync(file);
  }
}

async function ensureRootfsArtifact({
  destination,
  urls,
  maximumBytes,
  allowedOrigins,
  download = defaultArtifactDownload,
  onProgress,
  onRetry,
}) {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes <= 0) throw new Error("Ubuntu 根文件系统大小上限无效");
  if (!Array.isArray(urls) || urls.length === 0) throw new Error("Ubuntu 根文件系统下载源无效");
  for (const sourceUrl of urls) validateArtifactRedirect(sourceUrl, sourceUrl, allowedOrigins);
  if (fs.existsSync(destination)) {
    const info = fs.lstatSync(destination);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error(`Ubuntu 根文件系统不是安全的普通文件：${destination}`);
    if (info.size > 0 && info.size <= maximumBytes && !hasLegacyProgressPrefix(destination)) {
      return { reused: true, path: destination, bytes: info.size, finalUrl: urls[0] };
    }
    quarantineFile(destination);
  }
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  let lastFailure = null;
  for (let attempt = 0; attempt < urls.length; attempt += 1) {
    const sourceUrl = urls[attempt];
    const partialPath = `${destination}.partial.${process.pid}.${crypto.randomBytes(8).toString("hex")}`;
    let result;
    try {
      result = await download({
        url: sourceUrl,
        partialPath,
        allowedOrigins,
        maximumBytes,
        onProgress,
      });
      const info = fs.lstatSync(partialPath);
      if (info.isSymbolicLink() || !info.isFile() || info.size <= 0 || info.size > maximumBytes) {
        throw new Error("下载结果不是有效的非空文件");
      }
      fs.chmodSync(partialPath, 0o600);
      fs.renameSync(partialPath, destination);
      return { reused: false, path: destination, bytes: info.size, finalUrl: result.finalUrl || sourceUrl };
    } catch (error) {
      const actualBytes = fs.existsSync(partialPath) ? fs.statSync(partialPath).size : 0;
      if (fs.existsSync(partialPath)) quarantineFile(partialPath);
      lastFailure = { actualBytes, reason: error.message, sourceUrl };
      if (attempt + 1 < urls.length) {
        onRetry?.({ ...lastFailure, nextUrl: urls[attempt + 1] });
        continue;
      }
    }
  }
  throw new Error(`Ubuntu 根文件系统下载失败${lastFailure ? `：${lastFailure.reason}` : ""}`);
}

function quarantineFile(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const info = fs.lstatSync(filePath);
  if (info.isSymbolicLink() || !info.isFile()) throw new Error(`下载缓存不是安全的普通文件：${filePath}`);
  const quarantine = `${filePath}.invalid-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
  fs.renameSync(filePath, quarantine);
  return quarantine;
}

async function ensurePinnedArtifact({
  destination,
  urls,
  expectedBytes,
  sha256,
  allowedOrigins,
  download = defaultArtifactDownload,
  onProgress,
  onRetry,
}) {
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes <= 0) throw new Error("安装产物固定大小无效");
  if (!/^[a-f0-9]{64}$/.test(String(sha256 || ""))) throw new Error("安装产物 SHA-256 无效");
  if (!Array.isArray(urls) || urls.length === 0) throw new Error("安装产物下载源无效");
  for (const sourceUrl of urls) validateArtifactRedirect(sourceUrl, sourceUrl, allowedOrigins);
  if (fs.existsSync(destination)) {
    const info = fs.lstatSync(destination);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error(`安装产物不是安全的普通文件：${destination}`);
    if (info.size === expectedBytes && hashFile(destination) === sha256) {
      return { reused: true, path: destination, bytes: info.size, finalUrl: urls[0], trimmedBytes: 0 };
    }
    quarantineFile(destination);
  }
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  let lastMismatch = null;
  for (let attempt = 0; attempt < urls.length; attempt += 1) {
    const sourceUrl = urls[attempt];
    const partialPath = `${destination}.partial.${process.pid}.${crypto.randomBytes(8).toString("hex")}`;
    let result;
    try {
      result = await download({ url: sourceUrl, partialPath, allowedOrigins, expectedBytes, onProgress });
    } catch (error) {
      if (fs.existsSync(partialPath)) {
        const verification = verifyPinnedArtifact(partialPath, expectedBytes, sha256);
        if (verification.verified) {
          fs.chmodSync(partialPath, 0o600);
          fs.renameSync(partialPath, destination);
          return {
            reused: false,
            path: destination,
            bytes: expectedBytes,
            finalUrl: sourceUrl,
            trimmedBytes: verification.trimmedBytes,
          };
        }
        lastMismatch = { ...verification, expectedBytes, expectedSha256: sha256 };
        quarantineFile(partialPath);
      } else {
        lastMismatch = { actualBytes: 0, expectedBytes, actualSha256: null, expectedSha256: sha256 };
      }
      if (attempt + 1 >= urls.length) break;
      onRetry?.({ ...lastMismatch, reason: error.message, sourceUrl, nextUrl: urls[attempt + 1] });
      continue;
    }
    if (fs.existsSync(partialPath)) {
      const verification = verifyPinnedArtifact(partialPath, expectedBytes, sha256);
      if (verification.verified) {
        fs.chmodSync(partialPath, 0o600);
        fs.renameSync(partialPath, destination);
        return {
          reused: false,
          path: destination,
          bytes: expectedBytes,
          finalUrl: result.finalUrl || sourceUrl,
          trimmedBytes: verification.trimmedBytes,
        };
      }
      lastMismatch = { ...verification, expectedBytes, expectedSha256: sha256 };
      quarantineFile(partialPath);
      if (attempt + 1 < urls.length) {
        onRetry?.({ ...lastMismatch, reason: "文件完整性校验失败", sourceUrl, nextUrl: urls[attempt + 1] });
        continue;
      }
    }
    break;
  }
  const detail = lastMismatch
    ? `（实际 ${lastMismatch.actualBytes} bytes，SHA-256 ${lastMismatch.actualSha256}；期望 ${lastMismatch.expectedBytes} bytes，SHA-256 ${lastMismatch.expectedSha256}）`
    : "";
  throw new Error(`下载完成，但 Ubuntu 根文件系统 SHA-256 校验失败${detail}`);
}

function ipv4ToInteger(address) {
  const parts = String(address).split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    throw new Error(`无效的 IPv4 地址：${address}`);
  }
  return (((parts[0] * 256 + parts[1]) * 256 + parts[2]) * 256 + parts[3]) >>> 0;
}

function integerToIpv4(value) {
  const normalized = Number(value) >>> 0;
  return [24, 16, 8, 0].map((shift) => (normalized >>> shift) & 255).join(".");
}

function cidrRange(cidr) {
  const [address, rawPrefix] = String(cidr).split("/", 2);
  const prefix = Number(rawPrefix);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) throw new Error(`无效的 IPv4 CIDR：${cidr}`);
  const size = 2 ** (32 - prefix);
  const start = Math.floor(ipv4ToInteger(address) / size) * size;
  return { start, end: start + size - 1 };
}

function rangesOverlap(left, right) {
  return left.start <= right.end && right.start <= left.end;
}

function selectManagedSubnet(routePrefixes) {
  const occupied = (routePrefixes || [])
    .filter((prefix) => prefix !== "0.0.0.0/0")
    .map(cidrRange);
  for (let third = 255; third >= 1; third -= 1) {
    const cidr = `172.31.${third}.0/30`;
    const candidate = cidrRange(cidr);
    if (!occupied.some((route) => rangesOverlap(candidate, route))) {
      return {
        cidr,
        hostAddress: integerToIpv4(candidate.start + 1),
        guestAddress: integerToIpv4(candidate.start + 2),
      };
    }
  }
  throw new Error("没有找到可用的非重叠 /30 子网");
}

function managedNetworkFromCidr(cidr) {
  const range = cidrRange(cidr);
  if (range.end - range.start !== 3) throw new Error(`RainSkills 受管网络必须是 /30：${cidr}`);
  return {
    cidr,
    hostAddress: integerToIpv4(range.start + 1),
    guestAddress: integerToIpv4(range.start + 2),
  };
}

function redactSensitiveText(value) {
  return String(value || "")
    .replace(/(authorization\s*:\s*bearer\s+)[^\s]+/gi, "$1[REDACTED]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[REDACTED]")
    .replace(/((?:password|device[_-]?code|access[_-]?token|refresh[_-]?token)=)[^&\s]+/gi, "$1[REDACTED]")
    .replace(/("(?:password|device[_-]?code|access[_-]?token|refresh[_-]?token)"\s*:\s*")[^"]+("?)/gi, "$1[REDACTED]$2");
}

function evaluateWindowsDeployment(facts, policy) {
  const blockers = [];
  if (!facts || facts.installationId !== facts.expectedInstallationId) {
    blockers.push("部署验证的 installation_id 不匹配");
  }
  if (!facts?.containerRunning) blockers.push("Rainbond 外层容器未运行");
  if (!facts?.nodeReady) blockers.push("Rainbond K3s 节点尚未 Ready");
  if (!facts?.componentsReady) blockers.push("rbd-system 组件尚未全部就绪");
  if (!facts?.wslConsoleReachable) blockers.push("WSL 内无法访问 Rainbond Console");
  if (!facts?.windowsConsoleReachable) blockers.push("Windows 无法通过 127.0.0.1 访问 Rainbond Console");
  const listening = new Set((facts?.portsListening || []).map(Number));
  const missingPorts = (policy?.windows?.managed_ports || []).filter((port) => !listening.has(port));
  if (missingPorts.length > 0) blockers.push(`端口 80、443、6060、7070 尚未全部监听，缺少：${missingPorts.join("、")}`);
  if (!/^(?:\d{1,3}\.){3}\d{1,3}$/.test(String(facts?.guestAddress || ""))) {
    blockers.push("Rainbond WSL 固定地址无效");
  }
  return {
    ok: blockers.length === 0,
    blockers,
    location: "本地（Windows / WSL2）",
    consoleUrl: "http://127.0.0.1:7070",
    controlConsoleUrl: facts?.controlMode === "wsl"
      ? `http://${facts.guestAddress}:7070`
      : "http://127.0.0.1:7070",
  };
}

function evaluateWindowsPreflight(facts, policy, expectedUserSid) {
  if (!facts || typeof facts !== "object" || Array.isArray(facts)) {
    throw new Error("Windows 预检事实无效");
  }
  const windowsPolicy = policy?.windows;
  if (!windowsPolicy) throw new Error("缺少 Windows 安装策略");

  const blockers = [];
  const minimums = policy.minimums;
  if (!windowsPolicy.supported_product_types.includes(facts.productType)) {
    blockers.push("仅支持 Windows 工作站版本，当前系统不是受支持的 Windows 工作站");
  }
  if (Number(facts.buildNumber) < windowsPolicy.minimum_build) {
    blockers.push(`Windows 系统版本过低，内部版本至少需要 ${windowsPolicy.minimum_build}`);
  }
  if (!windowsPolicy.supported_architectures.includes(facts.architecture)) {
    blockers.push(`仅支持 ${windowsPolicy.supported_architectures.join("、")} 架构，当前为 ${facts.architecture || "未知"}`);
  }
  if (!expectedUserSid || String(facts.currentUserSid || "").toUpperCase() !== String(expectedUserSid).toUpperCase()) {
    blockers.push("当前用户 SID 与启动安装的用户不一致");
  }
  if (!facts.isAdministrator) blockers.push("当前用户必须属于本机 Administrators 组，后续操作仍会显示 UAC 确认");
  if (!facts.uacEnabled) blockers.push("必须启用 Windows UAC，才能安全执行需要管理员权限的固定操作");
  if (Number(facts.cpuCores) < minimums.cpu_cores) {
    blockers.push(`CPU 至少需要 ${minimums.cpu_cores} 核，当前 ${Number(facts.cpuCores) || 0} 核`);
  }
  if (Number(facts.memoryBytes) < minimums.memory_bytes) {
    blockers.push(`内存至少需要 8 GB，当前 ${gibibytes(facts.memoryBytes).toFixed(1)} GB`);
  }
  if (Number(facts.diskBytes) < minimums.disk_bytes) {
    blockers.push(`可用磁盘至少需要 50 GB，当前 ${gibibytes(facts.diskBytes).toFixed(1)} GB`);
  }
  if (!facts.virtualizationEnabled) blockers.push("未检测到可用的固件虚拟化，请先在 BIOS/UEFI 中启用虚拟化");
  if (facts.wslInstalled && !windowsPolicy.networking_modes.includes(String(facts.wslNetworkingMode || "").toLowerCase())) {
    blockers.push(`WSL 必须使用 NAT 网络模式，当前为 ${facts.wslNetworkingMode || "未知"}`);
  }
  if (Array.isArray(facts.occupiedPorts) && facts.occupiedPorts.length > 0) {
    blockers.push(`本机端口 ${facts.occupiedPorts.join("、")} 已被占用`);
  }
  if (Array.isArray(facts.unknownManagedObjects) && facts.unknownManagedObjects.length > 0) {
    blockers.push(`检测到未知的 RainSkills 管理对象：${facts.unknownManagedObjects.join("、")}`);
  }
  if (!facts.availableSubnet || !/^(?:\d{1,3}\.){3}\d{1,3}\/30$/.test(facts.availableSubnet)) {
    blockers.push("没有找到不与现有网络重叠的可用 /30 子网");
  }

  const allowedOrigins = new Set(windowsPolicy.preflight_allowed_origins.map(normalizedOrigin));
  const rootfsOrigins = new Set(windowsPolicy.ubuntu_rootfs.urls.map(normalizedOrigin));
  const checks = new Map((facts.originChecks || []).map((check) => [normalizedOrigin(check.origin), check]));
  let rootfsReachable = false;
  for (const origin of allowedOrigins) {
    const check = checks.get(origin);
    if (rootfsOrigins.has(origin)) {
      if (check?.reachable === true) rootfsReachable = true;
    } else if (!check || check.reachable !== true) {
      blockers.push(`无法访问安装所需地址 ${origin}`);
    }
    for (const redirect of check?.redirectOrigins || []) {
      const redirectOrigin = normalizedOrigin(redirect);
      if (!allowedOrigins.has(redirectOrigin)) blockers.push(`检测到未获准的跳转来源 ${redirectOrigin || redirect}`);
    }
  }
  if (!rootfsReachable) blockers.push("无法访问任何经过校验的 Ubuntu 根文件系统镜像");

  return {
    ok: blockers.length === 0,
    blockers,
    effects: [
      "启用 WSL 2 和虚拟机平台组件（可能需要重启 Windows）",
      "安装或更新经过验证的 WSL 运行时",
      "下载 Ubuntu 22.04 根文件系统",
      "创建专用的 Rainbond WSL 发行版",
      "配置本机 NAT 网络和 127.0.0.1 端口转发",
      "在专用 WSL 环境中安装并验证 Rainbond",
    ],
  };
}

function validateResult(result, expected) {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new Error("Windows helper 结果不是对象");
  }
  const unknown = Object.keys(result).filter((key) => !RESULT_KEYS.has(key));
  if (unknown.length > 0) throw new Error(`Windows helper 结果包含未允许字段：${unknown.join("、")}`);
  function rejectExecutableFields(value) {
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (["command", "script"].includes(key.toLowerCase())) {
        throw new Error(`Windows helper 结果包含未允许字段：${key}`);
      }
      rejectExecutableFields(child);
    }
  }
  rejectExecutableFields(result);
  if (result.schema !== RESULT_SCHEMA || result.action !== expected.action) {
    throw new Error("Windows helper 结果 schema 或 action 不匹配");
  }
  if (result.operation_id !== expected.operationId || result.installation_id !== expected.installationId) {
    throw new Error("Windows helper 结果与当前安装标识不匹配");
  }
  if (result.nonce !== expected.nonce) throw new Error("Windows helper 结果 nonce 不匹配");
  if (!new Set(["ok", "blocked", "error"]).has(result.status)) {
    throw new Error("Windows helper 结果 status 无效");
  }
  if (!result.facts || typeof result.facts !== "object" || Array.isArray(result.facts)) {
    throw new Error("Windows helper 结果缺少结构化 facts");
  }
  if (result.status === "error") {
    const factKeys = Object.keys(result.facts).sort();
    if (factKeys.join(",") !== "failedAction,failureMessage" ||
        result.facts.failedAction !== expected.action ||
        typeof result.facts.failureMessage !== "string" ||
        !result.facts.failureMessage.trim() ||
        result.facts.failureMessage.length > 2000 ||
        /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(result.facts.failureMessage)) {
      throw new Error("Windows helper 错误结果无效");
    }
  }
  return result;
}

function createWindowsPlatformAdapter({
  runner = defaultRunner,
  stateStore,
  policy,
  userSid,
  home = os.homedir(),
  powershell = "powershell.exe",
  helperPath = path.join(__dirname, "windows-platform.ps1"),
  pathTranslator = (value) => value,
  prepareResultForRead = null,
} = {}) {
  if (!stateStore) throw new Error("Windows platform adapter 需要安全状态存储");
  if (!policy?.windows) throw new Error("Windows platform adapter 缺少版本化策略");
  if (!/^S-\d-(?:\d+-)+\d+$/i.test(String(userSid || ""))) {
    throw new Error("Windows platform adapter 需要有效的当前用户 SID");
  }

  async function invoke(action, { operationId, installationId, payload = null }) {
    if (!FIXED_ACTIONS.includes(action)) throw new Error(`不允许的 Windows helper action：${action}`);
    assertUuid(operationId, "operation id");
    assertUuid(installationId, "installation id");
    const nonce = crypto.randomBytes(32).toString("hex");
    const root = path.join(home, ".rainbond", "platform-installer", operationId, "windows");
    stateStore.ensurePrivateDirectory(root);
    const requestPath = path.join(root, `request-${nonce}.json`);
    const resultPath = path.join(root, `result-${nonce}.json`);
    const request = {
      schema: REQUEST_SCHEMA,
      action,
      operation_id: operationId,
      installation_id: installationId,
      nonce,
      user_sid: userSid,
      policy: {
        minimums: policy.minimums,
        installer: policy.installer,
        windows: policy.windows,
      },
    };
    if (action !== "Preflight") request.payload = translateWindowsPayloadPaths(payload || {}, pathTranslator);
    stateStore.atomicWriteJson(requestPath, request);
    const args = [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      pathTranslator(helperPath),
      "-Action",
      action,
      "-RequestPath",
      pathTranslator(requestPath),
      "-ResultPath",
      pathTranslator(resultPath),
    ];
    const execution = await Promise.resolve(runner(powershell, args));
    if (execution?.error?.code === "ETIMEDOUT") {
      throw new Error(`Windows ${action} 等待超时`);
    }
    if (execution?.error) throw new Error(`无法启动 Windows helper：${execution.error.message}`);
    const status = execution?.status ?? execution?.code ?? 0;
    let result = null;
    if (fs.existsSync(resultPath)) {
      if (prepareResultForRead) prepareResultForRead(resultPath);
      else stateStore.protectRegularFile(resultPath);
      result = validateResult(
        stateStore.readProtectedJson(resultPath),
        { action, operationId, installationId, nonce }
      );
    }
    if (result?.status === "error") {
      throw new Error(`Windows ${result.facts.failedAction} 失败：${result.facts.failureMessage}`);
    }
    if (status !== 0) {
      const detail = String(execution?.stderr || execution?.stdout || "").trim();
      throw new Error(`Windows helper 执行失败（退出码 ${status}）${detail ? `：${detail}` : ""}`);
    }
    if (!result) {
      if (prepareResultForRead) prepareResultForRead(resultPath);
      else stateStore.protectRegularFile(resultPath);
      result = validateResult(
        stateStore.readProtectedJson(resultPath),
        { action, operationId, installationId, nonce }
      );
    }
    return result;
  }

  return {
    async preflight({ operationId, installationId }) {
      const result = await invoke("Preflight", { operationId, installationId });
      if (result.status === "error") throw new Error("Windows helper 无法完成预检");
      return {
        ...result,
        assessment: evaluateWindowsPreflight(result.facts, policy, userSid),
      };
    },
    installMachineBundle(options) {
      return invoke("InstallMachineBundle", options);
    },
    prepareWsl(options) {
      return invoke("PrepareWsl", options);
    },
    enableWsl(options) {
      return invoke("EnableWsl", options);
    },
    updateWsl(options) {
      return invoke("UpdateWsl", options);
    },
    verifyWsl(options) {
      return invoke("VerifyWsl", options);
    },
    registerResume(options) {
      return invoke("RegisterResume", options);
    },
    registerFinalize(options) {
      return invoke("RegisterFinalize", options);
    },
    async requestReboot({ interactive, confirmed, ...options }) {
      if (!interactive) throw new Error("Windows 重启只能在交互终端中由用户确认");
      if (!confirmed) throw new Error("Windows 重启需要用户明确确认");
      return invoke("RequestReboot", options);
    },
    finalize(options) {
      return invoke("Finalize", options);
    },
    importDistro(options) {
      return invoke("ImportDistro", options);
    },
    prepareRuntime(options) {
      return invoke("PrepareRuntime", options);
    },
    configureNetwork(options) {
      return invoke("ConfigureNetwork", options);
    },
    verifyNetwork(options) {
      return invoke("VerifyNetwork", options);
    },
    prepareDocker(options) {
      return invoke("PrepareDocker", options);
    },
    installRainbond(options) {
      return invoke("InstallRainbond", options);
    },
    provisionRainbond(options) {
      return invoke("ProvisionRainbond", options);
    },
    verifyDeployment(options) {
      return invoke("VerifyDeployment", options);
    },
  };
}

module.exports = {
  FIXED_ACTIONS,
  MACHINE_ACTIONS,
  REQUEST_SCHEMA,
  RESULT_SCHEMA,
  STATE_ACTIONS,
  USER_ACTIONS,
  WINDOWS_STAGES,
  createRecoveryBundle,
  createArtifactByteLimiter,
  createWindowsSecureStateStore,
  createWindowsPlatformAdapter,
  evaluateWindowsPreflight,
  evaluateWindowsDeployment,
  ensurePinnedArtifact,
  ensureRootfsArtifact,
  managedNetworkFromCidr,
  redactSensitiveText,
  resolveWindowsUserSid,
  resolveArtifactDownloadResponse,
  selectManagedSubnet,
  translateWindowsPayloadPaths,
  validateWindowsStageTransition,
  validateArtifactRedirect,
  verifyRecoveryBundle,
};
