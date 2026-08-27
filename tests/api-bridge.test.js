const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const test = require("node:test");

const repoRoot = path.resolve(__dirname, "..");
const bridgePath = path.join(repoRoot, "bin", "rainskills-tools.js");
function prepareProtectedRuntime(home, env) {
  if (!env.RAINBOND_URL || !env.RAINBOND_JWT) return;
  let origin;
  try {
    const parsed = new URL(env.RAINBOND_URL);
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) return;
    origin = parsed.origin;
  } catch {
    return;
  }
  const { createSingleRuntimeStore } = require("../rainbond-platform-installer/scripts/single-runtime.js");
  createSingleRuntimeStore({ home }).write({
    kind: "private",
    consoleOrigin: origin,
    token: env.RAINBOND_JWT,
    allowInsecureHttp: origin.startsWith("http://"),
  });
  const manifestDirectory = path.join(home, ".rainbond", "bin");
  const content = "---\nname: rainbond-app-assistant\n---\n# App assistant\n";
  const digest = require("node:crypto").createHash("sha256").update(content).digest("hex");
  fs.mkdirSync(manifestDirectory, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(manifestDirectory, "rainskills-skill-manifest.json"), `${JSON.stringify({
    schema: "rainskills.skill-manifest.v1",
    profile: "cli",
    package_version: "test",
    source_revision: null,
    skills: [{
      id: "rainbond-app-assistant",
      name: "rainbond-app-assistant",
      profile: "cli",
      package_version: "test",
      source_revision: null,
      content_sha256: digest,
      bundle_sha256: "a".repeat(64),
      content,
    }],
  })}\n`, { mode: 0o600 });
}

function prepareConnectedEnvironment(home, origin, token) {
  const { createSingleRuntimeStore } = require("../rainbond-platform-installer/scripts/single-runtime.js");
  const runtime = createSingleRuntimeStore({ home });
  runtime.write({
    kind: "private",
    consoleOrigin: origin,
    token,
    allowInsecureHttp: origin.startsWith("http://"),
  });
  return { runtime };
}

function runRawBridge(args, { home, input = "" } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bridgePath, ...args], {
      cwd: repoRoot,
      env: { ...process.env, HOME: home },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
    child.stdin.end(input);
  });
}

function runBridge(args, {
  env = {},
  input = "",
  allowInsecureHttp = true,
  home,
  includeSkillBinding = true,
  skillId = "rainbond-app-assistant",
} = {}) {
  return new Promise((resolve, reject) => {
    const actualHome = home || fs.mkdtempSync(path.join(os.tmpdir(), "rainskills-bridge-home-"));
    prepareProtectedRuntime(actualHome, env);
    const commandArgs = [...args];
    if (includeSkillBinding) {
      commandArgs.push("--skill-id", skillId);
      if (args[0] === "call") {
        commandArgs.push("--root-skill-id", skillId);
      }
    }
    const child = spawn(process.execPath, [bridgePath, ...commandArgs], {
      cwd: repoRoot,
      env: {
        ...process.env,
        HOME: actualHome,
        ...(allowInsecureHttp ? { RAINBOND_ALLOW_INSECURE_HTTP: "true" } : {}),
        ...env,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
    child.stdin.end(input);
  });
}

async function withRpcServer(handler, callback) {
  const requests = [];
  const sockets = new Set();
  const server = http.createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const record = {
        method: request.method,
        url: request.url,
        headers: request.headers,
        body: JSON.parse(body),
      };
      requests.push(record);
      handler(record, response);
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  try {
    return await callback(`http://127.0.0.1:${address.port}/ignored/base`, requests);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
}

function rpcResult(response, id, result) {
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
}

test("API bridge requires the current Rainbond CLI endpoint and recommends an upgrade", async () => {
  await withRpcServer((_record, response) => {
    response.writeHead(404, { "Content-Type": "text/html" });
    response.end("<!doctype html><title>Not Found</title>");
  }, async (baseUrl, requests) => {
    const { rpcRequest } = require(bridgePath);
    await assert.rejects(
      rpcRequest(
        { baseUrl: new URL(baseUrl).origin, jwt: "bridge-jwt.payload.signature" },
        "tools/list",
        {},
        { timeoutMs: 1_000 }
      ),
      (error) => error.exitCode === 4 && /v6\.9\.9.*更高版本/.test(error.message)
    );
    assert.deepEqual(requests.map((request) => [request.url, request.body.method]), [
      ["/console/mcp/rainskills/api/query", "tools/list"],
    ]);
  });
});

test("API bridge does not downgrade an unverified 404 response", async () => {
  await withRpcServer((_record, response) => {
    response.writeHead(404, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ detail: "upstream policy rejected the request" }));
  }, async (baseUrl, requests) => {
    const { rpcRequest } = require(bridgePath);
    await assert.rejects(
      rpcRequest(
        { baseUrl: new URL(baseUrl).origin, jwt: "bridge-jwt.payload.signature" },
        "tools/list",
        {},
        { timeoutMs: 1_000 }
      ),
      (error) => error.exitCode === 4
    );
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, "/console/mcp/rainskills/api/query");
  });
});

const CONTEXT_MEASUREMENT_FIXTURE = {
  tools: Array.from({ length: 12 }, (_unused, index) => ({
    name: `rainbond_catalog_tool_${String(index + 1).padStart(2, "0")}`,
    description: `Rainbond catalog tool ${index + 1} with workflow guidance, permission boundaries, and failure recovery instructions.`,
    inputSchema: {
      type: "object",
      properties: {
        team_name: { type: "string", description: "Rainbond team name." },
        app_name: { type: "string", description: "Rainbond application name." },
        page: { type: "integer", minimum: 1, description: "Result page number." },
      },
      required: ["team_name"],
      additionalProperties: false,
    },
  })),
  structuredResult: {
    app_id: 42,
    app_name: "demo",
    status: "running",
  },
};

function utf8Bytes(value) {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function measureContextBytes({ tools, structuredResult }) {
  const compactList = tools.map((tool) => tool.name);
  const schemas = tools.map(({ name, description, inputSchema }) => ({
    name,
    description,
    inputSchema,
  }));
  const schemaBytes = schemas.map(utf8Bytes);
  const fullCatalogBytes = utf8Bytes({ tools });
  const compactListBytes = utf8Bytes(compactList);
  const averageSchemaBytes = schemaBytes.reduce((sum, value) => sum + value, 0) / schemaBytes.length;
  const ratio = (bytes) => Number((bytes / fullCatalogBytes).toFixed(4));

  return {
    unit: "utf8_bytes",
    full_catalog_bytes: fullCatalogBytes,
    compact_list_bytes: compactListBytes,
    one_tool_schema_bytes: schemaBytes[0],
    structured_call_result_bytes: utf8Bytes(structuredResult),
    compact_list_ratio: ratio(compactListBytes),
    one_tool_schema_ratio: ratio(schemaBytes[0]),
    structured_call_result_ratio: ratio(utf8Bytes(structuredResult)),
    compact_list_plus_five_average_schemas_ratio: ratio(compactListBytes + (5 * averageSchemaBytes)),
  };
}

test("configuration requires paired environment overrides", () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "rainskills-bridge-config-"));
  const configDir = path.join(tempHome, ".rainbond");
  const marker = path.join(tempHome, "must-not-exist");
  fs.mkdirSync(configDir);
  fs.writeFileSync(
    path.join(configDir, "mcp.env"),
    [
      "export RAINBOND_URL='https://from-file.example/base'",
      "export RAINBOND_JWT='file-token'\"'\"'suffix'",
      `touch '${marker}'`,
      "export OTHER_SECRET='ignored'",
      "",
    ].join("\n"),
    { mode: 0o600 }
  );

  const { loadConfig, REQUEST_TIMEOUT_MS } = require(bridgePath);
  assert.throws(() => loadConfig({
    env: {
      RAINSKILLS_CREDENTIAL_SOURCE: "environment",
      RAINBOND_URL: "https://from-env.example/root",
    },
    homeDir: tempHome,
  }), /provided together/);
  const config = loadConfig({ env: {
    RAINSKILLS_CREDENTIAL_SOURCE: "environment",
    RAINBOND_URL: "https://from-env.example/root",
    RAINBOND_JWT: "override.payload.signature",
  }, homeDir: tempHome });

  assert.deepEqual(config, {
    baseUrl: "https://from-env.example/root",
    jwt: "override.payload.signature",
  });
  assert.equal(REQUEST_TIMEOUT_MS, 180_000);
  assert.equal(fs.existsSync(marker), false);
});

test("protected commands parse a Skill binding without runtime operation context", () => {
  const { parseCommand } = require(bridgePath);

  const cases = [
    [["status"], { command: "status" }],
    [["list"], { command: "list" }],
    [["list", "--prefix", "rainbond_query_"], {
      command: "list",
      prefix: "rainbond_query_",
    }],
    [["describe", "rainbond_create_app"], {
      command: "describe",
      toolName: "rainbond_create_app",
    }],
    [["read", "rainbond_query_apps", "--input", "-"], {
      command: "read",
      toolName: "rainbond_query_apps",
      input: "-",
    }],
    [["package-upload", "--archive", "/tmp/package.zip", "--input", "-"], {
      command: "package-upload",
      archive: "/tmp/package.zip",
      input: "-",
    }],
  ];

  for (const [commandArgs, expected] of cases) {
    assert.deepEqual(parseCommand([
      ...commandArgs,
      "--skill-id", "rainbond-app-assistant",
    ]), {
      ...expected,
      skillId: "rainbond-app-assistant",
    });
  }

  assert.throws(
    () => parseCommand(["list"]),
    /every tools command requires --skill-id <active-skill-id>/
  );
});

test("call parsing keeps valid base syntax separate from mutable-call authorization", () => {
  const { parseCommand } = require(bridgePath);

  assert.deepEqual(
    parseCommand([
      "call", "rainbond_create_app", "--input", "-",
      "--skill-id", "rainbond-app-assistant",
    ]),
    {
      command: "call",
      toolName: "rainbond_create_app",
      input: "-",
      skillId: "rainbond-app-assistant",
    }
  );

  assert.deepEqual(
    parseCommand([
      "call", "rainbond_create_app", "--input", "-",
      "--skill-id", "rainbond-app-assistant",
      "--root-skill-id", "rainbond-app-assistant",
      "--confirm", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    ]),
    {
      command: "call",
      toolName: "rainbond_create_app",
      input: "-",
      skillId: "rainbond-app-assistant",
      rootSkillId: "rainbond-app-assistant",
      confirmation: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    }
  );

  assert.throws(
    () => parseCommand([
      "call", "rainbond_create_app", "--input", "-", "--unknown", "value",
      "--skill-id", "rainbond-app-assistant",
    ]),
    /unsupported call option: --unknown/
  );

  assert.throws(
    () => parseCommand([
      "call", "rainbond_create_app", "--input", "-", "--skill-id",
    ]),
    /every tools command requires --skill-id <active-skill-id>/
  );

  assert.throws(
    () => parseCommand([
      "call", "rainbond_create_app", "--input", "-",
      "--skill-id", "rainbond-app-assistant",
      "--skill-id", "rainbond-app-assistant",
    ]),
    /every tools command requires --skill-id <active-skill-id>/
  );
});

test("protected commands report the missing Skill binding instead of invalid command", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "rainskills-bridge-missing-skill-"));
  const result = await runBridge(
    ["call", "rainbond_create_app", "--input", "-"],
    {
      env: {
        RAINBOND_URL: "http://127.0.0.1:65535",
        RAINBOND_JWT: "bridge-jwt.payload.signature",
      },
      home,
      input: JSON.stringify({ app_name: "demo" }),
      includeSkillBinding: false,
    }
  );

  assert.equal(result.code, 2);
  assert.match(result.stderr, /every tools command requires --skill-id <active-skill-id>/);
  assert.doesNotMatch(result.stderr, /invalid command/);
});

test("mutable calls validate Console tool schemas before issuing confirmation", async () => {
  await withRpcServer((record, response) => {
    assert.equal(record.body.method, "tools/list");
    rpcResult(response, record.body.id, {
      tools: [{
        name: "rainbond_create_component_from_image",
        description: "Create a component from an image.",
        inputSchema: {
          type: "object",
          properties: {
            team_name: { type: "string" },
            region_name: { type: "string" },
            app_id: { type: "integer", minimum: 1 },
            service_cname: { type: "string" },
            image: { type: "string" },
            is_deploy: { type: "boolean" },
          },
          required: ["team_name", "region_name", "app_id", "service_cname", "image"],
        },
      }],
    });
  }, async (baseUrl, requests) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "rainskills-bridge-schema-validation-"));
    const result = await runBridge(
      ["call", "rainbond_create_component_from_image", "--input", "-"],
      {
        env: {
          RAINBOND_URL: new URL(baseUrl).origin,
          RAINBOND_JWT: "bridge-jwt.payload.signature",
        },
        home,
        input: JSON.stringify({
          team_name: "demo-team",
          region_name: "rainbond",
          app_id: 12,
          service_cname: "nginx",
          image_address: "nginx:latest",
        }),
      }
    );

    assert.equal(result.code, 2);
    assert.match(result.stderr, /missing required field: image/i);
    assert.deepEqual(requests.map((request) => request.body.method), ["tools/list"]);
    assert.equal(fs.existsSync(path.join(home, ".rainbond", "operations")), false);
  });
});

test("schema validation covers Console enums, arrays, alternatives, and map values", () => {
  const { validateSchemaValue } = require(bridgePath);
  const schema = {
    type: "object",
    properties: {
      operation: { type: "string", enum: ["add", "enable_outer"] },
      app_id: { type: "integer", minimum: 1 },
      ports: {
        type: "array",
        minItems: 1,
        items: {
          oneOf: [
            { type: "integer", minimum: 1 },
            {
              type: "object",
              properties: { port: { type: "integer", minimum: 1 } },
              required: ["port"],
            },
          ],
        },
      },
      selector: { anyOf: [{ type: "string", minLength: 1 }, { type: "null" }] },
      envs: { type: "object", additionalProperties: { type: "string" } },
    },
    required: ["operation", "app_id"],
    additionalProperties: false,
  };

  assert.equal(validateSchemaValue({
    operation: "add",
    app_id: 12,
    ports: [80, { port: 443 }],
    selector: null,
    envs: { MODE: "prod" },
  }, schema, "$input"), null);
  assert.match(validateSchemaValue({ operation: "delete", app_id: 12 }, schema, "$input"), /unsupported value/);
  assert.match(validateSchemaValue({ operation: "add", app_id: 0 }, schema, "$input"), /below.*minimum/);
  assert.match(validateSchemaValue({ operation: "add", app_id: 12, ports: [] }, schema, "$input"), /too few items/);
  assert.match(validateSchemaValue({ operation: "add", app_id: 12, envs: { MODE: 1 } }, schema, "$input"), /must be string/);
  assert.match(validateSchemaValue({ operation: "add", app_id: 12, unexpected: true }, schema, "$input"), /unsupported field/);
});

test("catalog commands no longer depend on a runtime intent binding", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "rainskills-bridge-wrong-skill-"));
  const result = await runBridge(["list"], {
    env: {
      RAINBOND_URL: "http://127.0.0.1:65535",
      RAINBOND_JWT: "bridge-jwt.payload.signature",
    },
    home,
    skillId: "rainbond-template-installer",
  });

  assert.notEqual(result.code, 3);
  assert.doesNotMatch(result.stderr, /runtime operation intent/);
});

test("status, compact list, describe, and call use the dedicated JSON-RPC endpoint", async () => {
  const tools = [
    {
      name: "rainbond_create_app",
      description: "create",
      inputSchema: { type: "object" },
      annotations: { destructiveHint: false },
      metadata: { internal: "must not be exposed" },
    },
    { name: "rainbond_query_apps", description: "query", inputSchema: { type: "object" } },
    { name: "other_tool", description: "other", inputSchema: { type: "object" } },
  ];
  await withRpcServer((record, response) => {
    assert.equal(record.method, "POST");
    assert.equal(record.url, "/console/mcp/rainskills/api/query");
    assert.equal(record.headers.authorization, "GRJWT bridge-jwt.payload.signature");
    assert.equal(record.headers.accept, "application/json");
    assert.equal(record.headers["content-type"], "application/json");
    assert.equal(record.headers["mcp-protocol-version"], "2025-03-26");
    assert.equal(record.body.jsonrpc, "2.0");
    if (record.body.method === "tools/list") {
      rpcResult(response, record.body.id, { tools });
      return;
    }
    assert.equal(record.body.method, "tools/call");
    assert.equal(record.body.params.name, "rainbond_create_app");
    assert.deepEqual(record.body.params.arguments, { app_name: "demo" });
    const auditMetadata = record.body.params._meta["com.rainbond/rainskills"];
    assert.match(auditMetadata.operation_id, /^[0-9a-f-]{36}$/);
    assert.equal(Object.hasOwn(auditMetadata, "runtime_operation_id"), false);
    assert.equal(
      record.body.params._meta["com.rainbond/rainskills"].skill.id,
      "rainbond-app-assistant"
    );
    rpcResult(response, record.body.id, {
      isError: false,
      content: [{ type: "text", text: "must not be printed" }],
      structuredContent: { app_id: 42 },
    });
  }, async (baseUrl, requests) => {
    const env = { RAINBOND_URL: new URL(baseUrl).origin, RAINBOND_JWT: "bridge-jwt.payload.signature" };
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "rainskills-bridge-catalog-"));

    const status = await runBridge(["status"], { env, home });
    assert.equal(status.code, 0, status.stderr);
    const statusPayload = JSON.parse(status.stdout);
    assert.equal(statusPayload.status, "ok");
    assert.equal(statusPayload.cli_version, "2.1.0");
    assert.equal(statusPayload.tool_count, 3);
    assert.equal(typeof statusPayload.catalog_age_ms, "number");

    const list = await runBridge(["list", "--prefix", "rainbond_query_"], { env, home });
    assert.equal(list.code, 0, list.stderr);
    assert.deepEqual(JSON.parse(list.stdout), ["rainbond_query_apps"]);
    assert.doesNotMatch(list.stdout, /inputSchema|description/);

    const describe = await runBridge(["describe", "rainbond_create_app"], { env, home });
    assert.equal(describe.code, 0, describe.stderr);
    assert.deepEqual(JSON.parse(describe.stdout), {
      name: "rainbond_create_app",
      description: "create",
      inputSchema: { type: "object" },
    });
    assert.doesNotMatch(describe.stdout, /annotations|metadata|internal/);

    const confirmation = await runBridge(
      ["call", "rainbond_create_app", "--input", "-"],
      { env, home, input: JSON.stringify({ app_name: "demo" }) }
    );
    assert.equal(confirmation.code, 0, confirmation.stderr);
    const confirmationPayload = JSON.parse(confirmation.stdout);
    assert.equal(confirmationPayload.requires_confirmation, true);
    assert.equal(confirmationPayload.operation_class, "write");

    const swappedArguments = await runBridge(
      ["call", "rainbond_create_app", "--input", "-", "--confirm", confirmationPayload.confirmation_id],
      { env, home, input: JSON.stringify({ app_name: "different-target" }) }
    );
    assert.equal(swappedArguments.code, 2);
    assert.match(swappedArguments.stderr, /arguments.*match|confirmation.*match/i);
    assert.equal(requests.length, 1, "changed arguments must be rejected before execution");

    const call = await runBridge(
      ["call", "rainbond_create_app", "--input", "-", "--confirm", confirmationPayload.confirmation_id],
      { env, home, input: JSON.stringify({ app_name: "demo" }) }
    );
    assert.equal(call.code, 0, call.stderr);
    assert.deepEqual(JSON.parse(call.stdout), { app_id: 42 });
    assert.doesNotMatch(call.stdout, /must not be printed|structuredContent|content/);
    // status fetches and privately caches the catalog; list/describe reuse it and
    // only the mutating call reaches the Console afterwards.
    assert.equal(requests.length, 2);
  });
});

test("write confirmation can be claimed by only one concurrent process", async () => {
  await withRpcServer((record, response) => {
    if (record.body.method === "tools/list") {
      rpcResult(response, record.body.id, {
        tools: [{
          name: "rainbond_create_app",
          inputSchema: { type: "object", properties: { app_name: { type: "string" } } },
        }],
      });
      return;
    }
    assert.equal(record.body.method, "tools/call");
    setTimeout(() => {
      rpcResult(response, record.body.id, {
        isError: false,
        structuredContent: { app_id: 42 },
      });
    }, 100);
  }, async (baseUrl, requests) => {
    const env = { RAINBOND_URL: baseUrl, RAINBOND_JWT: "jwt.payload.signature" };
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "rainskills-bridge-claim-"));
    const input = JSON.stringify({ app_name: "demo" });
    const pending = await runBridge(
      ["call", "rainbond_create_app", "--input", "-"],
      { env, home, input }
    );
    assert.equal(pending.code, 0, pending.stderr);
    const { confirmation_id: operationId } = JSON.parse(pending.stdout);

    const results = await Promise.all([
      runBridge(
        ["call", "rainbond_create_app", "--input", "-", "--confirm", operationId],
        { env, home, input }
      ),
      runBridge(
        ["call", "rainbond_create_app", "--input", "-", "--confirm", operationId],
        { env, home, input }
      ),
    ]);

    assert.deepEqual(results.map((result) => result.code).sort(), [0, 2]);
    assert.deepEqual(
      requests.map((request) => request.body.method),
      ["tools/list", "tools/call"],
      "schema discovery runs once and the confirmed write executes at most once"
    );
  });
});

test("read executes only read-classified tools and rejects writes before network access", async () => {
  await withRpcServer((record, response) => {
    assert.equal(record.body.method, "tools/call");
    assert.deepEqual(record.body.params, {
      name: "rainbond_query_enterprises",
      arguments: {},
    });
    rpcResult(response, record.body.id, {
      isError: false,
      structuredContent: { items: [{ enterprise_name: "demo" }] },
    });
  }, async (baseUrl, requests) => {
    const env = { RAINBOND_URL: new URL(baseUrl).origin, RAINBOND_JWT: "bridge-jwt.payload.signature" };
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "rainskills-bridge-read-"));

    const read = await runBridge(
      ["read", "rainbond_query_enterprises", "--input", "-"],
      { env, home, input: "{}" }
    );
    assert.equal(read.code, 0, read.stderr);
    assert.deepEqual(JSON.parse(read.stdout), {
      items: [{ enterprise_name: "demo" }],
    });
    assert.equal(requests.length, 1);

    const write = await runBridge(
      ["read", "rainbond_create_app", "--input", "-"],
      { env, home, input: JSON.stringify({ app_name: "must-not-run" }) }
    );
    assert.equal(write.code, 2);
    assert.match(write.stderr, /read-only/i);
    assert.equal(requests.length, 1, "rejected writes must not reach Rainbond");

    const destructive = await runBridge(
      ["read", "rainbond_query_delete_history", "--input", "-"],
      { env, home, input: "{}" }
    );
    assert.equal(destructive.code, 2);
    assert.match(destructive.stderr, /read-only/i);
    assert.equal(requests.length, 1, "destructive names must not reach Rainbond");
  });
});

test("dependency summary is read-only while dependency mutations stay protected", async () => {
  await withRpcServer((record, response) => {
    assert.equal(record.body.method, "tools/call");
    assert.deepEqual(record.body.params, {
      name: "rainbond_manage_component_dependency",
      arguments: {
        team_name: "demo-team",
        region_name: "rainbond",
        app_id: 12,
        service_id: "svc-1",
        operation: "summary",
      },
    });
    rpcResult(response, record.body.id, {
      isError: false,
      structuredContent: {
        service_id: "svc-1",
        dependencies: { items: [], total: 0 },
      },
    });
  }, async (baseUrl, requests) => {
    const env = {
      RAINBOND_URL: new URL(baseUrl).origin,
      RAINBOND_JWT: "bridge-jwt.payload.signature",
    };
    const summaryInput = {
      team_name: "demo-team",
      region_name: "rainbond",
      app_id: 12,
      service_id: "svc-1",
      operation: "summary",
    };

    const summary = await runBridge(
      ["read", "rainbond_manage_component_dependency", "--input", "-"],
      { env, input: JSON.stringify(summaryInput) }
    );
    assert.equal(summary.code, 0, summary.stderr);
    assert.deepEqual(JSON.parse(summary.stdout), {
      service_id: "svc-1",
      dependencies: { items: [], total: 0 },
    });
    assert.equal(requests.length, 1);

    for (const operation of ["add", "add_reverse", "delete"]) {
      const mutation = await runBridge(
        ["read", "rainbond_manage_component_dependency", "--input", "-"],
        { env, input: JSON.stringify({ ...summaryInput, operation }) }
      );
      assert.equal(mutation.code, 2, `${operation}: ${mutation.stderr}`);
      assert.match(mutation.stderr, /read-only/i);
    }
    assert.equal(requests.length, 1, "dependency mutations must not execute through read");
  });
});

test("platform query uses the single runtime without creating a runtime operation", async () => {
  await withRpcServer((record, response) => {
    assert.equal(record.body.method, "tools/call");
    assert.deepEqual(record.body.params, {
      name: "rainbond_query_components",
      arguments: { enterprise_id: "enterprise-1", app_id: 1 },
    });
    rpcResult(response, record.body.id, {
      isError: false,
      structuredContent: { items: [{ service_cname: "web" }] },
    });
  }, async (baseUrl, requests) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "rainskills-one-shot-query-"));
    const token = "bridge-jwt.payload.signature";
    prepareConnectedEnvironment(
      home,
      new URL(baseUrl).origin,
      token
    );

    const result = await runRawBridge([
      "query", "rainbond_query_components",
      "--input", "-",
      "--skill-id", "rainbond-platform-query",
    ], {
      home,
      input: JSON.stringify({ enterprise_id: "enterprise-1", app_id: 1 }),
    });

    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { items: [{ service_cname: "web" }] });
    assert.equal(requests.length, 1);
    assert.equal(fs.existsSync(path.join(home, ".rainbond", "rainskills", "operations")), false);
  });
});

test("one-shot team query resolves the current enterprise inside the CLI", async () => {
  await withRpcServer((record, response) => {
    assert.equal(record.body.method, "tools/call");
    const { name, arguments: argumentsValue } = record.body.params;
    if (name === "rainbond_get_current_user") {
      assert.deepEqual(argumentsValue, {});
      rpcResult(response, record.body.id, {
        isError: false,
        structuredContent: {
          user_id: "user-1",
          enterprise_id: "enterprise-1",
        },
      });
      return;
    }
    assert.equal(name, "rainbond_query_teams");
    if (argumentsValue.enterprise_id !== "enterprise-1") {
      rpcResult(response, record.body.id, {
        isError: true,
        structuredContent: {
          status_code: 400,
          error_code: 400,
          msg: "invalid enterprise_id",
        },
      });
      return;
    }
    rpcResult(response, record.body.id, {
      isError: false,
      structuredContent: {
        items: [{ team_name: "default" }],
      },
    });
  }, async (baseUrl, requests) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "rainskills-team-query-"));
    prepareConnectedEnvironment(home, new URL(baseUrl).origin, "bridge-jwt.payload.signature");

    const result = await runRawBridge([
      "query", "rainbond_query_teams", "--input", "-",
      "--skill-id", "rainbond-platform-query",
    ], { home, input: "{}" });

    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      items: [{ team_name: "default" }],
    });
    assert.deepEqual(
      requests.map((request) => request.body.params.name),
      ["rainbond_get_current_user", "rainbond_query_teams"]
    );
  });
});

test("protected context resolve obtains enterprise and auto-selects one workspace-region", async () => {
  await withRpcServer((record, response) => {
    const name = record.body.params.name;
    if (name === "rainbond_get_current_user") {
      rpcResult(response, record.body.id, {
        isError: false,
        structuredContent: { enterprise_id: "enterprise-1" },
      });
      return;
    }
    assert.equal(name, "rainbond_query_teams");
    assert.deepEqual(record.body.params.arguments, { enterprise_id: "enterprise-1" });
    rpcResult(response, record.body.id, {
      isError: false,
      structuredContent: {
        items: [{
          team_id: "team-1",
          team_name: "default",
          roles: ["owner"],
          region_list: [{ region_name: "rainbond", region_alias: "默认集群" }],
        }],
        total: 1,
        page: 1,
        page_size: 20,
      },
    });
  }, async (baseUrl, requests) => {
    const result = await runBridge([
      "context", "resolve", "--input", "-",
    ], {
      env: {
        RAINBOND_URL: new URL(baseUrl).origin,
        RAINBOND_JWT: "bridge-jwt.payload.signature",
      },
      input: JSON.stringify({ required: ["enterprise", "workspace"] }),
    });

    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.state, "resolved");
    assert.equal(payload.context.enterprise_id, "enterprise-1");
    assert.equal(payload.context.team_id, "team-1");
    assert.equal(payload.context.region_name, "rainbond");
    assert.deepEqual(requests.map((entry) => entry.body.params.name), [
      "rainbond_get_current_user",
      "rainbond_query_teams",
    ]);
  });
});

test("protected context resolve returns one combined workspace selection", async () => {
  await withRpcServer((record, response) => {
    const name = record.body.params.name;
    if (name === "rainbond_get_current_user") {
      rpcResult(response, record.body.id, {
        isError: false,
        structuredContent: { enterprise_id: "enterprise-1" },
      });
      return;
    }
    rpcResult(response, record.body.id, {
      isError: false,
      structuredContent: {
        items: [
          { team_id: "team-a", team_name: "dev-id", team_alias: "开发", roles: ["developer"], region_list: [{ region_name: "r1", region_alias: "北京" }] },
          { team_id: "team-b", team_name: "prod-id", team_alias: "生产", roles: ["owner"], region_list: [{ region_name: "r2", region_alias: "上海" }] },
        ],
        total: 2,
        page: 1,
        page_size: 20,
      },
    });
  }, async (baseUrl) => {
    const result = await runBridge([
      "context", "resolve", "--input", "-",
    ], {
      env: {
        RAINBOND_URL: new URL(baseUrl).origin,
        RAINBOND_JWT: "bridge-jwt.payload.signature",
      },
      input: JSON.stringify({ required: ["enterprise", "workspace"] }),
    });
    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.state, "needs-selection");
    assert.equal(payload.enterprise_id, "enterprise-1");
    assert.equal(payload.dimension, "workspace-region");
    assert.deepEqual(payload.options.map((entry) => entry.label), [
      "开发（dev-id） / 北京",
      "生产（prod-id） / 上海",
    ]);
  });
});

test("protected context resolve applies exact workspace hints without model-side matching", async () => {
  await withRpcServer((record, response) => {
    const name = record.body.params.name;
    if (name === "rainbond_get_current_user") {
      rpcResult(response, record.body.id, {
        isError: false,
        structuredContent: { enterprise_id: "enterprise-1" },
      });
      return;
    }
    rpcResult(response, record.body.id, {
      isError: false,
      structuredContent: {
        items: [
          { team_id: "d20f25f64cd04775b65b65f45dafc3e3", team_name: "default", region_list: [{ region_name: "rainbond" }] },
          { team_id: "oyql35juf6bb4fc7a5e7641bba37d922", team_name: "zqh", region_list: [{ region_name: "rainbond" }] },
        ],
      },
    });
  }, async (baseUrl) => {
    const result = await runBridge([
      "context", "resolve", "--input", "-",
    ], {
      env: {
        RAINBOND_URL: new URL(baseUrl).origin,
        RAINBOND_JWT: "bridge-jwt.payload.signature",
      },
      input: JSON.stringify({
        required: ["enterprise", "workspace"],
        hints: { team_name: "zqh", region_name: "rainbond" },
      }),
    });

    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      state: "resolved",
      context: {
        enterprise_id: "enterprise-1",
        team_id: "oyql35juf6bb4fc7a5e7641bba37d922",
        team_name: "zqh",
        region_name: "rainbond",
      },
    });
  });
});

test("protected context resolve blocks an explicit workspace hint that has no exact match", async () => {
  await withRpcServer((record, response) => {
    const name = record.body.params.name;
    if (name === "rainbond_get_current_user") {
      rpcResult(response, record.body.id, {
        isError: false,
        structuredContent: { enterprise_id: "enterprise-1" },
      });
      return;
    }
    rpcResult(response, record.body.id, {
      isError: false,
      structuredContent: {
        items: [{ team_id: "d20f25f64cd04775b65b65f45dafc3e3", team_name: "default", region_list: [{ region_name: "rainbond" }] }],
      },
    });
  }, async (baseUrl) => {
    const result = await runBridge([
      "context", "resolve", "--input", "-",
    ], {
      env: {
        RAINBOND_URL: new URL(baseUrl).origin,
        RAINBOND_JWT: "bridge-jwt.payload.signature",
      },
      input: JSON.stringify({
        required: ["enterprise", "workspace"],
        hints: { team_name: "zqh" },
      }),
    });

    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      state: "blocked",
      reason: "workspace-hint-not-found",
    });
  });
});

test("protected context resolve revalidates a selected workspace without persisting context", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "rainskills-stateless-context-"));
  await withRpcServer((record, response) => {
    const name = record.body.params.name;
    if (name === "rainbond_get_current_user") {
      rpcResult(response, record.body.id, {
        isError: false,
        structuredContent: { enterprise_id: "enterprise-1" },
      });
      return;
    }
    rpcResult(response, record.body.id, {
      isError: false,
      structuredContent: {
        items: [
          { team_id: "02b8b08236174ee399c714f7b9c3ec01", team_name: "dev", region_list: [{ region_name: "r1" }] },
          { team_id: "oyql35juf6bb4fc7a5e7641bba37d922", team_name: "zqh", region_list: [{ region_name: "rainbond" }] },
        ],
      },
    });
  }, async (baseUrl, requests) => {
    const env = {
      RAINBOND_URL: new URL(baseUrl).origin,
      RAINBOND_JWT: "bridge-jwt.payload.signature",
    };
    const pending = await runBridge([
      "context", "resolve", "--input", "-",
    ], {
      env,
      home,
      input: JSON.stringify({ required: ["enterprise", "workspace"] }),
    });
    assert.equal(pending.code, 0, pending.stderr);
    const pendingPayload = JSON.parse(pending.stdout);
    const option = pendingPayload.options.find((item) => item.team_name === "zqh");
    assert(option);

    const selected = await runBridge([
      "context", "resolve", "--input", "-",
    ], {
      env,
      home,
      input: JSON.stringify({
        required: ["enterprise", "workspace"],
        selection: { option_id: option.id },
      }),
    });

    assert.equal(selected.code, 0, selected.stderr);
    assert.deepEqual(JSON.parse(selected.stdout), {
      state: "resolved",
      context: {
        enterprise_id: "enterprise-1",
        team_id: "oyql35juf6bb4fc7a5e7641bba37d922",
        team_name: "zqh",
        region_name: "rainbond",
      },
    });
    assert.deepEqual(requests.map((entry) => entry.body.params.name), [
      "rainbond_get_current_user",
      "rainbond_query_teams",
      "rainbond_get_current_user",
      "rainbond_query_teams",
    ]);
    assert.equal(
      fs.existsSync(path.join(home, ".rainbond", "rainskills", "target-contexts-v1")),
      false,
    );
  });
});

test("protected context resolve rejects stale selections and unsupported input before network access", async () => {
  await withRpcServer((record, response) => {
    const name = record.body.params.name;
    if (name === "rainbond_get_current_user") {
      rpcResult(response, record.body.id, {
        isError: false,
        structuredContent: { enterprise_id: "enterprise-1" },
      });
      return;
    }
    rpcResult(response, record.body.id, {
      isError: false,
      structuredContent: {
        items: [{ team_id: "02b8b08236174ee399c714f7b9c3ec01", team_name: "default", region_list: [{ region_name: "rainbond" }] }],
      },
    });
  }, async (baseUrl, requests) => {
    const env = {
      RAINBOND_URL: new URL(baseUrl).origin,
      RAINBOND_JWT: "bridge-jwt.payload.signature",
    };
    const stale = await runBridge([
      "context", "resolve", "--input", "-",
    ], {
      env,
      input: JSON.stringify({
        required: ["enterprise", "workspace"],
        selection: { option_id: "missing-option" },
      }),
    });
    assert.equal(stale.code, 0, stale.stderr);
    assert.deepEqual(JSON.parse(stale.stdout), {
      state: "blocked",
      reason: "workspace-selection-invalid",
    });

    const beforeUnsupported = requests.length;
    const unsupported = await runBridge([
      "context", "resolve", "--input", "-",
    ], {
      env,
      input: JSON.stringify({
        enterprise: "好雨科技",
        workspace: "zqh",
      }),
    });
    assert.equal(unsupported.code, 2);
    const errorPayload = unsupported.stderr.trim().split("\n")
      .map((line) => JSON.parse(line))
      .find((payload) => payload.error);
    assert.deepEqual(errorPayload, {
      error: "context input fields are invalid",
      expected: {
        required: ["enterprise", "workspace"],
        hints: { team_name: "<team-name>" },
      },
      note: "enterprise is resolved from the current authenticated identity",
    });
    assert.equal(requests.length, beforeUnsupported);
  });
});

test("one-shot platform query rejects unbound tools before state or network access", async () => {
  await withRpcServer((_record, response) => {
    response.writeHead(500);
    response.end();
  }, async (baseUrl, requests) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "rainskills-one-shot-query-reject-"));
    prepareConnectedEnvironment(
      home,
      new URL(baseUrl).origin,
      "bridge-jwt.payload.signature"
    );
    const result = await runRawBridge([
      "query", "rainbond_create_app", "--input", "-",
      "--skill-id", "rainbond-platform-query",
    ], { home, input: "{}" });

    assert.equal(result.code, 2);
    assert.match(result.stderr, /platform query tool is not allowed/i);
    assert.equal(requests.length, 0);
    assert.equal(fs.existsSync(path.join(home, ".rainbond", "rainskills", "operations")), false);
  });
});

test("call removes sensitive fields from successful tool results before stdout", async () => {
  await withRpcServer((record, response) => {
    assert.equal(record.body.method, "tools/call");
    rpcResult(response, record.body.id, {
      isError: false,
      structuredContent: {
        region_name: "rainbond",
        token: "region-token",
        key_file: "private-key-material",
        certificate: "certificate-material",
        confirmation_token: "confirm-once",
        nested: { password: "nested-password", health_status: "ok" },
      },
    });
  }, async (baseUrl) => {
    const result = await runBridge(
      ["call", "rainbond_query_regions", "--input", "-"],
      { env: { RAINBOND_URL: baseUrl, RAINBOND_JWT: "jwt.payload.signature" }, input: "{}" }
    );
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      region_name: "rainbond",
      confirmation_token: "confirm-once",
      nested: { health_status: "ok" },
    });
    assert.doesNotMatch(result.stdout, /region-token|private-key-material|certificate-material|nested-password/);
  });
});

test("call redacts successful env results using their semantic env names", async () => {
  const rootPassword = "ROOT-PASSWORD-MUST-NOT-LEAK";
  const databasePassword = "DATABASE-PASSWORD-MUST-NOT-LEAK";

  await withRpcServer((record, response) => {
    assert.equal(record.body.method, "tools/call");
    rpcResult(response, record.body.id, {
      isError: false,
      structuredContent: {
        envs: [
          { name: "MYSQL_ROOT_PASSWORD", value: rootPassword },
          { attr_name: "DB_PASS", attr_value: databasePassword },
          { name: "MYSQL_DATABASE", value: "xpi" },
        ],
        summary: `configured ${rootPassword}`,
      },
    });
  }, async (baseUrl) => {
    const result = await runBridge(
      ["call", "rainbond_query_regions", "--input", "-"],
      {
        env: { RAINBOND_URL: baseUrl, RAINBOND_JWT: "jwt.payload.signature" },
        input: JSON.stringify({
          envs: [
            { attr_name: "MYSQL_ROOT_PASSWORD", attr_value: rootPassword },
            { attr_name: "DB_PASS", attr_value: databasePassword },
            { attr_name: "MYSQL_DATABASE", attr_value: "xpi" },
          ],
        }),
      }
    );

    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      envs: [
        { name: "MYSQL_ROOT_PASSWORD", value: "[REDACTED]" },
        { attr_name: "DB_PASS", attr_value: "[REDACTED]" },
        { name: "MYSQL_DATABASE", value: "xpi" },
      ],
      summary: "configured [REDACTED]",
    });
    assert.doesNotMatch(result.stdout, /ROOT-PASSWORD-MUST-NOT-LEAK|DATABASE-PASSWORD-MUST-NOT-LEAK/);
  });
});

test("call preserves only the explicit unauthenticated package upload mode", async () => {
  await withRpcServer((record, response) => {
    assert.equal(record.body.method, "tools/call");
    rpcResult(response, record.body.id, {
      isError: false,
      structuredContent: {
        event_id: "upload-event",
        upload_request: {
          method: "POST",
          authorization: "none",
          nested: { authorization: "Bearer nested-secret" },
        },
        authorization: "Bearer root-secret",
        unsafe_upload_request: {
          authorization: "bearer",
        },
      },
    });
  }, async (baseUrl) => {
    const result = await runBridge(
      ["read", "rainbond_query_package_upload_contract", "--input", "-"],
      { env: { RAINBOND_URL: baseUrl, RAINBOND_JWT: "jwt.payload.signature" }, input: "{}" }
    );
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      event_id: "upload-event",
      upload_request: {
        method: "POST",
        authorization: "none",
        nested: {},
      },
      unsafe_upload_request: {},
    });
    assert.doesNotMatch(result.stdout, /root-secret|nested-secret|bearer/i);
  });
});

test("package-upload resolves the Console origin from the single runtime", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "rainskills-package-upload-home-"));
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "rainskills-package-upload-workspace-"));
  const archive = path.join(workspace, "web release.zip");
  const fakeBin = path.join(workspace, "bin");
  const curlLog = path.join(workspace, "curl-argv.json");
  fs.writeFileSync(archive, "package-bytes");
  fs.mkdirSync(fakeBin);
  const curl = path.join(fakeBin, "curl");
  fs.writeFileSync(
    curl,
    [
      `#!${process.execPath}`,
      `require("node:fs").writeFileSync(${JSON.stringify(curlLog)}, JSON.stringify(process.argv.slice(2)));`,
      "",
    ].join("\n"),
    { mode: 0o755 }
  );
  prepareProtectedRuntime(home, {
    RAINBOND_URL: "https://console.example/base",
    RAINBOND_JWT: "jwt.payload.signature",
  });

  const result = await runBridge(
    ["package-upload", "--archive", archive, "--input", "-"],
    {
      home,
      env: {
        PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ""}`,
        RAINBOND_URL: "",
        RAINBOND_JWT: "",
      },
      input: JSON.stringify({
        url: "/console/upload/events/e1",
        url_scope: "console_origin",
        method: "POST",
        content_type: "multipart/form-data",
        file_field: "packageTarFile",
        authorization: "none",
        timeout: 30,
      }),
    }
  );

  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { uploaded: true });
  const curlArgv = JSON.parse(fs.readFileSync(curlLog, "utf8"));
  assert.equal(curlArgv.at(-1), "https://console.example/console/upload/events/e1");
  assert.equal(curlArgv.some((value) => /jwt|authorization/i.test(value)), false);
});

test("call rejects local JSON file paths and never opens a network connection", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rainskills-bridge-input-"));
  const inputPath = path.join(tempDir, "input.json");
  fs.writeFileSync(inputPath, JSON.stringify({ team_name: "demo" }));

  await withRpcServer((_record, _response) => {
    assert.fail("stdin-only validation must run before sending a request");
  }, async (baseUrl, requests) => {
    const result = await runBridge(
      ["call", "rainbond_query_apps", "--input", inputPath],
      { env: { RAINBOND_URL: baseUrl, RAINBOND_JWT: "very-secret-jwt.payload.signature" } }
    );
    assert.equal(result.code, 2);
    assert.doesNotMatch(result.stderr, new RegExp(inputPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.equal(requests.length, 0);
  });
});

test("protected runtime environment carries the previously confirmed HTTP policy", async () => {
  await withRpcServer((record, response) => {
    rpcResult(response, record.body.id, { tools: [] });
  }, async (baseUrl, requests) => {
    const allowed = await runBridge(["status"], {
      env: {
        RAINBOND_URL: baseUrl,
        RAINBOND_JWT: "jwt.payload.signature",
        RAINBOND_ALLOW_INSECURE_HTTP: "true",
      },
    });
    assert.equal(allowed.code, 0, allowed.stderr);
    assert.match(allowed.stderr, /insecure HTTP/i);
    assert.equal(requests.length, 1);
  });
});

test("usage, input, configuration, transport, and tool errors have stable exit codes", async () => {
  for (const rejectedArgs of [
    ["call", "rainbond_create_app", "--token", "cli-secret"],
    ["list", "--url", "https://example.com/?token=query-secret"],
    ["status", "--jwt", "body-secret"],
  ]) {
    const rejected = await runBridge(rejectedArgs);
    assert.equal(rejected.code, 2);
    assert.doesNotMatch(rejected.stderr, /cli-secret|query-secret|body-secret/);
  }

  const unsafeUrl = await runBridge(["status"], {
    env: {
      RAINBOND_URL: "https://example.com/?token=query-secret",
      RAINBOND_JWT: "jwt.payload.signature",
    },
  });
  assert.equal(unsafeUrl.code, 3);
  assert.doesNotMatch(unsafeUrl.stderr, /query-secret/);

  const badInput = await runBridge(
    ["call", "rainbond_create_app", "--input", "-"],
    { input: '{"password":"not-json"' }
  );
  assert.equal(badInput.code, 2);
  assert.doesNotMatch(badInput.stderr, /not-json|password/);

  const missingConfig = await runBridge(["status"], {
    env: { HOME: fs.mkdtempSync(path.join(os.tmpdir(), "rainskills-no-config-")), RAINBOND_URL: "", RAINBOND_JWT: "" },
  });
  assert.equal(missingConfig.code, 3);

  await withRpcServer((_record, response) => {
    response.writeHead(401, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ detail: "token very-secret-jwt expired" }));
  }, async (baseUrl) => {
    const auth = await runBridge(["status"], {
      env: { RAINBOND_URL: baseUrl, RAINBOND_JWT: "very-secret-jwt.payload.signature" },
    });
    assert.equal(auth.code, 3);
    assert.doesNotMatch(auth.stderr, /very-secret-jwt/);
  });

  await withRpcServer((_record, response) => {
    response.writeHead(404, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ detail: "not found" }));
  }, async (baseUrl, requests) => {
    const endpoint = await runBridge(["status"], {
      env: { RAINBOND_URL: new URL(baseUrl).origin, RAINBOND_JWT: "jwt.payload.signature" },
    });
    assert.equal(endpoint.code, 4);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, "/console/mcp/rainskills/api/query");
  });

  await withRpcServer((record, response) => {
    if (record.body.method === "tools/list") {
      rpcResult(response, record.body.id, {
        tools: [{
          name: "rainbond_create_app",
          inputSchema: { type: "object", properties: { password: { type: "string" } } },
        }],
      });
      return;
    }
    rpcResult(response, record.body.id, {
      isError: true,
      structuredContent: {
        status_code: 400,
        msg_show: "invalid input",
        arguments: { password: "echoed-argument" },
      },
    });
  }, async (baseUrl) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "rainskills-bridge-operation-"));
    const pending = await runBridge(
      ["call", "rainbond_create_app", "--input", "-"],
      {
        env: { RAINBOND_URL: baseUrl, RAINBOND_JWT: "jwt.payload.signature" },
        home,
        input: JSON.stringify({ password: "echoed-argument" }),
      }
    );
    assert.equal(pending.code, 0, pending.stderr);
    const { confirmation_id: operationId } = JSON.parse(pending.stdout);
    const business = await runBridge(
      ["call", "rainbond_create_app", "--input", "-", "--confirm", operationId],
      {
        env: { RAINBOND_URL: baseUrl, RAINBOND_JWT: "jwt.payload.signature" },
        home,
        input: JSON.stringify({ password: "echoed-argument" }),
      }
    );
    assert.equal(business.code, 5);
    assert.doesNotMatch(business.stderr, /echoed-argument/);
    const errorLines = business.stderr.trim().split("\n");
    assert.deepEqual(JSON.parse(errorLines.at(-1)), {
      status_code: 400,
      msg_show: "invalid input",
      arguments: "[REDACTED]",
    });
  });
});

test("protocol errors and missing tools are distinguished", async () => {
  await withRpcServer((_record, response) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end("not-json");
  }, async (baseUrl) => {
    const malformed = await runBridge(["status"], {
      env: { RAINBOND_URL: baseUrl, RAINBOND_JWT: "jwt.payload.signature" },
    });
    assert.equal(malformed.code, 4);
  });

  await withRpcServer((record, response) => {
    rpcResult(response, record.body.id, { tools: [] });
  }, async (baseUrl) => {
    const missing = await runBridge(["describe", "rainbond_removed_tool"], {
      env: { RAINBOND_URL: baseUrl, RAINBOND_JWT: "jwt.payload.signature" },
    });
    assert.equal(missing.code, 5);
  });

  for (const code of [-32700, -32600, -32601]) {
    await withRpcServer((record, response) => {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        jsonrpc: "2.0",
        id: record.body.id,
        error: { code, message: "protocol mismatch" },
      }));
    }, async (baseUrl) => {
      const rpcError = await runBridge(["list"], {
        env: { RAINBOND_URL: baseUrl, RAINBOND_JWT: "jwt.payload.signature" },
      });
      assert.equal(rpcError.code, 4, `JSON-RPC code ${code}`);
    });
  }

  for (const rpcErrorFixture of [
    { code: -32602, message: "bad arguments" },
    { code: 404, message: "tool not found" },
    { code: 409, message: "business conflict" },
  ]) {
    await withRpcServer((record, response) => {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        jsonrpc: "2.0",
        id: record.body.id,
        error: rpcErrorFixture,
      }));
    }, async (baseUrl) => {
      const rpcError = await runBridge(["list"], {
        env: { RAINBOND_URL: baseUrl, RAINBOND_JWT: "jwt.payload.signature" },
      });
      assert.equal(rpcError.code, 5, `JSON-RPC code ${rpcErrorFixture.code}`);
    });
  }
});

test("input and response bodies have fixed byte limits", async () => {
  const {
    INPUT_MAX_BYTES,
    RESPONSE_MAX_BYTES,
    rpcRequest,
  } = require(bridgePath);
  assert.equal(INPUT_MAX_BYTES, 1024 * 1024);
  assert.equal(RESPONSE_MAX_BYTES, 10 * 1024 * 1024);

  const oversizedInput = JSON.stringify({ value: "x".repeat(INPUT_MAX_BYTES) });
  const inputResult = await runBridge(
    ["call", "rainbond_create_app", "--input", "-"],
    {
      env: {
        RAINBOND_URL: "https://console.example",
        RAINBOND_JWT: "jwt.payload.signature",
      },
      input: oversizedInput,
    }
  );
  assert.equal(inputResult.code, 2);

  await withRpcServer((record, response) => {
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: record.body.id,
      result: { tools: [{ name: "x".repeat(256) }] },
    });
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(body);
  }, async (baseUrl) => {
    await assert.rejects(
      rpcRequest(
        { baseUrl, jwt: "jwt.payload.signature" },
        "tools/list",
        {},
        { maxResponseBytes: 64, timeoutMs: 1_000 }
      ),
      (error) => error.exitCode === 4 && /large/i.test(error.message)
    );
  });
});

test("request timeout is wall-clock based even when the response keeps dripping", async () => {
  const { rpcRequest } = require(bridgePath);
  await withRpcServer((_record, response) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.write('{"jsonrpc":"2.0",');
    const interval = setInterval(() => response.write(" "), 10);
    const finish = setTimeout(() => response.end('"never":"complete"}'), 300);
    response.on("close", () => {
      clearInterval(interval);
      clearTimeout(finish);
    });
  }, async (baseUrl) => {
    const started = Date.now();
    await assert.rejects(
      rpcRequest(
        { baseUrl, jwt: "jwt.payload.signature" },
        "tools/list",
        {},
        { timeoutMs: 60, maxResponseBytes: 1024 }
      ),
      (error) => error.exitCode === 4 && /timed out/i.test(error.message)
    );
    assert(Date.now() - started < 220, "wall-clock timeout should not wait for the drip to end");
  });
});

test("aborted and incomplete HTTP responses fail cleanly", async () => {
  const { rpcRequest } = require(bridgePath);
  for (const termination of ["aborted", "incomplete-close"]) {
    await withRpcServer((_record, response) => {
      response.writeHead(200, {
        "Content-Type": "application/json",
        "Content-Length": "4096",
      });
      response.write('{"jsonrpc":"2.0"');
      if (termination === "aborted") {
        response.destroy();
      } else {
        response.socket.end();
      }
    }, async (baseUrl) => {
      await assert.rejects(
        rpcRequest(
          { baseUrl, jwt: "jwt.payload.signature" },
          "tools/list",
          {},
          { timeoutMs: 500, maxResponseBytes: 1024 }
        ),
        (error) => error.exitCode === 4,
        termination
      );
    });
  }
});

test("dedicated endpoint preserves a Console base path prefix", async () => {
  const { rpcRequest } = require(bridgePath);
  await withRpcServer((record, response) => {
    rpcResult(response, record.body.id, { tools: [] });
  }, async (serverBaseUrl, requests) => {
    const origin = new URL(serverBaseUrl).origin;
    for (const [basePath, expectedPath] of [
      ["", "/console/mcp/rainskills/api/query"],
      ["/prefix", "/prefix/console/mcp/rainskills/api/query"],
      ["/prefix/", "/prefix/console/mcp/rainskills/api/query"],
    ]) {
      const result = await rpcRequest(
        { baseUrl: `${origin}${basePath}`, jwt: "jwt.payload.signature" },
        "tools/list",
        {},
        { timeoutMs: 1_000 }
      );
      assert.deepEqual(result, { tools: [] });
      assert.equal(requests.at(-1).url, expectedPath);
    }
  });
});

test("catalog context measurements report reproducible UTF-8 bytes and ratios", (t) => {
  const report = measureContextBytes(CONTEXT_MEASUREMENT_FIXTURE);

  assert.deepEqual(report, {
    unit: "utf8_bytes",
    full_catalog_bytes: 5666,
    compact_list_bytes: 325,
    one_tool_schema_bytes: 470,
    structured_call_result_bytes: 50,
    compact_list_ratio: 0.0574,
    one_tool_schema_ratio: 0.083,
    structured_call_result_ratio: 0.0088,
    compact_list_plus_five_average_schemas_ratio: 0.4723,
  });
  assert.equal(Object.hasOwn(report, "token_count"), false);

  t.diagnostic(`catalog context serialization: ${JSON.stringify(report)}`);
});
