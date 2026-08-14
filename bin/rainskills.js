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
    if (!["RAINSKILLS_RUNTIME_CONNECT_COMPLETION", "RAINSKILLS_RUNTIME_OPERATION_ID"].includes(key)) {
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
  return {
    targetClient,
    environmentChoice,
    rainbondUrl,
    allowInsecureHttp,
    onboardingId,
    intent,
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
  const result = await runAttached(invocation.executable, invocation.args, {
    env: runtimeChildEnvironment(process.env, {
      RAINSKILLS_RUNTIME_CONNECT_COMPLETION: "1",
      RAINSKILLS_RUNTIME_OPERATION_ID: operationId,
    }, origin),
  });
  return { ...result, completesRuntimeState: true };
}

function defaultPrivateInstallerScheduler({ control, intent, operationId, target }) {
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
  return createNextAction(operationId);
}

async function runBuiltin(args, {
  runtimeStateManager,
  write = (value) => process.stdout.write(value),
  control = detectControlEnvironment(),
  originInspector,
  connectionRunner = defaultConnectionRunner,
  privateInstallerScheduler = defaultPrivateInstallerScheduler,
  credentialEnvironment = process.env,
  credentialPersister,
} = {}) {
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
  if (args[0] === "runtime" && args[1] === "assert-connect") {
    const expected = parseRuntimeAssertConnectArgs(args);
    const manager = runtimeStateManager || require(
      "../rainbond-platform-installer/scripts/runtime-state.js"
    ).createRuntimeStateManager();
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
    const manager = runtimeStateManager || require(
      "../rainbond-platform-installer/scripts/runtime-state.js"
    ).createRuntimeStateManager();
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
    if (options.environmentChoice === "install-private") {
      const nextAction = privateInstallerScheduler({
        control,
        intent: options.intent,
        operationId,
        target: options.targetClient,
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
    const manager = runtimeStateManager || require(
      "../rainbond-platform-installer/scripts/runtime-state.js"
    ).createRuntimeStateManager();
    const connection = {
      target_client: options.targetClient,
      environment_kind: options.environmentChoice === "saas" ? "saas" : "private",
      console_origin: inspection.origin,
      intent: options.intent,
      operation_id: operationId,
    };
    manager.startConnecting(connection);
    try {
      const invocation = runtimeConnectionInvocation(options, inspection.origin);
      let completedWithCredential = false;
      const completeWithCredential = async (credential) => {
        const priorToken = process.env.RAINBOND_JWT;
        try {
          process.env.RAINBOND_JWT = credential;
          await manager.markConnected(connection);
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
    write(`${JSON.stringify({
      schema: "rainskills.runtime-connect-result.v1",
      state: "connected",
      onboarding_id: operationId,
      environment_kind: connection.environment_kind,
    })}\n`);
    return true;
  }
  if (args[0] === "runtime" && args[1] === "complete-connect") {
    if (args.length !== 4 || args[2] !== "--onboarding-id" || !UUID_PATTERN.test(args[3] || "")) {
      throw new Error("runtime complete-connect 参数无效");
    }
    const manager = runtimeStateManager || require(
      "../rainbond-platform-installer/scripts/runtime-state.js"
    ).createRuntimeStateManager();
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
    const status = await manager.status();
    if (status.state !== "connected" || status.usable !== true) {
      throw new Error("runtime 尚未 connected 且通过 live probe，不能恢复 intent");
    }
    const runtime = manager.read();
    if (runtime.state !== "connected") throw new Error("runtime 状态已变化，不能恢复 intent");
    if (runtime.operation_id !== args[3]) throw new Error("runtime operation_id 与参数不匹配");
    if (!runtime.intent) throw new Error("runtime state 缺少 validated intent");
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

  if (args[0] === "platform" && args[1] === "install") {
    return {
      executable: execPath,
      args: [platformInstallerPath, "install", ...args.slice(2)],
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
    process.exitCode = spawnFailed ? 1 : code === null ? 1 : code;
  });
}

module.exports = {
  classifyNodeMajor,
  parseRuntimeConnectArgs,
  resolveInvocation,
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
