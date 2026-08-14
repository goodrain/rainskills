const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const repoRoot = path.resolve(__dirname, "..");
const launcherPath = path.join(repoRoot, "bin", "rainskills.js");
const controlEnvironmentPath = path.join(
  repoRoot,
  "rainbond-platform-installer",
  "scripts",
  "control-environment.js"
);
const windowsOnboardingPath = path.join(
  repoRoot,
  "rainbond-platform-installer",
  "scripts",
  "windows-onboarding.js"
);

test("control environment distinguishes native Windows, WSL, and POSIX", () => {
  const { detectControlEnvironment } = require(controlEnvironmentPath);

  assert.deepEqual(detectControlEnvironment({
    platform: "win32",
    env: {},
    kernelRelease: "10.0.26100",
  }), {
    mode: "windows-native",
    hostPlatform: "win32",
    controlPlatform: "win32",
  });

  assert.deepEqual(detectControlEnvironment({
    platform: "linux",
    env: {
      WSL_INTEROP: "/run/WSL/1_interop",
      WSL_DISTRO_NAME: "Ubuntu",
    },
    kernelRelease: "6.6.87.2-microsoft-standard-WSL2",
  }), {
    mode: "wsl",
    hostPlatform: "win32",
    controlPlatform: "linux",
    controlDistro: "Ubuntu",
  });

  assert.deepEqual(detectControlEnvironment({
    platform: "linux",
    env: { WSL_DISTRO_NAME: "Ubuntu" },
    kernelRelease: "6.8.0-generic",
  }), {
    mode: "posix",
    hostPlatform: "linux",
    controlPlatform: "linux",
  });
});

test("WSL classification fails closed when the control distro is invalid", () => {
  const { detectControlEnvironment } = require(controlEnvironmentPath);

  assert.deepEqual(detectControlEnvironment({
    platform: "linux",
    env: {
      WSL_INTEROP: "/run/WSL/1_interop",
      WSL_DISTRO_NAME: "Ubuntu\nmalicious",
    },
    kernelRelease: "5.15.153.1-microsoft-standard-WSL2",
  }), {
    mode: "wsl",
    hostPlatform: "win32",
    controlPlatform: "linux",
  });
});

test("launcher has the Node shebang and classifies supported runtimes", () => {
  const source = fs.readFileSync(launcherPath, "utf8");
  assert.equal(source.split("\n", 1)[0], "#!/usr/bin/env node");

  const { classifyNodeMajor, resolveInvocation } = require(launcherPath);
  assert.equal(classifyNodeMajor(16), "unsupported");
  assert.equal(classifyNodeMajor(18), "eol");
  assert.equal(classifyNodeMajor(20), "eol");
  assert.equal(classifyNodeMajor(22), "supported");
  assert.equal(classifyNodeMajor(24), "supported");
  assert.deepEqual(resolveInvocation(["codex", "--skip-mcp"]), {
    executable: "bash",
    args: [path.join(repoRoot, "install.sh"), "codex", "--skip-mcp"],
  });
});

test("launcher preserves arguments and environment and returns the Bash exit code", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rainskills-launcher-"));
  const fakeBash = path.join(tempDir, "bash");
  const logPath = path.join(tempDir, "args.log");

  fs.writeFileSync(
    fakeBash,
    [
      "#!/bin/sh",
      ': > "$RAINSKILLS_TEST_LOG"',
      'for argument in "$@"; do',
      '  printf "%s\\n" "$argument" >> "$RAINSKILLS_TEST_LOG"',
      "done",
      'printf "marker=%s\\n" "$RAINSKILLS_TEST_MARKER" >> "$RAINSKILLS_TEST_LOG"',
      'exit "$RAINSKILLS_TEST_EXIT_CODE"',
      "",
    ].join("\n"),
    { mode: 0o755 }
  );

  const result = spawnSync(
    process.execPath,
    [launcherPath, "codex", "--rainbond-url", "https://example.com/path with space"],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${tempDir}${path.delimiter}${process.env.PATH || ""}`,
        RAINSKILLS_TEST_EXIT_CODE: "23",
        RAINSKILLS_TEST_LOG: logPath,
        RAINSKILLS_TEST_MARKER: "preserved",
      },
    }
  );

  assert.equal(result.status, 23, result.stderr);
  assert.deepEqual(fs.readFileSync(logPath, "utf8").trim().split("\n"), [
    path.join(repoRoot, "install.sh"),
    "codex",
    "--rainbond-url",
    "https://example.com/path with space",
    "marker=preserved",
  ]);
});

test("launcher routes native Windows onboarding to Node and keeps WSL on Bash", () => {
  const { resolveInvocation } = require(launcherPath);
  const fakeNode = path.join(repoRoot, "fake-node");

  assert.deepEqual(resolveInvocation(["codex", "--skip-mcp"], {
    control: {
      mode: "windows-native",
      hostPlatform: "win32",
      controlPlatform: "win32",
    },
    execPath: fakeNode,
  }), {
    executable: fakeNode,
    args: [windowsOnboardingPath, "codex", "--skip-mcp"],
  });

  assert.deepEqual(resolveInvocation(["codex", "--skip-mcp"], {
    control: {
      mode: "wsl",
      hostPlatform: "win32",
      controlPlatform: "linux",
      controlDistro: "Ubuntu",
    },
    execPath: fakeNode,
  }), {
    executable: "bash",
    args: [path.join(repoRoot, "install.sh"), "codex", "--skip-mcp"],
  });
});

test("launcher handles runtime status in-process without spawning a shell", async () => {
  const { runBuiltin } = require(launcherPath);
  let writes = "";
  let spawnCalls = 0;

  const handled = await runBuiltin(["runtime", "status", "--json"], {
    runtimeStateManager: {
      status: async () => ({ schema: "rainskills.runtime-status.v1", state: "not_started", usable: false }),
    },
    write: (value) => { writes += value; },
    spawnFn: () => { spawnCalls += 1; },
  });

  assert.equal(handled, true);
  assert.equal(spawnCalls, 0);
  assert.deepEqual(JSON.parse(writes), {
    schema: "rainskills.runtime-status.v1",
    state: "not_started",
    usable: false,
  });
});

test("runtime connect parses fixed validated argv and rejects mixed environment choices", () => {
  const { parseRuntimeConnectArgs } = require(launcherPath);
  const intent = {
    type: "deploy",
    project_root: "/workspace/app",
    source_kind: "local",
  };

  assert.deepEqual(parseRuntimeConnectArgs([
    "runtime", "connect", "codex", "--saas", "--intent-json", JSON.stringify(intent),
  ]), {
    targetClient: "codex",
    environmentChoice: "saas",
    rainbondUrl: "",
    allowInsecureHttp: false,
    onboardingId: "",
    intent,
  });
  assert.throws(() => parseRuntimeConnectArgs([
    "runtime", "connect", "all", "--saas", "--rainbond-url", "https://rainbond.example.com",
    "--intent-json", JSON.stringify(intent),
  ]), /互斥|只能选择|环境/i);
  assert.throws(() => parseRuntimeConnectArgs([
    "runtime", "connect", "all", "--install-private", "--intent-json",
    JSON.stringify({ type: "query", operation: "summary" }),
  ]), /existing|已有|现有/i);
  assert.throws(() => parseRuntimeConnectArgs([
    "runtime", "connect", "all", "--saas", "--intent-json", '{"type":"deploy","token":"secret"}',
  ]), /凭据|字段|intent/i);
});

test("runtime connector child receives only an explicit environment allowlist", () => {
  const { runtimeChildEnvironment } = require(launcherPath);
  const childEnvironment = runtimeChildEnvironment({
    HOME: "/home/demo",
    PATH: "/usr/bin",
    RAINBOND_JWT: "test-credential-value",
    HTTPS_PROXY: "http://proxy.internal:3128",
    DATABASE_PASSWORD: "must-not-cross-boundary",
    NODE_OPTIONS: "--require=/tmp/untrusted.js",
  }, {
    RAINSKILLS_RUNTIME_OPERATION_ID: "1d6754d6-6fb3-4bda-9a04-15c2d261d178",
  });

  assert.deepEqual(Object.keys(childEnvironment).sort(), [
    "HOME", "HTTPS_PROXY", "PATH", "RAINSKILLS_RUNTIME_OPERATION_ID",
  ]);
});

test("runtime connector forwards inherited credential only as an exact origin-bound pair", () => {
  const { runtimeChildEnvironment } = require(launcherPath);
  const expectedOrigin = "https://new.example.com";
  const matching = runtimeChildEnvironment({
    RAINBOND_JWT: "fixtureHeader.fixturePayload.fixtureSignature",
    RAINBOND_URL: expectedOrigin,
  }, {}, expectedOrigin);
  assert.deepEqual(Object.keys(matching).sort(), ["RAINBOND_JWT", "RAINBOND_URL"]);

  for (const source of [
    { RAINBOND_JWT: "fixtureHeader.fixturePayload.fixtureSignature" },
    { RAINBOND_URL: expectedOrigin },
    {
      RAINBOND_JWT: "fixtureHeader.fixturePayload.fixtureSignature",
      RAINBOND_URL: "https://old.example.com",
    },
    {
      RAINBOND_JWT: "fixtureHeader.fixturePayload.fixtureSignature",
      RAINBOND_URL: "https://new.example.com/path",
    },
  ]) {
    const child = runtimeChildEnvironment(source, {}, expectedOrigin);
    assert.equal(Object.hasOwn(child, "RAINBOND_JWT"), false);
    assert.equal(Object.hasOwn(child, "RAINBOND_URL"), false);
  }
});

test("runtime assert-connect gate requires the exact protected connecting state", async () => {
  const { runBuiltin } = require(launcherPath);
  const operationId = "1d6754d6-6fb3-4bda-9a04-15c2d261d178";
  const current = {
    state: "connecting",
    operation_id: operationId,
    target_client: "codex",
    environment_kind: "private",
    console_origin: "https://console.example.com",
  };
  const exact = [
    "runtime", "assert-connect", "--onboarding-id", operationId,
    "--target", "codex", "--environment-kind", "private",
    "--console-origin", "https://console.example.com",
  ];
  assert.equal(await runBuiltin(exact, {
    runtimeStateManager: { read: () => current },
    write() { throw new Error("gate must be silent"); },
  }), true);

  for (const args of [
    exact.slice(0, -1).concat("https://other.example.com"),
    exact.map((value) => value === "codex" ? "claude" : value),
    exact.map((value) => value === operationId
      ? "b7c0af4f-5dd7-41ec-9d11-583203a71483" : value),
  ]) {
    await assert.rejects(() => runBuiltin(args, {
      runtimeStateManager: { read: () => current },
      write() { throw new Error("gate must be silent"); },
    }), /connecting|operation|匹配|门禁/i);
  }
});

test("runtime persist-connect-credential binds the env credential to connecting state", async () => {
  const { runBuiltin } = require(launcherPath);
  const operationId = "1d6754d6-6fb3-4bda-9a04-15c2d261d178";
  const persisted = [];
  const args = ["runtime", "persist-connect-credential", "--onboarding-id", operationId];
  const manager = {
    read: () => ({
      state: "connecting",
      operation_id: operationId,
      target_client: "codex",
      environment_kind: "private",
      console_origin: "https://console.example.com",
    }),
  };
  await runBuiltin(args, {
    runtimeStateManager: manager,
    credentialEnvironment: { RAINBOND_JWT: "fixtureHeader.fixturePayload.fixtureSignature" },
    credentialPersister: (credential) => persisted.push(credential),
    write() { throw new Error("writer must be silent"); },
  });
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0].baseUrl, "https://console.example.com");

  await assert.rejects(() => runBuiltin([
    "runtime", "persist-connect-credential", "--onboarding-id",
    "b7c0af4f-5dd7-41ec-9d11-583203a71483",
  ], {
    runtimeStateManager: manager,
    credentialEnvironment: { RAINBOND_JWT: "fixtureHeader.fixturePayload.fixtureSignature" },
    credentialPersister: (credential) => persisted.push(credential),
  }), /connecting|operation|匹配/i);
  assert.equal(persisted.length, 1);
});

test("runtime connect uses fixed POSIX argv and marks connected only after the live probe", async () => {
  const { runBuiltin } = require(launcherPath);
  const operationId = "1d6754d6-6fb3-4bda-9a04-15c2d261d178";
  const events = [];
  const intent = { type: "query", operation: "summary" };

  await runBuiltin([
    "runtime", "connect", "all", "--rainbond-url", "http://10.0.0.8:7070",
    "--allow-insecure-http", "--onboarding-id", operationId,
    "--intent-json", JSON.stringify(intent),
  ], {
    control: { mode: "posix", hostPlatform: "linux", controlPlatform: "linux" },
    originInspector: async () => ({
      origin: "http://10.0.0.8:7070",
      httpConfirmationRequired: true,
      pendingRedirectOrigin: null,
    }),
    runtimeStateManager: {
      startConnecting(input) { events.push(["connecting", input]); },
      async markConnected(input) { events.push(["connected", input]); },
    },
    async connectionRunner(invocation) {
      events.push(["run", invocation]);
      return { code: 0, completesRuntimeState: false };
    },
    write() {},
  });

  assert.equal(events[0][0], "connecting");
  assert.deepEqual(events[1], ["run", {
    executable: "bash",
    args: [
      path.join(repoRoot, "install.sh"), "connect", "all", "--self-hosted",
      "--rainbond-url", "http://10.0.0.8:7070", "--allow-insecure-http",
    ],
  }]);
  assert.equal(events[2][0], "connected");
  assert.deepEqual(events[2][1], events[0][1]);
});

test("POSIX runtime connect without an inherited token keeps browser authorization interactive", () => {
  const { runtimeChildEnvironment, runtimeConnectionInvocation } = require(launcherPath);
  const origin = "https://console.example.com";
  const invocation = runtimeConnectionInvocation({
    targetClient: "codex",
    environmentChoice: "private-existing",
    allowInsecureHttp: false,
  }, origin);
  assert.deepEqual(invocation.args, [
    path.join(repoRoot, "install.sh"), "connect", "codex", "--self-hosted",
    "--rainbond-url", origin,
  ]);
  assert.equal(invocation.args.includes("--non-interactive"), false);
  const environment = runtimeChildEnvironment({}, {
    RAINSKILLS_RUNTIME_CONNECT_COMPLETION: "1",
    RAINSKILLS_RUNTIME_OPERATION_ID: "1d6754d6-6fb3-4bda-9a04-15c2d261d178",
  }, origin);
  assert.equal(Object.hasOwn(environment, "RAINBOND_JWT"), false);
  assert.equal(Object.hasOwn(environment, "RAINBOND_URL"), false);
});

test("runtime connect does not write connected when authorization or live probe fails", async () => {
  const { runBuiltin } = require(launcherPath);
  let connected = 0;
  const args = [
    "runtime", "connect", "codex", "--saas", "--intent-json",
    JSON.stringify({ type: "deploy", project_root: "/workspace/app", source_kind: "local" }),
  ];

  await assert.rejects(() => runBuiltin(args, {
    control: { mode: "posix" },
    originInspector: async () => ({
      origin: "https://run.rainbond.com",
      httpConfirmationRequired: false,
      pendingRedirectOrigin: null,
    }),
    runtimeStateManager: {
      startConnecting() {},
      async markConnected() { connected += 1; },
    },
    connectionRunner: async () => ({ code: 9 }),
    write() {},
  }), /连接|退出码|授权/i);
  assert.equal(connected, 0);

  await assert.rejects(() => runBuiltin(args, {
    control: { mode: "posix" },
    originInspector: async () => ({
      origin: "https://run.rainbond.com",
      httpConfirmationRequired: false,
      pendingRedirectOrigin: null,
    }),
    runtimeStateManager: {
      startConnecting() {},
      async markConnected() {
        connected += 1;
        throw new Error("live probe failed");
      },
    },
    connectionRunner: async () => ({ code: 0, completesRuntimeState: false }),
    write() {},
  }), /probe/i);
  assert.equal(connected, 1);
});

test("failed runtime connect returns a fixed same-operation retry action that resumes", async () => {
  const { runBuiltin } = require(launcherPath);
  const { createRuntimeStateManager } = require(path.join(
    repoRoot, "rainbond-platform-installer", "scripts", "runtime-state.js"
  ));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "rainskills-connect-retry-"));
  const manager = createRuntimeStateManager({ home, liveProbe: async () => true });
  const operationId = "1d6754d6-6fb3-4bda-9a04-15c2d261d178";
  const intent = { type: "query", operation: "summary" };
  const initialArgs = [
    "runtime", "connect", "codex", "--rainbond-url", "https://console.example.com",
    "--onboarding-id", operationId, "--intent-json", JSON.stringify(intent),
  ];
  let output = "";
  let attempts = 0;
  const dependencies = {
    runtimeStateManager: manager,
    originInspector: async () => ({
      origin: "https://console.example.com",
      httpConfirmationRequired: false,
      pendingRedirectOrigin: null,
    }),
    connectionRunner: async () => {
      attempts += 1;
      return { code: attempts === 1 ? 9 : 0, completesRuntimeState: false };
    },
    write(value) { output += value; },
  };

  await assert.rejects(() => runBuiltin(initialArgs, dependencies), /连接|授权/i);
  const retry = JSON.parse(output.trim());
  assert.deepEqual(retry, {
    schema: "rainskills.next-action.v1",
    action: "retry-runtime-connect",
    onboarding_id: operationId,
    argv: initialArgs,
  });
  assert.equal(manager.read().state, "connecting");

  await assert.rejects(() => runBuiltin(initialArgs.map((value) => value === operationId
    ? "b7c0af4f-5dd7-41ec-9d11-583203a71483" : value), {
    ...dependencies,
    write() { throw new Error("competing operation must not receive a retry action"); },
  }), /active|connecting|进行中|另一个/i);
  assert.equal(attempts, 1);

  output = "";
  assert.equal(await runBuiltin(retry.argv, dependencies), true);
  assert.equal(attempts, 2);
  assert.equal(manager.read().state, "connected");
  assert.equal(manager.read().operation_id, operationId);
});

test("a competing runtime connect has zero authorization or configuration side effects", async () => {
  const { runBuiltin } = require(launcherPath);
  const { createRuntimeStateManager } = require(path.join(
    repoRoot, "rainbond-platform-installer", "scripts", "runtime-state.js"
  ));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "rainskills-connect-lease-"));
  const manager = createRuntimeStateManager({ home, liveProbe: async () => true });
  const first = {
    target_client: "codex",
    environment_kind: "private",
    console_origin: "https://console.example.com",
    intent: { type: "query", operation: "summary" },
    operation_id: "1d6754d6-6fb3-4bda-9a04-15c2d261d178",
  };
  manager.startConnecting(first);
  let sideEffects = 0;

  await assert.rejects(() => runBuiltin([
    "runtime", "connect", "codex", "--rainbond-url", "https://console.example.com",
    "--onboarding-id", "b7c0af4f-5dd7-41ec-9d11-583203a71483",
    "--intent-json", JSON.stringify(first.intent),
  ], {
    runtimeStateManager: manager,
    originInspector: async () => ({
      origin: first.console_origin,
      httpConfirmationRequired: false,
      pendingRedirectOrigin: null,
    }),
    connectionRunner: async () => {
      sideEffects += 1;
      return { code: 0, completesRuntimeState: false };
    },
  }), /active|connecting|进行中|另一个/i);

  assert.equal(sideEffects, 0);
  assert.equal(manager.read().operation_id, first.operation_id);
  assert.equal((await manager.markConnected(first)).state, "connected");
  assert.equal(manager.read().operation_id, first.operation_id);
});

test("runtime connect schedules a new private platform without connecting or authorizing", async () => {
  const { runBuiltin } = require(launcherPath);
  const calls = [];
  let output = "";

  await runBuiltin([
    "runtime", "connect", "claude", "--install-private", "--intent-json",
    JSON.stringify({
      type: "template-install",
      template_id: "wordpress",
      install_scope: "new-app",
    }),
  ], {
    control: { mode: "posix", hostPlatform: "linux", controlPlatform: "linux" },
    runtimeStateManager: {
      startConnecting() { throw new Error("must not connect"); },
    },
    privateInstallerScheduler(input) {
      calls.push(input);
      return {
        schema: "rainskills.next-action.v1",
        action: "install-platform",
        onboarding_id: input.operationId,
        argv: ["platform", "install", "--onboarding-id", input.operationId],
      };
    },
    write(value) { output += value; },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].target, "claude");
  assert.deepEqual(calls[0].intent, {
    type: "template-install",
    template_id: "wordpress",
    install_scope: "new-app",
  });
  assert.deepEqual(JSON.parse(output), {
    schema: "rainskills.next-action.v1",
    action: "install-platform",
    onboarding_id: calls[0].operationId,
    argv: ["platform", "install", "--onboarding-id", calls[0].operationId],
  });
});

test("intent resume rejects a legacy awaiting-platform checkpoint without usable runtime state", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "rainskills-intent-resume-"));
  const operationId = "1d6754d6-6fb3-4bda-9a04-15c2d261d178";
  const stateDirectory = path.join(home, ".rainbond");
  const statePath = path.join(stateDirectory, "rainskills-onboarding-v1.json");
  fs.mkdirSync(stateDirectory, { mode: 0o700 });
  fs.writeFileSync(statePath, `${JSON.stringify({
    schema: "rainskills.onboarding.v1",
    version: 1,
    operation_id: operationId,
    stage: "awaiting-platform",
    target: "codex",
    deployment_mode: "self-hosted",
    control_mode: "posix",
    control_distro: null,
    intent: {
      type: "deploy",
      project_root: "/workspace/app",
      source_kind: "git",
      source_url: "https://github.com/example/app.git",
    },
  }, null, 2)}\n`, { mode: 0o600 });

  const result = spawnSync(process.execPath, [
    launcherPath,
    "intent",
    "resume",
    "--onboarding-id",
    operationId,
  ], {
    encoding: "utf8",
    env: { ...process.env, HOME: home },
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /runtime|connected|usable|连接/i);
  assert.equal(result.stdout, "");
});

test("intent resume emits continuation from live-probed protected runtime state across processes", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "rainskills-runtime-resume-"));
  const operationId = "1d6754d6-6fb3-4bda-9a04-15c2d261d178";
  const runtimeDirectory = path.join(home, ".rainbond", "rainskills");
  const runtimePath = path.join(runtimeDirectory, "runtime-connection-v1.json");
  const preloadPath = path.join(home, "mock-runtime-fetch.js");
  fs.mkdirSync(runtimeDirectory, { recursive: true, mode: 0o700 });
  fs.writeFileSync(runtimePath, `${JSON.stringify({
    schema: "rainskills.runtime-connection.v1",
    version: 1,
    state: "connected",
    target_client: "codex",
    environment_kind: "saas",
    console_origin: "https://console.rainbond.com",
    validated_probe_at: "2026-08-14T00:00:00.000Z",
    intent: {
      type: "deploy",
      project_root: "/workspace/app",
      source_kind: "git",
      source_url: "https://github.com/example/app.git",
    },
    operation_id: operationId,
    created_at: "2026-08-14T00:00:00.000Z",
    updated_at: "2026-08-14T00:00:00.000Z",
    failed_step: "build",
    retry_count: 0,
    retry_budget: 0,
    last_failure_category: null,
  }, null, 2)}\n`, { mode: 0o600 });
  fs.writeFileSync(preloadPath, [
    "globalThis.fetch = async () => new Response(JSON.stringify({",
    "  jsonrpc: '2.0', id: 1,",
    "  result: { serverInfo: { name: 'rainbond-console-mcp' } },",
    "}), { status: 200 });",
    "",
  ].join("\n"), { mode: 0o600 });

  const result = spawnSync(process.execPath, [
    launcherPath,
    "intent",
    "resume",
    "--onboarding-id",
    operationId,
  ], {
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: home,
      NODE_OPTIONS: `--require=${preloadPath}`,
      RAINBOND_JWT: "current.process.jwt",
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    schema: "rainskills.intent-continuation.v1",
    skill_id: "rainbond-app-assistant",
    intent: {
      type: "deploy",
      project_root: "/workspace/app",
      source_kind: "git",
      source_url: "https://github.com/example/app.git",
    },
    resume_step: "build",
  });
});

test("intent resume requires connected usable state and matching operation", async () => {
  const { runBuiltin } = require(launcherPath);
  const operationId = "1d6754d6-6fb3-4bda-9a04-15c2d261d178";
  const otherOperationId = "b7c0af4f-5dd7-41ec-9d11-583203a71483";
  const baseState = {
    state: "connected",
    operation_id: operationId,
    intent: { type: "query", operation: "summary" },
    failed_step: null,
  };

  for (const runtimeStateManager of [
    { status: async () => ({ state: "connecting", usable: false }), read: () => baseState },
    { status: async () => ({ state: "connected", usable: false }), read: () => baseState },
    { status: async () => ({ state: "connected", usable: true }), read: () => ({ ...baseState, operation_id: otherOperationId }) },
    { status: async () => ({ state: "connected", usable: true }), read: () => ({ ...baseState, intent: null }) },
  ]) {
    await assert.rejects(() => runBuiltin([
      "intent", "resume", "--onboarding-id", operationId,
    ], { runtimeStateManager }), /runtime|operation|intent|usable|连接/i);
  }
});
