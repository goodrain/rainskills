"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { looksLikeJwt } = require("./windows-auth.js");

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

async function validateMcp({ url, token, fetchImpl = globalThis.fetch }) {
  if (!looksLikeJwt(token)) throw new Error("Rainbond JWT 格式无效");
  const response = await fetchImpl(url, {
    method: "POST",
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
  if (!response.ok) throw new Error(`Rainbond MCP 校验失败，HTTP ${response.status}`);
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

function removeExistingClient(spawnImpl, command, args, options) {
  const result = spawnImpl(command, args, options);
  if (result.error) {
    if (result.error.code === "ENOENT") throw new Error(`未找到所选客户端命令：${command}`);
    throw result.error;
  }
  if (result.signal) throw new Error(`${command} 被信号 ${result.signal} 中断`);
}

function writeCodexMcpConfig({ baseUrl, home = process.env.USERPROFILE || os.homedir() }) {
  const configDirectory = path.join(home, ".codex");
  const configPath = path.join(configDirectory, "config.toml");
  fs.mkdirSync(configDirectory, { recursive: true });
  const original = fs.existsSync(configPath) ? fs.readFileSync(configPath, "utf8") : "";
  const lines = original.replace(/\r\n?/g, "\n").split("\n");
  const sectionPattern = /^\s*\[\s*mcp_servers\.rainbond\s*\]\s*(?:#.*)?$/;
  const nextSectionPattern = /^\s*\[/;
  const start = lines.findIndex((line) => sectionPattern.test(line));
  const block = [
    "[mcp_servers.rainbond]",
    `url = ${JSON.stringify(`${baseUrl}/console/mcp/rainskills/codex/query`)}`,
    'bearer_token_env_var = "RAINBOND_JWT"',
  ];

  if (start >= 0) {
    let end = start + 1;
    while (end < lines.length && !nextSectionPattern.test(lines[end])) end += 1;
    lines.splice(start, end - start, ...block, "");
  } else {
    while (lines.length > 0 && lines.at(-1) === "") lines.pop();
    if (lines.length > 0) lines.push("");
    lines.push(...block, "");
  }

  if (original) fs.copyFileSync(configPath, `${configPath}.rainskills-backup`);
  fs.writeFileSync(configPath, lines.join("\n"), "utf8");
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

function configureSelectedClients({
  target,
  baseUrl,
  token,
  spawnImpl = spawnSync,
  home = process.env.USERPROFILE || os.homedir(),
}) {
  if (!looksLikeJwt(token)) throw new Error("Rainbond JWT 格式无效");
  if (!["codex", "claude", "all"].includes(target)) throw new Error("安装目标无效");
  const normalizedBase = normalizeBaseUrl(baseUrl);
  const environment = {
    ...process.env,
    RAINBOND_JWT: token,
    RAINBOND_URL: normalizedBase,
  };
  const options = { encoding: "utf8", env: environment, windowsHide: true };
  if (target === "codex" || target === "all") {
    const remove = spawnImpl("codex", ["mcp", "remove", "rainbond"], options);
    if (remove.error?.code === "ENOENT") {
      writeCodexMcpConfig({ baseUrl: normalizedBase, home });
    } else {
      if (remove.error) throw remove.error;
      if (remove.signal) throw new Error(`codex 被信号 ${remove.signal} 中断`);
      checkedSpawn(spawnImpl, "codex", [
        "mcp",
        "add",
        "rainbond",
        "--url",
        `${normalizedBase}/console/mcp/rainskills/codex/query`,
        "--bearer-token-env-var",
        "RAINBOND_JWT",
      ], options);
    }
  }
  if (target === "claude" || target === "all") {
    removeExistingClient(spawnImpl, "claude", [
      "mcp",
      "remove",
      "--scope",
      "user",
      "rainbond",
    ], options);
    checkedSpawn(spawnImpl, "claude", [
      "mcp",
      "add",
      "--scope",
      "user",
      "--transport",
      "http",
      "rainbond",
      `${normalizedBase}/console/mcp/rainskills/claude-code/query`,
      "-H",
      "Authorization: GRJWT ${RAINBOND_JWT}",
    ], options);
  }
}

module.exports = {
  configureSelectedClients,
  persistWindowsEnvironment,
  validateMcp,
};
