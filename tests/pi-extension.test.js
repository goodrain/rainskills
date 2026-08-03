const assert = require("node:assert/strict");
const { webcrypto } = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { pathToFileURL } = require("node:url");

const repoRoot = path.resolve(__dirname, "..");
const extensionPath = path.join(repoRoot, "pi", "rainskills-mcp.ts");
const extensionTestDir = fs.mkdtempSync(
  path.join(os.tmpdir(), "rainskills-pi-module-")
);
const extensionTestPath = path.join(extensionTestDir, "rainskills-mcp.mjs");

if (!globalThis.crypto) {
  Object.defineProperty(globalThis, "crypto", { value: webcrypto });
}

test.after(() => fs.rmSync(extensionTestDir, { recursive: true, force: true }));

async function loadExtension() {
  fs.copyFileSync(extensionPath, extensionTestPath);
  return import(`${pathToFileURL(extensionTestPath).href}?test=${Date.now()}`);
}

test("generated Pi extension has no trailing whitespace", () => {
  const extension = fs.readFileSync(extensionPath, "utf8");

  assert.doesNotMatch(extension, /[ \t]+$/m);
});

test("Pi extension reads the shared Rainbond credential without exposing it", async () => {
  assert(fs.existsSync(extensionPath), "Pi extension must be built before testing");
  const extension = await loadExtension();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "rainskills-pi-"));
  const configDir = path.join(home, ".rainbond");
  fs.mkdirSync(configDir);
  fs.writeFileSync(
    path.join(configDir, "mcp.env"),
    "export RAINBOND_JWT='header.payload.signature'\n" +
      "export RAINBOND_URL='https://rainbond.example.com/'\n",
    { mode: 0o600 }
  );

  const config = extension.readRainbondConfig({ env: {}, home });
  assert.deepEqual(config, {
    token: "header.payload.signature",
    url: "https://rainbond.example.com/console/mcp/rainskills/pi/query",
  });
  assert(!JSON.stringify(extension.publicConfig(config)).includes(config.token));
});

test("Pi extension preserves MCP text results and serializes other content", async () => {
  const extension = await loadExtension();
  assert.deepEqual(
    extension.toPiContent({
      content: [
        { type: "text", text: "deployed" },
        { type: "resource_link", uri: "https://example.com", name: "app" },
      ],
    }),
    [
      { type: "text", text: "deployed" },
      {
        type: "text",
        text: '{"type":"resource_link","uri":"https://example.com","name":"app"}',
      },
    ]
  );
});

test("Pi extension registers every discovered MCP tool independently", async () => {
  const extension = await loadExtension();
  const registered = [];
  const handlers = {};
  const fakePi = {
    on(name, handler) {
      handlers[name] = handler;
    },
    registerTool(definition) {
      registered.push(definition);
    },
  };
  const calls = [];
  const fakeClient = {
    async connect() {},
    async listTools() {
      return {
        tools: [
          {
            name: "rainbond_query_apps",
            description: "List Rainbond applications",
            inputSchema: { type: "object", properties: {} },
          },
        ],
      };
    },
    async callTool(request) {
      calls.push(request);
      return { content: [{ type: "text", text: "ok" }] };
    },
    async close() {},
  };

  extension.registerRainbondExtension(fakePi, {
    readConfig: () => ({ token: "secret", url: "https://example.com/mcp" }),
    createClient: () => fakeClient,
  });
  await handlers.session_start({}, { ui: { notify() {} } });

  assert.equal(registered.length, 1);
  assert.equal(registered[0].name, "rainbond_query_apps");
  assert.deepEqual(registered[0].parameters, {
    type: "object",
    properties: {},
  });
  const result = await registered[0].execute("call-1", { team: "demo" });
  assert.deepEqual(calls, [
    { name: "rainbond_query_apps", arguments: { team: "demo" } },
  ]);
  assert.deepEqual(result.content, [{ type: "text", text: "ok" }]);
});

test("bundled Pi extension completes a real Streamable HTTP MCP call", async () => {
  const extension = await loadExtension();
  const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
  const { StreamableHTTPServerTransport } = await import(
    "@modelcontextprotocol/sdk/server/streamableHttp.js"
  );
  const { z } = await import("zod");
  function createServer() {
    const server = new McpServer({ name: "pi-test", version: "1" });
    server.registerTool(
      "rainbond_echo",
      {
        description: "Echo through Rainbond MCP",
        inputSchema: { message: z.string() },
      },
      async ({ message }) => ({
        content: [{ type: "text", text: `echo:${message}` }],
      })
    );
    return server;
  }

  const receivedAuth = [];
  const serverErrors = [];
  const httpServer = http.createServer(async (request, response) => {
    receivedAuth.push(request.headers.authorization);
    try {
      if (request.method !== "POST") {
        response.writeHead(405).end();
        return;
      }
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const server = createServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      await server.connect(transport);
      await transport.handleRequest(request, response, body);
      response.on("close", () => {
        transport.close();
        server.close();
      });
    } catch (error) {
      serverErrors.push(error);
      if (!response.headersSent) response.writeHead(500);
      response.end();
    }
  });
  await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const address = httpServer.address();

  const registered = [];
  const handlers = {};
  const fakePi = {
    on(name, handler) {
      handlers[name] = handler;
    },
    registerTool(definition) {
      registered.push(definition);
    },
  };

  try {
    const connectionErrors = [];
    extension.registerRainbondExtension(fakePi, {
      readConfig: () => ({
        token: "integration-secret",
        url: `http://127.0.0.1:${address.port}/mcp`,
      }),
      onError: (error) => connectionErrors.push(error),
    });
    await handlers.session_start({}, { ui: { notify() {} } });
    const tool = registered.find(({ name }) => name === "rainbond_echo");
    assert(
      tool,
      [...connectionErrors, ...serverErrors]
        .map((error) => `${error?.constructor?.name}:${error?.code || ""}:${error?.message || error}`)
        .concat(`requests:${JSON.stringify(receivedAuth)}`)
        .join("\n") ||
        "MCP tool should be registered in Pi"
    );
    const result = await tool.execute("call-1", { message: "ready" });
    assert.deepEqual(result.content, [{ type: "text", text: "echo:ready" }]);
    assert(receivedAuth.length >= 2);
    assert(receivedAuth.every((value) => value === "GRJWT integration-secret"));
    await handlers.session_shutdown();
  } finally {
    await new Promise((resolve) => httpServer.close(resolve));
  }
});
