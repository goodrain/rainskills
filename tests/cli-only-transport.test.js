"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const test = require("node:test");

const repoRoot = path.resolve(__dirname, "..");
const cliPath = path.join(repoRoot, "bin", "rainskills-tools.js");
const launcherPath = path.join(repoRoot, "bin", "rainskills.js");
const ENVIRONMENT_ID = "11111111-1111-4111-8111-111111111111";
const OPERATION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const JWT = "eyJhbGciOiJub25lIn0.eyJzdWIiOiJ0ZXN0In0.signature";

function runCli(args, { home, input = "" } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
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
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

function createProtectedOperation(home, origin) {
  const { createPortableSecureStateStore } = require("./helpers/portable-secure-state.js");
  const { createEnvironmentRegistry } = require(
    "../rainbond-platform-installer/scripts/environment-registry.js"
  );
  const { createEnvironmentCredentialStore } = require(
    "../rainbond-platform-installer/scripts/environment-credentials.js"
  );
  const { createRuntimeOperationStore } = require(
    "../rainbond-platform-installer/scripts/runtime-operations.js"
  );
  const stateStore = createPortableSecureStateStore(home);
  const registry = createEnvironmentRegistry({
    home,
    stateStore,
    randomUUID: () => ENVIRONMENT_ID,
  });
  const environment = registry.add({
    kind: "private",
    consoleOrigin: origin,
    connectionState: "connected",
    name: "测试环境",
  }).environment;
  createEnvironmentCredentialStore({ home, stateStore }).write({
    environmentId: environment.id,
    origin,
    token: JWT,
  });
  createRuntimeOperationStore({ home, stateStore, registry }).begin({
    operationId: OPERATION_ID,
    environmentId: environment.id,
    intent: { type: "deploy", project_root: "/workspace/demo" },
  });
}

function installSkillManifest(home) {
  const directory = path.join(home, ".rainbond", "bin");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const content = "---\nname: rainbond-app-assistant\n---\n# App assistant\n";
  const digest = require("node:crypto").createHash("sha256").update(content).digest("hex");
  fs.writeFileSync(path.join(directory, "rainskills-skill-manifest.json"), `${JSON.stringify({
    schema: "rainskills.skill-manifest.v1",
    profile: "cli",
    package_version: "0.1.7",
    source_revision: null,
    skills: [{
      id: "rainbond-app-assistant",
      name: "rainbond-app-assistant",
      profile: "cli",
      package_version: "0.1.7",
      source_revision: null,
      content_sha256: digest,
      bundle_sha256: "a".repeat(64),
      content,
    }],
  })}\n`, { mode: 0o600 });
}

async function withServer(callback) {
  const requests = [];
  const server = http.createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      requests.push({
        url: request.url,
        authorization: request.headers.authorization,
        body: JSON.parse(body),
      });
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: { tools: [{
          name: "rainbond_query_apps",
          description: "query apps",
          inputSchema: { type: "object" },
        }] },
      }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    await callback(origin, requests);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("every tools command requires one protected runtime operation and Skill", async () => {
  await withServer(async (origin, requests) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "rainskills-cli-operation-"));
    createProtectedOperation(home, origin);

    const result = await runCli([
      "status", "--operation-id", OPERATION_ID,
      "--skill-id", "rainbond-app-assistant",
    ], { home });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).operation_id, OPERATION_ID);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, "/console/mcp/rainskills/api/query");
    assert.equal(requests[0].authorization, `GRJWT ${JWT}`);

    const missingSkill = await runCli([
      "status", "--operation-id", OPERATION_ID,
    ], { home });
    assert.equal(missingSkill.code, 2);
    assert.match(missingSkill.stderr, /skill-id/i);

    const missingOperation = await runCli([
      "status", "--skill-id", "rainbond-app-assistant",
    ], { home });
    assert.equal(missingOperation.code, 2);
    assert.match(missingOperation.stderr, /operation/i);
    assert.equal(requests.length, 1);
  });
});

test("launcher has no local MCP server entry point", () => {
  const { resolveInvocation } = require(launcherPath);
  assert.throws(() => resolveInvocation(["mcp", "serve", "--client", "codex"]), /不再提供本地 MCP|invalid|无效/i);
  const source = fs.readFileSync(launcherPath, "utf8");
  assert.doesNotMatch(source, /mcp-server\.js|mcp-router\.js/);
});

test("mutable calls are bound to the protected intent Skill and send audited metadata", async () => {
  const requests = [];
  const server = http.createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const rpc = JSON.parse(body);
      requests.push(rpc);
      response.writeHead(200, { "Content-Type": "application/json" });
      if (rpc.method === "tools/list") {
        response.end(JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: {
            tools: [{
              name: "rainbond_create_app",
              inputSchema: { type: "object", properties: { app_name: { type: "string" } } },
            }],
          },
        }));
        return;
      }
      response.end(JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: { isError: false, structuredContent: { app_id: "app-1" } },
      }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const origin = `http://127.0.0.1:${server.address().port}`;
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "rainskills-cli-audit-"));
    createProtectedOperation(home, origin);
    installSkillManifest(home);
    const input = JSON.stringify({ app_name: "demo" });

    const proposed = await runCli([
      "call", "rainbond_create_app", "--input", "-",
      "--operation-id", OPERATION_ID,
      "--skill-id", "rainbond-app-assistant",
    ], { home, input });
    assert.equal(proposed.code, 0, proposed.stderr);
    const confirmationId = JSON.parse(proposed.stdout).confirmation_id;
    assert.match(confirmationId, /^[0-9a-f-]{36}$/);
    const localOperation = JSON.parse(fs.readFileSync(path.join(
      home,
      ".rainbond",
      "operations",
      `${confirmationId}.json`
    ), "utf8"));
    assert.equal(localOperation.runtime_operation_id, OPERATION_ID);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].method, "tools/list");

    const executed = await runCli([
      "call", "rainbond_create_app", "--input", "-",
      "--operation-id", OPERATION_ID,
      "--skill-id", "rainbond-app-assistant",
      "--confirm", confirmationId,
    ], { home, input });
    assert.equal(executed.code, 0, executed.stderr);
    assert.equal(requests.length, 2);
    const metadata = requests[1].params._meta["com.rainbond/rainskills"];
    assert.equal(metadata.schema, "rainskills.operation-meta.v1");
    assert.equal(metadata.operation_id, confirmationId);
    assert.equal(Object.hasOwn(metadata, "runtime_operation_id"), false);
    assert.equal(metadata.skill.id, "rainbond-app-assistant");
    assert.equal(metadata.skill.content.includes("# App assistant"), true);

    const wrong = await runCli([
      "call", "rainbond_create_app", "--input", "-",
      "--operation-id", OPERATION_ID,
      "--skill-id", "rainbond-template-installer",
    ], { home, input });
    assert.equal(wrong.code, 3);
    assert.match(wrong.stderr, /Skill.*operation|intent|不匹配/i);
    assert.equal(requests.length, 2);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("distribution contains open-source deployment and excludes the local MCP implementation", () => {
  const packageInfo = require("../package.json");
  assert(packageInfo.files.includes("rainbond-opensource-app-deploy/"));
  assert.equal(packageInfo.dependencies?.["@modelcontextprotocol/sdk"], undefined);
  assert.equal(fs.existsSync(path.join(
    repoRoot,
    "rainbond-platform-installer",
    "scripts",
    "mcp-server.js"
  )), false);
  assert.equal(fs.existsSync(path.join(
    repoRoot,
    "rainbond-platform-installer",
    "scripts",
    "mcp-router.js"
  )), false);
});
