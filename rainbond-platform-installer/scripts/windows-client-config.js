"use strict";

const os = require("node:os");
const { looksLikeJwt } = require("./windows-auth.js");

const MAX_MISSING_ROUTE_BODY_BYTES = 64 * 1024;
const MCP_VALIDATION_TIMEOUT_MS = 30_000;

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

async function validateMcp({
  url,
  token,
  fetchImpl = globalThis.fetch,
  timeoutMs = MCP_VALIDATION_TIMEOUT_MS,
}) {
  if (!looksLikeJwt(token)) throw new Error("Rainbond JWT 格式无效");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MCP_VALIDATION_TIMEOUT_MS) {
    throw new Error("Rainbond MCP 校验超时参数无效");
  }
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      redirect: "manual",
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
  } catch (error) {
    if (timedOut) throw new Error("Rainbond MCP 校验超时，请检查 Console 连接后重试。");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = {
  MCP_VALIDATION_TIMEOUT_MS,
  isVerifiedMissingMcpRoute,
  validateMcp,
};
