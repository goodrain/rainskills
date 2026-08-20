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
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "rainskills", version: "9.8.7" }));
  for (const [skillId, content] of [
    ["rainbond-app-assistant", "---\nname: App assistant\n---\n# Root\n"],
    ["rainbond-fullstack-bootstrap", "---\nname: Bootstrap\n---\n# Bootstrap\n"],
  ]) {
    const directory = path.join(root, skillId);
    fs.mkdirSync(path.join(directory, "references"), { recursive: true });
    fs.writeFileSync(path.join(directory, "SKILL.md"), content);
    fs.writeFileSync(path.join(directory, "references", "contract.md"), `${skillId}\n`);
  }
  return root;
}

function build(sourceRoot, output, revision = "revision-1") {
  return spawnSync(process.execPath, [
    builder,
    "--source-root", sourceRoot,
    "--output", output,
    "--revision", revision,
  ], { encoding: "utf8" });
}

test("builder records exact UTF-8 content and deterministic bundle digests", () => {
  const sourceRoot = makeSourceRoot();
  const firstOutput = path.join(sourceRoot, "first.json");
  const secondOutput = path.join(sourceRoot, "second.json");

  const first = build(sourceRoot, firstOutput);
  const second = build(sourceRoot, secondOutput);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(second.status, 0, second.stderr);
  const manifest = JSON.parse(fs.readFileSync(firstOutput, "utf8"));
  const repeated = JSON.parse(fs.readFileSync(secondOutput, "utf8"));

  assert.equal(manifest.schema, "rainskills.skill-manifest.v1");
  assert.equal(manifest.profile, "cli");
  assert.equal(manifest.package_version, "9.8.7");
  assert.equal(manifest.source_revision, "revision-1");
  assert.deepEqual(manifest, repeated);
  assert.deepEqual(manifest.skills.map((entry) => entry.id), [
    "rainbond-app-assistant",
    "rainbond-fullstack-bootstrap",
  ]);
  for (const entry of manifest.skills) {
    assert.equal(entry.package_version, "9.8.7");
    assert.equal(entry.content_sha256, sha256(Buffer.from(entry.content, "utf8")));
    assert.match(entry.bundle_sha256, /^[a-f0-9]{64}$/);
  }
  assert.doesNotMatch(JSON.stringify(manifest), new RegExp(
    sourceRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  ));
  assert.equal(fs.statSync(firstOutput).mode & 0o077, 0);
});

test("content and relative bundle changes update their respective digests", () => {
  const sourceRoot = makeSourceRoot();
  const firstOutput = path.join(sourceRoot, "first.json");
  assert.equal(build(sourceRoot, firstOutput).status, 0);
  const first = JSON.parse(fs.readFileSync(firstOutput, "utf8"));
  const firstEntry = first.skills.find((entry) => entry.id === "rainbond-fullstack-bootstrap");

  fs.appendFileSync(path.join(sourceRoot, "rainbond-fullstack-bootstrap", "SKILL.md"), "changed\n");
  const contentOutput = path.join(sourceRoot, "content.json");
  assert.equal(build(sourceRoot, contentOutput).status, 0);
  const contentEntry = JSON.parse(fs.readFileSync(contentOutput, "utf8")).skills
    .find((entry) => entry.id === "rainbond-fullstack-bootstrap");
  assert.notEqual(contentEntry.content_sha256, firstEntry.content_sha256);
  assert.notEqual(contentEntry.bundle_sha256, firstEntry.bundle_sha256);

  fs.appendFileSync(
    path.join(sourceRoot, "rainbond-fullstack-bootstrap", "references", "contract.md"),
    "reference changed\n"
  );
  const bundleOutput = path.join(sourceRoot, "bundle.json");
  assert.equal(build(sourceRoot, bundleOutput).status, 0);
  const bundleEntry = JSON.parse(fs.readFileSync(bundleOutput, "utf8")).skills
    .find((entry) => entry.id === "rainbond-fullstack-bootstrap");
  assert.equal(bundleEntry.content_sha256, contentEntry.content_sha256);
  assert.notEqual(bundleEntry.bundle_sha256, contentEntry.bundle_sha256);
});

test("builder rejects symlinks and an output path inside a Skill bundle", () => {
  const sourceRoot = makeSourceRoot();
  const linked = path.join(sourceRoot, "rainbond-fullstack-bootstrap", "linked-secret");
  fs.symlinkSync(path.join(sourceRoot, "package.json"), linked);
  const linkedResult = build(sourceRoot, path.join(sourceRoot, "manifest.json"));
  assert.notEqual(linkedResult.status, 0);
  assert.match(linkedResult.stderr, /symbolic link/i);

  fs.unlinkSync(linked);
  const nestedOutput = path.join(
    sourceRoot,
    "rainbond-fullstack-bootstrap",
    "rainskills-skill-manifest.json"
  );
  const nestedResult = build(sourceRoot, nestedOutput);
  assert.notEqual(nestedResult.status, 0);
  assert.match(nestedResult.stderr, /outside Skill directories/i);
});
