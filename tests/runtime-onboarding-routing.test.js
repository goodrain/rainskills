"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { parseRuntimeConnectArgs } = require("../bin/rainskills.js");
const { parseCommand } = require("../bin/rainskills-tools.js");

const root = path.resolve(__dirname, "..");
const packageVersion = require("../package.json").version;
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

function gate(skillId) {
  const source = fs.readFileSync(path.join(root, skillId, "SKILL.md"), "utf8");
  const match = source.match(
    /<!-- rainskills-runtime-gate:start -->([\s\S]*?)<!-- rainskills-runtime-gate:end -->/
  );
  assert(match, `${skillId} must contain one runtime gate`);
  return match[1];
}

function contract(skillId) {
  const match = gate(skillId).match(/```json\n([\s\S]*?)\n```/);
  assert(match, `${skillId} must contain one JSON contract`);
  return JSON.parse(match[1]);
}

test("every business Skill uses the single-runtime CLI contract", () => {
  for (const skillId of skillIds) {
    const current = contract(skillId);
    assert.equal(current.schema, "rainskills.single-runtime-contract.v1");
    assert.equal(current.package_version, `rainskills@${packageVersion}`);
    assert.deepEqual(parseRuntimeConnectArgs(
      current.runtime_connect.saas.slice(2).map((item) => item === "<target>" ? "codex" : item)
    ), {
      targetClient: "codex",
      environmentChoice: "saas",
      rainbondUrl: "",
      allowInsecureHttp: false,
      privateLocation: undefined,
    });
    for (const command of ["context_resolve", "read", "call", "call_confirm"]) {
      const argv = current.input_commands[command].argv.slice(2)
        .map((item) => item === "<tool>" ? "rainbond_query_apps" : item)
        .map((item) => item === "<confirmation-id>"
          ? "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
          : item);
      const parsed = parseCommand(argv);
      assert.equal(parsed.skillId, skillId);
      assert.equal(Object.hasOwn(parsed, "operationId"), false);
    }
  }
});

test("runtime gates contain no multi-environment or runtime-operation protocol", () => {
  const forbidden = [
    /environment list/,
    /operation begin/,
    /operation complete/,
    /--environment-id/,
    /--operation-id/,
    /rainskills_operation_id/,
    /intent resume/,
  ];
  for (const skillId of skillIds) {
    const current = gate(skillId);
    for (const pattern of forbidden) assert.doesNotMatch(current, pattern);
    assert.match(current, /本机只允许连接一个 Rainbond 运行环境/);
    assert.match(current, /写调用不得自动重放/);
    assert.match(current, /403 直接停止/);
  }
});

test("root Skill manages one replaceable runtime and never configures client MCP", () => {
  const source = fs.readFileSync(path.join(root, "SKILL.md"), "utf8");
  assert.match(source, /只保存一个全局运行环境/);
  assert.match(source, /runtime reconnect <target>/);
  assert.match(source, /不得配置客户端 MCP/);
  assert.doesNotMatch(source, /environment set-default|environment rename|environment remove/);
});
