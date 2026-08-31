const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const builder = path.join(root, "scripts", "build-skill-profile.mjs");
const markdownLink = /\[[^\]]*\]\(([^)]+)\)/g;

function markdownFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return markdownFiles(entryPath);
    return entry.name.endsWith(".md") ? [entryPath] : [];
  });
}

function assertLinksResolve(directory, allowedPaths) {
  for (const markdown of markdownFiles(directory)) {
    const content = fs.readFileSync(markdown, "utf8");
    for (const match of content.matchAll(markdownLink)) {
      const target = match[1].replace(/^<|>$/g, "").split("#", 1)[0];
      if (!target || /^(https?:|mailto:|#)/.test(target)) continue;
      const resolved = path.resolve(path.dirname(markdown), target);
      assert(allowedPaths ? allowedPaths.has(path.relative(directory, resolved)) : fs.existsSync(resolved),
        `${path.relative(directory, markdown)} links to missing ${target}`);
    }
  }
}

function runtimeMarkdown(directory) {
  const files = [];
  const rootSkill = path.join(directory, "SKILL.md");
  if (fs.existsSync(rootSkill)) files.push(rootSkill);
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name.startsWith("rainbond-")) {
      files.push(...markdownFiles(path.join(directory, entry.name)));
    }
  }
  return files;
}

function assertRuntimeLinksResolve(directory) {
  const rootLinks = new Set(runtimeMarkdown(directory));
  for (const markdown of rootLinks) {
    const content = fs.readFileSync(markdown, "utf8");
    for (const match of content.matchAll(markdownLink)) {
      const target = match[1].replace(/^<|>$/g, "").split("#", 1)[0];
      if (!target || /^(https?:|mailto:|#)/.test(target)) continue;
      assert(fs.existsSync(path.resolve(path.dirname(markdown), target)),
        `${path.relative(directory, markdown)} links to missing ${target}`);
    }
  }
}

test("runtime Markdown links resolve in source, packed package, and embedded profile", () => {
  assertRuntimeLinksResolve(root);

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "rainskills-links-profile-"));
  const profileResult = spawnSync(process.execPath, [
    builder, "--profile", "embedded", "--source-root", root, "--output", profile, "--revision", "test-sha",
  ], { encoding: "utf8" });
  assert.equal(profileResult.status, 0, profileResult.stderr || profileResult.stdout);
  assertRuntimeLinksResolve(profile);

  const packDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "rainskills-links-pack-"));
  const pack = spawnSync("npm", ["pack", "--json", "--pack-destination", packDirectory], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, npm_config_cache: path.join(packDirectory, "npm-cache") },
  });
  assert.equal(pack.status, 0, pack.stderr || pack.stdout);
  const [{ filename, files }] = JSON.parse(pack.stdout);
  const unpacked = path.join(packDirectory, "package");
  const extract = spawnSync("tar", ["-xzf", path.join(packDirectory, filename), "-C", packDirectory], { encoding: "utf8" });
  assert.equal(extract.status, 0, extract.stderr || extract.stdout);
  assert(files.length > 0);
  assertRuntimeLinksResolve(unpacked);
});
