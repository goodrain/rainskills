#!/usr/bin/env node

const path = require("node:path");
const crypto = require("node:crypto");
const os = require("node:os");
const { spawn } = require("node:child_process");
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
  "DISPLAY", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS",
  "WSL_INTEROP", "WSL_DISTRO_NAME",
  "SSH_CONNECTION", "SSH_CLIENT", "SSH_TTY", "container",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy",
  "SSL_CERT_FILE", "SSL_CERT_DIR", "CURL_CA_BUNDLE", "NODE_EXTRA_CA_CERTS",
  "RAINBOND_LOGIN_TIMEOUT", "RAINSKILLS_NO_BROWSER",
  "RAINSKILLS_INSTALL_ATTEMPT_ID", "RAINSKILLS_PACKAGE_VERSION",
  "RAINSKILLS_TELEMETRY_OPERATION_ID", "RAINSKILLS_TELEMETRY_INSTALLATION_ID",
  "RAINSKILLS_TELEMETRY_TARGET", "RAINSKILLS_TELEMETRY_CONTROL_MODE",
  "RAINSKILLS_TELEMETRY_CLIENT", "RAINSKILLS_TELEMETRY_DIR",
  "RAINSKILLS_INSTALL_REPORT_URL", "RAINSKILLS_LIFECYCLE_REPORT_URL",
]);

function runtimeChildEnvironment(source = process.env, extra = {}) {
  const environment = {};
  for (const key of RUNTIME_CHILD_ENVIRONMENT_KEYS) {
    if (typeof source[key] === "string") environment[key] = source[key];
  }
  for (const key of Object.keys(extra)) {
    if (!["RAINSKILLS_RUNTIME_CONNECT_COMPLETION", "RAINSKILLS_RUNTIME_OPERATION_ID"].includes(key)) {
      throw new Error("runtime child environment 包含未知字段");
    }
    environment[key] = extra[key];
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
  if (!["codex", "claude", "pi", "all"].includes(args[5])) throw new Error("runtime connect target 无效");
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

function parseRuntimeConnectArgs(args) {
  if (args[0] !== "runtime" || args[1] !== "connect") {
    throw new Error("不是 runtime connect 命令");
  }
  const targetClient = args[2];
  if (!["codex", "claude", "pi", "all"].includes(targetClient)) {
    throw new Error("runtime connect 需要固定目标 codex、claude、pi 或 all");
  }
  let environmentChoice = "";
  let rainbondUrl = "";
  let allowInsecureHttp = false;
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
    } else if (["--intent-json", "--onboarding-id"].includes(argument)) {
      throw new Error(`runtime connect 不再支持 ${argument}`);
    } else {
      throw new Error("runtime connect 包含未知参数");
    }
  }
  if (!environmentChoice) throw new Error("runtime connect 必须选择一个应用运行环境");
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
    privateLocation: privateLocation || undefined,
  };
}

function runtimeConnectionInvocation(options, origin) {
  const installerPath = path.resolve(__dirname, "..", "install.sh");
  const args = [installerPath, "connect", options.targetClient];
  if (options.environmentChoice === "saas") args.push("--saas");
  else args.push("--self-hosted", "--rainbond-url", origin);
  if (options.allowInsecureHttp) args.push("--allow-insecure-http");
  args.push("--no-cached-token");
  return {
    executable: "bash",
    args,
  };
}

function runtimeConnectRetryAction(options, origin) {
  const argv = ["runtime", "connect", options.targetClient];
  if (options.environmentChoice === "saas") argv.push("--saas");
  else argv.push("--rainbond-url", origin);
  if (options.allowInsecureHttp) argv.push("--allow-insecure-http");
  return {
    schema: "rainskills.next-action.v1",
    action: "retry-runtime-connect",
    argv,
  };
}

function runAttached(executable, args, {
  env = process.env,
  signalSource = process,
  spawnImpl = spawn,
} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(executable, args, { env, stdio: "inherit" });
    const forwardSigint = () => child.kill("SIGINT");
    const forwardSigterm = () => child.kill("SIGTERM");
    const removeSignalListeners = () => {
      signalSource.removeListener("SIGINT", forwardSigint);
      signalSource.removeListener("SIGTERM", forwardSigterm);
    };
    signalSource.on("SIGINT", forwardSigint);
    signalSource.on("SIGTERM", forwardSigterm);
    child.once("error", () => {
      removeSignalListeners();
      reject(new Error("无法启动 RainSkills 运行环境连接器"));
    });
    child.once("close", (code, signal) => {
      removeSignalListeners();
      resolve({ code, signal });
    });
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
  const result = await runAttached(invocation.executable, invocation.args, {
    env: runtimeChildEnvironment(process.env, childEnvironment, origin),
  });
  return { ...result, completesRuntimeState: true };
}

function defaultPrivateInstallerScheduler({ control, operationId, target, privateLocation }) {
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
  });
  return createNextAction(operationId, privateLocation);
}

async function runBuiltin(args, {
  runtimeStateManager,
  singleRuntimeStore,
  write = (value) => process.stdout.write(value),
  control = detectControlEnvironment(),
  originInspector,
  connectionRunner = defaultConnectionRunner,
  privateInstallerScheduler = defaultPrivateInstallerScheduler,
  credentialEnvironment = process.env,
  credentialPersister,
  connectedCredentialReader,
} = {}) {
  const getSingleRuntimeStore = () => singleRuntimeStore || require(
    "../rainbond-platform-installer/scripts/single-runtime.js"
  ).createSingleRuntimeStore();
  const getRuntimeStateManager = () => {
    if (runtimeStateManager) return runtimeStateManager;
    return require(
      "../rainbond-platform-installer/scripts/runtime-state.js"
    ).createRuntimeStateManager();
  };

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
    if (runtimeStateManager) {
      write(`${JSON.stringify(await runtimeStateManager.status())}\n`);
      return true;
    }
    const runtime = getSingleRuntimeStore().read();
    if (!runtime) {
      write(`${JSON.stringify({
        schema: "rainskills.runtime-status.v1",
        state: "not_started",
        usable: false,
      })}\n`);
      return true;
    }
    try {
      const validation = await require(
        "../rainbond-platform-installer/scripts/windows-client-config.js"
      ).validateMcp({
        url: `${runtime.console_origin}/console/mcp/rainskills/api/query`,
        token: runtime.token,
      });
      if (validation.token !== runtime.token) {
        getSingleRuntimeStore().write({
          consoleOrigin: runtime.console_origin,
          kind: runtime.kind,
          token: validation.token,
          allowInsecureHttp: runtime.allow_insecure_http,
        });
      }
      write(`${JSON.stringify({
        schema: "rainskills.runtime-status.v1",
        state: "connected",
        usable: true,
        console_origin: runtime.console_origin,
        environment_kind: runtime.kind,
      })}\n`);
    } catch {
      write(`${JSON.stringify({
        schema: "rainskills.runtime-status.v1",
        state: "needs_reconnect",
        usable: false,
        console_origin: runtime.console_origin,
        environment_kind: runtime.kind,
      })}\n`);
    }
    return true;
  }
  if (args[0] === "runtime" && args[1] === "reconnect") {
    if (args.length !== 3 || !["codex", "claude", "pi", "all"].includes(args[2])) {
      throw new Error("runtime reconnect 参数无效");
    }
    const current = getSingleRuntimeStore().read();
    if (!current) throw new Error("目前还没有已连接的 Rainbond 运行环境");
    const reconnectArgs = ["runtime", "connect", args[2]];
    if (current.kind === "saas") reconnectArgs.push("--saas");
    else reconnectArgs.push("--rainbond-url", current.console_origin);
    if (current.allow_insecure_http) reconnectArgs.push("--allow-insecure-http");
    return runBuiltin(reconnectArgs, {
      runtimeStateManager,
      singleRuntimeStore: getSingleRuntimeStore(),
      write,
      control,
      originInspector,
      connectionRunner,
      privateInstallerScheduler,
      credentialEnvironment,
      credentialPersister,
      connectedCredentialReader,
    });
  }
  if (args[0] === "runtime" && args[1] === "assert-connect") {
    const expected = parseRuntimeAssertConnectArgs(args);
    const manager = getRuntimeStateManager(expected.operationId);
    assertConnectingState(manager.read(), expected);
    return true;
  }
  if (args[0] === "runtime" && args[1] === "store-credential") {
    if (
      args.length < 6
      || args[2] !== "--console-origin"
      || args[4] !== "--kind"
      || !["saas", "private"].includes(args[5])
      || (args.length === 7 && args[6] !== "--allow-insecure-http")
      || args.length > 7
    ) {
      throw new Error("runtime store-credential 参数无效");
    }
    const token = credentialEnvironment.RAINBOND_JWT;
    if (typeof token !== "string" || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) {
      throw new Error("runtime store-credential 缺少有效凭据");
    }
    getSingleRuntimeStore().write({
      consoleOrigin: args[3],
      kind: args[5],
      token,
      allowInsecureHttp: args[6] === "--allow-insecure-http",
    });
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
    } else {
      getSingleRuntimeStore().write({
        consoleOrigin: current.console_origin,
        kind: current.environment_kind,
        token,
        allowInsecureHttp: current.console_origin.startsWith("http://"),
      });
    }
    return true;
  }
  if (args[0] === "runtime" && args[1] === "connect") {
    const options = parseRuntimeConnectArgs(args);
    const operationId = crypto.randomUUID();
    if (options.environmentChoice === "install-private") {
      const nextAction = privateInstallerScheduler({
        control,
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
    const manager = getRuntimeStateManager(operationId);
    const connection = {
      target_client: options.targetClient,
      environment_kind: options.environmentChoice === "saas" ? "saas" : "private",
      console_origin: inspection.origin,
      intent: null,
      operation_id: operationId,
    };
    manager.startConnecting(connection, { replaceExisting: true });
    try {
      const invocation = runtimeConnectionInvocation(options, inspection.origin);
      let completedWithCredential = false;
      const completeWithCredential = async (credential) => {
        const priorToken = process.env.RAINBOND_JWT;
        try {
          process.env.RAINBOND_JWT = credential;
          await manager.markConnected(connection);
          getSingleRuntimeStore().write({
            consoleOrigin: inspection.origin,
            kind: connection.environment_kind,
            token: credential,
            allowInsecureHttp: inspection.origin.startsWith("http://"),
          });
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
      if (typeof manager.abortConnecting === "function") {
        manager.abortConnecting(connection);
      }
      write(`${JSON.stringify(runtimeConnectRetryAction(options, inspection.origin))}\n`);
      throw error;
    }
    let storedRuntime = getSingleRuntimeStore().read();
    if (!storedRuntime || storedRuntime.console_origin !== inspection.origin) {
      if (!connectedCredentialReader) {
        throw new Error("runtime connect 未写入唯一运行环境凭据");
      }
      const credential = await connectedCredentialReader(inspection.origin);
      if (!credential || credential.origin !== inspection.origin) {
        throw new Error("运行环境凭据与已验证 Console origin 不匹配");
      }
      getSingleRuntimeStore().write({
        consoleOrigin: inspection.origin,
        kind: connection.environment_kind,
        token: credential.token,
        allowInsecureHttp: inspection.origin.startsWith("http://"),
      });
      storedRuntime = getSingleRuntimeStore().read();
    }
    if (!storedRuntime || storedRuntime.console_origin !== inspection.origin) {
      throw new Error("唯一运行环境凭据与已连接 Console origin 不匹配");
    }
    write(`${JSON.stringify({
      schema: "rainskills.runtime-connect-result.v1",
      state: "connected",
      console_origin: inspection.origin,
      environment_kind: connection.environment_kind,
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

  if (args[0] === "mcp") {
    throw new Error("Rainskills 不再提供本地 MCP 服务，请使用本地 CLI");
  }

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
  parseRuntimeConnectArgs,
  resolveInvocation,
  runAttached,
  runAutoUpdatePhase,
  runBuiltin,
  runtimeChildEnvironment,
  runtimeConnectRetryAction,
  runtimeConnectionInvocation,
};

if (require.main === module) {
  run().catch((error) => {
    console.error(`错误：${error.message}`);
    process.exitCode = 1;
  });
}
