#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline/promises");
const { stdin, stdout } = require("node:process");
const { pathToFileURL } = require("node:url");
const { createSecureStateStore } = require("./secure-state.js");
const { createWindowsSecureStateStore } = require("./windows-platform.js");
const {
  authorizeWithDeviceFlow,
  authorizeWithLoopback,
  openWindowsBrowser,
} = require("./windows-auth.js");
const { validateMcp } = require("./windows-client-config.js");
const { createLifecycleTelemetry } = require("./telemetry.js");
const {
  createResultTelemetry,
  normalizeAgent,
  writeConfiguredAgents,
} = require("./result-telemetry.js");
const {
  destinationsForHostTarget,
  isHostTarget,
  telemetryClientForTarget,
} = require("./host-targets.js");

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CONTROL_MODES = new Set(["windows-native", "wsl", "posix"]);
const CAPABILITY_SUMMARY = `Rainskills 安装完成，下一条消息即可直接使用。

下一步可以直接说：

- 帮我部署当前项目
- 帮我部署一个 Git 仓库
- 帮我通过镜像或安装包部署应用
- 帮我安装一个应用模板
- 帮我分析当前项目应该如何部署

也可以直接告诉我你想部署什么应用。`;
const HERMES_CAPABILITY_SUMMARY = `Rainskills 安装完成。

如果安装发生在已经打开的 Hermes 会话中，请执行 /reset，或新建会话后再使用。

下一步可以直接说：

- 帮我部署当前项目
- 帮我部署一个 Git 仓库
- 帮我通过镜像或安装包部署应用
- 帮我安装一个应用模板
- 帮我分析当前项目应该如何部署

也可以直接告诉我你想部署什么应用。`;
const AGENT_SUMMARY_REQUIREMENT = "[RAINSKILLS_AGENT_SUMMARY_REQUIRED:include-next-actions]";

function isLocalHttpUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:") return false;

  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (hostname === "localhost" || hostname.endsWith(".localhost")) return true;
  if (net.isIP(hostname) === 6) {
    return hostname === "::1" || hostname.startsWith("fc") || hostname.startsWith("fd");
  }
  if (net.isIP(hostname) !== 4) return false;

  const octets = hostname.split(".").map(Number);
  return octets[0] === 10
    || octets[0] === 127
    || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
    || (octets[0] === 192 && octets[1] === 168)
    || (octets[0] === 169 && octets[1] === 254);
}

function requireValue(argv, index, option) {
  if (index + 1 >= argv.length || argv[index + 1].startsWith("--")) {
    throw new Error(`${option} 需要一个值`);
  }
  return argv[index + 1];
}

function authorizationTelemetryCode(error) {
  switch (error?.code) {
    case "DEVICE_AUTHORIZATION_DENIED":
      return "device_authorization_denied";
    case "DEVICE_AUTHORIZATION_EXPIRED":
      return "device_authorization_expired";
    case "DEVICE_AUTHORIZATION_CANCELLED":
      return "user_cancelled";
    default:
      return "authorization_failed";
  }
}

function parseWindowsInstallerArgs(argv) {
  const options = {
    target: "",
    customDest: "",
    force: false,
    verbose: false,
    skipMcp: false,
    nonInteractive: false,
    rainbondUrl: "",
    deploymentMode: "",
    allowInsecureHttp: false,
    noBrowser: false,
    noTelemetry: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (isHostTarget(argument)) {
      options.target = argument;
    } else if (argument === "--dest") {
      options.customDest = requireValue(argv, index, argument);
      index += 1;
    } else if (argument === "--force") {
      options.force = true;
    } else if (argument === "--verbose") {
      options.verbose = true;
    } else if (argument === "--skip-mcp") {
      options.skipMcp = true;
    } else if (argument === "--non-interactive") {
      options.nonInteractive = true;
    } else if (argument === "--rainbond-url") {
      options.rainbondUrl = requireValue(argv, index, argument);
      index += 1;
    } else if (argument === "--saas" || argument === "--self-hosted") {
      const nextMode = argument.slice(2);
      if (options.deploymentMode && options.deploymentMode !== nextMode) {
        throw new Error("--saas 和 --self-hosted 不能同时使用");
      }
      options.deploymentMode = nextMode;
    } else if (argument === "--allow-insecure-http") {
      options.allowInsecureHttp = true;
    } else if (argument === "--no-browser") {
      options.noBrowser = true;
    } else if (argument === "--no-telemetry") {
      options.noTelemetry = true;
    } else if (argument === "-h" || argument === "--help") {
      options.help = true;
    } else {
      throw new Error(`未知参数：${argument}`);
    }
  }
  return options;
}

function destinationsForTarget(target, home, env = process.env) {
  return destinationsForHostTarget(target, home, env);
}

function validateSkillDirectory(directory) {
  const skillFile = path.join(directory, "SKILL.md");
  let info;
  try {
    info = fs.lstatSync(skillFile);
  } catch (error) {
    if (error.code === "ENOENT") throw new Error(`${directory} 缺少 SKILL.md`);
    throw error;
  }
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error(`${skillFile} 必须是普通文件，不能是符号链接或 reparse point`);
  }
  const lines = fs.readFileSync(skillFile, "utf8").split(/\r?\n/);
  if (lines[0] !== "---") throw new Error(`${skillFile} 缺少标准 YAML frontmatter`);
  const closingIndex = lines.slice(1, 20).findIndex((line) => line === "---");
  if (closingIndex < 0) throw new Error(`${skillFile} 缺少标准 YAML frontmatter`);
  const frontmatter = lines.slice(1, closingIndex + 1);
  if (!frontmatter.some((line) => /^name:\s*\S/.test(line))) {
    throw new Error(`${skillFile} frontmatter 缺少 name`);
  }
  if (!frontmatter.some((line) => /^description:\s*\S/.test(line))) {
    throw new Error(`${skillFile} frontmatter 缺少 description`);
  }
}

function discoverSkills(packageRoot) {
  const skills = fs.readdirSync(packageRoot, { withFileTypes: true })
    .filter((entry) => entry.name.startsWith("rainbond-") && entry.isDirectory())
    .map((entry) => path.join(packageRoot, entry.name))
    .sort();
  const rootSkill = path.join(
    packageRoot,
    "marketplace",
    "rainskills",
    "skills",
    "rainskills"
  );
  if (fs.existsSync(rootSkill)) skills.push(rootSkill);
  if (skills.length === 0) {
    throw new Error(`在 ${packageRoot} 下没有找到 rainbond-* skill 目录`);
  }
  for (const skill of skills) validateSkillDirectory(skill);
  return skills;
}

function assertNoSymlinkPath(targetPath) {
  const resolved = path.resolve(targetPath);
  const parsed = path.parse(resolved);
  let current = parsed.root;
  for (const segment of resolved.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    if (!fs.existsSync(current)) continue;
    const info = fs.lstatSync(current);
    if (info.isSymbolicLink()) {
      throw new Error(`拒绝使用符号链接或 reparse point 目标：${current}`);
    }
  }
}

function directoryDigest(directory) {
  const digest = crypto.createHash("sha256");
  function visit(current, relative) {
    const entries = fs.readdirSync(current, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      const childRelative = path.posix.join(relative, entry.name);
      const info = fs.lstatSync(absolute);
      if (info.isSymbolicLink()) {
        throw new Error(`Skill 包含符号链接或 reparse point：${absolute}`);
      }
      if (info.isDirectory()) {
        digest.update(`d\0${childRelative}\0`);
        visit(absolute, childRelative);
      } else if (info.isFile()) {
        digest.update(`f\0${childRelative}\0${info.size}\0`);
        digest.update(fs.readFileSync(absolute));
      } else {
        throw new Error(`Skill 包含不支持的文件类型：${absolute}`);
      }
    }
  }
  visit(directory, "");
  return digest.digest("hex");
}

function replaceDirectory(source, destination) {
  const parent = path.dirname(destination);
  const name = path.basename(destination);
  const temporary = path.join(parent, `.${name}.rainskills-${crypto.randomBytes(6).toString("hex")}`);
  const backup = path.join(parent, `.${name}.backup-${crypto.randomBytes(6).toString("hex")}`);
  fs.cpSync(source, temporary, { recursive: true, errorOnExist: true });
  let backedUp = false;
  try {
    if (fs.existsSync(destination)) {
      fs.renameSync(destination, backup);
      backedUp = true;
    }
    fs.renameSync(temporary, destination);
    if (backedUp) fs.rmSync(backup, { recursive: true });
  } catch (error) {
    if (fs.existsSync(temporary)) fs.rmSync(temporary, { recursive: true });
    if (backedUp && !fs.existsSync(destination) && fs.existsSync(backup)) {
      fs.renameSync(backup, destination);
    }
    throw error;
  }
}

function copySkills({ skills, destinations, force = false, logger = () => {} }) {
  const counts = { installed: 0, updated: 0, unchanged: 0, forced: 0 };
  for (const destinationRoot of destinations) {
    assertNoSymlinkPath(destinationRoot);
    fs.mkdirSync(destinationRoot, { recursive: true });
    assertNoSymlinkPath(destinationRoot);
    for (const source of skills) {
      const destination = path.join(destinationRoot, path.basename(source));
      assertNoSymlinkPath(destination);
      if (!fs.existsSync(destination)) {
        replaceDirectory(source, destination);
        counts.installed += 1;
        logger(`[install] 已安装到 ${destination}`);
      } else if (force) {
        replaceDirectory(source, destination);
        counts.forced += 1;
        logger(`[overwrite] 已强制覆盖 ${destination}`);
      } else if (directoryDigest(source) === directoryDigest(destination)) {
        counts.unchanged += 1;
        logger(`[skip] ${destination} 已是最新`);
      } else {
        replaceDirectory(source, destination);
        counts.updated += 1;
        logger(`[update] 已更新 ${destination}`);
      }
    }
  }
  return counts;
}

function validateControl(control) {
  if (!control || !CONTROL_MODES.has(control.mode)) {
    throw new Error("不支持的 RainSkills control mode");
  }
  if (control.mode === "wsl") {
    const distro = String(control.controlDistro || "").trim();
    if (!distro || /[\u0000-\u001f\u007f-\u009f]/u.test(distro)) {
      throw new Error("WSL control distro 无效");
    }
    return distro;
  }
  return null;
}

function createOnboardingCheckpoint({
  home,
  target,
  packageVersion,
  control,
  operationId = crypto.randomUUID(),
  now = () => new Date().toISOString(),
  stateStore,
}) {
  if (!UUID_PATTERN.test(operationId)) throw new Error("operation id 不是有效的 UUID");
  if (!isHostTarget(target)) throw new Error("安装目标无效");
  const controlDistro = validateControl(control);
  const store = stateStore || (
    process.platform === "win32"
      ? createWindowsSecureStateStore({ home })
      : createSecureStateStore({ platform: process.platform, home })
  );
  const stateDirectory = path.join(home, ".rainbond");
  const checkpointPath = path.join(stateDirectory, "rainskills-onboarding-v1.json");
  const state = {
    schema: "rainskills.onboarding.v1",
    version: 1,
    operation_id: operationId,
    package_version: packageVersion || "unknown",
    updated_at: now(),
    stage: "awaiting-platform",
    target,
    deployment_mode: "self-hosted",
    control_mode: control.mode,
    control_distro: controlDistro,
    platform_state_path: path.join(
      stateDirectory,
      "platform-installer",
      operationId,
      "state.json"
    ),
    console_url: null,
  };
  store.atomicWriteJson(checkpointPath, state);
  return { path: checkpointPath, state };
}

function createNextAction(operationId, location = "") {
  if (!UUID_PATTERN.test(operationId || "")) throw new Error("operation id 不是有效的 UUID");
  if (location && !["local", "server"].includes(location)) {
    throw new Error("平台安装 location 只支持 local 或 server");
  }
  const argv = ["platform", "install", "--onboarding-id", operationId];
  if (location) argv.push("--location", location);
  return {
    schema: "rainskills.next-action.v1",
    action: "install-platform",
    onboarding_id: operationId,
    argv,
  };
}

async function authorizeAndConfigure({
  target,
  baseUrl,
  noBrowser = false,
  signal,
  logger = () => {},
  openBrowser = openWindowsBrowser,
  authorizeWithDeviceFlowImpl = authorizeWithDeviceFlow,
  authorizeWithLoopbackImpl = authorizeWithLoopback,
  validateMcpImpl = validateMcp,
  fetchImpl = globalThis.fetch,
  sleep,
  now,
  spawnImpl,
  telemetryFactory = createLifecycleTelemetry,
  onConfiguredCredential = () => {},
}) {
  const telemetry = telemetryFactory({
    context: {
      install_attempt_id: process.env.RAINSKILLS_INSTALL_ATTEMPT_ID || crypto.randomUUID(),
      operation_id: process.env.RAINSKILLS_TELEMETRY_OPERATION_ID,
      installation_id: process.env.RAINSKILLS_TELEMETRY_INSTALLATION_ID,
      package_version: process.env.RAINSKILLS_PACKAGE_VERSION,
      platform: "win32",
      control_mode: process.env.RAINSKILLS_TELEMETRY_CONTROL_MODE || "windows-native",
      target: process.env.RAINSKILLS_TELEMETRY_TARGET || "local-windows",
      client: telemetryClientForTarget(target),
      action: "install",
    },
  });
  const browserOpener = noBrowser ? async () => {} : openBrowser;
  let token;
  let authorizationMethod = "device_flow";
  telemetry.record({
    lifecycle_phase: "authorize_device_flow",
    step: "device_code",
    lifecycle_action: "authorize",
    lifecycle_status: "started",
    auth_method: "device_flow",
    transport: "powershell",
  });
  try {
    token = await authorizeWithDeviceFlowImpl({
      baseUrl,
      fetchImpl,
      now,
      openBrowser: browserOpener,
      logger,
      signal,
      sleep,
    });
  } catch (error) {
    if (error.code !== "DEVICE_FLOW_UNSUPPORTED") {
      const failureCode = authorizationTelemetryCode(error);
      telemetry.record({
        lifecycle_phase: "authorize_device_flow",
        step: "device_code",
        lifecycle_action: "authorize",
        lifecycle_status: "failed",
        error_code: failureCode,
        error_stage: "authorize_device_flow",
        reason_code: failureCode,
        auth_method: "device_flow",
        transport: "powershell",
      });
      throw error;
    }
    authorizationMethod = "browser_loopback";
    telemetry.record({
      lifecycle_phase: "authorize_device_flow",
      step: "device_code",
      lifecycle_action: "authorize",
      lifecycle_status: "skipped",
      auth_method: "device_flow",
      transport: "powershell",
    });
    telemetry.record({
      lifecycle_phase: "authorize_legacy",
      step: "legacy_callback",
      lifecycle_action: "authorize",
      lifecycle_status: "started",
      auth_method: "browser_loopback",
      transport: "powershell",
    });
    token = await authorizeWithLoopbackImpl({
      baseUrl,
      openBrowser: browserOpener,
      logger,
      signal,
    });
    telemetry.record({
      lifecycle_phase: "authorize_legacy",
      step: "legacy_callback",
      lifecycle_action: "authorize",
      lifecycle_status: "completed",
      auth_method: "browser_loopback",
      transport: "powershell",
    });
  }
  if (authorizationMethod === "device_flow") {
    telemetry.record({
      lifecycle_phase: "authorize_device_flow",
      step: "device_code",
      lifecycle_action: "authorize",
      lifecycle_status: "completed",
      auth_method: "device_flow",
      transport: "powershell",
    });
  }

  if (!isHostTarget(target)) throw new Error("安装目标无效");
  const cliUrl = `${baseUrl}/console/mcp/rainskills/api/query`;
  telemetry.record({
    lifecycle_phase: "configure_cli",
    step: "verify_cli_api",
    lifecycle_action: "configure_cli",
    lifecycle_status: "started",
    auth_method: authorizationMethod,
    transport: "powershell",
  });
  try {
    try {
      const validation = await validateMcpImpl({ fetchImpl, token, url: cliUrl });
      token = validation.token;
    } catch (error) {
      if (error.code !== "MCP_ENDPOINT_UNSUPPORTED") throw error;
      const upgradeRequired = new Error(
        "当前 Rainbond 版本不支持 Rainskills CLI，请先将 Rainbond 升级到 v6.9.9 或更高版本，然后从当前任务继续。",
        { cause: error }
      );
      upgradeRequired.code = error.code;
      throw upgradeRequired;
    }
  } catch (error) {
    telemetry.record({
      lifecycle_phase: "configure_cli",
      step: "verify_cli_api",
      lifecycle_action: "configure_cli",
      lifecycle_status: "failed",
      error_code: "cli_verification_failed",
      error_stage: "configure_cli",
      reason_code: "cli_verification_failed",
      retryable: true,
      auth_method: authorizationMethod,
      transport: "powershell",
    });
    throw error;
  }
  telemetry.record({
    lifecycle_phase: "configure_cli",
    step: "verify_cli_api",
    lifecycle_action: "configure_cli",
    lifecycle_status: "completed",
    auth_method: authorizationMethod,
    transport: "powershell",
  });
  await onConfiguredCredential(token);
  return { status: "configured" };
}

async function installLocalCli({ packageRoot, home }) {
  const installer = path.join(packageRoot, "scripts", "install-local-cli.mjs");
  if (!fs.existsSync(installer)) return { status: "not-packaged" };
  const module = await import(pathToFileURL(installer).href);
  module.installLocalCli({ source_root: packageRoot, home });
  return { status: "installed" };
}

async function promptTarget() {
  const terminal = readline.createInterface({ input: stdin, output: stdout });
  try {
    stdout.write(
      "请选择要安装和配置的平台：\n"
      + "  1) Codex\n"
      + "  2) Claude Code\n"
      + "  3) Pi Agent\n"
      + "  4) DeepSeek Harness\n"
      + "  5) WorkBuddy\n"
      + "  6) Hermes Agent\n"
      + "  7) 全部\n"
    );
    for (;;) {
      const answer = (await terminal.question("请输入选项 [1-7]: ")).trim();
      if (answer === "1") return "codex";
      if (answer === "2") return "claude";
      if (answer === "3") return "pi";
      if (answer === "4") return "dsh";
      if (answer === "5") return "workbuddy";
      if (answer === "6") return "hermes";
      if (answer === "7") return "all";
      stdout.write("请输入 1、2、3、4、5、6 或 7。\n");
    }
  } finally {
    terminal.close();
  }
}

async function promptDeployment() {
  const terminal = readline.createInterface({ input: stdin, output: stdout });
  try {
    stdout.write(
      "请选择要连接的 Rainbond：\n"
      + "  1) Rainbond Cloud（直接使用：https://run.rainbond.com）\n"
      + "  2) 私有化部署（已有平台可填写地址；没有平台可继续安装）\n"
    );
    let mode = "";
    while (!mode) {
      const answer = (await terminal.question("请输入选项 [1-2，回车默认 1]: ")).trim();
      if (answer === "" || answer === "1") mode = "saas";
      else if (answer === "2") mode = "self-hosted";
      else stdout.write("请输入 1 或 2。\n");
    }
    if (mode === "saas") {
      return { mode, baseUrl: "https://run.rainbond.com", needsPlatform: false };
    }

    stdout.write(
      "\n你现在是否已经有可以访问的 Rainbond 平台？\n"
      + "  1) 已经有，填写平台地址\n"
      + "  2) 还没有，帮我安装\n"
    );
    for (;;) {
      const answer = (await terminal.question("请输入选项 [1-2]: ")).trim();
      if (answer === "2") return { mode, baseUrl: "", needsPlatform: true };
      if (answer === "1") {
        const baseUrl = (await terminal.question("Rainbond Console 地址: ")).trim();
        if (baseUrl) return { mode, baseUrl, needsPlatform: false };
        stdout.write("Rainbond Console 地址不能为空。\n");
      } else {
        stdout.write("请输入 1 或 2。\n");
      }
    }
  } finally {
    terminal.close();
  }
}

async function resolveDeployment(options, {
  isTty = Boolean(stdin.isTTY && stdout.isTTY),
  promptDeployment: promptImpl = promptDeployment,
} = {}) {
  if (options.deploymentMode === "saas") {
    return {
      mode: "saas",
      baseUrl: options.rainbondUrl || "https://run.rainbond.com",
      needsPlatform: false,
    };
  }
  if (options.rainbondUrl) {
    return {
      mode: "self-hosted",
      baseUrl: options.rainbondUrl,
      needsPlatform: false,
    };
  }
  if (options.deploymentMode === "self-hosted") {
    return { mode: "self-hosted", baseUrl: "", needsPlatform: true };
  }
  if (options.nonInteractive || !isTty) return { needsUserInput: true };
  return promptImpl();
}

function usage() {
  stdout.write("Usage: npx rainskills [codex|claude|pi|dsh|workbuddy|hermes|all] [options]\n");
}

async function main(argv, dependencies = {}) {
  const options = parseWindowsInstallerArgs(argv);
  if (options.help) {
    usage();
    return { status: "help" };
  }
  const home = dependencies.home || os.homedir();
  const environment = dependencies.env || process.env;
  const packageRoot = dependencies.packageRoot || path.resolve(__dirname, "..", "..");
  const detectedTarget = environment.AI_AGENT === "hermes-agent"
    || environment.HERMES_AGENT === "true"
    ? "hermes"
    : "";
  let target = options.target || detectedTarget;
  if (!target && !options.customDest) {
    if (options.nonInteractive || !stdin.isTTY) {
      throw new Error("非交互安装必须明确指定 codex、claude、pi、dsh、workbuddy、hermes 或 all");
    }
    target = await (dependencies.promptTarget || promptTarget)();
  }
  const destinations = options.customDest
    ? [path.resolve(options.customDest)]
    : destinationsForTarget(target, home, environment);
  const skills = discoverSkills(packageRoot);
  const logger = dependencies.logger || ((message) => stdout.write(`${message}\n`));
  const detailLogger = options.verbose ? logger : () => {};
  const telemetryDirectory = path.join(home, ".rainbond", "rainskills", "telemetry");
  const packageVersion = (() => {
    try {
      const value = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8")).version;
      return typeof value === "string" && value ? value : "unknown";
    } catch {
      return "unknown";
    }
  })();
  const installAttemptId = UUID_PATTERN.test(environment.RAINSKILLS_INSTALL_ATTEMPT_ID || "")
    ? environment.RAINSKILLS_INSTALL_ATTEMPT_ID
    : crypto.randomUUID();
  const osArch = os.arch() === "x64" ? "amd64" : os.arch() === "arm64" ? "arm64" : "other";
  const telemetryDisabled = options.noTelemetry || environment.RAINSKILLS_TELEMETRY_DISABLED === "1";
  const resultTelemetry = (() => {
    try {
      return (dependencies.resultTelemetryFactory || createResultTelemetry)({
        directory: telemetryDirectory,
        packageVersion,
        agentType: "unknown",
        disabled: telemetryDisabled,
        installAttemptId,
        osArch,
      });
    } catch {
      return {
        record: () => ({ recorded: false, delivery: Promise.resolve(false) }),
      };
    }
  })();
  const targets = options.customDest
    ? ["unknown"]
    : (target === "all" ? ["claude", "codex", "pi", "dsh", "workbuddy", "hermes"] : [target]);
  const deliveries = [];
  try {
    const counts = copySkills({
      skills,
      destinations,
      force: options.force,
      logger: detailLogger,
    });
    if (!options.customDest) {
      await (dependencies.installLocalCli || installLocalCli)({ packageRoot, home });
    }
    for (const configuredTarget of targets) {
      const agent = normalizeAgent(configuredTarget);
      const result = resultTelemetry.record({
        event_type: "agent_config_result",
        install_attempt_id: installAttemptId,
        action: "install",
        agent_type: agent,
        status: "success",
      });
      deliveries.push(result.delivery);
    }
    const installResult = resultTelemetry.record({
      event_type: "install_result",
      install_attempt_id: installAttemptId,
      action: "install",
      os_type: "windows",
      os_arch: osArch,
      execution_environment: "native",
      status: "success",
    });
    deliveries.push(installResult.delivery);
    if (!telemetryDisabled) {
      try {
        (dependencies.configuredAgentsWriter || writeConfiguredAgents)(
          telemetryDirectory,
          targets.map(normalizeAgent)
        );
      } catch { /* telemetry state must not block installation */ }
    }
    await Promise.allSettled(deliveries);
    detailLogger("");
    detailLogger(`安装完成。本次：${counts.installed} 项新装 / ${counts.updated} 项已更新 / ${counts.unchanged} 项已是最新 / ${counts.forced} 项强制覆盖`);
    detailLogger("");
    logger(target === "hermes" ? HERMES_CAPABILITY_SUMMARY : CAPABILITY_SUMMARY);
    logger(AGENT_SUMMARY_REQUIREMENT);
    return { status: "skills-installed", counts };
  } catch (error) {
    const failure = resultTelemetry.record({
      event_type: "install_result",
      install_attempt_id: installAttemptId,
      action: "install",
      os_type: "windows",
      os_arch: osArch,
      execution_environment: "native",
      status: "failed",
      error_stage: "agent_configuration",
      error_code: "agent_config_failed",
    });
    await failure.delivery.catch(() => false);
    throw error;
  }
}

module.exports = {
  authorizeAndConfigure,
  copySkills,
  createNextAction,
  createOnboardingCheckpoint,
  destinationsForTarget,
  discoverSkills,
  installLocalCli,
  main,
  parseWindowsInstallerArgs,
  resolveDeployment,
  isLocalHttpUrl,
};

if (require.main === module) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`错误：${error.message}\n`);
    process.exitCode = 1;
  });
}
