"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const repoRoot = path.resolve(__dirname, "..");
const builder = path.join(repoRoot, "scripts", "build-skill-manifest.mjs");

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function makeSourceRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rainskills-manifest-source-"));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({
    name: "rainskills",
    version: "9.8.7",
  }));
  for (const [skillId, content] of [
    ["rainbond-app-assistant", "---\nname: App assistant\n---\n# Root\n"],
    ["rainbond-opensource-app-deploy", "---\nname: Open source deploy\n---\n# Deploy\n"],
  ]) {
    const directory = path.join(root, skillId);
    fs.mkdirSync(path.join(directory, "references"), { recursive: true });
    fs.writeFileSync(path.join(directory, "SKILL.md"), content);
    fs.writeFileSync(path.join(directory, "references", "contract.md"), `${skillId}\n`);
  }
  return root;
}

function build(sourceRoot, output) {
  return spawnSync(process.execPath, [
    builder,
    "--source-root", sourceRoot,
    "--output", output,
    "--revision", "revision-1",
  ], { encoding: "utf8" });
}

test("builder records exact Skill content and deterministic protected bundle digests", () => {
  const sourceRoot = makeSourceRoot();
  const firstOutput = path.join(sourceRoot, "first.json");
  const secondOutput = path.join(sourceRoot, "second.json");
  const first = build(sourceRoot, firstOutput);
  const second = build(sourceRoot, secondOutput);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(second.status, 0, second.stderr);
  const manifest = JSON.parse(fs.readFileSync(firstOutput, "utf8"));
  assert.deepEqual(manifest, JSON.parse(fs.readFileSync(secondOutput, "utf8")));
  assert.equal(manifest.schema, "rainskills.skill-manifest.v1");
  assert.equal(manifest.profile, "cli");
  assert.deepEqual(manifest.skills.map(({ id }) => id), [
    "rainbond-app-assistant",
    "rainbond-opensource-app-deploy",
  ]);
  for (const entry of manifest.skills) {
    assert.equal(entry.package_version, "9.8.7");
    assert.equal(entry.content_sha256, sha256(Buffer.from(entry.content, "utf8")));
    assert.match(entry.bundle_sha256, /^[a-f0-9]{64}$/);
  }
  assert.equal(fs.statSync(firstOutput).mode & 0o077, 0);
});

test("builder rejects symlinked Skill content and output inside a Skill bundle", () => {
  const sourceRoot = makeSourceRoot();
  const linked = path.join(sourceRoot, "rainbond-app-assistant", "linked-secret");
  fs.symlinkSync(path.join(sourceRoot, "package.json"), linked);
  const linkedResult = build(sourceRoot, path.join(sourceRoot, "manifest.json"));
  assert.notEqual(linkedResult.status, 0);
  assert.match(linkedResult.stderr, /symbolic link/i);

  fs.unlinkSync(linked);
  const nestedResult = build(sourceRoot, path.join(
    sourceRoot,
    "rainbond-app-assistant",
    "rainskills-skill-manifest.json"
  ));
  assert.notEqual(nestedResult.status, 0);
  assert.match(nestedResult.stderr, /outside Skill directories/i);
});
