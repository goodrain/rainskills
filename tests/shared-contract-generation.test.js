"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const repoRoot = path.resolve(__dirname, "..");
const syncScript = path.join(repoRoot, "scripts", "sync-shared-contracts.mjs");
const communitySkills = [
  "rainbond-ai-assistant",
  "rainbond-app-assistant",
  "rainbond-app-version-assistant",
  "rainbond-delivery-verifier",
  "rainbond-env-sync",
  "rainbond-fullstack-bootstrap",
  "rainbond-fullstack-troubleshooter",
  "rainbond-opensource-app-deploy",
  "rainbond-platform-plugin-manager",
  "rainbond-project-init",
  "rainbond-template-installer",
];

function markdownFiles(root) {
  const files = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...markdownFiles(entryPath));
    else if (entry.name.endsWith(".md")) files.push(entryPath);
  }
  return files;
}

test("open-source Skills ship no community advertising contract", () => {
  const canonical = path.join(repoRoot, "contracts", "shared", "community-card.md");
  assert.equal(fs.existsSync(canonical), false);

  for (const skillId of communitySkills) {
    const generatedPath = path.join(
      repoRoot,
      skillId,
      "references",
      "generated",
      "community-card.md",
    );
    assert.equal(fs.existsSync(generatedPath), false, generatedPath);
    for (const file of markdownFiles(path.join(repoRoot, skillId))) {
      assert.doesNotMatch(
        fs.readFileSync(file, "utf8"),
        /community-card|交流群|二维码|rainbond-xzs/i,
        path.relative(repoRoot, file),
      );
    }
  }
});

test("default user-result policy has one canonical source and current generated references", () => {
  const canonical = path.join(repoRoot, "contracts", "shared", "user-result.md");
  assert(fs.existsSync(canonical));
  const result = spawnSync(process.execPath, [syncScript, "--check"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);

  for (const skillId of communitySkills) {
    const generatedPath = path.join(
      repoRoot,
      skillId,
      "references",
      "generated",
      "user-result.md",
    );
    const generated = fs.readFileSync(generatedPath, "utf8");
    assert.match(generated, /source-sha256: [a-f0-9]{64}/);
    assert.match(generated, /<!-- rainskills-user-result:start -->/);
    assert.match(generated, /默认使用清晰、适度详细的中文/);
    assert.match(generated, /明确要求结构化/);
    assert.match(generated, /不得展示.*YAML.*JSON/);
    assert.match(generated, /不得猜测/);

    const discoverable = [
      path.join(repoRoot, skillId, "SKILL.md"),
      path.join(repoRoot, skillId, "references", "output-contract.md"),
    ].filter(fs.existsSync).some((file) => fs.readFileSync(file, "utf8").includes(
      "generated/user-result.md",
    ));
    assert(discoverable, `${skillId} must discover its generated user-result policy`);
  }
});

test("editable Skill sources contain no duplicated user-result marker block", () => {
  for (const skillId of communitySkills) {
    for (const file of markdownFiles(path.join(repoRoot, skillId))) {
      const relative = path.relative(path.join(repoRoot, skillId), file).split(path.sep).join("/");
      if (relative === "references/generated/user-result.md") continue;
      assert.doesNotMatch(
        fs.readFileSync(file, "utf8"),
        /<!-- rainskills-user-result:start -->/,
        `${skillId}/${relative}`,
      );
    }
  }
});
