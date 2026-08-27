#!/usr/bin/env node

const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const os = require("node:os");
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");
const { spawnSync } = require("node:child_process");

const REQUEST_TIMEOUT_MS = 180_000;
const INPUT_MAX_BYTES = 1024 * 1024;
const RESPONSE_MAX_BYTES = 10 * 1024 * 1024;
const STDOUT_MAX_BYTES = 128 * 1024;
const CATALOG_TTL_MS = 5 * 60 * 1000;
const PROTOCOL_VERSION = "2025-03-26";
const ENDPOINT_PATH = "/console/mcp/rainskills/api/query";
const CLI_VERSION = "2.1.0";
const CONFIG_DIRECTORY = ".rainbond";
const CATALOG_FILENAME = "capabilities.json";
const OPERATIONS_DIRECTORY = "operations";
const SKILL_MANIFEST_FILENAME = "rainskills-skill-manifest.json";
const OPERATION_ID_PATTERN = /^[a-f0-9]{8}-[a-f0-9-]{27,}$/;
const SKILL_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f-\u009f]/u;
const CONTEXT_RESOLVE_FIELDS = new Set(["required", "hints", "selection"]);
const CONTEXT_HINT_FIELDS = new Set(["team_id", "team_name", "region_name"]);
const SKILL_CONTENT_MAX_BYTES = 128 * 1024;
const SKILL_MANIFEST_MAX_BYTES = 4 * 1024 * 1024;
const SENSITIVE_RESPONSE_KEY_PATTERN = /(?:authorization|jwt|token|password|secret|credential|private[_-]?key|key[_-]?file|certificate|cert[_-]?file|ssl[_-]?ca[_-]?cert)/i;
const RISK_POLICY = Object.freeze({
  version: "1",
  readPrefixes: [
    "rainbond_query_", "rainbond_get_", "rainbond_list_", "rainbond_check_",
    "rainbond_describe_", "rainbond_validate_", "rainbond_verify_", "rainbond_search_",
  ],
  destructiveFragments: ["delete", "remove", "purge", "destroy"],
});
const CALL_OPTION_DEFINITIONS = Object.freeze({
  "--confirm": Object.freeze({ property: "confirmation", pattern: OPERATION_ID_PATTERN }),
  "--skill-id": Object.freeze({ property: "skillId", pattern: SKILL_ID_PATTERN }),
  "--root-skill-id": Object.freeze({ property: "rootSkillId", pattern: SKILL_ID_PATTERN }),
});
const PACKAGE_UPLOAD_FIELDS = Object.freeze([
  "url", "url_scope", "method", "content_type", "file_field", "authorization",
]);
const PACKAGE_UPLOAD_MAX_TIMEOUT_SECONDS = 3600;
const PLATFORM_QUERY_TO_RESOURCE = Object.freeze({
  rainbond_get_current_user: "current-user",
  rainbond_query_enterprises: "current-enterprise",
  rainbond_query_teams: "teams",
  rainbond_query_regions: "regions",
  rainbond_query_apps: "apps",
  rainbond_get_team_apps: "team-apps",
  rainbond_query_components: "components",
});
const ENTERPRISE_SCOPED_PLATFORM_QUERY_TOOLS = new Set([
  "rainbond_query_teams",
  "rainbond_query_regions",
  "rainbond_query_apps",
  "rainbond_query_components",
]);

const EXIT = Object.freeze({
  USAGE: 2,
  CONFIG: 3,
  TRANSPORT: 4,
  TOOL: 5,
});

class BridgeError extends Error {
  constructor(message, exitCode, payload) {
    super(message);
    this.exitCode = exitCode;
    this.payload = payload;
  }
}

function requireRuntimeModule(filename) {
  const candidates = [
    path.resolve(__dirname, "..", "rainbond-platform-installer", "scripts", filename),
    path.resolve(__dirname, "..", "lib", "rainskills", "rainbond-platform-installer", "scripts", filename),
    path.resolve(__dirname, "..", "lib", "rainbond-platform-installer", "scripts", filename),
  ];
  for (const candidate of candidates) {
    try {
      const info = fs.lstatSync(candidate);
      if (info.isFile() && !info.isSymbolicLink()) return require(candidate);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  throw new BridgeError("installed Rainskills CLI runtime is incomplete", EXIT.CONFIG);
}

function requireRuntimeFile(...segments) {
  const candidates = [
    path.resolve(__dirname, "..", ...segments),
    path.resolve(__dirname, "..", "lib", "rainskills", ...segments),
    path.resolve(__dirname, "..", "lib", ...segments),
  ];
  for (const candidate of candidates) {
    try {
      const info = fs.lstatSync(candidate);
      if (info.isFile() && !info.isSymbolicLink()) return candidate;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  throw new BridgeError("installed Rainskills package upload helper is incomplete", EXIT.CONFIG);
}

function loadConfig({
  env = process.env,
  homeDir = os.homedir(),
  includeRuntime = false,
} = {}) {
  const hasEnvironmentOverride = env.RAINSKILLS_CREDENTIAL_SOURCE === "environment";
  if (hasEnvironmentOverride && !(env.RAINBOND_URL && env.RAINBOND_JWT)) {
    throw new BridgeError(
      "RAINBOND_URL and RAINBOND_JWT must be provided together",
      EXIT.CONFIG
    );
  }
  const stored = hasEnvironmentOverride
    ? null
    : requireRuntimeModule("single-runtime.js").createSingleRuntimeStore({ home: homeDir }).read();
  const baseUrl = hasEnvironmentOverride ? env.RAINBOND_URL : stored?.console_origin;
  const jwt = hasEnvironmentOverride ? env.RAINBOND_JWT : stored?.token;
  if (!baseUrl || !jwt) {
    throw new BridgeError("no Rainbond runtime is configured", EXIT.CONFIG);
  }

  let parsed;
  try {
    parsed = new URL(baseUrl);
  } catch (_error) {
    throw new BridgeError("RAINBOND_URL must be a valid HTTP(S) URL", EXIT.CONFIG);
  }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username ||
    parsed.password || parsed.search || parsed.hash) {
    throw new BridgeError("RAINBOND_URL must be a safe HTTP(S) URL", EXIT.CONFIG);
  }
  const allowInsecureHttp = hasEnvironmentOverride
    ? env.RAINBOND_ALLOW_INSECURE_HTTP === "true"
    : stored.allow_insecure_http;
  if (parsed.protocol === "http:" && !allowInsecureHttp) {
    throw new BridgeError(
      "RAINBOND_URL must use HTTPS; explicitly authorize insecure HTTP during installation",
      EXIT.CONFIG
    );
  }
  const config = {
    baseUrl: parsed.toString().replace(/\/$/, ""),
    jwt,
  };
  if (includeRuntime) {
    config.homeDir = homeDir;
    config.allowInsecureHttp = allowInsecureHttp;
    config.isInsecureHttp = parsed.protocol === "http:";
  }
  return config;
}

function parseCommand(args) {
  if (args.includes("--operation-id") || args.includes("--environment-id")) {
    throw new BridgeError("--operation-id and --environment-id are no longer supported", EXIT.USAGE);
  }
  const skillIndex = args.indexOf("--skill-id");
  if (
    skillIndex < 0
    || !SKILL_ID_PATTERN.test(args[skillIndex + 1] || "")
    || args.indexOf("--skill-id", skillIndex + 1) !== -1
  ) {
    throw new BridgeError(
      "every tools command requires --skill-id <active-skill-id>",
      EXIT.USAGE
    );
  }
  const skillId = args[skillIndex + 1];
  const remaining = [
    ...args.slice(0, skillIndex),
    ...args.slice(skillIndex + 2),
  ];
  const command = remaining[0];
  const context = { skillId };
  if (
    command === "context"
    && remaining[1] === "resolve"
    && remaining.length === 4
    && remaining[2] === "--input"
    && remaining[3] === "-"
  ) {
    return {
      command,
      action: remaining[1],
      input: remaining[3],
      ...context,
    };
  }
  if (
    command === "query"
    && Object.hasOwn(PLATFORM_QUERY_TO_RESOURCE, remaining[1] || "")
    && remaining.length === 4
    && remaining[2] === "--input"
    && remaining[3] === "-"
  ) {
    return { command, toolName: remaining[1], input: remaining[3], ...context };
  }
  if (command === "query") {
    throw new BridgeError("platform query tool is not allowed", EXIT.USAGE);
  }
  if (command === "status" && remaining.length === 1) return { command, ...context };
  if (command === "list") {
    if (remaining.length === 1) return { command, ...context };
    if (remaining.length === 3 && remaining[1] === "--prefix" && remaining[2]) {
      return { command, prefix: remaining[2], ...context };
    }
  }
  if (command === "describe" && remaining.length === 2 && remaining[1]) {
    return { command, toolName: remaining[1], ...context };
  }
  if (
    command === "package-upload"
    && remaining.length === 5
    && remaining[1] === "--archive"
    && remaining[2]
    && !remaining[2].startsWith("--")
    && remaining[3] === "--input"
    && remaining[4] === "-"
  ) {
    return { command, archive: remaining[2], input: remaining[4], ...context };
  }
  if (command === "read" && remaining.length === 4 && remaining[1] && remaining[2] === "--input" && remaining[3] === "-") {
    return { command, toolName: remaining[1], input: remaining[3], ...context };
  }
  if (command === "call" && remaining.length >= 4 && remaining[1] && remaining[2] === "--input" && remaining[3] === "-") {
    const parsed = { command, toolName: remaining[1], input: remaining[3], ...context };
    for (let index = 4; index < remaining.length; index += 2) {
      const option = remaining[index];
      const value = remaining[index + 1];
      const definition = CALL_OPTION_DEFINITIONS[option];
      if (!definition) {
        throw new BridgeError(`unsupported call option: ${String(option)}`, EXIT.USAGE);
      }
      if (!value || value.startsWith("--")) {
        throw new BridgeError(`call option ${option} requires a value`, EXIT.USAGE);
      }
      if (parsed[definition.property]) {
        throw new BridgeError(`call option ${option} may be provided only once`, EXIT.USAGE);
      }
      if (!definition.pattern.test(value)) {
        throw new BridgeError(`call option ${option} has an invalid value`, EXIT.USAGE);
      }
      parsed[definition.property] = value;
    }
    return parsed;
  }
  throw new BridgeError("invalid command; use status, list, describe, read, or call", EXIT.USAGE);
}

function platformQueryIntent(toolName, argumentsValue) {
  const resource = PLATFORM_QUERY_TO_RESOURCE[toolName];
  if (!resource) throw new BridgeError("platform query tool is not allowed", EXIT.USAGE);
  const intent = { type: "platform-query", resource };
  for (const field of ["enterprise_id", "team_id"]) {
    if (argumentsValue[field] !== undefined) intent[field] = argumentsValue[field];
  }
  if (argumentsValue.app_id !== undefined) {
    const value = argumentsValue.app_id;
    if (!(
      (Number.isInteger(value) && value > 0)
      || (typeof value === "string" && /^[1-9][0-9]*$/.test(value))
    )) {
      throw new BridgeError("platform query app_id must be a positive integer", EXIT.USAGE);
    }
    intent.app_id = String(value);
  }
  return intent;
}

async function resolvePlatformQueryArguments(toolName, argumentsValue, config) {
  if (
    !ENTERPRISE_SCOPED_PLATFORM_QUERY_TOOLS.has(toolName)
    || (typeof argumentsValue.enterprise_id === "string" && argumentsValue.enterprise_id)
  ) {
    return argumentsValue;
  }
  const identity = await execute({
    command: "read",
    toolName: "rainbond_get_current_user",
    argumentsValue: {},
  }, config);
  if (!identity || typeof identity.enterprise_id !== "string" || !identity.enterprise_id) {
    throw new BridgeError(
      "current Rainbond identity does not include an enterprise",
      EXIT.TOOL
    );
  }
  return { ...argumentsValue, enterprise_id: identity.enterprise_id };
}

function readArguments(input) {
  if (input !== "-") {
    throw new BridgeError("read and call accept JSON only through --input - (stdin)", EXIT.USAGE);
  }
  let contentsBuffer;
  try {
    const chunks = [];
    let totalBytes = 0;
    while (true) {
      const chunk = Buffer.allocUnsafe(64 * 1024);
      const bytesRead = fs.readSync(0, chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      totalBytes += bytesRead;
      if (totalBytes > INPUT_MAX_BYTES) {
        throw new BridgeError("JSON input is too large", EXIT.USAGE);
      }
      chunks.push(chunk.subarray(0, bytesRead));
    }
    contentsBuffer = Buffer.concat(chunks, totalBytes);
  } catch (_error) {
    if (_error instanceof BridgeError) throw _error;
    throw new BridgeError("unable to read JSON input", EXIT.USAGE);
  }
  let parsed;
  try {
    parsed = JSON.parse(contentsBuffer.toString("utf8"));
  } catch (_error) {
    throw new BridgeError("input must contain valid JSON", EXIT.USAGE);
  }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new BridgeError("input JSON must be an object", EXIT.USAGE);
  }
  return parsed;
}

function validatePackageUploadRequest(value) {
  const allowed = new Set([...PACKAGE_UPLOAD_FIELDS, "timeout"]);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BridgeError("package upload request must be an object", EXIT.USAGE);
  }
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new BridgeError("package upload request has unknown fields", EXIT.USAGE);
  }
  if (PACKAGE_UPLOAD_FIELDS.some((key) => typeof value[key] !== "string" || !value[key])) {
    throw new BridgeError("package upload request is incomplete", EXIT.USAGE);
  }
  const timeout = value.timeout === undefined ? 1800 : value.timeout;
  if (
    !Number.isInteger(timeout)
    || timeout < 1
    || timeout > PACKAGE_UPLOAD_MAX_TIMEOUT_SECONDS
  ) {
    throw new BridgeError("package upload timeout is invalid", EXIT.USAGE);
  }
  return { ...value, timeout };
}

function packageUploadEnvironment(baseUrl, source = process.env) {
  const environment = { RAINBOND_URL: baseUrl };
  for (const key of [
    "PATH", "SystemRoot", "WINDIR", "ComSpec", "PATHEXT",
    "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL",
    "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY",
    "http_proxy", "https_proxy", "no_proxy",
    "SSL_CERT_FILE", "SSL_CERT_DIR", "CURL_CA_BUNDLE",
  ]) {
    if (typeof source[key] === "string" && source[key]) environment[key] = source[key];
  }
  return environment;
}

function executePackageUpload(command, config, { spawnSyncFn = spawnSync } = {}) {
  const request = validatePackageUploadRequest(command.argumentsValue);
  const helper = requireRuntimeFile(
    "rainbond-fullstack-bootstrap", "scripts", "upload_local_package.py"
  );
  const result = spawnSyncFn("python3", [
    helper,
    "upload",
    "--archive", command.archive,
    "--upload-url", request.url,
    "--url-scope", request.url_scope,
    "--method", request.method,
    "--content-type", request.content_type,
    "--file-field", request.file_field,
    "--authorization", request.authorization,
    "--timeout", String(request.timeout),
  ], {
    encoding: "utf8",
    env: packageUploadEnvironment(config.baseUrl),
    maxBuffer: 256 * 1024,
    shell: false,
    timeout: (request.timeout + 2) * 1000,
  });
  if (result.error || result.status !== 0) {
    throw new BridgeError("package upload failed", EXIT.TOOL);
  }
  let payload;
  try {
    payload = JSON.parse(result.stdout);
  } catch {
    throw new BridgeError("package upload helper returned invalid JSON", EXIT.TRANSPORT);
  }
  if (!payload || payload.uploaded !== true || Object.keys(payload).length !== 1) {
    throw new BridgeError("package upload helper returned an invalid result", EXIT.TRANSPORT);
  }
  return payload;
}

function assertPrivateDirectory(directory) {
  try {
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
    if ((stat.mode & 0o077) !== 0) fs.chmodSync(directory, 0o700);
    return true;
  } catch (error) {
    if (error.code !== "ENOENT") return false;
  }
  try {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.chmodSync(directory, 0o700);
    return true;
  } catch (_error) {
    return false;
  }
}

function catalogPath(config) {
  return path.join(config.homeDir || os.homedir(), CONFIG_DIRECTORY, CATALOG_FILENAME);
}

function operationsPath(config) {
  return path.join(config.homeDir || os.homedir(), CONFIG_DIRECTORY, OPERATIONS_DIRECTORY);
}

function skillManifestPath(config) {
  return path.join(config.homeDir || os.homedir(), CONFIG_DIRECTORY, "bin", SKILL_MANIFEST_FILENAME);
}

function loadSkillBinding(config, skillId, rootSkillId) {
  const target = skillManifestPath(config);
  let manifest;
  try {
    const info = fs.lstatSync(target);
    if (
      !info.isFile()
      || info.isSymbolicLink()
      || (process.platform !== "win32" && (info.mode & 0o077) !== 0)
      || info.size > SKILL_MANIFEST_MAX_BYTES
    ) throw new Error("unsafe manifest");
    manifest = JSON.parse(fs.readFileSync(target, "utf8"));
  } catch (_error) {
    throw new BridgeError("RainSkills Skill manifest is missing or unsafe", EXIT.CONFIG);
  }
  if (
    !manifest
    || manifest.schema !== "rainskills.skill-manifest.v1"
    || manifest.profile !== "cli"
    || typeof manifest.package_version !== "string"
    || !manifest.package_version
    || !Array.isArray(manifest.skills)
  ) {
    throw new BridgeError("RainSkills Skill manifest schema is incompatible", EXIT.CONFIG);
  }
  const entry = manifest.skills.find((candidate) => candidate && candidate.id === skillId);
  if (
    !entry
    || entry.profile !== "cli"
    || entry.package_version !== manifest.package_version
    || typeof entry.content !== "string"
    || Buffer.byteLength(entry.content, "utf8") > SKILL_CONTENT_MAX_BYTES
    || !SHA256_PATTERN.test(entry.content_sha256)
    || !SHA256_PATTERN.test(entry.bundle_sha256)
    || createHash("sha256").update(entry.content, "utf8").digest("hex") !== entry.content_sha256
  ) {
    throw new BridgeError("RainSkills Skill manifest entry is invalid", EXIT.CONFIG);
  }
  return {
    skillId,
    rootSkillId: rootSkillId || skillId,
    packageVersion: entry.package_version,
    sourceRevision: entry.source_revision || null,
    contentSha256: entry.content_sha256,
    bundleSha256: entry.bundle_sha256,
    content: entry.content,
  };
}

function classifyTool(toolName) {
  const normalized = String(toolName || "").toLowerCase();
  if (RISK_POLICY.destructiveFragments.some((fragment) => normalized.includes(fragment))) {
    return "destructive";
  }
  if (RISK_POLICY.readPrefixes.some((prefix) => normalized.startsWith(prefix))) return "read";
  return "write";
}

function operationFile(config, operationId) {
  return path.join(operationsPath(config), `${operationId}.json`);
}

function operationClaimFile(config, operationId) {
  return path.join(operationsPath(config), `${operationId}.claim`);
}

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function argumentsDigest(value) {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function writeOperation(config, record) {
  const directory = operationsPath(config);
  if (!assertPrivateDirectory(directory)) {
    throw new BridgeError("unable to write the local operation journal", EXIT.CONFIG);
  }
  const target = operationFile(config, record.operation_id);
  try {
    if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) {
      throw new Error("symbolic link");
    }
    const temporary = path.join(directory, `.${record.operation_id}.${process.pid}.tmp`);
    fs.writeFileSync(temporary, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    fs.chmodSync(temporary, 0o600);
    fs.renameSync(temporary, target);
  } catch (_error) {
    throw new BridgeError("unable to write the local operation journal", EXIT.CONFIG);
  }
}

function readOperation(config, operationId) {
  const target = operationFile(config, operationId);
  try {
    const stat = fs.lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) return null;
    const record = JSON.parse(fs.readFileSync(target, "utf8"));
    return record && typeof record === "object" ? record : null;
  } catch (_error) {
    return null;
  }
}

function prepareOperation(config, toolName, operationClass, argumentsValue, skillBinding) {
  const operationId = randomUUID();
  const record = {
    operation_id: operationId,
    tool_name: toolName,
    operation_class: operationClass,
    arguments_digest: argumentsDigest(argumentsValue),
    skill_id: skillBinding.skillId,
    root_skill_id: skillBinding.rootSkillId,
    skill_package_version: skillBinding.packageVersion,
    skill_source_revision: skillBinding.sourceRevision,
    skill_content_sha256: skillBinding.contentSha256,
    skill_bundle_sha256: skillBinding.bundleSha256,
    policy_version: RISK_POLICY.version,
    created_at: new Date().toISOString(),
    status: "awaiting_confirmation",
  };
  writeOperation(config, record);
  return record;
}

function confirmOperation(
  config,
  operationId,
  toolName,
  operationClass,
  argumentsValue,
  skillBinding
) {
  const record = readOperation(config, operationId);
  if (!record || record.status !== "awaiting_confirmation" || record.tool_name !== toolName ||
    record.operation_class !== operationClass ||
    record.arguments_digest !== argumentsDigest(argumentsValue) ||
    record.skill_id !== skillBinding.skillId ||
    record.root_skill_id !== skillBinding.rootSkillId ||
    record.skill_package_version !== skillBinding.packageVersion ||
    record.skill_content_sha256 !== skillBinding.contentSha256 ||
    record.skill_bundle_sha256 !== skillBinding.bundleSha256) {
    throw new BridgeError("operation confirmation is missing or does not match this tool", EXIT.USAGE);
  }
  let claim;
  try {
    claim = fs.openSync(operationClaimFile(config, operationId), "wx", 0o600);
    fs.writeFileSync(claim, `${JSON.stringify({ claimed_at: new Date().toISOString() })}\n`);
  } catch (_error) {
    throw new BridgeError("operation confirmation was already claimed", EXIT.USAGE);
  } finally {
    if (claim !== undefined) fs.closeSync(claim);
  }
  updateOperation(config, record, "executing");
  return record;
}

function buildAuditMetadata(operation, skillBinding) {
  return {
    schema: "rainskills.operation-meta.v1",
    operation_id: operation.operation_id,
    cli_version: CLI_VERSION,
    confirmation_type: "rainskills_cli",
    root_skill_id: skillBinding.rootSkillId,
    skill: {
      id: skillBinding.skillId,
      profile: "cli",
      package_version: skillBinding.packageVersion,
      source_revision: skillBinding.sourceRevision,
      content_sha256: skillBinding.contentSha256,
      bundle_sha256: skillBinding.bundleSha256,
      content: skillBinding.content,
    },
  };
}

function updateOperation(config, record, status) {
  writeOperation(config, { ...record, status, updated_at: new Date().toISOString() });
}

function loadCachedCatalog(config) {
  const target = catalogPath(config);
  try {
    const stat = fs.lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) return null;
    const payload = JSON.parse(fs.readFileSync(target, "utf8"));
    if (!payload || payload.endpoint !== config.baseUrl || payload.protocol_version !== PROTOCOL_VERSION ||
      !Array.isArray(payload.tools) || !Number.isFinite(payload.fetched_at)) return null;
    const age = Date.now() - payload.fetched_at;
    if (age < 0 || age > CATALOG_TTL_MS) return null;
    return { tools: payload.tools, age };
  } catch (_error) {
    return null;
  }
}

function writeCachedCatalog(config, tools) {
  const directory = path.dirname(catalogPath(config));
  if (!assertPrivateDirectory(directory)) return;
  const target = catalogPath(config);
  try {
    if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) return;
    const temporary = path.join(directory, `.capabilities.${process.pid}.${Date.now()}.tmp`);
    fs.writeFileSync(temporary, JSON.stringify({
      endpoint: config.baseUrl,
      protocol_version: PROTOCOL_VERSION,
      fetched_at: Date.now(),
      tools,
    }), { mode: 0o600 });
    fs.chmodSync(temporary, 0o600);
    fs.renameSync(temporary, target);
  } catch (_error) {
    // Capability caching is an optimization and must never block a valid API call.
  }
}

function fitOutput(value) {
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized, "utf8") <= STDOUT_MAX_BYTES) return value;
  const nextCursor = value && typeof value === "object" && !Array.isArray(value)
    ? value.next_cursor || value.nextCursor || null
    : null;
  return {
    truncated: true,
    summary: "RainSkills CLI result exceeded the local output budget; request a narrower page, time range, or log tail.",
    ...(nextCursor ? { next_cursor: nextCursor } : {}),
  };
}

function sanitizeToolResult(value, pathParts = []) {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeToolResult(item, pathParts));
  }
  if (!value || typeof value !== "object") return value;
  const safe = {};
  for (const [key, item] of Object.entries(value)) {
    // Console destructive operations may return this one-time control value.
    // It is not a credential and must remain available for the confirmation flow.
    const isPackageUploadAuthMode = key === "authorization"
      && item === "none"
      && pathParts.length === 1
      && pathParts[0] === "upload_request";
    if (key !== "confirmation_token"
      && !isPackageUploadAuthMode
      && SENSITIVE_RESPONSE_KEY_PATTERN.test(key)) continue;
    safe[key] = sanitizeToolResult(item, [...pathParts, key]);
  }
  return safe;
}

function collectArgumentRedactions(value, output = []) {
  if (typeof value === "string" && value.length >= 4) output.push(value);
  if (Array.isArray(value)) {
    for (const item of value) collectArgumentRedactions(item, output);
  } else if (value && typeof value === "object") {
    for (const item of Object.values(value)) collectArgumentRedactions(item, output);
  }
  return output;
}

function redactPayload(value) {
  if (Array.isArray(value)) return value.map(redactPayload);
  if (!value || typeof value !== "object") return value;
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (/arguments|authorization|jwt|token|password|secret|credential/i.test(key)) {
      result[key] = "[REDACTED]";
    } else {
      result[key] = redactPayload(item);
    }
  }
  return result;
}

function safeJson(value, secrets = []) {
  let output = JSON.stringify(redactPayload(value));
  for (const secret of secrets) {
    if (secret) output = output.split(secret).join("[REDACTED]");
  }
  return output;
}

function httpJsonRpcRequest(config, endpointPath, message, {
  timeoutMs = REQUEST_TIMEOUT_MS,
  maxResponseBytes = RESPONSE_MAX_BYTES,
} = {}) {
  const endpoint = new URL(`${config.baseUrl.replace(/\/+$/, "")}${endpointPath}`);
  const payload = JSON.stringify(message);
  const client = endpoint.protocol === "https:" ? https : http;

  return new Promise((resolve, reject) => {
    let settled = false;
    let responseRef;
    let wallTimer;

    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(wallTimer);
      callback(value);
    };
    const fail = (error, abort = false) => {
      if (settled) return;
      settle(reject, error);
      if (abort) {
        if (responseRef && !responseRef.destroyed) responseRef.destroy();
        if (!request.destroyed) request.destroy();
      }
    };

    const request = client.request(endpoint, {
      method: "POST",
      headers: {
        Authorization: `GRJWT ${config.jwt}`,
        Accept: "application/json",
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
        "MCP-Protocol-Version": PROTOCOL_VERSION,
      },
    }, (response) => {
      responseRef = response;
      const chunks = [];
      let responseBytes = 0;
      const interrupted = () => fail(
        new BridgeError("Rainbond API response was interrupted", EXIT.TRANSPORT),
        true
      );
      response.on("aborted", interrupted);
      response.on("error", interrupted);
      response.on("close", () => {
        if (!settled && !response.complete) interrupted();
      });
      response.on("data", (chunk) => {
        if (settled) return;
        responseBytes += chunk.length;
        if (responseBytes > maxResponseBytes) {
          fail(new BridgeError("Rainbond API response is too large", EXIT.TRANSPORT), true);
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => {
        if (settled) return;
        if (!response.complete) {
          interrupted();
          return;
        }
        const body = Buffer.concat(chunks, responseBytes).toString("utf8");
        settle(resolve, {
          statusCode: response.statusCode || 0,
          headers: response.headers,
          body,
        });
      });
    });
    request.on("error", (error) => {
      fail(error instanceof BridgeError
        ? error
        : new BridgeError("unable to reach Rainbond API", EXIT.TRANSPORT));
    });
    wallTimer = setTimeout(() => {
      fail(new BridgeError("Rainbond API request timed out", EXIT.TRANSPORT), true);
    }, timeoutMs);
    request.end(payload);
  });
}

function parseJsonRpcBody(body, expectedId, { allowEmpty = false, contentType = "" } = {}) {
  if (!body.trim() && allowEmpty) return null;
  let serialized = body;
  if (contentType.toLowerCase().includes("text/event-stream")) {
    const data = body.split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .filter(Boolean)
      .at(-1);
    if (!data) throw new BridgeError("Rainbond returned invalid MCP event data", EXIT.TRANSPORT);
    serialized = data;
  }
  let rpc;
  try {
    rpc = JSON.parse(serialized);
  } catch (_error) {
    throw new BridgeError("Rainbond returned invalid JSON", EXIT.TRANSPORT);
  }
  if (!rpc || rpc.jsonrpc !== "2.0" || (expectedId !== undefined && rpc.id !== expectedId)) {
    throw new BridgeError("Rainbond returned an invalid JSON-RPC response", EXIT.TRANSPORT);
  }
  if (rpc.error) {
    const protocolErrors = new Set([-32700, -32600, -32601]);
    throw new BridgeError(
      "Rainbond rejected the tool request",
      protocolErrors.has(rpc.error.code) ? EXIT.TRANSPORT : EXIT.TOOL,
      { code: rpc.error.code, message: rpc.error.message }
    );
  }
  if (!("result" in rpc)) {
    throw new BridgeError("Rainbond JSON-RPC result is missing", EXIT.TRANSPORT);
  }
  return rpc.result;
}

function assertRpcHttpSuccess(response, { endpointUnavailable = false } = {}) {
  if (response.statusCode === 401 || response.statusCode === 403) {
    throw new BridgeError("Rainbond authentication failed", EXIT.CONFIG);
  }
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new BridgeError(
      endpointUnavailable && response.statusCode === 404
        ? "Rainskills API endpoint is unavailable; upgrade Rainbond Console"
        : "Rainbond API request failed",
      EXIT.TRANSPORT
    );
  }
}

function isVerifiedMissingRpcRoute(response) {
  if (response.statusCode !== 404) return false;
  const contentType = String(response.headers["content-type"] || "").toLowerCase();
  const body = response.body.trim();
  if (contentType.includes("text/plain")) return body === "Not Found";
  if (contentType.includes("text/html")) {
    const normalized = body.toLowerCase();
    return normalized.includes("<title") && normalized.includes("not found");
  }
  if (!contentType.includes("json")) return false;
  try {
    const payload = JSON.parse(body);
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
    if (["Not Found", "not found"].includes(payload.detail)) return true;
    return ["code", "status", "status_code", "error_code"]
      .some((key) => payload[key] === 404 || payload[key] === "404");
  } catch {
    return false;
  }
}

async function rpcRequest(config, method, params = {}, options = {}) {
  const response = await httpJsonRpcRequest(config, ENDPOINT_PATH, {
    jsonrpc: "2.0",
    id: 1,
    method,
    params,
  }, options);
  if (isVerifiedMissingRpcRoute(response)) {
    throw new BridgeError(
      "当前 Rainbond 版本不支持 Rainskills CLI，请先将 Rainbond 升级到 v6.9.9 或更高版本",
      EXIT.TRANSPORT
    );
  }
  assertRpcHttpSuccess(response);
  return parseJsonRpcBody(response.body, 1, {
    contentType: String(response.headers["content-type"] || ""),
  });
}

async function listTools(config) {
  const cached = loadCachedCatalog(config);
  if (cached) return cached.tools;
  const result = await rpcRequest(config, "tools/list");
  if (!result || !Array.isArray(result.tools)) {
    throw new BridgeError("Rainbond tool catalog is invalid", EXIT.TRANSPORT);
  }
  writeCachedCatalog(config, result.tools);
  return result.tools;
}

function schemaTypeMatches(value, type) {
  if (type === "null") return value === null;
  if (type === "array") return Array.isArray(value);
  if (type === "object") return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  if (type === "integer") return Number.isInteger(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  return typeof value === type;
}

function validateSchemaValue(value, schema, fieldPath) {
  if (!schema || typeof schema !== "object") return null;
  if (Array.isArray(schema.oneOf)) {
    const matches = schema.oneOf.filter((candidate) => !validateSchemaValue(value, candidate, fieldPath));
    return matches.length === 1 ? null : `field ${fieldPath} must match exactly one allowed schema`;
  }
  if (Array.isArray(schema.anyOf)) {
    const matches = schema.anyOf.some((candidate) => !validateSchemaValue(value, candidate, fieldPath));
    return matches ? null : `field ${fieldPath} does not match an allowed schema`;
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((candidate) => candidate === value)) {
    return `field ${fieldPath} has an unsupported value`;
  }
  if (schema.type) {
    const allowedTypes = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!allowedTypes.some((type) => schemaTypeMatches(value, type))) {
      return `field ${fieldPath} must be ${allowedTypes.join(" or ")}`;
    }
  }
  if (typeof value === "string") {
    if (Number.isInteger(schema.minLength) && value.length < schema.minLength) {
      return `field ${fieldPath} is shorter than the allowed minimum`;
    }
    if (Number.isInteger(schema.maxLength) && value.length > schema.maxLength) {
      return `field ${fieldPath} exceeds the allowed maximum`;
    }
    if (typeof schema.pattern === "string") {
      try {
        if (!new RegExp(schema.pattern).test(value)) return `field ${fieldPath} has an invalid format`;
      } catch (_error) {
        throw new BridgeError("Rainbond tool schema contains an invalid pattern", EXIT.TRANSPORT);
      }
    }
  }
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) {
      return `field ${fieldPath} is below the allowed minimum`;
    }
    if (typeof schema.maximum === "number" && value > schema.maximum) {
      return `field ${fieldPath} exceeds the allowed maximum`;
    }
  }
  if (Array.isArray(value)) {
    if (Number.isInteger(schema.minItems) && value.length < schema.minItems) {
      return `field ${fieldPath} has too few items`;
    }
    if (Number.isInteger(schema.maxItems) && value.length > schema.maxItems) {
      return `field ${fieldPath} has too many items`;
    }
    if (schema.items) {
      for (let index = 0; index < value.length; index += 1) {
        const error = validateSchemaValue(value[index], schema.items, `${fieldPath}[${index}]`);
        if (error) return error;
      }
    }
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const required = Array.isArray(schema.required) ? schema.required : [];
    for (const field of required) {
      if (!Object.prototype.hasOwnProperty.call(value, field)) return `missing required field: ${field}`;
    }
    const properties = schema.properties && typeof schema.properties === "object"
      ? schema.properties
      : {};
    for (const [field, item] of Object.entries(value)) {
      if (Object.prototype.hasOwnProperty.call(properties, field)) {
        const error = validateSchemaValue(item, properties[field], `${fieldPath}.${field}`);
        if (error) return error;
      } else if (schema.additionalProperties === false) {
        return `unsupported field: ${field}`;
      } else if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
        const error = validateSchemaValue(item, schema.additionalProperties, `${fieldPath}.${field}`);
        if (error) return error;
      }
    }
  }
  return null;
}

async function validateToolArguments(config, toolName, argumentsValue) {
  const tools = await listTools(config);
  const tool = tools.find((candidate) => candidate && candidate.name === toolName);
  if (!tool) throw new BridgeError("Rainbond tool was not found", EXIT.TOOL);
  if (!tool.inputSchema || typeof tool.inputSchema !== "object") {
    throw new BridgeError("Rainbond tool schema is invalid", EXIT.TRANSPORT);
  }
  const validationError = validateSchemaValue(argumentsValue, tool.inputSchema, "$input");
  if (validationError) throw new BridgeError(validationError, EXIT.USAGE);
}

function boundedContextString(value) {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 128
    && !CONTROL_CHARACTER_PATTERN.test(value)
    ? value
    : null;
}

function contextInputUsageError() {
  return new BridgeError("context input fields are invalid", EXIT.USAGE, {
    error: "context input fields are invalid",
    expected: {
      required: ["enterprise", "workspace"],
      hints: { team_name: "<team-name>" },
    },
    note: "enterprise is resolved from the current authenticated identity",
  });
}

function validateContextHints(value) {
  if (value === undefined) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BridgeError("context workspace hints are invalid", EXIT.USAGE);
  }
  const entries = Object.entries(value);
  if (entries.length === 0
    || entries.some(([field, item]) => !CONTEXT_HINT_FIELDS.has(field) || !boundedContextString(item))) {
    throw new BridgeError("context workspace hints are invalid", EXIT.USAGE);
  }
  return Object.fromEntries(entries);
}

function validateContextSelection(value) {
  if (value === undefined) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).length !== 1
    || typeof value.option_id !== "string"
    || value.option_id.length === 0
    || value.option_id.length > 300
    || CONTROL_CHARACTER_PATTERN.test(value.option_id)) {
    throw new BridgeError("context workspace selection is invalid", EXIT.USAGE);
  }
  return { option_id: value.option_id };
}

function validateContextResolveInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw contextInputUsageError();
  }
  if (Object.keys(input).some((field) => !CONTEXT_RESOLVE_FIELDS.has(field))) {
    throw contextInputUsageError();
  }
  const required = input.required;
  if (!Array.isArray(required)
    || required.some((item) => !["enterprise", "workspace"].includes(item))) {
    throw new BridgeError("context required dimensions are invalid", EXIT.USAGE);
  }

  const hints = validateContextHints(input.hints);
  const selection = validateContextSelection(input.selection);

  if ((hints || selection) && !required.includes("workspace")) {
    throw new BridgeError("context workspace input requires the workspace dimension", EXIT.USAGE);
  }
  if (hints && selection) {
    throw new BridgeError("context hints and selection are mutually exclusive", EXIT.USAGE);
  }
  return { required, hints, selection };
}

function resolvedWorkspaceContext(enterpriseId, option) {
  return {
    state: "resolved",
    context: {
      enterprise_id: enterpriseId,
      team_id: option.team_id,
      team_name: option.team_name,
      region_name: option.region_name,
    },
  };
}

function workspaceSelectionResult(enterpriseId, options) {
  return {
    state: "needs-selection",
    enterprise_id: enterpriseId,
    dimension: "workspace-region",
    options,
  };
}

async function resolveStatelessContext(input, config) {
  const { required, hints, selection } = validateContextResolveInput(input);
  const identity = await execute({
    command: "read",
    toolName: "rainbond_get_current_user",
    argumentsValue: {},
  }, config);
  const enterpriseId = boundedContextString(identity?.enterprise_id);
  if (required.includes("enterprise") && !enterpriseId) {
    return { state: "blocked", reason: "no-current-enterprise" };
  }
  if (!required.includes("workspace")) {
    return { state: "resolved", context: { enterprise_id: enterpriseId } };
  }
  const teams = await execute({
    command: "read",
    toolName: "rainbond_query_teams",
    argumentsValue: enterpriseId ? { enterprise_id: enterpriseId } : {},
  }, config);
  const options = [];
  for (const item of Array.isArray(teams?.items) ? teams.items : []) {
    const teamId = boundedContextString(item?.team_id || item?.tenant_id);
    const teamName = boundedContextString(item?.team_name || item?.tenant_name);
    const teamAlias = boundedContextString(item?.team_alias || item?.tenant_alias);
    if (!teamId || !teamName || !Array.isArray(item.region_list)) continue;
    for (const region of item.region_list) {
      const regionName = boundedContextString(region?.region_name);
      if (!regionName) continue;
      const regionLabel = boundedContextString(region.region_alias) || regionName;
      const workspaceLabel = teamAlias && teamAlias !== teamName
        ? `${teamAlias}（${teamName}）`
        : teamName;
      options.push({
        id: `${teamId}:${regionName}`,
        label: `${workspaceLabel} / ${regionLabel}`,
        team_id: teamId,
        team_name: teamName,
        region_name: regionName,
      });
      if (options.length > 256) {
        throw new BridgeError("workspace candidate set is too large", EXIT.TOOL);
      }
    }
  }
  if (options.length === 0) return { state: "blocked", reason: "no-accessible-workspace" };
  if (selection) {
    const selected = options.find((option) => option.id === selection.option_id);
    return selected
      ? resolvedWorkspaceContext(enterpriseId, selected)
      : { state: "blocked", reason: "workspace-selection-invalid" };
  }
  const matchingOptions = hints
    ? options.filter((option) => Object.entries(hints).every(([field, value]) => option[field] === value))
    : options;
  if (matchingOptions.length === 0) {
    return { state: "blocked", reason: "workspace-hint-not-found" };
  }
  if (matchingOptions.length === 1) {
    return resolvedWorkspaceContext(enterpriseId, matchingOptions[0]);
  }
  return workspaceSelectionResult(enterpriseId, matchingOptions);
}

async function execute(command, config) {
  if (command.command === "context") {
    return resolveStatelessContext(command.argumentsValue, config);
  }
  if (command.command === "package-upload") {
    return executePackageUpload(command, config);
  }
  if (command.command === "status") {
    const tools = await listTools(config);
    const cached = loadCachedCatalog(config);
    return {
      status: "ok",
      cli_version: CLI_VERSION,
      tool_count: tools.length,
      catalog_age_ms: cached ? Math.max(0, Math.round(cached.age)) : 0,
    };
  }
  if (command.command === "list") {
    const tools = await listTools(config);
    return tools
      .map((tool) => tool && tool.name)
      .filter((name) => typeof name === "string" && (!command.prefix || name.startsWith(command.prefix)));
  }
  if (command.command === "describe") {
    const tools = await listTools(config);
    const tool = tools.find((candidate) => candidate && candidate.name === command.toolName);
    if (!tool) throw new BridgeError("Rainbond tool was not found", EXIT.TOOL);
    return {
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    };
  }

  const operationClass = classifyTool(command.toolName);
  if (command.command === "read" && operationClass !== "read") {
    throw new BridgeError(
      "read is read-only and rejects tools classified as write or destructive",
      EXIT.USAGE
    );
  }
  const argumentsValue = command.argumentsValue || readArguments(command.input);
  let operation = null;
  let skillBinding = null;
  if (operationClass !== "read") {
    if (!command.skillId) {
      throw new BridgeError("mutable calls require --skill-id <active-skill-id>", EXIT.USAGE);
    }
    skillBinding = loadSkillBinding(config, command.skillId, command.rootSkillId);
    if (!command.confirmation) {
      await validateToolArguments(config, command.toolName, argumentsValue);
      operation = prepareOperation(
        config,
        command.toolName,
        operationClass,
        argumentsValue,
        skillBinding
      );
      return {
        requires_confirmation: true,
        confirmation_id: operation.operation_id,
        operation_class: operation.operation_class,
        summary: "Review the target and repeat this exact call with --confirm <operation_id> to execute it once.",
      };
    }
    operation = confirmOperation(
      config,
      command.confirmation,
      command.toolName,
      operationClass,
      argumentsValue,
      skillBinding
    );
  }

  try {
    const params = {
      name: command.toolName,
      arguments: argumentsValue,
    };
    if (operation) {
      params._meta = {
        "com.rainbond/rainskills": buildAuditMetadata(operation, skillBinding),
      };
    }
    const result = await rpcRequest(config, "tools/call", params);
    if (!result || typeof result !== "object") {
      throw new BridgeError("Rainbond tool result is invalid", EXIT.TRANSPORT);
    }
    if (result.isError) {
      const statusCode = result.structuredContent && (
        result.structuredContent.status_code || result.structuredContent.error_code
      );
      throw new BridgeError(
        "Rainbond tool call failed",
        statusCode === 401 || statusCode === 403 ? EXIT.CONFIG : EXIT.TOOL,
        result.structuredContent || { error: "tool call failed" }
      );
    }
    if (!("structuredContent" in result)) {
      throw new BridgeError("Rainbond tool response lacks structuredContent", EXIT.TRANSPORT);
    }
    if (operation) updateOperation(config, operation, "succeeded");
    return fitOutput(sanitizeToolResult(result.structuredContent));
  } catch (error) {
    if (operation) {
      updateOperation(config, operation, error.exitCode === EXIT.TRANSPORT ? "unknown" : "failed");
    }
    throw error;
  }
}

async function main(args = process.argv.slice(2)) {
  let config;
  let command;
  let argumentRedactions = [];
  try {
    command = parseCommand(args);
    if (["read", "call", "package-upload", "query", "context"].includes(command.command)) {
      const argumentsValue = readArguments(command.input);
      command.argumentsValue = argumentsValue;
      argumentRedactions = collectArgumentRedactions(argumentsValue);
    }
    if (command.command === "query") {
      config = loadConfig({ includeRuntime: true });
      command.argumentsValue = await resolvePlatformQueryArguments(
        command.toolName,
        command.argumentsValue,
        config
      );
      platformQueryIntent(command.toolName, command.argumentsValue);
      command = {
        command: "read",
        toolName: command.toolName,
        argumentsValue: command.argumentsValue,
      };
      if (config.isInsecureHttp) {
        process.stderr.write('{"warning":"using insecure HTTP transport"}\n');
      }
      const output = await execute(command, config);
      process.stdout.write(`${JSON.stringify(fitOutput(output))}\n`);
      return;
    }
    config = loadConfig({
      includeRuntime: true,
    });
    if (config.isInsecureHttp) {
      process.stderr.write('{"warning":"using insecure HTTP transport"}\n');
    }
    const output = await execute(command, config);
    process.stdout.write(`${JSON.stringify(fitOutput(output))}\n`);
  } catch (error) {
    const bridgeError = error instanceof BridgeError
      ? error
      : new BridgeError("unexpected API bridge error", EXIT.TRANSPORT);
    const secrets = [config && config.jwt, config && config.baseUrl, ...argumentRedactions];
    const output = bridgeError.payload || { error: bridgeError.message };
    process.stderr.write(`${safeJson(output, secrets)}\n`);
    process.exitCode = bridgeError.exitCode;
  }
}

module.exports = {
  REQUEST_TIMEOUT_MS,
  INPUT_MAX_BYTES,
  RESPONSE_MAX_BYTES,
  STDOUT_MAX_BYTES,
  CATALOG_TTL_MS,
  CLI_VERSION,
  loadConfig,
  executePackageUpload,
  packageUploadEnvironment,
  parseCommand,
  platformQueryIntent,
  rpcRequest,
  validateSchemaValue,
  validateToolArguments,
  validatePackageUploadRequest,
};

if (require.main === module) {
  main();
}
