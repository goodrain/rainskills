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
