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
  assert.match(skill, /Codex=`codex`.*Claude Code=`claude`.*Pi Agent=`pi`/);
  assert.match(skill, /does not support OpenClaw/);
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

test("POSIX platform handoff prints only the fixed continuation command", () => {
  const installer = read("install.sh");

  assert.match(installer, /log "npx \$\{package_spec\} platform install --onboarding-id \$\{onboarding_id\}"/);
  assert.doesNotMatch(installer, /"schema": "rainskills\.next-action\.v1"/);
});

test("marketplace metadata presents Rainskills as one product", () => {
  const metadata = read("agents/openai.yaml");

  assert.match(metadata, /display_name: "Rainskills"/);
  assert.match(metadata, /short_description: ".{25,64}"/);
  assert.match(metadata, /default_prompt: ".*\$rainskills.*"/);
  assert.match(metadata, /安装.*Skill|install.*Skill/i);
  assert.doesNotMatch(metadata, /connect.*Rainbond|initialize.*Rainbond/i);
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

test("marketplace generator can check quietly during npm pack JSON output", () => {
  const result = spawnSync(
    process.execPath,
    ["scripts/build-marketplace-package.mjs", "--check", "--quiet"],
    { cwd: repoRoot, encoding: "utf8" }
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
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

test("Windows workflow contracts install package dependencies before running Node tests", () => {
  for (const workflowPath of [".github/workflows/release.yml", ".github/workflows/test.yml"]) {
    const workflow = read(workflowPath);
    const windowsJob = workflow.match(/windows[_-]contract:[\s\S]*?\n  [a-z][a-z_-]*:\n/)?.[0];
    assert(windowsJob, `${workflowPath} must define a Windows contract job`);
    const installStep = windowsJob.indexOf("npm ci --ignore-scripts");
    const testStep = windowsJob.indexOf("node --test tests/windows-onboarding.test.js");
    assert.notEqual(installStep, -1, `${workflowPath} must install package dependencies`);
    assert.notEqual(testStep, -1, `${workflowPath} must run Windows installer contracts`);
    assert(installStep < testStep, `${workflowPath} must install dependencies before tests`);
  }
});

test("npm artifact includes the marketplace entry without a Pi adapter", () => {
  const manifest = readJson("package.json");

  assert(manifest.files.includes("SKILL.md"));
  assert(manifest.files.includes("agents/"));
  assert(manifest.files.includes("marketplace/"));
  assert(!manifest.files.includes("pi/"));
  assert.equal(manifest.pi, undefined);
  assert.equal(manifest.scripts["build:pi"], undefined);
  assert.equal(manifest.scripts["check:pi"], undefined);
  assert.equal(manifest.scripts["test:pi"], undefined);
  assert.doesNotMatch(manifest.scripts.test, /test:pi/);
  assert.equal(
    manifest.scripts["test:marketplace"],
    "node --test tests/marketplace-entry.test.js"
  );
  assert.match(manifest.scripts.test, /npm run test:marketplace/);
  assert.equal(
    manifest.scripts["test:runtime-routing"],
    "node --test tests/runtime-onboarding-routing.test.js && python3 rainbond-app-assistant/scripts/validate_progressive_loading.py && python3 rainbond-app-assistant/scripts/validate_cross_skill_routing.py && python3 tests/run_skill_routing_evals.py"
  );
  assert.match(manifest.scripts.test, /npm run test:runtime-routing/);
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

test("README documents one-product installation and adapter-neutral stable auto-updates", () => {
  const readme = read("README.md");

  assert.match(readme, /npx skills add goodrain\/rainskills/);
  assert.match(readme, /codex plugin marketplace add goodrain\/rainskills/);
  assert.match(readme, /codex plugin add rainskills@goodrain/);
  assert.match(readme, /\/plugin marketplace add goodrain\/rainskills/);
  assert.match(readme, /\/plugin install rainskills@goodrain/);
  assert.match(readme, /静默检查更新/);
  assert.match(readme, /本地运行时立即返回.*后台任务静默检查更新/s);
  assert.match(readme, /不会阻塞或改变当前操作/);
  assert.match(readme, /只跟随.*正式版/s);
  assert.match(readme, /RC.*不会.*自动升级/s);
  assert.match(readme, /升级只更新 Rainskills 自身，不触发 Rainbond/s);
  assert.match(readme, /支持 Codex、Claude Code 和 Pi Agent/);
  assert.match(readme, /不支持 OpenClaw 安装/);
  assert.doesNotMatch(readme, /npx --yes rainskills openclaw/);
  assert.match(readme, /只会看到一个.*Rainskills/s);
  assert.match(readme, /安装完成后.*不会.*运行环境|安装完成后.*只.*Skills/s);
});

test("generated marketplace guidance installs Skills without eager runtime setup", () => {
  const skill = read("marketplace/rainskills/skills/rainskills/SKILL.md");
  const plugin = readJson("marketplace/rainskills/.codex-plugin/plugin.json");

  assert.match(skill, /Rainskills 安装完成/);
  assert.doesNotMatch(skill, /Stay attached until (?:all )?MCP|Report the configured Rainbond environment/);
  assert.match(plugin.description, /skill/i);
  assert.doesNotMatch(plugin.description, /connect|authoriz|MCP/i);
  assert.doesNotMatch(plugin.interface.longDescription, /choose Rainbond Cloud|authorize access|configure MCP/i);
  const completion = skill.slice(skill.indexOf("## Completion Message"));
  assert.match(completion, /下一步可以直接说/);
  assert.doesNotMatch(completion, /reload|restart|重新加载|重启/i);
});

test("Pi uses the generic Skills and CLI path without restoring its adapter", () => {
  const manifest = readJson("package.json");
  assert.match(read("SKILL.md"), /Pi Agent=`pi`/);
  assert.match(read("install.sh"), /\.pi\/agent\/skills/);
  assert.match(read("README.md"), /Codex、Claude Code 和 Pi Agent/);
  assert.equal(manifest.pi, undefined);
  assert(!manifest.files.includes("pi/"));
  assert.equal(manifest.scripts["build:pi"], undefined);
  assert.equal(manifest.scripts["test:pi"], undefined);
});
