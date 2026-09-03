const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

process.env.RAINSKILLS_TELEMETRY_DISABLED = "1";

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
const approvedCapabilitySummary = `Rainskills 安装完成，下一条消息即可直接使用。

下一步可以直接说：

- 帮我部署当前项目
- 帮我部署一个 Git 仓库
- 帮我通过镜像或安装包部署应用
- 帮我安装一个应用模板
- 帮我分析当前项目应该如何部署

也可以直接告诉我你想部署什么应用。`;
const hermesCapabilitySummary = `Rainskills 安装完成。

如果安装发生在已经打开的 Hermes 会话中，请执行 /reset，或新建会话后再使用。

下一步可以直接说：

- 帮我部署当前项目
- 帮我部署一个 Git 仓库
- 帮我通过镜像或安装包部署应用
- 帮我安装一个应用模板
- 帮我分析当前项目应该如何部署

也可以直接告诉我你想部署什么应用。`;
const agentSummaryRequirement = "[RAINSKILLS_AGENT_SUMMARY_REQUIRED:include-next-actions]";
const forbiddenDefaultInstallText = [
  "Rainbond Cloud",
  "私有",
  "MCP",
  "登录",
  "授权",
  "Rainbond Console",
  "rainskills.next-action.v1",
];

function assertApprovedCapabilitySummary(output) {
  const content = output.join("\n").replace(/\r\n/g, "\n");
  assert.equal(content.split(approvedCapabilitySummary).length - 1, 1);
  assert.equal(content.split(agentSummaryRequirement).length - 1, 1);
  assert.equal(content.trim(), `${approvedCapabilitySummary}\n${agentSummaryRequirement}`);
  assert.doesNotMatch(content, /reload|restart|重新加载|重启/i);
  const actualBullets = content
    .slice(content.indexOf("下一步可以直接说："), content.indexOf("也可以直接告诉我你想部署什么应用。"))
    .split("\n")
    .filter((line) => line.startsWith("- "));
  const expectedBullets = approvedCapabilitySummary.split("\n").filter((line) => line.startsWith("- "));
  assert.deepEqual(actualBullets, expectedBullets);
  for (const forbidden of forbiddenDefaultInstallText) {
    assert.equal(content.includes(forbidden), false, `default install output contains ${forbidden}`);
  }
}

function assertHermesCapabilitySummary(output) {
  const content = output.join("\n").replace(/\r\n/g, "\n");
  assert.equal(content.split(hermesCapabilitySummary).length - 1, 1);
  assert.equal(content.split(agentSummaryRequirement).length - 1, 1);
  assert.equal(content.trim(), `${hermesCapabilitySummary}\n${agentSummaryRequirement}`);
}

test("native Windows verbose mode keeps technical installation diagnostics opt-in", async () => {
  const { main } = require(windowsOnboardingPath);
  const home = temporaryHome();
  const packageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rainskills-package-verbose-"));
  const output = [];
  writeSkill(packageRoot, "rainbond-test");

  await main(["codex", "--force", "--verbose"], {
    home,
    packageRoot,
    logger(message) {
      output.push(message);
    },
  });

  assert.equal(output.some((line) => line.startsWith("[install]")), true);
  assert.equal(output.some((line) => line.includes("项新装")), true);
  assert.equal(output.at(-2), approvedCapabilitySummary);
  assert.equal(output.at(-1), agentSummaryRequirement);
});

test("native main ends every default target with the approved Skills-only completion", async (t) => {
  const { main } = require(windowsOnboardingPath);

  for (const target of ["codex", "claude", "pi", "dsh", "workbuddy", "hermes", "all"]) {
    await t.test(target, async () => {
      const home = temporaryHome();
      const packageRoot = fs.mkdtempSync(path.join(os.tmpdir(), `rainskills-package-${target}-`));
      const output = [];
      writeSkill(packageRoot, "rainbond-test");

      const result = await main([target, "--force"], {
        home,
        packageRoot,
        logger(message) {
          output.push(message);
        },
      });

      assert.equal(result.status, "skills-installed");
      if (target === "hermes") assertHermesCapabilitySummary(output);
      else assertApprovedCapabilitySummary(output);
    });
  }
});

test("native Windows detects Hermes from its agent environment", async () => {
  const { main } = require(windowsOnboardingPath);
  const home = temporaryHome();
  const packageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rainskills-package-hermes-auto-"));
  const output = [];
  writeSkill(packageRoot, "rainbond-test");

  const result = await main(["--force"], {
    env: { AI_AGENT: "hermes-agent", RAINSKILLS_TELEMETRY_DISABLED: "1" },
    home,
    packageRoot,
    logger(message) {
      output.push(message);
    },
  });

  assert.equal(result.status, "skills-installed");
  assert.equal(fs.existsSync(path.join(home, ".hermes", "skills", "rainbond-test", "SKILL.md")), true);
  assert.equal(fs.existsSync(path.join(home, ".codex", "skills")), false);
  assertHermesCapabilitySummary(output);
});

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

function writeMarketplaceRootSkill(root, body = "root\n") {
  const directory = path.join(root, "marketplace", "rainskills", "skills", "rainskills");
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(directory, "SKILL.md"),
    `---\nname: rainskills\ndescription: Manage Rainskills environments\n---\n\n${body}`
  );
  return directory;
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
        readableSids: ["S-1-5-18", "S-1-5-32-544", "S-1-5-21-current"],
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
    readableSids: ["S-1-5-21-current"],
  });
  assert.throws(() => store.readProtectedJson(filePath), /Everyone|Users/i);
  facts.set(filePath, {
    reparsePoint: false,
    ownerSid: "S-1-5-21-current",
    writableSids: ["S-1-5-21-current"],
    readableSids: ["S-1-5-21-current", "S-1-1-0"],
  });
  assert.throws(() => store.readProtectedJson(filePath), /读取|read|Everyone|Users/i);
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
    (error) => {
      assert.match(error.message, /正在运行|resume/i);
      assert.equal(error.code, "RAINSKILLS_OPERATION_LOCK_BUSY");
      return true;
    }
  );

  live.delete(101);
  const second = createStore(202).acquireOperationLock({ operationId });
  first.release();
  assert.equal(fs.existsSync(second.path), true);
  second.release();
  assert.equal(fs.existsSync(second.path), false);
});

test("operation lock publication never leaves a final lock when owner persistence crashes", () => {
  const home = temporaryHome();
  const operationId = "1d6754d6-6fb3-4bda-9a04-15c2d261d178";
  const store = createPortableSecureStateStore(home, {
    pid: 101,
    processIdentity: "process-101",
    isProcessAlive: () => false,
  });
  const originalWriteFileSync = fs.writeFileSync;
  let injected = false;
  fs.writeFileSync = function writeFileSyncWithCrash(target, ...args) {
    if (!injected && typeof target === "number") {
      injected = true;
      throw new Error("simulated owner persistence crash");
    }
    return originalWriteFileSync.call(this, target, ...args);
  };
  try {
    assert.throws(() => store.acquireOperationLock({ operationId }), /simulated/i);
  } finally {
    fs.writeFileSync = originalWriteFileSync;
  }

  const finalLock = path.join(home, ".rainbond", "rainskills-locks", `${operationId}.lock`);
  assert.equal(fs.existsSync(finalLock), false);
  const recovered = store.acquireOperationLock({ operationId });
  recovered.release();
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
    "--no-telemetry",
  ]);

  assert.equal(options.target, "all");
  assert.equal(options.force, true);
  assert.equal(options.skipMcp, true);
  assert.equal(options.nonInteractive, true);
  assert.equal(options.deploymentMode, "self-hosted");
  assert.equal(options.rainbondUrl, "https://rainbond.example.com");
  assert.equal(options.noBrowser, true);
  assert.equal(options.noTelemetry, true);
  assert.deepEqual(destinationsForTarget("all", home, {}), [
    path.join(home, ".claude", "skills"),
    path.join(home, ".codex", "skills"),
    path.join(home, ".pi", "agent", "skills"),
    path.join(home, ".dsh", "skills"),
    path.join(home, ".workbuddy-ai", "skills"),
    path.join(home, ".hermes", "skills"),
  ]);
  assert.deepEqual(destinationsForTarget("pi", home, {}), [
    path.join(home, ".pi", "agent", "skills"),
  ]);
  assert.deepEqual(destinationsForTarget("dsh", home, {}), [
    path.join(home, ".dsh", "skills"),
  ]);
  assert.deepEqual(destinationsForTarget("workbuddy", home, {}), [
    path.join(home, ".workbuddy-ai", "skills"),
  ]);
  assert.deepEqual(destinationsForTarget("hermes", home, {}), [
    path.join(home, ".hermes", "skills"),
  ]);
  assert.throws(() => parseWindowsInstallerArgs(["--unknown"]), /未知参数/);
  assert.throws(() => parseWindowsInstallerArgs(["--dest"]), /--dest/);
});

test("native Windows non-interactive installation requires an explicit target", async () => {
  const { main } = require(windowsOnboardingPath);
  const home = temporaryHome();
  const packageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rainskills-package-target-required-"));
  writeSkill(packageRoot, "rainbond-test");

  await assert.rejects(() => main(["--non-interactive", "--force"], {
    env: {},
    home,
    packageRoot,
    installLocalCli: async () => ({ status: "installed" }),
    logger() {},
  }), /必须明确指定/);
  assert.equal(fs.existsSync(path.join(home, ".codex", "skills")), false);
  assert.equal(fs.existsSync(path.join(home, ".hermes", "skills")), false);
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

test("Windows discovery includes the existing root environment-management Skill", () => {
  const { discoverSkills } = require(windowsOnboardingPath);
  const packageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rainskills-package-root-"));
  const businessSkill = writeSkill(packageRoot, "rainbond-test");
  const rootSkill = writeMarketplaceRootSkill(packageRoot);

  assert.deepEqual(discoverSkills(packageRoot), [businessSkill, rootSkill]);
});

test("native main honors a custom Skills destination without runtime setup", async () => {
  const { main } = require(windowsOnboardingPath);
  const home = temporaryHome();
  const packageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rainskills-package-dest-"));
  const customDestination = path.join(home, "custom-skills");
  const output = [];
  let authorizationCalls = 0;
  writeSkill(packageRoot, "rainbond-test");

  const result = await main([
    "--dest",
    customDestination,
    "--force",
    "--saas",
  ], {
    authorizeAndConfigure() {
      authorizationCalls += 1;
      throw new Error("authorization should not start");
    },
    home,
    packageRoot,
    logger(message) {
      output.push(message);
    },
  });

  assert.equal(result.status, "skills-installed");
  assert.equal(result.counts.installed, 1);
  assert.equal(authorizationCalls, 0);
  assert.equal(fs.existsSync(path.join(customDestination, "rainbond-test", "SKILL.md")), true);
  assert.equal(fs.existsSync(path.join(home, ".codex", "skills")), false);
  assert.equal(fs.existsSync(path.join(home, ".claude", "skills")), false);
  assert.equal(output.some((line) => line.includes("请重启")), false);
  assertApprovedCapabilitySummary(output);
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
  });

  assert.equal(checkpoint.state.control_mode, "windows-native");
  assert.equal(checkpoint.state.control_distro, null);
  assert.equal(Object.hasOwn(checkpoint.state, "intent"), false);
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
  assert.deepEqual(createNextAction(operationId, "local"), {
    schema: "rainskills.next-action.v1",
    action: "install-platform",
    onboarding_id: operationId,
    argv: ["platform", "install", "--onboarding-id", operationId, "--location", "local"],
  });
  assert.deepEqual(createNextAction(operationId, "server"), {
    schema: "rainskills.next-action.v1",
    action: "install-platform",
    onboarding_id: operationId,
    argv: ["platform", "install", "--onboarding-id", operationId, "--location", "server"],
  });
  assert.throws(() => createNextAction(operationId, "cluster"), /location|位置/i);

});

test("native main installs only Skills without selecting or configuring a runtime", async () => {
  const { main } = require(windowsOnboardingPath);
  const home = temporaryHome();
  const packageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rainskills-package-main-"));
  const destination = path.join(home, ".codex", "skills");
  const output = [];
  writeSkill(packageRoot, "rainbond-test");
  fs.writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({ version: "0.1.0-test" }));
  let deploymentPrompts = 0;
  let authorizationCalls = 0;

  const result = await main([
    "codex",
    "--self-hosted",
    "--rainbond-url",
    "https://rainbond.example.com",
  ], {
    authorizeAndConfigure() {
      authorizationCalls += 1;
      return { status: "configured" };
    },
    control: {
      mode: "windows-native",
      hostPlatform: "win32",
      controlPlatform: "win32",
    },
    home,
    packageRoot,
    promptDeployment() {
      deploymentPrompts += 1;
      throw new Error("deployment prompt must not run");
    },
    logger(message) {
      output.push(message);
    },
  });

  assert.equal(result.status, "skills-installed");
  assert.equal(deploymentPrompts, 0);
  assert.equal(authorizationCalls, 0);
  assert.equal(result.counts.installed, 1);
  assert.equal(fs.existsSync(path.join(destination, "rainbond-test", "SKILL.md")), true);
  assert.equal(fs.existsSync(path.join(home, ".rainbond")), false);
  assert.equal(fs.existsSync(path.join(home, ".codex", "config.toml")), false);
  assert.equal(fs.existsSync(path.join(home, ".claude.json")), false);
  assertApprovedCapabilitySummary(output);
});

test("native Windows installation publishes the protected local CLI bundle", async () => {
  const { installLocalCli } = require(windowsOnboardingPath);
  const home = temporaryHome();

  await installLocalCli({ packageRoot: repoRoot, home });

  assert.equal(fs.existsSync(path.join(home, ".rainbond", "bin", "rainskills-tools.js")), true);
  assert.equal(fs.existsSync(path.join(home, ".rainbond", "bin", "rainskills-skill-manifest.json")), true);
  assert.equal(fs.existsSync(path.join(home, ".rainbond", "lib", "rainbond-platform-installer", "scripts", "single-runtime.js")), true);
  assert.equal(fs.existsSync(path.join(home, ".codex", "config.toml")), false);
  assert.equal(fs.existsSync(path.join(home, ".claude.json")), false);
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
    (error) => error.code === "DEVICE_AUTHORIZATION_CANCELLED"
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
    (error) => error.code === "DEVICE_AUTHORIZATION_EXPIRED"
  );

  const deniedResponses = [
    new Response(JSON.stringify({
      device_code: "private-device-code",
      user_code: "BCDF-GHJK",
      expires_in: 600,
      interval: 1,
    }), { status: 200 }),
    new Response(JSON.stringify({ error: "access_denied" }), { status: 400 }),
  ];
  await assert.rejects(
    authorizeWithDeviceFlow({
      baseUrl: "https://rainbond.example.com",
      fetchImpl: async () => deniedResponses.shift(),
      openBrowser() {},
      sleep: async () => {},
      now: () => 0,
    }),
    (error) => error.code === "DEVICE_AUTHORIZATION_DENIED"
  );
});

test("native authorization telemetry preserves concrete Device Flow failure codes", async () => {
  const { authorizeAndConfigure } = require(windowsOnboardingPath);
  const cases = [
    ["DEVICE_AUTHORIZATION_DENIED", "device_authorization_denied"],
    ["DEVICE_AUTHORIZATION_EXPIRED", "device_authorization_expired"],
    ["DEVICE_AUTHORIZATION_CANCELLED", "user_cancelled"],
  ];

  for (const [code, expected] of cases) {
    const events = [];
    await assert.rejects(() => authorizeAndConfigure({
      target: "dsh",
      baseUrl: "https://rainbond.example.com",
      authorizeWithDeviceFlowImpl: async () => {
        const error = new Error(code);
        error.code = code;
        throw error;
      },
      telemetryFactory: () => ({ record(event) { events.push(event); } }),
    }));
    const failure = events.find((event) => event.lifecycle_status === "failed");
    assert.equal(failure.error_code, expected);
    assert.equal(failure.reason_code, expected);
  }
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

test("Windows CLI validation keeps JWT in the authorization header", async () => {
  const { validateMcp } = require(path.join(
    repoRoot,
    "rainbond-platform-installer",
    "scripts",
    "windows-client-config.js"
  ));
  const token = "header.payload.signature";
  let request = null;
  const validation = await validateMcp({
    url: "https://rainbond.example.com/console/mcp/rainskills/api/query",
    token,
    async fetchImpl(url, options) {
      request = { url, options };
      return new Response(JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: { serverInfo: { name: "rainbond-console-mcp" } },
      }), {
        status: 200,
        headers: { "x-renewed-token": "renewed.payload.signature" },
      });
    },
  });
  assert.equal(request.options.headers.Authorization, `GRJWT ${token}`);
  assert.equal(request.options.signal instanceof AbortSignal, true);
  assert.equal(JSON.parse(request.options.body).method, "initialize");
  assert.equal(validation.token, "renewed.payload.signature");
});

test("Windows MCP validation pins the selected endpoint and rejects redirect drift", async () => {
  const { validateMcp } = require(path.join(
    repoRoot,
    "rainbond-platform-installer",
    "scripts",
    "windows-client-config.js"
  ));
  const endpoint = "https://rainbond.example.com/console/mcp/rainskills/codex/query";
  let redirectMode = "";
  await assert.rejects(() => validateMcp({
    url: endpoint,
    token: "header.payload.signature",
    async fetchImpl(_url, options) {
      redirectMode = options.redirect;
      return {
        ok: true,
        status: 200,
        url: "https://attacker.example/console/mcp/rainskills/codex/query",
        headers: new Headers(),
        async json() {
          return { jsonrpc: "2.0", id: 1, result: { serverInfo: { name: "rainbond-console-mcp" } } };
        },
      };
    },
  }), /地址|endpoint|重定向/i);
  assert.equal(redirectMode, "manual");
});

test("MCP validation aborts a stalled live probe after the bounded timeout", async () => {
  const { validateMcp } = require(path.join(
    repoRoot,
    "rainbond-platform-installer",
    "scripts",
    "windows-client-config.js"
  ));

  await assert.rejects(() => validateMcp({
    url: "https://console.example.com/console/mcp/rainskills/api/query",
    token: "header.payload.signature",
    timeoutMs: 5,
    fetchImpl(_url, options) {
      return new Promise((resolve, reject) => {
        options.signal.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        }, { once: true });
      });
    },
  }), /MCP.*超时|超时.*MCP/i);

  await assert.rejects(() => validateMcp({
    url: "https://console.example.com/console/mcp/rainskills/api/query",
    token: "header.payload.signature",
    timeoutMs: 0,
    fetchImpl() {
      throw new Error("invalid timeout must fail before fetch");
    },
  }), /超时参数无效/);
});

test("native authorization orchestration falls back from Device Flow and validates the CLI API", async () => {
  const { authorizeAndConfigure } = require(windowsOnboardingPath);
  const { createLifecycleTelemetry } = require(path.join(repoRoot, "rainbond-platform-installer", "scripts", "telemetry.js"));
  const telemetryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "rainskills-windows-telemetry-"));
  const calls = [];
  let configuredCredential = "";
  const result = await authorizeAndConfigure({
    target: "codex",
    baseUrl: "https://rainbond.example.com",
    authorizeWithDeviceFlowImpl: async () => {
      const error = new Error("unsupported");
      error.code = "DEVICE_FLOW_UNSUPPORTED";
      throw error;
    },
    authorizeWithLoopbackImpl: async () => "header.payload.signature",
    validateMcpImpl: async ({ url, token }) => {
      calls.push({ kind: "validate", url, token });
      return { token: "renewed.payload.signature" };
    },
    onConfiguredCredential(value) {
      configuredCredential = value;
    },
    openBrowser() {},
    telemetryFactory(context) {
      return createLifecycleTelemetry({
        ...context,
        enabled: true,
        directory: telemetryDirectory,
        fetchImpl: async () => ({ ok: true, status: 200 }),
      });
    },
  });

  assert.deepEqual(result, { status: "configured" });
  assert.equal(configuredCredential, "renewed.payload.signature");
  assert.equal(calls[0].url, "https://rainbond.example.com/console/mcp/rainskills/api/query");
  assert.equal(calls.length, 1);
  const events = fs.readFileSync(path.join(telemetryDirectory, "events.jsonl"), "utf8")
    .trim().split("\n").map((line) => JSON.parse(line));
  assert.ok(events.some((event) => event.lifecycle_phase === "authorize_legacy" && event.lifecycle_status === "completed"));
  assert.ok(events.some((event) => event.lifecycle_phase === "configure_cli" && event.lifecycle_status === "completed"));
  assert.equal(new Set(events.map((event) => event.install_attempt_id)).size, 1);
  assert.doesNotMatch(fs.readFileSync(path.join(telemetryDirectory, "events.jsonl"), "utf8"), /header\.payload\.signature/);
});

test("native authorization asks for a Rainbond upgrade when the CLI endpoint is missing", async () => {
  const { authorizeAndConfigure } = require(windowsOnboardingPath);
  const urls = [];
  await assert.rejects(authorizeAndConfigure({
    target: "codex",
    baseUrl: "https://rainbond.example.com",
    authorizeWithDeviceFlowImpl: async () => "header.payload.signature",
    validateMcpImpl: async ({ url, token }) => {
      urls.push(url);
      const error = new Error("当前 Rainbond 版本不支持 Rainskills CLI，请先将 Rainbond 升级到 v6.9.9 或更高版本。");
      error.code = "MCP_ENDPOINT_UNSUPPORTED";
      throw error;
    },
    onConfiguredCredential() {},
    telemetryFactory: () => ({ record() {} }),
  }), /v6\.9\.9.*更高版本/);
  assert.deepEqual(urls, ["https://rainbond.example.com/console/mcp/rainskills/api/query"]);
});

test("native authorization does not downgrade MCP endpoints after a server error", async () => {
  const { authorizeAndConfigure } = require(windowsOnboardingPath);
  const urls = [];
  await assert.rejects(() => authorizeAndConfigure({
    target: "codex",
    baseUrl: "https://rainbond.example.com",
    authorizeWithDeviceFlowImpl: async () => "header.payload.signature",
    validateMcpImpl: async ({ url }) => {
      urls.push(url);
      throw new Error("Rainbond MCP 校验失败，HTTP 500");
    },
    telemetryFactory: () => ({ record() {} }),
  }), /HTTP 500/);
  assert.deepEqual(urls, ["https://rainbond.example.com/console/mcp/rainskills/api/query"]);
});

test("native main does not authorize or configure an explicitly supplied SaaS runtime", async () => {
  const { main } = require(windowsOnboardingPath);
  const home = temporaryHome();
  const packageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rainskills-package-saas-"));
  writeSkill(packageRoot, "rainbond-test");
  fs.writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({ version: "0.1.0-test" }));
  const calls = [];
  const output = [];

  const result = await main(["codex", "--saas"], {
    authorizeAndConfigure(options) {
      calls.push(options);
      return { status: "configured" };
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

  assert.equal(result.status, "skills-installed");
  assert.equal(calls.length, 0);
  assert.equal(fs.existsSync(path.join(home, ".rainbond")), false);
  assertApprovedCapabilitySummary(output);
});

test("native Windows installation reports one install result and each configured agent", async () => {
  const { main } = require(windowsOnboardingPath);
  const home = temporaryHome();
  const packageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rainskills-package-v2-telemetry-"));
  writeSkill(packageRoot, "rainbond-test");
  fs.writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({ version: "1.0.0" }));
  const records = [];
  const contexts = [];

  const result = await main(["all", "--force"], {
    env: { RAINSKILLS_TELEMETRY_DISABLED: "0" },
    home,
    packageRoot,
    installLocalCli: async () => ({ status: "installed" }),
    logger() {},
    resultTelemetryFactory(context) {
      contexts.push(context);
      return {
        record(event) {
          records.push(event);
          return { recorded: true, delivery: Promise.resolve(true) };
        },
      };
    },
  });

  assert.equal(result.status, "skills-installed");
  assert.equal(contexts.length, 1);
  assert.equal(contexts[0].packageVersion, "1.0.0");
  assert.deepEqual(records.filter((event) => event.event_type === "agent_config_result")
    .map((event) => event.agent_type).sort(), [
    "claude_code", "codex", "deepseek", "hermes_agent", "pi", "workbuddy",
  ]);
  assert.deepEqual(records.find((event) => event.event_type === "install_result"), {
    event_type: "install_result",
    install_attempt_id: contexts[0].installAttemptId,
    action: "install",
    os_type: "windows",
    os_arch: contexts[0].osArch,
    execution_environment: "native",
    status: "success",
  });
});

test("native Windows no-telemetry installation creates no telemetry state", async () => {
  const { main } = require(windowsOnboardingPath);
  const home = temporaryHome();
  const packageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rainskills-package-no-telemetry-"));
  writeSkill(packageRoot, "rainbond-test");
  fs.writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({ version: "1.0.0" }));

  const result = await main(["codex", "--force", "--no-telemetry"], {
    env: { RAINSKILLS_TELEMETRY_DISABLED: "0" },
    home,
    packageRoot,
    installLocalCli: async () => ({ status: "installed" }),
    logger() {},
  });

  assert.equal(result.status, "skills-installed");
  assert.equal(fs.existsSync(path.join(home, ".rainbond", "rainskills", "telemetry")), false);
});

test("native Windows installation remains fail-open when telemetry initialization fails", async () => {
  const { main } = require(windowsOnboardingPath);
  const home = temporaryHome();
  const packageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rainskills-package-v2-fail-open-"));
  writeSkill(packageRoot, "rainbond-test");
  fs.writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({ version: "1.0.0" }));

  const result = await main(["codex", "--force"], {
    env: { RAINSKILLS_TELEMETRY_DISABLED: "0" },
    home,
    packageRoot,
    installLocalCli: async () => ({ status: "installed" }),
    logger() {},
    resultTelemetryFactory() {
      throw new Error("telemetry storage unavailable");
    },
  });

  assert.equal(result.status, "skills-installed");
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

test("native Windows onboarding accepts local HTTP Console URLs without an opt-in flag", async () => {
  const { isLocalHttpUrl, main } = require(windowsOnboardingPath);
  assert.equal(isLocalHttpUrl("http://127.0.0.1:7070"), true);
  assert.equal(isLocalHttpUrl("http://172.31.255.2:7070"), true);
  assert.equal(isLocalHttpUrl("http://rainbond.example.com:7070"), false);
  assert.equal(isLocalHttpUrl("https://127.0.0.1:7070"), false);
  const home = temporaryHome();
  const packageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rainskills-package-local-http-"));
  writeSkill(packageRoot, "rainbond-test");
  fs.writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({ version: "0.1.0-test" }));
  const calls = [];

  const result = await main(["codex", "--rainbond-url", "http://127.0.0.1:7070"], {
    home,
    packageRoot,
    authorizeAndConfigure(options) {
      calls.push(options);
      return { status: "configured" };
    },
    logger() {},
  });

  assert.equal(result.status, "skills-installed");
  assert.equal(calls.length, 0);
  assert.equal(fs.existsSync(path.join(home, ".rainbond")), false);
});

test("native Windows onboarding defers public HTTP validation until explicit connection", async () => {
  const { main } = require(windowsOnboardingPath);
  const home = temporaryHome();
  const packageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rainskills-package-public-http-"));
  writeSkill(packageRoot, "rainbond-test");
  fs.writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({ version: "0.1.0-test" }));

  let authorizationCalls = 0;
  const result = await main(["codex", "--rainbond-url", "http://rainbond.example.com:7070"], {
    home,
    packageRoot,
    authorizeAndConfigure() {
      authorizationCalls += 1;
      throw new Error("authorization should not start");
    },
    logger() {},
  });

  assert.equal(result.status, "skills-installed");
  assert.equal(authorizationCalls, 0);
  assert.equal(fs.existsSync(path.join(home, ".rainbond")), false);
});
