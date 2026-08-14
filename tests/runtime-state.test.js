"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const runtimeStatePath = path.resolve(
  __dirname,
  "..",
  "rainbond-platform-installer",
  "scripts",
  "runtime-state.js"
);
const { createPortableSecureStateStore } = require("./helpers/portable-secure-state.js");

function temporaryHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "rainskills-runtime-state-"));
}

function connectedInput() {
  return {
    target_client: "codex",
    environment_kind: "saas",
    console_origin: "https://console.rainbond.com",
    intent: { type: "query", operation: "summary" },
    operation_id: "1d6754d6-6fb3-4bda-9a04-15c2d261d178",
  };
}

test("historical mcp.env cannot bypass not_started", async () => {
  const { createRuntimeStateManager } = require(runtimeStatePath);
  const home = temporaryHome();
  fs.mkdirSync(path.join(home, ".rainbond"), { mode: 0o700 });
  fs.writeFileSync(path.join(home, ".rainbond", "mcp.env"), "RAINBOND_JWT=historical\n", { mode: 0o600 });
  let probes = 0;
  const manager = createRuntimeStateManager({
    home,
    stateStore: createPortableSecureStateStore(home),
    liveProbe: async () => { probes += 1; return true; },
  });

  assert.deepEqual(await manager.status(), {
    schema: "rainskills.runtime-status.v1",
    state: "not_started",
    usable: false,
  });
  assert.equal(probes, 0);
});

test("runtime status is usable only after connected state passes a live probe", async () => {
  const { createRuntimeStateManager } = require(runtimeStatePath);
  const home = temporaryHome();
  let probeOk = true;
  let clock = 0;
  const manager = createRuntimeStateManager({
    home,
    stateStore: createPortableSecureStateStore(home),
    liveProbe: async () => probeOk,
    now: () => new Date(Date.UTC(2026, 7, 14, 0, 0, clock++)).toISOString(),
  });

  assert.equal(manager.startConnecting(connectedInput()).state, "connecting");
  probeOk = false;
  await assert.rejects(() => manager.markConnected(connectedInput()), /probe|验证/i);
  assert.equal(manager.read().state, "connecting");
  probeOk = true;
  assert.equal((await manager.markConnected(connectedInput())).state, "connected");
  const usable = await manager.status();
  assert.equal(usable.state, "connected");
  assert.equal(usable.usable, true);
  assert.match(usable.validated_probe_at, /^2026-/);

  probeOk = false;
  const unavailable = await manager.status();
  assert.equal(unavailable.state, "connecting");
  assert.equal(unavailable.usable, false);
  assert.equal(manager.read().state, "connecting");
});

test("runtime connection follows not_started to connecting to connected for the same operation", async () => {
  const { createRuntimeStateManager } = require(runtimeStatePath);
  const home = temporaryHome();
  const manager = createRuntimeStateManager({
    home,
    stateStore: createPortableSecureStateStore(home),
    liveProbe: async () => true,
  });

  await assert.rejects(() => manager.markConnected(connectedInput()), /connecting|状态/i);
  manager.startConnecting(connectedInput());
  await assert.rejects(() => manager.markConnected({
    ...connectedInput(),
    operation_id: "b7c0af4f-5dd7-41ec-9d11-583203a71483",
  }), /operation|连接/i);
  assert.equal((await manager.markConnected(connectedInput())).state, "connected");
});

test("active connecting operation is idempotent only for identical fields and rejects competitors", () => {
  const { createRuntimeStateManager } = require(runtimeStatePath);
  const home = temporaryHome();
  const manager = createRuntimeStateManager({
    home,
    platform: "linux",
    liveProbe: async () => true,
  });
  const first = connectedInput();
  const same = manager.startConnecting(first);
  assert.deepEqual(manager.startConnecting(first), same);

  for (const competing of [
    { ...first, operation_id: "b7c0af4f-5dd7-41ec-9d11-583203a71483" },
    { ...first, target_client: "claude" },
    { ...first, console_origin: "https://other.example.com" },
  ]) {
    assert.throws(() => manager.startConnecting(competing), /active|connecting|进行中|另一个/i);
    assert.deepEqual(manager.read(), same);
  }
});

test("an active connect rejects a competitor during live probe and completes consistently", async () => {
  const { createRuntimeStateManager } = require(runtimeStatePath);
  const home = temporaryHome();
  const newer = {
    ...connectedInput(),
    intent: { type: "create", project_root: "/workspace/new", source_kind: "local" },
    operation_id: "b7c0af4f-5dd7-41ec-9d11-583203a71483",
  };
  let manager;
  let competingError;
  manager = createRuntimeStateManager({
    home,
    stateStore: createPortableSecureStateStore(home),
    liveProbe: async () => {
      try {
        manager.startConnecting(newer);
      } catch (error) {
        competingError = error;
      }
      return true;
    },
  });
  manager.startConnecting(connectedInput());

  assert.equal((await manager.markConnected(connectedInput())).state, "connected");
  assert.match(competingError.message, /active|connecting|进行中|另一个/i);
  assert.equal(manager.read().operation_id, connectedInput().operation_id);
  assert.deepEqual(manager.read().intent, connectedInput().intent);
});

test("status does not downgrade a newer operation started during live probe", async () => {
  const { createRuntimeStateManager } = require(runtimeStatePath);
  const home = temporaryHome();
  const stateStore = createPortableSecureStateStore(home);
  const newer = {
    ...connectedInput(),
    intent: { type: "create", project_root: "/workspace/new", source_kind: "local" },
    operation_id: "b7c0af4f-5dd7-41ec-9d11-583203a71483",
  };
  let probeMode = "connect";
  let manager;
  manager = createRuntimeStateManager({
    home,
    stateStore,
    liveProbe: async () => {
      if (probeMode === "status") manager.startConnecting(newer);
      return probeMode === "connect";
    },
  });
  manager.startConnecting(connectedInput());
  await manager.markConnected(connectedInput());
  probeMode = "status";

  const result = await manager.status();
  assert.equal(result.state, "connecting");
  assert.equal(result.usable, false);
  assert.equal(manager.read().operation_id, newer.operation_id);
});

test("concurrent successful status probes both return usable after snapshot advances", async () => {
  const { createRuntimeStateManager } = require(runtimeStatePath);
  const home = temporaryHome();
  const stateStore = createPortableSecureStateStore(home);
  const input = connectedInput();
  const bootstrap = createRuntimeStateManager({ home, stateStore, liveProbe: async () => true });
  bootstrap.startConnecting(input);
  await bootstrap.markConnected(input);
  const resolvers = [];
  const liveProbe = () => new Promise((resolve) => resolvers.push(resolve));
  const firstManager = createRuntimeStateManager({ home, stateStore, liveProbe });
  const secondManager = createRuntimeStateManager({ home, stateStore, liveProbe });

  const firstStatus = firstManager.status();
  const secondStatus = secondManager.status();
  while (resolvers.length < 2) await new Promise((resolve) => setImmediate(resolve));
  resolvers[0](true);
  assert.equal((await firstStatus).usable, true);
  const validatedAtAfterFirst = firstManager.read().validated_probe_at;
  resolvers[1](true);
  assert.equal((await secondStatus).usable, true);
  assert.equal(secondManager.read().validated_probe_at, validatedAtAfterFirst);
});

test("runtime writes stay within the JSON allowlist without a revision field", async () => {
  const { createRuntimeStateManager } = require(runtimeStatePath);
  const home = temporaryHome();
  const manager = createRuntimeStateManager({
    home,
    stateStore: createPortableSecureStateStore(home),
    liveProbe: async () => true,
  });

  const connecting = manager.startConnecting(connectedInput());
  assert.equal(Object.hasOwn(connecting, "revision"), false);
  const connected = await manager.markConnected(connectedInput());
  assert.equal(Object.hasOwn(connected, "revision"), false);
  assert.equal(Object.hasOwn(JSON.parse(fs.readFileSync(manager.path, "utf8")), "revision"), false);
});

test("default live probe uses fixed client endpoints and only the process JWT", async () => {
  const { createRuntimeStateManager } = require(runtimeStatePath);
  const token = "current.process.jwt";
  for (const [targetClient, expectedPaths] of [
    ["codex", ["/console/mcp/rainskills/codex/query"]],
    ["claude", ["/console/mcp/rainskills/claude-code/query"]],
    ["all", ["/console/mcp/rainskills/codex/query", "/console/mcp/rainskills/claude-code/query"]],
  ]) {
    const home = temporaryHome();
    const stateStore = createPortableSecureStateStore(home);
    const input = { ...connectedInput(), target_client: targetClient };
    const bootstrap = createRuntimeStateManager({ home, stateStore, liveProbe: async () => true });
    bootstrap.startConnecting(input);
    await bootstrap.markConnected(input);
    const calls = [];
    const credentialWrites = [];
    const manager = createRuntimeStateManager({
      home,
      stateStore,
      env: { RAINBOND_JWT: token },
      credentialWriter: (value) => { credentialWrites.push(value); },
      async fetchImpl(url, options) {
        calls.push({ url, authorization: options.headers.Authorization });
        return new Response(JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: { serverInfo: { name: "rainbond-console-mcp" } },
        }), {
          status: 200,
          headers: targetClient === "all" && calls.length === 1
            ? { "x-renewed-token": "renewed.process.jwt" }
            : {},
        });
      },
    });

    assert.equal((await manager.status()).usable, true);
    assert.deepEqual(calls.map(({ url }) => new URL(url).pathname), expectedPaths);
    assert.deepEqual(calls.map(({ authorization }) => authorization), targetClient === "all"
      ? [`GRJWT ${token}`, "GRJWT renewed.process.jwt"]
      : expectedPaths.map(() => `GRJWT ${token}`));
    assert.deepEqual(credentialWrites, targetClient === "all" ? [{
      token: "renewed.process.jwt",
      baseUrl: "https://console.rainbond.com",
    }] : []);
  }
});

test("default live probe rejects redirects and endpoint drift", async () => {
  const { createRuntimeStateManager } = require(runtimeStatePath);
  for (const fetchImpl of [
    async (url, options) => {
      if (options.redirect !== "manual") {
        return new Response(JSON.stringify({
          jsonrpc: "2.0", id: 1, result: { serverInfo: { name: "rainbond-console-mcp" } },
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        jsonrpc: "2.0", id: 1, result: { serverInfo: { name: "rainbond-console-mcp" } },
      }), { status: 302, headers: { location: "https://attacker.example/mcp" } });
    },
    async () => ({
      ok: true,
      status: 200,
      url: "https://attacker.example/console/mcp/rainskills/codex/query",
      headers: { get: () => null },
      async json() {
        return { jsonrpc: "2.0", id: 1, result: { serverInfo: { name: "rainbond-console-mcp" } } };
      },
    }),
    async () => new Response(JSON.stringify({
      jsonrpc: "2.0", id: 1, result: { serverInfo: { name: "rainbond-console-mcp" } },
    }), { status: 200, headers: { location: "" } }),
  ]) {
    const home = temporaryHome();
    const stateStore = createPortableSecureStateStore(home);
    const bootstrap = createRuntimeStateManager({ home, stateStore, liveProbe: async () => true });
    bootstrap.startConnecting(connectedInput());
    await bootstrap.markConnected(connectedInput());
    const manager = createRuntimeStateManager({
      home,
      stateStore,
      env: { RAINBOND_JWT: "current.process.jwt" },
      fetchImpl,
    });

    assert.equal((await manager.status()).usable, false);
  }
});

test("renewed POSIX credential is atomically protected without runtime or output leakage", async () => {
  const { createRuntimeStateManager } = require(runtimeStatePath);
  const home = temporaryHome();
  const stateStore = createPortableSecureStateStore(home);
  const bootstrap = createRuntimeStateManager({ home, stateStore, liveProbe: async () => true });
  bootstrap.startConnecting(connectedInput());
  await bootstrap.markConnected(connectedInput());
  const renewedToken = "renewed.process.jwt";
  const manager = createRuntimeStateManager({
    home,
    stateStore,
    env: { RAINBOND_JWT: "current.process.jwt" },
    async fetchImpl() {
      return new Response(JSON.stringify({
        jsonrpc: "2.0", id: 1, result: { serverInfo: { name: "rainbond-console-mcp" } },
      }), { status: 200, headers: { "x-renewed-token": renewedToken } });
    },
  });

  const output = JSON.stringify(await manager.status());
  const credentialPath = path.join(home, ".rainbond", "mcp.env");
  assert.equal(output.includes(renewedToken), false);
  assert.equal(fs.statSync(credentialPath).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(credentialPath, "utf8"), [
    `export RAINBOND_JWT='${renewedToken}'`,
    "export RAINBOND_URL='https://console.rainbond.com'",
    "",
  ].join("\n"));
  assert.equal(fs.readFileSync(manager.path, "utf8").includes(renewedToken), false);
});

test("connecting credential writer rejects symlink and unsafe existing targets", () => {
  const { createRuntimeStateManager } = require(runtimeStatePath);
  const token = "fixtureHeader.fixturePayload.fixtureSignature";
  for (const unsafeTarget of ["symlink", "mode"]) {
    const home = temporaryHome();
    const manager = createRuntimeStateManager({ home, liveProbe: async () => true });
    const input = connectedInput();
    manager.startConnecting(input);
    const credentialPath = path.join(home, ".rainbond", "mcp.env");
    fs.mkdirSync(path.dirname(credentialPath), { recursive: true, mode: 0o700 });
    if (unsafeTarget === "symlink") {
      const outside = path.join(home, "outside.env");
      fs.writeFileSync(outside, "untouched\n", { mode: 0o600 });
      fs.symlinkSync(outside, credentialPath);
      assert.throws(() => manager.persistConnectingCredential({
        operationId: input.operation_id,
        token,
      }), /symlink|符号链接|regular|普通文件|安全|权限/i);
      assert.equal(fs.readFileSync(outside, "utf8"), "untouched\n");
    } else {
      fs.writeFileSync(credentialPath, "unsafe\n", { mode: 0o644 });
      assert.throws(() => manager.persistConnectingCredential({
        operationId: input.operation_id,
        token,
      }), /0600|mode|权限|安全/i);
      assert.equal(fs.readFileSync(credentialPath, "utf8"), "unsafe\n");
    }
  }
});

test("credential persistence failure makes renewal probe fail closed", async () => {
  const { createRuntimeStateManager } = require(runtimeStatePath);
  const home = temporaryHome();
  const stateStore = createPortableSecureStateStore(home);
  const bootstrap = createRuntimeStateManager({ home, stateStore, liveProbe: async () => true });
  bootstrap.startConnecting(connectedInput());
  await bootstrap.markConnected(connectedInput());
  const manager = createRuntimeStateManager({
    home,
    stateStore,
    env: { RAINBOND_JWT: "current.process.jwt" },
    credentialWriter() { throw new Error("unsafe detail renewed.process.jwt"); },
    async fetchImpl() {
      return new Response(JSON.stringify({
        jsonrpc: "2.0", id: 1, result: { serverInfo: { name: "rainbond-console-mcp" } },
      }), { status: 200, headers: { "x-renewed-token": "renewed.process.jwt" } });
    },
  });

  const output = JSON.stringify(await manager.status());
  assert.equal(JSON.parse(output).usable, false);
  assert.equal(output.includes("renewed.process.jwt"), false);
});

test("renewed credential is not written when a newer operation starts during probe", async () => {
  const { createRuntimeStateManager } = require(runtimeStatePath);
  const home = temporaryHome();
  const stateStore = createPortableSecureStateStore(home);
  const newer = {
    ...connectedInput(),
    intent: { type: "create", project_root: "/workspace/new", source_kind: "local" },
    operation_id: "b7c0af4f-5dd7-41ec-9d11-583203a71483",
  };
  const writes = [];
  let manager;
  manager = createRuntimeStateManager({
    home,
    stateStore,
    credentialWriter: (credential) => { writes.push(credential); },
    liveProbe: async () => {
      manager.startConnecting(newer);
      return {
        usable: true,
        renewedCredential: { token: "renewed.process.jwt", baseUrl: "https://console.rainbond.com" },
      };
    },
  });
  const bootstrap = createRuntimeStateManager({ home, stateStore, liveProbe: async () => true });
  bootstrap.startConnecting(connectedInput());
  await bootstrap.markConnected(connectedInput());

  assert.equal((await manager.status()).usable, false);
  assert.deepEqual(writes, []);
  assert.equal(manager.read().operation_id, newer.operation_id);
});

test("POSIX renewal does not overwrite credentials after a newer operation interleaves", async () => {
  const { createRuntimeStateManager } = require(runtimeStatePath);
  const home = temporaryHome();
  const stateStore = createPortableSecureStateStore(home);
  const newer = {
    ...connectedInput(),
    intent: { type: "create", project_root: "/workspace/new", source_kind: "local" },
    operation_id: "b7c0af4f-5dd7-41ec-9d11-583203a71483",
  };
  let manager;
  manager = createRuntimeStateManager({
    home,
    stateStore,
    env: { RAINBOND_JWT: "current.process.jwt" },
    async fetchImpl() {
      manager.startConnecting(newer);
      return new Response(JSON.stringify({
        jsonrpc: "2.0", id: 1, result: { serverInfo: { name: "rainbond-console-mcp" } },
      }), { status: 200, headers: { "x-renewed-token": "renewed.process.jwt" } });
    },
  });
  const bootstrap = createRuntimeStateManager({ home, stateStore, liveProbe: async () => true });
  bootstrap.startConnecting(connectedInput());
  await bootstrap.markConnected(connectedInput());

  assert.equal((await manager.status()).usable, false);
  assert.equal(fs.existsSync(path.join(home, ".rainbond", "mcp.env")), false);
  assert.equal(manager.read().operation_id, newer.operation_id);
});

test("runtime lock remains held until an async credential writer and state update finish", async () => {
  const { createRuntimeStateManager } = require(runtimeStatePath);
  const home = temporaryHome();
  const stateStore = createPortableSecureStateStore(home);
  let releaseWriter;
  let writerStarted;
  let probeMode = "connect";
  const started = new Promise((resolve) => { writerStarted = resolve; });
  const manager = createRuntimeStateManager({
    home,
    stateStore,
    liveProbe: async () => probeMode === "connect" ? true : ({
      usable: true,
      renewedCredential: { token: "renewed.process.jwt", baseUrl: "https://console.rainbond.com" },
    }),
    credentialWriter: () => new Promise((resolve) => {
      releaseWriter = resolve;
      writerStarted();
    }),
  });
  const competing = createRuntimeStateManager({ home, stateStore, liveProbe: async () => true });
  manager.startConnecting(connectedInput());
  await manager.markConnected(connectedInput());
  probeMode = "renew";
  const statusPromise = manager.status();
  const observedWriter = await Promise.race([
    started.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 50)),
  ]);
  assert.equal(observedWriter, true);

  assert.throws(() => competing.startConnecting({
    ...connectedInput(),
    operation_id: "b7c0af4f-5dd7-41ec-9d11-583203a71483",
  }), /正在|更新|running/i);
  releaseWriter();
  assert.equal((await statusPromise).usable, true);
});

test("markConnected stays connecting when renewed credential persistence fails", async () => {
  const { createRuntimeStateManager } = require(runtimeStatePath);
  const home = temporaryHome();
  const manager = createRuntimeStateManager({
    home,
    stateStore: createPortableSecureStateStore(home),
    liveProbe: async () => ({
      usable: true,
      renewedCredential: { token: "renewed.process.jwt", baseUrl: "https://console.rainbond.com" },
    }),
    credentialWriter() { throw new Error("unsafe renewed.process.jwt"); },
  });
  manager.startConnecting(connectedInput());

  await assert.rejects(() => manager.markConnected(connectedInput()), /credential|凭据|probe|验证/i);
  assert.equal(manager.read().state, "connecting");
});

test("default live probe fails closed without leaking the process JWT", async () => {
  const { createRuntimeStateManager } = require(runtimeStatePath);
  const home = temporaryHome();
  const stateStore = createPortableSecureStateStore(home);
  const input = connectedInput();
  const bootstrap = createRuntimeStateManager({ home, stateStore, liveProbe: async () => true });
  bootstrap.startConnecting(input);
  await bootstrap.markConnected(input);
  const token = "sensitive.process.jwt";
  let attempts = 0;
  const manager = createRuntimeStateManager({
    home,
    stateStore,
    env: { RAINBOND_JWT: token },
    async fetchImpl(url, options) {
      attempts += 1;
      throw new Error(`network failure ${options.headers.Authorization}`);
    },
  });

  const output = JSON.stringify(await manager.status());
  assert.equal(JSON.parse(output).usable, false);
  assert.equal(output.includes(token), false);
  assert.equal(attempts, 1);
});

test("stored runtime state validates fixed values and returns a fresh object", () => {
  const { createRuntimeStateManager } = require(runtimeStatePath);
  const validState = {
    schema: "rainskills.runtime-connection.v1",
    version: 1,
    state: "connecting",
    ...connectedInput(),
    validated_probe_at: null,
    created_at: "2026-08-14T00:00:00.000Z",
    updated_at: "2026-08-14T00:00:00.000Z",
    failed_step: "resolve-target",
    retry_count: 1,
    retry_budget: 1,
    last_failure_category: "credential-expired",
  };

  for (const mutation of [
    { created_at: "not-a-time" },
    { updated_at: null },
    { validated_probe_at: "yesterday" },
    { failed_step: "shell" },
    { retry_count: -1 },
    { retry_count: 1.5 },
    { retry_count: 1001 },
    { retry_budget: 2 },
    { last_failure_category: "raw secret output" },
  ]) {
    const home = temporaryHome();
    const stateStore = createPortableSecureStateStore(home);
    const manager = createRuntimeStateManager({ home, stateStore });
    stateStore.atomicWriteJson(manager.path, { ...validState, ...mutation });
    assert.throws(() => manager.read(), /runtime|timestamp|step|retry|failure|时间|固定|无效/i);
  }

  const home = temporaryHome();
  const stateStore = createPortableSecureStateStore(home);
  const manager = createRuntimeStateManager({ home, stateStore });
  stateStore.atomicWriteJson(manager.path, validState);
  const read = manager.read();
  assert.notEqual(read, validState);
  assert.notEqual(read.intent, validState.intent);
  assert.deepEqual(validState.intent, connectedInput().intent);
});

test("runtime state uses POSIX protected directories and 0600 file", () => {
  const { createRuntimeStateManager } = require(runtimeStatePath);
  const home = temporaryHome();
  const manager = createRuntimeStateManager({
    home,
    stateStore: createPortableSecureStateStore(home),
  });

  manager.startConnecting(connectedInput());
  assert.equal(manager.path, path.join(home, ".rainbond", "rainskills", "runtime-connection-v1.json"));
  assert.equal(fs.statSync(manager.path).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(manager.path)).mode & 0o777, 0o700);
});

test("runtime state delegates Windows protection to the secure store", () => {
  const { createRuntimeStateManager } = require(runtimeStatePath);
  const { createSecureStateStore } = require(path.resolve(
    __dirname,
    "..",
    "rainbond-platform-installer",
    "scripts",
    "secure-state.js"
  ));
  const home = temporaryHome();
  const currentSid = "S-1-5-21-111-222-333-1001";
  const aclCalls = [];
  const stateStore = createSecureStateStore({
    platform: "win32",
    home,
    currentSid,
    hardenWindowsAcl(targetPath, expectedKind) {
      aclCalls.push(["protect", targetPath, expectedKind]);
    },
    inspectWindowsAcl(targetPath, expectedKind) {
      aclCalls.push(["inspect", targetPath, expectedKind]);
      return {
        ownerSid: currentSid,
        writableSids: [currentSid, "S-1-5-18", "S-1-5-32-544"],
        reparsePoint: false,
      };
    },
  });
  const manager = createRuntimeStateManager({ home, platform: "win32", stateStore });

  manager.startConnecting(connectedInput());
  manager.read();
  assert.equal(aclCalls.some(([operation, , kind]) => operation === "protect" && kind === "directory"), true);
  assert.equal(aclCalls.some(([operation, , kind]) => operation === "protect" && kind === "file"), true);
  assert.equal(aclCalls.some(([operation, , kind]) => operation === "inspect" && kind === "file"), true);
});
