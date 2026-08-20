"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { normalizeConsoleOrigin } = require("./console-origin.js");
const { createSecureStateStore } = require("./secure-state.js");

const REGISTRY_SCHEMA = "rainskills.environments.v1";
const REGISTRY_LOCK_ID = "68e80ada-7946-44ca-b438-59eef580a238";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CONTROL_PATTERN = /[\u0000-\u001f\u007f-\u009f]/u;
const ENVIRONMENT_KINDS = new Set(["saas", "private"]);
const CONNECTION_STATES = new Set(["connected", "needs-reconnect", "unavailable"]);
const ROOT_FIELDS = new Set([
  "schema", "version", "default_environment_id", "environments",
]);
const ENVIRONMENT_FIELDS = new Set([
  "id", "name", "console_origin", "kind", "connection_state",
  "created_at", "updated_at", "last_verified_at",
]);
const MAX_ENVIRONMENTS = 128;
const MAX_NAME_LENGTH = 80;

function isIsoTimestamp(value) {
  return typeof value === "string"
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)
    && !Number.isNaN(Date.parse(value));
}

function normalizeEnvironmentName(value) {
  if (typeof value !== "string") throw new Error("环境名称无效");
  const normalized = value.normalize("NFKC").trim().replace(/\s+/gu, " ");
  if (!normalized || normalized.length > MAX_NAME_LENGTH || CONTROL_PATTERN.test(normalized)) {
    throw new Error(`环境名称必须是长度不超过 ${MAX_NAME_LENGTH} 的安全文本`);
  }
  return normalized;
}

function nameKey(value) {
  return normalizeEnvironmentName(value).toLocaleLowerCase("zh-CN");
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function createEnvironmentRegistry({
  platform = process.platform,
  home = os.homedir(),
  stateStore = createSecureStateStore({ platform, home }),
  randomUUID = crypto.randomUUID,
  now = () => new Date().toISOString(),
  activeOperationIds = () => [],
} = {}) {
  const registryPath = path.join(home, ".rainbond", "rainskills", "environments-v1.json");

  function emptyRegistry() {
    return {
      schema: REGISTRY_SCHEMA,
      version: 1,
      default_environment_id: null,
      environments: [],
    };
  }

  function validateEnvironment(input) {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new Error("环境记录无效");
    }
    for (const field of Object.keys(input)) {
      if (!ENVIRONMENT_FIELDS.has(field)) throw new Error(`环境记录包含未知字段：${field}`);
    }
    if (Object.keys(input).length !== ENVIRONMENT_FIELDS.size) {
      throw new Error("环境记录字段不完整");
    }
    if (!UUID_PATTERN.test(input.id || "")) throw new Error("环境 ID 无效");
    if (!ENVIRONMENT_KINDS.has(input.kind)) throw new Error("环境类型无效");
    if (!CONNECTION_STATES.has(input.connection_state)) throw new Error("环境连接状态无效");
    if (!isIsoTimestamp(input.created_at) || !isIsoTimestamp(input.updated_at)) {
      throw new Error("环境时间戳无效");
    }
    if (input.last_verified_at !== null && !isIsoTimestamp(input.last_verified_at)) {
      throw new Error("环境验证时间无效");
    }
    return {
      id: input.id,
      name: normalizeEnvironmentName(input.name),
      console_origin: normalizeConsoleOrigin(input.console_origin),
      kind: input.kind,
      connection_state: input.connection_state,
      created_at: input.created_at,
      updated_at: input.updated_at,
      last_verified_at: input.last_verified_at,
    };
  }

  function validateRegistry(input) {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new Error("环境注册表无效");
    }
    for (const field of Object.keys(input)) {
      if (!ROOT_FIELDS.has(field)) throw new Error(`环境注册表包含未知字段：${field}`);
    }
    if (
      Object.keys(input).length !== ROOT_FIELDS.size
      || input.schema !== REGISTRY_SCHEMA
      || input.version !== 1
      || !Array.isArray(input.environments)
      || input.environments.length > MAX_ENVIRONMENTS
    ) {
      throw new Error("环境注册表 schema 无效");
    }
    const environments = input.environments.map(validateEnvironment);
    const ids = new Set();
    const origins = new Set();
    const names = new Set();
    for (const environment of environments) {
      if (ids.has(environment.id)) throw new Error("环境注册表包含重复 ID");
      if (origins.has(environment.console_origin)) throw new Error("环境注册表包含重复 origin");
      const normalizedName = nameKey(environment.name);
      if (names.has(normalizedName)) throw new Error("环境注册表包含重复名称");
      ids.add(environment.id);
      origins.add(environment.console_origin);
      names.add(normalizedName);
    }
    if (
      input.default_environment_id !== null
      && (!UUID_PATTERN.test(input.default_environment_id) || !ids.has(input.default_environment_id))
    ) {
      throw new Error("默认环境 ID 无效");
    }
    if (environments.length > 0 && input.default_environment_id === null) {
      throw new Error("非空环境注册表必须指定默认环境");
    }
    return {
      schema: REGISTRY_SCHEMA,
      version: 1,
      default_environment_id: input.default_environment_id,
      environments,
    };
  }

  function read() {
    if (!fs.existsSync(registryPath)) return emptyRegistry();
    return clone(validateRegistry(stateStore.readProtectedJson(registryPath)));
  }

  function writeUnlocked(value) {
    const validated = validateRegistry(value);
    stateStore.atomicWriteJson(registryPath, validated);
    return clone(validated);
  }

  function withLock(action) {
    let lock;
    try {
      lock = stateStore.acquireOperationLock({ operationId: REGISTRY_LOCK_ID });
    } catch {
      throw new Error("环境注册表正在由另一个进程更新");
    }
    try {
      return action();
    } finally {
      lock.release();
    }
  }

  function nextAutomaticName(kind, origin, environments) {
    const hostname = new URL(origin).hostname.replace(/^\[|\]$/g, "");
    const base = kind === "saas" ? "Rainbond Cloud" : `私有环境-${hostname}`;
    const used = new Set(environments.map((entry) => nameKey(entry.name)));
    if (!used.has(nameKey(base))) return base;
    for (let suffix = 2; suffix <= MAX_ENVIRONMENTS + 1; suffix += 1) {
      const candidate = `${base}-${suffix}`;
      if (!used.has(nameKey(candidate))) return candidate;
    }
    throw new Error("无法生成不重复的环境名称");
  }

  function add({ kind, consoleOrigin, connectionState, name } = {}) {
    if (!ENVIRONMENT_KINDS.has(kind)) throw new Error("环境类型无效");
    if (!CONNECTION_STATES.has(connectionState)) throw new Error("环境连接状态无效");
    const origin = normalizeConsoleOrigin(consoleOrigin);
    return withLock(() => {
      const current = read();
      const existing = current.environments.find((entry) => entry.console_origin === origin);
      if (existing) {
        if (existing.kind !== kind) throw new Error("相同 Console origin 的环境类型不匹配");
        return { created: false, environment: clone(existing) };
      }
      if (current.environments.length >= MAX_ENVIRONMENTS) throw new Error("环境数量已达到上限");
      const environmentName = name === undefined
        ? nextAutomaticName(kind, origin, current.environments)
        : normalizeEnvironmentName(name);
      if (current.environments.some((entry) => nameKey(entry.name) === nameKey(environmentName))) {
        throw new Error("环境名称已存在");
      }
      const id = randomUUID();
      if (!UUID_PATTERN.test(id || "")) throw new Error("生成的环境 ID 无效");
      const timestamp = now();
      const environment = validateEnvironment({
        id,
        name: environmentName,
        console_origin: origin,
        kind,
        connection_state: connectionState,
        created_at: timestamp,
        updated_at: timestamp,
        last_verified_at: connectionState === "connected" ? timestamp : null,
      });
      const next = writeUnlocked({
        ...current,
        default_environment_id: current.default_environment_id || environment.id,
        environments: [...current.environments, environment],
      });
      return {
        created: true,
        environment: clone(next.environments.find((entry) => entry.id === environment.id)),
      };
    });
  }

  function rename(environmentId, name) {
    if (!UUID_PATTERN.test(environmentId || "")) throw new Error("环境 ID 无效");
    const normalized = normalizeEnvironmentName(name);
    return withLock(() => {
      const current = read();
      const existing = current.environments.find((entry) => entry.id === environmentId);
      if (!existing) throw new Error("环境不存在");
      if (current.environments.some(
        (entry) => entry.id !== environmentId && nameKey(entry.name) === nameKey(normalized)
      )) {
        throw new Error("环境名称已存在");
      }
      const timestamp = now();
      const next = writeUnlocked({
        ...current,
        environments: current.environments.map((entry) => entry.id === environmentId
          ? { ...entry, name: normalized, updated_at: timestamp }
          : entry),
      });
      return clone(next.environments.find((entry) => entry.id === environmentId));
    });
  }

  function setDefault(environmentId) {
    if (!UUID_PATTERN.test(environmentId || "")) throw new Error("环境 ID 无效");
    return withLock(() => {
      const current = read();
      if (!current.environments.some((entry) => entry.id === environmentId)) {
        throw new Error("环境不存在");
      }
      writeUnlocked({ ...current, default_environment_id: environmentId });
      return clone(current.environments.find((entry) => entry.id === environmentId));
    });
  }

  function remove(environmentId) {
    if (!UUID_PATTERN.test(environmentId || "")) throw new Error("环境 ID 无效");
    return withLock(() => {
      const current = read();
      const existing = current.environments.find((entry) => entry.id === environmentId);
      if (!existing) throw new Error("环境不存在");
      if (current.default_environment_id === environmentId) {
        throw new Error("删除默认环境前必须先指定新的默认环境");
      }
      const operations = activeOperationIds(environmentId);
      if (!Array.isArray(operations)) throw new Error("活动操作检查结果无效");
      if (operations.length > 0) throw new Error("该环境仍被活动操作使用，不能删除");
      writeUnlocked({
        ...current,
        environments: current.environments.filter((entry) => entry.id !== environmentId),
      });
      return clone(existing);
    });
  }

  function updateConnection(environmentId, connectionState) {
    if (!UUID_PATTERN.test(environmentId || "")) throw new Error("环境 ID 无效");
    if (!CONNECTION_STATES.has(connectionState)) throw new Error("环境连接状态无效");
    return withLock(() => {
      const current = read();
      const existing = current.environments.find((entry) => entry.id === environmentId);
      if (!existing) throw new Error("环境不存在");
      const timestamp = now();
      const next = writeUnlocked({
        ...current,
        environments: current.environments.map((entry) => entry.id === environmentId
          ? {
            ...entry,
            connection_state: connectionState,
            updated_at: timestamp,
            last_verified_at: connectionState === "connected"
              ? timestamp
              : entry.last_verified_at,
          }
          : entry),
      });
      return clone(next.environments.find((entry) => entry.id === environmentId));
    });
  }

  function list() {
    return read().environments;
  }

  function get(environmentId) {
    const environment = read().environments.find((entry) => entry.id === environmentId);
    return environment ? clone(environment) : null;
  }

  function findByName(name) {
    const key = nameKey(name);
    const environment = read().environments.find((entry) => nameKey(entry.name) === key);
    return environment ? clone(environment) : null;
  }

  function findByOrigin(origin) {
    const normalized = normalizeConsoleOrigin(origin);
    const environment = read().environments.find((entry) => entry.console_origin === normalized);
    return environment ? clone(environment) : null;
  }

  return {
    add,
    findByName,
    findByOrigin,
    get,
    list,
    path: registryPath,
    read,
    remove,
    rename,
    setDefault,
    updateConnection,
  };
}

module.exports = {
  CONNECTION_STATES,
  ENVIRONMENT_KINDS,
  REGISTRY_LOCK_ID,
  REGISTRY_SCHEMA,
  createEnvironmentRegistry,
  normalizeEnvironmentName,
};
