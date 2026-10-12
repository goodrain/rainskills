#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

export const EFFECT_CASE_SCHEMA = "rainskills.effect-eval-cases.v1";
export const EXPECTED_SKILLS = Object.freeze([
  "rainskills",
  "rainbond-ai-assistant",
  "rainbond-app-assistant",
  "rainbond-app-version-assistant",
  "rainbond-delivery-verifier",
  "rainbond-env-sync",
  "rainbond-fullstack-bootstrap",
  "rainbond-fullstack-troubleshooter",
  "rainbond-opensource-app-deploy",
  "rainbond-platform-installer",
  "rainbond-platform-plugin-manager",
  "rainbond-platform-query",
  "rainbond-project-init",
  "rainbond-template-installer",
]);

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function requireString(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
}

function requireStringArray(value, label, { allowEmpty = false } = {}) {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
    throw new Error(`${label} must be ${allowEmpty ? "an" : "a non-empty"} array`);
  }
  for (const item of value) requireString(item, `${label} item`);
}

function skillExists(root, skillId) {
  return fs.existsSync(skillId === "rainskills"
    ? path.join(root, "SKILL.md")
    : path.join(root, skillId, "SKILL.md"));
}

function validateCase(root, entry, fileSkillId) {
  requireString(entry.id, "case.id");
  requireString(entry.skill_id, `${entry.id}.skill_id`);
  if (entry.skill_id !== fileSkillId) throw new Error(`${entry.id}: file skill_id mismatch`);
  if (!skillExists(root, entry.skill_id)) throw new Error(`${entry.id}: Skill does not exist`);
  requireString(entry.prompt, `${entry.id}.prompt`);
  if (!entry.fixture || typeof entry.fixture !== "object" || Array.isArray(entry.fixture)) {
    throw new Error(`${entry.id}.fixture must be an object`);
  }
  requireStringArray(entry.expected_behaviors, `${entry.id}.expected_behaviors`);
  requireStringArray(entry.forbidden_behaviors, `${entry.id}.forbidden_behaviors`);
  requireStringArray(entry.safety_assertions, `${entry.id}.safety_assertions`);
  const routing = entry.routing;
  if (!routing || typeof routing !== "object" || Array.isArray(routing)) {
    throw new Error(`${entry.id}.routing must be an object`);
  }
  requireString(routing.expected_initial_owner, `${entry.id}.routing.expected_initial_owner`);
  if (!skillExists(root, routing.expected_initial_owner)) {
    throw new Error(`${entry.id}: expected_initial_owner Skill does not exist`);
  }
  for (const name of [
    "forbidden_initial_owners", "allowed_handoffs", "forbidden_handoffs",
  ]) requireStringArray(routing[name], `${entry.id}.routing.${name}`, { allowEmpty: true });
  if (routing.forbidden_initial_owners.includes(routing.expected_initial_owner)) {
    throw new Error(`${entry.id}: expected owner is forbidden`);
  }
  const collisions = routing.allowed_handoffs.filter((value) => routing.forbidden_handoffs.includes(value));
  if (collisions.length) throw new Error(`${entry.id}: allowed/forbidden handoffs intersect: ${collisions.join(", ")}`);
  if (entry.prompt_sha256 !== sha256(entry.prompt)) throw new Error(`${entry.id}: prompt_sha256 mismatch`);
  if (entry.fixture_sha256 !== sha256(canonicalJson(entry.fixture))) {
    throw new Error(`${entry.id}: fixture_sha256 mismatch`);
  }
  const core = { ...entry };
  delete core.content_sha256;
  if (entry.content_sha256 !== sha256(canonicalJson(core))) {
    throw new Error(`${entry.id}: content_sha256 mismatch`);
  }
  return entry;
}

export function loadEffectCases({ root }) {
  const caseDirectory = path.join(root, "tests", "effect-evals", "cases");
  const files = fs.existsSync(caseDirectory)
    ? fs.readdirSync(caseDirectory).filter((name) => name.endsWith(".yaml")).sort()
    : [];
  const expectedFiles = EXPECTED_SKILLS.map((skillId) => `${skillId}.yaml`).sort();
  if (JSON.stringify(files) !== JSON.stringify(expectedFiles)) {
    throw new Error(`effect case files mismatch: expected ${expectedFiles.join(", ")}; got ${files.join(", ")}`);
  }
  const cases = [];
  for (const filename of files) {
    const fileSkillId = filename.slice(0, -".yaml".length);
    const document = YAML.parse(fs.readFileSync(path.join(caseDirectory, filename), "utf8"));
    if (document?.schema !== EFFECT_CASE_SCHEMA) throw new Error(`${filename}: invalid schema`);
    if (document?.skill_id !== fileSkillId) throw new Error(`${filename}: invalid skill_id`);
    if (!Array.isArray(document.cases) || document.cases.length !== 2) {
      throw new Error(`${filename}: expected exactly two cases`);
    }
    cases.push(...document.cases.map((entry) => validateCase(root, entry, fileSkillId)));
  }
  if (cases.length !== 28) throw new Error(`expected 28 effect cases, got ${cases.length}`);
  const ids = new Set();
  for (const entry of cases) {
    if (ids.has(entry.id)) throw new Error(`duplicate effect case id: ${entry.id}`);
    ids.add(entry.id);
  }
  return cases;
}

if (path.resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) {
  try {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const cases = loadEffectCases({ root });
    process.stdout.write(`validated ${cases.length} effect cases across ${EXPECTED_SKILLS.length} Skills\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
