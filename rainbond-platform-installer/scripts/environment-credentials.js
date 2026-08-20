"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { normalizeConsoleOrigin } = require("./console-origin.js");
const { createSecureStateStore } = require("./secure-state.js");
const { looksLikeJwt } = require("./windows-auth.js");

const CREDENTIAL_SCHEMA = "rainskills.environment-credential.v1";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CREDENTIAL_FIELDS = new Set([
  "schema", "version", "environment_id", "origin", "token",
]);
const MAX_CREDENTIAL_BYTES = 16384;

function assertEnvironmentId(environmentId) {
  if (!UUID_PATTERN.test(environmentId || "")) throw new Error("环境 ID 无效");
  return environmentId;
}

function validateCredential(input, expected = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("环境凭据无效");
  }
  for (const field of Object.keys(input)) {
    if (!CREDENTIAL_FIELDS.has(field)) throw new Error(`环境凭据包含未知字段：${field}`);
  }
  if (
    Object.keys(input).length !== CREDENTIAL_FIELDS.size
    || input.schema !== CREDENTIAL_SCHEMA
    || input.version !== 1
  ) {
    throw new Error("环境凭据 schema 无效");
  }
  const environmentId = assertEnvironmentId(input.environment_id);
  if (expected.environmentId && environmentId !== assertEnvironmentId(expected.environmentId)) {
    throw new Error("环境凭据 ID 不匹配");
  }
  if (!looksLikeJwt(input.token)) throw new Error("环境凭据格式无效");
  const origin = normalizeConsoleOrigin(input.origin);
  if (expected.expectedOrigin && origin !== normalizeConsoleOrigin(expected.expectedOrigin)) {
    throw new Error("环境凭据 origin 不匹配");
  }
  return {
    schema: CREDENTIAL_SCHEMA,
    version: 1,
    environment_id: environmentId,
    origin,
    token: input.token,
  };
}

function createEnvironmentCredentialStore({
  platform = process.platform,
  home = os.homedir(),
  stateStore = createSecureStateStore({ platform, home }),
} = {}) {
  const directory = path.join(home, ".rainbond", "rainskills", "credentials");

  function pathFor(environmentId) {
    return path.join(directory, `${assertEnvironmentId(environmentId)}.json`);
  }

  function write({ environmentId, origin, token } = {}) {
    const payload = validateCredential({
      schema: CREDENTIAL_SCHEMA,
      version: 1,
      environment_id: environmentId,
      origin,
      token,
    });
    const target = pathFor(environmentId);
    stateStore.ensurePrivateDirectory(directory);
    if (fs.existsSync(target)) stateStore.assertProtectedRegularFile(target);
    stateStore.atomicWriteJson(target, payload);
    return { environmentId: payload.environment_id, origin: payload.origin };
  }

  function read({ environmentId, expectedOrigin } = {}) {
    const target = pathFor(environmentId);
    stateStore.assertProtectedRegularFile(target);
    const info = fs.lstatSync(target);
    if (info.size > MAX_CREDENTIAL_BYTES) throw new Error("环境凭据文件过大");
    const credential = validateCredential(stateStore.readProtectedJson(target), {
      environmentId,
      expectedOrigin,
    });
    return { origin: credential.origin, token: credential.token };
  }

  function has(environmentId) {
    const target = pathFor(environmentId);
    if (!fs.existsSync(target)) return false;
    stateStore.assertProtectedRegularFile(target);
    return true;
  }

  function remove(environmentId) {
    const target = pathFor(environmentId);
    if (!fs.existsSync(target)) return false;
    stateStore.assertProtectedRegularFile(target);
    fs.unlinkSync(target);
    return true;
  }

  return { directory, has, pathFor, read, remove, write };
}

function readLegacyPosixCredential({ home, stateStore }) {
  const directory = path.join(home, ".rainbond");
  const credentialPath = path.join(directory, "mcp.env");
  if (!fs.existsSync(credentialPath)) return null;
  stateStore.assertProtectedRegularFile(credentialPath);
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
  const fd = fs.openSync(credentialPath, flags);
  let content;
  try {
    const info = fs.fstatSync(fd);
    if (!info.isFile() || info.size > MAX_CREDENTIAL_BYTES) {
      throw new Error("旧 Rainbond 凭据文件无效");
    }
    content = fs.readFileSync(fd, "utf8");
  } finally {
    fs.closeSync(fd);
  }
  const match = content.match(
    /^export RAINBOND_JWT='([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)'\nexport RAINBOND_URL='([^'\r\n]+)'\n?$/
  );
  if (!match) throw new Error("旧 Rainbond 凭据文件语法无效");
  return { token: match[1], origin: normalizeConsoleOrigin(match[2]) };
}

function defaultLegacyReader({ platform, home, stateStore }) {
  if (platform === "win32") {
    const origin = process.env.RAINBOND_URL;
    if (!origin) return null;
    return require("./runtime-credentials.js").readRuntimeCredential({
      platform,
      home,
      stateStore,
      expectedOrigin: origin,
    });
  }
  return readLegacyPosixCredential({ home, stateStore });
}

function migrateLegacyCredential({
  platform = process.platform,
  home = os.homedir(),
  stateStore = createSecureStateStore({ platform, home }),
  registry,
  credentialStore = createEnvironmentCredentialStore({ platform, home, stateStore }),
  readLegacy = defaultLegacyReader,
} = {}) {
  if (!registry || typeof registry.add !== "function" || typeof registry.findByOrigin !== "function") {
    throw new Error("旧凭据迁移缺少环境注册表");
  }
  const legacy = readLegacy({ platform, home, stateStore });
  if (!legacy) return { migrated: false, environment: null };
  const origin = normalizeConsoleOrigin(legacy.origin);
  let environment = registry.findByOrigin(origin);
  if (!environment) {
    environment = registry.add({
      kind: origin === "https://run.rainbond.com" ? "saas" : "private",
      consoleOrigin: origin,
      connectionState: "connected",
    }).environment;
  }
  if (credentialStore.has(environment.id)) {
    credentialStore.read({ environmentId: environment.id, expectedOrigin: origin });
    return { migrated: false, environment };
  }
  credentialStore.write({
    environmentId: environment.id,
    origin,
    token: legacy.token,
  });
  return { migrated: true, environment };
}

function registerConnectedEnvironment({
  registry,
  credentialStore,
  origin,
  token,
  kind,
  name,
} = {}) {
  if (!registry || typeof registry.add !== "function") {
    throw new Error("连接环境缺少环境注册表");
  }
  if (!credentialStore || typeof credentialStore.write !== "function") {
    throw new Error("连接环境缺少凭据存储");
  }
  const normalizedOrigin = normalizeConsoleOrigin(origin);
  const registration = registry.add({
    kind,
    consoleOrigin: normalizedOrigin,
    connectionState: "needs-reconnect",
    ...(name === undefined ? {} : { name }),
  });
  credentialStore.write({
    environmentId: registration.environment.id,
    origin: normalizedOrigin,
    token,
  });
  return {
    ...registration,
    environment: registry.updateConnection(
      registration.environment.id,
      "connected"
    ),
  };
}

module.exports = {
  CREDENTIAL_SCHEMA,
  createEnvironmentCredentialStore,
  migrateLegacyCredential,
  readLegacyPosixCredential,
  registerConnectedEnvironment,
  validateCredential,
};
