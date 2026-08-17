const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const repoRoot = path.resolve(__dirname, "..");
const launcherPath = path.join(repoRoot, "bin", "rainskills.js");
const toolsBridgePath = path.join(repoRoot, "bin", "rainskills-tools.js");
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

function boundedUserMessage(output, messageId) {
  const begin = `[RAINSKILLS_USER_MESSAGE_BEGIN:${messageId}]\n`;
  const end = `\n[RAINSKILLS_USER_MESSAGE_END:${messageId}]`;
  const start = output.indexOf(begin);
  const finish = output.indexOf(end, start + begin.length);
  assert.notEqual(start, -1, `missing ${begin.trim()}`);
  assert.notEqual(finish, -1, `missing ${end.trim()}`);
  return output.slice(start + begin.length, finish);
}

test("runtime onboarding messages come from the launcher as fixed bounded blocks", async () => {
  const { runBuiltin } = require(launcherPath);
  const first = [];
  assert.equal(await runBuiltin([
    "runtime", "message", "--id", "new-application-environment",
  ], { write: (value) => first.push(value) }), true);
  assert.equal(
    boundedUserMessage(first.join(""), "runtime.new-application-environment"),
    "可以，我会帮你完成应用识别、构建、部署和访问验证。\n\n"
      + "不过目前还没有可用的应用运行环境。\n\n"
      + "你刚安装的 Rainskills 是负责“部署”的 AI 助手，它会分析项目并执行部署流程；Rainbond 负责为应用提供稳定运行环境。\n\n"
      + "请选择应用要运行的环境：\n\n"
      + "1) 云端环境（免费体验）\n"
      + "2) 私有环境（去对接）",
  );

  await assert.rejects(
    () => runBuiltin([
      "runtime", "message", "--id", "own-environment-connection",
    ], { write: () => {} }),
    /message id/i,
  );

  const second = [];
  assert.equal(await runBuiltin([
    "runtime", "message", "--id", "private-deployment-location",
  ], {
    control: { mode: "posix", hostPlatform: "darwin", controlPlatform: "darwin" },
    write: (value) => second.push(value),
  }), true);
  assert.equal(
    boundedUserMessage(second.join(""), "runtime.private-deployment-location"),
    "请选择部署位置：\n\n"
      + "1、对接到本地\n"
      + "2、对接到独立服务器\n"
      + "3、对接已有私有环境",
  );
  for (const controlPlatform of ["linux", "win32"]) {
    const output = [];
    assert.equal(await runBuiltin([
      "runtime", "message", "--id", "private-deployment-location",
    ], {
      control: { mode: "posix", hostPlatform: controlPlatform, controlPlatform },
      write: (value) => output.push(value),
    }), true);
    assert.equal(
      boundedUserMessage(output.join(""), "runtime.private-deployment-location"),
      "请选择部署位置：\n\n"
        + "1、对接到本地\n"
        + "2、对接到独立服务器\n"
        + "3、对接已有私有环境",
    );
  }

  const third = [];
  assert.equal(await runBuiltin([
    "runtime", "message", "--id", "private-console-origin",
  ], { write: (value) => third.push(value) }), true);
  assert.equal(
    boundedUserMessage(third.join(""), "runtime.private-console-origin"),
    "请提供已有私有环境地址。\n\n"
      + "示例：https://rainbond.example.com",
  );
  await assert.rejects(
    () => runBuiltin(["runtime", "message", "--id", "unknown"], { write: () => {} }),
    /message id/i,
  );
});

test("environment commands use immutable ids and operation begin has no project binding", async () => {
  const { runBuiltin } = require(launcherPath);
  const environmentId = "11111111-1111-4111-8111-111111111111";
  const operationId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const environments = [{
    id: environmentId,
    name: "生产环境",
    console_origin: "https://prod.example.com",
    kind: "private",
    connection_state: "connected",
    created_at: "2026-08-17T00:00:00.000Z",
    updated_at: "2026-08-17T00:00:00.000Z",
    last_verified_at: "2026-08-17T00:00:00.000Z",
  }];
  const registryCalls = [];
  const credentialCalls = [];
  const environmentCredentialStore = {
    remove(id) { credentialCalls.push(id); return true; },
  };
  const environmentRegistry = {
    read: () => ({ default_environment_id: environmentId, environments }),
    rename(id, name) {
      registryCalls.push(["rename", id, name]);
      return { ...environments[0], name };
    },
    setDefault(id) {
      registryCalls.push(["set-default", id]);
      return environments[0];
    },
    remove(id) {
      registryCalls.push(["remove", id]);
      return environments[0];
    },
  };
  const operationCalls = [];
  const operationStore = {
    begin(input) {
      operationCalls.push(input);
      return {
        operation_id: input.operationId,
        environment_id: input.environmentId,
        intent: input.intent,
        stage: "active",
      };
    },
  };

  const listOutput = [];
  assert.equal(await runBuiltin(["environment", "list", "--json"], {
    environmentRegistry,
    write: (value) => listOutput.push(value),
  }), true);
  assert.deepEqual(JSON.parse(listOutput.join("")), {
    schema: "rainskills.environment-list.v1",
    default_environment_id: environmentId,
    environments,
  });

  for (const [argv, action] of [
    [["environment", "rename", "--environment-id", environmentId, "--name", "正式环境"], "renamed"],
    [["environment", "set-default", "--environment-id", environmentId], "default-changed"],
    [["environment", "remove", "--environment-id", environmentId], "removed"],
  ]) {
    const output = [];
    assert.equal(await runBuiltin(argv, {
      environmentRegistry,
      environmentCredentialStore,
      write: (value) => output.push(value),
    }), true);
    assert.equal(JSON.parse(output.join("")).action, action);
  }
  assert.deepEqual(registryCalls, [
    ["rename", environmentId, "正式环境"],
    ["set-default", environmentId],
    ["remove", environmentId],
  ]);
  assert.deepEqual(credentialCalls, [environmentId]);

  const operationOutput = [];
  assert.equal(await runBuiltin([
    "operation", "begin",
    "--operation-id", operationId,
    "--environment-id", environmentId,
    "--intent-json", JSON.stringify({ type: "deploy", project_root: "/workspace/demo" }),
  ], {
    operationStore,
    write: (value) => operationOutput.push(value),
  }), true);
  assert.deepEqual(operationCalls, [{
    operationId,
    environmentId,
    intent: { type: "deploy", project_root: "/workspace/demo" },
  }]);
  const operationResult = JSON.parse(operationOutput.join(""));
  assert.equal(operationResult.schema, "rainskills.operation-begin-result.v1");
  assert.equal(operationResult.operation_id, operationId);
  assert.equal(Object.hasOwn(operationResult, "project_environment_id"), false);

  operationStore.complete = (id) => ({
    operation_id: id,
    environment_id: environmentId,
    stage: "completed",
  });
  const completeOutput = [];
  assert.equal(await runBuiltin([
    "operation", "complete", "--operation-id", operationId,
  ], { operationStore, write: (value) => completeOutput.push(value) }), true);
  assert.equal(JSON.parse(completeOutput.join("")).stage, "completed");

  await assert.rejects(() => runBuiltin([
    "environment", "remove", "--environment-id", "not-a-uuid",
  ], { environmentRegistry, write: () => {} }), /环境 ID/);
});

test("mcp serve starts one local operation router for every supported agent client", async () => {
  const { runBuiltin } = require(launcherPath);
  for (const client of ["codex", "claude", "pi", "generic"]) {
    const calls = [];
    assert.equal(await runBuiltin(["mcp", "serve", "--client", client], {
      environmentRegistry: { read() {}, get() {} },
      environmentCredentialStore: { read() {} },
      operationStore: { read() {} },
      mcpServerRunner: async (input) => calls.push(input),
    }), true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].client, client);
    assert.equal(typeof calls[0].environmentRegistry.read, "function");
    assert.equal(typeof calls[0].environmentCredentialStore.read, "function");
    assert.equal(typeof calls[0].operationStore.read, "function");
  }
  await assert.rejects(
    () => runBuiltin(["mcp", "serve", "--client", "unknown"], {
      mcpServerRunner: async () => {},
    }),
    /mcp serve 参数无效/
  );
});

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
  assert.deepEqual(resolveInvocation(["tools", "list", "--prefix", "rainbond_query_"]), {
    executable: process.execPath,
    args: [toolsBridgePath, "list", "--prefix", "rainbond_query_"],
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

test("launcher delegates a safe runtime status to one exact newer stable package", async () => {
  const { runAutoUpdatePhase } = require(launcherPath);
  const calls = [];
  const result = await runAutoUpdatePhase(["runtime", "status", "--json"], {
    currentVersion: "1.2.3",
    env: { PATH: "/usr/bin", RAINBOND_JWT: "header.payload.signature" },
    platform: "linux",
    updateState: {
      acquireLease: () => ({ release() {} }),
      recordFailure() {},
    },
    checkForUpdate: async () => ({ action: "delegate", version: "1.2.4" }),
    delegate: async (invocation, environment) => {
      calls.push({ invocation, environment });
      return { code: 0, signal: null };
    },
  });

  assert.equal(result.handled, true);
  assert.equal(result.code, 0);
  assert.deepEqual(calls[0].invocation, {
    executable: "npx",
    args: ["--yes", "--ignore-scripts", "rainskills@1.2.4", "runtime", "status", "--json"],
  });
  assert.equal(calls[0].environment.RAINSKILLS_AUTO_UPDATE_HOP, "1");
  assert.equal(calls[0].environment.RAINBOND_JWT, "header.payload.signature");
});

test("launcher holds one protected update lease through exact-version delegation", async () => {
  const { runAutoUpdatePhase } = require(launcherPath);
  const events = [];
  const result = await runAutoUpdatePhase(["runtime", "status", "--json"], {
    currentVersion: "1.2.3",
    env: {},
    updateState: {
      acquireLease() {
        events.push("acquire");
        return { release: () => events.push("release") };
      },
      read: () => ({ checked_at: null }),
      recordFailure: () => {},
    },
    checkForUpdate: async () => {
      events.push("check");
      return { action: "delegate", version: "1.2.4" };
    },
    delegate: async () => {
      events.push("delegate");
      return { code: 0, signal: null };
    },
  });

  assert.equal(result.handled, true);
  assert.deepEqual(events, ["acquire", "check", "delegate", "release"]);
});

test("the delegated stable package refreshes skills before continuing the original action", async () => {
  const { runAutoUpdatePhase } = require(launcherPath);
  const calls = [];
  const result = await runAutoUpdatePhase(["runtime", "status", "--json"], {
    currentVersion: "1.2.4",
    env: {
      RAINSKILLS_AUTO_UPDATE_HOP: "1",
      RAINSKILLS_AUTO_UPDATE_FROM: "1.2.3",
      RAINSKILLS_AUTO_UPDATE_TARGET: "1.2.4",
    },
    packageRoot: repoRoot,
    synchronizeSkills: (options) => calls.push(["sync", options.packageRoot]),
    updateState: {
      recordApplied: (version) => calls.push(["applied", version]),
    },
    checkForUpdate: async () => {
      throw new Error("delegated package must not check npm again");
    },
  });

  assert.deepEqual(result, { handled: false, reason: "delegated-sync-complete" });
  assert.deepEqual(calls, [["sync", repoRoot], ["applied", "1.2.4"]]);
});

test("a failed delegated skill refresh falls back to the old package without user-visible onboarding", async () => {
  const { AUTO_UPDATE_FALLBACK_EXIT_CODE, runAutoUpdatePhase } = require(launcherPath);
  const child = await runAutoUpdatePhase(["runtime", "status", "--json"], {
    currentVersion: "1.2.4",
    env: {
      RAINSKILLS_AUTO_UPDATE_HOP: "1",
      RAINSKILLS_AUTO_UPDATE_FROM: "1.2.3",
      RAINSKILLS_AUTO_UPDATE_TARGET: "1.2.4",
    },
    synchronizeSkills: () => {
      throw new Error("unsafe destination");
    },
    updateState: { recordFailure: () => {} },
  });
  assert.deepEqual(child, {
    handled: true,
    code: AUTO_UPDATE_FALLBACK_EXIT_CODE,
    signal: null,
  });

  let failures = 0;
  const parent = await runAutoUpdatePhase(["runtime", "status", "--json"], {
    currentVersion: "1.2.3",
    env: {},
    checkForUpdate: async () => ({ action: "delegate", version: "1.2.4" }),
    delegate: async () => ({ code: AUTO_UPDATE_FALLBACK_EXIT_CODE, signal: null }),
    updateState: { recordFailure: () => { failures += 1; } },
  });
  assert.deepEqual(parent, { handled: false, reason: "delegated-update-failed" });
  assert.equal(failures, 1);
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
  assert.equal(parseRuntimeConnectArgs([
    "runtime", "connect", "codex", "--install-private", "--location", "local",
    "--intent-json", JSON.stringify(intent),
  ]).privateLocation, "local");
  assert.equal(parseRuntimeConnectArgs([
    "runtime", "connect", "codex", "--install-private", "--location", "server",
    "--intent-json", JSON.stringify(intent),
  ]).privateLocation, "server");
  assert.throws(() => parseRuntimeConnectArgs([
    "runtime", "connect", "codex", "--saas", "--location", "local",
    "--intent-json", JSON.stringify(intent),
  ]), /location.*install-private|私有.*位置/i);
  assert.throws(() => parseRuntimeConnectArgs([
    "runtime", "connect", "codex", "--install-private", "--location", "cluster",
    "--intent-json", JSON.stringify(intent),
  ]), /location|位置/i);
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

test("runtime persist-connect-credential writes the isolated environment store without legacy shell state", async () => {
  const { runBuiltin } = require(launcherPath);
  const { createEnvironmentRegistry } = require(path.join(
    repoRoot, "rainbond-platform-installer", "scripts", "environment-registry.js"
  ));
  const { createEnvironmentCredentialStore } = require(path.join(
    repoRoot, "rainbond-platform-installer", "scripts", "environment-credentials.js"
  ));
  const { createRuntimeOperationStore } = require(path.join(
    repoRoot, "rainbond-platform-installer", "scripts", "runtime-operations.js"
  ));
  const { createPortableSecureStateStore } = require("./helpers/portable-secure-state.js");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "rainskills-isolated-connect-"));
  const stateStore = createPortableSecureStateStore(home);
  const environmentId = "11111111-1111-4111-8111-111111111111";
  const operationId = "1d6754d6-6fb3-4bda-9a04-15c2d261d178";
  const registry = createEnvironmentRegistry({
    home, stateStore, randomUUID: () => environmentId,
    now: () => "2026-08-17T00:00:00.000Z",
  });
  const credentials = createEnvironmentCredentialStore({ home, stateStore });
  const operations = createRuntimeOperationStore({ home, stateStore, registry });
  operations.createPending({ operationId, intent: { type: "deploy" } });

  await runBuiltin([
    "runtime", "persist-connect-credential", "--onboarding-id", operationId,
  ], {
    runtimeStateManager: { read: () => ({
      state: "connecting",
      operation_id: operationId,
      target_client: "codex",
      environment_kind: "private",
      console_origin: "https://console.example.com",
    }) },
    environmentRegistry: registry,
    environmentCredentialStore: credentials,
    operationStore: operations,
    credentialEnvironment: { RAINBOND_JWT: "fixtureHeader.fixturePayload.fixtureSignature" },
  });

  assert.equal(registry.read().default_environment_id, environmentId);
  assert.equal(operations.read(operationId).environment_id, environmentId);
  assert.equal(credentials.read({
    environmentId,
    expectedOrigin: "https://console.example.com",
  }).token, "fixtureHeader.fixturePayload.fixtureSignature");
  assert.equal(fs.existsSync(path.join(home, ".rainbond", "mcp.env")), false);
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

test("runtime connect registers and binds one environment without changing an existing default", async () => {
  const { runBuiltin } = require(launcherPath);
  const { createEnvironmentRegistry } = require(path.join(
    repoRoot, "rainbond-platform-installer", "scripts", "environment-registry.js"
  ));
  const { createEnvironmentCredentialStore } = require(path.join(
    repoRoot, "rainbond-platform-installer", "scripts", "environment-credentials.js"
  ));
  const { createRuntimeOperationStore } = require(path.join(
    repoRoot, "rainbond-platform-installer", "scripts", "runtime-operations.js"
  ));
  const { createPortableSecureStateStore } = require("./helpers/portable-secure-state.js");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "rainskills-connect-environment-"));
  const stateStore = createPortableSecureStateStore(home);
  const ids = [
    "11111111-1111-4111-8111-111111111111",
    "22222222-2222-4222-8222-222222222222",
  ];
  const registry = createEnvironmentRegistry({
    home,
    stateStore,
    randomUUID: () => ids.shift(),
    now: () => "2026-08-17T00:00:00.000Z",
  });
  const production = registry.add({
    kind: "private",
    consoleOrigin: "https://prod.example.com",
    connectionState: "connected",
    name: "生产环境",
  }).environment;
  const credentialStore = createEnvironmentCredentialStore({ home, stateStore });
  const operations = createRuntimeOperationStore({
    home,
    stateStore,
    registry,
    now: () => "2026-08-17T00:00:01.000Z",
  });
  const operationId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  let current = { state: "not_started" };
  const runtimeStateManager = {
    startConnecting(connection) {
      current = { ...connection, state: "connecting" };
      return current;
    },
    async markConnected(connection) {
      current = { ...connection, state: "connected" };
      return current;
    },
    read() { return current; },
  };
  const output = [];

  assert.equal(await runBuiltin([
    "runtime", "connect", "codex",
    "--rainbond-url", "https://test.example.com",
    "--onboarding-id", operationId,
    "--intent-json", JSON.stringify({ type: "deploy", project_root: "/workspace/demo" }),
  ], {
    runtimeStateManager,
    environmentRegistry: registry,
    environmentCredentialStore: credentialStore,
    operationStore: operations,
    connectedCredentialReader: () => ({
      origin: "https://test.example.com",
      token: "test.payload.signature",
    }),
    originInspector: async () => ({
      origin: "https://test.example.com",
      pendingRedirectOrigin: "",
      httpConfirmationRequired: false,
    }),
    connectionRunner: async () => ({ code: 0, signal: null, completesRuntimeState: false }),
    write: (value) => output.push(value),
  }), true);

  const result = JSON.parse(output.at(-1));
  assert.equal(result.environment_id, "22222222-2222-4222-8222-222222222222");
  assert.equal(registry.read().default_environment_id, production.id);
  assert.equal(registry.list().length, 2);
  assert.equal(operations.read(operationId).environment_id, result.environment_id);
  assert.equal(
    credentialStore.read({
      environmentId: result.environment_id,
      expectedOrigin: "https://test.example.com",
    }).token,
    "test.payload.signature"
  );
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
    "runtime", "connect", "claude", "--install-private", "--location", "server", "--intent-json",
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
  assert.equal(calls[0].privateLocation, "server");
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
    {
      status: async () => ({ state: "connecting", usable: false }),
      read: () => baseState,
      assertContinuationEligible: () => baseState,
      prepareContinuation: () => baseState,
    },
    {
      status: async () => ({ state: "connected", usable: false }),
      read: () => baseState,
      assertContinuationEligible: () => baseState,
      prepareContinuation: () => baseState,
    },
    {
      status: async () => ({ state: "connected", usable: true }),
      read: () => ({ ...baseState, operation_id: otherOperationId }),
      assertContinuationEligible() { throw new Error("runtime operation mismatch"); },
      prepareContinuation() { throw new Error("runtime operation mismatch"); },
    },
    {
      status: async () => ({ state: "connected", usable: true }),
      read: () => ({ ...baseState, intent: null }),
      assertContinuationEligible() { throw new Error("runtime intent missing"); },
      prepareContinuation() { throw new Error("runtime intent missing"); },
    },
  ]) {
    await assert.rejects(() => runBuiltin([
      "intent", "resume", "--onboarding-id", operationId,
    ], { runtimeStateManager }), /runtime|operation|intent|usable|连接/i);
  }
});

test("runtime record-failure accepts only the fixed operation, step, and reason argv", async () => {
  const { runBuiltin } = require(launcherPath);
  const operationId = "1d6754d6-6fb3-4bda-9a04-15c2d261d178";
  const calls = [];
  assert.equal(await runBuiltin([
    "runtime", "record-failure", "--onboarding-id", operationId,
    "--step", "read", "--reason", "credential-expired",
  ], {
    runtimeStateManager: {
      recordFailure(value) { calls.push(value); return { last_failure_category: value.reason }; },
    },
    write(value) { calls.push(JSON.parse(value)); },
  }), true);
  assert.deepEqual(calls[0], {
    operationId,
    step: "read",
    reason: "credential-expired",
  });
  assert.equal(calls[1].failure_category, "credential-expired");
  assert.equal(calls[1].retry_available, false);

  for (const args of [
    ["runtime", "record-failure", "--onboarding-id", "not-a-uuid", "--step", "read", "--reason", "credential-expired"],
    ["runtime", "record-failure", "--onboarding-id", operationId, "--step", "read", "--reason", "invalid_token"],
    ["runtime", "record-failure", "--onboarding-id", operationId, "--step", "read", "--reason", "permission-denied", "--extra"],
  ]) {
    await assert.rejects(() => runBuiltin(args, {
      runtimeStateManager: { recordFailure() { throw new Error("must not be called"); } },
    }), /参数|reason|原因|operation|onboarding/i);
  }
});

test("runtime reconnect reauthorizes the exact protected connection and live-probes it", async () => {
  const { runBuiltin } = require(launcherPath);
  const operationId = "1d6754d6-6fb3-4bda-9a04-15c2d261d178";
  const intent = { type: "query", operation: "summary", app_id: "app-1" };
  const connection = {
    target_client: "all",
    environment_kind: "private",
    console_origin: "https://console.example.com",
    intent,
    operation_id: operationId,
  };
  const events = [];
  let current = { ...connection, state: "connecting", retry_budget: 1, retry_count: 0 };
  let output = "";
  await runBuiltin(["runtime", "reconnect", "--onboarding-id", operationId], {
    runtimeStateManager: {
      async withReconnectLease(id, action) {
        assert.equal(id, operationId);
        return action(this.reconnectInput(id));
      },
      reconnectInput(id) { events.push(["read", id]); return connection; },
      read() { return current; },
      async markConnected(input) {
        events.push(["probe", input]);
        current = { ...current, state: "connected" };
      },
    },
    originInspector: async (origin) => ({
      origin,
      httpConfirmationRequired: false,
      pendingRedirectOrigin: null,
    }),
    async connectionRunner(invocation, context) {
      events.push(["authorize", invocation, context.origin, context.options]);
      return { code: 0, completesRuntimeState: false };
    },
    write(value) { output += value; },
  });

  assert.deepEqual(events.map(([event]) => event), ["read", "authorize", "probe"]);
  assert.equal(events[1][1].args.includes("--rainbond-url"), true);
  assert.equal(events[1][1].args.includes("https://console.example.com"), true);
  assert.equal(JSON.stringify(events).includes("token"), false);
  assert.deepEqual(JSON.parse(output), {
    schema: "rainskills.runtime-reconnect-result.v1",
    state: "connected",
    onboarding_id: operationId,
    environment_kind: "private",
  });
});

test("runtime reconnect rotates only the operation environment credential", async () => {
  const { runBuiltin } = require(launcherPath);
  const { createEnvironmentRegistry } = require(path.join(
    repoRoot, "rainbond-platform-installer", "scripts", "environment-registry.js"
  ));
  const { createEnvironmentCredentialStore } = require(path.join(
    repoRoot, "rainbond-platform-installer", "scripts", "environment-credentials.js"
  ));
  const { createRuntimeOperationStore } = require(path.join(
    repoRoot, "rainbond-platform-installer", "scripts", "runtime-operations.js"
  ));
  const { createPortableSecureStateStore } = require("./helpers/portable-secure-state.js");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "rainskills-reconnect-environment-"));
  const stateStore = createPortableSecureStateStore(home);
  const environmentId = "11111111-1111-4111-8111-111111111111";
  const operationId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const registry = createEnvironmentRegistry({
    home,
    stateStore,
    randomUUID: () => environmentId,
    now: () => "2026-08-17T00:00:00.000Z",
  });
  registry.add({
    kind: "private",
    consoleOrigin: "https://prod.example.com",
    connectionState: "connected",
  });
  const credentialStore = createEnvironmentCredentialStore({ home, stateStore });
  credentialStore.write({
    environmentId,
    origin: "https://prod.example.com",
    token: "old.payload.signature",
  });
  const operations = createRuntimeOperationStore({
    home,
    stateStore,
    registry,
    now: () => "2026-08-17T00:00:01.000Z",
  });
  operations.begin({ operationId, environmentId, intent: { type: "deploy" } });
  operations.recordFailure(operationId, { step: "build", reason: "credential-expired" });
  const connection = {
    state: "connected",
    target_client: "codex",
    environment_kind: "private",
    console_origin: "https://prod.example.com",
    intent: { type: "deploy" },
    operation_id: operationId,
  };
  const runtimeStateManager = {
    async withReconnectLease(id, action) {
      assert.equal(id, operationId);
      return action(connection);
    },
    async markConnected() {},
    read: () => connection,
  };

  const output = [];
  assert.equal(await runBuiltin([
    "runtime", "reconnect", "--onboarding-id", operationId,
  ], {
    runtimeStateManager,
    environmentRegistry: registry,
    environmentCredentialStore: credentialStore,
    operationStore: operations,
    connectedCredentialReader: () => ({
      origin: "https://prod.example.com",
      token: "new.payload.signature",
    }),
    originInspector: async () => ({
      origin: "https://prod.example.com",
      pendingRedirectOrigin: "",
      httpConfirmationRequired: false,
    }),
    connectionRunner: async () => ({ code: 0, signal: null, completesRuntimeState: true }),
    write: (value) => output.push(value),
  }), true);

  assert.equal(
    credentialStore.read({
      environmentId,
      expectedOrigin: "https://prod.example.com",
    }).token,
    "new.payload.signature"
  );
  assert.equal(registry.list().length, 1);
  assert.equal(JSON.parse(output.at(-1)).environment_id, environmentId);
});

test("runtime reconnect completion rejects drift in any protected connection field", async () => {
  const { runBuiltin } = require(launcherPath);
  const operationId = "1d6754d6-6fb3-4bda-9a04-15c2d261d178";
  const connection = {
    target_client: "codex",
    environment_kind: "private",
    console_origin: "https://console.example.com",
    intent: { type: "query", operation: "summary" },
    operation_id: operationId,
  };
  for (const drift of [
    { target_client: "claude" },
    { environment_kind: "saas" },
    { console_origin: "https://other.example.com" },
    { intent: { type: "query", operation: "logs" } },
  ]) {
    let output = "";
    await assert.rejects(() => runBuiltin([
      "runtime", "reconnect", "--onboarding-id", operationId,
    ], {
      runtimeStateManager: {
        async withReconnectLease(_id, action) { return action(connection); },
        reconnectInput: () => connection,
        read: () => ({ ...connection, ...drift, state: "connected" }),
      },
      originInspector: async (origin) => ({ origin, httpConfirmationRequired: false, pendingRedirectOrigin: null }),
      connectionRunner: async () => ({ code: 0, completesRuntimeState: true }),
      write(value) { output += value; },
    }), /重新授权失败|reconnect|重连/i);
    assert.equal(output.trim().split("\n").length, 1);
    assert.equal(JSON.parse(output).action, "retry-runtime-reconnect");
  }
});

test("concurrent runtime reconnect holds one authorization lease", async () => {
  const { runBuiltin } = require(launcherPath);
  const { createRuntimeStateManager } = require(path.join(
    repoRoot,
    "rainbond-platform-installer",
    "scripts",
    "runtime-state.js"
  ));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "rainskills-reconnect-race-"));
  const operationId = "1d6754d6-6fb3-4bda-9a04-15c2d261d178";
  const input = {
    target_client: "codex",
    environment_kind: "saas",
    console_origin: "https://run.rainbond.com",
    intent: { type: "query", operation: "summary" },
    operation_id: operationId,
  };
  const bootstrap = createRuntimeStateManager({ home, liveProbe: async () => true });
  bootstrap.startConnecting(input);
  await bootstrap.markConnected(input);
  bootstrap.recordFailure({ operationId, step: "read", reason: "credential-expired" });
  const firstManager = createRuntimeStateManager({ home, liveProbe: async () => true });
  const secondManager = createRuntimeStateManager({ home, liveProbe: async () => true });
  let releaseFirst;
  let authorizations = 0;
  const first = runBuiltin(["runtime", "reconnect", "--onboarding-id", operationId], {
    runtimeStateManager: firstManager,
    originInspector: async (origin) => ({ origin, httpConfirmationRequired: false, pendingRedirectOrigin: null }),
    connectionRunner: async (_invocation, context) => {
      authorizations += 1;
      await new Promise((resolve) => { releaseFirst = resolve; });
      await context.completeWithCredential("fixtureHeader.fixturePayload.fixtureSignature");
      return { code: 0, completesRuntimeState: true };
    },
    write() {},
  });
  while (!releaseFirst) await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(() => runBuiltin([
    "runtime", "reconnect", "--onboarding-id", operationId,
  ], {
    runtimeStateManager: secondManager,
    originInspector: async (origin) => ({ origin, httpConfirmationRequired: false, pendingRedirectOrigin: null }),
    connectionRunner: async () => { authorizations += 1; return { code: 1 }; },
    write() {},
  }), /运行|稍后|lock|锁|正在/i);
  assert.equal(authorizations, 1);
  releaseFirst();
  await first;
});

test("an old runtime connect action cannot bypass an exhausted credential retry", async () => {
  const { runBuiltin } = require(launcherPath);
  const { createRuntimeStateManager } = require(path.join(
    repoRoot,
    "rainbond-platform-installer",
    "scripts",
    "runtime-state.js"
  ));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "rainskills-retry-bypass-"));
  const operationId = "1d6754d6-6fb3-4bda-9a04-15c2d261d178";
  const intent = { type: "query", operation: "summary" };
  const input = {
    target_client: "codex",
    environment_kind: "saas",
    console_origin: "https://run.rainbond.com",
    intent,
    operation_id: operationId,
  };
  const manager = createRuntimeStateManager({ home, liveProbe: async () => true });
  manager.startConnecting(input);
  await manager.markConnected(input);
  manager.recordFailure({ operationId, step: "read", reason: "credential-expired" });
  await manager.markConnected(input);
  manager.prepareContinuation(operationId);
  manager.recordFailure({ operationId, step: "read", reason: "credential-expired" });

  let authorizations = 0;
  await assert.rejects(() => runBuiltin([
    "runtime", "connect", "codex", "--saas", "--onboarding-id", operationId,
    "--intent-json", JSON.stringify(intent),
  ], {
    runtimeStateManager: manager,
    originInspector: async () => ({
      origin: "https://run.rainbond.com",
      httpConfirmationRequired: false,
      pendingRedirectOrigin: null,
    }),
    connectionRunner: async () => { authorizations += 1; return { code: 0 }; },
    write() {},
  }), /retry|重试|credential|凭据|reconnect|重连/i);
  assert.equal(authorizations, 0);
});

test("runtime reconnect rejects operation drift and permission failures before authorization", async () => {
  const { runBuiltin } = require(launcherPath);
  const operationId = "1d6754d6-6fb3-4bda-9a04-15c2d261d178";
  for (const managerError of ["operation mismatch", "permission denied", "retry budget exhausted"]) {
    let authorizations = 0;
    await assert.rejects(() => runBuiltin([
      "runtime", "reconnect", "--onboarding-id", operationId,
    ], {
      runtimeStateManager: {
        async withReconnectLease(_id, action) { return action(this.reconnectInput()); },
        reconnectInput() { throw new Error(managerError); },
      },
      connectionRunner: async () => { authorizations += 1; },
    }), /operation|permission|retry/i);
    assert.equal(authorizations, 0);
  }
});

test("runtime reconnect failure never returns a credential from an internal error", async () => {
  const { runBuiltin } = require(launcherPath);
  const operationId = "1d6754d6-6fb3-4bda-9a04-15c2d261d178";
  const credential = "sensitiveHeader.sensitivePayload.sensitiveSignature";
  let output = "";
  let observed;
  try {
    await runBuiltin(["runtime", "reconnect", "--onboarding-id", operationId], {
      runtimeStateManager: {
        async withReconnectLease(_id, action) { return action(this.reconnectInput()); },
        reconnectInput: () => ({
          target_client: "codex",
          environment_kind: "saas",
          console_origin: "https://run.rainbond.com",
          intent: { type: "query", operation: "summary" },
          operation_id: operationId,
        }),
      },
      originInspector: async (origin) => ({
        origin,
        httpConfirmationRequired: false,
        pendingRedirectOrigin: null,
      }),
      connectionRunner: async () => { throw new Error(`authorization failed: ${credential}`); },
      write(value) { output += value; },
    });
  } catch (error) {
    observed = error;
  }
  assert.ok(observed);
  assert.equal(observed.message.includes(credential), false);
  assert.equal(output.includes(credential), false);
  assert.deepEqual(JSON.parse(output).argv, [
    "runtime", "reconnect", "--onboarding-id", operationId,
  ]);
});

test("intent resume consumes credential retry before emitting and preserves permission errors", async () => {
  const { runBuiltin } = require(launcherPath);
  const operationId = "1d6754d6-6fb3-4bda-9a04-15c2d261d178";
  const runtime = {
    state: "connected",
    operation_id: operationId,
    intent: { type: "query", operation: "logs", app_id: "app-1" },
    failed_step: "read",
    last_failure_category: "credential-expired",
    retry_budget: 1,
    retry_count: 0,
  };
  let consumed = false;
  let output = "";
  await runBuiltin(["intent", "resume", "--onboarding-id", operationId], {
    runtimeStateManager: {
      read: () => runtime,
      assertContinuationEligible: () => runtime,
      status: async () => ({ state: "connected", usable: true }),
      prepareContinuation(id) {
        assert.equal(id, operationId);
        consumed = true;
        return { ...runtime, retry_budget: 0, retry_count: 1 };
      },
    },
    write(value) {
      assert.equal(consumed, true);
      output += value;
    },
  });
  assert.equal(JSON.parse(output).resume_step, "read");

  await assert.rejects(() => runBuiltin([
    "intent", "resume", "--onboarding-id", operationId,
  ], {
    runtimeStateManager: {
      read: () => ({ ...runtime, last_failure_category: "permission-denied", retry_budget: 0 }),
      assertContinuationEligible() { throw new Error("permission denied"); },
      status: async () => { throw new Error("permission must fail before probe"); },
      prepareContinuation() { throw new Error("permission denied"); },
    },
  }), /permission/i);
});

test("intent resume rejects operation mismatch before live probe or credential renewal", async () => {
  const { runBuiltin } = require(launcherPath);
  const requestedOperation = "1d6754d6-6fb3-4bda-9a04-15c2d261d178";
  let probes = 0;
  await assert.rejects(() => runBuiltin([
    "intent", "resume", "--onboarding-id", requestedOperation,
  ], {
    runtimeStateManager: {
      assertContinuationEligible() { throw new Error("runtime operation mismatch"); },
      status: async () => { probes += 1; return { state: "connected", usable: true }; },
      prepareContinuation() { throw new Error("must not consume"); },
    },
  }), /operation|匹配/i);
  assert.equal(probes, 0);
});

test("every intent survives separate-process credential recovery and permission denial", async () => {
  const runtimeStateModule = path.join(
    repoRoot,
    "rainbond-platform-installer",
    "scripts",
    "runtime-state.js"
  );
  const cases = [
    [{ type: "deploy", project_root: "/workspace/app", source_kind: "local" }, "build", "rainbond-app-assistant"],
    [{ type: "create", project_root: "/workspace/app", source_kind: "git", source_url: "https://github.com/example/app.git" }, "runtime", "rainbond-app-assistant"],
    [{ type: "template-install", template_id: "wordpress", install_scope: "new-app" }, "install", "rainbond-template-installer"],
    [{ type: "query", operation: "logs", app_id: "app-1" }, "read", "rainbond-app-assistant"],
    [{ type: "troubleshoot", operation: "runtime", app_id: "app-1" }, "repair", "rainbond-app-assistant"],
    [{ type: "modify", team_id: "team-1", app_id: "app-1", operation: "env" }, "apply", "rainbond-app-assistant"],
    [{ type: "delivery-verify", operation: "full", app_id: "app-1" }, "access", "rainbond-delivery-verifier"],
    [{ type: "snapshot", team_id: "team-1", app_id: "app-1", operation: "create" }, "prepare", "rainbond-app-version-assistant"],
    [{ type: "publish", team_id: "team-1", app_id: "app-1", destination: "local-library" }, "apply", "rainbond-app-version-assistant"],
    [{ type: "rollback", team_id: "team-1", app_id: "app-1", snapshot_id: "snap-1", operation: "apply" }, "verify", "rainbond-app-version-assistant"],
  ];
  const driverDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "rainskills-recovery-driver-"));
  const driverPath = path.join(driverDirectory, "driver.js");
  fs.writeFileSync(driverPath, [
    `const fs = require(${JSON.stringify("node:fs")});`,
    `const { runBuiltin } = require(${JSON.stringify(launcherPath)});`,
    `const { createRuntimeStateManager } = require(${JSON.stringify(runtimeStateModule)});`,
    "const command = process.argv.slice(2);",
    "const manager = createRuntimeStateManager({ home: process.env.HOME, liveProbe: async () => true });",
    "runBuiltin(command, {",
    "  runtimeStateManager: manager,",
    "  originInspector: async (origin) => ({ origin, httpConfirmationRequired: false, pendingRedirectOrigin: null }),",
    "  connectionRunner: async (_invocation, context) => {",
    "    if (process.env.RAINSKILLS_TEST_RUNNER_MARKER) fs.writeFileSync(process.env.RAINSKILLS_TEST_RUNNER_MARKER, 'called\\n');",
    "    await context.completeWithCredential('fixtureHeader.fixturePayload.fixtureSignature');",
    "    return { code: 0, completesRuntimeState: true };",
    "  },",
    "}).then((handled) => {",
    "  if (!handled) throw new Error('unhandled command');",
    "}).catch((error) => {",
    "  console.error(`error: ${error.message}`);",
    "  process.exitCode = 1;",
    "});",
    "",
  ].join("\n"), { mode: 0o600 });

  const runChild = (home, command, extraEnvironment = {}) => spawnSync(
    process.execPath,
    [driverPath, ...command],
    {
      encoding: "utf8",
      env: { ...process.env, HOME: home, ...extraEnvironment },
    }
  );
  const bootstrap = async (home, operationId, intent) => {
    const { createRuntimeStateManager } = require(runtimeStateModule);
    const manager = createRuntimeStateManager({ home, liveProbe: async () => true });
    const input = {
      target_client: "codex",
      environment_kind: "saas",
      console_origin: "https://console.rainbond.com",
      intent,
      operation_id: operationId,
    };
    manager.startConnecting(input);
    await manager.markConnected(input);
    return manager;
  };

  for (const [intent, failedStep, skillId] of cases) {
    const credentialHome = fs.mkdtempSync(path.join(os.tmpdir(), "rainskills-recovery-credential-"));
    const operationId = require("node:crypto").randomUUID();
    const manager = await bootstrap(credentialHome, operationId, intent);
    const record = runChild(credentialHome, [
      "runtime", "record-failure", "--onboarding-id", operationId,
      "--step", failedStep, "--reason", "credential-expired",
    ]);
    assert.equal(record.status, 0, record.stderr);
    assert.equal(record.stdout.includes("fixtureHeader"), false);

    const reconnect = runChild(credentialHome, [
      "runtime", "reconnect", "--onboarding-id", operationId,
    ]);
    assert.equal(reconnect.status, 0, reconnect.stderr);
    assert.equal(reconnect.stdout.includes("fixtureHeader"), false);

    const resume = runChild(credentialHome, [
      "intent", "resume", "--onboarding-id", operationId,
    ]);
    assert.equal(resume.status, 0, resume.stderr);
    assert.deepEqual(JSON.parse(resume.stdout), {
      schema: "rainskills.intent-continuation.v1",
      skill_id: skillId,
      intent,
      resume_step: failedStep,
    });
    assert.equal(manager.read().retry_count, 1);
    assert.equal(manager.read().retry_budget, 0);

    const secondRecord = runChild(credentialHome, [
      "runtime", "record-failure", "--onboarding-id", operationId,
      "--step", failedStep, "--reason", "credential-expired",
    ]);
    assert.equal(secondRecord.status, 0, secondRecord.stderr);
    const secondRetryMarker = path.join(credentialHome, "second-retry-called");
    const secondReconnect = runChild(credentialHome, [
      "runtime", "reconnect", "--onboarding-id", operationId,
    ], { RAINSKILLS_TEST_RUNNER_MARKER: secondRetryMarker });
    assert.equal(secondReconnect.status, 1);
    assert.match(secondReconnect.stderr, /retry|重试|budget/i);
    assert.equal(fs.existsSync(secondRetryMarker), false);

    const permissionHome = fs.mkdtempSync(path.join(os.tmpdir(), "rainskills-recovery-permission-"));
    const permissionOperationId = require("node:crypto").randomUUID();
    await bootstrap(permissionHome, permissionOperationId, intent);
    const permissionRecord = runChild(permissionHome, [
      "runtime", "record-failure", "--onboarding-id", permissionOperationId,
      "--step", failedStep, "--reason", "permission-denied",
    ]);
    assert.equal(permissionRecord.status, 0, permissionRecord.stderr);
    const permissionMarker = path.join(permissionHome, "permission-retry-called");
    const permissionReconnect = runChild(permissionHome, [
      "runtime", "reconnect", "--onboarding-id", permissionOperationId,
    ], { RAINSKILLS_TEST_RUNNER_MARKER: permissionMarker });
    assert.equal(permissionReconnect.status, 1);
    assert.match(permissionReconnect.stderr, /permission|权限/i);
    assert.equal(fs.existsSync(permissionMarker), false);
    const permissionResume = runChild(permissionHome, [
      "intent", "resume", "--onboarding-id", permissionOperationId,
    ]);
    assert.equal(permissionResume.status, 1);
    assert.match(permissionResume.stderr, /permission|权限/i);
    assert.equal(permissionResume.stdout, "");
  }
});
