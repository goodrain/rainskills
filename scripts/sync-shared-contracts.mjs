#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const customerSkills = Object.freeze([
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
]);
const handoffSkills = Object.freeze([
  "rainbond-app-assistant",
  "rainbond-project-init",
  "rainbond-fullstack-bootstrap",
  "rainbond-fullstack-troubleshooter",
  "rainbond-delivery-verifier",
  "rainbond-template-installer",
]);
const sharedContracts = Object.freeze([
  {
    id: "user-result policy",
    source: "user-result.md",
    generated: "user-result.md",
    start: "<!-- rainskills-user-result:start -->",
    end: "<!-- rainskills-user-result:end -->",
  },
]);

function parseArgs(argv) {
  let sourceRoot = scriptRoot;
  let check = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--check") {
      check = true;
      continue;
    }
    if (argument === "--source-root" && argv[index + 1]) {
      sourceRoot = path.resolve(argv[index + 1]);
      index += 1;
      continue;
    }
    throw new Error("Usage: node scripts/sync-shared-contracts.mjs [--source-root <path>] [--check]");
  }
  return { sourceRoot, check };
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function writeAtomically(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o755 });
  const temporary = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, content, { encoding: "utf8", mode: 0o644 });
  fs.renameSync(temporary, filePath);
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

function run({ sourceRoot, check }) {
  const stale = [];
  for (const contract of sharedContracts) {
    const canonicalPath = path.join(sourceRoot, "contracts", "shared", contract.source);
    const canonical = fs.readFileSync(canonicalPath, "utf8");
    if ((canonical.split(contract.start).length - 1) !== 1
      || (canonical.split(contract.end).length - 1) !== 1) {
      throw new Error(`canonical ${contract.id} markers are invalid`);
    }
    const digest = sha256(canonical);
    const expected = `<!-- generated-by: scripts/sync-shared-contracts.mjs -->\n<!-- source-sha256: ${digest} -->\n${canonical.trimEnd()}\n`;
    for (const skillId of customerSkills) {
      const skillRoot = path.join(sourceRoot, skillId);
      const generatedPath = path.join(skillRoot, "references", "generated", contract.generated);
      const current = fs.existsSync(generatedPath) ? fs.readFileSync(generatedPath, "utf8") : null;
      if (current !== expected) {
        stale.push(path.relative(sourceRoot, generatedPath));
        if (!check) writeAtomically(generatedPath, expected);
      }
      const editableFiles = markdownFiles(skillRoot).filter((file) => file !== generatedPath);
      for (const file of editableFiles) {
        if (fs.readFileSync(file, "utf8").includes(contract.start)) {
          throw new Error(`editable ${contract.id} remains in ${path.relative(sourceRoot, file)}`);
        }
      }
      if (!editableFiles.some((file) => fs.readFileSync(file, "utf8").includes(`generated/${contract.generated}`))) {
        throw new Error(`${skillId} does not discover its generated ${contract.id}`);
      }
    }
  }
  const handoffSchema = fs.readFileSync(
    path.join(sourceRoot, "contracts", "handoff-context.schema.yaml"),
    "utf8",
  );
  const handoffExpected = `# generated-by: scripts/sync-shared-contracts.mjs\n# source-sha256: ${sha256(handoffSchema)}\n${handoffSchema}`;
  for (const skillId of handoffSkills) {
    const generatedPath = path.join(
      sourceRoot,
      skillId,
      "schemas",
      "generated",
      "handoff-context.schema.yaml",
    );
    const current = fs.existsSync(generatedPath) ? fs.readFileSync(generatedPath, "utf8") : null;
    if (current !== handoffExpected) {
      stale.push(path.relative(sourceRoot, generatedPath));
      if (!check) writeAtomically(generatedPath, handoffExpected);
    }
    const entrypoint = fs.readFileSync(path.join(sourceRoot, skillId, "SKILL.md"), "utf8");
    if (!entrypoint.includes("schemas/generated/handoff-context.schema.yaml")) {
      throw new Error(`${skillId} does not discover its generated HandoffContext schema`);
    }
  }
  if (check && stale.length > 0) throw new Error(`generated shared contract is stale: ${stale.join(", ")}`);
}

try {
  run(parseArgs(process.argv.slice(2)));
} catch (error) {
  process.stderr.write(`Shared contract synchronization failed: ${error.message}\n`);
  process.exitCode = 1;
}
