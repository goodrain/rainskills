const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createPortableSecureStateStore } = require("./helpers/portable-secure-state.js");

const repoRoot = path.resolve(__dirname, "..");
const secureStatePath = path.join(
  repoRoot,
  "rainbond-platform-installer",
  "scripts",
  "secure-state.js"
);
const windowsOnboardingPath = path.join(
  repoRoot,
  "rainbond-platform-installer",
  "scripts",
  "windows-onboarding.js"
);
const platformInstallerPath = path.join(
  repoRoot,
  "rainbond-platform-installer",
  "scripts",
  "platform-installer.js"
);

function temporaryHome() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rainskills-windows-home-")));
}

function writeSkill(root, name, body = "initial\n") {
  const directory = path.join(root, name);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(directory, "SKILL.md"),
    `---\nname: ${name}\ndescription: Test skill\n---\n\n${body}`
  );
  return directory;
}

function writeBridge(root, body = "#!/usr/bin/env node\n") {
  const bridge = path.join(root, "bin", "rainskills-tools.js");
  fs.mkdirSync(path.dirname(bridge), { recursive: true });
  fs.writeFileSync(bridge, body);
  return bridge;
}

function authorizationParams(url) {
  const parsed = new URL(url);
  const queryIndex = parsed.hash.indexOf("?");
  return new URLSearchParams(queryIndex >= 0 ? parsed.hash.slice(queryIndex + 1) : "");
}

test("secure state preserves POSIX modes and blocks paths outside home", {
  skip: process.platform === "win32",
}, () => {
  const { createSecureStateStore } = require(secureStatePath);
  const home = temporaryHome();
  const store = createSecureStateStore({ platform: "linux", home });
  const directory = path.join(home, ".rainbond", "state");
  const filePath = path.join(directory, "state.json");

  store.ensurePrivateDirectory(directory);
  store.atomicWriteJson(filePath, { ok: true });

  assert.equal(fs.lstatSync(directory).mode & 0o777, 0o700);
  assert.equal(fs.lstatSync(filePath).mode & 0o777, 0o600);
  assert.deepEqual(store.readProtectedJson(filePath), { ok: true });
  assert.throws(
    () => store.ensurePrivateDirectory(path.join(home, "..", "escaped")),
    /当前用户目录/
  );
});

test("secure state enforces Windows owner, ACL, and reparse-point checks", () => {
  const { createSecureStateStore } = require(secureStatePath);
  const home = temporaryHome();
  const facts = new Map();
  const hardened = [];
  const store = createSecureStateStore({
    platform: "win32",
    home,
    currentSid: "S-1-5-21-current",
    hardenWindowsAcl(target, kind) {
      hardened.push({ target, kind });
      facts.set(target, {
        reparsePoint: false,
        ownerSid: "S-1-5-21-current",
        writableSids: ["S-1-5-18", "S-1-5-32-544", "S-1-5-21-current"],
      });
    },
    inspectWindowsAcl(target) {
      return facts.get(target);
    },
  });
  const directory = path.join(home, ".rainbond");
  const filePath = path.join(directory, "state.json");

  store.ensurePrivateDirectory(directory);
  store.atomicWriteJson(filePath, { ok: true });
  assert.deepEqual(store.readProtectedJson(filePath), { ok: true });
  assert.ok(hardened.some((entry) => entry.target === filePath && entry.kind === "file"));

  facts.set(filePath, { ...facts.get(filePath), reparsePoint: true });
  assert.throws(() => store.readProtectedJson(filePath), /reparse point/i);
  facts.set(filePath, {
    reparsePoint: false,
    ownerSid: "S-1-5-21-other",
    writableSids: [],
  });
  assert.throws(() => store.readProtectedJson(filePath), /owner/i);
  store.protectRegularFile(filePath);
  assert.deepEqual(store.readProtectedJson(filePath), { ok: true });
  facts.set(filePath, {
    reparsePoint: false,
    ownerSid: "S-1-5-21-current",
    writableSids: ["S-1-1-0"],
  });
  assert.throws(() => store.readProtectedJson(filePath), /Everyone|Users/i);
});

test("operation locks reject live owners and reclaim proven stale owners", () => {
  const home = temporaryHome();
  const operationId = "1d6754d6-6fb3-4bda-9a04-15c2d261d178";
  const live = new Set([101]);
  const createStore = (pid) => createPortableSecureStateStore(home, {
    pid,
    processIdentity: `process-${pid}`,
    isProcessAlive(ownerPid) {
      return live.has(ownerPid);
    },
  });

  const first = createStore(101).acquireOperationLock({ operationId });
  assert.throws(
    () => createStore(202).acquireOperationLock({ operationId }),
    /正在运行|resume/i
  );

  live.delete(101);
  const second = createStore(202).acquireOperationLock({ operationId });
  first.release();
  assert.equal(fs.existsSync(second.path), true);
  second.release();
  assert.equal(fs.existsSync(second.path), false);
});

test("Windows argument parsing rejects unknown input before installation", () => {
  const { parseWindowsInstallerArgs, destinationsForTarget } = require(windowsOnboardingPath);
  const home = temporaryHome();
  const options = parseWindowsInstallerArgs([
    "all",
    "--force",
    "--skip-mcp",
    "--non-interactive",
    "--self-hosted",
    "--rainbond-url",
    "https://rainbond.example.com",
    "--no-browser",
  ]);

  assert.equal(options.target, "all");
  assert.equal(options.force, true);
  assert.equal(options.skipMcp, true);
  assert.equal(options.nonInteractive, true);
  assert.equal(options.deploymentMode, "self-hosted");
  assert.equal(options.rainbondUrl, "https://rainbond.example.com");
  assert.equal(options.noBrowser, true);
  assert.deepEqual(destinationsForTarget("all", home), [
    path.join(home, ".claude", "skills"),
    path.join(home, ".codex", "skills"),
  ]);
  assert.equal(parseWindowsInstallerArgs(["pi"]).target, "pi");
  assert.deepEqual(destinationsForTarget("pi", home), [
    path.join(home, ".pi", "agent", "skills"),
  ]);
  assert.throws(() => parseWindowsInstallerArgs(["--unknown"]), /未知参数/);
  assert.throws(() => parseWindowsInstallerArgs(["--dest"]), /--dest/);
  assert.equal(parseWindowsInstallerArgs(["codex", "--api-only"]).apiOnly, true);
  assert.equal(parseWindowsInstallerArgs(["codex", "--api-only", "--skip-mcp"]).apiOnly, true);
});

test("Windows bridge installation is atomic, protected, updatable, and reparse-safe", () => {
  const { installBridge } = require(windowsOnboardingPath);
  const home = temporaryHome();
  const packageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rainskills-package-bridge-"));
  const source = writeBridge(packageRoot, "v1\n");
  const stateStore = createPortableSecureStateStore(home);

  const destination = installBridge({ home, packageRoot, stateStore });
  assert.equal(fs.readFileSync(destination, "utf8"), "v1\n");
  assert.equal(fs.lstatSync(destination).mode & 0o777, 0o600);
  fs.writeFileSync(source, "v2\n");
  assert.equal(installBridge({ home, packageRoot, stateStore }), destination);
  assert.equal(fs.readFileSync(destination, "utf8"), "v2\n");
  assert.equal(
    fs.readdirSync(path.dirname(destination)).some((name) => name.startsWith(".rainskills-tools.js.")),
    false
  );

  fs.writeFileSync(source, "v3\n");
  const failingStore = {
    ...stateStore,
    protectRegularFile(target) {
      if (target === destination) throw new Error("simulated ACL failure");
      return stateStore.protectRegularFile(target);
    },
  };
  assert.throws(
    () => installBridge({ home, packageRoot, stateStore: failingStore }),
    /simulated ACL failure/
  );
  assert.equal(fs.readFileSync(destination, "utf8"), "v2\n");
  assert.equal(
    fs.readdirSync(path.dirname(destination)).some((name) => name.startsWith(".rainskills-tools.js.")),
    false
  );

  fs.rmSync(path.dirname(destination), { recursive: true });
  fs.symlinkSync(path.join(home, ".codex"), path.dirname(destination), "dir");
  assert.throws(
    () => installBridge({ home, packageRoot, stateStore }),
    /symbolic|符号链接|reparse/i
  );
});

test("Codex installation writes a protected rule for CLI-enforced reads only", () => {
  const { installCodexReadRule } = require(windowsOnboardingPath);
  const home = temporaryHome();
  const stateStore = createPortableSecureStateStore(home);
  const bridge = path.join(home, ".rainbond", "bin", "rainskills-tools.js");
  fs.mkdirSync(path.dirname(bridge), { recursive: true });
  fs.writeFileSync(bridge, "#!/usr/bin/env node\n");

  const destination = installCodexReadRule({ home, bridge, stateStore });
  const rule = fs.readFileSync(destination, "utf8");
  assert.equal(destination, path.join(home, ".codex", "rules", "rainskills.rules"));
  assert.equal(fs.lstatSync(destination).mode & 0o777, 0o600);
  assert.match(rule, /prefix_rule\(/);
  assert.match(rule, /decision = "allow"/);
  assert.match(rule, /\["status", "list", "describe", "read"\]/);
  assert.match(rule, new RegExp(JSON.stringify(bridge).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(rule, /"call"|network_access/);
});

test("Windows skill copying installs, skips, updates, and force-overwrites atomically", () => {
  const {
    copySkills,
    discoverSkills,
  } = require(windowsOnboardingPath);
  const packageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rainskills-package-"));
  const destination = path.join(temporaryHome(), ".codex", "skills");
  const source = writeSkill(packageRoot, "rainbond-test");
  fs.mkdirSync(path.join(packageRoot, "rainbond-invalid"));
  fs.writeFileSync(path.join(packageRoot, "rainbond-invalid", "SKILL.md"), "invalid\n");

  assert.throws(() => discoverSkills(packageRoot), /frontmatter/);
  fs.rmSync(path.join(packageRoot, "rainbond-invalid"), { recursive: true });
  const skills = discoverSkills(packageRoot);
  assert.deepEqual(skills, [source]);

  assert.deepEqual(copySkills({ skills, destinations: [destination] }), {
    installed: 1,
    updated: 0,
    unchanged: 0,
    forced: 0,
  });
  assert.deepEqual(copySkills({ skills, destinations: [destination] }), {
    installed: 0,
    updated: 0,
    unchanged: 1,
    forced: 0,
  });

  fs.appendFileSync(path.join(source, "SKILL.md"), "changed\n");
  assert.equal(copySkills({ skills, destinations: [destination] }).updated, 1);
  assert.equal(copySkills({ skills, destinations: [destination], force: true }).forced, 1);

  const unsafeDestination = path.join(temporaryHome(), "unsafe");
  fs.symlinkSync(destination, unsafeDestination, "dir");
  assert.throws(
    () => copySkills({ skills, destinations: [unsafeDestination] }),
    /符号链接|reparse point/i
  );
});

test("native Windows checkpoint is protected and accepted by platform resume", () => {
  const {
    createOnboardingCheckpoint,
    createNextAction,
  } = require(windowsOnboardingPath);
  const { readOnboardingState } = require(platformInstallerPath);
  const home = temporaryHome();
  const stateStore = createPortableSecureStateStore(home);
  const operationId = "1d6754d6-6fb3-4bda-9a04-15c2d261d178";
  const checkpoint = createOnboardingCheckpoint({
    home,
    target: "codex",
    packageVersion: "0.1.0-test",
    control: {
      mode: "windows-native",
      hostPlatform: "win32",
      controlPlatform: "win32",
    },
    operationId,
    now: () => "2026-08-03T00:00:00.000Z",
    stateStore,
    transportMode: "api",
  });

  assert.equal(checkpoint.state.control_mode, "windows-native");
  assert.equal(checkpoint.state.control_distro, null);
  assert.equal(checkpoint.state.transport_mode, "api");
  assert.equal(checkpoint.state.platform_state_path, path.join(
    home,
    ".rainbond",
    "platform-installer",
    operationId,
    "state.json"
  ));
  assert.deepEqual(
    readOnboardingState(checkpoint.path, operationId, stateStore),
    checkpoint.state
  );
  assert.deepEqual(createNextAction(operationId), {
    schema: "rainskills.next-action.v1",
    action: "install-platform",
    onboarding_id: operationId,
    argv: ["platform", "install", "--onboarding-id", operationId],
  });
});

test("native main saves private onboarding and shows the fixed continuation command", async () => {
  const { main } = require(windowsOnboardingPath);
  const home = temporaryHome();
  const packageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rainskills-package-main-"));
  const destination = path.join(home, ".codex", "skills");
  const output = [];
  writeSkill(packageRoot, "rainbond-test");
  writeBridge(packageRoot);
  fs.writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({ version: "0.1.0-test" }));
  const baseStateStore = createPortableSecureStateStore(home);
  let lockAcquisitions = 0;
  const stateStore = {
    ...baseStateStore,
    acquireOperationLock(options) {
      lockAcquisitions += 1;
      return baseStateStore.acquireOperationLock(options);
    },
  };

  const result = await main(["codex", "--self-hosted"], {
    control: {
      mode: "windows-native",
      hostPlatform: "win32",
      controlPlatform: "win32",
    },
    home,
    packageRoot,
    stateStore,
    logger(message) {
      output.push(message);
    },
  });

  assert.equal(result.status, "awaiting-platform");
  assert.equal(lockAcquisitions, 1);
  assert.equal(result.counts.installed, 1);
  assert.equal(fs.existsSync(path.join(destination, "rainbond-test", "SKILL.md")), true);
  assert.equal(fs.existsSync(path.join(home, ".rainbond", "bin", "rainskills-tools.js")), true);
  assert.equal(fs.existsSync(path.join(home, ".codex", "rules", "rainskills.rules")), true);
  assert(output.some((line) => line.includes("Codex 只读网络规则")));
  const continuationCommand = `npx rainskills@0.1.0-test platform install --onboarding-id ${result.nextAction.onboarding_id}`;
  assert(output.includes("Rainbond 平台安装将在独立步骤中继续，前面的选择已经保存。"));
  assert(output.includes("支持 Windows 本地安装，也可以安装到 Linux 服务器。"));
  assert(output.some((line) => line.includes("终端用户可以直接执行：")));
  assert(output.includes(continuationCommand));
  assert.equal(output.at(-1), continuationCommand);
  assert.equal(
    output.some((line) => line.includes('"schema":"rainskills.next-action.v1"')),
    false
  );
  assert.equal(
    fs.existsSync(path.join(
      home,
      ".rainbond",
      "rainskills-locks",
      `${result.checkpoint.state.operation_id}.lock`
    )),
    false
  );
});

test("deprecated API-only checkpoint is normalized to the CLI transport", async () => {
  const { main } = require(windowsOnboardingPath);
  const home = temporaryHome();
  const packageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rainskills-api-checkpoint-"));
  writeSkill(packageRoot, "rainbond-test");
  writeBridge(packageRoot);
  fs.writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({ version: "0.1.0-test" }));
  const result = await main(["codex", "--api-only", "--self-hosted"], {
    control: { mode: "windows-native", hostPlatform: "win32", controlPlatform: "win32" },
    home,
    packageRoot,
    stateStore: createPortableSecureStateStore(home),
    logger() {},
  });
  assert.equal(result.status, "awaiting-platform");
  assert.equal(result.checkpoint.state.transport_mode, "cli");
});

test("Windows authorization accepts GET and POST loopback callbacks with exact state", async (t) => {
  const {
    authorizeWithLoopback,
    looksLikeJwt,
  } = require(path.join(
    repoRoot,
    "rainbond-platform-installer",
    "scripts",
    "windows-auth.js"
  ));
  const token = "header.payload.signature";
  assert.equal(looksLikeJwt(token), true);
  assert.equal(looksLikeJwt("not-a-token"), false);

  for (const method of ["GET", "POST"]) {
    await t.test(method, async () => {
      let openedUrl = "";
      const result = await authorizeWithLoopback({
        baseUrl: "https://rainbond.example.com",
        timeoutMs: 5000,
        async openBrowser(url) {
          openedUrl = url;
          const parameters = authorizationParams(url);
          const callback = new URL(parameters.get("callback"));
          const state = parameters.get("state");
          const preflight = await fetch(callback, {
            method: "OPTIONS",
            headers: {
              "access-control-request-private-network": "true",
              origin: "https://rainbond.example.com",
            },
          });
          assert.equal(preflight.status, 204);
          assert.equal(preflight.headers.get("access-control-allow-private-network"), "true");
          if (method === "GET") {
            callback.searchParams.set("token", token);
            callback.searchParams.set("state", state);
            const response = await fetch(callback);
            assert.equal(response.status, 200);
          } else {
            const response = await fetch(callback, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ token, state }),
            });
            assert.equal(response.status, 200);
          }
        },
      });
      assert.equal(result, token);
      assert.match(openedUrl, /^https:\/\/rainbond\.example\.com\/#\/cli-auth\?/);
    });
  }
});

test("Windows loopback authorization rejects state mismatch, timeout, and abort", async () => {
  const { authorizeWithLoopback } = require(path.join(
    repoRoot,
    "rainbond-platform-installer",
    "scripts",
    "windows-auth.js"
  ));
  await assert.rejects(
    authorizeWithLoopback({
      baseUrl: "https://rainbond.example.com",
      timeoutMs: 1000,
      async openBrowser(url) {
        const callback = new URL(authorizationParams(url).get("callback"));
        callback.searchParams.set("token", "header.payload.signature");
        callback.searchParams.set("state", "wrong");
        await fetch(callback);
      },
    }),
    /state/i
  );
  await assert.rejects(
    authorizeWithLoopback({
      baseUrl: "https://rainbond.example.com",
      timeoutMs: 20,
      openBrowser() {},
    }),
    /超时|timeout/i
  );

  const controller = new AbortController();
  let callbackUrl = "";
  const pending = authorizeWithLoopback({
    baseUrl: "https://rainbond.example.com",
    timeoutMs: 1000,
    signal: controller.signal,
    openBrowser(url) {
      callbackUrl = authorizationParams(url).get("callback");
      controller.abort();
    },
  });
  await assert.rejects(pending, /取消|abort/i);
  await assert.rejects(fetch(callbackUrl));
});

test("Windows Device Flow pins origin and follows pending, slow_down, and Retry-After", async () => {
  const { authorizeWithDeviceFlow } = require(path.join(
    repoRoot,
    "rainbond-platform-installer",
    "scripts",
    "windows-auth.js"
  ));
  const responses = [
    new Response(JSON.stringify({
      device_code: "private-device-code",
      user_code: "BCDF-GHJK",
      verification_uri: "https://attacker.example/device",
      verification_uri_complete: "https://attacker.example/complete",
      expires_in: 600,
      interval: 1,
    }), { status: 200, headers: { "content-type": "application/json" } }),
    new Response(JSON.stringify({ error: "authorization_pending" }), { status: 400 }),
    new Response(JSON.stringify({ error: "slow_down" }), { status: 400 }),
    new Response(JSON.stringify({ error: "authorization_pending" }), {
      status: 429,
      headers: { "retry-after": "9" },
    }),
    new Response(JSON.stringify({
      access_token: "header.payload.signature",
      token_type: "Bearer",
    }), { status: 200 }),
  ];
  const calls = [];
  const sleeps = [];
  let openedUrl = "";
  const output = [];

  const token = await authorizeWithDeviceFlow({
    baseUrl: "https://rainbond.example.com",
    openBrowser(url) {
      openedUrl = url;
    },
    logger(message) {
      output.push(message);
    },
    async fetchImpl(url, options) {
      calls.push({ url, options });
      return responses.shift();
    },
    async sleep(seconds) {
      sleeps.push(seconds);
    },
    now: (() => {
      let value = 0;
      return () => value++;
    })(),
  });

  assert.equal(token, "header.payload.signature");
  assert.equal(openedUrl, "https://rainbond.example.com/#/device?user_code=BCDF-GHJK");
  assert.deepEqual(output, [
    "授权码：BCDF-GHJK",
    "授权地址：https://rainbond.example.com/#/device?user_code=BCDF-GHJK",
  ]);
  assert.deepEqual(calls.map((call) => new URL(call.url).pathname), [
    "/console/mcp/device/code",
    "/console/mcp/device/token",
    "/console/mcp/device/token",
    "/console/mcp/device/token",
    "/console/mcp/device/token",
  ]);
  assert.deepEqual(sleeps, [1, 1, 6, 9]);
  assert.equal(calls.some((call) => call.url.includes("private-device-code")), false);
});

test("Windows Device Flow handles unsupported, expiration, and cancellation", async () => {
  const { authorizeWithDeviceFlow } = require(path.join(
    repoRoot,
    "rainbond-platform-installer",
    "scripts",
    "windows-auth.js"
  ));
  await assert.rejects(
    authorizeWithDeviceFlow({
      baseUrl: "https://rainbond.example.com",
      fetchImpl: async () => new Response("Not Found", { status: 404 }),
    }),
    (error) => error.code === "DEVICE_FLOW_UNSUPPORTED"
  );
  await assert.rejects(
    authorizeWithDeviceFlow({
      baseUrl: "https://rainbond.example.com",
      fetchImpl: async () => new Response(JSON.stringify({ error: "not_found" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      }),
    }),
    (error) => error.code === "DEVICE_FLOW_UNSUPPORTED"
  );

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    authorizeWithDeviceFlow({
      baseUrl: "https://rainbond.example.com",
      signal: controller.signal,
      fetchImpl: async () => {
        throw new Error("must not fetch");
      },
    }),
    /取消|abort/i
  );

  let nowValue = 0;
  await assert.rejects(
    authorizeWithDeviceFlow({
      baseUrl: "https://rainbond.example.com",
      fetchImpl: async () => new Response(JSON.stringify({
        device_code: "private-device-code",
        user_code: "BCDF-GHJK",
        verification_uri: "https://rainbond.example.com/#/device",
        verification_uri_complete: "https://rainbond.example.com/#/device?user_code=BCDF-GHJK",
        expires_in: 1,
        interval: 1,
      }), { status: 200 }),
      openBrowser() {},
      sleep: async () => {},
      now() {
        nowValue += 1;
        return nowValue;
      },
    }),
    /超时|过期/
  );
});

test("Windows browser opener uses a fixed PowerShell file and treats URL as data", async () => {
  const { openWindowsBrowser } = require(path.join(
    repoRoot,
    "rainbond-platform-installer",
    "scripts",
    "windows-auth.js"
  ));
  const calls = [];
  const helperPath = path.join(repoRoot, "rainbond-platform-installer", "scripts", "windows-browser.ps1");
  function spawnImpl(command, args, options) {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    queueMicrotask(() => child.emit("close", 0, null));
    return child;
  }
  const url = "https://rainbond.example.com/#/device?user_code=BCDF-GHJK&next=a;b";

  await openWindowsBrowser(url, { spawnImpl, helperPath });

  assert.equal(calls[0].command, "powershell.exe");
  assert.deepEqual(calls[0].args, [
    "-NoProfile",
    "-NonInteractive",
    "-File",
    helperPath,
    "-Url",
    url,
  ]);
  assert.equal(calls[0].args.includes("-Command"), false);

  const helperSource = fs.readFileSync(helperPath, "utf8");
  assert.match(helperSource, /Start-Process -FilePath \$Url\b/);
  assert.doesNotMatch(helperSource, /Start-Process -FilePath \$uri\.AbsoluteUri/);
});

test("native CLI authorization validates the dedicated endpoint and writes protected credentials", async () => {
  const { authorizeAndConfigure, validateApi } = require(windowsOnboardingPath);
  let request;
  const validated = await validateApi({
    url: "https://rainbond.example.com/console/mcp/rainskills/api/query",
    token: "header.payload.signature",
    async fetchImpl(url, options) {
      request = { url, options };
      return new Response(JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: { tools: [] },
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  assert.deepEqual(validated, { token: "header.payload.signature" });
  assert.equal(request.url, "https://rainbond.example.com/console/mcp/rainskills/api/query");
  assert.equal(request.options.headers.Authorization, "GRJWT header.payload.signature");
  assert.equal(request.options.headers["mcp-protocol-version"], "2025-03-26");
  assert.deepEqual(JSON.parse(request.options.body), {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/list",
    params: {},
  });
  await assert.rejects(
    validateApi({
      url: request.url,
      token: "header.payload.signature",
      fetchImpl: async () => new Response(JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: { serverInfo: { name: "rainbond-console-mcp" } },
      }), { status: 200 }),
    }),
    /无法识别/
  );
  let timeoutSignal;
  await assert.rejects(
    validateApi({
      url: request.url,
      token: "header.payload.signature",
      timeoutMs: 10,
      fetchImpl: async (_url, options) => {
        timeoutSignal = options.signal;
        return new Promise(() => {});
      },
    }),
    /超时/
  );
  assert.equal(timeoutSignal.aborted, true);

  let slowReaderCancelled = false;
  await assert.rejects(
    validateApi({
      url: request.url,
      token: "header.payload.signature",
      timeoutMs: 10,
      fetchImpl: async () => ({
        ok: true,
        body: {
          getReader() {
            return {
              read() { return new Promise(() => {}); },
              async cancel() { slowReaderCancelled = true; },
            };
          },
        },
      }),
    }),
    /超时/
  );
  assert.equal(slowReaderCancelled, true);

  const oversizedChunk = new Uint8Array(6 * 1024 * 1024);
  await assert.rejects(
    validateApi({
      url: request.url,
      token: "header.payload.signature",
      maxResponseBytes: 10 * 1024 * 1024,
      fetchImpl: async () => new Response(new Blob([oversizedChunk, oversizedChunk])),
    }),
    /过大/
  );

  let successSignal;
  await validateApi({
    url: request.url,
    token: "header.payload.signature",
    timeoutMs: 10,
    async fetchImpl(_url, options) {
      successSignal = options.signal;
      return new Response(JSON.stringify({ result: { tools: [] } }));
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(successSignal.aborted, false, "success must clear its wall-clock timer");

  const calls = [];
  const home = temporaryHome();
  const stateStore = createPortableSecureStateStore(home);
  const result = await authorizeAndConfigure({
    target: "all",
    home,
    stateStore,
    baseUrl: "https://rainbond.example.com",
    authorizeWithDeviceFlowImpl: async () => "header.payload.signature",
    validateApiImpl: async ({ url, token }) => {
      calls.push({ kind: "validate", url, token });
      return { token: "renewed.payload.signature" };
    },
    openBrowser() {},
  });

  assert.deepEqual(result, { status: "cli-configured" });
  assert.equal(calls[0].url, "https://rainbond.example.com/console/mcp/rainskills/api/query");
  const credentialsPath = path.join(home, ".rainbond", "credentials.env");
  assert.equal(fs.lstatSync(credentialsPath).mode & 0o777, 0o600);
  assert.match(fs.readFileSync(credentialsPath, "utf8"), /renewed\.payload\.signature/);
});

test("native main completes an explicit SaaS configuration", async () => {
  const { main } = require(windowsOnboardingPath);
  const home = temporaryHome();
  const packageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rainskills-package-saas-"));
  writeSkill(packageRoot, "rainbond-test");
  writeBridge(packageRoot);
  fs.writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({ version: "0.1.0-test" }));
  const calls = [];
  const output = [];

  const result = await main(["codex", "--saas"], {
    authorizeAndConfigure(options) {
      calls.push(options);
      return { status: "cli-configured" };
    },
    control: {
      mode: "windows-native",
      hostPlatform: "win32",
      controlPlatform: "win32",
    },
    home,
    packageRoot,
    stateStore: createPortableSecureStateStore(home),
    logger(message) {
      output.push(message);
    },
  });

  assert.equal(result.status, "cli-configured");
  assert.equal(calls[0].baseUrl, "https://run.rainbond.com");
  assert.equal(calls[0].target, "codex");
  assert.equal(fs.existsSync(path.join(home, ".rainbond", "bin", "rainskills-tools.js")), true);
  assert.match(output.join("\n"), /重新启动 Codex/);
});

test("native deployment selection preserves Cloud, private URL, and no-platform choices", async () => {
  const {
    parseWindowsInstallerArgs,
    resolveDeployment,
  } = require(windowsOnboardingPath);

  assert.deepEqual(await resolveDeployment(
    parseWindowsInstallerArgs(["--saas"]),
    { isTty: false }
  ), {
    mode: "saas",
    baseUrl: "https://run.rainbond.com",
    needsPlatform: false,
  });
  assert.deepEqual(await resolveDeployment(
    parseWindowsInstallerArgs(["--rainbond-url", "https://rainbond.example.com"]),
    { isTty: false }
  ), {
    mode: "self-hosted",
    baseUrl: "https://rainbond.example.com",
    needsPlatform: false,
  });
  assert.deepEqual(await resolveDeployment(
    parseWindowsInstallerArgs(["--self-hosted"]),
    { isTty: false }
  ), {
    mode: "self-hosted",
    baseUrl: "",
    needsPlatform: true,
  });
  assert.deepEqual(await resolveDeployment(
    parseWindowsInstallerArgs([]),
    { isTty: false }
  ), {
    needsUserInput: true,
  });

  assert.deepEqual(await resolveDeployment(
    parseWindowsInstallerArgs([]),
    {
      isTty: true,
      promptDeployment: async () => ({
        mode: "self-hosted",
        baseUrl: "",
        needsPlatform: true,
      }),
    }
  ), {
    mode: "self-hosted",
    baseUrl: "",
    needsPlatform: true,
  });
});

test("deprecated API-only flag remains a no-op for every target", async () => {
  const { main } = require(windowsOnboardingPath);
  for (const argv of [
    ["codex", "--api-only", "--saas"],
    ["claude", "--api-only", "--saas"],
    ["pi", "--api-only", "--saas"],
    ["all", "--api-only", "--saas"],
    ["--dest", "CUSTOM", "--api-only", "--saas"],
  ]) {
    const home = temporaryHome();
    const packageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rainskills-package-api-only-"));
    writeSkill(packageRoot, "rainbond-test");
    writeBridge(packageRoot);
    fs.writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({ version: "0.1.0-test" }));
    const customDestination = path.join(home, "custom-skills");
    const actualArgv = argv.map((argument) => argument === "CUSTOM" ? customDestination : argument);
    const calls = [];
    const result = await main(actualArgv, {
      home,
      packageRoot,
      stateStore: createPortableSecureStateStore(home),
      authorizeAndConfigure(options) {
        calls.push(options);
        return { status: "cli-configured" };
      },
      logger() {},
    });
    assert.equal(result.status, actualArgv.includes("--dest") ? "skills-installed" : "cli-configured");
    if (!actualArgv.includes("--dest")) {
      assert.equal(calls[0].apiOnly, undefined, "deprecated flag must not alter authorization");
    }
    assert.equal(fs.existsSync(path.join(home, ".rainbond", "bin", "rainskills-tools.js")), true);
    if (actualArgv.includes("--dest")) {
      assert.equal(fs.existsSync(path.join(customDestination, "rainbond-test", "SKILL.md")), true);
    }
  }
});

test("CLI installation fails clearly before writes on an unsupported Node runtime", async () => {
  const { main } = require(windowsOnboardingPath);
  const home = temporaryHome();
  const packageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rainskills-package-old-node-"));
  writeSkill(packageRoot, "rainbond-test");
  writeBridge(packageRoot);
  fs.writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({ version: "0.1.0-test" }));
  await assert.rejects(
    main(["codex", "--api-only", "--saas"], {
      home,
      packageRoot,
      nodeVersion: "16.20.0",
      logger() {},
    }),
    /Node\.js 18/
  );
  assert.equal(fs.existsSync(path.join(home, ".codex", "skills")), false);
  assert.equal(fs.existsSync(path.join(home, ".rainbond", "bin")), false);

  for (const nodeVersion of ["", "not-a-version", "18oops", "17.99.0"]) {
    await assert.rejects(
      main(["codex", "--api-only", "--saas"], {
        home: temporaryHome(),
        packageRoot,
        nodeVersion,
        logger() {},
      }),
      /Node\.js 18/
    );
  }
});

test("native Windows onboarding requires an opt-in for every HTTP Console URL", async () => {
  const { main } = require(windowsOnboardingPath);
  const home = temporaryHome();
  const packageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rainskills-package-local-http-"));
  writeSkill(packageRoot, "rainbond-test");
  writeBridge(packageRoot);
  fs.writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({ version: "0.1.0-test" }));
  const calls = [];

  await assert.rejects(main(["codex", "--rainbond-url", "http://127.0.0.1:7070"], {
    home,
    packageRoot,
    authorizeAndConfigure(options) {
      calls.push(options);
      return { status: "configured" };
    },
    logger() {},
  }), /默认禁用明文 HTTP/);

  const result = await main(["codex", "--rainbond-url", "http://127.0.0.1:7070", "--allow-insecure-http"], {
    home,
    packageRoot,
    authorizeAndConfigure(options) {
      calls.push(options);
      return { status: "cli-configured" };
    },
    logger() {},
  });
  assert.equal(result.status, "cli-configured");
  assert.equal(calls[0].baseUrl, "http://127.0.0.1:7070");
});

test("native Windows onboarding still protects public HTTP Console URLs", async () => {
  const { main } = require(windowsOnboardingPath);
  const home = temporaryHome();
  const packageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rainskills-package-public-http-"));
  writeSkill(packageRoot, "rainbond-test");
  writeBridge(packageRoot);
  fs.writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({ version: "0.1.0-test" }));

  await assert.rejects(
    main(["codex", "--rainbond-url", "http://rainbond.example.com:7070"], {
      home,
      packageRoot,
      authorizeAndConfigure() {
        throw new Error("authorization should not start");
      },
      logger() {},
    }),
    /默认禁用明文 HTTP/
  );
});
