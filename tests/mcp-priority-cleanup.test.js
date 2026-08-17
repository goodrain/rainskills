const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const repoRoot = path.resolve(__dirname, "..");

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
}

function collectInstructionMarkdown(root) {
  const files = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (["evals", "runs", "scripts", "tests", "__pycache__"].includes(entry.name)) continue;
      files.push(...collectInstructionMarkdown(entryPath));
    } else if (entry.name.endsWith(".md")) {
      files.push(entryPath);
    }
  }
  return files;
}

test("obsolete MCP-first specifications are absent", () => {
  for (const relativePath of [
    ".claude/specs/api-fallback-transport.md",
    ".claude/specs/api-fallback-transport.yaml",
    "docs/plans/2026-08-12-api-fallback-transport-design.md",
  ]) {
    assert.equal(fs.existsSync(path.join(repoRoot, relativePath)), false, relativePath);
  }

  assert.doesNotMatch(
    read("docs/plans/2026-08-13-cli-only-rainskills-and-agent-skill-coordination.md"),
    /native MCP preferred \+ CLI bridge fallback/i
  );
});

test("shared CLI instructions use transport-neutral Rainbond Tool wording", () => {
  const instructionFiles = fs
    .readdirSync(repoRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("rainbond-"))
    .flatMap((entry) => collectInstructionMarkdown(path.join(repoRoot, entry.name)));
  const forbidden = [
    /Preferred MCP Tools/i,
    /Next MCP tools/i,
    /exact MCP tools/i,
    /trust MCP/i,
    /query MCP component data first/i,
    /Before any mutating MCP call/i,
    /Mutating MCP calls/i,
    /storage MCP call/i,
    /single MCP call/i,
    /through the updated Rainbond MCP workflow/i,
    /Route each concern through the correct MCP entry/i,
    /MCP gives runtime truth/i,
    /Current install MCP/i,
    /current MCP(?:-facing)? (?:surface|capability)/i,
    /MCP\/runtime/i,
    /MCP write operations/i,
    /MCP local-package/i,
    /MCP package upload/i,
    /MCP client machine/i,
    /MCP (?:initialize|status)/i,
    /(?:an|the|any|a) MCP tool/i,
  ];

  for (const file of instructionFiles) {
    const content = fs.readFileSync(file, "utf8");
    for (const pattern of forbidden) {
      assert.doesNotMatch(content, pattern, `${path.relative(repoRoot, file)} retains ${pattern}`);
    }
  }
});

test("legacy MCP-first routing fixtures are absent", () => {
  const fixture = read("tests/skill-routing-fixtures.yaml");
  assert.doesNotMatch(fixture, /^transport_cases:/m);
  assert.doesNotMatch(fixture, /^\s+expected_state: mcp$/m);
  assert.doesNotMatch(fixture, /current_session_has_any_rainbond_tool/);
});

test("profile-neutral blocker vocabulary does not name a transport", () => {
  for (const relativePath of [
    "rainbond-app-assistant/SKILL.md",
    "rainbond-fullstack-bootstrap/SKILL.md",
    "rainbond-fullstack-bootstrap/schemas/bootstrap-result.schema.yaml",
    "rainbond-fullstack-bootstrap/scripts/validate_bootstrap_output.py",
    "rainbond-fullstack-troubleshooter/SKILL.md",
    "rainbond-fullstack-troubleshooter/schemas/troubleshoot-result.schema.yaml",
    "rainbond-fullstack-troubleshooter/scripts/validate_troubleshoot_output.py",
  ]) {
    assert.doesNotMatch(read(relativePath), /mcp backend issue/i, relativePath);
  }
});

test("every POSIX installer test function is registered", () => {
  const source = read("tests/install.sh.test");
  const definitions = [...source.matchAll(/^(test_[A-Za-z0-9_]+)\(\)\s*\{/gm)].map(
    (match) => match[1]
  );
  const registered = new Set(
    [...source.matchAll(/^(test_[A-Za-z0-9_]+)$/gm)].map((match) => match[1])
  );
  const missing = definitions.filter((name) => !registered.has(name));

  assert.deepEqual(missing, [], `unregistered installer tests: ${missing.join(", ")}`);
});

test("POSIX installer no longer carries fallback-only state", () => {
  const installer = read("install.sh");
  assert.doesNotMatch(installer, /RAINSKILLS_API_FALLBACK_ACTIVE/);
  assert.doesNotMatch(installer, /RAINSKILLS_PI_EXTENSION_TEMP_FILE/);
  assert.doesNotMatch(installer, /RAINSKILLS_MCP_VALIDATION_TEMP_DIR/);
  assert.doesNotMatch(installer, /cleanup_mcp_validation/);
});
