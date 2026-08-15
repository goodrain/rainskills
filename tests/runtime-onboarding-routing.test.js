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
const launcher = `["npx", "--yes", "rainskills@${packageVersion}"]`;
const runtimeSkills = [
  {
    file: "rainbond-app-assistant/SKILL.md",
    action: "分析、构建、部署和验证当前项目",
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
};

const bootstrapScopeCases = [
  [{ type: "bootstrap", project_root: "/workspace/app" }, "new"],
  [{ type: "bootstrap", project_root: "/workspace/app", team_id: "team" }, "new"],
  [{ type: "bootstrap", project_root: "/workspace/app", app_id: "app" }, "existing"],
  [{ type: "bootstrap", project_root: "/workspace/app", service_id: "service" }, "existing"],
  [{ type: "bootstrap", project_root: "/workspace/app", app_id: "app", service_id: "service" }, "existing"],
];

function materializeConnectArgv(template, intent) {
  return template.map((value) => {
    if (value === "<target>") return "codex";
    if (value === "<rainbond-url>") return "https://console.example.com";
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
  await runBuiltin(fullArgv.slice(3), {
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
      assert.throws(() => parseRuntimeConnectArgs(installArgv.slice(3)), /existing|已有|现有/i);
    } else {
      assert.equal(parseRuntimeConnectArgs(installArgv.slice(3)).environmentChoice, "install-private");
    }
  }

  const routing = markedSection(skill, "runtime-routing");
  const existingBranch = headingSection(routing, "### 已有目标", "<!-- rainskills-runtime-routing:end -->");
  assert.match(existingBranch, /Rainbond Cloud/);
  assert.match(existingBranch, /已有私有 Rainbond/);
  assert.doesNotMatch(existingBranch, /install-private|安装私有 Rainbond/i);
});

for (const skill of runtimeSkills) {
  test(`${skill.file} gates every business operation on protected runtime status`, () => {
    const gate = markedSection(read(skill.file), "runtime-gate");

    assert.match(gate, /第一步.*Node\.js.*18/s);
    assert(gate.indexOf("Node.js") < gate.indexOf("runtime\", \"status"));
    assert.match(gate, /执行组件需要 Node\.js 18/);
    assert.match(gate, /缺失|低于/);
    assert.match(gate, /停止.*不.*选择运行环境.*不.*MCP.*不.*猜测/s);
    assert.match(gate, /用户或 agent 明确同意.*安装.*Node\.js.*原始 intent/s);
    assert.match(gate, /先于.*业务 MCP/s);
    assert.match(gate, /not_started.*(?:历史.*MCP.*不能|不能因历史.*MCP).*跳过|not_started.*不得.*跳过/s);
    assert.match(gate, /connected.*usable\s*=\s*true.*live probe/s);
    assert.match(gate, /live probe.*失败.*reconnect|探针.*失败.*重连/is);
    assert.match(gate, /固定.*onboarding-id.*原始 intent.*resume_step/s);
    assert.match(gate, /401.*--step/s);
    assert.match(gate, /401.*一次/s);
    assert.match(gate, /第二次 401.*停止|401.*第二次.*停止/s);
    assert.match(gate, /403.*不.*重新授权|403.*禁止.*重.*授权/s);
    assert.match(gate, new RegExp(launcher.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(gate, /版本.*package\.json.*一致/s);
    assert.match(gate, /argv 数组/);
    assert.match(gate, /禁止.*rainskills@latest|禁止.*latest/s);
    assert.match(gate, /禁止.*shell 字符串|禁止.*执行 shell 字符串/s);
    assert.match(gate, /\["runtime", "status", "--json"\]/);
    assert.match(gate, /"runtime", "connect"/);
    assert.match(gate, /codex.*claude.*all/s);
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
    assert.deepEqual(contract.launcher, ["npx", "--yes", `rainskills@${packageVersion}`]);
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
          assert.deepEqual(fullArgv.slice(0, 3), contract.launcher);
          const parsed = parseRuntimeConnectArgs(fullArgv.slice(3));
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
    assert.match(routing, /Rainskills 是 AI 部署助手/);
    assert.match(routing, /Rainbond 是一套应用运行和管理平台/);
    assert.match(routing, /不需要了解 Kubernetes/);
    assert.match(routing, /Rainbond Cloud/);
    assert.match(routing, /已有私有 Rainbond/);

    if (skill.route === "new" || skill.route === "mixed") {
      assert.match(routing, /安装私有 Rainbond/);
    }
    if (skill.route === "existing") {
      assert.match(routing, /承载目标应用/);
      assert.match(routing, /只让用户选择.*Rainbond Cloud.*已有私有 Rainbond/s);
      assert.match(routing, /不得.*安装私有 Rainbond|不得.*新平台/s);
    }
    if (skill.route === "mixed") {
      assert.match(
        routing,
        /已有应用.*(?:不得.*安装.*新|existing-app.*不得.*install-private|只(?:让用户选择|提供|连接).*Rainbond Cloud.*已有私有 Rainbond)/is
      );
    }
  });
}

test("root Rainskills installation stops after Skills success and capability guidance", () => {
  const skill = read("SKILL.md");
  const initialize = skill.slice(skill.indexOf("## Initialize"));
  const completion = headingSection(skill, "## Completion Message");
  const approved = `Rainskills 安装完成。

现在可以帮你：

- 分析项目的技术栈和部署结构
- 将当前项目或 Git 仓库部署上线
- 通过源码、镜像或安装包部署应用
- 分析项目结构
- 识别技术栈
- 从应用模板安装应用
- 给出部署结构建议

直接告诉我你想做什么即可。`;

  assert.match(skill, /Rainskills 安装完成/);
  assert.match(skill, /分析项目的技术栈和部署结构/);
  assert.match(skill, /将当前项目或 Git 仓库部署上线/);
  assert.match(skill, /通过源码、镜像或安装包部署应用/);
  assert.match(skill, /从应用模板安装应用/);
  assert.match(skill, /直接告诉我你想做什么即可/);
  assert.doesNotMatch(initialize, /选择.*运行环境|配置 MCP|浏览器.*授权|Rainbond Cloud.*私有/s);
  assert.equal(completion.match(/```text\n([\s\S]*?)\n```/)?.[1], approved);
  assert.doesNotMatch(completion, /reload|restart|重新加载|重启|下一步/i);
  assert.match(skill, /Skills-only.*不需要 Node\.js|仅安装 Skills.*不需要 Node\.js/s);
  assert.match(skill, /首次.*需要运行环境.*Node\.js 18/s);
  assert.doesNotMatch(completion, /Node\.js|Node 18/i);
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
  assert(result.stdout.trim().endsWith(approved));
});

test("protected runtime intents directly cover every business skill and survive connect/resume", async () => {
  const samples = {
    deploy: { type: "deploy", project_root: "/workspace/app", source_kind: "local" },
    snapshot: { type: "snapshot", team_id: "team", app_id: "app", operation: "create" },
    "delivery-verify": { type: "delivery-verify", operation: "full", app_id: "app" },
    "env-sync": { type: "env-sync", project_root: "/workspace/app", environment: "production", app_id: "app" },
    bootstrap: { type: "bootstrap", project_root: "/workspace/app", app_id: "app" },
    "troubleshoot-phase": { type: "troubleshoot-phase", operation: "build", app_id: "app" },
    "project-init": { type: "project-init", project_root: "/workspace/app", source_kind: "local" },
    "template-install": { type: "template-install", template_id: "template", install_scope: "new-app" },
  };
  const expectedSkills = new Set(runtimeSkills.map(({ file }) => file.split("/", 1)[0]));
  const coveredSkills = new Set(Object.values(INTENT_DEFINITIONS).map(({ skillId }) => skillId));
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

test("app assistant frontmatter is a pure generic trigger without MCP preference", () => {
  const text = read("rainbond-app-assistant/SKILL.md");
  const frontmatter = YAML.parse(text.split(/^---\s*$/m)[1]);
  assert.equal(frontmatter.name, "rainbond-app-assistant");
  assert.match(frontmatter.description, /deploy.*run.*publish.*troubleshoot/is);
  assert.match(frontmatter.description, /regardless.*runtime.*MCP/is);
  assert.doesNotMatch(frontmatter.description, /prefer.*MCP|full lifecycle|project-init.*bootstrap/is);
});

test("generated Rainskills completion has no reload or next-step prompt", () => {
  const skill = read("marketplace/rainskills/skills/rainskills/SKILL.md");
  const completion = headingSection(skill, "## Completion Message");

  assert.match(completion, /Rainskills 安装完成/);
  assert.doesNotMatch(completion, /reload|restart|重新加载|重启|下一步/i);
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
  assert.match(newApp, /Rainbond Cloud.*已有私有 Rainbond.*安装私有 Rainbond/s);
  assert.match(existingApp, /Rainbond Cloud.*承载目标应用.*已有私有 Rainbond/s);
  assert.match(existingApp, /不得.*install-private/s);
});

test("README introduces runtime only after an application action and documents recovery", () => {
  const readme = read("README.md");

  assert.match(readme, /安装完成后.*只.*Skills.*能力列表/s);
  assert.match(readme, /用户首次提出.*部署|第一次提出.*运行环境/s);
  assert.match(readme, /目前还没有可用的应用运行环境/);
  assert.match(readme, /\["runtime", "status", "--json"\]/);
  assert.match(readme, /Console origin/);
  assert.match(readme, /401.*一次.*403.*不.*重新授权/s);
  assert.match(readme, /取消.*重试|失败.*重试/s);
  assert.match(readme, new RegExp(launcher.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(readme, /\["runtime", "connect", "<target>".*--intent-json/s);
  assert.match(readme, /rainskills\.next-action\.v1\.argv/);
  assert.match(readme, /permission-denied.*不 reconnect/s);
  assert.match(readme, /Skills-only.*不需要 Node\.js|仅安装 Skills.*不需要 Node\.js/s);
  assert.match(readme, /首次.*需要运行环境.*Node\.js 18/s);
  const privateInstall = headingSection(readme, "## 私有 Rainbond 安装", "## 更新");
  assert.doesNotMatch(privateInstall, /npx --yes rainskills platform install/);
  const platformLaunchers = [
    ...privateInstall.matchAll(/npx --yes rainskills@([^ ]+) platform install/g),
  ];
  assert.equal(platformLaunchers.length, 4);
  assert(platformLaunchers.every((match) => match[1] === packageVersion));
});

test("platform installer guidance reveals modes progressively", () => {
  const skill = read("rainbond-platform-installer/SKILL.md");
  const progressive = markedSection(skill, "platform-routing");

  assert.match(progressive, /先.*安装到本地.*安装到服务器/s);
  assert.match(progressive, /本地.*直接.*单机/s);
  assert.match(progressive, /本地.*不.*ROI.*Kubernetes/s);
  assert.match(progressive, /服务器.*单机.*主机集群.*已有 Kubernetes/s);
  assert.match(progressive, /1、2 或 N|1\/2\/N/);
  assert.match(progressive, /etcd.*正奇数/i);
  assert.match(skill, /--cluster-config/);
  assert.match(skill, /--kubeconfig/);
  assert.match(skill, /--kube-context/);
  assert.match(skill, /--chart-version/);
  assert.match(skill, /--yes/);
  assert.match(skill, new RegExp(launcher.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(skill, /rainskills\.next-action\.v1.*(?:validate.*argv|校验.*argv)/is);
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
