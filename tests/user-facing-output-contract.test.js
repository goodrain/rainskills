const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const root = path.resolve(__dirname, "..");

const customerFacingSkills = [
  "rainbond-app-assistant",
  "rainbond-app-version-assistant",
  "rainbond-delivery-verifier",
  "rainbond-env-sync",
  "rainbond-fullstack-bootstrap",
  "rainbond-fullstack-troubleshooter",
  "rainbond-project-init",
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

test("ordinary user replies default to concise Chinese without internal contracts", () => {
  for (const skill of customerFacingSkills) {
    const content = read(`${skill}/SKILL.md`);
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
