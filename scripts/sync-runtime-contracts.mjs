#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageVersion = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
const skillIds = [
  "rainbond-app-assistant",
  "rainbond-app-version-assistant",
  "rainbond-delivery-verifier",
  "rainbond-env-sync",
  "rainbond-fullstack-bootstrap",
  "rainbond-fullstack-troubleshooter",
  "rainbond-platform-query",
  "rainbond-opensource-app-deploy",
  "rainbond-project-init",
  "rainbond-template-installer",
];
const forbidden = [
  "environment list",
  "operation begin",
  "operation complete",
  "--environment-id",
  "--operation-id",
  "rainskills_operation_id",
  "intent resume",
];

function runtimeGate(source, skillId) {
  const match = source.match(
    /<!-- rainskills-runtime-gate:start -->([\s\S]*?)<!-- rainskills-runtime-gate:end -->/
  );
  if (!match) throw new Error(`${skillId} 缺少 runtime gate`);
  return match[1];
}

function runtimeContract(gate, skillId) {
  const match = gate.match(/```json\n([\s\S]*?)\n```/);
  if (!match) throw new Error(`${skillId} 缺少单运行环境 JSON contract`);
  const contract = JSON.parse(match[1]);
  if (contract.schema !== "rainskills.single-runtime-contract.v1") {
    throw new Error(`${skillId} runtime contract schema 无效`);
  }
  if (contract.package_version !== `rainskills@${packageVersion}`) {
    throw new Error(`${skillId} runtime contract 版本不同步`);
  }
  for (const name of ["context_resolve", "read", "call", "call_confirm"]) {
    const argv = contract.input_commands?.[name]?.argv;
    if (!Array.isArray(argv) || !argv.includes("--skill-id") || !argv.includes(skillId)) {
      throw new Error(`${skillId} ${name} CLI contract 无效`);
    }
  }
  return contract;
}

for (const skillId of skillIds) {
  const source = fs.readFileSync(path.join(root, skillId, "SKILL.md"), "utf8");
  const gate = runtimeGate(source, skillId);
  for (const value of forbidden) {
    if (gate.includes(value)) throw new Error(`${skillId} 仍包含已删除契约：${value}`);
  }
  runtimeContract(gate, skillId);
}

if (!process.argv.slice(2).every((argument) => argument === "--check")) {
  throw new Error("Usage: node scripts/sync-runtime-contracts.mjs [--check]");
}
