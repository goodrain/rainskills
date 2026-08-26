"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const https = require("node:https");
const os = require("node:os");
const path = require("node:path");
const tls = require("node:tls");

const { createSecureStateStore } = require("./secure-state.js");

const OFFICIAL_LATEST_URL = "https://registry.npmjs.org/rainskills/latest";
const OFFICIAL_REGISTRY = "https://registry.npmjs.org/";
const MIRROR_REGISTRY = "https://registry.npmmirror.com/";
const REGISTRY_SOURCES = Object.freeze({
  official: Object.freeze({
    name: "official",
    registry: OFFICIAL_REGISTRY,
    latestUrl: OFFICIAL_LATEST_URL,
    tarballOrigin: OFFICIAL_REGISTRY,
  }),
  mirror: Object.freeze({
    name: "mirror",
    registry: MIRROR_REGISTRY,
    latestUrl: `${MIRROR_REGISTRY}rainskills/latest`,
    tarballOrigin: "https://cdn.npmmirror.com/",
  }),
});
const UPDATE_STATE_SCHEMA = "rainskills.auto-update.v1";
const UPDATE_STATE_VERSION = 1;
const UPDATE_OPERATION_ID = "b53d72d4-5e88-4aae-9a9d-8305142d0262";
const DEFAULT_CHECK_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_METADATA_BYTES = 64 * 1024;
const MAX_TARBALL_BYTES = 16 * 1024 * 1024;
const METADATA_TIMEOUT_MS = 3000;
const TARBALL_TIMEOUT_MS = 15_000;
const INTERNAL_TIMEOUT_CODE = "RAINSKILLS_REQUEST_TIMEOUT";
const PROTOCOL_ERROR_CODE = "RAINSKILLS_PROTOCOL_ERROR";
const METADATA_FALLBACK_ERROR_CODES = Object.freeze([
  "ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT",
  "EHOSTUNREACH", "ENETUNREACH",
]);
const STABLE_VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const SAFE_ENTRY = Object.freeze(["runtime", "status", "--json"]);
const DEFAULT_AGENT_ROOTS = Object.freeze([
  [".codex", "skills"],
  [".claude", "skills"],
  [".agents", "skills"],
]);
const AUTO_UPDATE_ENVIRONMENT_KEYS = Object.freeze([
  "HOME", "USERPROFILE", "PATH", "Path", "SystemRoot", "ComSpec",
  "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy",
]);

function protocolError(message) {
  const error = new Error(message);
  error.code = PROTOCOL_ERROR_CODE;
  return error;
}

function timeoutError(label) {
  const error = new Error(`${label}请求超时`);
  error.code = INTERNAL_TIMEOUT_CODE;
  return error;
}

function isStableVersion(value) {
  return typeof value === "string" && STABLE_VERSION_PATTERN.test(value);
}

function stableVersionParts(value) {
  if (!isStableVersion(value)) throw new Error("只支持正式版 semver");
  return value.split(".").map((part) => Number.parseInt(part, 10));
}

function compareStableVersions(left, right) {
  const leftParts = stableVersionParts(left);
  const rightParts = stableVersionParts(right);
  for (let index = 0; index < leftParts.length; index += 1) {
    if (leftParts[index] > rightParts[index]) return 1;
    if (leftParts[index] < rightParts[index]) return -1;
  }
  return 0;
}

function isSafeAutoUpdateEntry(args) {
  return Array.isArray(args)
    && args.length === SAFE_ENTRY.length
    && args.every((value, index) => value === SAFE_ENTRY[index]);
}

function tarballUrlFor(source, version) {
  if (source === REGISTRY_SOURCES.mirror) {
    return `${source.tarballOrigin}packages/rainskills/${version}/rainskills-${version}.tgz`;
  }
  return `${source.tarballOrigin}rainskills/-/rainskills-${version}.tgz`;
}

function metadataTarballUrlFor(source, version) {
  return `${source.registry}rainskills/-/rainskills-${version}.tgz`;
}

function sourceForRegistry(registry) {
  return Object.values(REGISTRY_SOURCES).find((source) => source.registry === registry) || null;
}

function validateRegistryLatestMetadata(metadata, source) {
  if (!Object.values(REGISTRY_SOURCES).includes(source)) {
    throw protocolError("npm registry 来源无效");
  }
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw protocolError("npm latest metadata 无效");
  }
  if (metadata.name !== "rainskills" || !isStableVersion(metadata.version)) {
    throw protocolError("npm latest 不是 Rainskills 正式版");
  }
  const expectedMetadataTarball = metadataTarballUrlFor(source, metadata.version);
  const downloadTarball = tarballUrlFor(source, metadata.version);
  if (
    !metadata.dist
    || typeof metadata.dist !== "object"
    || typeof metadata.dist.integrity !== "string"
    || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(metadata.dist.integrity)
    || metadata.dist.tarball !== expectedMetadataTarball
  ) {
    throw protocolError("npm latest 制品来源或完整性信息无效");
  }
  return {
    version: metadata.version,
    registry: source.registry,
    tarball: downloadTarball,
    integrity: metadata.dist.integrity,
  };
}

function validateOfficialLatestMetadata(metadata) {
  return validateRegistryLatestMetadata(metadata, REGISTRY_SOURCES.official);
}

function validateContentLength(headers, maxBytes, { allowZero, label }) {
  const raw = headers && headers["content-length"];
  if (raw === undefined) return;
  if (typeof raw !== "string" || !/^(0|[1-9]\d*)$/.test(raw)) {
    throw protocolError(`${label} Content-Length 无效`);
  }
  const value = Number(raw);
  if ((!allowZero && value === 0) || !Number.isSafeInteger(value) || value > maxBytes) {
    throw protocolError(`${label} Content-Length 超出限制`);
  }
}

function fixedHttpsOptions(headers) {
  return {
    headers,
    rejectUnauthorized: true,
    checkServerIdentity: tls.checkServerIdentity,
    ca: tls.rootCertificates,
  };
}

function fetchRegistryMetadata(source, {
  request = https.get,
  timeoutMs = METADATA_TIMEOUT_MS,
  maxBytes = MAX_METADATA_BYTES,
} = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let req;
    const deadline = setTimeout(() => {
      req?.destroy(timeoutError("npm latest "));
    }, timeoutMs);
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (error) reject(error);
      else resolve(value);
    };
    req = request(source.latestUrl, fixedHttpsOptions({ accept: "application/json" }), (response) => {
      if (response.statusCode !== 200 || response.headers.location) {
        response.resume();
        finish(protocolError("npm latest 响应无效"));
        return;
      }
      try {
        validateContentLength(response.headers, maxBytes, { allowZero: true, label: "npm latest" });
      } catch (error) {
        response.resume();
        finish(error);
        return;
      }
      let size = 0;
      const chunks = [];
      response.on("data", (chunk) => {
        size += chunk.length;
        if (size > maxBytes) {
          req.destroy(protocolError("npm latest 响应过大"));
          return;
        }
        chunks.push(chunk);
      });
      response.once("error", (error) => finish(error));
      response.once("end", () => {
        try {
          const metadata = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          finish(null, validateRegistryLatestMetadata(metadata, source));
        } catch (error) {
          finish(error.code ? error : protocolError("npm latest JSON 无效"));
        }
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(timeoutError("npm latest ")));
    req.once("error", (error) => finish(error));
  });
}

function fetchOfficialLatest(options = {}) {
  return fetchRegistryMetadata(REGISTRY_SOURCES.official, options);
}

function isMetadataFallbackError(error) {
  return error?.code === INTERNAL_TIMEOUT_CODE
    || METADATA_FALLBACK_ERROR_CODES.includes(error?.code);
}

async function fetchLatestWithFallback({
  fetchMetadata = fetchRegistryMetadata,
  ...requestOptions
} = {}) {
  try {
    return await fetchMetadata(REGISTRY_SOURCES.official, requestOptions);
  } catch (error) {
    if (!isMetadataFallbackError(error)) throw error;
    return fetchMetadata(REGISTRY_SOURCES.mirror, requestOptions);
  }
}

function validateUpdateDescriptor(descriptor) {
  const source = sourceForRegistry(descriptor?.registry);
  if (
    !source
    || !isStableVersion(descriptor?.version)
    || descriptor.tarball !== tarballUrlFor(source, descriptor.version)
    || typeof descriptor.integrity !== "string"
    || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(descriptor.integrity)
  ) {
    throw protocolError("自动升级制品描述无效");
  }
  return { ...descriptor };
}

function expectedIntegrityBytes(integrity) {
  const bytes = Buffer.from(integrity.slice("sha512-".length), "base64");
  if (bytes.length !== 64) throw protocolError("自动升级 SHA-512 integrity 无效");
  return bytes;
}

function writeAllSync(fd, chunk) {
  let offset = 0;
  while (offset < chunk.length) {
    offset += fs.writeSync(fd, chunk, offset, chunk.length - offset);
  }
}

function hashOpenFile(fd, maxBytes = MAX_TARBALL_BYTES) {
  const hash = crypto.createHash("sha512");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let size = 0;
  let offset = 0;
  for (;;) {
    const count = fs.readSync(fd, buffer, 0, buffer.length, offset);
    if (count === 0) break;
    size += count;
    if (size > maxBytes) throw protocolError("自动升级本地制品过大");
    hash.update(buffer.subarray(0, count));
    offset += count;
  }
  if (size === 0) throw protocolError("自动升级本地制品为空");
  return { size, digest: hash.digest() };
}

function downloadTarballToDescriptor(descriptor, fd, {
  request = https.get,
  timeoutMs = TARBALL_TIMEOUT_MS,
  maxBytes = MAX_TARBALL_BYTES,
} = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let req;
    let size = 0;
    const hash = crypto.createHash("sha512");
    const deadline = setTimeout(() => req?.destroy(timeoutError("npm tarball ")), timeoutMs);
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (error) reject(error);
      else resolve(value);
    };
    req = request(descriptor.tarball, fixedHttpsOptions({ accept: "application/octet-stream" }), (response) => {
      if (response.statusCode !== 200 || response.headers.location) {
        response.resume();
        finish(protocolError("npm tarball 响应无效"));
        return;
      }
      try {
        validateContentLength(response.headers, maxBytes, { allowZero: false, label: "npm tarball" });
      } catch (error) {
        response.resume();
        finish(error);
        return;
      }
      response.on("data", (chunk) => {
        if (settled) return;
        size += chunk.length;
        if (size > maxBytes) {
          req.destroy(protocolError("npm tarball 响应过大"));
          return;
        }
        try {
          writeAllSync(fd, chunk);
          hash.update(chunk);
        } catch (error) {
          req.destroy(error);
        }
      });
      response.once("error", (error) => finish(error));
      response.once("end", () => {
        if (size === 0) {
          finish(protocolError("npm tarball 为空"));
          return;
        }
        try {
          const actual = hash.digest();
          const expected = expectedIntegrityBytes(descriptor.integrity);
          if (!crypto.timingSafeEqual(actual, expected)) {
            throw protocolError("npm tarball SHA-512 integrity 不匹配");
          }
          finish(null, { size, digest: actual.toString("hex") });
        } catch (error) {
          finish(error);
        }
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(timeoutError("npm tarball ")));
    req.once("error", (error) => finish(error));
  });
}

async function acquireStableUpdateArtifact(descriptor, {
  home = os.homedir(),
  platform = process.platform,
  stateStore = createDefaultStateStore(platform, home),
  request = https.get,
  randomBytes = crypto.randomBytes,
} = {}) {
  const validated = validateUpdateDescriptor(descriptor);
  const directory = stateStore.ensurePrivateDirectory(
    path.join(home, ".rainbond", "rainskills", "update-artifacts")
  );
  const digestPrefix = expectedIntegrityBytes(validated.integrity).toString("hex").slice(0, 16);
  const finalPath = path.join(directory, `rainskills-${validated.version}-${digestPrefix}.tgz`);
  if (fs.existsSync(finalPath)) {
    stateStore.assertProtectedRegularFile(finalPath);
    const noFollow = fs.constants.O_NOFOLLOW || 0;
    const existingFd = fs.openSync(finalPath, fs.constants.O_RDONLY | noFollow);
    let identity;
    try {
      identity = fs.fstatSync(existingFd);
      const pathIdentity = fs.lstatSync(finalPath);
      if (
        pathIdentity.isSymbolicLink()
        || !pathIdentity.isFile()
        || pathIdentity.dev !== identity.dev
        || pathIdentity.ino !== identity.ino
      ) throw protocolError("自动升级既有制品身份发生变化");
      const actual = hashOpenFile(existingFd);
      if (!crypto.timingSafeEqual(actual.digest, expectedIntegrityBytes(validated.integrity))) {
        throw protocolError("自动升级既有制品 SHA-512 integrity 不匹配");
      }
    } finally {
      fs.closeSync(existingFd);
    }
    let cleaned = false;
    return {
      path: finalPath,
      cleanup() {
        if (cleaned) return;
        cleaned = true;
        try {
          const current = fs.lstatSync(finalPath);
          if (
            !current.isSymbolicLink()
            && current.isFile()
            && current.dev === identity.dev
            && current.ino === identity.ino
          ) fs.unlinkSync(finalPath);
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
      },
    };
  }
  const candidatePath = path.join(
    directory,
    `.rainskills-${validated.version}.${process.pid}.${randomBytes(6).toString("hex")}.candidate`
  );
  const noFollow = fs.constants.O_NOFOLLOW || 0;
  let fd;
  let published = false;
  let identity;
  try {
    fd = fs.openSync(
      candidatePath,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow,
      0o600
    );
    await downloadTarballToDescriptor(validated, fd, { request });
    fs.fsyncSync(fd);
    stateStore.protectRegularFile(candidatePath);
    identity = fs.fstatSync(fd);
    const candidateIdentity = fs.lstatSync(candidatePath);
    if (
      candidateIdentity.isSymbolicLink()
      || !candidateIdentity.isFile()
      || candidateIdentity.dev !== identity.dev
      || candidateIdentity.ino !== identity.ino
    ) {
      throw protocolError("自动升级候选制品身份发生变化");
    }
    fs.linkSync(candidatePath, finalPath);
    published = true;
    stateStore.protectRegularFile(finalPath);
    const finalIdentity = fs.lstatSync(finalPath);
    if (
      finalIdentity.isSymbolicLink()
      || !finalIdentity.isFile()
      || finalIdentity.dev !== identity.dev
      || finalIdentity.ino !== identity.ino
    ) {
      throw protocolError("自动升级最终制品身份发生变化");
    }
    fs.unlinkSync(candidatePath);
    if (platform !== "win32") {
      const directoryFd = fs.openSync(directory, "r");
      try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
    }
    fs.closeSync(fd);
    fd = undefined;
    let cleaned = false;
    return {
      path: finalPath,
      cleanup() {
        if (cleaned) return;
        cleaned = true;
        try {
          const current = fs.lstatSync(finalPath);
          if (
            !current.isSymbolicLink()
            && current.isFile()
            && current.dev === identity.dev
            && current.ino === identity.ino
          ) fs.unlinkSync(finalPath);
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
      },
    };
  } catch (error) {
    if (fd !== undefined) fs.closeSync(fd);
    for (const target of [candidatePath, ...(published ? [finalPath] : [])]) {
      try { fs.unlinkSync(target); } catch (cleanupError) {
        if (cleanupError.code !== "ENOENT") throw cleanupError;
      }
    }
    throw error;
  }
}

async function prepareStableUpdate({
  fetchLatest = fetchLatestWithFallback,
  acquireArtifact = acquireStableUpdateArtifact,
  ...options
} = {}) {
  const descriptor = validateUpdateDescriptor(await fetchLatest(options));
  const artifact = await acquireArtifact(descriptor, options);
  return { descriptor, artifact };
}

function createDefaultStateStore(platform, home) {
  if (platform === "win32") {
    const { createWindowsSecureStateStore } = require("./windows-platform.js");
    return createWindowsSecureStateStore({ home });
  }
  return createSecureStateStore({ platform, home });
}

function createAutoUpdateState({
  home = os.homedir(),
  platform = process.platform,
  stateStore = createDefaultStateStore(platform, home),
  now = () => new Date().toISOString(),
} = {}) {
  const directory = path.join(home, ".rainbond", "rainskills");
  const statePath = path.join(directory, "auto-update-v1.json");

  function emptyState() {
    return {
      schema: UPDATE_STATE_SCHEMA,
      version: UPDATE_STATE_VERSION,
      checked_at: null,
      latest_version: null,
      applied_version: null,
      last_error_at: null,
      destinations: [],
    };
  }

  function validate(state) {
    if (!state || typeof state !== "object" || Array.isArray(state)) {
      throw new Error("自动升级状态无效");
    }
    const allowed = new Set([
      "schema", "version", "checked_at", "latest_version", "applied_version",
      "last_error_at", "destinations",
    ]);
    for (const field of Object.keys(state)) {
      if (!allowed.has(field)) throw new Error("自动升级状态包含未知字段");
    }
    if (state.schema !== UPDATE_STATE_SCHEMA || state.version !== UPDATE_STATE_VERSION) {
      throw new Error("自动升级状态版本无效");
    }
    for (const field of ["checked_at", "last_error_at"]) {
      if (state[field] !== null && Number.isNaN(Date.parse(state[field]))) {
        throw new Error("自动升级时间状态无效");
      }
    }
    for (const field of ["latest_version", "applied_version"]) {
      if (state[field] !== null && !isStableVersion(state[field])) {
        throw new Error("自动升级版本状态无效");
      }
    }
    if (!Array.isArray(state.destinations) || state.destinations.some((item) => (
      typeof item !== "string" || !path.isAbsolute(item) || /[\u0000-\u001f\u007f-\u009f]/u.test(item)
    ))) {
      throw new Error("自动升级安装位置状态无效");
    }
    return {
      ...emptyState(),
      ...state,
      destinations: [...new Set(state.destinations.map((item) => path.resolve(item)))].sort(),
    };
  }

  function read() {
    if (!fs.existsSync(statePath)) return emptyState();
    return validate(stateStore.readProtectedJson(statePath));
  }

  function write(patch) {
    stateStore.ensurePrivateDirectory(directory);
    const next = validate({ ...read(), ...patch });
    stateStore.atomicWriteJson(statePath, next);
    return next;
  }

  return {
    path: statePath,
    acquireLease() {
      stateStore.ensurePrivateDirectory(directory);
      return stateStore.acquireOperationLock({ operationId: UPDATE_OPERATION_ID });
    },
    read,
    readInstallations() {
      return { destinations: read().destinations };
    },
    recordCheck(latestVersion) {
      return write({
        checked_at: now(),
        latest_version: isStableVersion(latestVersion) ? latestVersion : null,
        last_error_at: null,
      });
    },
    recordApplied(version) {
      if (!isStableVersion(version)) throw new Error("只能记录正式版升级");
      return write({
        checked_at: now(),
        latest_version: version,
        applied_version: version,
        last_error_at: null,
      });
    },
    recordFailure() {
      return write({ last_error_at: now() });
    },
    recordDestinations(destinations) {
      const combined = [...read().destinations, ...destinations.map((item) => path.resolve(item))];
      return write({ destinations: [...new Set(combined)].sort() });
    },
  };
}

function protectedJsonIfPresent(filePath, stateStore) {
  if (!fs.existsSync(filePath)) return null;
  return stateStore.readProtectedJson(filePath);
}

function hasActiveOperation({
  home = os.homedir(),
  platform = process.platform,
  stateStore = createDefaultStateStore(platform, home),
} = {}) {
  try {
    const runtime = protectedJsonIfPresent(
      path.join(home, ".rainbond", "rainskills", "runtime-connection-v1.json"),
      stateStore
    );
    if (runtime && runtime.state === "connecting") return true;
    const onboarding = protectedJsonIfPresent(
      path.join(home, ".rainbond", "rainskills-onboarding-v1.json"),
      stateStore
    );
    if (onboarding && onboarding.stage !== "configured") return true;
    return false;
  } catch {
    return true;
  }
}

async function checkForStableUpdate({
  args,
  currentVersion,
  env = process.env,
  home = os.homedir(),
  platform = process.platform,
  now = () => Date.now(),
  ttlMs = DEFAULT_CHECK_TTL_MS,
  fetchLatest = fetchLatestWithFallback,
  activeOperationDetector,
  updateState,
} = {}) {
  if (!isStableVersion(currentVersion)) {
    return { action: "continue", reason: "current-prerelease" };
  }
  if (!isSafeAutoUpdateEntry(args)) {
    return { action: "continue", reason: "unsafe-entry" };
  }
  if (env.RAINSKILLS_AUTO_UPDATE_HOP === "1") {
    return { action: "continue", reason: "delegated-hop" };
  }
  const detectActive = activeOperationDetector || (() => hasActiveOperation({ home, platform }));
  try {
    if (detectActive()) return { action: "continue", reason: "active-operation" };
  } catch {
    return { action: "continue", reason: "active-operation" };
  }
  let state = updateState;
  try {
    state ||= createAutoUpdateState({ home, platform });
    const prior = state.read();
    if (prior.checked_at && now() - Date.parse(prior.checked_at) < ttlMs) {
      return { action: "continue", reason: "fresh-check" };
    }
  } catch {
    return { action: "continue", reason: "state-unavailable" };
  }
  let latest;
  try {
    latest = await fetchLatest();
  } catch {
    try { state.recordFailure?.(); } catch { /* best-effort only */ }
    return { action: "continue", reason: "check-failed" };
  }
  try {
    latest = validateUpdateDescriptor(latest);
  } catch {
    try { state.recordCheck(null); } catch { /* best-effort only */ }
    return { action: "continue", reason: "invalid-latest" };
  }
  if (compareStableVersions(latest.version, currentVersion) <= 0) {
    try { state.recordCheck(latest.version); } catch { /* best-effort only */ }
    return { action: "continue", reason: "up-to-date" };
  }
  return { action: "delegate", ...latest };
}

function buildStableUpdateInvocation(descriptor, args, {
  platform = process.platform,
  artifactPath,
} = {}) {
  const validated = validateUpdateDescriptor(descriptor);
  if (!isSafeAutoUpdateEntry(args)) throw new Error("自动升级入口无效");
  const isAbsoluteArtifact = platform === "win32"
    ? path.win32.isAbsolute(artifactPath || "")
    : path.isAbsolute(artifactPath || "");
  if (typeof artifactPath !== "string" || !isAbsoluteArtifact) {
    throw new Error("自动升级本地制品路径无效");
  }
  return {
    executable: platform === "win32" ? "npm.cmd" : "npm",
    args: [
      "exec",
      "--yes",
      "--ignore-scripts",
      `--registry=${validated.registry}`,
      `--package=${artifactPath}`,
      "--",
      "rainskills",
      ...args,
    ],
  };
}

function sanitizeAutoUpdateEnvironment(source = process.env) {
  const environment = {};
  for (const key of AUTO_UPDATE_ENVIRONMENT_KEYS) {
    if (typeof source[key] === "string") environment[key] = source[key];
  }
  return environment;
}

function buildStableUpdateEnvironment(source, { fromVersion, targetVersion, registry }) {
  if (!isStableVersion(fromVersion) || !isStableVersion(targetVersion)) {
    throw new Error("自动升级环境只能绑定正式版");
  }
  if (!sourceForRegistry(registry)) throw new Error("自动升级 registry 无效");
  return {
    ...sanitizeAutoUpdateEnvironment(source),
    RAINSKILLS_AUTO_UPDATE_HOP: "1",
    RAINSKILLS_AUTO_UPDATE_FROM: fromVersion,
    RAINSKILLS_AUTO_UPDATE_TARGET: targetVersion,
    npm_config_registry: registry,
    npm_config_ignore_scripts: "true",
  };
}

function resolveInstallDestinations(args, home = os.homedir()) {
  if (
    !Array.isArray(args)
    || args.includes("--help")
    || args.includes("-h")
    || ["runtime", "platform", "resume", "intent", "refresh", "connect"].includes(args[0])
  ) return [];
  let target = "all";
  let customDestination = "";
  for (let index = 0; index < args.length; index += 1) {
    if (["codex", "claude", "pi", "all"].includes(args[index])) target = args[index];
    if (args[index] === "--dest" && typeof args[index + 1] === "string") {
      customDestination = path.resolve(args[index + 1]);
      index += 1;
    }
  }
  if (customDestination) return [customDestination];
  if (target === "codex") return [path.join(home, ".codex", "skills")];
  if (target === "claude") return [path.join(home, ".claude", "skills")];
  if (target === "pi") return [path.join(home, ".pi", "agent", "skills")];
  return [
    path.join(home, ".claude", "skills"),
    path.join(home, ".codex", "skills"),
    path.join(home, ".pi", "agent", "skills"),
  ];
}

function recordSkillInstallDestinations(args, {
  home = os.homedir(),
  platform = process.platform,
  updateState = createAutoUpdateState({ home, platform }),
} = {}) {
  const destinations = resolveInstallDestinations(args, home);
  if (destinations.length > 0) updateState.recordDestinations(destinations);
  return destinations;
}

function assertNoSymlinkPath(targetPath) {
  const resolved = path.resolve(targetPath);
  const parsed = path.parse(resolved);
  let current = parsed.root;
  for (const segment of resolved.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    if (!fs.existsSync(current)) continue;
    if (fs.lstatSync(current).isSymbolicLink()) {
      throw new Error("Skill 自动升级拒绝符号链接或 reparse point");
    }
  }
}

function assertSafeTree(directory) {
  const info = fs.lstatSync(directory);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error("Skill 自动升级目标必须是普通目录，不能是符号链接或 reparse point");
  }
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const child = path.join(directory, entry.name);
    const childInfo = fs.lstatSync(child);
    if (childInfo.isSymbolicLink()) throw new Error("Skill 自动升级拒绝符号链接或 reparse point");
    if (childInfo.isDirectory()) assertSafeTree(child);
    else if (!childInfo.isFile()) throw new Error("Skill 自动升级遇到不支持的文件类型");
  }
}

function discoverDestinationRoots({ home, sourceNames, updateState, destinations }) {
  const configured = destinations || [
    ...DEFAULT_AGENT_ROOTS.map((segments) => path.join(home, ...segments)),
    ...updateState.readInstallations().destinations,
  ];
  const unique = [...new Set(configured.map((item) => path.resolve(item)))];
  const selected = [];
  for (const root of unique) {
    assertNoSymlinkPath(root);
    if (!fs.existsSync(root)) continue;
    assertSafeTree(root);
    if (sourceNames.some((name) => fs.existsSync(path.join(root, name)))) selected.push(root);
  }
  return selected;
}

function synchronizeInstalledSkills({
  packageRoot,
  home = os.homedir(),
  platform = process.platform,
  updateState = createAutoUpdateState({ home, platform }),
  destinations,
} = {}) {
  const { discoverSkills } = require("./windows-onboarding.js");
  const sources = discoverSkills(packageRoot);
  const sourceNames = sources.map((source) => path.basename(source));
  const roots = discoverDestinationRoots({ home, sourceNames, updateState, destinations });
  if (roots.length === 0) throw new Error("没有可安全刷新的 Rainskills 安装位置");

  const transactions = [];
  const published = [];
  try {
    for (const root of roots) {
      const transactionRoot = path.join(
        root,
        `.rainskills-auto-update-${process.pid}-${crypto.randomBytes(6).toString("hex")}`
      );
      fs.mkdirSync(transactionRoot, { mode: 0o700 });
      const stagedRoot = path.join(transactionRoot, "staged");
      const backupRoot = path.join(transactionRoot, "backup");
      fs.mkdirSync(stagedRoot, { mode: 0o700 });
      fs.mkdirSync(backupRoot, { mode: 0o700 });
      for (const source of sources) {
        fs.cpSync(source, path.join(stagedRoot, path.basename(source)), {
          recursive: true,
          errorOnExist: true,
        });
      }
      assertSafeTree(stagedRoot);
      transactions.push({ root, transactionRoot, stagedRoot, backupRoot });
    }

    for (const transaction of transactions) {
      for (const name of sourceNames) {
        const destination = path.join(transaction.root, name);
        const staged = path.join(transaction.stagedRoot, name);
        const backup = path.join(transaction.backupRoot, name);
        const existed = fs.existsSync(destination);
        if (existed) fs.renameSync(destination, backup);
        try {
          fs.renameSync(staged, destination);
          published.push({ destination, backup, existed });
        } catch (error) {
          if (existed && !fs.existsSync(destination) && fs.existsSync(backup)) {
            fs.renameSync(backup, destination);
          }
          throw error;
        }
      }
    }
  } catch (error) {
    for (const item of published.reverse()) {
      if (fs.existsSync(item.destination)) fs.rmSync(item.destination, { recursive: true, force: true });
      if (item.existed && fs.existsSync(item.backup)) fs.renameSync(item.backup, item.destination);
    }
    throw error;
  } finally {
    for (const transaction of transactions) {
      if (fs.existsSync(transaction.transactionRoot)) {
        fs.rmSync(transaction.transactionRoot, { recursive: true, force: true });
      }
    }
  }
  return { destinations: roots.length, skills: sourceNames.length };
}

module.exports = {
  AUTO_UPDATE_ENVIRONMENT_KEYS,
  DEFAULT_CHECK_TTL_MS,
  INTERNAL_TIMEOUT_CODE,
  MAX_METADATA_BYTES,
  MAX_TARBALL_BYTES,
  METADATA_FALLBACK_ERROR_CODES,
  METADATA_TIMEOUT_MS,
  OFFICIAL_LATEST_URL,
  OFFICIAL_REGISTRY,
  REGISTRY_SOURCES,
  TARBALL_TIMEOUT_MS,
  acquireStableUpdateArtifact,
  buildStableUpdateEnvironment,
  buildStableUpdateInvocation,
  checkForStableUpdate,
  compareStableVersions,
  createAutoUpdateState,
  fetchLatestWithFallback,
  fetchOfficialLatest,
  fetchRegistryMetadata,
  hasActiveOperation,
  isSafeAutoUpdateEntry,
  isStableVersion,
  prepareStableUpdate,
  recordSkillInstallDestinations,
  resolveInstallDestinations,
  sanitizeAutoUpdateEnvironment,
  synchronizeInstalledSkills,
  validateRegistryLatestMetadata,
  validateUpdateDescriptor,
  validateOfficialLatestMetadata,
};
