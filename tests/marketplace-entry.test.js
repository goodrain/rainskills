const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const repoRoot = path.resolve(__dirname, "..");
const marketplaceRoot = path.join(repoRoot, "marketplace", "rainskills");

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
}

function readJson(relativePath) {
  return JSON.parse(read(relativePath));
}

function findNamedFiles(root, name) {
  if (!fs.existsSync(root)) {
    return [];
  }

  const matches = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      matches.push(...findNamedFiles(entryPath, name));
    } else if (entry.name === name) {
      matches.push(entryPath);
    }
  }
  return matches;
}

test("repository exposes one complete Rainskills marketplace entry", () => {
  const skill = read("SKILL.md");

  assert.match(skill, /^---\nname: rainskills\n/);
  assert.match(skill, /description: Use when /);
  assert.match(skill, /single marketplace entry/i);
  assert.match(skill, /install\.sh/);
  assert.match(skill, /every bundled `rainbond-\*` Skill as an independent Skill/i);
  assert.match(skill, /Do not ask the user to choose only one/i);
  assert.match(skill, /OpenClaw=`openclaw`, Pi Agent=`pi`/);
  assert.match(skill, /attached interactive terminal/i);
  assert.match(skill, /RAINSKILLS_USER_INPUT_REQUIRED/);
  assert.match(skill, /rainskills\.next-action\.v1/);
  assert.match(
    skill,
    /native Windows.*node <skill-directory>\/bin\/rainskills\.js <target>/is
  );
  assert.match(
    skill,
    /macOS, Linux, or WSL.*bash <skill-directory>\/install\.sh <target>/is
  );
});

test("marketplace metadata presents Rainskills as one product", () => {
  const metadata = read("agents/openai.yaml");

  assert.match(metadata, /display_name: "Rainskills"/);
  assert.match(metadata, /short_description: ".{25,64}"/);
  assert.match(metadata, /default_prompt: ".*\$rainskills.*"/);
});

test("generated marketplace package contains one version-pinned Skill", () => {
  const manifest = readJson("package.json");
  const skillFiles = findNamedFiles(marketplaceRoot, "SKILL.md");

  assert.deepEqual(
    skillFiles.map((file) => path.relative(marketplaceRoot, file)),
    [path.join("skills", "rainskills", "SKILL.md")]
  );

  const skill = fs.readFileSync(skillFiles[0], "utf8");
  assert.match(skill, /^---\nname: rainskills\n/);
  assert.match(skill, /single marketplace entry/i);
  assert.match(
    skill,
    new RegExp(`npx --yes rainskills@${manifest.version.replaceAll(".", "\\.")}`)
  );
  assert.doesNotMatch(skill, /npx --yes rainskills`/);
  assert.match(skill, /Node\.js 18/);
  assert.match(
    skill,
    /If the adjacent `bin\/rainskills\.js` exists.*same versioned npm package fallback/s
  );
  assert.match(
    skill,
    /bash <\(curl -fsSL https:\/\/get\.rainbond\.com\/rainskills\/install\.sh\)/
  );
  assert.equal(findNamedFiles(marketplaceRoot, "install.sh").length, 0);
});

test("Claude and Codex manifests expose the same generated product", () => {
  const packageManifest = readJson("package.json");
  const claudeManifest = readJson(
    "marketplace/rainskills/.claude-plugin/plugin.json"
  );
  const codexManifest = readJson(
    "marketplace/rainskills/.codex-plugin/plugin.json"
  );

  for (const manifest of [claudeManifest, codexManifest]) {
    assert.equal(manifest.name, "rainskills");
    assert.equal(manifest.version, packageManifest.version);
    assert.equal(manifest.author.name, "Goodrain");
    assert.equal(manifest.repository, "https://github.com/goodrain/rainskills");
    assert.equal(manifest.license, "Apache-2.0");
  }

  assert.equal(codexManifest.skills, "./skills/");
  assert.equal(codexManifest.interface.displayName, "Rainskills");
  assert.equal(codexManifest.interface.developerName, "Goodrain");
  assert.deepEqual(codexManifest.interface.capabilities, ["Interactive", "Write"]);
  assert.equal(codexManifest.mcpServers, undefined);
});

test("Claude and Codex catalogs point to the one generated plugin", () => {
  const claudeMarketplace = readJson(".claude-plugin/marketplace.json");
  const codexMarketplace = readJson(".agents/plugins/marketplace.json");

  assert.equal(claudeMarketplace.name, "goodrain");
  assert.equal(claudeMarketplace.owner.name, "Goodrain");
  assert.deepEqual(
    claudeMarketplace.plugins.map(({ name, source }) => ({ name, source })),
    [
      {
        name: "rainskills",
        source: "./marketplace/rainskills",
      },
    ]
  );
  assert.equal(claudeMarketplace.plugins[0].version, undefined);

  assert.equal(codexMarketplace.name, "goodrain");
  assert.deepEqual(codexMarketplace.plugins, [
    {
      name: "rainskills",
      source: {
        source: "local",
        path: "./marketplace/rainskills",
      },
      policy: {
        installation: "AVAILABLE",
        authentication: "ON_USE",
      },
      category: "Engineering",
    },
  ]);
});

test("marketplace generator reports committed output is current", () => {
  const result = spawnSync(
    process.execPath,
    ["scripts/build-marketplace-package.mjs", "--check"],
    { cwd: repoRoot, encoding: "utf8" }
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Marketplace package is current/);
});

test("release verifies marketplace output before building the repository tarball", () => {
  const workflow = read(".github/workflows/release.yml");
  const validationStep = workflow.indexOf("name: Verify marketplace package");
  const packStep = workflow.indexOf("name: Pack release tarball");

  assert.notEqual(validationStep, -1);
  assert.notEqual(packStep, -1);
  assert(validationStep < packStep);
  assert.match(
    workflow.slice(validationStep, packStep),
    /node scripts\/build-marketplace-package\.mjs --check/
  );
});

test("npm artifact includes the marketplace entry", () => {
  const manifest = readJson("package.json");

  assert(manifest.files.includes("SKILL.md"));
  assert(manifest.files.includes("agents/"));
  assert(manifest.files.includes("marketplace/"));
  assert(manifest.files.includes("pi/"));
  assert.deepEqual(manifest.pi, {
    skills: ["./marketplace/rainskills/skills"],
  });
  assert.equal(
    manifest.scripts["test:marketplace"],
    "node --test tests/marketplace-entry.test.js"
  );
  assert.match(manifest.scripts.test, /npm run test:marketplace/);
  assert.equal(
    manifest.scripts["build:marketplace"],
    "node scripts/build-marketplace-package.mjs"
  );
  assert.equal(
    manifest.scripts["check:marketplace"],
    "node scripts/build-marketplace-package.mjs --check"
  );
});

test("README distinguishes marketplace and direct installer Node requirements", () => {
  const readme = read("README.md");

  assert.match(readme, /Skill 市场.*Node\.js 22\.20\.0/s);
  assert.match(readme, /直接运行.*最低支持 Node\.js 18/s);
});

test("README documents one-product installation and updates for each adapter", () => {
  const readme = read("README.md");

  assert.match(readme, /npx skills add goodrain\/rainskills/);
  assert.match(readme, /codex plugin marketplace add goodrain\/rainskills/);
  assert.match(readme, /codex plugin add rainskills@goodrain/);
  assert.match(readme, /\/plugin marketplace add goodrain\/rainskills/);
  assert.match(readme, /\/plugin install rainskills@goodrain/);
  assert.match(readme, /npx skills update rainskills/);
  assert.match(readme, /codex plugin marketplace upgrade goodrain/);
  assert.match(readme, /\/plugin update rainskills@goodrain/);
  assert.match(readme, /OpenClaw/);
  assert.match(readme, /Pi Agent/);
  assert.match(readme, /pi install npm:rainskills/);
  assert.match(readme, /只会看到一个.*Rainskills/s);
});
