const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const repoRoot = path.resolve(__dirname, "..");

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
}

test("repository exposes one complete Rainskills marketplace entry", () => {
  const skill = read("SKILL.md");

  assert.match(skill, /^---\nname: rainskills\n/);
  assert.match(skill, /description: Use when /);
  assert.match(skill, /single marketplace entry/i);
  assert.match(skill, /install\.sh/);
  assert.match(skill, /Do not install .*rainbond-\*/i);
  assert.match(skill, /attached interactive terminal/i);
  assert.match(skill, /RAINSKILLS_USER_INPUT_REQUIRED/);
  assert.match(skill, /rainskills\.next-action\.v1/);
});

test("marketplace metadata presents Rainskills as one product", () => {
  const metadata = read("agents/openai.yaml");

  assert.match(metadata, /display_name: "Rainskills"/);
  assert.match(metadata, /short_description: ".{25,64}"/);
  assert.match(metadata, /default_prompt: ".*\$rainskills.*"/);
});

test("npm artifact includes the marketplace entry", () => {
  const manifest = JSON.parse(read("package.json"));

  assert(manifest.files.includes("SKILL.md"));
  assert(manifest.files.includes("agents/"));
  assert.equal(
    manifest.scripts["test:marketplace"],
    "node --test tests/marketplace-entry.test.js"
  );
  assert.match(manifest.scripts.test, /npm run test:marketplace/);
});

test("README distinguishes marketplace and direct installer Node requirements", () => {
  const readme = read("README.md");

  assert.match(readme, /Skill 市场.*Node\.js 22\.20\.0/s);
  assert.match(readme, /直接运行.*最低支持 Node\.js 18/s);
});
