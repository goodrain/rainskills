"use strict";

const crypto = require("node:crypto");
const http = require("node:http");
const path = require("node:path");
const { spawn } = require("node:child_process");

const JWT_PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const USER_CODE_PATTERN = /^[23456789BCDFGHJKMNPQRTVWXY]{4}-[23456789BCDFGHJKMNPQRTVWXY]{4}$/;

function looksLikeJwt(value) {
  return JWT_PATTERN.test(String(value || ""));
}

function normalizedBaseUrl(value) {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("Rainbond Console 地址必须是无凭据的 HTTP(S) URL");
  }
  url.hash = "";
  url.search = "";
  url.pathname = url.pathname.replace(/\/$/, "");
  return url.toString().replace(/\/$/, "");
}

function responseHtml(success) {
  const title = success ? "Rainbond CLI 授权完成" : "Rainbond CLI 授权失败";
  const detail = success ? "授权完成，请回到终端继续。" : "授权校验失败，请回到终端重试。";
  return `<!doctype html><meta charset="utf-8"><title>${title}</title><p>${detail}</p>`;
}

function authorizeWithLoopback({
  baseUrl,
  openBrowser,
  timeoutMs = 600000,
  signal,
  logger = () => {},
}) {
  if (typeof openBrowser !== "function") throw new Error("缺少浏览器打开器");
  const normalizedBase = normalizedBaseUrl(baseUrl);
  const expectedState = crypto.randomBytes(24).toString("base64url");

  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;

    function settle(error, token) {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", abort);
      server.close();
      if (typeof server.closeAllConnections === "function") server.closeAllConnections();
      if (error) reject(error);
      else resolve(token);
    }

    function abort() {
      settle(new Error("Rainbond 浏览器授权已取消"));
    }

    function writeResponse(request, response, status, success) {
      const headers = {
        "access-control-allow-headers": "content-type",
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-allow-origin": request.headers.origin || "*",
        "content-type": "text/html; charset=utf-8",
        vary: "Origin",
      };
      if (request.headers["access-control-request-private-network"] === "true") {
        headers["access-control-allow-private-network"] = "true";
      }
      response.writeHead(status, headers);
      response.end(responseHtml(success));
    }

    function handleCallback(request, params, response) {
      if (params.state !== expectedState) {
        writeResponse(request, response, 400, false);
        settle(new Error("Rainbond 浏览器授权回调 state 不匹配"));
        return;
      }
      if (!looksLikeJwt(params.token)) {
        writeResponse(request, response, 400, false);
        settle(new Error("Rainbond 浏览器授权回调没有返回合法 JWT"));
        return;
      }
      writeResponse(request, response, 200, true);
      settle(null, params.token);
    }

    const server = http.createServer((request, response) => {
      const requestUrl = new URL(request.url, "http://127.0.0.1");
      if (request.method === "OPTIONS") {
        writeResponse(request, response, 204, true);
        return;
      }
      if (requestUrl.pathname !== "/cli-callback") {
        writeResponse(request, response, 404, false);
        return;
      }
      if (request.method === "GET") {
        handleCallback(request, {
          state: requestUrl.searchParams.get("state"),
          token: requestUrl.searchParams.get("token"),
        }, response);
        return;
      }
      if (request.method !== "POST") {
        writeResponse(request, response, 405, false);
        return;
      }

      let raw = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        raw += chunk;
        if (raw.length > 16384) request.destroy();
      });
      request.on("end", () => {
        try {
          const payload = JSON.parse(raw || "{}");
          handleCallback(request, { state: payload.state, token: payload.token }, response);
        } catch {
          writeResponse(request, response, 400, false);
          settle(new Error("Rainbond 浏览器授权回调不是合法 JSON"));
        }
      });
    });

    server.on("error", (error) => settle(new Error(`无法启动本地授权回调：${error.message}`)));
    if (signal?.aborted) {
      abort();
      return;
    }
    if (signal) signal.addEventListener("abort", abort, { once: true });
    timer = setTimeout(() => settle(new Error("Rainbond 浏览器授权超时")), timeoutMs);
    server.listen(0, "127.0.0.1", async () => {
      const address = server.address();
      const callback = `http://127.0.0.1:${address.port}/cli-callback`;
      const query = new URLSearchParams({ callback, state: expectedState });
      const authorizationUrl = `${normalizedBase}/#/cli-auth?${query.toString()}`;
      try {
        logger(`授权地址：${authorizationUrl}`);
        await openBrowser(authorizationUrl);
      } catch (error) {
        settle(new Error(`无法打开 Rainbond 授权页面：${error.message}`));
      }
    });
  });
}

function abortIfNeeded(signal) {
  if (signal?.aborted) throw new Error("Rainbond 设备授权已取消");
}

async function jsonResponse(response) {
  try {
    return await response.json();
  } catch {
    throw new Error("Rainbond Device Flow 返回了无效 JSON");
  }
}

async function authorizeWithDeviceFlow({
  baseUrl,
  openBrowser = () => {},
  fetchImpl = globalThis.fetch,
  sleep = (seconds) => new Promise((resolve) => setTimeout(resolve, seconds * 1000)),
  now = () => Math.floor(Date.now() / 1000),
  signal,
  logger = () => {},
}) {
  const normalizedBase = normalizedBaseUrl(baseUrl);
  abortIfNeeded(signal);
  const codeResponse = await fetchImpl(`${normalizedBase}/console/mcp/device/code`, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ client_id: "rainskills", scope: "mcp" }).toString(),
    signal,
  });
  if (codeResponse.status === 404) {
    const error = new Error("当前 Rainbond Console 不支持 Device Flow");
    error.code = "DEVICE_FLOW_UNSUPPORTED";
    throw error;
  }
  if (!codeResponse.ok) throw new Error(`Rainbond Device Flow 初始化失败（HTTP ${codeResponse.status}）`);
  const authorization = await jsonResponse(codeResponse);
  if (
    typeof authorization.device_code !== "string"
    || !USER_CODE_PATTERN.test(authorization.user_code || "")
    || !Number.isInteger(authorization.expires_in)
    || authorization.expires_in <= 0
    || !Number.isInteger(authorization.interval)
    || authorization.interval <= 0
  ) {
    throw new Error("Rainbond Device Flow 返回了无效响应");
  }

  const verificationUrl = `${normalizedBase}/#/device?${new URLSearchParams({
    user_code: authorization.user_code,
  }).toString()}`;
  logger(`授权码：${authorization.user_code}`);
  logger(`授权地址：${verificationUrl}`);
  await openBrowser(verificationUrl);
  const startedAt = now();
  const deadline = startedAt + authorization.expires_in;
  let interval = authorization.interval;

  for (;;) {
    abortIfNeeded(signal);
    await sleep(interval);
    abortIfNeeded(signal);
    if (now() >= deadline) throw new Error("Rainbond 设备授权超时");
    let response;
    try {
      response = await fetchImpl(`${normalizedBase}/console/mcp/device/token`, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          client_id: "rainskills",
          device_code: authorization.device_code,
        }).toString(),
        signal,
      });
    } catch (error) {
      if (signal?.aborted) abortIfNeeded(signal);
      interval = Math.min(interval * 2, 30);
      continue;
    }
    const payload = await jsonResponse(response);
    if (response.ok) {
      if (payload.token_type !== "Bearer" || !looksLikeJwt(payload.access_token)) {
        throw new Error("Rainbond Device Flow 返回的访问凭证无效");
      }
      return payload.access_token;
    }
    if (response.status === 429) {
      const retryAfter = Number.parseInt(response.headers.get("retry-after") || "", 10);
      interval = Number.isInteger(retryAfter) && retryAfter > interval
        ? retryAfter
        : interval + 5;
      continue;
    }
    if (payload.error === "authorization_pending") continue;
    if (payload.error === "slow_down") {
      interval += 5;
      continue;
    }
    if (payload.error === "access_denied") throw new Error("你已拒绝 Rainbond 授权");
    if (payload.error === "expired_token") throw new Error("Rainbond 设备授权码已过期");
    throw new Error(`Rainbond Device Flow 轮询失败（HTTP ${response.status}）`);
  }
}

function openWindowsBrowser(url, {
  spawnImpl = spawn,
  helperPath = path.join(__dirname, "windows-browser.ps1"),
} = {}) {
  const parsed = new URL(url);
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error("浏览器地址必须是无凭据的 HTTP(S) URL");
  }
  return new Promise((resolve, reject) => {
    const child = spawnImpl("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-File",
      helperPath,
      "-Url",
      url,
    ], {
      stdio: "ignore",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (signal) reject(new Error(`浏览器打开器被信号 ${signal} 中断`));
      else if (code !== 0) reject(new Error(`浏览器打开器退出码为 ${code}`));
      else resolve();
    });
  });
}

module.exports = {
  authorizeWithDeviceFlow,
  authorizeWithLoopback,
  looksLikeJwt,
  openWindowsBrowser,
};
