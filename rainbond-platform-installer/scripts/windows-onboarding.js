#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline/promises");
const { spawnSync } = require("node:child_process");
const { stdin, stdout } = require("node:process");
const { detectControlEnvironment } = require("./control-environment.js");
const { createSecureStateStore } = require("./secure-state.js");
const { createWindowsSecureStateStore } = require("./windows-platform.js");
const {
  authorizeWithDeviceFlow,
  authorizeWithLoopback,
  openWindowsBrowser,
} = require("./windows-auth.js");

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CONTROL_MODES = new Set(["windows-native", "wsl", "posix"]);
const API_VALIDATION_TIMEOUT_MS = 180000;
const API_VALIDATION_MAX_BYTES = 10 * 1024 * 1024;

async function validateApi({
  url,
  token,
  fetchImpl = globalThis.fetch,
  timeoutMs = API_VALIDATION_TIMEOUT_MS,
  maxResponseBytes = API_VALIDATION_MAX_BYTES,
}) {
  const controller = new AbortController();
  let reader;
  let wallClockTimer;
  const timeoutError = new Error("Rainbond API Bridge 校验超时");
  const wallClock = new Promise((_, reject) => {
    wallClockTimer = setTimeout(() => {
      controller.abort();
      if (reader) void reader.cancel().catch(() => {});
      reject(timeoutError);
    }, timeoutMs);
  });
  try {
    return await Promise.race([(async () => {
      const response = await fetchImpl(url, {
        method: "POST",
        signal: controller.signal,
        headers: {
          accept: "application/json",
          Authorization: `GRJWT ${token}`,
          "content-type": "application/json",
          "mcp-protocol-version": "2025-03-26",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/list",
          params: {},
        }),
      });
      if (!response.ok) throw new Error(`Rainbond API Bridge 校验失败，HTTP ${response.status}`);
      if (!response.body || typeof response.body.getReader !== "function") {
        throw new Error("Rainbond API Bridge 校验返回了无法识别的响应");
      }
      reader = response.body.getReader();
      const chunks = [];
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxResponseBytes) {
          controller.abort();
          await reader.cancel().catch(() => {});
          throw new Error("Rainbond API Bridge 校验响应过大");
        }
        chunks.push(value);
      }
      const body = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        body.set(chunk, offset);
        offset += chunk.byteLength;
      }
      let payload;
      try {
        payload = JSON.parse(new TextDecoder().decode(body));
      } catch {
        throw new Error("Rainbond API Bridge 校验返回了无法识别的响应");
      }
      if (!Array.isArray(payload?.result?.tools)) {
        throw new Error("Rainbond API Bridge 校验返回了无法识别的响应");
      }
      return { token };
    })(), wallClock]);
  } finally {
    clearTimeout(wallClockTimer);
  }
}

function requireValue(argv, index, option) {
  if (index + 1 >= argv.length || argv[index + 1].startsWith("--")) {
    throw new Error(`${option} 需要一个值`);
  }
  return argv[index + 1];
}

function parseWindowsInstallerArgs(argv) {
  const options = {
    target: "",
    customDest: "",
    force: false,
    skipMcp: false,
    apiOnly: false,
    nonInteractive: false,
    rainbondUrl: "",
    deploymentMode: "",
    allowInsecureHttp: false,
    noBrowser: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (["codex", "claude", "pi", "all"].includes(argument)) {
      options.target = argument;
    } else if (argument === "--dest") {
      options.customDest = requireValue(argv, index, argument);
      index += 1;
    } else if (argument === "--force") {
      options.force = true;
    } else if (argument === "--skip-mcp") {
      options.skipMcp = true;
    } else if (argument === "--api-only") {
      options.apiOnly = true;
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
    } else if (argument === "-h" || argument === "--help") {
      options.help = true;
    } else {
      throw new Error(`未知参数：${argument}`);
    }
  }
  return options;
}

function writeCliCredentials({ baseUrl, home, token, stateStore, allowInsecureHttp = false }) {
  const store = stateStore || createWindowsSecureStateStore({ home });
  const directory = store.ensurePrivateDirectory(path.join(home, ".rainbond"));
  const target = path.join(directory, "credentials.env");
  const temporary = path.join(directory, `.credentials.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`);
  if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) {
    throw new Error(`拒绝覆盖 Windows reparse point：${target}`);
  }
  fs.writeFileSync(
    temporary,
    `export RAINBOND_JWT=${JSON.stringify(token)}\nexport RAINBOND_URL=${JSON.stringify(baseUrl)}\nexport RAINBOND_ALLOW_INSECURE_HTTP=${JSON.stringify(String(allowInsecureHttp))}\n`,
    { mode: 0o600 }
  );
  try {
    store.protectRegularFile(temporary);
    fs.renameSync(temporary, target);
    store.protectRegularFile(target);
  } catch (error) {
    try {
      fs.unlinkSync(temporary);
    } catch (cleanupError) {
      if (cleanupError.code !== "ENOENT") throw cleanupError;
    }
    throw error;
  }
}

function destinationsForTarget(target, home) {
  if (target === "codex") return [path.join(home, ".codex", "skills")];
  if (target === "claude") return [path.join(home, ".claude", "skills")];
  if (target === "pi") return [path.join(home, ".pi", "agent", "skills")];
  if (target === "all") {
    return [
      path.join(home, ".claude", "skills"),
      path.join(home, ".codex", "skills"),
    ];
  }
  throw new Error(`未知安装目标：${target}`);
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

function installBridge({ home, packageRoot, stateStore }) {
  const source = path.join(packageRoot, "bin", "rainskills-tools.js");
  const info = fs.lstatSync(source);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error(`API Bridge 必须是普通文件，不能是符号链接或 reparse point：${source}`);
  }
  const store = stateStore || (
    process.platform === "win32"
      ? createWindowsSecureStateStore({ home })
      : createSecureStateStore({ platform: process.platform, home })
  );
  const directory = path.join(home, ".rainbond", "bin");
  try {
    const directoryInfo = fs.lstatSync(directory);
    if (directoryInfo.isSymbolicLink()) {
      throw new Error(`拒绝使用符号链接或 reparse point Bridge 目录：${directory}`);
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  assertNoSymlinkPath(directory);
  store.ensurePrivateDirectory(directory);
  const destination = path.join(directory, "rainskills-tools.js");
  const manifestDestination = path.join(directory, "rainskills-skill-manifest.json");
  if (fs.existsSync(destination)) {
    const existing = fs.lstatSync(destination);
    if (!existing.isFile() || existing.isSymbolicLink()) {
      throw new Error(`拒绝覆盖符号链接或 reparse point Bridge：${destination}`);
    }
  }
  if (fs.existsSync(manifestDestination)) {
    const existing = fs.lstatSync(manifestDestination);
    if (!existing.isFile() || existing.isSymbolicLink()) {
      throw new Error(`拒绝覆盖符号链接或 reparse point Skill manifest：${manifestDestination}`);
    }
  }
  const temporary = path.join(
    directory,
    `.rainskills-tools.js.${process.pid}.${crypto.randomBytes(6).toString("hex")}`
  );
  const backup = path.join(
    directory,
    `.rainskills-tools.js.backup.${process.pid}.${crypto.randomBytes(6).toString("hex")}`
  );
  const manifestTemporary = path.join(
    directory,
    `.rainskills-skill-manifest.json.${process.pid}.${crypto.randomBytes(6).toString("hex")}`
  );
  const manifestBackup = path.join(
    directory,
    `.rainskills-skill-manifest.json.backup.${process.pid}.${crypto.randomBytes(6).toString("hex")}`
  );
  let backedUp = false;
  let installed = false;
  let manifestBackedUp = false;
  let manifestInstalled = false;
  try {
    const packagedBuilder = path.join(packageRoot, "scripts", "build-skill-manifest.mjs");
    const fallbackBuilder = path.resolve(__dirname, "..", "..", "scripts", "build-skill-manifest.mjs");
    const builder = fs.existsSync(packagedBuilder) ? packagedBuilder : fallbackBuilder;
    const build = spawnSync(process.execPath, [
      builder,
      "--source-root", packageRoot,
      "--output", manifestTemporary,
    ], { encoding: "utf8" });
    if (build.status !== 0) {
      throw new Error(`生成 Skill manifest 失败：${String(build.stderr || build.stdout || "unknown error").trim()}`);
    }
    store.protectRegularFile(manifestTemporary);
    fs.copyFileSync(source, temporary, fs.constants.COPYFILE_EXCL);
    store.protectRegularFile(temporary);
    if (fs.existsSync(manifestDestination)) {
      fs.renameSync(manifestDestination, manifestBackup);
      manifestBackedUp = true;
    }
    fs.renameSync(manifestTemporary, manifestDestination);
    manifestInstalled = true;
    store.protectRegularFile(manifestDestination);
    if (fs.existsSync(destination)) {
      fs.renameSync(destination, backup);
      backedUp = true;
    }
    fs.renameSync(temporary, destination);
    installed = true;
    store.protectRegularFile(destination);
    if (backedUp) fs.rmSync(backup, { force: true });
    if (manifestBackedUp) fs.rmSync(manifestBackup, { force: true });
  } catch (error) {
    try {
      fs.rmSync(temporary, { force: true });
      fs.rmSync(manifestTemporary, { force: true });
    } catch {
      // Preserve the original installation error.
    }
    if (installed && fs.existsSync(destination)) {
      fs.rmSync(destination, { force: true });
    }
    if (backedUp && fs.existsSync(backup)) {
      fs.renameSync(backup, destination);
    }
    if (manifestInstalled && fs.existsSync(manifestDestination)) {
      fs.rmSync(manifestDestination, { force: true });
    }
    if (manifestBackedUp && fs.existsSync(manifestBackup)) {
      fs.renameSync(manifestBackup, manifestDestination);
    }
    throw error;
  }
  return destination;
}

function installCodexReadRule({ home, bridge, stateStore }) {
  const bridgeInfo = fs.lstatSync(bridge);
  if (!bridgeInfo.isFile() || bridgeInfo.isSymbolicLink()) {
    throw new Error(`RainSkills CLI 必须是普通文件，不能是符号链接或 reparse point：${bridge}`);
  }
  const store = stateStore || (
    process.platform === "win32"
      ? createWindowsSecureStateStore({ home })
      : createSecureStateStore({ platform: process.platform, home })
  );
  const directory = path.join(home, ".codex", "rules");
  assertNoSymlinkPath(directory);
  store.ensurePrivateDirectory(directory);
  const destination = path.join(directory, "rainskills.rules");
  if (fs.existsSync(destination)) {
    const existing = fs.lstatSync(destination);
    if (!existing.isFile() || existing.isSymbolicLink()) {
      throw new Error(`拒绝覆盖符号链接或 reparse point Codex 规则：${destination}`);
    }
  }
  const rule = [
    "# Managed by RainSkills. The CLI enforces the read-only boundary before network access.",
    "prefix_rule(",
    "    pattern = [",
    "        \"node\",",
    `        ${JSON.stringify(bridge)},`,
    "        [\"status\", \"list\", \"describe\", \"read\"],",
    "    ],",
    "    decision = \"allow\",",
    "    justification = \"Allow only RainSkills catalog inspection and CLI-enforced read-only Rainbond queries.\",",
    ")",
    "",
  ].join("\n");
  const temporary = path.join(
    directory,
    `.rainskills.rules.${process.pid}.${crypto.randomBytes(6).toString("hex")}`
  );
  const backup = path.join(
    directory,
    `.rainskills.rules.backup.${process.pid}.${crypto.randomBytes(6).toString("hex")}`
  );
  let backedUp = false;
  try {
    fs.writeFileSync(temporary, rule, { flag: "wx" });
    store.protectRegularFile(temporary);
    if (fs.existsSync(destination)) {
      fs.renameSync(destination, backup);
      backedUp = true;
    }
    fs.renameSync(temporary, destination);
    store.protectRegularFile(destination);
    if (backedUp) fs.rmSync(backup, { force: true });
  } catch (error) {
    try {
      fs.rmSync(temporary, { force: true });
    } catch {
      // Preserve the original installation error.
    }
    if (backedUp && fs.existsSync(destination)) fs.rmSync(destination, { force: true });
    if (backedUp && fs.existsSync(backup)) fs.renameSync(backup, destination);
    throw error;
  }
  return destination;
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
  transportMode = "cli",
}) {
  if (!UUID_PATTERN.test(operationId)) throw new Error("operation id 不是有效的 UUID");
  if (!["codex", "claude", "pi", "all"].includes(target)) throw new Error("安装目标无效");
  // Existing interrupted onboardings may still carry the old transport label.
  // New checkpoints are always written by main() with transportMode="cli".
  if (!["cli", "mcp", "api"].includes(transportMode)) throw new Error("安装传输模式无效");
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
    transport_mode: transportMode,
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

function createNextAction(operationId) {
  if (!UUID_PATTERN.test(operationId || "")) throw new Error("operation id 不是有效的 UUID");
  return {
    schema: "rainskills.next-action.v1",
    action: "install-platform",
    onboarding_id: operationId,
    argv: ["platform", "install", "--onboarding-id", operationId],
  };
}

async function authorizeAndConfigure({
  target,
  home = os.homedir(),
  packageRoot = path.resolve(__dirname, "..", ".."),
  stateStore,
  allowInsecureHttp = false,
  baseUrl,
  noBrowser = false,
  signal,
  logger = () => {},
  openBrowser = openWindowsBrowser,
  authorizeWithDeviceFlowImpl = authorizeWithDeviceFlow,
  authorizeWithLoopbackImpl = authorizeWithLoopback,
  validateApiImpl = validateApi,
  fetchImpl = globalThis.fetch,
  sleep,
  now,
  spawnImpl,
}) {
  const browserOpener = noBrowser ? async () => {} : openBrowser;
  let token;
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
    if (error.code !== "DEVICE_FLOW_UNSUPPORTED") throw error;
    token = await authorizeWithLoopbackImpl({
      baseUrl,
      openBrowser: browserOpener,
      logger,
      signal,
    });
  }

  const apiUrl = `${baseUrl}/console/mcp/rainskills/api/query`;
  const validation = await validateApiImpl({ fetchImpl, token, url: apiUrl });
  token = validation.token;
  writeCliCredentials({ baseUrl, home, token, stateStore, allowInsecureHttp });
  logger("RainSkills CLI 已授权并验证；未修改客户端 MCP 配置。");
  return { status: "cli-configured" };
}

async function promptTarget() {
  const terminal = readline.createInterface({ input: stdin, output: stdout });
  try {
    stdout.write("请选择要安装和配置的平台：\n  1) Codex\n  2) Claude Code\n  3) Pi\n  4) Codex 和 Claude Code\n");
    for (;;) {
      const answer = (await terminal.question("请输入选项 [1-4]: ")).trim();
      if (answer === "1") return "codex";
      if (answer === "2") return "claude";
      if (answer === "3") return "pi";
      if (answer === "" || answer === "4") return "all";
      stdout.write("请输入 1、2、3 或 4。\n");
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
  stdout.write("Usage: npx rainskills [codex|claude|pi|all] [options]\n");
}

async function main(argv, dependencies = {}) {
  const options = parseWindowsInstallerArgs(argv);
  if (options.help) {
    usage();
    return { status: "help" };
  }
  const home = dependencies.home || os.homedir();
  const packageRoot = dependencies.packageRoot || path.resolve(__dirname, "..", "..");
  const nodeVersion = Object.hasOwn(dependencies, "nodeVersion")
    ? dependencies.nodeVersion
    : process.versions.node;
  const nodeMajorText = typeof nodeVersion === "string" ? nodeVersion.split(".")[0] : "";
  const nodeMajor = /^\d+$/.test(nodeMajorText) ? Number(nodeMajorText) : Number.NaN;
  if (!Number.isInteger(nodeMajor) || nodeMajor < 18) {
    throw new Error("RainSkills CLI 需要 Node.js 18 或更高版本；不会安装 Python/Shell Bridge");
  }
  const target = options.target || (
    options.nonInteractive || !stdin.isTTY
      ? "all"
      : await (dependencies.promptTarget || promptTarget)()
  );
  const logger = dependencies.logger || ((message) => stdout.write(`${message}\n`));
  const destinations = options.customDest
    ? [path.resolve(options.customDest)]
    : destinationsForTarget(target, home);
  const skills = discoverSkills(packageRoot);
  const counts = copySkills({
    skills,
    destinations,
    force: options.force,
    logger,
  });
  if (options.customDest) {
    installBridge({ home, packageRoot, stateStore: dependencies.stateStore });
    return { status: "skills-installed", counts };
  }
  const runtimePlatform = dependencies.platform || process.platform;
  const stateStore = dependencies.stateStore || (
    runtimePlatform === "win32"
      ? createWindowsSecureStateStore({ home, runner: dependencies.runner })
      : createSecureStateStore({ platform: runtimePlatform, home })
  );
  const bridge = installBridge({ home, packageRoot, stateStore });
  if (target === "codex" || target === "all") {
    const rule = installCodexReadRule({ home, bridge, stateStore });
    logger(`[install] 已安装 Codex 只读网络规则到 ${rule}`);
  }

  const deployment = await resolveDeployment(options, {
    isTty: dependencies.isTty,
    promptDeployment: dependencies.promptDeployment,
  });
  if (deployment.needsUserInput) {
    logger("[RAINSKILLS_USER_INPUT_REQUIRED:rainbond_environment]");
    logger("请选择 Rainbond Cloud，或选择私有化部署并提供平台地址/继续平台安装。");
    return { status: "waiting-user", counts };
  }

  if (deployment.needsPlatform) {
    const packageManifest = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"));
    const operationId = dependencies.operationId || crypto.randomUUID();
    const operationLock = stateStore.acquireOperationLock({ operationId });
    try {
      const checkpoint = createOnboardingCheckpoint({
        home,
        target,
        packageVersion: packageManifest.version,
        control: dependencies.control || detectControlEnvironment(),
        operationId,
        stateStore,
        transportMode: "cli",
      });
      const nextAction = createNextAction(operationId);
      logger("");
      logger("Rainbond 平台安装将在独立步骤中继续，前面的选择已经保存。");
      logger("支持 Windows 本地安装，也可以安装到 Linux 服务器。");
      logger("");
      logger("如果由 AI 代为安装，请按下面的固定参数继续；终端用户可以直接执行：");
      logger(`npx rainskills@${packageManifest.version} platform install --onboarding-id ${operationId}`);
      return { status: "awaiting-platform", counts, checkpoint, nextAction };
    } finally {
      operationLock.release();
    }
  }

  const baseUrl = deployment.baseUrl;
  const parsedBase = new URL(baseUrl);
  if (!["http:", "https:"].includes(parsedBase.protocol)) {
    throw new Error("Rainbond Console 地址必须使用 HTTP 或 HTTPS");
  }
  parsedBase.pathname = parsedBase.pathname.replace(/\/$/, "");
  parsedBase.search = "";
  parsedBase.hash = "";
  const normalizedBase = parsedBase.toString().replace(/\/$/, "");
  if (parsedBase.protocol === "http:" && !options.allowInsecureHttp) {
    throw new Error("默认禁用明文 HTTP；如需继续请添加 --allow-insecure-http");
  }
  const configure = dependencies.authorizeAndConfigure || authorizeAndConfigure;
  const configuration = await configure({
    target,
    home,
    packageRoot,
    stateStore,
    allowInsecureHttp: options.allowInsecureHttp,
    baseUrl: normalizedBase,
    noBrowser: options.noBrowser,
    logger,
    ...(dependencies.authorizationDependencies || {}),
  });
  const clientLabel = target === "codex"
    ? "Codex"
    : target === "claude"
      ? "Claude Code"
      : target === "pi"
        ? "Pi（执行 /reload）"
        : "Codex 和 Claude Code";
  logger(`安装和授权已完成。请重新启动 ${clientLabel}，让新 Skills 生效。`);
  return { status: "cli-configured", counts, configuration };
}

module.exports = {
  authorizeAndConfigure,
  copySkills,
  createNextAction,
  createOnboardingCheckpoint,
  destinationsForTarget,
  discoverSkills,
  main,
  parseWindowsInstallerArgs,
  resolveDeployment,
  installBridge,
  installCodexReadRule,
  writeCliCredentials,
  validateApi,
};

if (require.main === module) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`错误：${error.message}\n`);
    process.exitCode = 1;
  });
}
