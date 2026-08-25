"use strict";

const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { looksLikeJwt } = require("./windows-auth.js");

const MAX_MISSING_ROUTE_BODY_BYTES = 64 * 1024;

function normalizeBaseUrl(value) {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("Rainbond Console 地址必须是无凭据的 HTTP(S) URL");
  }
  url.search = "";
  url.hash = "";
  url.pathname = url.pathname.replace(/\/$/, "");
  return url.toString().replace(/\/$/, "");
}

async function readBoundedResponseText(response) {
  const declaredLength = Number(response.headers?.get?.("content-length") || 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_MISSING_ROUTE_BODY_BYTES) return null;
  if (!response.body?.getReader) {
    const text = await response.text();
    return Buffer.byteLength(text, "utf8") <= MAX_MISSING_ROUTE_BODY_BYTES ? text : null;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_MISSING_ROUTE_BODY_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function isVerifiedMissingMcpRoute(response) {
  if (response.status !== 404) return false;
  const contentType = String(response.headers?.get?.("content-type") || "").toLowerCase();
  const body = await readBoundedResponseText(response);
  if (body === null) return false;
  const trimmed = body.trim();
  if (contentType.includes("text/plain")) return trimmed === "Not Found";
  if (contentType.includes("text/html")) {
    const lower = trimmed.toLowerCase();
    return lower.includes("<title") && lower.includes("not found");
  }
  if (contentType.includes("json")) {
    try {
      const payload = JSON.parse(trimmed);
      return payload && typeof payload === "object" && !Array.isArray(payload)
        && [payload.code, payload.status, payload.status_code, payload.error_code].some(
          (value) => value === 404 || value === "404"
        );
    } catch {
      return false;
    }
  }
  return false;
}

async function validateMcp({ url, token, fetchImpl = globalThis.fetch }) {
  if (!looksLikeJwt(token)) throw new Error("Rainbond JWT 格式无效");
  const response = await fetchImpl(url, {
    method: "POST",
    redirect: "manual",
    headers: {
      accept: "application/json",
      Authorization: `GRJWT ${token}`,
      "content-type": "application/json",
      "mcp-protocol-version": "2025-03-26",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {},
    }),
  });
  const location = response.headers?.get?.("location");
  const hasLocation = typeof response.headers?.has === "function"
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
      expected = new URL(url);
    } catch {
      throw new Error("Rainbond MCP endpoint 响应地址无效");
    }
    if (observed.href !== expected.href) {
      throw new Error("Rainbond MCP endpoint 响应地址不匹配");
    }
  }
  if (!response.ok) {
    const error = new Error(`Rainbond MCP 校验失败，HTTP ${response.status}`);
    if (await isVerifiedMissingMcpRoute(response)) error.code = "MCP_ENDPOINT_UNSUPPORTED";
    throw error;
  }
  const payload = await response.json();
  if (payload?.result?.serverInfo?.name !== "rainbond-console-mcp") {
    throw new Error("Rainbond MCP 校验返回了无法识别的响应");
  }
  const renewed = response.headers.get("x-renewed-token");
  return { token: looksLikeJwt(renewed) ? renewed : token };
}

function checkedSpawn(spawnImpl, command, args, options) {
  const result = spawnImpl(command, args, options);
  if (result.error) {
    if (result.error.code === "ENOENT") throw new Error(`未找到所选客户端命令：${command}`);
    throw result.error;
  }
  if (result.signal) throw new Error(`${command} 被信号 ${result.signal} 中断`);
  if (result.status !== 0) throw new Error(`${command} 配置失败，退出码 ${result.status}`);
}

function persistWindowsEnvironment({
  token,
  baseUrl,
  spawnImpl = spawnSync,
  helperPath = path.join(__dirname, "windows-client-config.ps1"),
}) {
  if (!looksLikeJwt(token)) throw new Error("Rainbond JWT 格式无效");
  const normalizedBase = normalizeBaseUrl(baseUrl);
  const environment = {
    ...process.env,
    RAINSKILLS_RAINBOND_JWT: token,
    RAINSKILLS_RAINBOND_URL: normalizedBase,
  };
  checkedSpawn(spawnImpl, "powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-File",
    helperPath,
  ], {
    encoding: "utf8",
    env: environment,
    windowsHide: true,
  });
  process.env.RAINBOND_JWT = token;
  process.env.RAINBOND_URL = normalizedBase;
}

module.exports = {
  isVerifiedMissingMcpRoute,
  persistWindowsEnvironment,
  validateMcp,
};
