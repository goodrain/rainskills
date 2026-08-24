#!/usr/bin/env node

const path = require("node:path");
const crypto = require("node:crypto");
const os = require("node:os");
const { spawn } = require("node:child_process");
const { isDeepStrictEqual } = require("node:util");
const {
  detectControlEnvironment,
} = require("../rainbond-platform-installer/scripts/control-environment.js");
const {
  normalizeConsoleOrigin,
} = require("../rainbond-platform-installer/scripts/console-origin.js");
const {
  renderCatalogUserMessage,
} = require("../rainbond-platform-installer/scripts/user-message.js");

const AUTO_UPDATE_FALLBACK_EXIT_CODE = 75;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RUNTIME_CHILD_ENVIRONMENT_KEYS = Object.freeze([
  "HOME", "PATH", "SHELL", "TMPDIR", "TEMP", "TMP", "USER", "LOGNAME", "LANG", "LC_ALL",
  "TERM", "COLORTERM", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy",
  "SSL_CERT_FILE", "SSL_CERT_DIR", "CURL_CA_BUNDLE", "NODE_EXTRA_CA_CERTS",
  "RAINBOND_LOGIN_TIMEOUT", "RAINSKILLS_NO_BROWSER",
  "RAINSKILLS_INSTALL_ATTEMPT_ID", "RAINSKILLS_PACKAGE_VERSION",
  "RAINSKILLS_TELEMETRY_OPERATION_ID", "RAINSKILLS_TELEMETRY_INSTALLATION_ID",
  "RAINSKILLS_TELEMETRY_TARGET", "RAINSKILLS_TELEMETRY_CONTROL_MODE",
  "RAINSKILLS_TELEMETRY_CLIENT", "RAINSKILLS_TELEMETRY_DIR",
  "RAINSKILLS_INSTALL_REPORT_URL", "RAINSKILLS_LIFECYCLE_REPORT_URL",
]);

function runtimeChildEnvironment(source = process.env, extra = {}, expectedOrigin = "") {
  const environment = {};
  for (const key of RUNTIME_CHILD_ENVIRONMENT_KEYS) {
    if (typeof source[key] === "string") environment[key] = source[key];
  }
  for (const key of Object.keys(extra)) {
    if (!["RAINSKILLS_RUNTIME_CONNECT_COMPLETION", "RAINSKILLS_RUNTIME_OPERATION_ID", "RAINSKILLS_RUNTIME_STATE_SCOPE"].includes(key)) {
      throw new Error("runtime child environment 包含未知字段");
    }
    environment[key] = extra[key];
  }
  if (
    expectedOrigin
    && typeof source.RAINBOND_JWT === "string"
    && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(source.RAINBOND_JWT)
    && typeof source.RAINBOND_URL === "string"
  ) {
    try {
      if (normalizeConsoleOrigin(source.RAINBOND_URL) === normalizeConsoleOrigin(expectedOrigin)) {
        environment.RAINBOND_JWT = source.RAINBOND_JWT;
        environment.RAINBOND_URL = normalizeConsoleOrigin(expectedOrigin);
      }
    } catch {
      // An inherited credential is optional. Invalid or origin-drifted pairs are discarded.
    }
  }
  return environment;
}

function requireFixedValue(args, index, option) {
  const value = args[index + 1];
  if (typeof value !== "string" || !value || value.startsWith("--")) {
    throw new Error(`${option} 需要一个值`);
  }
  return value;
}

function parseRuntimeAssertConnectArgs(args) {
  if (
    args.length !== 10
    || args[0] !== "runtime"
    || args[1] !== "assert-connect"
    || args[2] !== "--onboarding-id"
    || args[4] !== "--target"
    || args[6] !== "--environment-kind"
    || args[8] !== "--console-origin"
  ) {
    throw new Error("runtime connect 内部门禁参数无效");
  }
  if (!UUID_PATTERN.test(args[3] || "")) throw new Error("runtime connect operation 无效");
  if (!["codex", "claude", "all"].includes(args[5])) throw new Error("runtime connect target 无效");
  if (!["saas", "private"].includes(args[7])) throw new Error("runtime connect environment kind 无效");
  return {
    operationId: args[3],
    targetClient: args[5],
    environmentKind: args[7],
    consoleOrigin: normalizeConsoleOrigin(args[9]),
  };
}

function assertConnectingState(current, expected) {
  if (
    !current
    || current.state !== "connecting"
    || current.operation_id !== expected.operationId
    || current.target_client !== expected.targetClient
    || current.environment_kind !== expected.environmentKind
    || current.console_origin !== expected.consoleOrigin
  ) {
    throw new Error("runtime connect 内部门禁与 protected connecting state 不匹配");
  }
}

function assertExactConnectedState(current, expected) {
  if (
    !current
    || current.state !== "connected"
    || current.operation_id !== expected.operation_id
    || current.target_client !== expected.target_client
    || current.environment_kind !== expected.environment_kind
    || current.console_origin !== expected.console_origin
    || !isDeepStrictEqual(current.intent, expected.intent)
  ) {
    throw new Error("runtime reconnect 完成状态与 protected connection 不匹配");
  }
}

function parseRuntimeConnectArgs(args) {
  if (args[0] !== "runtime" || args[1] !== "connect") {
    throw new Error("不是 runtime connect 命令");
  }
  const targetClient = args[2];
  if (!["codex", "claude", "all"].includes(targetClient)) {
    throw new Error("runtime connect 需要固定目标 codex、claude 或 all");
  }
  let environmentChoice = "";
  let rainbondUrl = "";
  let allowInsecureHttp = false;
  let onboardingId = "";
  let intentInput = "";
  let privateLocation = "";
  for (let index = 3; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--saas" || argument === "--install-private") {
      if (environmentChoice) throw new Error("runtime connect 的环境选择必须互斥");
      environmentChoice = argument === "--saas" ? "saas" : "install-private";
    } else if (argument === "--rainbond-url") {
      if (environmentChoice) throw new Error("runtime connect 的环境选择必须互斥");
      rainbondUrl = requireFixedValue(args, index, argument);
      environmentChoice = "private-existing";
      index += 1;
    } else if (argument === "--allow-insecure-http") {
      allowInsecureHttp = true;
    } else if (argument === "--location") {
      privateLocation = requireFixedValue(args, index, argument);
      if (!["local", "server"].includes(privateLocation)) {
        throw new Error("runtime connect 私有部署位置只支持 local 或 server");
      }
      index += 1;
    } else if (argument === "--onboarding-id") {
      onboardingId = requireFixedValue(args, index, argument);
      index += 1;
    } else if (argument === "--intent-json") {
      intentInput = requireFixedValue(args, index, argument);
      index += 1;
    } else {
      throw new Error("runtime connect 包含未知参数");
    }
  }
  if (!environmentChoice) throw new Error("runtime connect 必须选择一个应用运行环境");
  if (!intentInput || intentInput.length > 16384) throw new Error("runtime connect 需要受限的 intent JSON");
  let rawIntent;
  try {
    rawIntent = JSON.parse(intentInput);
  } catch {
    throw new Error("intent JSON 无效");
  }
  const { assertIntentCanInstallNewPlatform, validateIntent } = require(
    "../rainbond-platform-installer/scripts/runtime-intents.js"
  );
  const intent = environmentChoice === "install-private"
    ? assertIntentCanInstallNewPlatform(rawIntent)
    : validateIntent(rawIntent);
  if (onboardingId && !UUID_PATTERN.test(onboardingId)) throw new Error("onboarding id 无效");
  if (allowInsecureHttp && environmentChoice !== "private-existing") {
    throw new Error("--allow-insecure-http 只适用于明确的私有 Console 地址");
  }
  if (privateLocation && environmentChoice !== "install-private") {
    throw new Error("--location 只适用于 install-private 私有平台安装");
  }
  return {
    targetClient,
    environmentChoice,
    rainbondUrl,
    allowInsecureHttp,
    onboardingId,
    intent,
    ...(privateLocation ? { privateLocation } : {}),
  };
}

function runtimeConnectionInvocation(options, origin) {
  const installerPath = path.resolve(__dirname, "..", "install.sh");
  const args = [installerPath, "connect", options.targetClient];
  if (options.environmentChoice === "saas") args.push("--saas");
  else args.push("--self-hosted", "--rainbond-url", origin);
  if (options.allowInsecureHttp) args.push("--allow-insecure-http");
  return {
    executable: "bash",
    args,
  };
}

function runtimeConnectRetryAction(options, origin, operationId) {
  const argv = ["runtime", "connect", options.targetClient];
  if (options.environmentChoice === "saas") argv.push("--saas");
  else argv.push("--rainbond-url", origin);
  if (options.allowInsecureHttp) argv.push("--allow-insecure-http");
  argv.push("--onboarding-id", operationId, "--intent-json", JSON.stringify(options.intent));
  return {
    schema: "rainskills.next-action.v1",
    action: "retry-runtime-connect",
    onboarding_id: operationId,
    argv,
  };
}

function runtimeReconnectRetryAction(operationId) {
  return {
    schema: "rainskills.next-action.v1",
    action: "retry-runtime-reconnect",
    onboarding_id: operationId,
    argv: ["runtime", "reconnect", "--onboarding-id", operationId],
  };
}

function parseRuntimeFailureArgs(args) {
  if (
    args.length !== 8
    || args[0] !== "runtime"
    || args[1] !== "record-failure"
    || args[2] !== "--onboarding-id"
    || args[4] !== "--step"
    || args[6] !== "--reason"
  ) {
    throw new Error("runtime record-failure 参数无效");
  }
  if (!UUID_PATTERN.test(args[3] || "")) throw new Error("runtime failure onboarding operation 无效");
  if (!args[5] || args[5].startsWith("--")) throw new Error("runtime failure step 无效");
  if (!["credential-expired", "permission-denied"].includes(args[7])) {
    throw new Error("runtime failure reason 无效");
  }
  return { operationId: args[3], step: args[5], reason: args[7] };
}

function parseRuntimeReconnectArgs(args) {
  if (
    args.length !== 4
    || args[0] !== "runtime"
    || args[1] !== "reconnect"
    || args[2] !== "--onboarding-id"
    || !UUID_PATTERN.test(args[3] || "")
  ) {
    throw new Error("runtime reconnect 参数无效");
  }
  return { operationId: args[3] };
}

function createEnvironmentRuntimeServices() {
  const { createEnvironmentRegistry } = require(
    "../rainbond-platform-installer/scripts/environment-registry.js"
  );
  const { createRuntimeOperationStore } = require(
    "../rainbond-platform-installer/scripts/runtime-operations.js"
  );
  const { createEnvironmentCredentialStore } = require(
    "../rainbond-platform-installer/scripts/environment-credentials.js"
  );
  let operations;
  const registry = createEnvironmentRegistry({
    activeOperationIds: (environmentId) => operations?.activeOperationIds(environmentId) || [],
  });
  operations = createRuntimeOperationStore({ registry });
  return {
    environmentCredentialStore: createEnvironmentCredentialStore(),
    environmentRegistry: registry,
    operationStore: operations,
  };
}

function parseEnvironmentMutationArgs(args) {
  const action = args[1];
  if (!new Set(["rename", "set-default", "remove"]).has(action)) {
    throw new Error("environment action 无效");
  }
  if (args[2] !== "--environment-id" || !UUID_PATTERN.test(args[3] || "")) {
    throw new Error("环境 ID 无效");
  }
  if (action === "rename") {
    if (args.length !== 6 || args[4] !== "--name" || !args[5] || args[5].startsWith("--")) {
      throw new Error("environment rename 参数无效");
    }
    return { action, environmentId: args[3], name: args[5] };
  }
  if (args.length !== 4) throw new Error(`environment ${action} 参数无效`);
  return { action, environmentId: args[3] };
}

function parseOperationBeginArgs(args) {
  if (args[0] !== "operation" || args[1] !== "begin") {
    throw new Error("operation begin 参数无效");
  }
  let operationId = "";
  let environmentId = "";
  let intentInput = "";
  for (let index = 2; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--operation-id") {
      operationId = requireFixedValue(args, index, argument);
      index += 1;
    } else if (argument === "--environment-id") {
      environmentId = requireFixedValue(args, index, argument);
      index += 1;
    } else if (argument === "--intent-json") {
      intentInput = requireFixedValue(args, index, argument);
      index += 1;
    } else {
      throw new Error("operation begin 包含未知参数");
    }
  }
  if (!UUID_PATTERN.test(operationId)) throw new Error("operation ID 无效");
  if (environmentId && !UUID_PATTERN.test(environmentId)) throw new Error("环境 ID 无效");
  if (!intentInput || intentInput.length > 16384) throw new Error("operation begin 缺少 intent JSON");
  let intent;
  try {
    intent = JSON.parse(intentInput);
  } catch {
    throw new Error("operation begin intent JSON 无效");
  }
  return { operationId, environmentId: environmentId || undefined, intent };
}

function parseMcpServeArgs(args) {
  if (
    args.length !== 4
    || args[0] !== "mcp"
    || args[1] !== "serve"
    || args[2] !== "--client"
    || !["codex", "claude", "pi", "generic"].includes(args[3])
  ) {
    throw new Error("mcp serve 参数无效");
  }
  return { client: args[3] };
}

async function defaultMcpServerRunner({
  environmentRegistry,
  environmentCredentialStore,
  operationStore,
}) {
  const { createMcpRouter } = require(
    "../rainbond-platform-installer/scripts/mcp-router.js"
  );
  const { serveStdio } = require(
    "../rainbond-platform-installer/scripts/mcp-server.js"
  );
  return serveStdio({
    router: createMcpRouter({
      registry: environmentRegistry,
      credentialStore: environmentCredentialStore,
      operationStore,
    }),
  });
}

function runAttached(executable, args, { env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { env, stdio: "inherit" });
    child.once("error", () => reject(new Error("无法启动 RainSkills 运行环境连接器")));
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
}

async function defaultConnectionRunner(invocation, {
  completeWithCredential,
  control,
  options,
  origin,
  operationId,
}) {
  if (control.mode === "windows-native") {
    const { authorizeAndConfigure } = require(
      "../rainbond-platform-installer/scripts/windows-onboarding.js"
    );
    await authorizeAndConfigure({
      target: options.targetClient,
      baseUrl: origin,
      onConfiguredCredential: completeWithCredential,
    });
    return { code: 0, completesRuntimeState: true };
  }
  const childEnvironment = {
    RAINSKILLS_RUNTIME_CONNECT_COMPLETION: "1",
    RAINSKILLS_RUNTIME_OPERATION_ID: operationId,
  };
  if (options.intent?.type === "environment-add") {
    childEnvironment.RAINSKILLS_RUNTIME_STATE_SCOPE = "operation";
  }
  const result = await runAttached(invocation.executable, invocation.args, {
    env: runtimeChildEnvironment(process.env, childEnvironment, origin),
  });
  return { ...result, completesRuntimeState: true };
}

function defaultPrivateInstallerScheduler({ control, intent, operationId, target, privateLocation }) {
  const {
    createNextAction,
    createOnboardingCheckpoint,
  } = require("../rainbond-platform-installer/scripts/windows-onboarding.js");
  const packageVersion = require("../package.json").version;
  createOnboardingCheckpoint({
    home: os.homedir(),
    target,
    packageVersion,
    control,
    operationId,
    intent,
  });
  return createNextAction(operationId, privateLocation);
}

async function runBuiltin(args, {
  runtimeStateManager,
  environmentCredentialStore,
  environmentRegistry,
  operationStore,
  write = (value) => process.stdout.write(value),
  control = detectControlEnvironment(),
  originInspector,
  connectionRunner = defaultConnectionRunner,
  privateInstallerScheduler = defaultPrivateInstallerScheduler,
  credentialEnvironment = process.env,
  credentialPersister,
  connectedCredentialReader,
  mcpServerRunner = defaultMcpServerRunner,
} = {}) {
  let environmentServices;
  const getEnvironmentServices = () => {
    environmentServices ||= createEnvironmentRuntimeServices();
    return environmentServices;
  };
  const getEnvironmentRegistry = () => environmentRegistry
    || getEnvironmentServices().environmentRegistry;
  const getOperationStore = () => operationStore || getEnvironmentServices().operationStore;
  const getEnvironmentCredentialStore = () => environmentCredentialStore
    || getEnvironmentServices().environmentCredentialStore;
  const getRuntimeStateManager = (operationId, { scoped = false } = {}) => {
    if (runtimeStateManager) return runtimeStateManager;
    const operationScoped = scoped || (
      credentialEnvironment.RAINSKILLS_RUNTIME_STATE_SCOPE === "operation"
      && credentialEnvironment.RAINSKILLS_RUNTIME_OPERATION_ID === operationId
    );
    return require(
      "../rainbond-platform-installer/scripts/runtime-state.js"
    ).createRuntimeStateManager(operationScoped ? { operationId } : {});
  };

  if (args[0] === "mcp" && args[1] === "serve") {
    const { client } = parseMcpServeArgs(args);
    await mcpServerRunner({
      client,
      environmentRegistry: getEnvironmentRegistry(),
      environmentCredentialStore: getEnvironmentCredentialStore(),
      operationStore: getOperationStore(),
    });
    return true;
  }

  if (args[0] === "environment" && args[1] === "list") {
    if (args.length !== 3 || args[2] !== "--json") {
      throw new Error("environment list 只支持固定参数 --json");
    }
    const current = getEnvironmentRegistry().read();
    write(`${JSON.stringify({
      schema: "rainskills.environment-list.v1",
      default_environment_id: current.default_environment_id,
      environments: current.environments,
    })}\n`);
    return true;
  }
  if (args[0] === "environment" && ["rename", "set-default", "remove"].includes(args[1])) {
    const input = parseEnvironmentMutationArgs(args);
    const registry = getEnvironmentRegistry();
    let environment;
    let action;
    if (input.action === "rename") {
      environment = registry.rename(input.environmentId, input.name);
      action = "renamed";
    } else if (input.action === "set-default") {
      environment = registry.setDefault(input.environmentId);
      action = "default-changed";
    } else {
      environment = registry.remove(input.environmentId);
      getEnvironmentCredentialStore().remove(input.environmentId);
      action = "removed";
    }
    write(`${JSON.stringify({
      schema: "rainskills.environment-result.v1",
      action,
      environment,
    })}\n`);
    return true;
  }
  if (args[0] === "operation" && args[1] === "begin") {
    const input = parseOperationBeginArgs(args);
    const operation = getOperationStore().begin(input);
    write(`${JSON.stringify({
      schema: "rainskills.operation-begin-result.v1",
      operation_id: operation.operation_id,
      environment_id: operation.environment_id,
      intent: operation.intent,
      stage: operation.stage,
    })}\n`);
    return true;
  }
  if (args[0] === "operation" && args[1] === "complete") {
    if (
      args.length !== 4
      || args[2] !== "--operation-id"
      || !UUID_PATTERN.test(args[3] || "")
    ) {
      throw new Error("operation complete 参数无效");
    }
    const operation = getOperationStore().complete(args[3]);
    write(`${JSON.stringify({
      schema: "rainskills.operation-complete-result.v1",
      operation_id: operation.operation_id,
      environment_id: operation.environment_id,
      stage: operation.stage,
    })}\n`);
    return true;
  }
  if (args[0] === "runtime" && args[1] === "message") {
    if (args.length !== 4 || args[2] !== "--id") {
      throw new Error("runtime message 只支持固定参数 --id");
    }
    write(renderCatalogUserMessage(args[3], {
      controlPlatform: control.controlPlatform || control.hostPlatform,
    }));
    return true;
  }
  if (args[0] === "runtime" && args[1] === "status") {
    if (args.length !== 3 || args[2] !== "--json") {
      throw new Error("runtime status 只支持固定参数 --json");
    }
    const manager = runtimeStateManager || require(
      "../rainbond-platform-installer/scripts/runtime-state.js"
    ).createRuntimeStateManager();
    write(`${JSON.stringify(await manager.status())}\n`);
    return true;
  }
  if (args[0] === "runtime" && args[1] === "record-failure") {
    const failure = parseRuntimeFailureArgs(args);
    const manager = runtimeStateManager || require(
      "../rainbond-platform-installer/scripts/runtime-state.js"
    ).createRuntimeStateManager();
    const state = manager.recordFailure(failure);
    write(`${JSON.stringify({
      schema: "rainskills.runtime-failure-record.v1",
      onboarding_id: failure.operationId,
      failure_category: state.last_failure_category,
      retry_available: state.retry_budget === 1,
    })}\n`);
    return true;
  }
  if (args[0] === "runtime" && args[1] === "reconnect") {
    const { operationId } = parseRuntimeReconnectArgs(args);
    const multiEnvironmentEnabled = Boolean(
      environmentRegistry
      || operationStore
      || environmentCredentialStore
      || !runtimeStateManager
    );
    let reconnectedEnvironment = null;
    const manager = runtimeStateManager || require(
      "../rainbond-platform-installer/scripts/runtime-state.js"
    ).createRuntimeStateManager();
    const reconnectResult = await manager.withReconnectLease(operationId, async (connection) => {
      try {
        const inspect = originInspector || require(
          "../rainbond-platform-installer/scripts/console-origin.js"
        ).inspectConsoleOrigin;
        const inspection = await inspect(connection.console_origin);
        if (inspection.pendingRedirectOrigin || inspection.origin !== connection.console_origin) {
          throw new Error("protected Console origin 在重连检查中发生变化");
        }
        const options = {
          targetClient: connection.target_client,
          environmentChoice: connection.environment_kind === "saas" ? "saas" : "private-existing",
          rainbondUrl: connection.console_origin,
          allowInsecureHttp: connection.console_origin.startsWith("http://"),
          onboardingId: operationId,
          intent: connection.intent,
        };
        const invocation = runtimeConnectionInvocation(options, connection.console_origin);
        let completedWithCredential = false;
        const completeWithCredential = async (credential) => {
          const priorToken = process.env.RAINBOND_JWT;
          try {
            process.env.RAINBOND_JWT = credential;
            await manager.markConnected(connection);
            if (multiEnvironmentEnabled) {
              const protectedOperation = getOperationStore().read(operationId);
              if (!protectedOperation?.environment_id) {
                throw new Error("runtime reconnect 缺少已锁定的运行环境");
              }
              const registration = require(
                "../rainbond-platform-installer/scripts/environment-credentials.js"
              ).registerConnectedEnvironment({
                registry: getEnvironmentRegistry(),
                credentialStore: getEnvironmentCredentialStore(),
                origin: connection.console_origin,
                token: credential,
                kind: connection.environment_kind,
              });
              if (registration.environment.id !== protectedOperation.environment_id) {
                throw new Error("runtime reconnect 不能切换已锁定的运行环境");
              }
              reconnectedEnvironment = registration.environment;
            }
            completedWithCredential = true;
          } finally {
            if (priorToken === undefined) delete process.env.RAINBOND_JWT;
            else process.env.RAINBOND_JWT = priorToken;
          }
        };
        const result = await connectionRunner(invocation, {
          completeWithCredential,
          control,
          options,
          origin: connection.console_origin,
          operationId,
        });
        if (result.signal || result.code !== 0) {
          throw new Error("RainSkills 运行环境重新授权未完成");
        }
        if (result.completesRuntimeState) {
          assertExactConnectedState(manager.read(), connection);
        } else {
          if (completedWithCredential) throw new Error("运行环境重连器返回了矛盾状态");
          await manager.markConnected(connection);
          assertExactConnectedState(manager.read(), connection);
        }
        return {
          environmentKind: connection.environment_kind,
          consoleOrigin: connection.console_origin,
        };
      } catch {
        write(`${JSON.stringify(runtimeReconnectRetryAction(operationId))}\n`);
        throw new Error("RainSkills 运行环境重新授权失败");
      }
    });
    if (multiEnvironmentEnabled) {
      const operations = getOperationStore();
      const protectedOperation = operations.read(operationId);
      if (!protectedOperation || !protectedOperation.environment_id) {
        throw new Error("runtime reconnect 缺少已锁定的运行环境");
      }
      if (!reconnectedEnvironment) {
        if (connectedCredentialReader) {
          const credential = await connectedCredentialReader(reconnectResult.consoleOrigin);
          reconnectedEnvironment = require(
            "../rainbond-platform-installer/scripts/environment-credentials.js"
          ).registerConnectedEnvironment({
            registry: getEnvironmentRegistry(),
            credentialStore: getEnvironmentCredentialStore(),
            origin: reconnectResult.consoleOrigin,
            token: credential.token,
            kind: reconnectResult.environmentKind,
          }).environment;
        } else {
          const existing = getEnvironmentRegistry().findByOrigin(reconnectResult.consoleOrigin);
          if (!existing || !getEnvironmentCredentialStore().has(existing.id)) {
            throw new Error("runtime reconnect 未写入目标环境凭据");
          }
          getEnvironmentCredentialStore().read({
            environmentId: existing.id,
            expectedOrigin: reconnectResult.consoleOrigin,
          });
          reconnectedEnvironment = existing;
        }
      }
      if (reconnectedEnvironment.id !== protectedOperation.environment_id) {
        throw new Error("runtime reconnect 不能切换已锁定的运行环境");
      }
    }
    write(`${JSON.stringify({
      schema: "rainskills.runtime-reconnect-result.v1",
      state: "connected",
      onboarding_id: operationId,
      environment_kind: reconnectResult.environmentKind,
      ...(reconnectedEnvironment ? {
        environment_id: reconnectedEnvironment.id,
        environment_name: reconnectedEnvironment.name,
      } : {}),
    })}\n`);
    return true;
  }
  if (args[0] === "runtime" && args[1] === "assert-connect") {
    const expected = parseRuntimeAssertConnectArgs(args);
    const manager = getRuntimeStateManager(expected.operationId);
    assertConnectingState(manager.read(), expected);
    return true;
  }
  if (args[0] === "runtime" && args[1] === "persist-connect-credential") {
    if (
      args.length !== 4
      || args[2] !== "--onboarding-id"
      || !UUID_PATTERN.test(args[3] || "")
    ) {
      throw new Error("runtime connect credential writer 参数无效");
    }
    const manager = getRuntimeStateManager(args[3]);
    const current = manager.read();
    if (current.state !== "connecting" || current.operation_id !== args[3]) {
      throw new Error("runtime connect credential writer 与 connecting operation 不匹配");
    }
    const token = credentialEnvironment.RAINBOND_JWT;
    if (typeof token !== "string" || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) {
      throw new Error("runtime connect credential writer 缺少有效凭据");
    }
    if (credentialPersister) {
      await credentialPersister({ token, baseUrl: current.console_origin });
    } else if (
      environmentRegistry
      || operationStore
      || environmentCredentialStore
      || !runtimeStateManager
    ) {
      const registration = require(
        "../rainbond-platform-installer/scripts/environment-credentials.js"
      ).registerConnectedEnvironment({
        registry: getEnvironmentRegistry(),
        credentialStore: getEnvironmentCredentialStore(),
        origin: current.console_origin,
        token,
        kind: current.environment_kind,
      });
      const operations = getOperationStore();
      const operation = operations.read(args[3]);
      if (!operation) throw new Error("runtime connect operation 不存在");
      if (operation.environment_id === null) {
        operations.bindEnvironment(args[3], registration.environment.id);
      } else if (operation.environment_id !== registration.environment.id) {
        throw new Error("runtime connect 不能改变已锁定的运行环境");
      }
    } else {
      if (typeof manager.persistConnectingCredential !== "function") {
        throw new Error("runtime connect credential writer 不可用");
      }
      await manager.persistConnectingCredential({ operationId: args[3], token });
    }
    return true;
  }
  if (args[0] === "runtime" && args[1] === "connect") {
    const options = parseRuntimeConnectArgs(args);
    const operationId = options.onboardingId || crypto.randomUUID();
    const multiEnvironmentEnabled = Boolean(
      environmentRegistry
      || operationStore
      || environmentCredentialStore
      || !runtimeStateManager
    );
    let operations;
    if (multiEnvironmentEnabled) {
      operations = getOperationStore();
      const existingOperation = operations.read(operationId);
      if (!existingOperation) {
        operations.createPending({ operationId, intent: options.intent });
      } else if (
        existingOperation.stage !== "awaiting-environment"
        || !isDeepStrictEqual(existingOperation.intent, options.intent)
      ) {
        throw new Error("runtime connect operation 与受保护的原始 intent 不匹配");
      }
    }
    if (options.environmentChoice === "install-private") {
      const nextAction = privateInstallerScheduler({
        control,
        intent: options.intent,
        operationId,
        target: options.targetClient,
        privateLocation: options.privateLocation,
      });
      write(`${JSON.stringify(nextAction)}\n`);
      return true;
    }

    const inspect = originInspector || require(
      "../rainbond-platform-installer/scripts/console-origin.js"
    ).inspectConsoleOrigin;
    const requestedOrigin = options.environmentChoice === "saas"
      ? "https://run.rainbond.com"
      : options.rainbondUrl;
    const inspection = await inspect(requestedOrigin);
    if (inspection.pendingRedirectOrigin) {
      throw new Error(`Console 请求切换到新的 origin；请确认后改用：${inspection.pendingRedirectOrigin}`);
    }
    if (inspection.httpConfirmationRequired && !options.allowInsecureHttp) {
      throw new Error("明文 HTTP 需要单独显式确认；确认可信内网后使用 --allow-insecure-http");
    }
    const manager = getRuntimeStateManager(operationId, {
      scoped: options.intent.type === "environment-add",
    });
    const connection = {
      target_client: options.targetClient,
      environment_kind: options.environmentChoice === "saas" ? "saas" : "private",
      console_origin: inspection.origin,
      intent: options.intent,
      operation_id: operationId,
    };
    let registeredEnvironment = null;
    manager.startConnecting(connection);
    try {
      const invocation = runtimeConnectionInvocation(options, inspection.origin);
      let completedWithCredential = false;
      const completeWithCredential = async (credential) => {
        const priorToken = process.env.RAINBOND_JWT;
        try {
          process.env.RAINBOND_JWT = credential;
          await manager.markConnected(connection);
          if (multiEnvironmentEnabled) {
            registeredEnvironment = require(
              "../rainbond-platform-installer/scripts/environment-credentials.js"
            ).registerConnectedEnvironment({
              registry: getEnvironmentRegistry(),
              credentialStore: getEnvironmentCredentialStore(),
              origin: inspection.origin,
              token: credential,
              kind: connection.environment_kind,
            }).environment;
            const pending = operations.read(operationId);
            if (pending.environment_id === null) {
              operations.bindEnvironment(operationId, registeredEnvironment.id);
            } else if (pending.environment_id !== registeredEnvironment.id) {
              throw new Error("runtime connect 不能改变已锁定的运行环境");
            }
          }
          completedWithCredential = true;
        } finally {
          if (priorToken === undefined) delete process.env.RAINBOND_JWT;
          else process.env.RAINBOND_JWT = priorToken;
        }
      };
      const result = await connectionRunner(invocation, {
        completeWithCredential,
        control,
        options,
        origin: inspection.origin,
        operationId,
      });
      if (result.signal || result.code !== 0) {
        throw new Error("RainSkills 运行环境连接或授权未完成");
      }
      if (result.completesRuntimeState) {
        const state = manager.read();
        if (state.state !== "connected" || state.operation_id !== operationId) {
          throw new Error("运行环境连接器未完成 live probe");
        }
      } else {
        if (completedWithCredential) throw new Error("运行环境连接器返回了矛盾状态");
        await manager.markConnected(connection);
      }
    } catch (error) {
      write(`${JSON.stringify(runtimeConnectRetryAction(options, inspection.origin, operationId))}\n`);
      throw error;
    }
    if (multiEnvironmentEnabled) {
      if (!registeredEnvironment) {
        if (connectedCredentialReader) {
          const credential = await connectedCredentialReader(inspection.origin);
          if (!credential || credential.origin !== inspection.origin) {
            throw new Error("运行环境凭据与已验证 Console origin 不匹配");
          }
          registeredEnvironment = require(
            "../rainbond-platform-installer/scripts/environment-credentials.js"
          ).registerConnectedEnvironment({
            registry: getEnvironmentRegistry(),
            credentialStore: getEnvironmentCredentialStore(),
            origin: inspection.origin,
            token: credential.token,
            kind: connection.environment_kind,
          }).environment;
        } else {
          const existing = getEnvironmentRegistry().findByOrigin(inspection.origin);
          if (!existing || !getEnvironmentCredentialStore().has(existing.id)) {
            throw new Error("runtime connect 未写入目标环境凭据");
          }
          getEnvironmentCredentialStore().read({
            environmentId: existing.id,
            expectedOrigin: inspection.origin,
          });
          registeredEnvironment = existing;
        }
      }
      const protectedOperation = operations.read(operationId);
      if (protectedOperation.environment_id === null) {
        operations.bindEnvironment(operationId, registeredEnvironment.id);
      } else if (protectedOperation.environment_id !== registeredEnvironment.id) {
        throw new Error("runtime connect 不能改变已锁定的运行环境");
      }
    }
    const environmentSnapshot = registeredEnvironment && options.intent.type === "environment-add"
      ? getEnvironmentRegistry().read()
      : null;
    write(`${JSON.stringify({
      schema: "rainskills.runtime-connect-result.v1",
      state: "connected",
      onboarding_id: operationId,
      environment_kind: connection.environment_kind,
      ...(registeredEnvironment ? {
        environment_id: registeredEnvironment.id,
        environment_name: registeredEnvironment.name,
      } : {}),
      ...(environmentSnapshot ? {
        default_environment_id: environmentSnapshot.default_environment_id,
        environments: environmentSnapshot.environments,
        user_message: require(
          "../rainbond-platform-installer/scripts/user-message.js"
        ).renderEnvironmentConnectedList({
          environments: environmentSnapshot.environments,
          defaultEnvironmentId: environmentSnapshot.default_environment_id,
          addedEnvironmentId: registeredEnvironment.id,
        }),
      } : {}),
    })}\n`);
    return true;
  }
  if (args[0] === "runtime" && args[1] === "complete-connect") {
    if (args.length !== 4 || args[2] !== "--onboarding-id" || !UUID_PATTERN.test(args[3] || "")) {
      throw new Error("runtime complete-connect 参数无效");
    }
    const manager = getRuntimeStateManager(args[3]);
    const current = manager.read();
    if (current.state !== "connecting" || current.operation_id !== args[3]) {
      throw new Error("runtime connecting operation 不匹配");
    }
    await manager.markConnected({
      target_client: current.target_client,
      environment_kind: current.environment_kind,
      console_origin: current.console_origin,
      intent: current.intent,
      operation_id: current.operation_id,
    });
    return true;
  }
  if (args[0] === "intent" && args[1] === "resume") {
    if (args.length !== 4 || args[2] !== "--onboarding-id" || !args[3]) {
      throw new Error("intent resume 需要固定参数 --onboarding-id <uuid>");
    }
    const manager = runtimeStateManager || require(
      "../rainbond-platform-installer/scripts/runtime-state.js"
    ).createRuntimeStateManager();
    manager.assertContinuationEligible(args[3]);
    const status = await manager.status();
    if (status.state !== "connected" || status.usable !== true) {
      throw new Error("runtime 尚未 connected 且通过 live probe，不能恢复 intent");
    }
    const runtime = manager.prepareContinuation(args[3]);
    const { createIntentContinuation } = require(
      "../rainbond-platform-installer/scripts/runtime-intents.js"
    );
    write(`${JSON.stringify(createIntentContinuation(runtime.intent, runtime.failed_step || undefined))}\n`);
    return true;
  }
  return false;
}

function classifyNodeMajor(major) {
  if (major < 18) {
    return "unsupported";
  }
  if (major === 18 || major === 20) {
    return "eol";
  }
  return "supported";
}

function resolveInvocation(args, {
  control = detectControlEnvironment(),
  execPath = process.execPath,
} = {}) {
  const installerPath = path.resolve(__dirname, "..", "install.sh");
  const platformInstallerPath = path.resolve(
    __dirname,
    "..",
    "rainbond-platform-installer",
    "scripts",
    "platform-installer.js"
  );
  const windowsOnboardingPath = path.resolve(
    __dirname,
    "..",
    "rainbond-platform-installer",
    "scripts",
    "windows-onboarding.js"
  );

  if (args[0] === "tools") {
    return {
      executable: execPath,
      args: [path.resolve(__dirname, "rainskills-tools.js"), ...args.slice(1)],
    };
  }

  if (args[0] === "platform" && args[1] === "install") {
    return {
      executable: execPath,
      args: [platformInstallerPath, "install", ...args.slice(2)],
    };
  }
  if (args[0] === "ssh" && ["prepare", "prepare-cluster"].includes(args[1])) {
    return {
      executable: execPath,
      args: [
        path.resolve(__dirname, "..", "rainbond-platform-installer", "scripts", "ssh-key-setup.js"),
        args[1],
        ...args.slice(2),
      ],
    };
  }
  if (args[0] === "resume") {
    return {
      executable: execPath,
      args: [platformInstallerPath, "resume", ...args.slice(1)],
    };
  }
  if (control.mode === "windows-native") {
    return {
      executable: execPath,
      args: [windowsOnboardingPath, ...args],
    };
  }
  return {
    executable: "bash",
    args: [installerPath, ...args],
  };
}

async function runAutoUpdatePhase(args, {
  currentVersion = require("../package.json").version,
  env = process.env,
  home = os.homedir(),
  platform = process.platform,
  packageRoot = path.resolve(__dirname, ".."),
  checkForUpdate,
  acquireArtifact,
  synchronizeSkills,
  updateState,
  delegate,
  activeOperationDetector,
} = {}) {
  const autoUpdate = require(
    "../rainbond-platform-installer/scripts/auto-update.js"
  );
  let state = updateState;
  const getState = () => {
    state ||= autoUpdate.createAutoUpdateState({ home, platform });
    return state;
  };
  if (env.RAINSKILLS_AUTO_UPDATE_HOP === "1") {
    try {
      if (
        env.RAINSKILLS_AUTO_UPDATE_TARGET !== currentVersion
        || !autoUpdate.isStableVersion(env.RAINSKILLS_AUTO_UPDATE_FROM)
        || !autoUpdate.isStableVersion(currentVersion)
      ) {
        throw new Error("自动升级委托版本不匹配");
      }
      const detectActive = activeOperationDetector
        || (() => autoUpdate.hasActiveOperation({ home, platform }));
      if (detectActive()) {
        throw new Error("存在正在执行的 Rainskills 操作");
      }
      (synchronizeSkills || autoUpdate.synchronizeInstalledSkills)({
        packageRoot,
        home,
        platform,
        updateState: getState(),
      });
      getState().recordApplied(currentVersion);
      return { handled: false, reason: "delegated-sync-complete" };
    } catch {
      try { getState().recordFailure(); } catch { /* the old version remains authoritative */ }
      return { handled: true, code: AUTO_UPDATE_FALLBACK_EXIT_CODE, signal: null };
    }
  }
  let lease = null;
  let artifact = null;
  try {
    if (autoUpdate.isStableVersion(currentVersion) && autoUpdate.isSafeAutoUpdateEntry(args)) {
      lease = getState().acquireLease?.() || null;
    }
  } catch {
    return { handled: false, reason: "update-busy" };
  }
  try {
    const decision = await (checkForUpdate || autoUpdate.checkForStableUpdate)({
      args,
      currentVersion,
      env,
      home,
      platform,
      ...(activeOperationDetector ? { activeOperationDetector } : {}),
      ...(state ? { updateState: state } : {}),
    });
    if (decision.action !== "delegate") {
      return { handled: false, reason: decision.reason };
    }
    artifact = await (acquireArtifact || autoUpdate.acquireStableUpdateArtifact)(decision, {
      home,
      platform,
    });
    const detectActive = activeOperationDetector
      || (() => autoUpdate.hasActiveOperation({ home, platform }));
    if (detectActive()) return { handled: false, reason: "active-operation" };
    const invocation = autoUpdate.buildStableUpdateInvocation(decision, args, {
      platform,
      artifactPath: artifact.path,
    });
    const environment = autoUpdate.buildStableUpdateEnvironment(env, {
      fromVersion: currentVersion,
      targetVersion: decision.version,
      registry: decision.registry,
    });
    let result;
    try {
      result = await (delegate || ((nextInvocation, nextEnvironment) => runAttached(
        nextInvocation.executable,
        nextInvocation.args,
        { env: nextEnvironment }
      )))(invocation, environment);
    } catch {
      try { getState().recordFailure(); } catch { /* best effort only */ }
      return { handled: false, reason: "delegated-update-failed" };
    }
    if (result.code === AUTO_UPDATE_FALLBACK_EXIT_CODE && !result.signal) {
      try { getState().recordFailure(); } catch { /* best effort only */ }
      return { handled: false, reason: "delegated-update-failed" };
    }
    return {
      handled: true,
      code: result.code === null ? 1 : result.code,
      signal: result.signal || null,
    };
  } finally {
    try { artifact?.cleanup(); } catch { /* protected cleanup is best effort */ }
    lease?.release();
  }
}

async function run() {
  const major = Number.parseInt(process.versions.node.split(".", 1)[0], 10);
  const support = classifyNodeMajor(major);

  if (support === "unsupported") {
    console.error(
      `错误：RainSkills 的 npx 安装方式需要 Node.js 18 或更高版本，当前为 ${process.version}。`
    );
    console.error(
      "请升级到 Node.js 22/24，或改用：bash <(curl -fsSL https://get.rainbond.com/rainskills/install.sh)"
    );
    process.exitCode = 1;
    return;
  }

  if (support === "eol") {
    console.error(
      `警告：当前 ${process.version} 已结束维护；本次仍会继续，建议升级到 Node.js 22 或 24。`
    );
  }

  const args = process.argv.slice(2);
  const autoUpdateResult = await runAutoUpdatePhase(args);
  if (autoUpdateResult.handled) {
    if (autoUpdateResult.signal) {
      process.kill(process.pid, autoUpdateResult.signal);
      return;
    }
    process.exitCode = autoUpdateResult.code;
    return;
  }
  if (await runBuiltin(args)) return;
  const invocation = resolveInvocation(args);
  const child = spawn(invocation.executable, invocation.args, {
    env: process.env,
    stdio: "inherit",
  });
  let spawnFailed = false;

  const forwardSigint = () => child.kill("SIGINT");
  const forwardSigterm = () => child.kill("SIGTERM");
  process.on("SIGINT", forwardSigint);
  process.on("SIGTERM", forwardSigterm);

  child.on("error", (error) => {
    spawnFailed = true;
    console.error(`错误：无法启动 RainSkills 安装器：${error.message}`);
    process.exitCode = 1;
  });

  child.on("close", (code, signal) => {
    process.removeListener("SIGINT", forwardSigint);
    process.removeListener("SIGTERM", forwardSigterm);

    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    if (!spawnFailed && code === 0) {
      try {
        require("../rainbond-platform-installer/scripts/auto-update.js")
          .recordSkillInstallDestinations(args);
      } catch {
        // Skill installation already succeeded. Canonical roots remain discoverable on the next run.
      }
    }
    process.exitCode = spawnFailed ? 1 : code === null ? 1 : code;
  });
}

module.exports = {
  AUTO_UPDATE_FALLBACK_EXIT_CODE,
  classifyNodeMajor,
  parseRuntimeFailureArgs,
  parseRuntimeReconnectArgs,
  parseRuntimeConnectArgs,
  resolveInvocation,
  runAutoUpdatePhase,
  runBuiltin,
  runtimeChildEnvironment,
  runtimeConnectRetryAction,
  runtimeConnectionInvocation,
  runtimeReconnectRetryAction,
};

if (require.main === module) {
  run().catch((error) => {
    console.error(`错误：${error.message}`);
    process.exitCode = 1;
  });
}
