"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const https = require("node:https");
const os = require("node:os");
const path = require("node:path");

const { createSecureStateStore } = require("./secure-state.js");

const OFFICIAL_LATEST_URL = "https://registry.npmjs.org/rainskills/latest";
const OFFICIAL_REGISTRY = "https://registry.npmjs.org/";
const UPDATE_STATE_SCHEMA = "rainskills.auto-update.v1";
const UPDATE_STATE_VERSION = 1;
const UPDATE_OPERATION_ID = "b53d72d4-5e88-4aae-9a9d-8305142d0262";
const DEFAULT_CHECK_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_METADATA_BYTES = 64 * 1024;
const STABLE_VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const SAFE_ENTRY = Object.freeze(["runtime", "status", "--json"]);
const DEFAULT_AGENT_ROOTS = Object.freeze([
  [".codex", "skills"],
  [".claude", "skills"],
  [".agents", "skills"],
]);

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

function validateOfficialLatestMetadata(metadata) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new Error("npm latest metadata 无效");
  }
  if (metadata.name !== "rainskills" || !isStableVersion(metadata.version)) {
    throw new Error("npm latest 不是 Rainskills 正式版");
  }
  const expectedTarball = `${OFFICIAL_REGISTRY}rainskills/-/rainskills-${metadata.version}.tgz`;
  if (
    !metadata.dist
    || typeof metadata.dist !== "object"
    || typeof metadata.dist.integrity !== "string"
    || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(metadata.dist.integrity)
    || metadata.dist.tarball !== expectedTarball
  ) {
    throw new Error("npm latest 制品来源或完整性信息无效");
  }
  return { version: metadata.version };
}

function fetchOfficialLatest({
  request = https.get,
  timeoutMs = 3000,
  maxBytes = MAX_METADATA_BYTES,
} = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve(value);
    };
    const req = request(OFFICIAL_LATEST_URL, {
      headers: { accept: "application/json" },
    }, (response) => {
      if (response.statusCode !== 200 || response.headers.location) {
        response.resume();
        finish(new Error("npm latest 响应无效"));
        return;
      }
      let size = 0;
      const chunks = [];
      response.on("data", (chunk) => {
        size += chunk.length;
        if (size > maxBytes) {
          req.destroy(new Error("npm latest 响应过大"));
          return;
        }
        chunks.push(chunk);
      });
      response.once("error", (error) => finish(error));
      response.once("end", () => {
        try {
          const metadata = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          finish(null, validateOfficialLatestMetadata(metadata));
        } catch (error) {
          finish(error);
        }
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error("npm latest 请求超时")));
    req.once("error", (error) => finish(error));
  });
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
    return Boolean(onboarding && onboarding.stage !== "configured");
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
  fetchLatest = fetchOfficialLatest,
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
  if (!latest || !isStableVersion(latest.version)) {
    try { state.recordCheck(null); } catch { /* best-effort only */ }
    return { action: "continue", reason: "invalid-latest" };
  }
  if (compareStableVersions(latest.version, currentVersion) <= 0) {
    try { state.recordCheck(latest.version); } catch { /* best-effort only */ }
    return { action: "continue", reason: "up-to-date" };
  }
  return { action: "delegate", version: latest.version };
}

function buildStableUpdateInvocation(version, args, { platform = process.platform } = {}) {
  if (!isStableVersion(version)) throw new Error("自动升级只能委托到正式版");
  if (!isSafeAutoUpdateEntry(args)) throw new Error("自动升级入口无效");
  return {
    executable: platform === "win32" ? "npx.cmd" : "npx",
    args: ["--yes", "--ignore-scripts", `rainskills@${version}`, ...args],
  };
}

function buildStableUpdateEnvironment(source, { fromVersion, targetVersion }) {
  if (!isStableVersion(fromVersion) || !isStableVersion(targetVersion)) {
    throw new Error("自动升级环境只能绑定正式版");
  }
  return {
    ...source,
    RAINSKILLS_AUTO_UPDATE_HOP: "1",
    RAINSKILLS_AUTO_UPDATE_FROM: fromVersion,
    RAINSKILLS_AUTO_UPDATE_TARGET: targetVersion,
    npm_config_registry: OFFICIAL_REGISTRY,
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
    if (["codex", "claude", "all"].includes(args[index])) target = args[index];
    if (args[index] === "--dest" && typeof args[index + 1] === "string") {
      customDestination = path.resolve(args[index + 1]);
      index += 1;
    }
  }
  if (customDestination) return [customDestination];
  if (target === "codex") return [path.join(home, ".codex", "skills")];
  if (target === "claude") return [path.join(home, ".claude", "skills")];
  return [path.join(home, ".claude", "skills"), path.join(home, ".codex", "skills")];
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
  DEFAULT_CHECK_TTL_MS,
  OFFICIAL_LATEST_URL,
  buildStableUpdateEnvironment,
  buildStableUpdateInvocation,
  checkForStableUpdate,
  compareStableVersions,
  createAutoUpdateState,
  fetchOfficialLatest,
  hasActiveOperation,
  isSafeAutoUpdateEntry,
  isStableVersion,
  recordSkillInstallDestinations,
  resolveInstallDestinations,
  synchronizeInstalledSkills,
  validateOfficialLatestMetadata,
};
