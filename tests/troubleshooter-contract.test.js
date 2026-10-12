"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const YAML = require("yaml");

const root = path.resolve(__dirname, "..");
const skillRoot = path.join(root, "rainbond-fullstack-troubleshooter");

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

test("Troubleshooter fields and enums come only from the canonical schema", () => {
  const main = read("rainbond-fullstack-troubleshooter/SKILL.md");
  const output = read("rainbond-fullstack-troubleshooter/references/output-contract.md");
  const validator = read("rainbond-fullstack-troubleshooter/scripts/validate_troubleshoot_output.py");
  for (const content of [main, output]) {
    assert.doesNotMatch(content, /Live schema summary:/);
    assert.doesNotMatch(content, /Canonical required top-level fields:/);
    assert.match(content, /generated\/troubleshoot-contract\.md/);
  }
  assert.doesNotMatch(validator, /CANONICAL_BUCKETS/);
});

test("generated TroubleshootResult reference is current and schema-derived", () => {
  const generator = path.join(skillRoot, "scripts/generate_troubleshoot_contract.mjs");
  const result = spawnSync(process.execPath, [generator, "--check"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const generated = read("rainbond-fullstack-troubleshooter/references/generated/troubleshoot-contract.md");
  assert.match(generated, /schema_sha256: [a-f0-9]{64}/);
  assert.match(generated, /config_file_configmap_missing/);
  assert.match(generated, /platform backend issue/);
  assert.match(generated, /platform_backend_issue/);
  assert.match(generated, /verification_summary\.key_error_cleared/);
});

test("ConfigMap fixture requires one save, one restart, and fresh verification", () => {
  const expectedText = read("rainbond-fullstack-troubleshooter/evals/10-config-file-configmap-missing.expected.yaml");
  const expected = YAML.parse(expectedText);
  const actions = [
    "Re-saved config-file content exactly once with new_file_content and no unchanged new_volume_path.",
    "Restarted the affected api component exactly once after the re-save.",
    "Read fresh post-restart component events and pod detail exactly once.",
  ];
  assert.deepEqual(expected.assert.equal["TroubleshootResult.actions_taken"], actions);

  const response = read("rainbond-fullstack-troubleshooter/evals/10-config-file-configmap-missing.response.md");
  for (const action of actions) assert.match(response, new RegExp(action.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(response, /fresh post-restart/i);
});

test("ConfigMap fixture rejects a missing restart action", () => {
  const evalDir = fs.mkdtempSync(path.join(os.tmpdir(), "rainskills-configmap-fixture-"));
  const expected = read("rainbond-fullstack-troubleshooter/evals/10-config-file-configmap-missing.expected.yaml");
  const response = read("rainbond-fullstack-troubleshooter/evals/10-config-file-configmap-missing.response.md");
  const invalid = response.replace(/\n    - "Restarted the affected api component exactly once after the re-save\."/, "");
  fs.writeFileSync(path.join(evalDir, "configmap.expected.yaml"), expected);
  fs.writeFileSync(path.join(evalDir, "configmap.response.md"), invalid);

  const result = spawnSync("python3", [
    path.join(skillRoot, "scripts/run_troubleshooter_evals.py"),
    "--eval-dir", evalDir,
    "--schema", path.join(skillRoot, "schemas/troubleshoot-result.schema.yaml"),
  ], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /TroubleshootResult\.actions_taken/);
});
