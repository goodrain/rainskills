const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const repoRoot = path.resolve(__dirname, "..");
const syncScript = path.join(repoRoot, "scripts", "sync-runtime-version.mjs");

function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rainskills-version-sync-"));
  fs.mkdirSync(path.join(root, "rainbond-example"));
  fs.mkdirSync(path.join(root, "rainbond-platform-installer", "scripts"), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(root, "package.json"),
    `${JSON.stringify({
      name: "rainskills",
      version: "2.3.4-rc.1",
      files: ["SKILL.md", "README.md", "rainbond-example/"],
    }, null, 2)}\n`
  );
  fs.writeFileSync(
    path.join(root, "SKILL.md"),
    "fixed: rainskills@0.1.7\nfloating example: rainskills@latest\n"
  );
  fs.writeFileSync(
    path.join(root, "README.md"),
    "command: npx --yes rainskills@0.1.7 runtime status --json\nhistory: version 0.1.7\n"
  );
  fs.writeFileSync(
    path.join(root, "rainbond-example", "SKILL.md"),
    'launcher: ["npx", "--yes", "rainskills@0.1.7"]\n'
  );
  fs.writeFileSync(
    path.join(root, "rainbond-platform-installer", "scripts", "installed-version.js"),
    'module.exports = Object.freeze({ version: "0.1.7" });\n'
  );
  return root;
}

function runSync(root, ...args) {
  return spawnSync(process.execPath, [syncScript, "--source-root", root, ...args], {
    encoding: "utf8",
  });
}

test("check mode rejects stale canonical launcher versions without changing files", () => {
  const root = createFixture();
  const skillPath = path.join(root, "SKILL.md");
  const before = fs.readFileSync(skillPath, "utf8");

  const result = runSync(root, "--check");

  assert.equal(result.status, 1);
  assert.match(result.stderr, /SKILL\.md/);
  assert.match(result.stderr, /rainbond-example\/SKILL\.md/);
  assert.equal(fs.readFileSync(skillPath, "utf8"), before);
});

test("sync mode updates every canonical launcher and preserves floating and historical text", () => {
  const root = createFixture();

  const syncResult = runSync(root);
  assert.equal(syncResult.status, 0, syncResult.stderr || syncResult.stdout);

  for (const relativePath of [
    "SKILL.md",
    "README.md",
    "rainbond-example/SKILL.md",
    "rainbond-platform-installer/scripts/installed-version.js",
  ]) {
    const content = fs.readFileSync(path.join(root, relativePath), "utf8");
    if (relativePath.endsWith("installed-version.js")) {
      assert.match(content, /version: "2\.3\.4-rc\.1"/);
      assert.doesNotMatch(content, /version: "0\.1\.7"/);
    } else {
      assert.match(content, /rainskills@2\.3\.4-rc\.1/);
      assert.doesNotMatch(content, /rainskills@0\.1\.7/);
    }
  }
  assert.match(fs.readFileSync(path.join(root, "SKILL.md"), "utf8"), /rainskills@latest/);
  assert.match(fs.readFileSync(path.join(root, "README.md"), "utf8"), /history: version 0\.1\.7/);

  const checkResult = runSync(root, "--check");
  assert.equal(checkResult.status, 0, checkResult.stderr || checkResult.stdout);
});

test("the repository release documents match package.json", () => {
  const result = runSync(repoRoot, "--check");
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("the release workflow checks runtime versions before packaging artifacts", () => {
  const workflow = fs.readFileSync(
    path.join(repoRoot, ".github", "workflows", "release.yml"),
    "utf8"
  );
  const versionCheck = workflow.indexOf(
    "node scripts/sync-runtime-version.mjs --check"
  );
  const marketplaceCheck = workflow.indexOf(
    "node scripts/build-marketplace-package.mjs --check"
  );
  const packStep = workflow.indexOf("name: Pack release tarball");

  assert.notEqual(versionCheck, -1);
  assert.notEqual(marketplaceCheck, -1);
  assert.notEqual(packStep, -1);
  assert(versionCheck < marketplaceCheck);
  assert(marketplaceCheck < packStep);
});
