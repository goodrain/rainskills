"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { isDeepStrictEqual } = require("node:util");

const { createSecureStateStore } = require("./secure-state.js");
const { persistWindowsEnvironment, validateMcp } = require("./windows-client-config.js");
const { INTENT_DEFINITIONS, validateIntent } = require("./runtime-intents.js");

const RUNTIME_SCHEMA = "rainskills.runtime-connection.v1";
const STATUS_SCHEMA = "rainskills.runtime-status.v1";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STATES = new Set(["not_started", "connecting", "connected"]);
const TARGET_CLIENTS = new Set(["codex", "claude", "all"]);
const ENVIRONMENT_KINDS = new Set(["saas", "private"]);
const FAILURE_CATEGORIES = new Set(["credential-expired", "permission-denied"]);
const MAX_RETRY_COUNT = 1000;
const RUNTIME_STATE_LOCK_ID = "cf1c1a85-63e7-45f8-9dd5-20ea1d511c48";
const STATE_FIELDS = new Set([
  "schema", "version", "state", "target_client", "environment_kind", "console_origin",
  "validated_probe_at", "intent", "operation_id", "created_at", "updated_at", "failed_step",
  "retry_count", "retry_budget", "last_failure_category",
]);

function normalizeConsoleOrigin(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("console_origin 无效");
  }
  if (
    !["http:", "https:"].includes(parsed.protocol)
    || parsed.username
    || parsed.password
    || (parsed.pathname && parsed.pathname !== "/")
    || parsed.search
    || parsed.hash
  ) {
    throw new Error("console_origin 必须是规范的 HTTP/HTTPS origin");
  }
  return parsed.origin;
}

function createDefaultStore(platform, home) {
  if (platform === "win32") {
    const { createWindowsSecureStateStore } = require("./windows-platform.js");
    return createWindowsSecureStateStore({ home });
  }
  return createSecureStateStore({ platform, home });
}

function isIsoTimestamp(value) {
  return typeof value === "string"
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)
    && !Number.isNaN(Date.parse(value));
}

async function fetchPinnedMcpEndpoint(endpoint, fetchImpl, options) {
  const response = await fetchImpl(endpoint, { ...options, redirect: "manual" });
  const location = response?.headers?.get?.("location");
  const hasLocation = typeof response?.headers?.has === "function"
    ? response.headers.has("location")
    : location !== null && location !== undefined;
  if ((response.status >= 300 && response.status < 400) || hasLocation) {
    throw new Error("Rainbond MCP endpoint 不允许重定向");
  }
  if (response.url) {
    let observed;
    let expected;
    try {
      observed = new URL(response.url);
      expected = new URL(endpoint);
    } catch {
      throw new Error("Rainbond MCP endpoint 响应地址无效");
    }
    if (`${observed.origin}${observed.pathname}` !== `${expected.origin}${expected.pathname}`) {
      throw new Error("Rainbond MCP endpoint 响应地址不匹配");
    }
  }
  return response;
}

function shellSingleQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

function persistPosixCredential({ home, stateStore, token, baseUrl }) {
  const directory = stateStore.ensurePrivateDirectory(path.join(home, ".rainbond"));
  const target = stateStore.assertInsideHome(path.join(directory, "mcp.env"), "凭据文件");
  try {
    fs.lstatSync(target);
    stateStore.assertProtectedRegularFile(target);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const temporary = path.join(
    directory,
    `.mcp.env.${process.pid}.${crypto.randomBytes(8).toString("hex")}`
  );
  const content = [
    `export RAINBOND_JWT=${shellSingleQuote(token)}`,
    `export RAINBOND_URL=${shellSingleQuote(baseUrl)}`,
    "",
  ].join("\n");
  let fd;
  try {
    fd = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(fd, content, "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    stateStore.protectRegularFile(temporary);
    try {
      fs.lstatSync(target);
      stateStore.assertProtectedRegularFile(target);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    fs.renameSync(temporary, target);
    stateStore.protectRegularFile(target);
    const directoryFd = fs.openSync(directory, "r");
    try {
      fs.fsyncSync(directoryFd);
    } finally {
      fs.closeSync(directoryFd);
    }
  } catch (error) {
    if (fd !== undefined) fs.closeSync(fd);
    try {
      fs.unlinkSync(temporary);
    } catch (cleanupError) {
      if (cleanupError.code !== "ENOENT") throw cleanupError;
    }
    throw error;
  }
}

async function probeConfiguredMcp(state, { env, fetchImpl }) {
  const originalToken = env.RAINBOND_JWT;
  let token = originalToken;
  const clientPaths = state.target_client === "all"
    ? ["codex", "claude-code"]
    : [state.target_client === "claude" ? "claude-code" : "codex"];
  for (const client of clientPaths) {
    const preferredEndpoint = `${state.console_origin}/console/mcp/rainskills/${client}/query`;
    const genericEndpoint = `${state.console_origin}/console/mcp/query`;
    const validateEndpoint = (endpoint) => validateMcp({
      url: endpoint,
      token,
      fetchImpl: (url, options) => {
        if (url !== endpoint) throw new Error("Rainbond MCP endpoint 请求地址不匹配");
        return fetchPinnedMcpEndpoint(endpoint, fetchImpl, options);
      },
    });
    let validation;
    try {
      validation = await validateEndpoint(preferredEndpoint);
    } catch (error) {
      if (error.code !== "MCP_ENDPOINT_UNSUPPORTED") throw error;
      validation = await validateEndpoint(genericEndpoint);
    }
    token = validation.token;
  }
  return {
    usable: true,
    renewedCredential: token === originalToken
      ? null
      : { token, baseUrl: state.console_origin },
  };
}

function normalizeProbeResult(result, state) {
  if (result === true) return { usable: true, renewedCredential: null };
  if (!result || result.usable !== true) return { usable: false, renewedCredential: null };
  const credential = result.renewedCredential;
  if (credential === undefined || credential === null) {
    return { usable: true, renewedCredential: null };
  }
  if (
    !credential
    || typeof credential !== "object"
    || Array.isArray(credential)
    || Object.keys(credential).sort().join(",") !== "baseUrl,token"
    || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(String(credential.token || ""))
    || normalizeConsoleOrigin(credential.baseUrl) !== state.console_origin
  ) {
    throw new Error("live probe 返回的 renewed credential 无效");
  }
  return {
    usable: true,
    renewedCredential: { token: credential.token, baseUrl: state.console_origin },
  };
}

function createRuntimeStateManager({
  platform = process.platform,
  home = os.homedir(),
  stateStore = createDefaultStore(platform, home),
  liveProbe,
  fetchImpl = globalThis.fetch,
  env = process.env,
  credentialWriter,
  now = () => new Date().toISOString(),
} = {}) {
  const statePath = path.join(home, ".rainbond", "rainskills", "runtime-connection-v1.json");
  const writeCredential = credentialWriter || (platform === "win32"
    ? ({ token, baseUrl }) => persistWindowsEnvironment({ token, baseUrl })
    : ({ token, baseUrl }) => persistPosixCredential({ home, stateStore, token, baseUrl }));
  const probe = liveProbe || ((state) => probeConfiguredMcp(state, {
    env,
    fetchImpl,
  }));

  function validateStoredState(state) {
    if (!state || typeof state !== "object" || Array.isArray(state)) throw new Error("runtime state 必须是对象");
    for (const field of Object.keys(state)) {
      if (!STATE_FIELDS.has(field)) throw new Error(`runtime state 包含未知字段：${field}`);
    }
    if (state.schema !== RUNTIME_SCHEMA || state.version !== 1 || !STATES.has(state.state)) {
      throw new Error("不支持的 runtime connection state");
    }
    if (!TARGET_CLIENTS.has(state.target_client)) throw new Error("target_client 无效");
    if (!ENVIRONMENT_KINDS.has(state.environment_kind)) throw new Error("environment_kind 无效");
    const consoleOrigin = normalizeConsoleOrigin(state.console_origin);
    if (!UUID_PATTERN.test(state.operation_id || "")) throw new Error("operation_id 无效");
    const intent = state.intent === undefined || state.intent === null ? null : validateIntent(state.intent);
    if (!isIsoTimestamp(state.created_at) || !isIsoTimestamp(state.updated_at)) {
      throw new Error("runtime state timestamp 无效");
    }
    if (state.validated_probe_at !== null && !isIsoTimestamp(state.validated_probe_at)) {
      throw new Error("runtime state validated probe timestamp 无效");
    }
    const fixedSteps = intent ? INTENT_DEFINITIONS[intent.type].steps : [];
    if (state.failed_step !== null && !fixedSteps.includes(state.failed_step)) {
      throw new Error("runtime state failed step 不是 intent 的固定步骤");
    }
    if (!Number.isInteger(state.retry_count) || state.retry_count < 0 || state.retry_count > MAX_RETRY_COUNT) {
      throw new Error("runtime state retry count 无效");
    }
    if (!Number.isInteger(state.retry_budget) || state.retry_budget < 0 || state.retry_budget > 1) {
      throw new Error("runtime state retry budget 无效");
    }
    if (state.last_failure_category !== null && !FAILURE_CATEGORIES.has(state.last_failure_category)) {
      throw new Error("runtime state failure category 无效");
    }
    return {
      ...state,
      console_origin: consoleOrigin,
      intent,
    };
  }

  function read() {
    if (!fs.existsSync(statePath)) return { state: "not_started" };
    return validateStoredState(stateStore.readProtectedJson(statePath));
  }

  function connectionFields(input) {
    if (!input || typeof input !== "object") throw new Error("runtime connection input 无效");
    if (!TARGET_CLIENTS.has(input.target_client)) throw new Error("target_client 无效");
    if (!ENVIRONMENT_KINDS.has(input.environment_kind)) throw new Error("environment_kind 无效");
    if (!UUID_PATTERN.test(input.operation_id || "")) throw new Error("operation_id 无效");
    return {
      target_client: input.target_client,
      environment_kind: input.environment_kind,
      console_origin: normalizeConsoleOrigin(input.console_origin),
      intent: input.intent === undefined ? null : validateIntent(input.intent),
      operation_id: input.operation_id,
    };
  }

  function writeStateUnlocked(state) {
    const validated = validateStoredState({ ...state });
    stateStore.atomicWriteJson(statePath, validated);
    return validated;
  }

  function withRuntimeStateLock(action) {
    let lock;
    try {
      lock = stateStore.acquireOperationLock({ operationId: RUNTIME_STATE_LOCK_ID });
    } catch {
      throw new Error("runtime state 正在由另一个进程更新");
    }
    try {
      return action();
    } finally {
      lock.release();
    }
  }

  async function withRuntimeStateLockAsync(action) {
    let lock;
    try {
      lock = stateStore.acquireOperationLock({ operationId: RUNTIME_STATE_LOCK_ID });
    } catch {
      throw new Error("runtime state 正在由另一个进程更新");
    }
    try {
      return await action();
    } finally {
      lock.release();
    }
  }

  async function casWrite(expectedState, state, {
    renewedCredential = null,
    credentialFailureState,
  } = {}) {
    return withRuntimeStateLockAsync(async () => {
      const current = read();
      if (!isDeepStrictEqual(current, expectedState)) {
        return { written: false, current };
      }
      if (renewedCredential) {
        try {
          await writeCredential(renewedCredential);
        } catch {
          const failed = credentialFailureState
            ? writeStateUnlocked(credentialFailureState(current))
            : current;
          return { written: false, current: failed, credentialFailed: true };
        }
      }
      const written = writeStateUnlocked(state);
      return { written: true, current: written };
    });
  }

  function sameConnection(left, right) {
    return left.state === "connected"
      && right.state === "connected"
      && left.operation_id === right.operation_id
      && left.target_client === right.target_client
      && left.environment_kind === right.environment_kind
      && left.console_origin === right.console_origin
      && JSON.stringify(left.intent) === JSON.stringify(right.intent);
  }

  function startConnecting(input) {
    return withRuntimeStateLock(() => {
      const prior = read();
      const fields = connectionFields(input);
      if (prior.operation_id === fields.operation_id && prior.last_failure_category !== null) {
        if (prior.last_failure_category === "permission-denied") {
          throw new Error("permission denied 不允许重新授权");
        }
        throw new Error("凭据失效恢复必须使用受保护的 runtime reconnect 重试门禁");
      }
      if (prior.state === "connecting") {
        const identical = prior.operation_id === fields.operation_id
          && prior.target_client === fields.target_client
          && prior.environment_kind === fields.environment_kind
          && prior.console_origin === fields.console_origin
          && isDeepStrictEqual(prior.intent, fields.intent);
        if (identical) return prior;
        throw new Error("另一个 runtime connecting operation 正在进行中");
      }
      const timestamp = now();
      return writeStateUnlocked({
        schema: RUNTIME_SCHEMA,
        version: 1,
        state: "connecting",
        ...fields,
        validated_probe_at: null,
        created_at: prior.created_at || timestamp,
        updated_at: timestamp,
        failed_step: null,
        retry_count: 0,
        retry_budget: 0,
        last_failure_category: null,
      });
    });
  }

  function persistConnectingCredential({ operationId, token }) {
    if (!UUID_PATTERN.test(operationId || "")) throw new Error("operation_id 无效");
    if (typeof token !== "string" || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) {
      throw new Error("runtime credential 无效");
    }
    return withRuntimeStateLock(() => {
      const current = read();
      if (current.state !== "connecting" || current.operation_id !== operationId) {
        throw new Error("runtime credential 与 connecting operation 不匹配");
      }
      writeCredential({ token, baseUrl: current.console_origin });
      return { persisted: true };
    });
  }

  async function markConnected(input) {
    const prior = read();
    const fields = connectionFields(input);
    if (prior.state !== "connecting") {
      throw new Error("runtime 必须先进入 connecting 状态");
    }
    if (
      prior.operation_id !== fields.operation_id
      || prior.target_client !== fields.target_client
      || prior.environment_kind !== fields.environment_kind
      || prior.console_origin !== fields.console_origin
      || JSON.stringify(prior.intent) !== JSON.stringify(fields.intent)
    ) {
      throw new Error("connected 写入必须匹配当前 connecting operation");
    }
    let probeResult = { usable: false, renewedCredential: null };
    try {
      probeResult = normalizeProbeResult(
        await probe({ ...prior, ...fields, state: "connecting" }),
        { ...prior, ...fields, state: "connecting" }
      );
    } catch {
      probeResult = { usable: false, renewedCredential: null };
    }
    if (!probeResult.usable) throw new Error("只有 live probe 验证成功才能写入 connected");
    const timestamp = now();
    const result = await casWrite(prior, {
      schema: RUNTIME_SCHEMA,
      version: 1,
      state: "connected",
      ...fields,
      validated_probe_at: timestamp,
      created_at: prior.created_at || timestamp,
      updated_at: timestamp,
      failed_step: prior.failed_step || null,
      retry_count: prior.retry_count || 0,
      retry_budget: prior.retry_budget || 0,
      last_failure_category: prior.last_failure_category || null,
    }, {
      renewedCredential: probeResult.renewedCredential,
    });
    if (result.credentialFailed) throw new Error("live probe 凭据持久化失败");
    if (!result.written) throw new Error("runtime operation changed during live probe");
    return result.current;
  }

  async function status() {
    const current = read();
    if (current.state === "not_started") {
      return { schema: STATUS_SCHEMA, state: "not_started", usable: false };
    }
    if (current.state !== "connected") {
      return { schema: STATUS_SCHEMA, state: current.state, usable: false };
    }
    let probeResult = { usable: false, renewedCredential: null };
    try {
      probeResult = normalizeProbeResult(await probe(current), current);
    } catch {
      probeResult = { usable: false, renewedCredential: null };
    }
    if (!probeResult.usable) {
      const transition = await casWrite(current, {
        ...current,
        state: "connecting",
        validated_probe_at: null,
        updated_at: now(),
      });
      if (!transition.written) {
        return { schema: STATUS_SCHEMA, state: transition.current.state, usable: false };
      }
      return { schema: STATUS_SCHEMA, state: transition.current.state, usable: false };
    }
    const validatedProbeAt = now();
    const validation = await casWrite(current, {
      ...current,
      validated_probe_at: validatedProbeAt,
      updated_at: validatedProbeAt,
    }, {
      renewedCredential: probeResult.renewedCredential,
      credentialFailureState: (latest) => ({
        ...latest,
        state: "connecting",
        validated_probe_at: null,
        updated_at: now(),
      }),
    });
    if (validation.credentialFailed) {
      return { schema: STATUS_SCHEMA, state: validation.current.state, usable: false };
    }
    if (!validation.written) {
      if (sameConnection(current, validation.current)) {
        return {
          schema: STATUS_SCHEMA,
          state: "connected",
          usable: true,
          validated_probe_at: validation.current.validated_probe_at,
        };
      }
      return { schema: STATUS_SCHEMA, state: validation.current.state, usable: false };
    }
    return {
      schema: STATUS_SCHEMA,
      state: "connected",
      usable: true,
      validated_probe_at: validatedProbeAt,
    };
  }

  function assertMatchingOperation(current, operationId) {
    if (!UUID_PATTERN.test(operationId || "")) throw new Error("operation_id 无效");
    if (current.state === "not_started" || current.operation_id !== operationId) {
      throw new Error("runtime operation_id 与参数不匹配");
    }
    if (!current.intent) throw new Error("runtime state 缺少 validated intent");
  }

  function recordFailure({ operationId, step, reason } = {}) {
    if (!FAILURE_CATEGORIES.has(reason)) throw new Error("runtime failure reason 无效");
    return withRuntimeStateLock(() => {
      const current = read();
      assertMatchingOperation(current, operationId);
      const fixedSteps = INTENT_DEFINITIONS[current.intent.type].steps;
      if (!fixedSteps.includes(step)) throw new Error("runtime failure step 不是 intent 的固定步骤");

      if (
        reason === "credential-expired"
        && current.state === "connecting"
        && current.last_failure_category === reason
        && current.failed_step === step
        && current.retry_count === 0
        && current.retry_budget === 1
      ) {
        return current;
      }
      if (current.state !== "connected") {
        throw new Error("只有 connected runtime 才能记录业务操作失败");
      }

      const credentialExpired = reason === "credential-expired";
      const retryBudget = credentialExpired && current.retry_count === 0 ? 1 : 0;
      return writeStateUnlocked({
        ...current,
        state: credentialExpired ? "connecting" : "connected",
        validated_probe_at: credentialExpired ? null : current.validated_probe_at,
        failed_step: step,
        retry_budget: retryBudget,
        last_failure_category: reason,
        updated_at: now(),
      });
    });
  }

  function reconnectInput(operationId) {
    return withRuntimeStateLock(() => {
      const current = read();
      assertMatchingOperation(current, operationId);
      if (current.last_failure_category === "permission-denied") {
        throw new Error("permission denied 不允许重新授权或重试");
      }
      if (
        current.state !== "connecting"
        || current.last_failure_category !== "credential-expired"
        || current.retry_budget !== 1
        || current.retry_count !== 0
      ) {
        throw new Error("runtime credential retry budget 已用尽或尚未记录凭据失效");
      }
      return connectionFields(current);
    });
  }

  async function withReconnectLease(operationId, action) {
    if (!UUID_PATTERN.test(operationId || "")) throw new Error("operation_id 无效");
    if (typeof action !== "function") throw new Error("runtime reconnect action 无效");
    let lease;
    try {
      lease = stateStore.acquireOperationLock({ operationId });
    } catch {
      throw new Error("该 runtime reconnect 正在运行；请稍后重试");
    }
    try {
      const connection = reconnectInput(operationId);
      return await action(connection);
    } finally {
      lease.release();
    }
  }

  function assertContinuationEligible(operationId) {
    return withRuntimeStateLock(() => {
      const current = read();
      assertMatchingOperation(current, operationId);
      if (current.state !== "connected") throw new Error("runtime 尚未 connected，不能恢复 intent");
      if (current.last_failure_category === "permission-denied") {
        throw new Error("permission denied：当前操作没有权限，不能自动重试");
      }
      if (
        current.last_failure_category === "credential-expired"
        && (current.retry_budget !== 1 || current.retry_count !== 0)
      ) {
        throw new Error("runtime credential retry budget 已用尽");
      }
      return current;
    });
  }

  function prepareContinuation(operationId) {
    return withRuntimeStateLock(() => {
      const current = read();
      assertMatchingOperation(current, operationId);
      if (current.state !== "connected") throw new Error("runtime 尚未 connected，不能恢复 intent");
      if (current.last_failure_category === "permission-denied") {
        throw new Error("permission denied：当前操作没有权限，不能自动重试");
      }
      if (current.last_failure_category !== "credential-expired") return current;
      if (current.retry_budget !== 1 || current.retry_count !== 0) {
        throw new Error("runtime credential retry budget 已用尽");
      }
      return writeStateUnlocked({
        ...current,
        retry_count: current.retry_count + 1,
        retry_budget: 0,
        updated_at: now(),
      });
    });
  }

  return {
    markConnected,
    path: statePath,
    persistConnectingCredential,
    assertContinuationEligible,
    prepareContinuation,
    read,
    reconnectInput,
    recordFailure,
    startConnecting,
    status,
    withReconnectLease,
  };
}

module.exports = {
  FAILURE_CATEGORIES,
  MAX_RETRY_COUNT,
  RUNTIME_STATE_LOCK_ID,
  RUNTIME_SCHEMA,
  STATUS_SCHEMA,
  createRuntimeStateManager,
  isIsoTimestamp,
  normalizeConsoleOrigin,
  normalizeProbeResult,
  fetchPinnedMcpEndpoint,
  persistPosixCredential,
  probeConfiguredMcp,
};
