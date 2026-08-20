"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const repoRoot = path.resolve(__dirname, "..");
const autoUpdatePath = path.join(
  repoRoot,
  "rainbond-platform-installer",
  "scripts",
  "auto-update.js"
);

function temporaryHome() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rainskills-auto-update-")));
}

function writeSkill(root, name, body) {
  const directory = path.join(root, name);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(directory, "SKILL.md"),
    `---\nname: ${name}\ndescription: Test skill\n---\n\n${body}\n`,
    "utf8"
  );
  return directory;
}

test("prerelease builds never check npm and unsafe commands stay pinned", async () => {
  const { checkForStableUpdate } = require(autoUpdatePath);
  let fetches = 0;
  const fetchLatest = async () => {
    fetches += 1;
    return { version: "1.2.4" };
  };

  assert.deepEqual(await checkForStableUpdate({
    args: ["runtime", "status", "--json"],
    currentVersion: "1.2.3-rc.1",
    fetchLatest,
  }), { action: "continue", reason: "current-prerelease" });
  assert.deepEqual(await checkForStableUpdate({
    args: ["resume", "--onboarding-id", "11111111-1111-4111-8111-111111111111"],
    currentVersion: "1.2.3",
    fetchLatest,
  }), { action: "continue", reason: "unsafe-entry" });
  assert.deepEqual(await checkForStableUpdate({
    args: ["platform", "install", "--onboarding-id", "11111111-1111-4111-8111-111111111111"],
    currentVersion: "1.2.3",
    fetchLatest,
  }), { action: "continue", reason: "unsafe-entry" });
  assert.equal(fetches, 0);
});

test("stable builds select only a newer stable npm latest version", async () => {
  const { checkForStableUpdate } = require(autoUpdatePath);
  const base = {
    args: ["runtime", "status", "--json"],
    currentVersion: "1.2.3",
    activeOperationDetector: () => false,
    updateState: {
      read: () => ({ checked_at: null }),
      recordCheck: () => {},
    },
  };

  assert.deepEqual(await checkForStableUpdate({
    ...base,
    fetchLatest: async () => ({ version: "1.2.4" }),
  }), { action: "delegate", version: "1.2.4" });
  assert.deepEqual(await checkForStableUpdate({
    ...base,
    fetchLatest: async () => ({ version: "1.3.0-rc.1" }),
  }), { action: "continue", reason: "invalid-latest" });
  assert.deepEqual(await checkForStableUpdate({
    ...base,
    fetchLatest: async () => ({ version: "1.2.3" }),
  }), { action: "continue", reason: "up-to-date" });
});

test("active operations, a one-hop delegate, and a fresh TTL skip update checks", async () => {
  const { checkForStableUpdate } = require(autoUpdatePath);
  let fetches = 0;
  const fetchLatest = async () => {
    fetches += 1;
    return { version: "9.0.0" };
  };
  const common = {
    args: ["runtime", "status", "--json"],
    currentVersion: "1.2.3",
    fetchLatest,
  };

  assert.deepEqual(await checkForStableUpdate({
    ...common,
    env: { RAINSKILLS_AUTO_UPDATE_HOP: "1" },
  }), { action: "continue", reason: "delegated-hop" });
  assert.deepEqual(await checkForStableUpdate({
    ...common,
    activeOperationDetector: () => true,
  }), { action: "continue", reason: "active-operation" });
  assert.deepEqual(await checkForStableUpdate({
    ...common,
    activeOperationDetector: () => false,
    now: () => Date.parse("2026-08-17T12:00:00.000Z"),
    updateState: {
      read: () => ({ checked_at: "2026-08-17T11:30:00.000Z" }),
      recordCheck: () => {},
    },
  }), { action: "continue", reason: "fresh-check" });
  assert.equal(fetches, 0);
});

test("official npm metadata is pinned to the rainskills registry artifact", () => {
  const { validateOfficialLatestMetadata } = require(autoUpdatePath);
  assert.deepEqual(validateOfficialLatestMetadata({
    name: "rainskills",
    version: "2.1.0",
    dist: {
      integrity: `sha512-${Buffer.alloc(64, 1).toString("base64")}`,
      tarball: "https://registry.npmjs.org/rainskills/-/rainskills-2.1.0.tgz",
    },
  }), { version: "2.1.0" });
  assert.throws(() => validateOfficialLatestMetadata({
    name: "rainskills",
    version: "2.1.0",
    dist: {
      integrity: "sha512-YWJjZA==",
      tarball: "https://registry.npmjs.org/rainskills/-/rainskills-2.1.0.tgz",
    },
  }), /完整性|integrity/i);
  assert.throws(() => validateOfficialLatestMetadata({
    name: "rainskills",
    version: "2.1.0-rc.1",
    dist: {
      integrity: "sha512-YWJjZA==",
      tarball: "https://registry.npmjs.org/rainskills/-/rainskills-2.1.0-rc.1.tgz",
    },
  }), /stable|正式版/i);
  assert.throws(() => validateOfficialLatestMetadata({
    name: "rainskills",
    version: "2.1.0",
    dist: {
      integrity: "sha512-YWJjZA==",
      tarball: "https://example.com/rainskills-2.1.0.tgz",
    },
  }), /registry|来源/i);
});

test("the delegated command uses an exact stable package with scripts disabled", () => {
  const { buildStableUpdateInvocation, buildStableUpdateEnvironment } = require(autoUpdatePath);
  assert.deepEqual(buildStableUpdateInvocation("1.4.0", ["runtime", "status", "--json"], {
    platform: "linux",
  }), {
    executable: "npx",
    args: ["--yes", "--ignore-scripts", "rainskills@1.4.0", "runtime", "status", "--json"],
  });
  assert.deepEqual(buildStableUpdateInvocation("1.4.0", ["runtime", "status", "--json"], {
    platform: "win32",
  }).executable, "npx.cmd");
  const environment = buildStableUpdateEnvironment({
    PATH: "/bin",
    RAINBOND_JWT: "header.payload.signature",
    npm_config_registry: "https://untrusted.invalid",
  }, { fromVersion: "1.3.0", targetVersion: "1.4.0" });
  assert.equal(environment.RAINSKILLS_AUTO_UPDATE_HOP, "1");
  assert.equal(environment.RAINSKILLS_AUTO_UPDATE_FROM, "1.3.0");
  assert.equal(environment.RAINSKILLS_AUTO_UPDATE_TARGET, "1.4.0");
  assert.equal(environment.npm_config_registry, "https://registry.npmjs.org/");
  assert.equal(environment.npm_config_ignore_scripts, "true");
  assert.equal(environment.RAINBOND_JWT, "header.payload.signature");
});

test("protected update state and custom install destinations survive across runs", () => {
  const {
    createAutoUpdateState,
    recordSkillInstallDestinations,
    resolveInstallDestinations,
  } = require(autoUpdatePath);
  const home = temporaryHome();
  const custom = path.join(home, "custom-agent", "skills");
  const state = createAutoUpdateState({ home, platform: "linux" });

  assert.deepEqual(resolveInstallDestinations(["codex", "--force"], home), [
    path.join(home, ".codex", "skills"),
  ]);
  assert.deepEqual(resolveInstallDestinations(["--dest", custom, "--force"], home), [custom]);
  assert.deepEqual(resolveInstallDestinations(["--help"], home), []);
  assert.deepEqual(resolveInstallDestinations(["refresh"], home), []);
  recordSkillInstallDestinations(["--dest", custom, "--force"], { home, platform: "linux", updateState: state });
  assert.deepEqual(state.readInstallations(), { destinations: [custom] });
  assert.equal(fs.lstatSync(path.join(home, ".rainbond", "rainskills")).mode & 0o777, 0o700);
  assert.equal(fs.lstatSync(path.join(home, ".rainbond", "rainskills", "auto-update-v1.json")).mode & 0o777, 0o600);
});

test("skill synchronization updates known agent roots without touching Rainbond state", () => {
  const { synchronizeInstalledSkills } = require(autoUpdatePath);
  const home = temporaryHome();
  const packageRoot = path.join(home, "package");
  const codexRoot = path.join(home, ".codex", "skills");
  const agentsRoot = path.join(home, ".agents", "skills");
  const rainbondRoot = path.join(home, ".rainbond");
  fs.mkdirSync(packageRoot);
  fs.mkdirSync(codexRoot, { recursive: true });
  fs.mkdirSync(agentsRoot, { recursive: true });
  fs.mkdirSync(rainbondRoot, { recursive: true });
  writeSkill(packageRoot, "rainbond-one", "new one");
  writeSkill(packageRoot, "rainbond-two", "new two");
  writeSkill(codexRoot, "rainbond-one", "old one");
  writeSkill(agentsRoot, "rainbond-two", "old two");
  writeSkill(codexRoot, "unrelated-skill", "keep me");
  fs.writeFileSync(path.join(rainbondRoot, "mcp.env"), "credential sentinel\n", { mode: 0o600 });
  fs.mkdirSync(path.join(rainbondRoot, "rainskills"));
  fs.writeFileSync(
    path.join(rainbondRoot, "rainskills", "runtime-connection-v1.json"),
    "runtime sentinel\n",
    { mode: 0o600 }
  );

  const result = synchronizeInstalledSkills({ packageRoot, home, platform: "linux" });

  assert.equal(result.destinations, 2);
  assert.match(fs.readFileSync(path.join(codexRoot, "rainbond-one", "SKILL.md"), "utf8"), /new one/);
  assert.match(fs.readFileSync(path.join(codexRoot, "rainbond-two", "SKILL.md"), "utf8"), /new two/);
  assert.match(fs.readFileSync(path.join(agentsRoot, "rainbond-one", "SKILL.md"), "utf8"), /new one/);
  assert.match(fs.readFileSync(path.join(codexRoot, "unrelated-skill", "SKILL.md"), "utf8"), /keep me/);
  assert.equal(fs.readFileSync(path.join(rainbondRoot, "mcp.env"), "utf8"), "credential sentinel\n");
  assert.equal(
    fs.readFileSync(path.join(rainbondRoot, "rainskills", "runtime-connection-v1.json"), "utf8"),
    "runtime sentinel\n"
  );
});

test("an unsafe skill destination aborts before any installed skill changes", () => {
  const { synchronizeInstalledSkills } = require(autoUpdatePath);
  const home = temporaryHome();
  const packageRoot = path.join(home, "package");
  const codexRoot = path.join(home, ".codex", "skills");
  const unsafeRoot = path.join(home, ".agents", "skills");
  fs.mkdirSync(packageRoot);
  fs.mkdirSync(codexRoot, { recursive: true });
  fs.mkdirSync(path.dirname(unsafeRoot), { recursive: true });
  writeSkill(packageRoot, "rainbond-one", "new one");
  writeSkill(codexRoot, "rainbond-one", "old one");
  fs.symlinkSync(codexRoot, unsafeRoot, "dir");

  assert.throws(() => synchronizeInstalledSkills({
    packageRoot,
    home,
    platform: "linux",
    destinations: [codexRoot, unsafeRoot],
  }), /symbolic|符号链接|reparse/i);
  assert.match(fs.readFileSync(path.join(codexRoot, "rainbond-one", "SKILL.md"), "utf8"), /old one/);
});

test("the public update contract is stable-only and never re-runs Rainbond onboarding", () => {
  const readme = fs.readFileSync(path.join(repoRoot, "README.md"), "utf8");
  assert.match(readme, /只(?:跟随|检查|自动升级到).{0,20}正式版/s);
  assert.match(readme, /RC.{0,20}(?:不会|不参与|不自动升级)/s);
  assert.match(readme, /升级.{0,40}(?:不会|不触发).{0,30}(?:Rainbond|运行环境).{0,30}(?:安装|授权|对接|连接)/s);
  assert.match(readme, /原(?:始)?(?:业务)?操作.{0,20}(?:继续|恢复)/s);
});
