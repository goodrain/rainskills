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
const forbiddenFullGuidance = [
  "刷新一次环境列表",
  "刷新环境列表",
  "全局默认环境",
  "复用已绑定的环境 ID",
  "不重复枚举环境",
];
const requiredAuthorizationGuidance = [
  "同一个命令会话",
  "后续业务步骤",
  "退出码为 0",
  "rainskills.runtime-connect-result.v1",
  "state=connected",
  "session_id",
  "write_stdin",
  "exit_code",
  "RAINSKILLS_AGENT_WAIT_REQUIRED:runtime-connect",
  "RAINSKILLS_AGENT_WAIT_COMPLETE:runtime-connect",
  "DeepSeek Harness=`dsh`",
  "WorkBuddy=`workbuddy`",
  "Hermes Agent=`hermes`",
  "background=true",
  "action=\"wait\"",
  "单引号 heredoc",
];

function runtimeGate(source, skillId) {
  const match = source.match(
    /<!-- rainskills-runtime-gate:start -->([\s\S]*?)<!-- rainskills-runtime-gate:end -->/
  );
  if (!match) throw new Error(`${skillId} 缺少 runtime gate`);
  return match[1];
}

function runtimeGateSource(skillId) {
  const referencePath = path.join(root, skillId, "references", "runtime-gate.md");
  const sourcePath = fs.existsSync(referencePath)
    ? referencePath
    : path.join(root, skillId, "SKILL.md");
  return fs.readFileSync(sourcePath, "utf8");
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
  const contextInput = contract.input_commands.context_resolve.stdin;
  if (JSON.stringify(contextInput) !== JSON.stringify({
    default: { required: ["enterprise", "workspace"] },
    with_hints: {
      required: ["enterprise", "workspace"],
      hints: { team_name: "<team-name>" },
    },
    with_selection: {
      required: ["enterprise", "workspace"],
      selection: { option_id: "<option-id>" },
    },
  })) {
    throw new Error(`${skillId} context resolve stdin contract 无效`);
  }
  return contract;
}

for (const skillId of skillIds) {
  const source = runtimeGateSource(skillId);
  const gate = runtimeGate(source, skillId);
  for (const value of forbidden) {
    if (gate.includes(value)) throw new Error(`${skillId} 仍包含已删除契约：${value}`);
  }
  for (const value of forbiddenFullGuidance) {
    if (source.includes(value)) throw new Error(`${skillId} 仍包含已删除的多运行环境说明：${value}`);
  }
  for (const value of requiredAuthorizationGuidance) {
    if (!gate.includes(value)) throw new Error(`${skillId} 缺少授权同步门禁：${value}`);
  }
  runtimeContract(gate, skillId);
}

if (!process.argv.slice(2).every((argument) => argument === "--check")) {
  throw new Error("Usage: node scripts/sync-runtime-contracts.mjs [--check]");
}
