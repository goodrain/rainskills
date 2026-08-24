const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const test = require("node:test");

const repoRoot = path.resolve(__dirname, "..");
const bridgePath = path.join(repoRoot, "bin", "rainskills-tools.js");

function writeSkillManifest(home) {
  const directory = path.join(home, ".rainbond", "bin");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const skills = ["rainbond-app-assistant", "rainbond-fullstack-bootstrap"].map((id) => {
    const content = `# ${id}\n`;
    return {
      id,
      name: id,
      profile: "cli",
      package_version: "1.0.0",
      source_revision: null,
      content_sha256: require("node:crypto").createHash("sha256").update(content).digest("hex"),
      bundle_sha256: "b".repeat(64),
      content,
    };
  });
  const target = path.join(directory, "rainskills-skill-manifest.json");
  fs.writeFileSync(target, JSON.stringify({
    schema: "rainskills.skill-manifest.v1",
    profile: "cli",
    package_version: "1.0.0",
    source_revision: null,
    skills,
  }), { mode: 0o600 });
  fs.chmodSync(target, 0o600);
  return target;
}

function runBridge(args, {
  env = {}, input = "", allowInsecureHttp = true, home, attachSkill = true,
} = {}) {
  return new Promise((resolve, reject) => {
    const homeDirectory = home || fs.mkdtempSync(path.join(os.tmpdir(), "rainskills-bridge-home-"));
    let effectiveArgs = args;
    if (args[0] === "call" && attachSkill && !args.includes("--skill-id")) {
      writeSkillManifest(homeDirectory);
      effectiveArgs = [...args, "--skill-id", "rainbond-app-assistant"];
    }
    const child = spawn(process.execPath, [bridgePath, ...effectiveArgs], {
      cwd: repoRoot,
      env: {
        ...process.env,
        HOME: homeDirectory,
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

test("configuration safely parses mcp.env and lets environment values win", () => {
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
  const config = loadConfig({
    env: { RAINBOND_URL: "https://from-env.example/root" },
    homeDir: tempHome,
  });

  assert.deepEqual(config, {
    baseUrl: "https://from-env.example/root",
    jwt: "file-token'suffix",
  });
  assert.equal(REQUEST_TIMEOUT_MS, 180_000);
  assert.equal(fs.existsSync(marker), false);
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
    assert.equal(record.headers.authorization, "GRJWT bridge-jwt");
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
    const env = { RAINBOND_URL: new URL(baseUrl).origin, RAINBOND_JWT: "bridge-jwt" };
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "rainskills-bridge-catalog-"));

    const status = await runBridge(["status"], { env, home });
    assert.equal(status.code, 0, status.stderr);
    const statusPayload = JSON.parse(status.stdout);
    assert.equal(statusPayload.status, "ok");
    assert.equal(statusPayload.cli_version, "2.2.0");
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
      ["call", "rainbond_create_app", "--input", "-", "--confirm", confirmationPayload.operation_id],
      { env, home, input: JSON.stringify({ app_name: "different-target" }) }
    );
    assert.equal(swappedArguments.code, 2);
    assert.match(swappedArguments.stderr, /arguments.*match|confirmation.*match/i);
    assert.equal(requests.length, 1, "changed arguments must be rejected before execution");

    const call = await runBridge(
      ["call", "rainbond_create_app", "--input", "-", "--confirm", confirmationPayload.operation_id],
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
    assert.equal(record.body.method, "tools/call");
    setTimeout(() => {
      rpcResult(response, record.body.id, {
        isError: false,
        structuredContent: { app_id: 42 },
      });
    }, 100);
  }, async (baseUrl, requests) => {
    const env = { RAINBOND_URL: baseUrl, RAINBOND_JWT: "jwt" };
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "rainskills-bridge-claim-"));
    const input = JSON.stringify({ app_name: "demo" });
    const pending = await runBridge(
      ["call", "rainbond_create_app", "--input", "-"],
      { env, home, input }
    );
    assert.equal(pending.code, 0, pending.stderr);
    const { operation_id: operationId } = JSON.parse(pending.stdout);

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
    assert.equal(requests.length, 1, "the confirmed write must execute at most once");
  });
});

test("confirmed writes bind the active Skill and send namespaced audit metadata", async () => {
  await withRpcServer((record, response) => {
    assert.equal(record.body.method, "tools/call");
    assert.deepEqual(record.body.params.arguments, { app_name: "demo" });
    assert.equal(record.body.params.arguments._meta, undefined);
    const metadata = record.body.params._meta["com.rainbond/rainskills"];
    assert.equal(metadata.schema, "rainskills.operation-meta.v1");
    assert.equal(metadata.confirmation_type, "rainskills_cli");
    assert.equal(metadata.root_skill_id, "rainbond-app-assistant");
    assert.equal(metadata.skill.id, "rainbond-fullstack-bootstrap");
    assert.equal(metadata.skill.profile, "cli");
    assert.equal(metadata.skill.content, "# rainbond-fullstack-bootstrap\n");
    rpcResult(response, record.body.id, {
      isError: false,
      structuredContent: { app_id: 42 },
    });
  }, async (baseUrl, requests) => {
    const env = { RAINBOND_URL: baseUrl, RAINBOND_JWT: "jwt" };
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "rainskills-bridge-skill-audit-"));
    writeSkillManifest(home);
    const skillArgs = [
      "--skill-id", "rainbond-fullstack-bootstrap",
      "--root-skill-id", "rainbond-app-assistant",
    ];
    const input = JSON.stringify({ app_name: "demo" });
    const pending = await runBridge(
      ["call", "rainbond_create_app", "--input", "-", ...skillArgs],
      { env, home, input }
    );
    assert.equal(pending.code, 0, pending.stderr);
    const operationId = JSON.parse(pending.stdout).operation_id;

    const confirmed = await runBridge(
      ["call", "rainbond_create_app", "--input", "-", ...skillArgs, "--confirm", operationId],
      { env, home, input }
    );
    assert.equal(confirmed.code, 0, confirmed.stderr);
    assert.equal(requests.length, 1);
    assert.equal(
      requests[0].body.params._meta["com.rainbond/rainskills"].operation_id,
      operationId
    );
  });
});

test("mutable calls reject missing, changed, or unsafe Skill bindings before network access", async () => {
  await withRpcServer((_record, response) => {
    rpcResult(response, 1, { isError: false, structuredContent: { ok: true } });
  }, async (baseUrl, requests) => {
    const env = { RAINBOND_URL: baseUrl, RAINBOND_JWT: "jwt" };
    const input = JSON.stringify({ app_name: "demo" });
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "rainskills-bridge-skill-guard-"));
    writeSkillManifest(home);

    const missing = await runBridge(
      ["call", "rainbond_create_app", "--input", "-"],
      { env, home, input, attachSkill: false }
    );
    assert.equal(missing.code, 2);
    assert.match(missing.stderr, /skill-id/i);

    const pending = await runBridge(
      ["call", "rainbond_create_app", "--input", "-", "--skill-id", "rainbond-app-assistant"],
      { env, home, input }
    );
    assert.equal(pending.code, 0, pending.stderr);
    const operationId = JSON.parse(pending.stdout).operation_id;
    const changed = await runBridge([
      "call", "rainbond_create_app", "--input", "-",
      "--skill-id", "rainbond-fullstack-bootstrap", "--confirm", operationId,
    ], { env, home, input });
    assert.equal(changed.code, 2);
    assert.match(changed.stderr, /confirmation|skill/i);

    fs.chmodSync(path.join(home, ".rainbond", "bin", "rainskills-skill-manifest.json"), 0o644);
    const unsafe = await runBridge(
      ["call", "rainbond_create_app", "--input", "-", "--skill-id", "rainbond-app-assistant"],
      { env, home, input }
    );
    assert.equal(unsafe.code, 3);
    assert.match(unsafe.stderr, /manifest/i);
    assert.equal(requests.length, 0);
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
    const env = { RAINBOND_URL: new URL(baseUrl).origin, RAINBOND_JWT: "bridge-jwt" };
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

test("argument-aware classification matches Console mixed and side-effecting tools", () => {
  const { classifyTool } = require(bridgePath);

  assert.equal(
    classifyTool("rainbond_manage_component_envs", { operation: "summary" }),
    "read"
  );
  assert.equal(
    classifyTool("rainbond_manage_component_envs", { operation: "delete" }),
    "destructive"
  );
  assert.equal(
    classifyTool("rainbond_manage_component_probe", { operation: "get" }),
    "read"
  );
  assert.equal(classifyTool("rainbond_get_component_check_result", {}), "write");
  assert.equal(classifyTool("rainbond_get_yaml_app_check_result", {}), "write");
  assert.equal(classifyTool("rainbond_exec", {}), "write");
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
      { env: { RAINBOND_URL: baseUrl, RAINBOND_JWT: "jwt" }, input: "{}" }
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

test("call rejects local JSON file paths and never opens a network connection", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rainskills-bridge-input-"));
  const inputPath = path.join(tempDir, "input.json");
  fs.writeFileSync(inputPath, JSON.stringify({ team_name: "demo" }));

  await withRpcServer((_record, _response) => {
    assert.fail("stdin-only validation must run before sending a request");
  }, async (baseUrl, requests) => {
    const result = await runBridge(
      ["call", "rainbond_query_apps", "--input", inputPath],
      { env: { RAINBOND_URL: baseUrl, RAINBOND_JWT: "very-secret-jwt" } }
    );
    assert.equal(result.code, 2);
    assert.doesNotMatch(result.stderr, new RegExp(inputPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.equal(requests.length, 0);
  });
});

test("HTTP is rejected unless insecure HTTP is explicitly authorized", async () => {
  await withRpcServer((_record, _response) => {
    assert.fail("HTTP must be rejected before sending a JWT");
  }, async (baseUrl, requests) => {
    const blocked = await runBridge(["status"], {
      env: { RAINBOND_URL: baseUrl, RAINBOND_JWT: "jwt" },
      allowInsecureHttp: false,
    });
    assert.equal(blocked.code, 3);
    assert.match(blocked.stderr, /HTTPS|insecure/i);
    assert.equal(requests.length, 0);
  });

  await withRpcServer((record, response) => {
    rpcResult(response, record.body.id, { tools: [] });
  }, async (baseUrl, requests) => {
    const allowed = await runBridge(["status"], {
      env: {
        RAINBOND_URL: baseUrl,
        RAINBOND_JWT: "jwt",
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
      RAINBOND_JWT: "jwt",
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
      env: { RAINBOND_URL: baseUrl, RAINBOND_JWT: "very-secret-jwt" },
    });
    assert.equal(auth.code, 3);
    assert.doesNotMatch(auth.stderr, /very-secret-jwt/);
  });

  await withRpcServer((_record, response) => {
    response.writeHead(404, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ detail: "not found" }));
  }, async (baseUrl, requests) => {
    const endpoint = await runBridge(["status"], {
      env: { RAINBOND_URL: new URL(baseUrl).origin, RAINBOND_JWT: "jwt" },
    });
    assert.equal(endpoint.code, 4);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, "/console/mcp/rainskills/api/query");
  });

  await withRpcServer((record, response) => {
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
        env: { RAINBOND_URL: baseUrl, RAINBOND_JWT: "jwt" },
        home,
        input: JSON.stringify({ password: "echoed-argument" }),
      }
    );
    assert.equal(pending.code, 0, pending.stderr);
    const { operation_id: operationId } = JSON.parse(pending.stdout);
    const business = await runBridge(
      ["call", "rainbond_create_app", "--input", "-", "--confirm", operationId],
      {
        env: { RAINBOND_URL: baseUrl, RAINBOND_JWT: "jwt" },
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
      env: { RAINBOND_URL: baseUrl, RAINBOND_JWT: "jwt" },
    });
    assert.equal(malformed.code, 4);
  });

  await withRpcServer((record, response) => {
    rpcResult(response, record.body.id, { tools: [] });
  }, async (baseUrl) => {
    const missing = await runBridge(["describe", "rainbond_removed_tool"], {
      env: { RAINBOND_URL: baseUrl, RAINBOND_JWT: "jwt" },
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
        env: { RAINBOND_URL: baseUrl, RAINBOND_JWT: "jwt" },
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
        env: { RAINBOND_URL: baseUrl, RAINBOND_JWT: "jwt" },
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
        RAINBOND_JWT: "jwt",
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
        { baseUrl, jwt: "jwt" },
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
        { baseUrl, jwt: "jwt" },
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
          { baseUrl, jwt: "jwt" },
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
        { baseUrl: `${origin}${basePath}`, jwt: "jwt" },
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
