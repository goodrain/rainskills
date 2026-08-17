const assert = require("node:assert/strict");
const { webcrypto } = require("node:crypto");
const fs = require("node:fs");
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

test("Pi extension starts the version-pinned local Rainskills router without credentials", async () => {
  assert(fs.existsSync(extensionPath), "Pi extension must be built before testing");
  const extension = await loadExtension();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "rainskills-pi-"));
  const config = extension.readRainbondConfig({ env: {}, home });
  assert.deepEqual(config, {
    command: "npx",
    args: [
      "--yes", "rainskills@0.1.0-rc.64", "mcp", "serve", "--client", "pi",
    ],
  });
  assert.deepEqual(extension.publicConfig(config), config);
  assert.doesNotMatch(JSON.stringify(config), /JWT|token|rainbond\.example/i);
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

test("bundled Pi extension completes a real local stdio MCP call", async () => {
  const extension = await loadExtension();
  const fixture = path.join(extensionTestDir, "fake-router.mjs");
  const sdkRoot = path.join(repoRoot, "node_modules", "@modelcontextprotocol", "sdk", "dist", "esm");
  fs.writeFileSync(fixture, `
import { Server } from ${JSON.stringify(pathToFileURL(path.join(sdkRoot, "server", "index.js")).href)};
import { StdioServerTransport } from ${JSON.stringify(pathToFileURL(path.join(sdkRoot, "server", "stdio.js")).href)};
import { CallToolRequestSchema, ListToolsRequestSchema } from ${JSON.stringify(pathToFileURL(path.join(sdkRoot, "types.js")).href)};
const server = new Server({ name: "pi-test", version: "1" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{
  name: "rainbond_echo",
  description: "Echo through the local Rainskills router",
  inputSchema: { type: "object", properties: { message: { type: "string" } }, required: ["message"] }
}] }));
server.setRequestHandler(CallToolRequestSchema, async ({ params }) => ({
  content: [{ type: "text", text: "echo:" + params.arguments.message }]
}));
await server.connect(new StdioServerTransport());
`);

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

  const connectionErrors = [];
  extension.registerRainbondExtension(fakePi, {
    readConfig: () => ({ command: process.execPath, args: [fixture] }),
    onError: (error) => connectionErrors.push(error),
  });
  await handlers.session_start({}, { ui: { notify() {} } });
  const tool = registered.find(({ name }) => name === "rainbond_echo");
  assert(tool, connectionErrors.map((error) => error?.message || String(error)).join("\n"));
  const result = await tool.execute("call-1", { message: "ready" });
  assert.deepEqual(result.content, [{ type: "text", text: "echo:ready" }]);
  await handlers.session_shutdown();
});
