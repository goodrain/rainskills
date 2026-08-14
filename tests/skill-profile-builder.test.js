const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const repoRoot = path.resolve(__dirname, "..");
const builder = path.join(repoRoot, "scripts", "build-skill-profile.mjs");
const embeddedSkills = [
  "rainbond-app-assistant",
  "rainbond-app-version-assistant",
  "rainbond-delivery-verifier",
  "rainbond-fullstack-bootstrap",
  "rainbond-fullstack-troubleshooter",
  "rainbond-template-installer",
];

function buildEmbeddedProfile(output, ...extraArgs) {
  return spawnSync(
    process.execPath,
    [
      builder,
      "--profile",
      "embedded",
      "--source-root",
      repoRoot,
      "--output",
      output,
      "--revision",
      "test-sha",
      ...extraArgs,
    ],
    { encoding: "utf8" }
  );
}

function markdownFiles(root) {
  const files = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...markdownFiles(entryPath));
    else if (entry.name.endsWith(".md")) files.push(entryPath);
  }
  return files;
}

function extractHeredoc(workflow, fileName) {
  const marker = `cat > ${fileName} <<EOF\n`;
  const start = workflow.indexOf(marker);
  assert.notEqual(start, -1, `${fileName} heredoc must exist`);

  const bodyStart = start + marker.length;
  const remainder = workflow.slice(bodyStart);
  const terminator = remainder.match(/\n\s+EOF(?:\n|$)/);
  assert.ok(terminator, `${fileName} heredoc must have an EOF terminator`);
  return remainder.slice(0, terminator.index);
}

function assertManifestContract(manifest, { fileName, profile, transport, tarballUrl }) {
  assert.match(manifest, new RegExp(`^\\s*"profile": "${profile}",$`, "m"), fileName);
  assert.match(
    manifest,
    new RegExp(`^\\s*"transport": "${transport}",$`, "m"),
    fileName
  );
  assert.match(
    manifest,
    new RegExp(`^\\s*"tarball_url": "${tarballUrl}",$`, "m"),
    fileName
  );
  assert.equal((manifest.match(/"profile":/g) || []).length, 1, fileName);
  assert.equal((manifest.match(/"transport":/g) || []).length, 1, fileName);
  assert.equal((manifest.match(/"tarball_url":/g) || []).length, 1, fileName);
}

test("embedded profile is explicit, transport-safe, and contains only Agent-compatible skills", () => {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), "rainskills-embedded-"));
  const result = buildEmbeddedProfile(output);
  assert.equal(result.status, 0, result.stderr || result.stdout);

  const manifest = JSON.parse(
    fs.readFileSync(path.join(output, "rainskills-profile.json"), "utf8")
  );
  assert.deepEqual(manifest, {
    manifest_version: 1,
    profile: "embedded",
    source_revision: "test-sha",
    generator_version: 1,
    skills: embeddedSkills,
    runtime_contract: {
      platform_transport: "mcp",
      endpoint_class: "rainbond_agent_mcp",
      client_workspace: "unavailable",
      local_package_upload: "unsupported",
      configuration_sources: [
        "explicit_input",
        "session_context",
        "platform_tools",
      ],
      unavailable_behavior: "stop_and_report",
    },
  });

  for (const skill of embeddedSkills) {
    const skillPath = path.join(output, skill, "SKILL.md");
    const content = fs.readFileSync(skillPath, "utf8");
    assert.match(content, /^---\nmode: embedded\n/m, skill);
    assert.match(content, /embedded profile|会话.*Rainbond Tool/i, skill);
    assert.match(content, /Embedded Runtime Contract（最高优先级）/, skill);
    assert.match(content, /不读取本机项目目录或 `\.rainbond\/` 文件/, skill);
  }
  for (const markdownFile of markdownFiles(output)) {
    assert.doesNotMatch(
      fs.readFileSync(markdownFile, "utf8"),
      /rainskills-tools\.js|credentials\.env|mcp\.env|--api-only|\/console\/mcp\/rainskills\/api\/query/,
      path.relative(output, markdownFile)
    );
  }

  assert.equal(fs.existsSync(path.join(output, "rainbond-project-init")), false);
  assert.equal(fs.existsSync(path.join(output, "rainbond-env-sync")), false);
  assert.equal(fs.existsSync(path.join(output, "rainbond-platform-installer")), false);
  assert.equal(
    fs.existsSync(
      path.join(output, "rainbond-fullstack-bootstrap", "scripts", "upload_local_package.py")
    ),
    false,
    "embedded profile must not ship a client-workspace upload helper"
  );
});

test("embedded profile rejects unsupported profile values and a non-empty output directory", () => {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), "rainskills-embedded-fail-"));
  fs.writeFileSync(path.join(output, "existing"), "preserve me", "utf8");

  const occupied = buildEmbeddedProfile(output);
  assert.notEqual(occupied.status, 0);
  assert.match(occupied.stderr, /output directory must be empty/i);

  const badProfile = spawnSync(
    process.execPath,
    [builder, "--profile", "unknown", "--output", path.join(output, "next")],
    { encoding: "utf8" }
  );
  assert.notEqual(badProfile.status, 0);
  assert.match(badProfile.stderr, /unsupported profile/i);
});

test("release workflow publishes an isolated embedded artifact and channel manifests", () => {
  const workflow = fs.readFileSync(
    path.join(repoRoot, ".github", "workflows", "release.yml"),
    "utf8"
  );
  const buildProfile = workflow.indexOf("Build embedded Agent profile");
  const upload = workflow.indexOf("Upload to TOS");
  assert.notEqual(buildProfile, -1);
  assert(buildProfile < upload, "embedded profile must be built before upload");
  assert.match(workflow, /build-skill-profile\.mjs\s+\\?\s*\n?\s*--profile embedded/);
  assert.match(workflow, /rainskills-embedded-\$\{SHA\}\.tar\.gz/);
  assert.match(workflow, /profiles\/embedded\/channels\/canary\.json/);
  assert.match(workflow, /profiles\/embedded\/channels\/stable\.json/);
  assertManifestContract(extractHeredoc(workflow, "canary.json"), {
    fileName: "canary.json",
    profile: "cli",
    transport: "api",
    tarballUrl: "https://get\\.rainbond\\.com/rainskills/rainskills-\\$\\{SHA\\}\\.tar\\.gz",
  });
  assertManifestContract(extractHeredoc(workflow, "canary-embedded.json"), {
    fileName: "canary-embedded.json",
    profile: "embedded",
    transport: "mcp",
    tarballUrl:
      "https://get\\.rainbond\\.com/rainskills/profiles/embedded/rainskills-embedded-\\$\\{SHA\\}\\.tar\\.gz",
  });
  assertManifestContract(extractHeredoc(workflow, "stable.json"), {
    fileName: "stable.json",
    profile: "cli",
    transport: "api",
    tarballUrl: "\\$\\{TARBALL\\}",
  });
  assertManifestContract(extractHeredoc(workflow, "stable-embedded.json"), {
    fileName: "stable-embedded.json",
    profile: "embedded",
    transport: "mcp",
    tarballUrl: "\\$\\{\\{ steps\\.meta\\.outputs\\.embedded_tarball \\}\\}",
  });
  assert.match(
    workflow,
    /TARBALL_URL="https:\/\/get\.rainbond\.com\/rainskills\/rainskills-\$\{SHA\}\.tar\.gz"/
  );
  assert.match(
    workflow,
    /EMBEDDED_TARBALL_URL="https:\/\/get\.rainbond\.com\/rainskills\/profiles\/embedded\/rainskills-embedded-\$\{SHA\}\.tar\.gz"/
  );
  assert.match(
    workflow,
    /echo "tarball=\$\{TARBALL_URL\}"\s*>> "\$GITHUB_OUTPUT"/
  );
  assert.match(
    workflow,
    /echo "embedded_tarball=\$\{EMBEDDED_TARBALL_URL\}"\s*>> "\$GITHUB_OUTPUT"/
  );
  assert.match(
    workflow,
    /TARBALL="\$\{\{ steps\.meta\.outputs\.tarball \}\}"[\s\S]{0,100}cat > stable\.json <<EOF/
  );
  assert.doesNotMatch(workflow, /build-pi-extension\.mjs/);
});
