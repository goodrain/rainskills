"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = require("@modelcontextprotocol/sdk/inMemory.js");

const serverPath = path.resolve(
  __dirname,
  "..",
  "rainbond-platform-installer",
  "scripts",
  "mcp-server.js"
);

test("local MCP server exposes routed tools and forwards operation-scoped calls", async () => {
  const calls = [];
  const router = {
    async refreshTools() {
      return [{
        name: "rainbond_echo",
        description: "Echo through the selected environment",
        inputSchema: {
          type: "object",
          properties: {
            rainskills_operation_id: { type: "string", format: "uuid" },
            message: { type: "string" },
          },
          required: ["rainskills_operation_id", "message"],
          additionalProperties: false,
        },
      }];
    },
    listTools() {
      return this.tools || [];
    },
    async callTool(name, args) {
      calls.push({ name, args });
      return { content: [{ type: "text", text: "ok" }] };
    },
  };
  const { createRainskillsMcpServer } = require(serverPath);
  const local = createRainskillsMcpServer({ router });
  const client = new Client({ name: "test-client", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await local.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const listed = await client.listTools();
    assert.deepEqual(listed.tools.map((tool) => tool.name), ["rainbond_echo"]);
    assert(listed.tools[0].inputSchema.required.includes("rainskills_operation_id"));
    const result = await client.callTool({
      name: "rainbond_echo",
      arguments: {
        rainskills_operation_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        message: "hello",
      },
    });
    assert.deepEqual(result.content, [{ type: "text", text: "ok" }]);
    assert.deepEqual(calls, [{
      name: "rainbond_echo",
      args: {
        rainskills_operation_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        message: "hello",
      },
    }]);
  } finally {
    await client.close();
    await local.close();
  }
});

test("local MCP server returns fixed safe tool errors", async () => {
  const router = {
    async refreshTools() {
      return [{
        name: "rainbond_echo",
        description: "Echo",
        inputSchema: { type: "object", properties: {}, additionalProperties: true },
      }];
    },
    async callTool() {
      throw new Error("运行环境调用失败");
    },
  };
  const { createRainskillsMcpServer } = require(serverPath);
  const local = createRainskillsMcpServer({ router });
  const client = new Client({ name: "test-client", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await local.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const result = await client.callTool({ name: "rainbond_echo", arguments: {} });
    assert.equal(result.isError, true);
    assert.deepEqual(result.content, [{ type: "text", text: "运行环境调用失败" }]);
  } finally {
    await client.close();
    await local.close();
  }
});
