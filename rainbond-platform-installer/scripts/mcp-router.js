"use strict";

const { INTENT_DEFINITIONS } = require("./runtime-intents.js");

const OPERATION_ARGUMENT = "rainskills_operation_id";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function assertObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label}无效`);
  }
  return value;
}

function operationSchema(inputSchema) {
  const schema = clone(assertObject(inputSchema, "MCP tool schema "));
  if (schema.type !== "object") throw new Error("MCP tool schema 必须是 object");
  const properties = schema.properties === undefined
    ? {}
    : clone(assertObject(schema.properties, "MCP tool properties "));
  properties[OPERATION_ARGUMENT] = {
    type: "string",
    format: "uuid",
    description: "Rainskills protected operation id",
  };
  const required = Array.isArray(schema.required) ? [...schema.required] : [];
  if (!required.includes(OPERATION_ARGUMENT)) required.push(OPERATION_ARGUMENT);
  return { ...schema, properties, required };
}

function statusCode(error) {
  const value = error && (error.status ?? error.statusCode ?? error.code);
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : null;
}

function failureStep(operation) {
  if (operation.failed_step) return operation.failed_step;
  const definition = INTENT_DEFINITIONS[operation.intent.type];
  if (!definition || !definition.steps.length) throw new Error("runtime operation intent 无效");
  return definition.steps[0];
}

async function createDefaultClient({ environment, credential }) {
  const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
  const {
    StreamableHTTPClientTransport,
  } = require("@modelcontextprotocol/sdk/client/streamableHttp.js");
  const endpoint = new URL("/console/mcp/query", environment.console_origin);
  const transport = new StreamableHTTPClientTransport(endpoint, {
    requestInit: {
      headers: { Authorization: `GRJWT ${credential.token}` },
      redirect: "manual",
    },
  });
  const client = new Client({ name: "rainskills-router", version: "1.0.0" });
  await client.connect(transport);
  return client;
}

function createMcpRouter({
  registry,
  operationStore,
  credentialStore,
  clientFactory = createDefaultClient,
} = {}) {
  if (!registry || typeof registry.read !== "function" || typeof registry.get !== "function") {
    throw new Error("MCP router 缺少环境注册表");
  }
  if (!operationStore || typeof operationStore.read !== "function") {
    throw new Error("MCP router 缺少 operation store");
  }
  if (!credentialStore || typeof credentialStore.read !== "function") {
    throw new Error("MCP router 缺少环境凭据 store");
  }
  if (typeof clientFactory !== "function") throw new Error("MCP router client factory 无效");

  let catalog = new Map();
  let tools = [];
  let unavailableEnvironmentIds = new Set();

  async function withClient(environment, action) {
    const credential = credentialStore.read({
      environmentId: environment.id,
      expectedOrigin: environment.console_origin,
    });
    const client = await clientFactory({ environment: clone(environment), credential });
    try {
      return await action(client);
    } finally {
      if (client && typeof client.close === "function") await client.close();
    }
  }

  async function listAllTools(client) {
    const result = [];
    let cursor;
    do {
      const page = await client.listTools(cursor ? { cursor } : undefined);
      if (!page || !Array.isArray(page.tools)) throw new Error("运行环境返回了无效的 MCP tool 列表");
      result.push(...page.tools);
      cursor = page.nextCursor;
    } while (cursor);
    return result;
  }

  async function refreshTools() {
    const nextCatalog = new Map();
    const nextTools = new Map();
    const nextUnavailableEnvironmentIds = new Set();
    const environments = registry.read().environments
      .filter((environment) => environment.connection_state === "connected");
    for (const environment of environments) {
      let remoteTools;
      try {
        remoteTools = await withClient(environment, (client) => listAllTools(client));
      } catch {
        nextUnavailableEnvironmentIds.add(environment.id);
        continue;
      }
      for (const remoteTool of remoteTools) {
        if (
          !remoteTool
          || typeof remoteTool.name !== "string"
          || !remoteTool.name
          || typeof remoteTool.description !== "string"
        ) {
          throw new Error("运行环境返回了无效的 MCP tool 定义");
        }
        const routedTool = {
          name: remoteTool.name,
          description: remoteTool.description,
          inputSchema: operationSchema(remoteTool.inputSchema),
        };
        const existing = nextTools.get(remoteTool.name);
        if (existing && JSON.stringify(existing.inputSchema) !== JSON.stringify(routedTool.inputSchema)) {
          throw new Error("不同运行环境返回了不一致的 MCP tool schema");
        }
        if (!existing) nextTools.set(remoteTool.name, routedTool);
        if (!nextCatalog.has(remoteTool.name)) nextCatalog.set(remoteTool.name, new Set());
        nextCatalog.get(remoteTool.name).add(environment.id);
      }
    }
    catalog = nextCatalog;
    unavailableEnvironmentIds = nextUnavailableEnvironmentIds;
    tools = [...nextTools.values()].sort((left, right) => left.name.localeCompare(right.name));
    return clone(tools);
  }

  function listTools() {
    return clone(tools);
  }

  async function callTool(name, input, { signal } = {}) {
    if (typeof name !== "string" || !name) throw new Error("MCP tool name 无效");
    const args = assertObject(input, "MCP tool arguments ");
    const operationId = args[OPERATION_ARGUMENT];
    if (!UUID_PATTERN.test(operationId || "")) throw new Error("缺少有效的 Rainskills operation id");
    const operation = operationStore.read(operationId);
    if (!operation) throw new Error("Rainskills operation 不存在");
    if (operation.stage === "completed") throw new Error("Rainskills operation 已完成");
    if (!operation.environment_id || operation.stage === "awaiting-environment") {
      throw new Error("Rainskills operation 尚未选择运行环境");
    }
    const environment = registry.get(operation.environment_id);
    if (!environment) throw new Error("该操作绑定的运行环境不存在");
    if (environment.connection_state !== "connected") throw new Error("该操作绑定的运行环境当前不可用");
    if (!catalog.has(name)) await refreshTools();
    if (unavailableEnvironmentIds.has(environment.id)) {
      throw new Error("该操作绑定的运行环境当前不可用");
    }
    if (!catalog.get(name)?.has(environment.id)) throw new Error("该运行环境不支持请求的能力");
    const remoteArguments = { ...args };
    delete remoteArguments[OPERATION_ARGUMENT];
    try {
      return await withClient(environment, (client) => client.callTool({
        name,
        arguments: remoteArguments,
      }, undefined, { signal }));
    } catch (error) {
      const status = statusCode(error);
      if (status === 401) {
        operationStore.recordFailure(operationId, {
          step: failureStep(operation),
          reason: "credential-expired",
        });
        throw new Error("运行环境授权已失效，需要重新连接");
      }
      if (status === 403) {
        operationStore.recordFailure(operationId, {
          step: failureStep(operation),
          reason: "permission-denied",
        });
        throw new Error("当前运行环境权限不足");
      }
      throw new Error("运行环境调用失败");
    }
  }

  return { callTool, listTools, refreshTools };
}

module.exports = {
  OPERATION_ARGUMENT,
  createDefaultClient,
  createMcpRouter,
  operationSchema,
};
