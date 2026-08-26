#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const scriptRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { INTENT_DEFINITIONS, INTENT_EXAMPLES, validateIntent } = require(
  path.join(scriptRoot, "rainbond-platform-installer", "scripts", "runtime-intents.js")
);

function parseArgs(argv) {
  let check = false;
  for (const argument of argv) {
    if (argument === "--check") check = true;
    else throw new Error("Usage: node scripts/sync-runtime-contracts.mjs [--check]");
  }
  return { check };
}

function inputCommands(skillId) {
  const launcher = ["node", "<home>/.rainbond/bin/rainskills-tools.js"];
  const operation = ["--operation-id", "<uuid>", "--skill-id", skillId];
  const commands = {
    "context-resolve": {
      argv: [...launcher, "context", "resolve", "--input", "-", ...operation],
      stdin: { required: ["enterprise", "workspace"] },
    },
    "context-select": {
      argv: [...launcher, "context", "select", "--input", "-", ...operation],
      stdin: { selection_id: "<selection-id>", option_id: "<option-id>" },
    },
    read: {
      argv: [...launcher, "read", "<tool>", "--input", "-", ...operation],
      stdin_schema_source: "tool-catalog",
    },
    call: {
      argv: [...launcher, "call", "<tool>", "--input", "-", ...operation],
      stdin_schema_source: "tool-catalog",
    },
  };
  if (skillId === "rainbond-fullstack-bootstrap") {
    commands["package-upload"] = {
      argv: [
        ...launcher,
        "package-upload", "--archive", "<archive-path>", "--input", "-",
        ...operation,
      ],
      stdin_schema_source: "upload-request",
    };
  }
  return commands;
}

function queryInputCommands(localArgv) {
  return {
    "query-default": {
      argv: localArgv["platform-query-default"],
      stdin_schema_source: "tool-catalog",
    },
    "query-selected": {
      argv: localArgv["platform-query-selected"],
      stdin_schema_source: "tool-catalog",
    },
  };
}

function operationLocalArgv(current) {
  const launcher = [
    "node",
    "<installed-skills-root>/rainbond-platform-installer/scripts/local-runtime.js",
  ];
  return {
    "environment-list": current["environment-list"],
    "operation-begin-default": [
      ...launcher,
      "operation", "begin",
      "--operation-id", "<uuid>",
      "--intent-json", "<intent-json>",
    ],
    "operation-begin-selected": [
      ...launcher,
      "operation", "begin",
      "--operation-id", "<uuid>",
      "--environment-id", "<environment-id>",
      "--intent-json", "<intent-json>",
    ],
    "operation-complete": current["operation-complete"],
    "runtime-message": current["runtime-message"],
  };
}

function intentContracts(skillId) {
  const contracts = {};
  for (const [type, definition] of Object.entries(INTENT_DEFINITIONS)) {
    if (definition.skillId !== skillId) continue;
    const example = validateIntent(INTENT_EXAMPLES[type]);
    contracts[type] = {
      type,
      required: ["type", ...definition.required],
      optional: definition.optional,
      enums: definition.enums,
      example,
    };
  }
  return contracts;
}

function expectedContract(skillId, contract) {
  const isQuery = skillId === "rainbond-platform-query";
  const localArgv = isQuery ? contract.local_argv : operationLocalArgv(contract.local_argv);
  const result = {
    ...contract,
    local_argv: localArgv,
    input_commands: isQuery ? queryInputCommands(localArgv) : inputCommands(skillId),
    intents: intentContracts(skillId),
  };
  delete result.minimal_intents;
  return result;
}

function renderJson(value, depth = 0) {
  if (Array.isArray(value)) {
    if (value.every((item) => item === null || ["string", "number", "boolean"].includes(typeof item))) {
      return `[${value.map((item) => JSON.stringify(item)).join(", ")}]`;
    }
    const indent = "  ".repeat(depth + 1);
    return `[\n${indent}${value.map((item) => renderJson(item, depth + 1)).join(`,\n${indent}`)}\n${"  ".repeat(depth)}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value);
    if (entries.length === 0) return "{}";
    const indent = "  ".repeat(depth + 1);
    return `{\n${indent}${entries.map(([key, item]) => (
      `${JSON.stringify(key)}: ${renderJson(item, depth + 1)}`
    )).join(`,\n${indent}`)}\n${"  ".repeat(depth)}}`;
  }
  return JSON.stringify(value);
}

function writeAtomically(filePath, content) {
  const temporaryPath = `${filePath}.tmp-${process.pid}`;
  const mode = fs.statSync(filePath).mode;
  try {
    fs.writeFileSync(temporaryPath, content, { encoding: "utf8", mode, flag: "wx" });
    fs.renameSync(temporaryPath, filePath);
  } catch (error) {
    try { fs.rmSync(temporaryPath, { force: true }); } catch { /* preserve the sync error */ }
    throw error;
  }
}

function updateContract(relativePath, check) {
  const skillId = relativePath.split("/", 1)[0];
  const filePath = path.join(scriptRoot, relativePath);
  const current = fs.readFileSync(filePath, "utf8");
  const pattern = /^([ \t]*)<!-- rainskills-runtime-contract:start -->\r?\n\1```json\r?\n([\s\S]*?)\r?\n\1```\r?\n\1<!-- rainskills-runtime-contract:end -->/m;
  const match = current.match(pattern);
  if (!match) throw new Error(`${relativePath} 缺少 runtime contract 区块`);
  const indent = match[1];
  const contract = JSON.parse(match[2].replace(new RegExp(`^${indent}`, "gm"), ""));
  const renderedJson = renderJson(expectedContract(skillId, contract))
    .split("\n")
    .map((line) => `${indent}${line}`)
    .join("\n");
  const replacement = [
    `${indent}<!-- rainskills-runtime-contract:start -->`,
    `${indent}\`\`\`json`,
    renderedJson,
    `${indent}\`\`\``,
    `${indent}<!-- rainskills-runtime-contract:end -->`,
  ].join("\n");
  const expected = current.replace(pattern, replacement);
  if (expected === current) return false;
  if (check) throw new Error(`${relativePath} runtime contract 不是最新状态`);
  writeAtomically(filePath, expected);
  return true;
}

function run() {
  const { check } = parseArgs(process.argv.slice(2));
  const skills = fs.readdirSync(scriptRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("rainbond-"))
    .map((entry) => `${entry.name}/SKILL.md`)
    .filter((relativePath) => fs.existsSync(path.join(scriptRoot, relativePath)))
    .filter((relativePath) => fs.readFileSync(path.join(scriptRoot, relativePath), "utf8")
      .includes("<!-- rainskills-runtime-contract:start -->"));
  for (const relativePath of skills.sort()) updateContract(relativePath, check);
}

try {
  run();
} catch (error) {
  console.error(`Runtime contract synchronization failed: ${error.message}`);
  process.exitCode = 1;
}
