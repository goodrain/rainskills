"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const YAML = require("yaml");

const {
  parseRuntimeConnectArgs,
  parseRuntimeFailureArgs,
  parseRuntimeReconnectArgs,
  runBuiltin,
} = require("../bin/rainskills.js");
const {
  INTENT_DEFINITIONS,
  isExistingAppIntent,
  validateIntent,
} = require("../rainbond-platform-installer/scripts/runtime-intents.js");
const { createRuntimeStateManager } = require("../rainbond-platform-installer/scripts/runtime-state.js");
const { createPortableSecureStateStore } = require("./helpers/portable-secure-state.js");

const repoRoot = path.resolve(__dirname, "..");
const packageVersion = require("../package.json").version;
const launcher = `["node", "<home>/.rainbond/lib/rainskills/bin/rainskills.js"]`;
const packageMarker = `rainskills@${packageVersion}`;
const runtimeLauncherLength = 2;
const localLauncher = [
  "node",
  "<installed-skills-root>/rainbond-platform-installer/scripts/local-runtime.js",
];
const runtimeSkills = [
  {
    file: "rainbond-app-assistant/SKILL.md",
    action: "完成应用识别、构建、部署和访问验证",
    route: "mixed",
    intentTypes: ["deploy", "create", "query", "troubleshoot", "modify"],
  },
  {
    file: "rainbond-app-version-assistant/SKILL.md",
    action: "继续版本中心操作",
    route: "existing",
    intentTypes: ["snapshot", "publish", "rollback"],
  },
  {
    file: "rainbond-delivery-verifier/SKILL.md",
    action: "验证应用交付状态和访问地址",
    route: "existing",
    intentTypes: ["delivery-verify"],
  },
  {
    file: "rainbond-env-sync/SKILL.md",
    action: "同步已有应用的环境配置",
    route: "existing",
    intentTypes: ["env-sync"],
  },
  {
    file: "rainbond-fullstack-bootstrap/SKILL.md",
    action: "创建应用和组件拓扑",
    route: "mixed",
    intentTypes: ["bootstrap"],
  },
  {
    file: "rainbond-fullstack-troubleshooter/SKILL.md",
    action: "排查已有应用的构建或运行问题",
    route: "existing",
    intentTypes: ["troubleshoot-phase"],
  },
  {
    file: "rainbond-platform-query/SKILL.md",
    action: "查询 Rainbond 平台信息",
    route: "existing",
    intentTypes: ["platform-query"],
  },
  {
    file: "rainbond-opensource-app-deploy/SKILL.md",
    action: "部署未收录到应用市场的开源应用",
    route: "new",
    intentTypes: ["opensource-deploy"],
  },
  {
    file: "rainbond-project-init/SKILL.md",
    action: "识别并接入当前项目",
    route: "new",
    intentTypes: ["project-init"],
  },
  {
    file: "rainbond-template-installer/SKILL.md",
    action: "从模板安装应用",
    route: "mixed",
    intentTypes: ["template-install"],
  },
];

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
}

function markedSection(text, name) {
  const start = `<!-- rainskills-${name}:start -->`;
  const end = `<!-- rainskills-${name}:end -->`;
  const startIndex = text.indexOf(start);
  const endIndex = text.indexOf(end);
  assert.notEqual(startIndex, -1, `missing ${start}`);
  assert.notEqual(endIndex, -1, `missing ${end}`);
  assert(startIndex < endIndex, `${name} markers are out of order`);
  return text.slice(startIndex, endIndex + end.length);
}

function headingSection(text, heading, nextHeading) {
  const start = text.indexOf(heading);
  assert.notEqual(start, -1, `missing ${heading}`);
  const end = nextHeading ? text.indexOf(nextHeading, start + heading.length) : text.length;
  assert.notEqual(end, -1, `missing ${nextHeading}`);
  return text.slice(start, end);
}

function materializeDocumentedArgv(text, marker) {
  const raw = [...text.matchAll(/`(\[[^\n`]+\])`/g)]
    .map((match) => match[1])
    .find((candidate) => candidate.includes(marker));
  assert(raw, `missing documented argv for ${marker}`);
  return JSON.parse(raw
    .replaceAll("<同一 onboarding-id>", "1d6754d6-6fb3-4bda-9a04-15c2d261d178")
    .replaceAll("<当前固定步骤>", "read"));
}

function runtimeContract(text) {
  const section = markedSection(text, "runtime-contract");
  const json = section.match(/```json\s*\n([\s\S]*?)\n\s*```/)?.[1];
  assert(json, "runtime contract must contain one JSON block");
  return JSON.parse(json);
}

function assertTwoLevelNewRuntimeChoice(routing) {
  const firstChoice = headingSection(routing, "#### 选择运行环境");

  assert.match(firstChoice, /请选择应用要运行的环境/);
  assert.match(firstChoice, /1\)\s*云端环境（免费体验）/);
  assert.match(firstChoice, /2\)\s*私有环境（去对接）/);
  assert.match(firstChoice, /请选择部署位置/);
  assert.match(firstChoice, /1、\s*部署到本机/);
  assert.match(firstChoice, /2、\s*部署到独立服务器/);
  assert.match(firstChoice, /3、\s*部署到已有 Rainbond/);
  assert.doesNotMatch(firstChoice, /连接已有环境.*帮我准备一个新环境/s);
  assert.match(firstChoice, /private-existing/);
  assert.match(firstChoice, /install-private/);
  assert.match(firstChoice, /--location.*local.*--location.*server/s);
}

const intentSamples = {
  deploy: [
    { type: "deploy", project_root: "/workspace/app", source_kind: "local" },
    { type: "deploy", project_root: "/workspace/app", source_kind: "local", service_id: "service" },
  ],
  create: [
    { type: "create", project_root: "/workspace/app", source_kind: "git", source_url: "https://example.com/app.git" },
    { type: "create", project_root: "/workspace/app", source_kind: "local", service_id: "service" },
  ],
  query: [{ type: "query", operation: "summary", app_id: "app" }],
  "platform-query": [{ type: "platform-query", resource: "components", enterprise_id: "enterprise", app_id: "app" }],
  troubleshoot: [{ type: "troubleshoot", operation: "build", app_id: "app" }],
  modify: [{ type: "modify", team_id: "team", app_id: "app", operation: "env" }],
  snapshot: [{ type: "snapshot", team_id: "team", app_id: "app", operation: "create" }],
  publish: [{ type: "publish", team_id: "team", app_id: "app", destination: "local-library" }],
  rollback: [{ type: "rollback", team_id: "team", app_id: "app", snapshot_id: "snapshot", operation: "preview" }],
  "delivery-verify": [{ type: "delivery-verify", operation: "full", app_id: "app" }],
  "env-sync": [{ type: "env-sync", project_root: "/workspace/app", environment: "production", app_id: "app" }],
  bootstrap: [
    { type: "bootstrap", project_root: "/workspace/app" },
    { type: "bootstrap", project_root: "/workspace/app", app_id: "app" },
    { type: "bootstrap", project_root: "/workspace/app", service_id: "service" },
  ],
  "troubleshoot-phase": [{ type: "troubleshoot-phase", operation: "build", app_id: "app" }],
  "project-init": [{ type: "project-init", project_root: "/workspace/app", source_kind: "local" }],
  "template-install": [
    { type: "template-install", template_id: "template", install_scope: "new-app" },
    { type: "template-install", template_id: "template", install_scope: "existing-app", app_id: "app" },
  ],
  "opensource-deploy": [{ type: "opensource-deploy", source_kind: "compose", source_url: "https://example.com/compose.yaml" }],
};

const bootstrapScopeCases = [
  [{ type: "bootstrap", project_root: "/workspace/app" }, "new"],
  [{ type: "bootstrap", project_root: "/workspace/app", team_id: "team" }, "new"],
  [{ type: "bootstrap", project_root: "/workspace/app", app_id: "app" }, "existing"],
  [{ type: "bootstrap", project_root: "/workspace/app", service_id: "service" }, "existing"],
  [{ type: "bootstrap", project_root: "/workspace/app", app_id: "app", service_id: "service" }, "existing"],
];

const approvedNewApplicationRuntimeCopy = `> 可以，我会帮你完成应用识别、构建、部署和访问验证。
  >
  > 不过目前还没有可用的应用运行环境。
  >
  > 你刚安装的 Rainskills 是负责“部署”的 AI 助手，它会分析项目并执行部署流程；Rainbond 负责为应用提供稳定运行环境。`;

function materializeConnectArgv(template, intent) {
  return template.map((value) => {
    if (value === "<target>") return "codex";
    if (value === "<rainbond-url>") return "https://console.example.com";
    if (value === "<private-location>") return "local";
    if (value === "<intent-json>") return JSON.stringify(intent);
    return value;
  });
}

async function connectAndResume(fullArgv, intent, skillId) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "rainskills-contract-"));
  const manager = createRuntimeStateManager({
    home,
    stateStore: createPortableSecureStateStore(home),
    liveProbe: async () => true,
  });
  const output = [];
  await runBuiltin(fullArgv.slice(runtimeLauncherLength), {
    runtimeStateManager: manager,
    originInspector: async (origin) => ({ origin }),
    connectionRunner: async () => ({ code: 0, signal: null, completesRuntimeState: false }),
    write: (value) => output.push(value),
  });
  const onboardingId = JSON.parse(output.pop()).onboarding_id;
  await runBuiltin(["intent", "resume", "--onboarding-id", onboardingId], {
    runtimeStateManager: manager,
    write: (value) => output.push(value),
  });
  const continuation = JSON.parse(output.pop());
  assert.equal(continuation.skill_id, skillId);
  assert.deepEqual(continuation.intent, intent);
}

test("bootstrap scope is explicit and existing targets cannot install a private platform", async () => {
  const skillId = "rainbond-fullstack-bootstrap";
  const skill = read("rainbond-fullstack-bootstrap/SKILL.md");
  const contract = runtimeContract(skill);

  assert.deepEqual(contract.route_conditions, {
    new: { app_id: "absent", service_id: "absent" },
    existing: { any_present: ["app_id", "service_id"] },
  });

  for (const [sample, expectedScope] of bootstrapScopeCases) {
    const intent = validateIntent(sample);
    assert.equal(isExistingAppIntent(intent), expectedScope === "existing", JSON.stringify(sample));
    assert(contract.routes[expectedScope], `bootstrap must document ${expectedScope} routes`);
    const connectedArgv = materializeConnectArgv(contract.connect_argv.saas, intent);
    await connectAndResume(connectedArgv, intent, skillId);

    const installArgv = materializeConnectArgv(contract.connect_argv["install-private"], intent);
    if (expectedScope === "existing") {
      assert.throws(() => parseRuntimeConnectArgs(installArgv.slice(runtimeLauncherLength)), /existing|已有|现有/i);
    } else {
      assert.equal(parseRuntimeConnectArgs(installArgv.slice(runtimeLauncherLength)).environmentChoice, "install-private");
    }
  }

  const routing = markedSection(skill, "runtime-routing");
  const existingBranch = headingSection(routing, "### 已有目标", "<!-- rainskills-runtime-routing:end -->");
  assert.match(existingBranch, /Rainbond Cloud/);
  assert.match(existingBranch, /已有私有 Rainbond/);
  assert.doesNotMatch(existingBranch, /install-private|安装私有 Rainbond/i);
});

test("generic deployment uses the approved copy and defers source intake until platform completion", async () => {
  const skill = read("rainbond-app-assistant/SKILL.md");
  const contract = runtimeContract(skill);
  const routing = markedSection(skill, "runtime-routing");
  const platformSkill = read("rainbond-platform-installer/SKILL.md");

  assert.deepEqual(contract.intents.deploy, {
    required: [],
    optional: ["project_root", "source_kind", "source_url", "service_id"],
    enums: { source_kind: ["local", "git", "image", "package"] },
  });
  assert.deepEqual(contract.intents.create, contract.intents.deploy);
  assert.match(routing, new RegExp(approvedNewApplicationRuntimeCopy.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(routing, /平台安装完成前.*不得.*应用来源|不得.*应用来源.*平台安装完成前/s);
  assert.match(routing, /项目路径.*Git 仓库.*镜像地址.*安装包路径/s);
  assert.match(platformSkill, /平台安装.*不得.*应用来源|不得.*应用来源.*平台安装/s);

  for (const type of ["deploy", "create"]) {
    const intent = { type };
    const argv = materializeConnectArgv(contract.connect_argv["install-private"], intent);
    assert.deepEqual(parseRuntimeConnectArgs(argv.slice(runtimeLauncherLength)).intent, intent);
  }
});

for (const skill of runtimeSkills) {
  test(`${skill.file} locks every request to one environment without project binding`, () => {
    const gate = markedSection(read(skill.file), "runtime-gate");

    assert.match(gate, /\["environment", "list", "--json"\]/);
    assert.match(gate, /\["operation", "begin"/);
    assert.match(gate, /不可变环境 ID|immutable.*environment/i);
    assert.match(gate, /rainskills_operation_id/);
    assert.match(gate, /未指定.*全局默认环境/s);
    assert.match(gate, /默认(?:环境)?不可用.*停止.*(?:禁止自动切换|不回退)/s);
    assert.match(gate, /同一项目.*多个环境|同一项目.*任意多个环境/s);
    assert.match(gate, /禁止.*项目级.*(?:默认环境|绑定)|不.*项目绑定/s);
    assert.match(gate, /明确.*团队.*团队/s);
    assert.match(gate, /明确.*运行环境.*环境/s);
    assert.match(gate, /裸名称.*同时匹配.*(?:确认|询问)/s);
  });

  test(`${skill.file} gates every business operation on the protected environment registry`, () => {
    const gate = markedSection(read(skill.file), "runtime-gate");

    assert.match(gate, /第一步.*Node\.js.*18/s);
    assert.match(gate, /Node\.js 前置检查通过后.*\["environment", "list", "--json"\]/s);
    assert.match(gate, /执行组件需要 Node\.js 18/);
    assert.match(gate, /缺失|低于/);
    assert.match(gate, /停止.*不.*选择运行环境.*不.*MCP.*不.*猜测/s);
    assert.match(gate, /用户或 agent 明确同意.*安装.*Node\.js.*原始 intent/s);
    assert.match(gate, /\["environment", "list", "--json"\]/);
    assert.match(gate, /\["operation", "begin"/);
    assert.match(gate, /固定.*onboarding-id.*原始 intent.*resume_step/s);
    assert.match(gate, /401.*--step/s);
    assert.match(gate, /401.*一次/s);
    assert.match(gate, /第二次 401.*停止|401.*第二次.*停止/s);
    assert.match(gate, /403.*不.*重新授权|403.*禁止.*重.*授权/s);
    assert.match(gate, new RegExp(launcher.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(gate, new RegExp(packageMarker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(gate, /版本.*package\.json.*一致/s);
    assert.match(gate, /argv 数组/);
    assert.match(gate, /禁止.*rainskills@latest|禁止.*latest/s);
    assert.match(gate, /禁止.*shell 字符串|禁止.*执行 shell 字符串/s);
    assert.match(gate, /"runtime", "connect"/);
    assert.match(gate, /codex.*claude.*pi.*all/s);
    assert.match(gate, /--intent-json/);
    assert.match(gate, /rainskills\.next-action\.v1.*校验.*argv/s);
    assert.match(gate, /\["intent", "resume", "--onboarding-id", "<同一 onboarding-id>"\]/);
    assert.match(gate, /\["runtime", "record-failure", "--onboarding-id", "<同一 onboarding-id>", "--step", "<当前固定步骤>", "--reason", "credential-expired"\]/);
    assert.match(gate, /\["runtime", "record-failure", "--onboarding-id", "<同一 onboarding-id>", "--step", "<当前固定步骤>", "--reason", "permission-denied"\]/);
    assert.match(gate, /\["runtime", "reconnect", "--onboarding-id", "<同一 onboarding-id>"\]/);
    assert.match(gate, /permission-denied.*停止.*不得.*reconnect/s);
    assert.deepEqual(parseRuntimeFailureArgs(materializeDocumentedArgv(gate, "credential-expired")), {
      operationId: "1d6754d6-6fb3-4bda-9a04-15c2d261d178",
      step: "read",
      reason: "credential-expired",
    });
    assert.deepEqual(parseRuntimeFailureArgs(materializeDocumentedArgv(gate, "permission-denied")), {
      operationId: "1d6754d6-6fb3-4bda-9a04-15c2d261d178",
      step: "read",
      reason: "permission-denied",
    });
    assert.deepEqual(parseRuntimeReconnectArgs(materializeDocumentedArgv(gate, "runtime\", \"reconnect")), {
      operationId: "1d6754d6-6fb3-4bda-9a04-15c2d261d178",
    });
  });

  test(`${skill.file} publishes a route-safe executable intent contract`, async () => {
    const skillId = skill.file.split("/", 1)[0];
    const contract = runtimeContract(read(skill.file));
    const expectedScopes = skill.route === "mixed" ? ["existing", "new"] : [skill.route];
    const expectedEnvironments = {
      existing: ["private-existing", "saas"],
      new: ["install-private", "private-existing", "saas"],
    };

    assert.equal(contract.schema, "rainskills.skill-runtime-contract.v1");
    assert.deepEqual(contract.launcher, [
      "node", "<home>/.rainbond/lib/rainskills/bin/rainskills.js",
    ]);
    assert.equal(contract.package_version, `rainskills@${packageVersion}`);
    assert.deepEqual(contract.local_launcher, localLauncher);
    assert.deepEqual(contract.local_argv, {
      "environment-list": [...localLauncher, "environment", "list", "--json"],
      "operation-begin": [
        ...localLauncher,
        "operation", "begin",
        "--operation-id", "<uuid>",
        "--intent-json", "<intent-json>",
      ],
      "operation-complete": [
        ...localLauncher,
        "operation", "complete",
        "--operation-id", "<uuid>",
      ],
      "runtime-message": [
        ...localLauncher,
        "runtime", "message",
        "--id", "<message-id>",
      ],
    });
    const gate = markedSection(read(skill.file), "runtime-gate");
    assert.match(gate, /本地 launcher.*不得访问 npm|本地 launcher.*不访问 npm/s);
    assert.match(gate, /(相邻|同级).*rainbond-platform-installer.*local-runtime\.js/s);
    assert.match(gate, /environment.*list.*本地 launcher/s);
    assert.match(gate, /operation.*begin.*本地 launcher/s);
    assert.match(gate, /operation.*complete.*本地 launcher/s);
    assert.match(gate, /runtime.*message.*本地 launcher/s);
    assert.match(gate, /\.rainbond\/bin\/rainskills-tools\.js/);
    assert.match(gate, /不得.*直接调用.*Rainbond MCP|禁止.*直接调用.*Rainbond MCP/s);
    assert.match(gate, /不得.*本地 Rainskills MCP|禁止.*本地 Rainskills MCP/s);
    assert.deepEqual(Object.keys(contract.routes).sort(), expectedScopes.sort());
    for (const scope of expectedScopes) {
      assert.deepEqual([...contract.routes[scope]].sort(), expectedEnvironments[scope]);
    }
    assert.deepEqual(Object.keys(contract.intents).sort(), [...skill.intentTypes].sort());
    for (const type of skill.intentTypes) {
      const definition = INTENT_DEFINITIONS[type];
      assert.deepEqual(contract.intents[type], {
        required: definition.required,
        optional: definition.optional,
        enums: definition.enums,
      });
      for (const sample of intentSamples[type]) {
        const intent = validateIntent(sample);
        const scope = isExistingAppIntent(intent) ? "existing" : "new";
        assert(contract.routes[scope], `${type} must document ${scope} routing`);
        for (const environment of contract.routes[scope]) {
          const fullArgv = materializeConnectArgv(contract.connect_argv[environment], intent);
          assert.deepEqual(fullArgv.slice(0, contract.launcher.length), contract.launcher);
          const parsed = parseRuntimeConnectArgs(fullArgv.slice(contract.launcher.length));
          assert.deepEqual(parsed.intent, intent);
          assert.equal(
            parsed.environmentChoice,
            environment === "private-existing" ? "private-existing" : environment
          );
          if (environment === "install-private") assert.equal(isExistingAppIntent(intent), false);
        }
        const connectedArgv = materializeConnectArgv(contract.connect_argv.saas, intent);
        await connectAndResume(connectedArgv, intent, skillId);
      }
    }
    if (skill.route === "existing") {
      assert.equal(contract.connect_argv["install-private"], undefined);
      assert.doesNotMatch(markedSection(read(skill.file), "runtime-gate"), /--install-private/);
    }
  });

  test(`${skill.file} uses action-matched runtime onboarding copy`, () => {
    const routing = markedSection(read(skill.file), "runtime-routing");

    assert.match(routing, new RegExp(skill.action));
    assert.match(routing, /目前还没有可用的应用运行环境/);
    if (skill.file === "rainbond-app-assistant/SKILL.md") {
      assert.match(routing, /Rainskills 是负责“部署”的 AI 助手/);
      assert.match(routing, /Rainbond 负责为应用提供稳定运行环境/);
    } else {
      assert.match(routing, /Rainskills 是 AI 部署助手/);
      assert.match(routing, /Rainbond 是一套应用运行和管理平台/);
      assert.match(routing, /不需要了解 Kubernetes/);
    }
    assert.match(routing, /runtime.*message.*private-console-origin/s);
    if (skill.route === "new" || skill.route === "mixed") {
      assertTwoLevelNewRuntimeChoice(routing);
    }
    if (skill.route === "existing") {
      assert.match(routing, /Rainbond Cloud/);
      assert.match(routing, /已有私有 Rainbond/);
      assert.match(routing, /承载目标应用/);
      assert.match(routing, /只让用户选择.*Rainbond Cloud.*已有私有 Rainbond/s);
      assert.match(routing, /不得.*安装私有 Rainbond|不得.*新平台/s);
    }
    if (skill.route === "mixed") {
      assert.match(routing, /先.*(?:确认|判定).*scope/s);
      assert(routing.search(/先.*(?:确认|判定).*scope/s) < routing.indexOf("#### 选择运行环境"));
      assert.match(
        routing,
        /已有应用.*(?:不得.*安装.*新|existing-app.*不得.*install-private|只(?:让用户选择|提供|连接).*Rainbond Cloud.*已有私有 Rainbond)/is
      );
    }
  });
}

test("root Rainskills installation stops after Skills success and capability guidance", () => {
  const skill = read("SKILL.md");
  const initialize = headingSection(skill, "## Initialize", "## Completion Message");
  const completion = headingSection(skill, "## Completion Message");
  const approved = `Rainskills 安装完成，下一条消息即可直接使用。

下一步可以直接说：

- 帮我部署当前项目
- 帮我部署一个 Git 仓库
- 帮我通过镜像或安装包部署应用
- 帮我安装一个应用模板
- 帮我分析当前项目应该如何部署

也可以直接告诉我你想部署什么应用。`;

  assert.match(skill, /Rainskills 安装完成/);
  assert.match(skill, /下一步可以直接说/);
  assert.match(skill, /帮我部署当前项目/);
  assert.match(skill, /帮我部署一个 Git 仓库/);
  assert.match(skill, /帮我通过镜像或安装包部署应用/);
  assert.match(skill, /帮我安装一个应用模板/);
  assert.match(skill, /也可以直接告诉我你想部署什么应用/);
  assert.match(skill, /RAINSKILLS_AGENT_SUMMARY_REQUIRED:include-next-actions/);
  assert.doesNotMatch(initialize, /选择.*运行环境|配置 MCP|浏览器.*授权|Rainbond Cloud.*私有/s);
  assert.equal(completion.match(/```text\n([\s\S]*?)\n```/)?.[1], approved);
  assert.doesNotMatch(completion, /reload|restart|重新加载|重启/i);
  assert.match(skill, /Skills-only.*不需要 Node\.js|仅安装 Skills.*不需要 Node\.js/s);
  assert.match(skill, /首次.*需要运行环境.*Node\.js 18/s);
  assert.doesNotMatch(completion, /Node\.js|Node 18/i);
});

test("root Rainskills manages a global default and adds later environments without project binding", () => {
  const skill = read("SKILL.md");
  const management = headingSection(skill, "## Manage Runtime Environments");

  assert.match(management, /environment list --json/);
  assert.match(management, /environment rename --environment-id <uuid> --name <name>/);
  assert.match(management, /environment set-default --environment-id <uuid>/);
  assert.match(management, /environment remove --environment-id <uuid>/);
  assert.match(management, /"type":"environment-add"/);
  assert.match(management, /第二个环境不得自动改成默认环境/);
  assert.match(management, /同一项目可以部署到任意多个环境和团队/);
  assert.match(management, /裸名称同时匹配两者时必须询问/);
  assert.match(management, /新增环境.*直接.*runtime connect/s);
  assert.match(management, /不得.*runtime status.*旧.*runtime.*状态/s);
  assert.match(management, /授权成功.*完整环境列表.*原样/s);
  assert.match(management, /不得.*迁移、备份.*runtime-connection/s);
  assert.match(management, /add-environment-location.*private-deployment-location/s);
  assert.match(management, /部署到本机.*部署到独立服务器.*部署到已有 Rainbond/s);
  assert.doesNotMatch(management, /own-environment-connection|连接已有环境.*准备新环境/s);
});

test("CDN Skills-only installation works without Node and keeps completion unchanged", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "rainskills-no-node-"));
  const staging = path.join(temporary, "package", "rainskills");
  fs.mkdirSync(staging, { recursive: true });
  fs.copyFileSync(path.join(repoRoot, "install.sh"), path.join(staging, "install.sh"));
  for (const name of fs.readdirSync(repoRoot).filter((entry) => entry.startsWith("rainbond-"))) {
    if (fs.statSync(path.join(repoRoot, name)).isDirectory()) {
      fs.cpSync(path.join(repoRoot, name), path.join(staging, name), { recursive: true });
    }
  }
  const tarball = path.join(temporary, "rainskills.tar.gz");
  const packed = spawnSync("/usr/bin/tar", ["-czf", tarball, "-C", path.join(temporary, "package"), "rainskills"]);
  assert.equal(packed.status, 0, packed.stderr?.toString());
  const destination = path.join(temporary, "skills");
  const result = spawnSync("/bin/bash", ["-s", "--", "--dest", destination, "--force"], {
    input: read("install.sh"),
    encoding: "utf8",
    env: {
      HOME: temporary,
      PATH: "/usr/bin:/bin",
      RAINBOND_SKILLS_TARBALL_URL: `file://${tarball}`,
      RAINBOND_SKILLS_OSS_URL: "",
    },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(spawnSync("/bin/sh", ["-c", "command -v node"], { env: { PATH: "/usr/bin:/bin" } }).status, 1);
  const approved = headingSection(read("SKILL.md"), "## Completion Message")
    .match(/```text\n([\s\S]*?)\n```/)?.[1];
  assert(result.stdout.includes(`[RAINSKILLS_USER_MESSAGE_BEGIN:install.completed]\n${approved}\n[RAINSKILLS_USER_MESSAGE_END:install.completed]`));
});

test("protected runtime intents directly cover every business skill and survive connect/resume", async () => {
  const samples = {
    deploy: { type: "deploy", project_root: "/workspace/app", source_kind: "local" },
    snapshot: { type: "snapshot", team_id: "team", app_id: "app", operation: "create" },
    "delivery-verify": { type: "delivery-verify", operation: "full", app_id: "app" },
    "env-sync": { type: "env-sync", project_root: "/workspace/app", environment: "production", app_id: "app" },
    bootstrap: { type: "bootstrap", project_root: "/workspace/app", app_id: "app" },
    "troubleshoot-phase": { type: "troubleshoot-phase", operation: "build", app_id: "app" },
    "platform-query": { type: "platform-query", resource: "teams", enterprise_id: "enterprise" },
    "project-init": { type: "project-init", project_root: "/workspace/app", source_kind: "local" },
    "template-install": { type: "template-install", template_id: "template", install_scope: "new-app" },
    "opensource-deploy": { type: "opensource-deploy", source_kind: "compose", source_url: "https://example.com/compose.yaml" },
  };
  const expectedSkills = new Set(runtimeSkills.map(({ file }) => file.split("/", 1)[0]));
  const coveredSkills = new Set(
    Object.values(INTENT_DEFINITIONS)
      .map(({ skillId }) => skillId)
      .filter((skillId) => skillId !== "rainskills")
  );
  assert.deepEqual([...expectedSkills].sort(), [...coveredSkills].sort());

  for (const skillId of expectedSkills) {
    const [type] = Object.entries(INTENT_DEFINITIONS).find(([, definition]) => definition.skillId === skillId);
    assert(samples[type], `missing integration sample for ${skillId}/${type}`);
    const intent = validateIntent(samples[type]);
    const connectArgv = ["runtime", "connect", "codex", "--saas", "--intent-json", JSON.stringify(intent)];
    assert.deepEqual(parseRuntimeConnectArgs(connectArgv).intent, intent);

    const home = fs.mkdtempSync(path.join(os.tmpdir(), "rainskills-routing-"));
    const manager = createRuntimeStateManager({
      home,
      stateStore: createPortableSecureStateStore(home),
      liveProbe: async () => true,
    });
    const output = [];
    await runBuiltin(connectArgv, {
      runtimeStateManager: manager,
      originInspector: async () => ({ origin: "https://run.rainbond.com" }),
      connectionRunner: async () => ({ code: 0, signal: null, completesRuntimeState: false }),
      write: (value) => output.push(value),
    });
    const onboardingId = JSON.parse(output.pop()).onboarding_id;
    await runBuiltin(["intent", "resume", "--onboarding-id", onboardingId], {
      runtimeStateManager: manager,
      write: (value) => output.push(value),
    });
    const continuation = JSON.parse(output.pop());
    assert.equal(continuation.skill_id, skillId);
    assert.deepEqual(continuation.intent, intent);
    assert.equal(continuation.resume_step, INTENT_DEFINITIONS[type].steps[0]);
  }
});

test("business Skills forbid exploratory commands and blind retries after a CLI failure", () => {
  for (const skill of runtimeSkills) {
    const gate = markedSection(read(skill.file), "runtime-gate");
    assert.match(
      gate,
      /只有 CLI 返回并通过校验的 `rainskills\.next-action\.v1` argv 才能执行续接/
    );
    assert.match(gate, /普通失败.*禁止自动重试/);
    assert.match(gate, /不得执行 `--help`、`sleep`、`rg`、`grep`/);
    assert.match(gate, /不得搜索 Rainskills 源码/);
    assert.match(gate, /同一 `operation complete` 最多执行一次/);
  }
});

test("app assistant frontmatter is a pure generic trigger without MCP preference", () => {
  const text = read("rainbond-app-assistant/SKILL.md");
  const frontmatter = YAML.parse(text.split(/^---\s*$/m)[1]);
  assert.equal(frontmatter.name, "rainbond-app-assistant");
  assert.match(frontmatter.description, /deploy.*run.*publish.*troubleshoot/is);
  assert.match(frontmatter.description, /regardless.*runtime.*MCP/is);
  assert.doesNotMatch(frontmatter.description, /prefer.*MCP|full lifecycle|project-init.*bootstrap/is);
});

test("deployment-facing skills keep internal diagnostics out of normal user results", () => {
  const files = [
    "rainbond-app-assistant/SKILL.md",
    "rainbond-fullstack-troubleshooter/SKILL.md",
    "rainbond-delivery-verifier/SKILL.md",
  ];

  for (const file of files) {
    const skill = read(file);
    const protocol = markedSection(skill, "user-result");
    assert.match(protocol, /最高优先级/);
    assert.match(protocol, /部署成功.*运行环境地址.*应用访问地址/s);
    assert.match(protocol, /项目：.*运行环境：.*工作空间：.*应用：.*已完成操作/s);
    assert.doesNotMatch(protocol, /团队：/);
    assert.match(protocol, /无法.*确认.*省略.*不得.*(?:猜测|推测)/s);
    assert.match(protocol, /部署失败.*失败原因/s);
    assert.match(protocol, /只有.*解决办法.*确实.*可执行/s);
    assert.match(protocol, /不得.*Problem Judgment.*Actions Taken.*Verification Result.*Structured Output/s);
    assert.match(protocol, /不得.*内部状态码.*YAML.*JSON/s);
    assert.match(protocol, /用户明确要求.*结构化|自动化.*明确要求.*结构化/s);
  }

  const appAssistant = read("rainbond-app-assistant/SKILL.md");
  assert.doesNotMatch(appAssistant, /结果仍在构建或异常.*才把.*fenced `yaml`/s);
  assert.doesNotMatch(appAssistant, /Do not make non-success output terse/);
  assert.doesNotMatch(read("rainbond-fullstack-troubleshooter/SKILL.md"), /Always respond using exactly these sections:/);
  assert.doesNotMatch(read("rainbond-delivery-verifier/SKILL.md"), /Always respond using exactly these sections:/);
});

test("generated Rainskills completion has actionable next prompts without reload guidance", () => {
  const skill = read("marketplace/rainskills/skills/rainskills/SKILL.md");
  const completion = headingSection(skill, "## Completion Message", "## Manage Runtime Environments");

  assert.match(completion, /Rainskills 安装完成/);
  assert.match(completion, /下一步可以直接说/);
  assert.match(completion, /帮我部署当前项目/);
  assert.doesNotMatch(completion, /reload|restart|重新加载|重启/i);
  assert.doesNotMatch(completion, /运行环境|MCP|授权|Rainbond Cloud|私有 Rainbond/i);
});

test("app assistant clarifies ambiguous app intent before runtime choices", () => {
  const routing = markedSection(read("rainbond-app-assistant/SKILL.md"), "runtime-routing");
  const ambiguous = headingSection(routing, "### 意图不明确", "### 新应用");
  const newApp = headingSection(routing, "### 新应用", "### 已有应用");
  const existingApp = headingSection(routing, "### 已有应用");

  assert.match(ambiguous, /部署新应用还是管理已有应用/);
  assert.doesNotMatch(ambiguous, /Rainbond Cloud|私有 Rainbond|install-private|runtime connect/i);
  assert.match(ambiguous, /确认前.*不.*连接运行环境/s);
  assertTwoLevelNewRuntimeChoice(newApp);
  assert.match(existingApp, /Rainbond Cloud.*承载目标应用.*已有私有 Rainbond/s);
  assert.match(existingApp, /不得.*install-private/s);
});

test("README introduces runtime only after an application action and documents recovery", () => {
  const readme = read("README.md");

  assert.match(readme, /安装完成后.*只.*Skills.*能力列表/s);
  assert.match(readme, /用户首次提出.*部署|第一次提出.*运行环境/s);
  assert.match(readme, /目前还没有可用的应用运行环境/);
  assert.match(readme, /\["environment", "list", "--json"\]/);
  assert.match(readme, /Console origin/);
  assert.match(readme, /401.*一次.*403.*不.*重新授权/s);
  assert.match(readme, /取消.*重试|失败.*重试/s);
  assert.match(readme, new RegExp(launcher.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(readme, /\["runtime", "connect", "<target>".*--intent-json/s);
  assert.match(readme, /rainskills\.next-action\.v1\.argv/);
  assert.match(readme, /permission-denied.*不 reconnect/s);
  assert.match(readme, /Skills-only.*不需要 Node\.js|仅安装 Skills.*不需要 Node\.js/s);
  assert.match(readme, /首次.*需要运行环境.*Node\.js 18/s);
  const newRuntimeChoice = headingSection(readme, "### 新应用环境选择", "### 已有应用环境选择");
  assertTwoLevelNewRuntimeChoice(newRuntimeChoice);
  const existingRuntimeChoice = headingSection(readme, "### 已有应用环境选择", "## 私有 Rainbond 安装");
  assert.match(existingRuntimeChoice, /Rainbond Cloud.*承载目标应用.*已有私有 Rainbond/s);
  assert.doesNotMatch(existingRuntimeChoice, /帮我(?:安装|准备)私有 Rainbond/);
  const privateInstall = headingSection(readme, "## 私有 Rainbond 安装", "## 更新");
  assert.doesNotMatch(privateInstall, /npx --yes rainskills platform install/);
  const platformLaunchers = privateInstall.match(
    /node ~\/\.rainbond\/lib\/rainskills\/bin\/rainskills\.js platform install/g
  ) || [];
  assert.equal(platformLaunchers.length, 4);
  assert.match(readme, new RegExp(`rainskills@${packageVersion.replaceAll(".", "\\.")}`));
});

test("platform installer guidance reveals modes progressively", () => {
  const skill = read("rainbond-platform-installer/SKILL.md");
  const policy = read("rainbond-platform-installer/references/installation-policy.md");
  const progressive = markedSection(skill, "platform-routing");

  assert.match(progressive, /请选择部署位置：.*1、部署到本机.*2、部署到独立服务器.*3、部署到已有 Rainbond/s);
  assert.doesNotMatch(skill, /请选择安装位置|安装到本地|安装到 Linux 服务器/);
  assert.doesNotMatch(policy, /请选择安装位置|安装到本地|安装到 Linux 服务器/);
  for (const file of [
    "rainbond-platform-installer/scripts/platform-installer.js",
    "rainbond-platform-installer/scripts/platform-routing.js",
  ]) {
    assert.doesNotMatch(read(file), /请选择安装位置|安装到本地|安装到 Linux 服务器/);
  }
  assert.match(skill, /runtime["',\s]+message["',\s]+--id["',\s]+private-deployment-location/);
  assert.match(skill, /选择 1.*--location["'`,\s]+local.*选择 2.*--location["'`,\s]+server.*选择 3.*private-console-origin/s);
  assert.doesNotMatch(skill, /detect the control machine and ask for the installation target/i);
  assert.match(progressive, /请选择服务器类型：.*1、单台服务器（Linux）.*2、三台及以上服务器（Linux）.*3、已有 Kubernetes 集群/s);
  assert.match(progressive, /本机.*直接.*单机/s);
  assert.match(progressive, /本机.*不.*ROI.*Kubernetes/s);
  assert.match(progressive, /1、2 或 N|1\/2\/N/);
  assert.match(progressive, /etcd.*正奇数/i);
  assert.match(progressive, /可点击.*cluster\.yaml.*当前系统.*打开命令/s);
  assert.doesNotMatch(progressive, /只告诉用户文件位置/);
  assert.match(progressive, /全部.*未就绪.*节点.*一次.*列出/s);
  assert.match(progressive, /prepare-cluster.*--cluster-config/s);
  assert.match(progressive, /只.*回复.*一次.*已完成/s);
  assert.match(skill, /单台服务器.*ssh prepare.*主机集群.*ssh prepare-cluster/s);
  assert.match(skill, /--cluster-config/);
  assert.match(skill, /--kubeconfig/);
  assert.match(skill, /--kube-context/);
  assert.match(skill, /--chart-version/);
  assert.match(skill, /--yes/);
  assert.match(skill, new RegExp(launcher.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(skill, /rainskills\.next-action\.v1.*(?:validate.*argv|校验.*argv)/is);
  assert.match(skill, /RAINSKILLS_USER_MESSAGE_BEGIN/);
  assert.match(skill, /原样.*(?:转发|输出).*不得.*(?:总结|改写|追加)/s);
  assert.match(skill, /附着.*(?:PTY|终端)|(?:PTY|终端).*附着/is);
  assert.match(skill, /不得.*ssh-keyscan/is);
  assert.match(skill, /不得.*ssh-copy-id/is);
  assert.match(skill, /不得.*回复.*已授权|不得.*要求.*已授权/is);
  const appAssistant = read("rainbond-app-assistant/SKILL.md");
  assert.match(appAssistant, /runtime["',\s]+message["',\s]+--id["',\s]+new-application-environment/);
  assert.match(appAssistant, /runtime["',\s]+message["',\s]+--id["',\s]+private-deployment-location/);
  assert.match(appAssistant, /RAINSKILLS_USER_MESSAGE_BEGIN/);
});

test("README documents one batch SSH command for all unavailable cluster nodes", () => {
  const readme = read("README.md");
  const sshFlow = headingSection(readme, "### 服务器 SSH 固定流程", "## 多运行环境");
  assert.match(sshFlow, /单台服务器.*ssh prepare.*主机集群.*ssh prepare-cluster/s);
  assert.match(sshFlow, /全部.*待处理节点.*名称.*IP.*端口/s);
  assert.match(sshFlow, /一条.*prepare-cluster.*--cluster-config/s);
  assert.match(sshFlow, /统一回复.*已完成/s);
  assert.doesNotMatch(sshFlow, /主机集群.*逐台.*回复“已完成”/s);
});

test("platform installer UI metadata follows the OpenAI Skill contract", () => {
  const metadata = read("rainbond-platform-installer/agents/openai.yaml");
  const values = [...metadata.matchAll(/^  [a-z_]+:\s*(.+)$/gm)].map((match) => match[1]);

  assert(values.length >= 3);
  assert(values.every((value) => /^".*"$/.test(value)), "all string values must be quoted");
  const shortDescription = metadata.match(/short_description: "([^"]+)"/)?.[1] || "";
  assert(shortDescription.length >= 25 && shortDescription.length <= 64);
  assert.match(metadata, /default_prompt: ".*\$rainbond-platform-installer.*"/);
  assert.match(metadata, /主机集群|Kubernetes/);
});
