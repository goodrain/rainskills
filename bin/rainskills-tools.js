#!/usr/bin/env node

const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const os = require("node:os");
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");

const REQUEST_TIMEOUT_MS = 180_000;
const INPUT_MAX_BYTES = 1024 * 1024;
const RESPONSE_MAX_BYTES = 10 * 1024 * 1024;
const STDOUT_MAX_BYTES = 128 * 1024;
const CATALOG_TTL_MS = 5 * 60 * 1000;
const PROTOCOL_VERSION = "2025-03-26";
const ENDPOINT_PATH = "/console/mcp/rainskills/api/query";
const CLI_VERSION = "2.2.0";
const CONFIG_DIRECTORY = ".rainbond";
const CREDENTIALS_FILENAME = "credentials.env";
const LEGACY_CREDENTIALS_FILENAME = "mcp.env";
const CATALOG_FILENAME = "capabilities.json";
const OPERATIONS_DIRECTORY = "operations";
const SKILL_MANIFEST_FILENAME = "rainskills-skill-manifest.json";
const OPERATION_ID_PATTERN = /^[a-f0-9]{8}-[a-f0-9-]{27,}$/;
const SKILL_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const SKILL_CONTENT_MAX_BYTES = 128 * 1024;
const SKILL_MANIFEST_MAX_BYTES = 4 * 1024 * 1024;
const SENSITIVE_RESPONSE_KEY_PATTERN = /(?:authorization|jwt|token|password|secret|credential|private[_-]?key|key[_-]?file|certificate|cert[_-]?file|ssl[_-]?ca[_-]?cert)/i;
const RISK_POLICY = Object.freeze({
  version: "2",
  readPrefixes: [
    "rainbond_query_", "rainbond_get_", "rainbond_list_",
    "rainbond_describe_", "rainbond_validate_", "rainbond_verify_", "rainbond_search_",
  ],
  destructiveFragments: ["delete", "remove", "purge", "destroy"],
  writeTools: [
    "rainbond_exec",
    "rainbond_get_component_check_result",
    "rainbond_get_yaml_app_check_result",
  ],
  mixedReadOperations: {
    rainbond_manage_component_envs: ["summary", "list", "view"],
    rainbond_manage_component_connection_envs: ["summary", "list", "view"],
    rainbond_manage_component_ports: ["summary", "list", "view"],
    rainbond_manage_component_storage: [
      "summary", "list", "view", "list_unmounted", "list_available_mounts",
    ],
    rainbond_manage_component_autoscaler: [
      "summary", "list", "view", "get_rule", "detail", "records", "history", "logs",
    ],
    rainbond_manage_component_probe: ["summary", "list", "view", "get", "detail"],
    rainbond_manage_component_dependency: ["summary", "list", "view"],
  },
});

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

function parseShellValue(value) {
  let offset = 0;
  let result = "";
  while (offset < value.length) {
    const quote = value[offset];
    if (quote === "'") {
      const end = value.indexOf("'", offset + 1);
      if (end === -1) return null;
      result += value.slice(offset + 1, end);
      offset = end + 1;
      continue;
    }
    if (quote === '"') {
      const end = value.indexOf('"', offset + 1);
      if (end === -1) return null;
      result += value.slice(offset + 1, end).replace(/\\([\\"$`])/g, "$1");
      offset = end + 1;
      continue;
    }
    const match = value.slice(offset).match(/^[^\s'"#]+/);
    if (!match) return null;
    result += match[0];
    offset += match[0].length;
  }
  return result;
}

function parseEnvFile(contents) {
  const values = {};
  for (const line of contents.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?(RAINBOND_URL|RAINBOND_JWT|RAINBOND_ALLOW_INSECURE_HTTP)\s*=\s*(.*?)\s*$/);
    if (!match) continue;
    const parsed = parseShellValue(match[2]);
    if (parsed !== null) values[match[1]] = parsed;
  }
  return values;
}

function readPrivateEnvFile(configPath) {
  let stat;
  try {
    stat = fs.lstatSync(configPath);
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw new BridgeError("unable to inspect Rainbond configuration", EXIT.CONFIG);
  }
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
    throw new BridgeError("Rainbond configuration must be a private regular file", EXIT.CONFIG);
  }
  try {
    return parseEnvFile(fs.readFileSync(configPath, "utf8"));
  } catch (_error) {
    throw new BridgeError("unable to read Rainbond configuration", EXIT.CONFIG);
  }
}

function loadConfig({ env = process.env, homeDir = os.homedir(), includeRuntime = false } = {}) {
  const configDirectory = path.join(homeDir, CONFIG_DIRECTORY);
  const credentialsPath = path.join(configDirectory, CREDENTIALS_FILENAME);
  const legacyCredentialsPath = path.join(configDirectory, LEGACY_CREDENTIALS_FILENAME);
  const fileValues = readPrivateEnvFile(credentialsPath);
  const legacyValues = Object.keys(fileValues).length === 0
    ? readPrivateEnvFile(legacyCredentialsPath)
    : {};

  const baseUrl = env.RAINBOND_URL || fileValues.RAINBOND_URL || legacyValues.RAINBOND_URL;
  const jwt = env.RAINBOND_JWT || fileValues.RAINBOND_JWT || legacyValues.RAINBOND_JWT;
  if (!baseUrl || !jwt) {
    throw new BridgeError("RAINBOND_URL and RAINBOND_JWT are required", EXIT.CONFIG);
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
  const allowInsecureHttp = (env.RAINBOND_ALLOW_INSECURE_HTTP ||
    fileValues.RAINBOND_ALLOW_INSECURE_HTTP ||
    legacyValues.RAINBOND_ALLOW_INSECURE_HTTP) === "true";
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
  const command = args[0];
  if (command === "status" && args.length === 1) return { command };
  if (command === "list") {
    if (args.length === 1) return { command };
    if (args.length === 3 && args[1] === "--prefix" && args[2]) {
      return { command, prefix: args[2] };
    }
  }
  if (command === "describe" && args.length === 2 && args[1]) {
    return { command, toolName: args[1] };
  }
  if (command === "read" && args.length === 4 && args[1] && args[2] === "--input" && args[3] === "-") {
    return { command, toolName: args[1], input: args[3] };
  }
  if (command === "call" && args.length >= 4 && args[1] && args[2] === "--input" && args[3] === "-") {
    const parsed = { command, toolName: args[1], input: args[3] };
    if (args.length === 4) return parsed;
    const allowed = new Set(["--confirm", "--skill-id", "--root-skill-id"]);
    for (let index = 4; index < args.length; index += 2) {
      const option = args[index];
      const value = args[index + 1];
      if (!allowed.has(option) || !value || value.startsWith("--")) break;
      if (option === "--confirm" && !parsed.confirmation && OPERATION_ID_PATTERN.test(value)) {
        parsed.confirmation = value;
      } else if (option === "--skill-id" && !parsed.skillId && SKILL_ID_PATTERN.test(value)) {
        parsed.skillId = value;
      } else if (option === "--root-skill-id" && !parsed.rootSkillId && SKILL_ID_PATTERN.test(value)) {
        parsed.rootSkillId = value;
      } else {
        break;
      }
      if (index + 2 === args.length) return parsed;
    }
  }
  throw new BridgeError("invalid command; use status, list, describe, read, or call", EXIT.USAGE);
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
  let info;
  let manifest;
  try {
    info = fs.lstatSync(target);
    if (!info.isFile() || info.isSymbolicLink() ||
      (process.platform !== "win32" && (info.mode & 0o077) !== 0) ||
      info.size > SKILL_MANIFEST_MAX_BYTES) {
      throw new Error("unsafe manifest");
    }
    manifest = JSON.parse(fs.readFileSync(target, "utf8"));
  } catch (_error) {
    throw new BridgeError("RainSkills Skill manifest is missing or unsafe", EXIT.CONFIG);
  }
  if (!manifest || manifest.schema !== "rainskills.skill-manifest.v1" || manifest.profile !== "cli" ||
    typeof manifest.package_version !== "string" || !manifest.package_version || !Array.isArray(manifest.skills)) {
    throw new BridgeError("RainSkills Skill manifest schema is incompatible", EXIT.CONFIG);
  }
  const entry = manifest.skills.find((candidate) => candidate && candidate.id === skillId);
  if (!entry || entry.profile !== "cli" || entry.package_version !== manifest.package_version ||
    typeof entry.content !== "string" || Buffer.byteLength(entry.content, "utf8") > SKILL_CONTENT_MAX_BYTES ||
    !SHA256_PATTERN.test(entry.content_sha256) || !SHA256_PATTERN.test(entry.bundle_sha256) ||
    createHash("sha256").update(entry.content, "utf8").digest("hex") !== entry.content_sha256 ||
    (entry.source_revision !== null && entry.source_revision !== undefined &&
      (typeof entry.source_revision !== "string" || !entry.source_revision || entry.source_revision.length > 128))) {
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

function classifyTool(toolName, argumentsValue = {}) {
  const normalized = String(toolName || "").toLowerCase();
  const operation = typeof argumentsValue.operation === "string"
    ? argumentsValue.operation.trim().toLowerCase()
    : typeof argumentsValue.action === "string"
      ? argumentsValue.action.trim().toLowerCase()
      : "";
  if (RISK_POLICY.destructiveFragments.some(
    (fragment) => normalized.includes(fragment) || operation.includes(fragment)
  )) {
    return "destructive";
  }
  const readOperations = RISK_POLICY.mixedReadOperations[normalized];
  if (readOperations && readOperations.includes(operation)) return "read";
  if (RISK_POLICY.writeTools.includes(normalized)) return "write";
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
    record.skill_source_revision !== skillBinding.sourceRevision ||
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

function sanitizeToolResult(value) {
  if (Array.isArray(value)) return value.map(sanitizeToolResult);
  if (!value || typeof value !== "object") return value;
  const safe = {};
  for (const [key, item] of Object.entries(value)) {
    // Console destructive operations may return this one-time control value.
    // It is not a credential and must remain available for the confirmation flow.
    if (key !== "confirmation_token" && SENSITIVE_RESPONSE_KEY_PATTERN.test(key)) continue;
    safe[key] = sanitizeToolResult(item);
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

function rpcRequest(config, method, params = {}, {
  timeoutMs = REQUEST_TIMEOUT_MS,
  maxResponseBytes = RESPONSE_MAX_BYTES,
} = {}) {
  const endpoint = new URL(`${config.baseUrl.replace(/\/+$/, "")}${ENDPOINT_PATH}`);
  const payload = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method,
    params,
  });
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
        if (response.statusCode === 401 || response.statusCode === 403) {
          fail(new BridgeError("Rainbond authentication failed", EXIT.CONFIG));
          return;
        }
        if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
          fail(new BridgeError(
            response.statusCode === 404
              ? "Rainskills API endpoint is unavailable; upgrade Rainbond Console"
              : "Rainbond API request failed",
            EXIT.TRANSPORT
          ));
          return;
        }
        let rpc;
        try {
          rpc = JSON.parse(body);
        } catch (_error) {
          fail(new BridgeError("Rainbond returned invalid JSON", EXIT.TRANSPORT));
          return;
        }
        if (!rpc || rpc.jsonrpc !== "2.0" || rpc.id !== 1) {
          fail(new BridgeError("Rainbond returned an invalid JSON-RPC response", EXIT.TRANSPORT));
          return;
        }
        if (rpc.error) {
          const protocolErrors = new Set([-32700, -32600, -32601]);
          fail(new BridgeError(
            "Rainbond rejected the tool request",
            protocolErrors.has(rpc.error.code) ? EXIT.TRANSPORT : EXIT.TOOL,
            {
            code: rpc.error.code,
            message: rpc.error.message,
            }
          ));
          return;
        }
        if (!("result" in rpc)) {
          fail(new BridgeError("Rainbond JSON-RPC result is missing", EXIT.TRANSPORT));
          return;
        }
        settle(resolve, rpc.result);
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

async function execute(command, config) {
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

  const argumentsValue = command.argumentsValue || readArguments(command.input);
  const operationClass = classifyTool(command.toolName, argumentsValue);
  if (command.command === "read" && operationClass !== "read") {
    throw new BridgeError(
      "read is read-only and rejects tools classified as write or destructive",
      EXIT.USAGE
    );
  }
  let operation = null;
  let skillBinding = null;
  if (operationClass !== "read") {
    if (!command.skillId) {
      throw new BridgeError("mutable calls require --skill-id <active-skill-id>", EXIT.USAGE);
    }
    skillBinding = loadSkillBinding(config, command.skillId, command.rootSkillId);
    if (!command.confirmation) {
      operation = prepareOperation(
        config,
        command.toolName,
        operationClass,
        argumentsValue,
        skillBinding
      );
      return {
        requires_confirmation: true,
        operation_id: operation.operation_id,
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
    if (command.command === "read" || command.command === "call") {
      const argumentsValue = readArguments(command.input);
      command.argumentsValue = argumentsValue;
      argumentRedactions = collectArgumentRedactions(argumentsValue);
    }
    config = loadConfig({ includeRuntime: true });
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
  parseEnvFile,
  parseCommand,
  classifyTool,
  rpcRequest,
};

if (require.main === module) {
  main();
}
