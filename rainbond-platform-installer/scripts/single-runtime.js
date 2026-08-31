"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { normalizeConsoleOrigin } = require("./console-origin.js");
const { createSecureStateStore } = require("./secure-state.js");
const { looksLikeJwt } = require("./windows-auth.js");

const SINGLE_RUNTIME_SCHEMA = "rainskills.single-runtime.v1";
const KINDS = new Set(["saas", "private"]);
const FIELDS = new Set([
  "schema", "version", "console_origin", "kind", "token",
  "allow_insecure_http", "created_at", "updated_at",
]);
const MAX_BYTES = 16384;

function isIsoTimestamp(value) {
  return typeof value === "string"
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)
    && !Number.isNaN(Date.parse(value));
}

function validateSingleRuntime(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("单运行环境记录无效");
  }
  for (const field of Object.keys(input)) {
    if (!FIELDS.has(field)) throw new Error(`单运行环境记录包含未知字段：${field}`);
  }
  if (
    Object.keys(input).length !== FIELDS.size
    || input.schema !== SINGLE_RUNTIME_SCHEMA
    || input.version !== 1
    || !KINDS.has(input.kind)
    || typeof input.allow_insecure_http !== "boolean"
    || !looksLikeJwt(input.token)
    || !isIsoTimestamp(input.created_at)
    || !isIsoTimestamp(input.updated_at)
  ) {
    throw new Error("单运行环境记录 schema 无效");
  }
  const origin = normalizeConsoleOrigin(input.console_origin);
  if (origin.startsWith("http://") && !input.allow_insecure_http) {
    throw new Error("明文 HTTP 运行环境必须显式允许不安全传输");
  }
  return {
    schema: SINGLE_RUNTIME_SCHEMA,
    version: 1,
    console_origin: origin,
    kind: input.kind,
    token: input.token,
    allow_insecure_http: input.allow_insecure_http,
    created_at: input.created_at,
    updated_at: input.updated_at,
  };
}

function createSingleRuntimeStore({
  platform = process.platform,
  home = os.homedir(),
  stateStore = createSecureStateStore({ platform, home }),
  now = () => new Date().toISOString(),
} = {}) {
  const runtimePath = path.join(home, ".rainbond", "rainskills", "single-runtime-v1.json");

  function read() {
    if (!fs.existsSync(runtimePath)) return null;
    stateStore.assertProtectedRegularFile(runtimePath);
    if (fs.lstatSync(runtimePath).size > MAX_BYTES) {
      throw new Error("单运行环境记录文件过大");
    }
    return validateSingleRuntime(stateStore.readProtectedJson(runtimePath));
  }

  function write({
    consoleOrigin,
    kind,
    token,
    allowInsecureHttp = false,
  } = {}) {
    if (fs.existsSync(runtimePath)) stateStore.assertProtectedRegularFile(runtimePath);
    const current = read();
    const timestamp = now();
    const value = validateSingleRuntime({
      schema: SINGLE_RUNTIME_SCHEMA,
      version: 1,
      console_origin: consoleOrigin,
      kind,
      token,
      allow_insecure_http: allowInsecureHttp,
      created_at: current?.created_at || timestamp,
      updated_at: timestamp,
    });
    stateStore.atomicWriteJson(runtimePath, value);
    return value;
  }

  function remove() {
    if (!fs.existsSync(runtimePath)) return false;
    stateStore.assertProtectedRegularFile(runtimePath);
    fs.unlinkSync(runtimePath);
    return true;
  }

  return { path: runtimePath, read, remove, write };
}

module.exports = {
  SINGLE_RUNTIME_SCHEMA,
  createSingleRuntimeStore,
  validateSingleRuntime,
};
