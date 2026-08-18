#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EMBEDDED_SKILLS = [
  "rainbond-app-assistant",
  "rainbond-app-version-assistant",
  "rainbond-delivery-verifier",
  "rainbond-fullstack-bootstrap",
  "rainbond-fullstack-troubleshooter",
  "rainbond-platform-query",
  "rainbond-template-installer",
];
const EXCLUDED_SUBTREES = new Set([
  "evals",
  "runs",
  "scripts",
  "tests",
  "__pycache__",
]);
const EMBEDDED_RUNTIME_CONTRACT = {
  platform_transport: "mcp",
  endpoint_class: "rainbond_agent_mcp",
  client_workspace: "unavailable",
  local_package_upload: "unsupported",
  configuration_sources: [
    "explicit_input",
    "session_context",
    "platform_tools",
  ],
  unavailable_behavior: "stop_and_report",
};
const FORBIDDEN_EMBEDDED_MARKERS = [
  "rainskills-tools.js",
  "credentials.env",
  "mcp.env",
  "--api-only",
  "/console/mcp/rainskills/api/query",
];

function usage() {
  return [
    "Usage: node scripts/build-skill-profile.mjs --profile embedded --output <directory>",
    "       [--source-root <directory>] [--revision <sha-or-version>]",
  ].join("\n");
}

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") return { help: true };
    if (!new Set(["--profile", "--output", "--source-root", "--revision"]).has(arg)) {
      throw new Error(`unknown argument: ${arg}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`missing value for ${arg}`);
    values[arg.slice(2).replace(/-/g, "_")] = value;
    index += 1;
  }
  if (values.profile !== "embedded") {
    throw new Error("unsupported profile: only 'embedded' is supported");
  }
  if (!values.output) throw new Error("--output is required");
  return values;
}

function resolveRevision(sourceRoot, explicitRevision) {
  if (explicitRevision) return explicitRevision;
  try {
    return execFileSync("git", ["-C", sourceRoot, "rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "unversioned";
  }
}

function assertEmptyOutput(outputRoot) {
  if (!fs.existsSync(outputRoot)) return;
  if (!fs.statSync(outputRoot).isDirectory()) {
    throw new Error(`output path is not a directory: ${outputRoot}`);
  }
  if (fs.readdirSync(outputRoot).length > 0) {
    throw new Error(`output directory must be empty: ${outputRoot}`);
  }
}

function copySkill(source, destination) {
  fs.cpSync(source, destination, {
    recursive: true,
    filter: (entry) => !EXCLUDED_SUBTREES.has(path.basename(entry)),
  });
}

function markdownFiles(root) {
  const files = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...markdownFiles(entryPath));
    else if (entry.name.endsWith(".md")) files.push(entryPath);
  }
  return files;
}

function transformEmbeddedNarrative(content) {
  return content.replace(
    "user-level home directories as a whole (`~/.codex`, `~/.claude`, `~/.rainbond`, `~/.cache`, etc.). Only specific named files such as `~/.rainbond/credentials.env` are allowed when explicitly required by a configured workflow step.",
    "user-level home directories (`~/.codex`, `~/.claude`, `~/.rainbond`, `~/.cache`, etc.) and all named files under them. The embedded runtime never reads client credential files."
  ).replace(/\[([^\]]+)\]\((?:scripts|evals)\/[^)]*\)/g, "$1");
}

function replaceRequired(content, expression, replacement, label) {
  const updated = content.replace(expression, replacement);
  if (updated === content) {
    throw new Error(`embedded profile transform could not find ${label}`);
  }
  return updated;
}

function embeddedTransportSection() {
  return [
    "## Rainbond 传输",
    "",
    "这是 **embedded profile**。只使用本次会话由 rainbond-agent 暴露的 `rainbond_*` Rainbond Tool；不运行 shell、Node、curl 或本机 CLI 作为平台调用通道。",
    "",
    "- server-side transport、身份委托、审批、审计、超时与轮询保护由 Agent 执行器负责；不得要求用户安装客户端或提供凭据。",
    "- 只要会话 Tool 可用，本工作流在结束前复用该会话能力；认证、网络或业务错误时停止并报告平台事实，不尝试替代传输或重复写操作。",
    "- 写操作超时或结果未知时禁止重放；先使用同一会话的查询 Tool 核实平台事实。",
    "",
  ].join("\n");
}

function embeddedTopLevelPreflight() {
  return [
    "  ## Rainbond Transport Preflight（最高优先级）",
    "",
    "  这是 **embedded profile**。在读取下层 Skill、扫描项目或执行 Rainbond 业务操作前，确认本会话已暴露所需的 `rainbond_*` Rainbond Tool。",
    "",
    "  1. 不运行 shell、Node、curl 或本机 CLI，也不读取客户端凭据文件。",
    "  2. 会话 Tool 可用时，选择 `embedded` 并在工作流结束前保持不变；服务端负责身份委托、审批、审计与传输。",
    "  3. Tool 不可用、认证或网络异常时立即停止，报告需由 Agent 管理员恢复服务端 Rainbond 连接；不得要求用户粘贴 Token/JWT 或尝试替代调用通道。",
    "  4. 写操作超时或结果未知时禁止重放，先用同一会话的查询 Tool 核实平台事实。",
    "",
  ].join("\n");
}

function embeddedRuntimeSection() {
  return [
    "  ## Agent Runtime Boundary（高优先级）",
    "",
    "  本 Skill 运行在 rainbond-agent 的 **embedded profile** 中。平台能力由服务端会话 Tool 提供；不得指导用户安装本机 Skill、配置客户端、粘贴 JWT，或执行 shell/Node/curl 命令来绕过服务端控制。",
    "",
    "  若会话中缺少所需 Rainbond Tool，停止并说明需要由 Agent 管理员恢复服务端 Rainbond 连接；本轮不进行客户端安装或凭据恢复流程。",
    "",
  ].join("\n");
}

function embeddedTransportReference() {
  return [
    "# Rainbond embedded transport policy",
    "",
    "本文件只适用于 `profile=embedded` 产物。它不改变业务顺序、权限或停止条件。",
    "",
    "## 固定规则",
    "",
    "- 只调用当前会话提供的 `rainbond_*` Tool；不运行 shell、Node、curl 或本机 CLI。",
    "- 服务端负责授权、审批、审计、幂等保护、超时与轮询限制；用户不提供或粘贴凭据。",
    "- 会话 Tool 不可用、认证失败、网络错误或超时时停止并报告服务端连接状态；不切换到另一条传输。",
    "- 写操作结果未知时不重放，先查询平台事实；审批或服务端拒绝必须如实报告。",
    "- 不把完整 Tool 输出、内部 ID、连接配置或 Secret 原样复述给用户。",
    "",
  ].join("\n");
}

function embeddedRuntimeContractSection() {
  return [
    "## Embedded Runtime Contract（最高优先级）",
    "",
    "本 Skill 仅运行在 rainbond-agent 的 embedded runtime 中。本节覆盖本文件及其 modules/references 内与此冲突的客户端假设。",
    "",
    "- 平台操作只通过当前会话的 `rainbond_*` Tool 执行；服务端负责身份委托、审批、审计、超时与轮询保护。",
    "- 不读取本机项目目录或 `.rainbond/` 文件，不读取用户主目录、凭据或环境变量，也不运行 shell、Node、curl 或本机 CLI。",
    "- 配置与上下文只可来自：用户明确输入、当前 UI/会话上下文、或同一会话 Tool 返回的平台事实。缺少这些信息时先询问，不得从客户端文件推断。",
    "- 本地目录打包、客户端上传、`source.local_path` 与本地 helper 在 embedded runtime 中均不支持；需要本地工作区能力时停止并明确交由本机 CLI profile 完成。",
    "- Tool 不可用、认证/网络失败，或写操作结果未知时停止并报告；写操作不重放，先用查询 Tool 核实平台事实。",
    "",
  ].join("\n");
}

function insertEmbeddedRuntimeContract(content, skillName) {
  return replaceRequired(
    content,
    /^(---\n[\s\S]*?\n---\n)/,
    `$1\n${embeddedRuntimeContractSection()}`,
    `${skillName} embedded runtime contract`
  );
}

function transformSkill(skillName, content) {
  let transformed = content;
  if (skillName === "rainbond-app-assistant") {
    transformed = replaceRequired(
      transformed,
      /  ## Rainbond Transport Preflight（最高优先级）[\s\S]*?(?=  ## Installation Intent（高优先级）)/,
      embeddedTopLevelPreflight(),
      "top-level transport preflight"
    );
    transformed = replaceRequired(
      transformed,
      /  ## Installation Intent（高优先级）[\s\S]*?(?=  ## 硬规则)/,
      embeddedRuntimeSection(),
      "top-level installation intent"
    );
    transformed = transformed.replace(
      "Uses the installed RainSkills CLI for platform actions.",
      "Uses the session-provided Rainbond tools for platform actions."
    );
    transformed = transformed.replace(
      "主要服务 CLI / Codex 端使用者",
      "主要服务本机 profile 使用者"
    );
  } else {
    transformed = replaceRequired(
      transformed,
      /## Rainbond 传输\n[\s\S]*?(?=## )/,
      embeddedTransportSection(),
      `${skillName} transport section`
    );
  }

  if (skillName === "rainbond-fullstack-bootstrap") {
    transformed = replaceRequired(
      transformed,
      /- \*\*Profile before create\*\*: when the `rainbond_get_project_source_profile` tool is available in this session \(rainagent runtime\), you MUST call it once for the repository before the FIRST `rainbond_create_component_from_source` of that repository, and fill creation parameters from the profile \(subdirectories, default branch, dockerfile preference, ports, env keys\)\. In CLI runtimes without that tool, derive the same facts by reading the local project files before creating\. Creating source components by guess is forbidden\./,
      "- **Profile before create**: call `rainbond_get_project_source_profile` once for the repository before the FIRST `rainbond_create_component_from_source`, and fill creation parameters from the profile (subdirectories, default branch, dockerfile preference, ports, env keys). If the Tool is unavailable or the profile is incomplete, stop and request the missing source facts; creating source components by guess is forbidden.",
      "embedded source-profile prerequisite"
    );
  }
  transformed = replaceRequired(
    transformed,
    /^---\n/,
    "---\nmode: embedded\n",
    `${skillName} frontmatter`
  );
  return insertEmbeddedRuntimeContract(transformed, skillName);
}

function assertEmbeddedSafe(root) {
  for (const markdownFile of markdownFiles(root)) {
    const content = fs.readFileSync(markdownFile, "utf8");
    for (const marker of FORBIDDEN_EMBEDDED_MARKERS) {
      if (content.includes(marker)) {
        throw new Error(
          `embedded profile contains forbidden '${marker}' in ${path.relative(root, markdownFile)}`
        );
      }
    }
  }
}

function buildEmbeddedProfile({ source_root: sourceRoot, output, revision }) {
  const resolvedSource = path.resolve(sourceRoot || scriptRoot);
  const resolvedOutput = path.resolve(output);
  assertEmptyOutput(resolvedOutput);
  fs.mkdirSync(resolvedOutput, { recursive: true, mode: 0o700 });

  for (const skillName of EMBEDDED_SKILLS) {
    const source = path.join(resolvedSource, skillName);
    const destination = path.join(resolvedOutput, skillName);
    if (!fs.existsSync(path.join(source, "SKILL.md"))) {
      throw new Error(`source skill is missing: ${skillName}`);
    }
    copySkill(source, destination);
    for (const markdownFile of markdownFiles(destination)) {
      const original = fs.readFileSync(markdownFile, "utf8");
      const sanitized = transformEmbeddedNarrative(original);
      if (sanitized !== original) fs.writeFileSync(markdownFile, sanitized, "utf8");
    }
    const skillFile = path.join(destination, "SKILL.md");
    const transformed = transformSkill(skillName, fs.readFileSync(skillFile, "utf8"));
    fs.writeFileSync(skillFile, transformed, { encoding: "utf8", mode: 0o600 });
  }

  const referencePath = path.join(
    resolvedOutput,
    "rainbond-app-assistant",
    "references",
    "transport-resolution.md"
  );
  fs.writeFileSync(referencePath, embeddedTransportReference(), { encoding: "utf8", mode: 0o600 });
  assertEmbeddedSafe(resolvedOutput);

  const manifest = {
    manifest_version: 1,
    profile: "embedded",
    source_revision: resolveRevision(resolvedSource, revision),
    generator_version: 1,
    skills: EMBEDDED_SKILLS,
    runtime_contract: EMBEDDED_RUNTIME_CONTRACT,
  };
  fs.writeFileSync(
    path.join(resolvedOutput, "rainskills-profile.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 }
  );
}

try {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
  } else {
    buildEmbeddedProfile(options);
  }
} catch (error) {
  process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
