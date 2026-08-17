"use strict";

const { Server } = require("@modelcontextprotocol/sdk/server/index.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} = require("@modelcontextprotocol/sdk/types.js");

const SAFE_ROUTER_ERRORS = new Set([
  "运行环境调用失败",
  "运行环境授权已失效，需要重新连接",
  "当前运行环境权限不足",
  "该操作绑定的运行环境当前不可用",
  "该操作绑定的运行环境不存在",
  "该运行环境不支持请求的能力",
  "Rainskills operation 不存在",
  "Rainskills operation 已完成",
  "Rainskills operation 尚未选择运行环境",
  "缺少有效的 Rainskills operation id",
]);

function safeRouterError(error) {
  const message = error && typeof error.message === "string" ? error.message : "";
  return SAFE_ROUTER_ERRORS.has(message) ? message : "运行环境调用失败";
}

function createRainskillsMcpServer({ router } = {}) {
  if (
    !router
    || typeof router.refreshTools !== "function"
    || typeof router.callTool !== "function"
  ) {
    throw new Error("Rainskills MCP server 缺少 router");
  }
  const server = new Server(
    { name: "rainskills", version: require("../../package.json").version },
    { capabilities: { tools: { listChanged: false } } }
  );
  let tools = [];

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    try {
      return await router.callTool(
        request.params.name,
        request.params.arguments || {},
        { signal: extra?.signal }
      );
    } catch (error) {
      return {
        isError: true,
        content: [{ type: "text", text: safeRouterError(error) }],
      };
    }
  });

  return {
    async connect(transport) {
      tools = await router.refreshTools();
      await server.connect(transport);
    },
    async close() {
      await server.close();
    },
  };
}

async function serveStdio({ router } = {}) {
  const local = createRainskillsMcpServer({ router });
  await local.connect(new StdioServerTransport());
  return local;
}

module.exports = {
  createRainskillsMcpServer,
  safeRouterError,
  serveStdio,
};
