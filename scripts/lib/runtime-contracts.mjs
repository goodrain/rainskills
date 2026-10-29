import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";

export const RUNTIME_SKILL_IDS = Object.freeze([
  "rainbond-ai-assistant", "rainbond-app-assistant", "rainbond-app-version-assistant",
  "rainbond-delivery-verifier", "rainbond-env-sync", "rainbond-fullstack-bootstrap",
  "rainbond-fullstack-troubleshooter", "rainbond-opensource-app-deploy",
  "rainbond-platform-plugin-manager", "rainbond-platform-query", "rainbond-project-init",
  "rainbond-scheduled-task",
  "rainbond-template-installer",
]);
const OVERLAY_KEYS = Object.freeze([
  "schema", "skill_id", "profiles", "command_set", "version_guard",
  "missing_runtime_mode", "scope_discriminator", "resume_target", "invariants",
]);
const OPTIONAL_OVERLAY_KEYS = ["cli_only_commands"];
const PROFILES = new Set(["cli", "embedded"]);
const COMMANDS = new Set([
  "context_resolve", "list", "describe", "read", "query", "snapshot", "poll", "package_upload",
  "delivery_probe", "handoff_create", "handoff_validate", "call", "call_confirm", "batch", "recipe",
]);
const VERSION_GUARDS = new Set(["required", "none"]);
const MISSING_RUNTIME_MODES = new Set([
  "new_application", "existing_application", "linked_project", "ai_workload",
  "plugin_management", "read_only_query",
]);
const SCOPES = new Set(["workspace", "enterprise", "read_only"]);

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function assertEnum(value, values, label) {
  if (!values.has(value)) throw new Error(`${label} is invalid: ${value}`);
}

export function validateRuntimeOverlay(overlay, expectedSkillId = overlay?.skill_id) {
  if (!overlay || typeof overlay !== "object" || Array.isArray(overlay)) throw new Error("runtime overlay must be an object");
  const unknown = Object.keys(overlay).filter((key) => !OVERLAY_KEYS.includes(key) && !OPTIONAL_OVERLAY_KEYS.includes(key));
  if (unknown.length > 0) throw new Error(`unknown overlay key: ${unknown.join(", ")}`);
  const missing = OVERLAY_KEYS.filter((key) => !(key in overlay));
  if (missing.length > 0) throw new Error(`missing overlay key: ${missing.join(", ")}`);
  if (overlay.schema !== "rainskills.runtime-overlay.v1") throw new Error("runtime overlay schema is invalid");
  if (overlay.skill_id !== expectedSkillId || !/^rainbond-[a-z0-9-]+$/.test(overlay.skill_id)) {
    throw new Error(`runtime overlay skill_id is invalid: ${overlay.skill_id}`);
  }
  for (const [label, values, allowed] of [["profiles", overlay.profiles, PROFILES], ["command_set", overlay.command_set, COMMANDS]]) {
    if (!Array.isArray(values) || values.length === 0 || new Set(values).size !== values.length) {
      throw new Error(`${label} must be a non-empty unique array`);
    }
    for (const value of values) assertEnum(value, allowed, label);
  }
  if (overlay.cli_only_commands !== undefined && (!Array.isArray(overlay.cli_only_commands)
    || new Set(overlay.cli_only_commands).size !== overlay.cli_only_commands.length
    || overlay.cli_only_commands.some((value) => !overlay.command_set.includes(value)))) throw new Error("cli_only_commands must be a unique command_set subset");
  for (const command of ["batch", "recipe"]) {
    if (overlay.command_set.includes(command) && !overlay.cli_only_commands?.includes(command)) throw new Error(`${command} must be CLI-only`);
  }
  if (!overlay.profiles.includes("cli")) throw new Error("profiles must include cli");
  assertEnum(overlay.version_guard, VERSION_GUARDS, "version_guard");
  assertEnum(overlay.missing_runtime_mode, MISSING_RUNTIME_MODES, "missing_runtime_mode");
  assertEnum(overlay.scope_discriminator, SCOPES, "scope_discriminator");
  if (typeof overlay.resume_target !== "string" || !overlay.resume_target || overlay.resume_target.length > 80) throw new Error("resume_target is invalid");
  if (!Array.isArray(overlay.invariants) || overlay.invariants.length < 1 || overlay.invariants.length > 5 || overlay.invariants.some((value) => typeof value !== "string" || !value || value.length > 320)) {
    throw new Error("invariants must contain one to five bounded strings");
  }
  if (overlay.command_set.includes("query") && overlay.command_set.length !== 1) throw new Error("query is an exclusive read-only command set");
  if (overlay.command_set.includes("call_confirm") !== overlay.command_set.includes("call")) throw new Error("call and call_confirm must be declared together");
  if (!overlay.profiles.includes("embedded") && overlay.scope_discriminator === "enterprise") throw new Error("enterprise plugin management must support embedded profile");
  return overlay;
}

export function readRuntimeOverlay(sourceRoot, skillId) {
  const overlayPath = path.join(sourceRoot, "contracts", "runtime", "skills", `${skillId}.yaml`);
  return validateRuntimeOverlay(YAML.parse(fs.readFileSync(overlayPath, "utf8")), skillId);
}

function commandArgv(skillId, ...args) {
  return ["node", "<home>/.rainbond/bin/rainskills-tools.js", ...args, "--skill-id", skillId];
}

function buildCommand(skillId, command) {
  if (command === "context_resolve") return {
    argv: commandArgv(skillId, "context", "resolve", "--input", "-"),
    stdin: {
      default: { required: ["enterprise", "workspace"] },
      with_hints: { required: ["enterprise", "workspace"], hints: { team_name: "<team-name>" } },
      with_selection: { required: ["enterprise", "workspace"], selection: { option_id: "<option-id>" } },
    },
  };
  if (command === "list") return { argv: commandArgv(skillId, "list", "--prefix", "<tool-prefix>") };
  if (command === "describe") return { argv: commandArgv(skillId, "describe", "<tool-name>") };
  if (command === "read") return { argv: commandArgv(skillId, "read", "<tool>", "--input", "-"), stdin_schema_source: "tool-catalog" };
  if (command === "query") return { argv: commandArgv(skillId, "query", "<tool>", "--input", "-"), stdin_schema_source: "platform-query-allowlist" };
  if (command === "snapshot") return {
    argv: commandArgv(skillId, "snapshot", "<runtime|app|component|delivery>", "--input", "-"),
    stdin_schema_source: "rainskills.read-snapshot.v1.request",
  };
  if (command === "poll") return {
    argv: commandArgv(skillId, "poll", "<read-tool>", "--input", "-"),
    stdin_schema_source: "rainskills.protected-poll.v1.request",
  };
  if (command === "package_upload") return { argv: commandArgv(skillId, "package-upload", "--archive", "<archive-path>", "--input", "-"), stdin_schema_source: "rainbond_init_package_upload.upload_request" };
  if (command === "delivery_probe") return {
    argv: commandArgv(skillId, "delivery", "probe", "--input", "-"),
    policy_schema_source: "schemas/delivery-probe-policy.schema.yaml",
    stdin_schema_source: "schemas/delivery-probe-input.schema.yaml",
    result_schema_source: "schemas/delivery-probe-result.schema.yaml",
  };
  if (command === "handoff_create") return {
    argv: commandArgv(skillId, "handoff", "create", "--input", "-"),
    stdin_schema_source: "contracts/handoff-context.schema.yaml#create-input",
  };
  if (command === "handoff_validate") return {
    argv: commandArgv(skillId, "handoff", "validate", "--input", "-"),
    stdin_schema_source: "contracts/handoff-context.schema.yaml#validation-input",
  };
  if (["batch", "recipe"].includes(command)) return {
    argv: commandArgv(skillId, command, "--input", "-"),
    confirm_argv: [...commandArgv(skillId, command, "--input", "-"), "--confirm", "<confirmation-id>"],
    stdin_schema_source: command === "batch" ? "schemas/generated/confirmed-batch.schema.yaml" : "schemas/generated/component-recipe.schema.yaml",
  };
  if (command === "call") return { argv: commandArgv(skillId, "call", "<tool>", "--input", "-"), stdin_schema_source: "tool-catalog" };
  if (command === "call_confirm") return { argv: [...commandArgv(skillId, "call", "<tool>", "--input", "-"), "--confirm", "<confirmation-id>"], stdin_schema_source: "same-confirmed-input" };
  throw new Error(`unsupported command: ${command}`);
}

function runtimeContract(packageVersion, overlay) {
  const inputCommands = {};
  for (const command of overlay.command_set) inputCommands[command] = buildCommand(overlay.skill_id, command);
  return {
    schema: "rainskills.single-runtime-contract.v1",
    package_version: `rainskills@${packageVersion}`,
    runtime_status: ["node", "<home>/.rainbond/lib/rainskills/bin/rainskills.js", "runtime", "status", "--json"],
    runtime_connect: {
      saas: ["node", "<home>/.rainbond/lib/rainskills/bin/rainskills.js", "runtime", "connect", "<target>", "--saas"],
      private_existing: ["node", "<home>/.rainbond/lib/rainskills/bin/rainskills.js", "runtime", "connect", "<target>", "--rainbond-url", "<console-origin>"],
      install_private: ["node", "<home>/.rainbond/lib/rainskills/bin/rainskills.js", "runtime", "connect", "<target>", "--install-private", "--location", "<local-or-server>"],
      reconnect: ["node", "<home>/.rainbond/lib/rainskills/bin/rainskills.js", "runtime", "reconnect", "<target>"],
    },
    input_commands: inputCommands,
  };
}

function fillTemplate(template, replacements) {
  let output = template;
  for (const [key, value] of Object.entries(replacements)) output = output.replaceAll(`{{${key}}}`, value);
  const unresolved = output.match(/\{\{[A-Z0-9_]+\}\}/g);
  if (unresolved) throw new Error(`unresolved runtime template value: ${unresolved.join(", ")}`);
  return output;
}

export function renderRuntimeGate({ sourceRoot, packageVersion, overlay, profile }) {
  validateRuntimeOverlay(overlay, overlay.skill_id);
  assertEnum(profile, PROFILES, "profile");
  if (!overlay.profiles.includes(profile)) throw new Error(`${overlay.skill_id} does not support ${profile} profile`);
  const baseName = profile === "cli" ? "cli-base.md" : "embedded-base.md";
  const base = fs.readFileSync(path.join(sourceRoot, "contracts", "runtime", baseName), "utf8");
  const schema = fs.readFileSync(path.join(sourceRoot, "contracts", "runtime", "overlay.schema.json"), "utf8");
  const canonicalOverlay = `${JSON.stringify(overlay, null, 2)}\n`;
  const sourceDigest = sha256(`${base}\0${schema}\0${canonicalOverlay}\0${packageVersion}\0${profile}`);
  const contextGuidance = overlay.command_set.includes("context_resolve")
    ? "`context resolve` 是无状态调用。首次 stdin 固定为 `{\"required\":[\"enterprise\",\"workspace\"]}` 字面请求体；显式 team/region 放入 `hints`，多候选选择通过 `selection.option_id` 重新查询验证。不得执行 `context select` 或写本地 context。所有可变 `call` 必须先取得 confirmation ID，再以完全相同输入追加 `--confirm` 执行一次。"
    : "本 Skill 不解析或持久化 workspace context，也不拥有 mutation 命令；只可执行 overlay 声明的固定只读命令。";
  const versionGuard = overlay.version_guard === "required"
    ? `运行状态的 \`package_version\` 必须与下方 JSON contract 完全一致；缺失或不一致时先执行固定版本 \`rainskills@${packageVersion}\` 的更新/修复流程。不得在版本错配时继续业务调用。`
    : "运行状态必须来自固定 launcher；不得使用未验证的替代 CLI 或传输。";
  const body = fillTemplate(base, {
    VERSION_GUARD: versionGuard,
    CONTEXT_GUIDANCE: contextGuidance,
    SKILL_ID: overlay.skill_id,
    SUPPORTED_PROFILES: overlay.profiles.join(", "),
    COMMAND_SET: overlay.command_set.filter((command) => profile === "cli" || !overlay.cli_only_commands?.includes(command)).join(", "),
    VERSION_GUARD_MODE: overlay.version_guard,
    MISSING_RUNTIME_MODE: overlay.missing_runtime_mode,
    SCOPE_DISCRIMINATOR: overlay.scope_discriminator,
    RESUME_TARGET: overlay.resume_target,
    INVARIANTS: overlay.invariants.map((value) => `- ${value}`).join("\n"),
    CONTRACT_JSON: profile === "cli" ? JSON.stringify(runtimeContract(packageVersion, overlay), null, 2) : "",
  });
  return `<!-- generated-by: scripts/sync-runtime-contracts.mjs -->\n<!-- source-sha256: ${sourceDigest} -->\n<!-- profile: ${profile} -->\n${body.trimEnd()}\n`;
}

function readRoutingModes(sourceRoot) {
  const source = fs.readFileSync(path.join(sourceRoot, "contracts", "runtime", "routing-modes.yaml"), "utf8");
  const parsed = YAML.parse(source);
  if (parsed?.schema !== "rainskills.runtime-routing-modes.v1" || !parsed.modes || typeof parsed.modes !== "object") {
    throw new Error("runtime routing modes schema is invalid");
  }
  const actualModes = Object.keys(parsed.modes).sort();
  const expectedModes = [...MISSING_RUNTIME_MODES].sort();
  if (JSON.stringify(actualModes) !== JSON.stringify(expectedModes)) throw new Error("runtime routing mode set is incomplete");
  for (const [mode, config] of Object.entries(parsed.modes)) {
    if (
      !config
      || typeof config.message_id !== "string"
      || !config.message_id
      || !Array.isArray(config.choices)
      || config.choices.length < 2
      || config.choices.some((choice) => typeof choice !== "string" || !choice)
      || typeof config.allow_install_private !== "boolean"
    ) {
      throw new Error(`runtime routing mode is invalid: ${mode}`);
    }
  }
  return { parsed, source };
}

export function renderRuntimeRouting({ sourceRoot, overlay, profile }) {
  validateRuntimeOverlay(overlay, overlay.skill_id);
  assertEnum(profile, PROFILES, "profile");
  if (!overlay.profiles.includes(profile)) throw new Error(`${overlay.skill_id} does not support ${profile} profile`);
  const { parsed, source } = readRoutingModes(sourceRoot);
  const mode = parsed.modes[overlay.missing_runtime_mode];
  const canonicalOverlay = `${JSON.stringify(overlay, null, 2)}\n`;
  const sourceDigest = sha256(`${source}\0${canonicalOverlay}\0${profile}`);
  const header = [
    "<!-- generated-by: scripts/sync-runtime-contracts.mjs -->",
    `<!-- source-sha256: ${sourceDigest} -->`,
    `<!-- profile: ${profile} -->`,
    "<!-- rainskills-runtime-routing:start -->",
    "# 缺少运行环境时（生成文件）",
    "",
    `- \`skill_id\`: \`${overlay.skill_id}\``,
    `- \`missing_runtime_mode\`: \`${overlay.missing_runtime_mode}\``,
    `- \`resume_target\`: \`${overlay.resume_target}\``,
    "",
  ];
  if (profile === "embedded") {
    return [...header,
      "当前会话缺少所需 `rainbond_*` Tool 时立即停止，说明需要由 Agent 管理员恢复服务端 Rainbond 连接。不得展示客户端环境菜单、运行本机命令、索取凭据或切换传输。",
      "",
      "<!-- rainskills-runtime-routing:end -->",
      "",
    ].join("\n");
  }
  const body = [];
  if (overlay.missing_runtime_mode === "new_application") {
    body.push("意图不明确时，只问用户是在部署新应用还是管理已有应用；确认前不连接运行环境，也不展示选项。", "");
    if (overlay.skill_id === "rainbond-app-assistant") {
      body.push(
        "仅当 `runtime status --json` 明确返回 `state=not_started` 且 `usable=false` 时进入本路由。只有当前本地项目且目录可读取时才读取 [local project analysis](../local-project-analysis.md)，完成只读分析并输出“已识别”和“预计交付结果”；不得写项目文件、联网或调用 Rainbond。",
        "裸 Git URL、镜像引用、软件包或归档文件必须跳过本地预分析，直接进入后续环境选择；市场模板和第三方开源套件由各自所属 Skill 处理，也不得在此触发预分析。",
        "",
        "`state=connected` 且 `usable=true` 时直接恢复 `project-deployment`，不得执行本地预分析，也不得展示环境菜单。版本错配、状态命令失败、连接中或已有环境但 live probe 失败时按 Runtime Gate 修复或停止，不得当作没有运行环境。",
        "",
        `完成上述可选分析后，执行固定 launcher 的 \`runtime message --id ${mode.message_id}\`，只原样转发消息 marker 之间的正文。然后只显示：`,
      );
    } else {
      body.push(
        `新应用请求执行固定 launcher 的 \`runtime message --id ${mode.message_id}\`，只原样转发消息 marker 之间的正文。然后只显示：`,
      );
    }
    body.push(
      "",
      ...mode.choices.map((choice, index) => `${index + 1}) ${choice}`),
      "",
      "选择 Rainbond Cloud 云端环境时连接 Rainbond Cloud；选择独立服务器时使用 `--install-private --location server`；选择本机环境时使用 `--install-private --location local`；选择已有 Rainbond 时先执行 `runtime message --id private-console-origin`，再连接用户给出的 Console origin。不得增加私有环境子菜单。",
    );
  } else {
    body.push(
      `只让用户选择 \`${mode.choices[0]}\` 或 \`${mode.choices[1]}\`。已有私有 Rainbond 使用固定 launcher 的 \`runtime message --id ${mode.message_id}\` 获取 Console origin；不得安装新平台，也不得用新平台代替目标资源。`,
    );
  }
  body.push(
    "",
    `连接和 live probe 成功后恢复到 \`${overlay.resume_target}\`；不得提前询问无关业务字段，也不得保存环境 ID、operation ID 或 intent JSON。`,
    "",
    "<!-- rainskills-runtime-routing:end -->",
    "",
  );
  return [...header, ...body].join("\n");
}

function writeAtomically(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o755 });
  const temporary = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, content, { encoding: "utf8", mode: 0o644 });
  fs.renameSync(temporary, filePath);
}

export function syncRuntimeContracts({ sourceRoot, check = false, profile = "cli", skillIds = RUNTIME_SKILL_IDS }) {
  const packageInfo = JSON.parse(fs.readFileSync(path.join(sourceRoot, "package.json"), "utf8"));
  const stale = [];
  for (const skillId of skillIds) {
    const overlay = readRuntimeOverlay(sourceRoot, skillId);
    if (!overlay.profiles.includes(profile)) continue;
    const expected = renderRuntimeGate({ sourceRoot, packageVersion: packageInfo.version, overlay, profile });
    const generatedPath = path.join(sourceRoot, skillId, "references", "generated", "runtime-gate.md");
    const current = fs.existsSync(generatedPath) ? fs.readFileSync(generatedPath, "utf8") : null;
    if (current !== expected) {
      stale.push(path.relative(sourceRoot, generatedPath));
      if (!check) writeAtomically(generatedPath, expected);
    }
    const expectedRouting = renderRuntimeRouting({ sourceRoot, overlay, profile });
    const generatedRoutingPath = path.join(sourceRoot, skillId, "references", "generated", "runtime-routing.md");
    const currentRouting = fs.existsSync(generatedRoutingPath) ? fs.readFileSync(generatedRoutingPath, "utf8") : null;
    if (currentRouting !== expectedRouting) {
      stale.push(path.relative(sourceRoot, generatedRoutingPath));
      if (!check) writeAtomically(generatedRoutingPath, expectedRouting);
    }
    if (profile === "cli") {
      const entrypoint = fs.readFileSync(path.join(sourceRoot, skillId, "SKILL.md"), "utf8");
      if (entrypoint.includes("<!-- rainskills-runtime-gate:start -->")) throw new Error(`${skillId} source SKILL.md still embeds the complete Runtime Gate`);
      if (!entrypoint.includes("references/generated/runtime-gate.md")) throw new Error(`${skillId} source SKILL.md does not load its generated Runtime Gate`);
      if (entrypoint.includes("<!-- rainskills-runtime-routing:start -->")) throw new Error(`${skillId} source SKILL.md still embeds Runtime Routing`);
      if (!entrypoint.includes("references/generated/runtime-routing.md")) throw new Error(`${skillId} source SKILL.md does not load generated Runtime Routing`);
      if (fs.existsSync(path.join(sourceRoot, skillId, "references", "runtime-gate.md"))) throw new Error(`${skillId} retains a legacy editable Runtime Gate`);
      if (fs.existsSync(path.join(sourceRoot, skillId, "references", "runtime-routing.md"))) throw new Error(`${skillId} retains legacy editable Runtime Routing`);
    }
  }
  if (check && stale.length > 0) throw new Error(`generated Runtime Gate is stale: ${stale.join(", ")}`);
  return stale;
}
