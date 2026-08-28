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

function runtimeGateSource(skillId) {
  const referencePath = path.join(root, skillId, "references", "runtime-gate.md");
  const sourcePath = fs.existsSync(referencePath)
    ? referencePath
    : path.join(root, skillId, "SKILL.md");
  return fs.readFileSync(sourcePath, "utf8");
}

function gate(skillId) {
  const source = runtimeGateSource(skillId);
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
    assert.deepEqual(current.input_commands.context_resolve.stdin, {
      default: { required: ["enterprise", "workspace"] },
      with_hints: {
        required: ["enterprise", "workspace"],
        hints: { team_name: "<team-name>" },
      },
      with_selection: {
        required: ["enterprise", "workspace"],
        selection: { option_id: "<option-id>" },
      },
    });
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
    assert.match(current, /同一个命令会话/);
    assert.match(current, /禁止[^。\n]*后续业务步骤/);
    assert.match(current, /退出码为 0/);
    assert.match(current, /rainskills\.runtime-connect-result\.v1/);
    assert.match(current, /state[^。\n]*connected/);
    assert.match(current, /session_id/);
    assert.match(current, /write_stdin/);
    assert.match(current, /exit_code/);
    assert.match(current, /RAINSKILLS_AGENT_WAIT_REQUIRED:runtime-connect/);
    assert.match(current, /RAINSKILLS_AGENT_WAIT_COMPLETE:runtime-connect/);
    assert.match(current, /Hermes Agent=`hermes`/);
    assert.match(current, /terminal[^\n]*background=true/);
    assert.match(current, /process[^\n]*action="wait"/);
  }
});

test("business Skills do not restore removed runtime registries outside the generated gate", () => {
  const forbidden = [
    /刷新(?:一次)?环境列表/,
    /全局默认环境/,
    /复用已绑定的环境 ID/,
    /不重复枚举环境/,
  ];
  for (const skillId of skillIds) {
    const source = runtimeGateSource(skillId);
    for (const pattern of forbidden) assert.doesNotMatch(source, pattern);
  }
});

test("app assistant loads specialist guidance without legacy select-skill tools or operation state", () => {
  const source = fs.readFileSync(
    path.join(root, "rainbond-app-assistant", "references", "workflow-rules.md"),
    "utf8",
  );
  assert.doesNotMatch(source, /select_skill_/);
  assert.doesNotMatch(source, /绑定到本次 operation/);
  assert.doesNotMatch(source, /context resolve` 已保存/);
  assert.match(source, /完整读取[^。\n]*专项 Skill[^。\n]*SKILL\.md/);
  assert.match(source, /enterprise_id[^。\n]*team_id[^。\n]*team_name[^。\n]*region_name/);
  assert.match(source, /team_id[^。\n]*平台调用/);
  assert.match(source, /team_id[^。\n]*不得[^。\n]*(?:过程消息|最终报告)/);
});

test("progressive-loading stages use workspace context and live app-component facts", () => {
  for (const relativePath of [
    path.join("rainbond-app-assistant", "SKILL.md"),
    path.join("rainbond-opensource-app-deploy", "SKILL.md"),
  ]) {
    const source = fs.readFileSync(path.join(root, relativePath), "utf8");
    assert.doesNotMatch(source, /operation\/context/);
    assert.match(source, /workspace context/);
    assert.match(source, /app\/component/);
  }
});

test("root Skill manages one replaceable runtime and never configures client MCP", () => {
  const source = fs.readFileSync(path.join(root, "SKILL.md"), "utf8");
  assert.match(source, /只保存一个全局运行环境/);
  assert.match(source, /runtime reconnect <target>/);
  assert.match(source, /不得配置客户端 MCP/);
  assert.match(source, /同一个命令会话/);
  assert.match(source, /禁止[^。\n]*后续业务步骤/);
  assert.match(source, /rainskills\.runtime-connect-result\.v1/);
  assert.match(source, /session_id/);
  assert.match(source, /write_stdin/);
  assert.match(source, /RAINSKILLS_AGENT_WAIT_REQUIRED:runtime-connect/);
  assert.match(source, /RAINSKILLS_AGENT_WAIT_COMPLETE:runtime-connect/);
  assert.match(source, /Hermes Agent=`hermes`/);
  assert.match(source, /process[^\n]*action="wait"/);
  assert.doesNotMatch(source, /environment set-default|environment rename|environment remove/);
});

test("new-application Skills expose the four runtime choices without a private-environment submenu", () => {
  const newApplicationSkillIds = [
    "rainbond-app-assistant",
    "rainbond-fullstack-bootstrap",
    "rainbond-opensource-app-deploy",
    "rainbond-project-init",
    "rainbond-template-installer",
  ];
  for (const skillId of newApplicationSkillIds) {
    const source = runtimeGateSource(skillId);
    assert.match(
      source,
      /1\) 云端环境（免费体验）\s+2\) 本机环境\s+3\) 独立服务器\s+4\) 已有 Rainbond/,
      `${skillId} must show the flattened environment menu`,
    );
    assert.doesNotMatch(source, /私有环境（去对接）/);
    assert.doesNotMatch(source, /"private-deployment-location"/);
  }
});

test("platform installer reuses the location selected by the flattened environment menu", () => {
  const source = fs.readFileSync(
    path.join(root, "rainbond-platform-installer", "SKILL.md"),
    "utf8",
  );
  assert.match(source, /next-action[^。\n]*--location[^。\n]*不得再次调用[^。\n]*private-deployment-location/);
  assert.match(source, /只有用户直接要求安装 Rainbond 平台[^。\n]*尚未选择部署位置/);
});
