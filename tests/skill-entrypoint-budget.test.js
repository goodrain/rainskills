"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");

function assertEntrypoint(skillId, budget) {
  const skillRoot = path.join(root, skillId);
  const entrypoint = fs.readFileSync(path.join(skillRoot, "SKILL.md"), "utf8");
  assert(Buffer.byteLength(entrypoint, "utf8") <= budget, `${skillId} entrypoint exceeds ${budget} bytes`);
  for (const heading of [
    "Purpose and ownership",
    "Fast path",
    "Conditional reading table",
    "Workflow",
    "Hard stops",
    "Safety invariants",
    "Output selection",
    "Anti-patterns",
  ]) assert.match(entrypoint, new RegExp(`^## ${heading}$`, "m"), `${skillId}: ${heading}`);
  for (const row of entrypoint.split("\n").filter((line) => line.startsWith("|"))) {
    const links = row.match(/\[[^\]]+\]\([^)]+\)/g) || [];
    assert(links.length <= 2, `${skillId} conditional row loads more than two references: ${row}`);
  }
  for (const match of entrypoint.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
    if (/^(?:https?:|#)/.test(match[1])) continue;
    assert(fs.existsSync(path.resolve(skillRoot, match[1])), `${skillId}: missing ${match[1]}`);
  }
}

function markdownFiles(directory) {
  if (!fs.existsSync(directory)) return [];
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...markdownFiles(absolute));
    else if (entry.name.endsWith(".md")) files.push(absolute);
  }
  return files;
}

function assertReferenceBudgets(skillId) {
  for (const directory of ["references", "modules"]) {
    for (const absolute of markdownFiles(path.join(root, skillId, directory))) {
      assert(
        fs.statSync(absolute).size <= 16 * 1024,
        `${path.relative(root, absolute)} exceeds the 16 KiB reference hard limit`,
      );
    }
  }
}

test("project init entrypoint is a bounded conditional router", () => {
  assertEntrypoint("rainbond-project-init", 14 * 1024);
  assertReferenceBudgets("rainbond-project-init");
});

test("bootstrap entrypoint is a bounded conditional router", () => {
  assertEntrypoint("rainbond-fullstack-bootstrap", 14 * 1024);
  assertReferenceBudgets("rainbond-fullstack-bootstrap");
});

test("troubleshooter entrypoint is a bounded conditional router", () => {
  assertEntrypoint("rainbond-fullstack-troubleshooter", 16 * 1024);
  assertReferenceBudgets("rainbond-fullstack-troubleshooter");
});

test("delivery verifier entrypoint is a bounded conditional router", () => {
  assertEntrypoint("rainbond-delivery-verifier", 12 * 1024);
  assertReferenceBudgets("rainbond-delivery-verifier");
});

test("env sync entrypoint is a bounded conditional router", () => {
  assertEntrypoint("rainbond-env-sync", 12 * 1024);
  assertReferenceBudgets("rainbond-env-sync");
});

test("template installer entrypoint is a bounded conditional router", () => {
  assertEntrypoint("rainbond-template-installer", 12 * 1024);
  assertReferenceBudgets("rainbond-template-installer");
});

test("app version entrypoint is a bounded conditional router", () => {
  assertEntrypoint("rainbond-app-version-assistant", 12 * 1024);
  assertReferenceBudgets("rainbond-app-version-assistant");
});

test("platform query entrypoint is a bounded conditional router", () => {
  assertEntrypoint("rainbond-platform-query", 4 * 1024);
  assertReferenceBudgets("rainbond-platform-query");
});
