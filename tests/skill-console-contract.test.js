const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const builder = path.join(root, "scripts", "build-skill-profile.mjs");

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

function markdownFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return markdownFiles(entryPath);
    return entry.name.endsWith(".md") ? [entryPath] : [];
  });
}

function embeddedMarkdown() {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), "rainskills-contract-"));
  const result = spawnSync(process.execPath, [
    builder, "--profile", "embedded", "--source-root", root,
    "--output", output, "--revision", "test-sha",
  ], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return markdownFiles(output).map((file) => fs.readFileSync(file, "utf8")).join("\n");
}

test("published source and embedded profile use the Console-backed tool contracts", () => {
  const source = fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("rainbond-"))
    .flatMap((entry) => markdownFiles(path.join(root, entry.name)))
    .map((file) => fs.readFileSync(file, "utf8"))
    .join("\n");
  const embedded = embeddedMarkdown();

  for (const content of [source, embedded]) {
    assert.doesNotMatch(content, /rainbond_submit_app_share(?!_info)/);
    assert.doesNotMatch(content, /rainbond_query_component_dependencies/);
    assert.match(content, /rainbond_submit_app_share_info/);
    assert.match(content, /rainbond_manage_component_dependency\(operation=summary\)/);
  }

  const troubleshooter = [
    read("rainbond-fullstack-troubleshooter/SKILL.md"),
    read("rainbond-fullstack-troubleshooter/references/root-cause-rules.md"),
  ].join("\n");
  assert.match(troubleshooter, /路径不变时省略 `new_volume_path`/);
  assert.match(troubleshooter, /`new_file_content` is required/);
  assert.doesNotMatch(troubleshooter, /new_volume_path` is required even when the path is unchanged/);
});

test("Console failure reasons have one stable user-facing mapping and app IDs are normalized at tool boundaries", () => {
  const troubleshooter = read("rainbond-fullstack-troubleshooter/SKILL.md");
  for (const reason of [
    "config_file_configmap_missing", "volume_mount_failed", "image_pull_failed",
    "crash_loop", "probe_failed", "unschedulable", "k8s_api_rejected", "unknown",
  ]) {
    assert.match(troubleshooter, new RegExp("\\\\| `" + reason + "`"));
  }
  assert.match(troubleshooter, /`unknown`.*existing evidence chain/);

  for (const file of [
    "rainbond-app-version-assistant/SKILL.md",
    "rainbond-template-installer/SKILL.md",
    "rainbond-project-init/SKILL.md",
    "rainbond-app-assistant/SKILL.md",
    "rainbond-env-sync/SKILL.md",
  ]) {
    const content = read(file);
    assert.match(content, /(?:Tool|MCP|工具).*[`]?app_id[`]?.*(?:positive integer|正整数)|[`]?app_id[`]?.*(?:positive integer|正整数).*(?:Tool|MCP|工具)/is, file);
  }

  const appAssistantSchema = read("rainbond-app-assistant/schemas/app-assistant-result.schema.yaml");
  const bootstrapSchema = read("rainbond-fullstack-bootstrap/schemas/bootstrap-result.schema.yaml");
  assert.doesNotMatch(
    appAssistantSchema,
    /app_id:\n\s+anyOf:\n\s+- \$ref: "#\/\$defs\/positive_integer"\n\s+- \$ref: "#\/\$defs\/nullable_non_empty_string"/
  );
  assert.doesNotMatch(
    bootstrapSchema,
    /app_id:\n\s+anyOf:[\s\S]{0,160}non_empty_string/
  );
});

test("platform query fixes Console-required arguments for CLI and embedded execution", () => {
  const query = read("rainbond-platform-query/SKILL.md");
  assert.match(query, /rainbond_query_teams.*enterprise_id/s);
  assert.match(query, /rainbond_query_apps.*enterprise_id/s);
  assert.match(query, /rainbond_query_components.*enterprise_id.*app_id/s);
  assert.match(query, /rainbond_get_team_apps.*team_name.*region_name/s);
  assert.match(query, /rainbond_query_regions.*enterprise_id/s);
});

test("local runtime commands request protected-state access in sandboxed hosts", () => {
  const localRuntimeSkills = [
    "SKILL.md",
    ...fs.readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("rainbond-"))
      .map((entry) => `${entry.name}/SKILL.md`)
      .filter((relativePath) => fs.existsSync(path.join(root, relativePath)))
      .filter((relativePath) => read(relativePath).includes("local-runtime.js")),
  ];
  const expectedRule = /受限沙箱.*用户级受保护目录访问/is;

  for (const relativePath of localRuntimeSkills) {
    assert.match(read(relativePath), expectedRule, relativePath);
  }

  const embedded = embeddedMarkdown();
  assert.match(embedded, expectedRule);
});

test("runtime prerequisites are session-cached and never rediscover fixed launchers", () => {
  const localRuntimeSkills = [
    "SKILL.md",
    ...fs.readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("rainbond-"))
      .map((entry) => `${entry.name}/SKILL.md`)
      .filter((relativePath) => fs.existsSync(path.join(root, relativePath)))
      .filter((relativePath) => read(relativePath).includes("local-runtime.js")),
  ];

  for (const relativePath of localRuntimeSkills) {
    const content = read(relativePath);
    assert.match(content, /同一会话内只检查一次 Node\.js/, relativePath);
    assert.match(content, /禁止读取、搜索或探测 `?rainskills\.js`?/, relativePath);
    assert.match(content, /npm root -g/, relativePath);
  }

  const embedded = embeddedMarkdown();
  assert.match(embedded, /同一会话内只检查一次 Node\.js/);
  assert.match(embedded, /禁止读取、搜索或探测 `?rainskills\.js`?/);
});

test("failure context stays secret-safe and canonical blocker vocabularies agree", () => {
  const appAssistant = read("rainbond-app-assistant/SKILL.md");
  const troubleshooter = read("rainbond-fullstack-troubleshooter/SKILL.md");
  const model = read("rainbond-app-assistant/references/product-object-model.md");
  const schema = read("rainbond-fullstack-troubleshooter/schemas/troubleshoot-result.schema.yaml");

  for (const content of [appAssistant, troubleshooter]) {
    assert.match(content, /event_log_tail.*(?:never|不得).*原文|(?:never|不得).*event_log_tail.*原文/is);
  }
  assert.doesNotMatch(troubleshooter, /`k8s_api_rejected`[^\n]*`code_or_build_handoff_needed`/);
  for (const content of [troubleshooter, model, schema]) {
    assert.match(content, /config_file_configmap_missing/);
  }
});

test("large skills link to substantive on-demand references", () => {
  const pairs = [
    ["rainbond-app-assistant/SKILL.md", "rainbond-app-assistant/references/output-contract.md"],
    ["rainbond-project-init/SKILL.md", "rainbond-project-init/references/manifest-rules.md"],
    ["rainbond-fullstack-troubleshooter/SKILL.md", "rainbond-fullstack-troubleshooter/references/root-cause-rules.md"],
  ];
  for (const [parent, reference] of pairs) {
    assert.match(read(parent), new RegExp(reference.split("/").at(-1).replace(".", "\\.")), parent);
    assert(read(reference).split(/\r?\n/).length > 50, `${reference} must be substantive`);
    assert.doesNotMatch(read(reference), /remain in the parent|留在父|compatibility transition/i, reference);
  }
});

test("aggregate fast paths and recovery rules stay bounded", () => {
  const delivery = read("rainbond-delivery-verifier/SKILL.md");
  const envSync = read("rainbond-env-sync/SKILL.md");
  const appAssistant = read("rainbond-app-assistant/SKILL.md");
  const bootstrap = read("rainbond-fullstack-bootstrap/modules/40-source-and-package-rules.md");
  const troubleshooter = read("rainbond-fullstack-troubleshooter/SKILL.md");

  assert.match(delivery, /rainbond_get_app_health_overview/);
  assert.match(envSync, /rainbond_analyze_env_conflicts/);
  assert.match(appAssistant, /rainbond_get_operation_failure_context/);
  assert.match(bootstrap, /rainbond_wait_for_build_completion/);
  assert.match(bootstrap, /create_status.*complete[\s\S]*explicit user confirmation/);
  assert.match(troubleshooter, /rainbond_get_app_health_overview/);
});

test("CNB recovery is state-dependent and destructive recovery stays explicitly confirmed", () => {
  const bootstrap = read("rainbond-fullstack-bootstrap/modules/40-source-and-package-rules.md");
  const appAssistant = read("rainbond-app-assistant/SKILL.md");

  for (const content of [bootstrap, appAssistant]) {
    assert.match(content, /create_status.*complete[\s\S]*explicit user confirmation/i);
    assert.match(content, /topology.*configuration snapshot/i);
  }
  assert.match(bootstrap, /checking.*checked[\s\S]*prefer_dockerfile_when_detected=true/i);
  assert.match(bootstrap, /Missing status evidence or confirmation is a read-only stop condition/);
});

test("ConfigMap failures have an explicit Console-reason-to-output-contract mapping", () => {
  const troubleshooter = [
    read("rainbond-fullstack-troubleshooter/SKILL.md"),
    read("rainbond-fullstack-troubleshooter/references/root-cause-rules.md"),
  ].join("\n");
  const schema = read("rainbond-fullstack-troubleshooter/schemas/troubleshoot-result.schema.yaml");
  const validator = read("rainbond-fullstack-troubleshooter/scripts/validate_troubleshoot_output.py");

  assert.match(troubleshooter, /Config-file ConfigMap missing/);
  assert.match(troubleshooter, /blocker_bucket = config_file_configmap_missing/);
  assert.match(schema, /- config_file_configmap_missing/);
  assert.doesNotMatch(schema, /stop_reason:[\s\S]*- config_file_configmap_missing/);
  assert.match(validator, /"config_file_configmap_missing"/);
});
