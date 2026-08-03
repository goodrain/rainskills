const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

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

test("secure state preserves POSIX modes and blocks paths outside home", () => {
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
  facts.set(filePath, {
    reparsePoint: false,
    ownerSid: "S-1-5-21-current",
    writableSids: ["S-1-1-0"],
  });
  assert.throws(() => store.readProtectedJson(filePath), /Everyone|Users/i);
});

test("operation locks reject live owners and reclaim proven stale owners", () => {
  const { createSecureStateStore } = require(secureStatePath);
  const home = temporaryHome();
  const operationId = "1d6754d6-6fb3-4bda-9a04-15c2d261d178";
  const live = new Set([101]);
  const createStore = (pid) => createSecureStateStore({
    platform: "linux",
    home,
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
  assert.throws(() => parseWindowsInstallerArgs(["--unknown"]), /未知参数/);
  assert.throws(() => parseWindowsInstallerArgs(["--dest"]), /--dest/);
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
  const { createSecureStateStore } = require(secureStatePath);
  const {
    createOnboardingCheckpoint,
    createNextAction,
  } = require(windowsOnboardingPath);
  const { readOnboardingState } = require(platformInstallerPath);
  const home = temporaryHome();
  const stateStore = createSecureStateStore({ platform: "linux", home });
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

test("native main saves private onboarding and emits the fixed next action", async () => {
  const { createSecureStateStore } = require(secureStatePath);
  const { main } = require(windowsOnboardingPath);
  const home = temporaryHome();
  const packageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rainskills-package-main-"));
  const destination = path.join(home, ".codex", "skills");
  const output = [];
  writeSkill(packageRoot, "rainbond-test");
  fs.writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({ version: "0.1.0-test" }));
  const baseStateStore = createSecureStateStore({ platform: "linux", home });
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
  assert.deepEqual(JSON.parse(output.at(-1)), result.nextAction);
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
