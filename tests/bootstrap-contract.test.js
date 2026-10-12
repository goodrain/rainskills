"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const YAML = require("yaml");

const root = path.resolve(__dirname, "..");

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

test("bootstrap modules defer to one closed proxy policy", () => {
  const rootSkill = read("rainbond-fullstack-bootstrap/SKILL.md");
  const creation = read("rainbond-fullstack-bootstrap/modules/30-creation-rules.md");
  const source = [
    read("rainbond-fullstack-bootstrap/modules/40-source-rules.md"),
    read("rainbond-fullstack-bootstrap/modules/42-source-topology.md"),
    read("rainbond-fullstack-bootstrap/modules/44-source-build-rules.md"),
    read("rainbond-fullstack-bootstrap/modules/45-package-rules.md"),
  ].join("\n");

  assert.match(rootSkill, /github\.com[^\n]*https:\/\/ghfast\.top/);
  assert.match(rootSkill, /docker\.io[^\n]*docker\.1ms\.run/);
  assert.match(rootSkill, /Other public registries[\s\S]{0,500}try the original URL directly/i);
  for (const module of [creation, source]) {
    assert.match(module, /Always-on Guardrail 7/);
    assert.doesNotMatch(module, /ask once whether to keep the raw/i);
    assert.doesNotMatch(module, /gh\.rainbond\.cc/);
  }
  assert.match(creation, /Never derive[^\n]*docker\.1ms\.run\/quay\.io/);
});

test("provider fixture proves persistence, dependency direction, and provider contract", () => {
  const expectedText = read("rainbond-fullstack-bootstrap/evals/07-provider-connection-contract.expected.yaml");
  const expected = YAML.parse(expectedText);
  const response = read("rainbond-fullstack-bootstrap/evals/07-provider-connection-contract.response.md");

  for (const phrase of [
    "durable storage",
    "/var/lib/mysql",
    "api -> mysql",
    "provider connection envs",
    "No duplicate consumer DB envs",
  ]) {
    assert.match(expectedText, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
    assert.match(response, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
  }
  assert.deepEqual(expected.assert.prose_ordered, [
    "durable storage at /var/lib/mysql",
    "provider connection envs on mysql",
    "service_id=api, dep_service_id=mysql",
    "deployed the configured components",
  ]);
  assert.match(response, /storage[^\n]*(?:before|prior to)[^\n]*(?:deploy|deployment)/i);
  assert.match(response, /api -> mysql/);
  assert.doesNotMatch(response, /mysql -> api/);
});

test("bootstrap fixture validator rejects provider actions in the wrong order", () => {
  const evalDir = fs.mkdtempSync(path.join(os.tmpdir(), "rainskills-bootstrap-order-"));
  const expected = read("rainbond-fullstack-bootstrap/evals/07-provider-connection-contract.expected.yaml");
  const response = read("rainbond-fullstack-bootstrap/evals/07-provider-connection-contract.response.md");
  const storageSentence = "Inspected `mysql` storage and mounted durable storage at /var/lib/mysql with an explicit volume name before deployment. ";
  const connectionSentence = "Configured the MySQL provider inner port and stable port alias, then created provider connection envs on mysql. ";
  const invalid = response.replace(
    `${storageSentence}${connectionSentence}`,
    `${connectionSentence}${storageSentence}`,
  );
  fs.writeFileSync(path.join(evalDir, "order.expected.yaml"), expected);
  fs.writeFileSync(path.join(evalDir, "order.response.md"), invalid);

  const result = spawnSync("python3", [
    path.join(root, "rainbond-fullstack-bootstrap/scripts/run_bootstrap_evals.py"),
    "--eval-dir", evalDir,
    "--schema", path.join(root, "rainbond-fullstack-bootstrap/schemas/bootstrap-result.schema.yaml"),
  ], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /required ordered text/i);
});
