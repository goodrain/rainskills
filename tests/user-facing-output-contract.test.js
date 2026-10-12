const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const customerFacingSkills = [
  "rainbond-ai-assistant",
  "rainbond-app-assistant",
  "rainbond-app-version-assistant",
  "rainbond-delivery-verifier",
  "rainbond-env-sync",
  "rainbond-fullstack-bootstrap",
  "rainbond-fullstack-troubleshooter",
  "rainbond-project-init",
  "rainbond-platform-plugin-manager",
  "rainbond-template-installer",
];

const outputContractFiles = [
  "rainbond-app-assistant/references/output-contract.md",
  "rainbond-app-version-assistant/SKILL.md",
  "rainbond-env-sync/SKILL.md",
  "rainbond-fullstack-bootstrap/SKILL.md",
  "rainbond-fullstack-bootstrap/modules/70-output-contract.md",
  "rainbond-fullstack-bootstrap/references/quick-reference.md",
  "rainbond-fullstack-troubleshooter/references/output-contract.md",
  "rainbond-project-init/SKILL.md",
  "rainbond-project-init/references/operational-reference.md",
  "rainbond-project-init/references/output-contract.md",
  "rainbond-template-installer/SKILL.md",
];

const validatorFiles = [
  "rainbond-app-assistant/scripts/validate_app_assistant_output.py",
  "rainbond-delivery-verifier/scripts/validate_delivery_verifier_output.py",
  "rainbond-fullstack-bootstrap/scripts/validate_bootstrap_output.py",
  "rainbond-fullstack-troubleshooter/scripts/validate_troubleshoot_output.py",
];

const evalDirectories = [
  "rainbond-app-assistant/evals",
  "rainbond-delivery-verifier/evals",
  "rainbond-fullstack-bootstrap/evals",
  "rainbond-fullstack-troubleshooter/evals",
];

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

test("customer output contains no community advertising", () => {
  for (const skill of customerFacingSkills) {
    for (const relativePath of [
      `${skill}/SKILL.md`,
      `${skill}/references/output-contract.md`,
      `${skill}/references/generated/user-result.md`,
    ]) {
      if (!fs.existsSync(path.join(root, relativePath))) continue;
      assert.doesNotMatch(read(relativePath), /community-card|交流群|二维码|rainbond-xzs/i, relativePath);
    }
  }
});

test("ordinary user replies default to concise Chinese without internal contracts", () => {
  for (const skill of customerFacingSkills) {
    const entrypoint = read(`${skill}/SKILL.md`);
    const content = `${entrypoint}\n${read(`${skill}/references/generated/user-result.md`)}`;
    assert.match(
      content,
      /(?:用户可见结果协议|简洁结果协议)/,
      `${skill} must define its customer-facing result mode`,
    );
    assert.match(
      content,
      /(?:用户|自动化|评测)[^\n]*明确要求[^\n]*(?:结构化|YAML|JSON)/,
      `${skill} must make structured output explicitly opt-in`,
    );
    assert.match(
      content,
      /默认[^\n]*(?:不得|不(?:应|要|得)?)[^\n]*(?:YAML|JSON|内部)/,
      `${skill} must forbid internal output in the default mode`,
    );
  }
});

test("deployment progress identifies workspaces by name instead of team ID", () => {
  const entrypoint = read("rainbond-app-assistant/SKILL.md");
  const workflow = read("rainbond-app-assistant/references/workflow-rules.md");

  assert.match(entrypoint, /过程消息[^\n]*team_name[^\n]*展示/);
  assert.match(entrypoint, /不展示 `team_id`/);
  assert.match(
    entrypoint,
    /未完成：加载 \[output contract\]\(references\/output-contract\.md\)/,
  );
  assert.match(workflow, /team_id[^。\n]*不得[^。\n]*过程消息[^。\n]*最终报告/);
});

test("supporting output contracts do not make structured data the default final reply", () => {
  const forbiddenUnconditionalContracts = [
    /Every final reply must/i,
    /The final reply must end with `### Structured Output`/i,
    /Always respond using exactly these sections/i,
    /always end with `### Structured Output`/i,
    /omitting the required `### Structured Output` section/i,
  ];

  for (const relativePath of outputContractFiles) {
    const content = read(relativePath);
    for (const pattern of forbiddenUnconditionalContracts) {
      assert.doesNotMatch(content, pattern, relativePath);
    }
  }
});

test("reply validators default to customer mode and require fixtures to declare their mode", () => {
  for (const relativePath of validatorFiles) {
    const content = read(relativePath);
    assert.match(content, /presentation_mode/, relativePath);
    assert.match(
      content,
      /presentation_mode[^\n]*["']customer["']/,
      `${relativePath} must default to customer presentation`,
    );
    assert.match(
      content,
      /presentation_mode\s*==\s*["']structured["']/,
      `${relativePath} must retain an explicit structured mode`,
    );
  }

  for (const directory of evalDirectories) {
    const absoluteDirectory = path.join(root, directory);
    for (const entry of fs.readdirSync(absoluteDirectory)) {
      if (!entry.endsWith(".expected.yaml")) continue;
      assert.match(
        read(path.join(directory, entry)),
        /^presentation_mode: (?:customer|structured)$/m,
        `${directory}/${entry} must declare its presentation mode`,
      );
    }
  }
});

test("reply validators accept customer text by default and reject internal contracts without opt-in", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "rainskills-customer-output-"));
  const customerResponse = path.join(temporary, "customer.md");
  fs.writeFileSync(
    customerResponse,
    "操作完成。\n\n- 应用：demo\n- 结果：组件运行正常。\n",
    "utf8",
  );

  const structuredFixtures = {
    "rainbond-app-assistant/scripts/validate_app_assistant_output.py":
      "rainbond-app-assistant/evals/01-linked-topology-missing.response.md",
    "rainbond-delivery-verifier/scripts/validate_delivery_verifier_output.py":
      "rainbond-delivery-verifier/evals/01-delivered-verified.response.md",
    "rainbond-fullstack-bootstrap/scripts/validate_bootstrap_output.py":
      "rainbond-fullstack-bootstrap/evals/01-reuse-only.response.md",
    "rainbond-fullstack-troubleshooter/scripts/validate_troubleshoot_output.py":
      "rainbond-fullstack-troubleshooter/evals/01-source-build-failed.response.md",
  };

  for (const [validator, structuredFixture] of Object.entries(structuredFixtures)) {
    const accepted = spawnSync("python3", [path.join(root, validator), customerResponse], {
      encoding: "utf8",
    });
    assert.equal(accepted.status, 0, accepted.stderr || accepted.stdout || validator);

    const rejected = spawnSync(
      "python3",
      [path.join(root, validator), path.join(root, structuredFixture)],
      { encoding: "utf8" },
    );
    assert.notEqual(rejected.status, 0, `${validator} must reject implicit structured output`);
  }
});

test("default deployment replies preserve useful verified detail without generic promotion", () => {
  const entrypoint = read("rainbond-app-assistant/SKILL.md");
  assert.doesNotMatch(entrypoint, /部署成功后的固定动作块/);
  assert.match(entrypoint, /references\/output-contract\.md/);

  for (const relativePath of [
    "contracts/shared/user-result.md",
    "rainbond-app-assistant/references/output-contract.md",
    "rainbond-app-assistant/references/workflow-rules.md",
    "rainbond-fullstack-bootstrap/modules/70-output-contract.md",
    "rainbond-fullstack-troubleshooter/references/output-contract.md",
    "rainbond-delivery-verifier/references/output-contract.md",
  ]) {
    const content = read(relativePath);
    assert.doesNotMatch(content, /你接下来可以：/, relativePath);
    assert.doesNotMatch(content, /将应用迁移到自己的 Rainbond/, relativePath);
  }

  const canonical = read("contracts/shared/user-result.md");
  assert.match(canonical, /已执行动作/);
  assert.match(canonical, /当前状态/);
  assert.match(canonical, /关键证据/);
  assert.match(canonical, /访问地址|端口说明/);
  assert.match(canonical, /唯一下一步/);
  assert.match(canonical, /同一字段[^\n]*只出现一次/);
});

test("customer validators accept bounded success and reject duplicate fields", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "rainskills-success-actions-"));
  const conciseResponse = path.join(temporary, "concise.md");
  const duplicateResponse = path.join(temporary, "duplicate.md");
  fs.writeFileSync(
    conciseResponse,
    "部署成功\n应用：demo\n状态：running\n地址：https://example.com\n",
    "utf8",
  );
  fs.writeFileSync(
    duplicateResponse,
    "部署成功\n应用：demo\n状态：running\n状态：running\n地址：https://example.com\n",
    "utf8",
  );

  for (const validator of [
    "rainbond-app-assistant/scripts/validate_app_assistant_output.py",
    "rainbond-delivery-verifier/scripts/validate_delivery_verifier_output.py",
  ]) {
    const accepted = spawnSync("python3", [path.join(root, validator), conciseResponse], {
      encoding: "utf8",
    });
    assert.equal(accepted.status, 0, accepted.stderr || accepted.stdout || validator);

    const rejected = spawnSync("python3", [path.join(root, validator), duplicateResponse], {
      encoding: "utf8",
    });
    assert.notEqual(rejected.status, 0, validator);
  }
});

test("customer validators accept a useful detailed incomplete deployment result", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "rainskills-detailed-output-"));
  const response = path.join(temporary, "incomplete.md");
  fs.writeFileSync(response, [
    "部署未完成",
    "",
    "已执行动作：已创建应用和组件，并开放 8080 端口。",
    "状态：组件尚未运行。",
    "阻塞：镜像推送至集群内部仓库失败。",
    "关键证据：连续两次出现相同推送错误。",
    "端口说明：官方 nginx 镜像默认监听 80，使用 8080 时需要同步调整容器监听端口。",
    "下一步：修复集群镜像仓库后重新部署。",
    "",
  ].join("\n"), "utf8");

  const result = spawnSync(
    "python3",
    [path.join(root, "rainbond-app-assistant/scripts/validate_app_assistant_output.py"), response],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
