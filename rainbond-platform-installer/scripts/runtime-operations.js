"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { isDeepStrictEqual } = require("node:util");

const { createSecureStateStore } = require("./secure-state.js");
const { INTENT_DEFINITIONS, validateIntent } = require("./runtime-intents.js");

const OPERATION_SCHEMA = "rainskills.runtime-operation.v1";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CONTROL_PATTERN = /[\u0000-\u001f\u007f-\u009f]/u;
const STAGES = new Set(["awaiting-environment", "active", "interrupted", "completed"]);
const ACTIVE_STAGES = new Set(["awaiting-environment", "active", "interrupted"]);
const FAILURE_CATEGORIES = new Set(["credential-expired", "permission-denied"]);
const OPERATION_FIELDS = new Set([
  "schema", "version", "operation_id", "environment_id", "intent",
  "team_id", "app_id", "service_id", "stage", "failed_step",
  "retry_count", "retry_budget", "last_failure_category",
  "created_at", "updated_at",
]);

function isIsoTimestamp(value) {
  return typeof value === "string"
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)
    && !Number.isNaN(Date.parse(value));
}

function assertUuid(value, label) {
  if (!UUID_PATTERN.test(value || "")) throw new Error(`${label}无效`);
  return value;
}

function normalizeIdentifier(value, label) {
  if (value === null || value === undefined) return null;
  if (
    typeof value !== "string"
    || !value
    || value.length > 128
    || CONTROL_PATTERN.test(value)
  ) {
    throw new Error(`${label}无效`);
  }
  return value;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function createRuntimeOperationStore({
  platform = process.platform,
  home = os.homedir(),
  stateStore = createSecureStateStore({ platform, home }),
  registry,
  now = () => new Date().toISOString(),
} = {}) {
  if (!registry || typeof registry.read !== "function" || typeof registry.get !== "function") {
    throw new Error("runtime operation 缺少环境注册表");
  }
  const directory = path.join(home, ".rainbond", "rainskills", "operations");

  function pathFor(operationId) {
    return path.join(directory, `${assertUuid(operationId, "operation_id ")}.json`);
  }

  function validateStoredOperation(input) {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new Error("runtime operation 无效");
    }
    for (const field of Object.keys(input)) {
      if (!OPERATION_FIELDS.has(field)) throw new Error(`runtime operation 包含未知字段：${field}`);
    }
    if (
      Object.keys(input).length !== OPERATION_FIELDS.size
      || input.schema !== OPERATION_SCHEMA
      || input.version !== 1
      || !STAGES.has(input.stage)
    ) {
      throw new Error("runtime operation schema 无效");
    }
    const operationId = assertUuid(input.operation_id, "operation_id ");
    let environmentId = input.environment_id;
    if (input.stage === "awaiting-environment") {
      if (environmentId !== null) throw new Error("等待环境的操作不能提前绑定环境");
    } else {
      environmentId = assertUuid(environmentId, "environment_id ");
    }
    const intent = validateIntent(input.intent);
    const steps = INTENT_DEFINITIONS[intent.type].steps;
    if (input.failed_step !== null && !steps.includes(input.failed_step)) {
      throw new Error("runtime operation failed_step 无效");
    }
    if (!Number.isInteger(input.retry_count) || input.retry_count < 0) {
      throw new Error("runtime operation retry_count 无效");
    }
    if (![0, 1].includes(input.retry_budget)) throw new Error("runtime operation retry_budget 无效");
    if (input.last_failure_category !== null && !FAILURE_CATEGORIES.has(input.last_failure_category)) {
      throw new Error("runtime operation failure category 无效");
    }
    if (!isIsoTimestamp(input.created_at) || !isIsoTimestamp(input.updated_at)) {
      throw new Error("runtime operation timestamp 无效");
    }
    return {
      schema: OPERATION_SCHEMA,
      version: 1,
      operation_id: operationId,
      environment_id: environmentId,
      intent,
      team_id: normalizeIdentifier(input.team_id, "team_id"),
      app_id: normalizeIdentifier(input.app_id, "app_id"),
      service_id: normalizeIdentifier(input.service_id, "service_id"),
      stage: input.stage,
      failed_step: input.failed_step,
      retry_count: input.retry_count,
      retry_budget: input.retry_budget,
      last_failure_category: input.last_failure_category,
      created_at: input.created_at,
      updated_at: input.updated_at,
    };
  }

  function read(operationId) {
    const target = pathFor(operationId);
    if (!fs.existsSync(target)) return null;
    return clone(validateStoredOperation(stateStore.readProtectedJson(target)));
  }

  function writeUnlocked(operation) {
    const validated = validateStoredOperation(operation);
    stateStore.ensurePrivateDirectory(directory);
    stateStore.atomicWriteJson(pathFor(validated.operation_id), validated);
    return clone(validated);
  }

  function withLock(operationId, action) {
    let lock;
    try {
      lock = stateStore.acquireOperationLock({ operationId: assertUuid(operationId, "operation_id ") });
    } catch {
      throw new Error("runtime operation 正在由另一个进程更新");
    }
    try {
      return action();
    } finally {
      lock.release();
    }
  }

  function initialOperation({ operationId, environmentId, intent, stage }) {
    const timestamp = now();
    return {
      schema: OPERATION_SCHEMA,
      version: 1,
      operation_id: operationId,
      environment_id: environmentId,
      intent: validateIntent(intent),
      team_id: null,
      app_id: null,
      service_id: null,
      stage,
      failed_step: null,
      retry_count: 0,
      retry_budget: 0,
      last_failure_category: null,
      created_at: timestamp,
      updated_at: timestamp,
    };
  }

  function createPending({ operationId, intent } = {}) {
    return withLock(operationId, () => {
      const existing = read(operationId);
      const requested = initialOperation({
        operationId,
        environmentId: null,
        intent,
        stage: "awaiting-environment",
      });
      if (existing) {
        if (
          existing.stage === "awaiting-environment"
          && isDeepStrictEqual(existing.intent, requested.intent)
        ) return existing;
        throw new Error("operation_id 已用于其他任务");
      }
      return writeUnlocked(requested);
    });
  }

  function assertConnectedEnvironment(environmentId) {
    const environment = registry.get(assertUuid(environmentId, "environment_id "));
    if (!environment) throw new Error("运行环境不存在");
    if (environment.connection_state !== "connected") throw new Error("运行环境当前不可用");
    return environment;
  }

  function begin({ operationId, environmentId, intent } = {}) {
    const registryState = registry.read();
    const resolvedId = environmentId || registryState.default_environment_id;
    if (!resolvedId) throw new Error("目前还没有可用的应用运行环境");
    assertConnectedEnvironment(resolvedId);
    return withLock(operationId, () => {
      const existing = read(operationId);
      const requested = initialOperation({
        operationId,
        environmentId: resolvedId,
        intent,
        stage: "active",
      });
      if (existing) {
        if (
          existing.environment_id === resolvedId
          && isDeepStrictEqual(existing.intent, requested.intent)
        ) return existing;
        throw new Error("operation_id 已用于其他任务");
      }
      return writeUnlocked(requested);
    });
  }

  function bindEnvironment(operationId, environmentId) {
    assertConnectedEnvironment(environmentId);
    return withLock(operationId, () => {
      const current = read(operationId);
      if (!current) throw new Error("runtime operation 不存在");
      if (current.environment_id !== null) throw new Error("runtime operation 已经锁定运行环境");
      if (current.stage !== "awaiting-environment") throw new Error("runtime operation 当前不能绑定环境");
      return writeUnlocked({
        ...current,
        environment_id: environmentId,
        stage: "active",
        updated_at: now(),
      });
    });
  }

  function updateTargets(operationId, { teamId, appId, serviceId } = {}) {
    return withLock(operationId, () => {
      const current = read(operationId);
      if (!current || current.stage === "completed") throw new Error("runtime operation 不可更新");
      return writeUnlocked({
        ...current,
        team_id: teamId === undefined ? current.team_id : normalizeIdentifier(teamId, "team_id"),
        app_id: appId === undefined ? current.app_id : normalizeIdentifier(appId, "app_id"),
        service_id: serviceId === undefined ? current.service_id : normalizeIdentifier(serviceId, "service_id"),
        updated_at: now(),
      });
    });
  }

  function recordFailure(operationId, { step, reason } = {}) {
    if (!FAILURE_CATEGORIES.has(reason)) throw new Error("runtime failure reason 无效");
    return withLock(operationId, () => {
      const current = read(operationId);
      if (!current || current.stage === "completed") throw new Error("runtime operation 不可更新");
      if (!INTENT_DEFINITIONS[current.intent.type].steps.includes(step)) {
        throw new Error("runtime failure step 无效");
      }
      return writeUnlocked({
        ...current,
        failed_step: step,
        retry_budget: reason === "credential-expired" ? 1 : 0,
        last_failure_category: reason,
        updated_at: now(),
      });
    });
  }

  function consumeRetry(operationId) {
    return withLock(operationId, () => {
      const current = read(operationId);
      if (!current) throw new Error("runtime operation 不存在");
      if (current.last_failure_category === "permission-denied") {
        throw new Error("当前操作权限不足，不能自动重试");
      }
      if (current.last_failure_category !== "credential-expired" || current.retry_budget !== 1) {
        throw new Error("runtime credential retry budget 已用尽");
      }
      return writeUnlocked({
        ...current,
        retry_count: current.retry_count + 1,
        retry_budget: 0,
        updated_at: now(),
      });
    });
  }

  function complete(operationId) {
    return withLock(operationId, () => {
      const current = read(operationId);
      if (!current || current.environment_id === null) throw new Error("runtime operation 不能完成");
      return writeUnlocked({ ...current, stage: "completed", updated_at: now() });
    });
  }

  function list() {
    if (!fs.existsSync(directory)) return [];
    stateStore.ensurePrivateDirectory(directory);
    return fs.readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && UUID_PATTERN.test(entry.name.replace(/\.json$/, "")))
      .map((entry) => read(entry.name.replace(/\.json$/, "")))
      .sort((left, right) => left.created_at.localeCompare(right.created_at));
  }

  function activeOperationIds(environmentId) {
    assertUuid(environmentId, "environment_id ");
    return list()
      .filter((operation) => (
        operation.environment_id === environmentId && ACTIVE_STAGES.has(operation.stage)
      ))
      .map((operation) => operation.operation_id);
  }

  return {
    activeOperationIds,
    begin,
    bindEnvironment,
    complete,
    consumeRetry,
    createPending,
    directory,
    list,
    pathFor,
    read,
    recordFailure,
    updateTargets,
  };
}

function resolveTargetReference({
  registry,
  explicitEnvironmentName,
  explicitTeamName,
  bareTargetName,
  teamNames = [],
} = {}) {
  if (!registry || typeof registry.read !== "function") throw new Error("缺少环境注册表");
  const defaultEnvironmentId = registry.read().default_environment_id;
  if (explicitEnvironmentName !== undefined) {
    const environment = registry.findByName(explicitEnvironmentName);
    return environment
      ? { kind: "environment", environment_id: environment.id }
      : { kind: "unknown-environment", environment_name: explicitEnvironmentName };
  }
  if (explicitTeamName !== undefined) {
    if (!defaultEnvironmentId) return { kind: "missing-environment" };
    return {
      kind: "team",
      environment_id: defaultEnvironmentId,
      team_name: normalizeIdentifier(explicitTeamName, "team name"),
    };
  }
  if (bareTargetName !== undefined) {
    const environment = registry.findByName(bareTargetName);
    const team = teamNames.find((name) => String(name).normalize("NFKC") === String(bareTargetName).normalize("NFKC"));
    if (environment && team) {
      return {
        kind: "ambiguous",
        environment_id: environment.id,
        default_environment_id: defaultEnvironmentId,
        team_name: team,
      };
    }
    if (environment) return { kind: "environment", environment_id: environment.id };
    if (team && defaultEnvironmentId) {
      return { kind: "team", environment_id: defaultEnvironmentId, team_name: team };
    }
    return { kind: "unknown-target", target_name: bareTargetName };
  }
  return defaultEnvironmentId
    ? { kind: "environment", environment_id: defaultEnvironmentId }
    : { kind: "missing-environment" };
}

module.exports = {
  ACTIVE_STAGES,
  FAILURE_CATEGORIES,
  OPERATION_SCHEMA,
  createRuntimeOperationStore,
  resolveTargetReference,
};
