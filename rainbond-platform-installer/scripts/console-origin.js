"use strict";

const net = require("node:net");

const MAX_ORIGIN_LENGTH = 2048;
const MAX_REDIRECT_HOPS = 4;
const CONTROL_PATTERN = /[\u0000-\u001f\u007f-\u009f]/u;

function normalizeConsoleOrigin(value) {
  if (
    typeof value !== "string"
    || !value
    || value.length > MAX_ORIGIN_LENGTH
    || value.trim() !== value
    || CONTROL_PATTERN.test(value)
  ) {
    throw new Error("Rainbond Console 地址必须是规范的 HTTP/HTTPS origin");
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Rainbond Console 地址必须是规范的 HTTP/HTTPS origin");
  }
  if (
    !["http:", "https:"].includes(parsed.protocol)
    || parsed.username
    || parsed.password
    || parsed.pathname !== "/"
    || parsed.search
    || parsed.hash
  ) {
    throw new Error("Rainbond Console 地址必须是规范的 HTTP/HTTPS origin");
  }
  return parsed.origin;
}

function normalizedHostname(origin) {
  return new URL(origin).hostname.toLowerCase().replace(/^\[|\]$/g, "");
}

function isLoopbackAddress(hostname) {
  if (hostname === "localhost" || hostname.endsWith(".localhost")) return true;
  if (net.isIP(hostname) === 6) return hostname === "::1";
  if (net.isIP(hostname) !== 4) return false;
  return Number(hostname.split(".", 1)[0]) === 127;
}

function isManagedPrivateAddress(hostname) {
  if (net.isIP(hostname) === 6) return hostname.startsWith("fc") || hostname.startsWith("fd");
  if (net.isIP(hostname) !== 4) return false;
  const octets = hostname.split(".").map(Number);
  return octets[0] === 10
    || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
    || (octets[0] === 192 && octets[1] === 168);
}

function classifyHttpOrigin(value) {
  const origin = normalizeConsoleOrigin(value);
  const isHttp = origin.startsWith("http://");
  if (!isHttp) {
    return {
      isHttp: false,
      isLoopback: false,
      isManagedPrivate: false,
      confirmationRequired: false,
    };
  }
  const hostname = normalizedHostname(origin);
  const isLoopback = isLoopbackAddress(hostname);
  const isManagedPrivate = !isLoopback && isManagedPrivateAddress(hostname);
  return {
    isHttp,
    isLoopback,
    isManagedPrivate,
    confirmationRequired: !isLoopback && !isManagedPrivate,
  };
}

function redirectLocation(response, currentUrl) {
  if (response.status < 300 || response.status >= 400) return null;
  const location = response.headers?.get?.("location");
  if (!location) throw new Error("Rainbond Console 返回了无效重定向");
  let target;
  try {
    target = new URL(location, currentUrl);
  } catch {
    throw new Error("Rainbond Console 返回了无效重定向");
  }
  if (!["http:", "https:"].includes(target.protocol) || target.username || target.password) {
    throw new Error("Rainbond Console 返回了不安全重定向");
  }
  return target;
}

async function inspectConsoleOrigin(value, {
  fetchImpl = globalThis.fetch,
  maxRedirectHops = MAX_REDIRECT_HOPS,
} = {}) {
  const origin = normalizeConsoleOrigin(value);
  if (typeof fetchImpl !== "function") throw new Error("当前环境无法检查 Rainbond Console 连接");
  if (!Number.isInteger(maxRedirectHops) || maxRedirectHops < 0 || maxRedirectHops > MAX_REDIRECT_HOPS) {
    throw new Error("Rainbond Console 重定向策略无效");
  }
  let currentUrl = `${origin}/`;
  try {
    for (let hop = 0; hop <= maxRedirectHops; hop += 1) {
      const response = await fetchImpl(currentUrl, {
        method: "HEAD",
        redirect: "manual",
        signal: typeof AbortSignal?.timeout === "function" ? AbortSignal.timeout(10000) : undefined,
      });
      if (response.url) {
        let observed;
        try {
          observed = new URL(response.url).href;
        } catch {
          throw new Error("Rainbond Console 响应地址无效");
        }
        if (observed !== currentUrl) {
          throw new Error("Rainbond Console 响应地址发生了未授权重定向");
        }
      }
      const target = redirectLocation(response, currentUrl);
      if (!target) {
        return {
          origin,
          httpConfirmationRequired: classifyHttpOrigin(origin).confirmationRequired,
          pendingRedirectOrigin: null,
        };
      }
      if (target.origin !== origin) {
        return {
          origin,
          httpConfirmationRequired: classifyHttpOrigin(origin).confirmationRequired,
          pendingRedirectOrigin: target.origin,
        };
      }
      if (hop === maxRedirectHops) throw new Error("Rainbond Console 重定向次数超过安全上限");
      currentUrl = target.href;
    }
  } catch (error) {
    if (/^Rainbond Console/.test(error.message)) throw error;
    if (origin.startsWith("https://")) {
      throw new Error("无法安全验证 Rainbond Console HTTPS/TLS 连接");
    }
    throw new Error("无法验证 Rainbond Console 连接");
  }
  throw new Error("无法验证 Rainbond Console 连接");
}

module.exports = {
  MAX_REDIRECT_HOPS,
  classifyHttpOrigin,
  inspectConsoleOrigin,
  isLoopbackAddress,
  isManagedPrivateAddress,
  normalizeConsoleOrigin,
};
