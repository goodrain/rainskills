const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const repoRoot = path.resolve(__dirname, "..");
const policyRelative = path.join(
  "rainbond-app-assistant",
  "references",
  "transport-resolution.md"
);
const businessSkills = [
  "rainbond-app-assistant",
  "rainbond-app-version-assistant",
  "rainbond-delivery-verifier",
  "rainbond-env-sync",
  "rainbond-fullstack-bootstrap",
  "rainbond-fullstack-troubleshooter",
  "rainbond-project-init",
  "rainbond-template-installer",
];
const allSkills = fs
  .readdirSync(repoRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && entry.name.startsWith("rainbond-"))
  .map((entry) => entry.name)
  .sort();

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
}

function assertReferencesResolve(installationRoot) {
  for (const skillName of businessSkills) {
    const skillPath = path.join(installationRoot, skillName, "SKILL.md");
    const skill = fs.readFileSync(skillPath, "utf8");
    const expectedReference = skillName === "rainbond-app-assistant"
      ? "references/transport-resolution.md"
      : "../rainbond-app-assistant/references/transport-resolution.md";
    assert.match(skill, new RegExp(expectedReference.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.equal(
      fs.existsSync(path.resolve(path.dirname(skillPath), expectedReference)),
      true,
      `${skillName} transport reference does not resolve`
    );
  }
}

test("one compact shared policy defines the deterministic CLI state machine", () => {
  const policy = read(policyRelative);
  assert(policy.split(/\r?\n/).length <= 150, "transport policy must stay within 150 lines");
  for (const marker of [
    "run CLI status exactly once",
    "lock transport until workflow ends",
    "list --prefix <prefix>",
    "describe <tool>",
    "只返回能力名称",
    "read <tool> --input -",
    "call <tool> --input -",
    "outcome_unknown",
    "/console/mcp/rainskills/api/query",
  ]) {
    assert.match(policy, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.equal(
    (policy.match(/\/console\/mcp\/query/g) || []).length,
    0,
    "the CLI policy must not mention the generic endpoint"
  );
  assert.doesNotMatch(policy, /MCP 失败就改走 API|优先 MCP，失败自动降级/);
});

test("common read intents use fixed CLI contracts without per-call discovery", () => {
  const policy = read(policyRelative);
  for (const marker of [
    "rainbond_query_enterprises",
    "rainbond_query_teams",
    "rainbond_query_apps",
    "rainbond_get_team_apps",
    "rainbond_query_regions",
    "不执行 `list` 或 `describe`",
    "不得因为用户只要求企业信息而额外查询团队或集群",
    "不得使用 `2>&1`、`grep` 或 `head` 处理 CLI 的 JSON 输出",
    "邮箱、内部 ID、连接地址与配置仅在用户明确需要时展示",
  ]) {
    assert.match(policy, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.match(policy, /只读能力.*`read <tool> --input -`/);
  assert.match(policy, /写入或破坏性能力.*`call <tool> --input -`/);
});

test("exactly the eight business skills load the shared policy", () => {
  const referringSkills = [];
  for (const skillName of allSkills) {
    const skill = read(path.join(skillName, "SKILL.md"));
    if (skill.includes("transport-resolution.md")) referringSkills.push(skillName);
  }
  if (read("SKILL.md").includes("transport-resolution.md")) referringSkills.push("<root>");
  assert.deepEqual(referringSkills.sort(), [...businessSkills].sort());
  assertReferencesResolve(repoRoot);
  assert.doesNotMatch(read("SKILL.md"), /transport-resolution\.md/);
  assert.doesNotMatch(
    read(path.join("rainbond-platform-installer", "SKILL.md")),
    /transport-resolution\.md/
  );
});

test("top-level preflight initializes CLI once and lower skills inherit", () => {
  const top = read(path.join("rainbond-app-assistant", "SKILL.md"));
  const preflightStart = top.indexOf("## Rainbond Transport Preflight");
  const nextHeading = top.indexOf("\n  ## ", preflightStart + 3);
  assert.notEqual(preflightStart, -1);
  const preflight = top.slice(preflightStart, nextHeading === -1 ? undefined : nextHeading);
  assert.match(preflight, /不检测当前会话的 `rainbond_\*` Tool/);
  assert.match(preflight, /status/);
  assert.match(preflight, /工作流结束前保持不变/);
  assert.match(preflight, /CLI status 成功时选择 `cli`/);
  assert.doesNotMatch(preflight, /rainbond_query_enterprises/);
  assert.doesNotMatch(top, /Step 0 — Probe MCP availability/);

  for (const skillName of businessSkills.slice(1)) {
    const skill = read(path.join(skillName, "SKILL.md"));
    assert.match(skill, /## Rainbond (CLI|传输)/);
    assert.match(skill, /上游已初始化.*RainSkills CLI.*直接复用/);
    assert.match(skill, /不得触发替代调用通道|不得触发任何客户端 MCP 回退/);
  }
});

test("both phase-loading gates use relative reads before writes", () => {
  const top = read(path.join("rainbond-app-assistant", "SKILL.md"));
  const hardRuleStart = top.indexOf("31.");
  const hardRuleEnd = top.indexOf("32.", hardRuleStart);
  const hardRule = top.slice(hardRuleStart, hardRuleEnd);
  const deepDiveStart = top.indexOf("## 深入子流程");
  const deepDiveEnd = top.indexOf("## 停止条件", deepDiveStart);
  const deepDive = top.slice(deepDiveStart, deepDiveEnd);

  for (const section of [hardRule, deepDive]) {
    assert.match(section, /进入.*阶段.*必须.*加载.*SKILL|写操作.*之前.*加载.*SKILL|进入每个专项阶段.*必须读取.*SKILL/s);
    assert.match(section, /相对路径读取|已安装相对路径/);
    assert.match(section, /每个阶段.*一次|同一个 skill.*一次/s);
    assert.match(section, /未加载.*禁止.*写|没加载.*不允许.*写|未读取时禁止执行该阶段写操作/s);
  }

  for (const skillName of businessSkills.slice(1)) {
    assert.match(top, new RegExp(`\.\./${skillName}/SKILL\\.md`));
  }
});

test("business skills contain no operational MCP-only source or stop rules", () => {
  const forbidden = [
    /MCP 不可用，无法完成 online verification/,
    /runtime truth from MCP only/,
    /Rainbond MCP: the only valid source/,
    /Query Rainbond MCP/,
    /trust MCP and report/,
    /executed through MCP/,
    /confirmed through MCP/,
    /if MCP is unavailable/,
    /MCP runtime facts later conflict/,
    /MCP data first/,
    /通过 MCP 查找或创建/,
    /任何 MCP 写工具/,
    /下一个 MCP 写调用/,
    /就必须.*select_skill/s,
  ];
  for (const skillName of businessSkills) {
    const skill = read(path.join(skillName, "SKILL.md"));
    for (const pattern of forbidden) {
      assert.doesNotMatch(skill, pattern, `${skillName} retains ${pattern}`);
    }
  }
});

test("project-init schema YAML parses and edited list items retain peer indentation", () => {
  const projectInit = read(path.join("rainbond-project-init", "SKILL.md"));
  const schemaMatch = projectInit.match(/Proposed schema:\s*```yaml\n([\s\S]*?)\n```/);
  assert(schemaMatch, "ProjectInitResult proposed schema block is missing");
  const parsed = spawnSync(
    "python3",
    ["-c", "import sys, yaml; data=yaml.safe_load(sys.stdin.read()); assert 'ProjectInitResult' in data"],
    { input: schemaMatch[1], encoding: "utf8" }
  );
  assert.equal(parsed.status, 0, parsed.stderr || parsed.stdout);

  for (const line of [
    "  next_action: stop | bootstrap | reconnect_transport | ask_identity | ask_manifest_review",
    "  - use `linked` only when current-run platform verification confirmed the app/binding",
    "  - use `pending_verification` when local binding or generated state exists but current-run platform verification did not complete",
    "  - use `reconnect_transport`, `ask_identity`, or `ask_manifest_review` only when that specific external action is the true gating step",
    "- if the locked Rainbond transport was unavailable, explicitly say initialization is pending online verification",
    "  - `reconnect Rainbond transport and verify app existence`",
    "- when the locked Rainbond transport is unavailable or identity is blocked, still use the same required section headings and final `ProjectInitResult`; only field values change",
    "- declaring initialization complete when the locked Rainbond transport is unavailable and app existence was not verified online",
    "- if `.rainbond/local.json` was written without platform verification, mark it `pending_verification`",
    "- in that case, the correct next step is to reconnect the locked Rainbond transport and verify app existence before claiming full initialization",
  ]) {
    assert(projectInit.split(/\r?\n/).includes(line), `wrong indentation: ${line}`);
  }
});

test("official POSIX installs preserve the full-suite reference layout on install, update, force, and custom dest", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rainskills-transport-posix-"));
  const destination = path.join(tempRoot, "custom-skills");
  for (const extraArgs of [[], [], ["--force"]]) {
    const result = spawnSync(
      "bash",
      ["install.sh", "--dest", destination, ...extraArgs],
      { cwd: repoRoot, encoding: "utf8", env: { ...process.env, HOME: path.join(tempRoot, "home") } }
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assertReferencesResolve(destination);
  }
});

test("official Windows copy preserves the full-suite reference layout", () => {
  const { copySkills, discoverSkills } = require(path.join(
    repoRoot,
    "rainbond-platform-installer",
    "scripts",
    "windows-onboarding.js"
  ));
  const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rainskills-transport-windows-")));
  const destination = path.join(tempRoot, "skills");
  const skills = discoverSkills(repoRoot);
  copySkills({ skills, destinations: [destination] });
  assertReferencesResolve(destination);
  copySkills({ skills, destinations: [destination] });
  assertReferencesResolve(destination);
  copySkills({ skills, destinations: [destination], force: true });
  assertReferencesResolve(destination);
});

test("transport adaptation does not replace established business sequences", () => {
  const expectedMarkers = {
    "rainbond-app-assistant": [
      "不能静默改成 `package` 或 `image`",
      "写操作超时或结果未知时禁止重放",
    ],
    "rainbond-app-version-assistant": [
      "rainbond_create_app_version_snapshot",
      "rainbond_complete_app_share",
      "rainbond_rollback_app_version_snapshot",
      "never call `rainbond_complete_app_share` before all events are successful",
    ],
    "rainbond-delivery-verifier": [
      "This skill must not:",
      "perform destructive actions",
    ],
    "rainbond-env-sync": [
      "This skill writes only:",
      "skip all sensitive values",
    ],
    "rainbond-fullstack-bootstrap": [
      "rainbond_create_component_from_source",
      "rainbond_manage_component_dependency",
      "rainbond_operate_app",
      "Do not continue with fallback execution modes",
    ],
    "rainbond-fullstack-troubleshooter": [
      "component events",
      "build logs",
      "runtime logs",
      "Never print secret values",
    ],
    "rainbond-project-init": [
      "This skill must not:",
      "guess destructive actions",
    ],
    "rainbond-template-installer": [
      "rainbond_query_app_model_versions",
      "rainbond_install_app_model",
      "never silently install into an existing app",
    ],
  };
  for (const [skillName, markers] of Object.entries(expectedMarkers)) {
    const skill = read(path.join(skillName, "SKILL.md"));
    for (const marker of markers) assert.match(skill, new RegExp(marker));
  }
});

test("no transport reference generation or synchronization script is introduced", () => {
  const scriptFiles = [];
  for (const directory of ["scripts", "tests"]) {
    for (const name of fs.readdirSync(path.join(repoRoot, directory))) {
      if (/transport.*(?:sync|generat)|(?:sync|generat).*transport/i.test(name)) {
        scriptFiles.push(path.join(directory, name));
      }
    }
  }
  assert.deepEqual(scriptFiles, []);
});
