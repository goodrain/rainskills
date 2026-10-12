#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import YAML from "yaml";
import { EXPECTED_SKILLS, canonicalJson, loadEffectCases, sha256 } from "./validate-effect-evals.mjs";
import { buildSkillManifest } from "./build-skill-manifest.mjs";

const HOST_SCHEMA = "rainskills.codex-host-evals.v2";
const ARTIFACT_MAX_BYTES = 10 * 1024 * 1024;
const WRITE_SCENARIOS = new Set([
  "deploy-current-project",
  "deploy-bare-git",
  "create-three-component-topology",
  "diagnose-missing-dependency",
  "initialize-monorepo",
  "install-plugin-and-resume-ai",
  "reject-unsupported-multimodal-bypass",
]);
const TOOL_ITEM_PATTERN = /(?:command|tool|mcp|web_search|computer|file_change)/i;
const require = createRequire(import.meta.url);

function unavailableValue() {
  return "unavailable";
}

function unavailableUsage() {
  return {
    status: "unavailable",
    source: "unavailable",
    input_tokens: null,
    cached_input_tokens: null,
    cache_write_input_tokens: null,
    uncached_input_tokens: null,
    output_tokens: null,
    reasoning_output_tokens: null,
    total_tokens: null,
    cache_hit_ratio: null,
  };
}

export function unavailableScenario({ scenarioId, reason, runRole = "baseline" }) {
  return {
    scenario_id: scenarioId,
    benchmark_layer: "codex_host",
    data_source: "unavailable",
    run_role: runRole,
    timing: {
      process_exit_ms: unavailableValue(),
      turn_completed_ms: unavailableValue(),
      first_event_ms: unavailableValue(),
      first_tool_ms: unavailableValue(),
      first_user_progress_ms: unavailableValue(),
      tool_wall_time_ms: unavailableValue(),
      orchestration_and_tool_ms: unavailableValue(),
      external_platform_wait_ms: unavailableValue(),
    },
    host_turns: 0,
    model_roundtrips: unavailableValue(),
    retry_calls: 0,
    tool_calls: 0,
    poll_calls: 0,
    skills_opened: [],
    references_opened: [],
    reference_reads: {
      status: "unavailable",
      measurement_basis: "completed direct sed/cat reads of references or modules",
      total: null,
      repeated: null,
      bytes: null,
      unique_paths: [],
      unresolved: null,
    },
    messages: {
      final_answer_chars: null,
      visible_progress_chars: null,
      visible_progress_messages: null,
      per_message_tokens: unavailableValue(),
    },
    usage: unavailableUsage(),
    compaction_count: unavailableValue(),
    result: "unavailable",
    outcome_signature: null,
    unavailable_reason: reason,
    behavior_assertions: [],
  };
}

function characterCount(value) {
  return [...String(value)].length;
}

function normalizedObservedPath(value) {
  return value.replace(/^\.\//, "");
}

function referenceReadOperations(command) {
  const operations = [];
  const documentPath = String.raw`([^\s;&|"']+\/(?:references|modules)\/[^\s;&|"']+\.md)`;
  const sed = new RegExp(String.raw`sed\s+-n\s+['"](\d+),(\d+)p['"]\s+${documentPath}`, "g");
  for (const match of String(command).matchAll(sed)) {
    operations.push({ path: normalizedObservedPath(match[3]), start: Number(match[1]), end: Number(match[2]) });
  }
  const cat = new RegExp(String.raw`(?:^|[;&|]\s*)cat\s+${documentPath}`, "g");
  for (const match of String(command).matchAll(cat)) {
    operations.push({ path: normalizedObservedPath(match[1]), start: null, end: null });
  }
  return operations;
}

function selectedFileBytes(workspace, operation) {
  if (!workspace) return null;
  const absolute = path.resolve(workspace, operation.path);
  const relative = path.relative(workspace, absolute);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
  const stat = fs.statSync(absolute, { throwIfNoEntry: false });
  if (!stat?.isFile()) return null;
  const content = fs.readFileSync(absolute);
  if (operation.start === null) return content.length;
  const lines = content.toString("utf8").match(/[^\n]*\n|[^\n]+$/g) || [];
  return Buffer.byteLength(lines.slice(operation.start - 1, operation.end).join(""));
}

function observedReferenceReads(timedEvents, workspace) {
  const operations = timedEvents.flatMap(({ event }) => {
    if (event.type !== "item.completed" || event.item?.type !== "command_execution") return [];
    return referenceReadOperations(event.item.command || "");
  });
  let unresolved = 0;
  let bytes = 0;
  for (const operation of operations) {
    const selectedBytes = selectedFileBytes(workspace, operation);
    if (selectedBytes === null) unresolved += 1;
    else bytes += selectedBytes;
  }
  const uniquePaths = [...new Set(operations.map((operation) => operation.path))].sort();
  return {
    status: unresolved === 0 ? "observed" : "partially_observed",
    measurement_basis: "completed direct sed/cat reads of references or modules",
    total: operations.length,
    repeated: operations.length - uniquePaths.length,
    bytes,
    unique_paths: uniquePaths,
    unresolved,
  };
}

function commandOperation(command) {
  const match = String(command).match(/rainskills-tools\.js\s+(read|snapshot|poll|call|handoff|context|status)\b/);
  return match ? `rainskills_${match[1]}` : "command_other";
}

function isToolItem(event) {
  return event?.item?.type && TOOL_ITEM_PATTERN.test(event.item.type)
    && event.item.type !== "agent_message";
}

function intervalUnion(intervals) {
  if (!intervals.length) return 0;
  const sorted = [...intervals].sort((left, right) => left[0] - right[0]);
  let total = 0;
  let [start, end] = sorted[0];
  for (const [nextStart, nextEnd] of sorted.slice(1)) {
    if (nextStart <= end) {
      end = Math.max(end, nextEnd);
      continue;
    }
    total += end - start;
    [start, end] = [nextStart, nextEnd];
  }
  return total + end - start;
}

function observedPaths(timedEvents) {
  const skillPaths = new Set();
  const referencePaths = new Set();
  for (const { event } of timedEvents) {
    const text = JSON.stringify(event);
    for (const match of text.matchAll(/(?:[A-Za-z0-9._/-]+\/)?SKILL\.md/g)) skillPaths.add(match[0]);
    for (const match of text.matchAll(/[A-Za-z0-9._/-]+\/references\/[A-Za-z0-9._/-]+\.md/g)) {
      referencePaths.add(match[0]);
    }
  }
  return {
    skills: [...skillPaths].sort(),
    references: [...referencePaths].sort(),
  };
}

export function normalizeCodexRun({ timedEvents, processExitMs, exitCode, timedOut = false, workspace = null }) {
  const toolStarts = new Map();
  const toolIntervals = [];
  let firstItem = null;
  let firstTool = null;
  let turnCompleted = null;
  let usageEvent = null;
  const agentMessages = [];
  let toolCalls = 0;
  let pollCalls = 0;
  let retryCalls = 0;
  let turnStarts = 0;
  let compactionCount = 0;
  const toolCallsByCategory = {};
  const toolCallsByOperation = {};

  for (const { received_ms: receivedMs, event } of timedEvents) {
    if (event.type === "turn.started") turnStarts += 1;
    if (event.type === "error" && /reconnecting/i.test(String(event.message || ""))) retryCalls += 1;
    if ((event.type === "item.started" || event.type === "item.completed") && firstItem === null) {
      firstItem = receivedMs;
    }
    if (event.type === "item.started" && isToolItem(event)) {
      toolCalls += 1;
      toolCallsByCategory[event.item.type] = (toolCallsByCategory[event.item.type] || 0) + 1;
      const operation = event.item.type === "command_execution"
        ? commandOperation(event.item.command)
        : event.item.type;
      toolCallsByOperation[operation] = (toolCallsByOperation[operation] || 0) + 1;
      if (firstTool === null) firstTool = receivedMs;
      toolStarts.set(event.item.id, receivedMs);
      if (/poll|write_stdin/i.test(JSON.stringify(event.item))) pollCalls += 1;
    }
    if (event.type === "item.completed" && isToolItem(event)) {
      const start = toolStarts.get(event.item.id);
      if (start !== undefined) toolIntervals.push([start, receivedMs]);
    }
    if (event.type === "item.completed" && event.item?.type === "agent_message") {
      agentMessages.push({ receivedMs, text: event.item.text || "" });
    }
    if (event.type === "turn.completed") {
      turnCompleted = receivedMs;
      usageEvent = event.usage || null;
    }
    if (/compact/i.test(String(event.type))) compactionCount += 1;
  }

  let usage = unavailableUsage();
  if (usageEvent) {
    const input = usageEvent.input_tokens;
    const cached = usageEvent.cached_input_tokens ?? 0;
    const cacheWrite = usageEvent.cache_write_input_tokens ?? 0;
    const output = usageEvent.output_tokens;
    const reasoning = usageEvent.reasoning_output_tokens ?? 0;
    if ([input, cached, cacheWrite, output, reasoning].every((value) => Number.isSafeInteger(value) && value >= 0)
      && cached <= input && reasoning <= output) {
      usage = {
        status: "observed",
        source: "codex_exec_json",
        input_tokens: input,
        cached_input_tokens: cached,
        cache_write_input_tokens: cacheWrite,
        uncached_input_tokens: input - cached,
        output_tokens: output,
        reasoning_output_tokens: reasoning,
        total_tokens: input + output,
        cache_hit_ratio: input === 0 ? 0 : cached / input,
      };
    }
  }
  const paths = observedPaths(timedEvents);
  const referenceReads = observedReferenceReads(timedEvents, workspace);
  paths.references = referenceReads.unique_paths;
  const finalMessage = agentMessages.at(-1)?.text || "";
  const progressMessages = agentMessages.slice(0, -1);
  const result = timedOut
    ? "failed"
    : exitCode !== 0
      ? "failed"
      : /(?:blocked|cannot continue|无法继续|缺少受控|需要用户)/i.test(finalMessage)
        ? "blocked"
        : "success";
  return {
    timing: {
      process_exit_ms: processExitMs,
      turn_completed_ms: turnCompleted ?? unavailableValue(),
      first_event_ms: firstItem ?? unavailableValue(),
      first_tool_ms: firstTool ?? unavailableValue(),
      first_user_progress_ms: agentMessages.length > 1
        ? agentMessages[0].receivedMs
        : unavailableValue(),
      tool_wall_time_ms: intervalUnion(toolIntervals),
      orchestration_and_tool_ms: unavailableValue(),
      external_platform_wait_ms: unavailableValue(),
    },
    host_turns: Math.max(turnStarts, usageEvent ? 1 : 0),
    model_roundtrips: unavailableValue(),
    retry_calls: retryCalls,
    tool_calls: toolCalls,
    tool_calls_by_category: toolCallsByCategory,
    tool_calls_by_operation: toolCallsByOperation,
    poll_calls: pollCalls,
    skills_opened: paths.skills,
    references_opened: paths.references,
    reference_reads: referenceReads,
    messages: {
      final_answer_chars: characterCount(finalMessage),
      visible_progress_chars: progressMessages.reduce((sum, message) => sum + characterCount(message.text), 0),
      visible_progress_messages: progressMessages.length,
      per_message_tokens: unavailableValue(),
    },
    usage,
    compaction_count: compactionCount || unavailableValue(),
    result,
    final_message: finalMessage || null,
  };
}

function recursiveFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (["__pycache__", ".DS_Store"].includes(entry.name) || entry.name.endsWith(".pyc")) return [];
    const absolute = path.join(directory, entry.name);
    return entry.isDirectory() ? recursiveFiles(absolute) : [absolute];
  });
}

function directoryDigest(directory) {
  const hash = crypto.createHash("sha256");
  for (const file of recursiveFiles(directory).sort()) {
    hash.update(path.relative(directory, file));
    hash.update("\0");
    hash.update(fs.readFileSync(file));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function copySkillBundles(root, workspace) {
  const target = path.join(workspace, ".codex", "skills");
  fs.mkdirSync(target, { recursive: true });
  for (const skillId of EXPECTED_SKILLS) {
    const destination = path.join(target, skillId);
    if (skillId === "rainskills") {
      fs.mkdirSync(destination, { recursive: true });
      fs.copyFileSync(path.join(root, "SKILL.md"), path.join(destination, "SKILL.md"));
      if (fs.existsSync(path.join(root, "agents"))) {
        fs.cpSync(path.join(root, "agents"), path.join(destination, "agents"), { recursive: true });
      }
      continue;
    }
    fs.cpSync(path.join(root, skillId), destination, {
      recursive: true,
      filter: (source) => !source.includes(`${path.sep}__pycache__`)
        && !source.endsWith(".pyc")
        && !source.endsWith(".DS_Store"),
    });
  }
  return { path: target, digest: directoryDigest(target) };
}

export function prepareIsolatedCodexEnvironment({ workspace, baseEnvironment, authSource }) {
  const isolatedHome = path.join(workspace, ".isolated-home");
  const isolatedCodexHome = path.join(workspace, ".isolated-codex-home");
  fs.mkdirSync(isolatedHome, { recursive: true, mode: 0o700 });
  fs.mkdirSync(isolatedCodexHome, { recursive: true, mode: 0o700 });
  fs.chmodSync(isolatedHome, 0o700);
  fs.chmodSync(isolatedCodexHome, 0o700);
  let authCopied = false;
  if (authSource) {
    const sourceStat = fs.statSync(authSource, { throwIfNoEntry: false });
    if (sourceStat?.isFile()) {
      const target = path.join(isolatedCodexHome, "auth.json");
      fs.copyFileSync(authSource, target);
      fs.chmodSync(target, 0o600);
      authCopied = true;
    }
  }
  const childEnvironment = {
    ...baseEnvironment,
    HOME: isolatedHome,
    CODEX_HOME: isolatedCodexHome,
    XDG_CONFIG_HOME: path.join(isolatedHome, ".config"),
    XDG_CACHE_HOME: path.join(isolatedHome, ".cache"),
    XDG_DATA_HOME: path.join(isolatedHome, ".local", "share"),
    RAINSKILLS_TELEMETRY_DISABLED: "1",
    RAINSKILLS_CREDENTIAL_SOURCE: "environment",
    RAINBOND_URL: "",
    RAINBOND_JWT: "",
  };
  for (const name of Object.keys(childEnvironment)) {
    if (name.startsWith("CODEX_") && name !== "CODEX_HOME") delete childEnvironment[name];
  }
  delete childEnvironment.OPENAI_API_KEY;
  delete childEnvironment.OPENAI_API_KEY_PATH;
  return { childEnvironment, isolatedHome, isolatedCodexHome, authCopied };
}

function gitState(root) {
  const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  const status = execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" });
  return { sha, clean: status.trim() === "" };
}

function parseScenarioConfig(root) {
  const document = YAML.parse(fs.readFileSync(
    path.join(root, "benchmarks", "skill-performance", "scenarios.yaml"),
    "utf8",
  ));
  return document.scenarios;
}

function makePrompt(effectCase, entrySkill, options) {
  const prefix = options.fixtureOnly
    ? [
        "This is a read-only fixture-only Codex host evaluation.",
        `Use the $${entrySkill} Skill from the isolated candidate bundle.`,
        "Do not call Rainbond, network, web, browser, shell, or any external tool. Do not modify files.",
        "Analyze the request using only the Skill and the hash-pinned policy fixture. State the initial owner, any allowed handoff, the safety stop, and the expected outcome concisely.",
      ]
    : options.controlledLive
      ? [
        "This is a controlled disposable Rainbond end-to-end evaluation.",
        `Use the $${entrySkill} Skill from the isolated repository bundle and follow its allowed handoffs.`,
        `For this isolated benchmark, run the runtime preflight only as: node ${options.liveCliPath} status --skill-id rainbond-app-assistant.`,
        `Use business operations only through the protected CLI at ${options.liveCliPath}; do not use curl, direct HTTP, a browser, or any other network path.`,
        `The user authorizes creating and mutating only the exact disposable app ${options.liveAppName} in team ${options.liveTeamName} and region ${options.liveRegionName}.`,
        `Use image ${options.liveImage} for one component named ${options.liveComponentName}; configure container port ${options.liveContainerPort}, deploy it, wait with bounded polling, and verify delivery when the platform provides an address.`,
        "Required milestones for both variants: explicitly activate project-init and create rainbond.app.json plus .rainbond/local.json for this exact image component; activate bootstrap; create and deploy the topology; expose port 80; wait for bounded convergence; then activate delivery-verifier and verify the user URL.",
        "Do not activate troubleshooter unless fresh health evidence is abnormal. Do not list the entire tool catalog or describe a Tool whose schema is already given by the active Skill.",
        "Do not touch any pre-existing app or component. Do not delete the disposable app; the harness performs exact-name cleanup after the run.",
        "Do not expose credentials or environment variables. Keep progress and the final result concise.",
      ]
      : [
        `Use the $${entrySkill} Skill from the isolated candidate bundle.`,
        "This run is read-only. Do not perform mutations; stop when the request would require a controlled Rainbond write environment.",
      ];
  return [...prefix, "User request:", effectCase.prompt].join("\n\n");
}

function safeWrite(file, content) {
  fs.writeFileSync(file, content, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

function redactArtifactText(value) {
  return String(value)
    .replace(/sk-[A-Za-z0-9_*.-]{16,}/g, "<redacted-api-key>")
    .replace(/\b(?:Bearer|GRJWT)\s+[A-Za-z0-9._~+/-]+=*/gi, "<redacted-authorization>")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "<redacted-jwt>");
}

function parseCliJson(stdout) {
  const lines = String(stdout).split(/\r?\n/).filter((line) => line.trim());
  for (const line of lines.reverse()) {
    try { return JSON.parse(line); } catch (_error) { /* inspect the preceding line */ }
  }
  throw new Error("protected CLI did not return JSON");
}

function runProtectedCli({ cliPath, args, input, environment }) {
  const stdout = execFileSync(process.execPath, [cliPath, ...args], {
    input: `${JSON.stringify(input)}\n`,
    encoding: "utf8",
    env: environment,
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 180_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  return parseCliJson(stdout);
}

function confirmedProtectedCall({ cliPath, toolName, input, skillId, environment }) {
  const baseArgs = ["call", toolName, "--input", "-", "--skill-id", skillId];
  const prepared = runProtectedCli({ cliPath, args: baseArgs, input, environment });
  if (!prepared?.requires_confirmation || typeof prepared.confirmation_id !== "string") {
    throw new Error(`protected CLI did not prepare ${toolName}`);
  }
  return runProtectedCli({
    cliPath,
    args: [
      "call", toolName, "--input", "-", "--confirm", prepared.confirmation_id,
      "--skill-id", skillId,
    ],
    input,
    environment,
  });
}

function cleanupDisposableApp(options) {
  const environment = {
    ...process.env,
    RAINSKILLS_TELEMETRY_DISABLED: "1",
    RAINSKILLS_CREDENTIAL_SOURCE: "environment",
    RAINBOND_URL: options.liveCredentials.console_origin,
    RAINBOND_JWT: options.liveCredentials.token,
    RAINBOND_ALLOW_INSECURE_HTTP: String(options.liveCredentials.allow_insecure_http),
  };
  const query = runProtectedCli({
    cliPath: options.liveCliPath,
    args: ["read", "rainbond_query_apps", "--input", "-", "--skill-id", "rainbond-app-assistant"],
    input: {
      enterprise_id: options.liveEnterpriseId,
      query: options.liveAppName,
      page: 1,
      page_size: 20,
    },
    environment,
  });
  const exact = Array.isArray(query?.items)
    ? query.items.filter((app) => app?.app_name === options.liveAppName)
    : [];
  if (exact.length === 0) return { result: "success", deleted: false };
  if (exact.length !== 1 || exact[0].team_name !== options.liveTeamName) {
    throw new Error("disposable app lookup was not unique in the benchmark team");
  }
  const prepared = confirmedProtectedCall({
    cliPath: options.liveCliPath,
    toolName: "rainbond_delete_app",
    input: { app_id: exact[0].app_id },
    skillId: "rainbond-app-assistant",
    environment,
  });
  if (!prepared?.requires_confirmation || typeof prepared.confirmation_token !== "string") {
    throw new Error("Rainbond did not return an app deletion confirmation token");
  }
  const deleted = confirmedProtectedCall({
    cliPath: options.liveCliPath,
    toolName: "rainbond_delete_app",
    input: {
      app_id: exact[0].app_id,
      confirm: true,
      confirmation_token: prepared.confirmation_token,
    },
    skillId: "rainbond-app-assistant",
    environment,
  });
  if (deleted?.deleted !== true) throw new Error("Rainbond did not confirm disposable app deletion");
  return { result: "success", deleted: true, app_id: exact[0].app_id };
}

export function buildCodexArgs({ workspace, prompt, options }) {
  const args = [
    "exec", "--json", "--ephemeral", "--ignore-user-config", "--ignore-rules",
    "--disable", "plugins", "--disable", "remote_plugin", "--disable", "plugin_sharing",
    "--skip-git-repo-check", "-s", options.controlledLive ? "danger-full-access" : "read-only",
    "-c", "approval_policy=\"never\"", "-C", workspace,
    "-m", options.model,
    "-c", `model_reasoning_effort=${JSON.stringify(options.reasoningEffort)}`,
  ];
  if (options.providerName) {
    const prefix = `model_providers.${options.providerName}`;
    args.push(
      "-c", `model_provider=${JSON.stringify(options.providerName)}`,
      "-c", `${prefix}.name=${JSON.stringify(options.providerName)}`,
      "-c", `${prefix}.base_url=${JSON.stringify(options.providerBaseUrl)}`,
      "-c", `${prefix}.wire_api=${JSON.stringify(options.providerWireApi)}`,
      "-c", `${prefix}.requires_openai_auth=${options.providerRequiresOpenAIAuth}`,
      "-c", `${prefix}.supports_websockets=${options.providerSupportsWebsockets}`,
    );
  }
  args.push(prompt);
  return args;
}

async function executeCodex({ root, scenario, effectCase, options, repetition }) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), `rainskills-host-${scenario.id}-`));
  fs.chmodSync(workspace, 0o700);
  if (options.controlledLive) cleanupDisposableApp(options);
  const bundle = copySkillBundles(root, workspace);
  const fixture = { kind: "policy_scenario", name: effectCase.id };
  safeWrite(path.join(workspace, "EVAL_FIXTURE.json"), `${JSON.stringify(fixture, null, 2)}\n`);
  const prompt = makePrompt(effectCase, scenario.entry_skill, options);
  const artifactDirectory = path.join(options.artifactRoot, scenario.id, String(repetition));
  fs.mkdirSync(artifactDirectory, { recursive: true, mode: 0o700 });
  fs.chmodSync(artifactDirectory, 0o700);
  const started = process.hrtime.bigint();
  const timedEvents = [];
  let stdout = "";
  let stderr = "";
  let buffered = "";
  let artifactBytes = 0;
  let timedOut = false;
  const args = buildCodexArgs({ workspace, prompt, options });
  const authRoot = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  const isolatedRuntime = prepareIsolatedCodexEnvironment({
    workspace,
    baseEnvironment: process.env,
    authSource: path.join(authRoot, "auth.json"),
  });
  const { childEnvironment } = isolatedRuntime;
  if (options.controlledLive) {
    childEnvironment.RAINSKILLS_CREDENTIAL_SOURCE = "environment";
    childEnvironment.RAINBOND_URL = options.liveCredentials.console_origin;
    childEnvironment.RAINBOND_JWT = options.liveCredentials.token;
    childEnvironment.RAINBOND_ALLOW_INSECURE_HTTP = String(
      options.liveCredentials.allow_insecure_http,
    );
    const manifestPath = path.join(
      isolatedRuntime.isolatedHome,
      ".rainbond",
      "bin",
      "rainskills-skill-manifest.json",
    );
    buildSkillManifest({ source_root: root, output: manifestPath, revision: options.sourceSha });
  }
  const child = spawn("codex", args, {
    cwd: workspace,
    env: childEnvironment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
  }, options.timeoutMs);
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    artifactBytes += Buffer.byteLength(chunk);
    if (artifactBytes > ARTIFACT_MAX_BYTES) {
      timedOut = true;
      child.kill("SIGTERM");
      return;
    }
    buffered += chunk;
    const lines = buffered.split(/\r?\n/);
    buffered = lines.pop() || "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        timedEvents.push({
          received_ms: Number(process.hrtime.bigint() - started) / 1e6,
          event: JSON.parse(line),
        });
      } catch (_error) {
        // Preserve malformed raw output; normalization reports missing usage instead of inventing it.
      }
    }
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
    artifactBytes += Buffer.byteLength(chunk);
    if (artifactBytes > ARTIFACT_MAX_BYTES) {
      timedOut = true;
      child.kill("SIGTERM");
    }
  });
  const completion = await new Promise((resolve) => {
    child.on("error", (error) => resolve({ exitCode: 1, signal: null, spawnError: error.message }));
    child.on("close", (exitCode, signal) => resolve({ exitCode: exitCode ?? 1, signal, spawnError: null }));
  });
  clearTimeout(timer);
  const processExitMs = Number(process.hrtime.bigint() - started) / 1e6;
  safeWrite(path.join(artifactDirectory, "stdout.jsonl"), redactArtifactText(stdout));
  safeWrite(path.join(artifactDirectory, "stderr.log"), redactArtifactText(stderr));
  safeWrite(path.join(artifactDirectory, "events.timed.jsonl"), timedEvents
    .map((entry) => JSON.stringify(entry)).join("\n") + (timedEvents.length ? "\n" : ""));
  const normalized = normalizeCodexRun({
    timedEvents,
    processExitMs,
    exitCode: completion.exitCode,
    timedOut,
    workspace,
  });
  let cleanup = { result: "success", deleted: false };
  if (options.controlledLive) {
    try {
      cleanup = cleanupDisposableApp(options);
    } catch (_error) {
      cleanup = { result: "failed", deleted: false };
    }
  }
  const outcomeSignature = options.fixtureOnly
    ? sha256(canonicalJson({
        scenario_id: scenario.id,
        expected_behaviors: effectCase.expected_behaviors,
        result: normalized.result,
      }))
    : null;
  fs.rmSync(workspace, { recursive: true, force: true });
  return {
    scenario_id: scenario.id,
    benchmark_layer: "codex_host",
    data_source: "codex_exec_json",
    run_role: options.runRole,
    environment: {
      active_skill_bundle_digest: bundle.digest,
      prompt_sha256: sha256(prompt),
      fixture_sha256: sha256(canonicalJson(fixture)),
      session_mode: "fresh_session",
      test_environment: options.fixtureOnly ? "fixture_only" : "unavailable",
      reset_method: "fresh temporary workspace",
      cleanup_result: cleanup.result,
      cleanup_deleted_disposable_app: cleanup.deleted,
      host_isolation: "isolated_home_codex_home_and_repo_skill_scope",
      isolated_auth_copy: isolatedRuntime.authCopied,
    },
    ...normalized,
    outcome_signature: outcomeSignature,
    outcome_eligibility_basis: options.fixtureOnly
      ? "matching fixture scenario, expected behavior contract, and successful host result"
      : unavailableValue(),
    timed_out: timedOut,
    exit_code: completion.exitCode,
    signal: completion.signal,
    spawn_error: completion.spawnError,
    artifact_directory: artifactDirectory,
    behavior_assertions: effectCase.expected_behaviors,
  };
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function mad(values) {
  const center = median(values);
  return median(values.map((value) => Math.abs(value - center)));
}

function summarize(records) {
  const grouped = new Map();
  for (const record of records) {
    const list = grouped.get(record.scenario_id) || [];
    list.push(record);
    grouped.set(record.scenario_id, list);
  }
  return [...grouped].map(([scenarioId, values]) => {
    const observed = values.filter((value) => typeof value.timing?.process_exit_ms === "number");
    const timings = observed.map((value) => value.timing.process_exit_ms);
    return {
      scenario_id: scenarioId,
      planned_runs: values.length,
      observed_runs: observed.length,
      process_exit_p50_ms: timings.length ? median(timings) : unavailableValue(),
      process_exit_mad_ms: timings.length ? mad(timings) : unavailableValue(),
      process_exit_p95_ms: timings.length
        ? [...timings].sort((a, b) => a - b)[Math.ceil(timings.length * 0.95) - 1]
        : unavailableValue(),
      failure_rate: observed.length
        ? values.filter((value) => value.result === "failed").length / values.length
        : unavailableValue(),
      timeout_rate: observed.length
        ? values.filter((value) => value.timed_out === true).length / values.length
        : unavailableValue(),
      cleanup_failure_rate: observed.length
        ? values.filter((value) => value.environment?.cleanup_result === "failed").length / values.length
        : unavailableValue(),
    };
  });
}

function parseArgs(argv) {
  const options = {
    execute: false,
    fixtureOnly: false,
    label: "phase0-a-only",
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
    repetitions: 1,
    primaryRepetitions: 3,
    timeoutMs: 180_000,
    output: null,
    artifactRoot: null,
    scenario: null,
    providerName: null,
    providerBaseUrl: null,
    providerWireApi: "responses",
    providerRequiresOpenAIAuth: true,
    providerSupportsWebsockets: false,
    sourceRoot: null,
    runRole: "baseline",
    baseSha: null,
    candidateSha: null,
    runOrderSeed: null,
    controlledLive: false,
    liveCliPath: null,
    liveAppName: null,
    liveTeamName: null,
    liveRegionName: null,
    liveEnterpriseId: null,
    liveImage: "nginx:alpine",
    liveComponentName: "web",
    liveContainerPort: 80,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--execute") { options.execute = true; continue; }
    if (argument === "--fixture-only") { options.execute = true; options.fixtureOnly = true; continue; }
    if (argument === "--controlled-live") { options.execute = true; options.controlledLive = true; continue; }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`missing value for ${argument}`);
    if (argument === "--label") options.label = value;
    else if (argument === "--model") options.model = value;
    else if (argument === "--reasoning-effort") options.reasoningEffort = value;
    else if (argument === "--repetitions") options.repetitions = Number(value);
    else if (argument === "--primary-repetitions") options.primaryRepetitions = Number(value);
    else if (argument === "--timeout-ms") options.timeoutMs = Number(value);
    else if (argument === "--output") options.output = path.resolve(value);
    else if (argument === "--artifact-root") options.artifactRoot = path.resolve(value);
    else if (argument === "--scenario") options.scenario = value;
    else if (argument === "--provider-name") options.providerName = value;
    else if (argument === "--provider-base-url") options.providerBaseUrl = value;
    else if (argument === "--provider-wire-api") options.providerWireApi = value;
    else if (argument === "--provider-requires-openai-auth") options.providerRequiresOpenAIAuth = value === "true";
    else if (argument === "--provider-supports-websockets") options.providerSupportsWebsockets = value === "true";
    else if (argument === "--source-root") options.sourceRoot = path.resolve(value);
    else if (argument === "--run-role") options.runRole = value;
    else if (argument === "--base-sha") options.baseSha = value;
    else if (argument === "--candidate-sha") options.candidateSha = value;
    else if (argument === "--run-order-seed") options.runOrderSeed = value;
    else if (argument === "--live-cli-path") options.liveCliPath = path.resolve(value);
    else if (argument === "--live-app-name") options.liveAppName = value;
    else if (argument === "--live-team-name") options.liveTeamName = value;
    else if (argument === "--live-region-name") options.liveRegionName = value;
    else if (argument === "--live-enterprise-id") options.liveEnterpriseId = value;
    else if (argument === "--live-image") options.liveImage = value;
    else if (argument === "--live-component-name") options.liveComponentName = value;
    else if (argument === "--live-container-port") options.liveContainerPort = Number(value);
    else throw new Error(`unknown argument: ${argument}`);
    index += 1;
  }
  for (const [name, value, min, max] of [
    ["repetitions", options.repetitions, 1, 20],
    ["primary-repetitions", options.primaryRepetitions, 1, 20],
    ["timeout-ms", options.timeoutMs, 1_000, 900_000],
  ]) if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`invalid ${name}`);
  if (Boolean(options.providerName) !== Boolean(options.providerBaseUrl)) {
    throw new Error("provider-name and provider-base-url must be provided together");
  }
  if (options.providerName && !/^[A-Za-z0-9_-]+$/.test(options.providerName)) {
    throw new Error("invalid provider-name");
  }
  if (options.providerBaseUrl) {
    const url = new URL(options.providerBaseUrl);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
      throw new Error("invalid provider-base-url");
    }
  }
  if (!new Set(["responses", "chat"]).has(options.providerWireApi)) {
    throw new Error("invalid provider-wire-api");
  }
  if (!new Set(["baseline", "base", "candidate"]).has(options.runRole)) {
    throw new Error("invalid run-role");
  }
  for (const [name, value] of [["base-sha", options.baseSha], ["candidate-sha", options.candidateSha]]) {
    if (value !== null && !/^[0-9a-f]{40}$/.test(value)) throw new Error(`invalid ${name}`);
  }
  if (options.sourceRoot && !fs.statSync(options.sourceRoot, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error("invalid source-root");
  }
  if (options.fixtureOnly && options.controlledLive) throw new Error("fixture-only and controlled-live conflict");
  if (options.controlledLive) {
    for (const required of [
      "liveCliPath", "liveAppName", "liveTeamName", "liveRegionName", "liveEnterpriseId",
    ]) {
      if (!options[required]) throw new Error(`missing ${required}`);
    }
    if (!fs.statSync(options.liveCliPath, { throwIfNoEntry: false })?.isFile()) {
      throw new Error("invalid live-cli-path");
    }
    if (!/^[a-z][a-z0-9-]{2,62}$/.test(options.liveAppName)) throw new Error("invalid live-app-name");
    if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(options.liveTeamName)) throw new Error("invalid live-team-name");
    if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(options.liveRegionName)) throw new Error("invalid live-region-name");
    if (!/^[a-f0-9]{32}$/.test(options.liveEnterpriseId)) throw new Error("invalid live-enterprise-id");
    if (!Number.isSafeInteger(options.liveContainerPort)
      || options.liveContainerPort < 1 || options.liveContainerPort > 65535) {
      throw new Error("invalid live-container-port");
    }
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const harnessRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const sourceRoot = options.sourceRoot || harnessRoot;
  const git = gitState(sourceRoot);
  options.sourceSha = git.sha;
  if (options.controlledLive) {
    const { createSingleRuntimeStore } = require(path.join(
      harnessRoot,
      "rainbond-platform-installer",
      "scripts",
      "single-runtime.js",
    ));
    options.liveCredentials = createSingleRuntimeStore({ home: os.homedir() }).read();
    if (!options.liveCredentials) throw new Error("connected Rainbond runtime is unavailable");
  }
  const packageVersion = JSON.parse(fs.readFileSync(path.join(sourceRoot, "package.json"), "utf8")).version;
  const cases = new Map(loadEffectCases({ root: harnessRoot }).map((entry) => [entry.id, entry]));
  const allScenarios = parseScenarioConfig(harnessRoot);
  const scenarios = options.scenario
    ? allScenarios.filter((scenario) => scenario.id === options.scenario)
    : allScenarios;
  if (options.scenario && scenarios.length !== 1) throw new Error(`unknown scenario: ${options.scenario}`);
  const manifestDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "rainskills-host-manifest-"));
  const manifestPath = path.join(manifestDirectory, "manifest.json");
  buildSkillManifest({ source_root: sourceRoot, output: manifestPath, revision: git.sha });
  const skillManifestDigest = sha256(fs.readFileSync(manifestPath));
  fs.rmSync(manifestDirectory, { recursive: true, force: true });
  options.artifactRoot ||= path.join(os.tmpdir(), "rainskills-host-evals", options.label);
  fs.mkdirSync(options.artifactRoot, { recursive: true, mode: 0o700 });
  fs.chmodSync(options.artifactRoot, 0o700);
  const records = [];
  const runStartedAt = new Date().toISOString();
  for (const scenario of scenarios) {
    const effectCase = cases.get(scenario.effect_case_id);
    const runs = scenario.id === "deploy-current-project"
      ? options.primaryRepetitions
      : options.repetitions;
    for (let repetition = 1; repetition <= runs; repetition += 1) {
      if (!options.execute) {
        records.push(unavailableScenario({
          scenarioId: scenario.id,
          reason: "host execution not requested",
          runRole: options.runRole,
        }));
      } else if (!options.fixtureOnly && !options.controlledLive && WRITE_SCENARIOS.has(scenario.id)) {
        records.push(unavailableScenario({
          scenarioId: scenario.id,
          reason: "controlled Rainbond test environment, reset, and cleanup are unavailable",
          runRole: options.runRole,
        }));
      } else {
        records.push(await executeCodex({ root: sourceRoot, scenario, effectCase, options, repetition }));
      }
    }
  }
  const output = {
    schema: HOST_SCHEMA,
    benchmark_layer: "codex_host",
    run_role: options.runRole,
    control_status: !options.execute
      ? "unavailable"
      : options.fixtureOnly ? "uncontrolled" : options.controlledLive ? "controlled" : "controlled",
    environment: {
      base_sha: options.baseSha || (git.clean && options.runRole !== "candidate" ? git.sha : null),
      candidate_sha: options.candidateSha || (git.clean && options.runRole === "candidate" ? git.sha : null),
      worktree_clean: git.clean,
      model_id: options.model,
      reasoning_effort: options.reasoningEffort,
      codex_build: execFileSync("codex", ["--version"], { encoding: "utf8" }).trim(),
      host_toolset_digest: unavailableValue(),
      rainbond_catalog_digest: unavailableValue(),
      skill_manifest_digest: skillManifestDigest,
      rainskills_package_version: packageVersion,
      rainskills_cli_version: packageVersion,
      rainskills_protocol_version: "rainskills.single-runtime-contract.v1",
      rainbond_platform_version: unavailableValue(),
      validator_digest: sha256(fs.readFileSync(fileURLToPath(import.meta.url))),
      run_order_seed: options.runOrderSeed,
      run_started_at: runStartedAt,
      test_environment: options.fixtureOnly
        ? "fixture_only"
        : options.controlledLive ? "disposable_rainbond_app" : unavailableValue(),
    },
    summary: summarize(records),
    scenarios: records,
  };
  const serialized = `${JSON.stringify(output, null, 2)}\n`;
  if (options.output) {
    fs.mkdirSync(path.dirname(options.output), { recursive: true });
    fs.writeFileSync(options.output, serialized);
  } else process.stdout.write(serialized);
}

if (path.resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}
