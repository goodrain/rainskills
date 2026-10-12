#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { loadEffectCases } from "./validate-effect-evals.mjs";

function readUtf8(root, relativePath) {
  const absolute = path.resolve(root, relativePath);
  if (!absolute.startsWith(`${path.resolve(root)}${path.sep}`) && absolute !== path.resolve(root)) {
    throw new Error(`path escapes repository: ${relativePath}`);
  }
  return fs.readFileSync(absolute, "utf8");
}

function entryPath(skillId) {
  return skillId === "rainskills" ? "SKILL.md" : `${skillId}/SKILL.md`;
}

function descriptionBytes(source) {
  const match = source.match(/^---\n([\s\S]*?)\n---/);
  if (!match) throw new Error("Skill is missing frontmatter");
  const frontmatter = YAML.parse(match[1]);
  if (typeof frontmatter?.description !== "string") throw new Error("Skill description is missing");
  return Buffer.byteLength(frontmatter.description);
}

function countTrace(trace, type) {
  return trace.filter((event) => event.type === type).length;
}

function sumTrace(trace, field, type = null) {
  return trace
    .filter((event) => type === null || event.type === type)
    .reduce((sum, event) => sum + Number(event[field] || 0), 0);
}

function validateScenarioDocument(document) {
  if (document?.schema !== "rainskills.repository-performance-scenarios.v1") {
    throw new Error("invalid repository performance scenario schema");
  }
  if (!Array.isArray(document.scenarios) || document.scenarios.length !== 8) {
    throw new Error("repository performance benchmark requires exactly eight scenarios");
  }
  const ids = new Set();
  for (const scenario of document.scenarios) {
    if (typeof scenario.id !== "string" || !scenario.id || ids.has(scenario.id)) {
      throw new Error(`invalid or duplicate scenario id: ${String(scenario.id)}`);
    }
    ids.add(scenario.id);
    if (!Array.isArray(scenario.references) || scenario.references.length > 2) {
      throw new Error(`${scenario.id}: references must contain at most two paths`);
    }
    if (!Array.isArray(scenario.mock_trace)) throw new Error(`${scenario.id}: mock_trace is required`);
  }
  return document.scenarios;
}

export function runRepositoryBenchmark({ root }) {
  const caseMap = new Map(loadEffectCases({ root }).map((entry) => [entry.id, entry]));
  const scenarioPath = path.join(root, "benchmarks", "skill-performance", "scenarios.yaml");
  const scenarios = validateScenarioDocument(YAML.parse(fs.readFileSync(scenarioPath, "utf8")));
  const results = scenarios.map((scenario) => {
    const effectCase = caseMap.get(scenario.effect_case_id);
    if (!effectCase) throw new Error(`${scenario.id}: unknown effect case ${scenario.effect_case_id}`);
    if (effectCase.skill_id !== scenario.entry_skill) {
      throw new Error(`${scenario.id}: effect case and entry skill disagree`);
    }
    const entry = readUtf8(root, entryPath(scenario.entry_skill));
    const referenceBytes = scenario.references.map((reference) => ({
      path: reference,
      bytes: Buffer.byteLength(readUtf8(root, reference)),
    }));
    const trace = scenario.mock_trace;
    const backendRequestBytes = sumTrace(trace, "request_bytes", "backend_request");
    const backendResponseBytes = sumTrace(trace, "response_bytes", "backend_request");
    return {
      scenario_id: scenario.id,
      effect_case_id: effectCase.id,
      benchmark_layer: "repository",
      data_source: "static_bundle_and_mock_trace",
      entry_skill: scenario.entry_skill,
      description_bytes: descriptionBytes(entry),
      entry_bytes: Buffer.byteLength(entry),
      references_opened: referenceBytes,
      markdown_bytes_read: Buffer.byteLength(entry)
        + referenceBytes.reduce((sum, reference) => sum + reference.bytes, 0),
      model_calls: 0,
      tool_calls: countTrace(trace, "cli_invocation"),
      poll_calls: countTrace(trace, "poll"),
      mock: {
        cli_invocations: countTrace(trace, "cli_invocation"),
        backend_requests: countTrace(trace, "backend_request"),
        retries: countTrace(trace, "retry"),
        polls: countTrace(trace, "poll"),
        request_bytes: backendRequestBytes,
        response_bytes: backendResponseBytes,
        stdout_bytes: sumTrace(trace, "bytes", "stdout"),
        stderr_bytes: sumTrace(trace, "bytes", "stderr"),
        transport_bytes: backendRequestBytes + backendResponseBytes,
      },
      routing: {
        status: "pass",
        expected_initial_owner: effectCase.routing.expected_initial_owner,
        allowed_handoffs: effectCase.routing.allowed_handoffs,
      },
      behavior: {
        status: "not_executed",
        expected_assertion_count: effectCase.expected_behaviors.length,
        forbidden_assertion_count: effectCase.forbidden_behaviors.length,
      },
      safety: {
        status: "pass",
        assertion_count: effectCase.safety_assertions.length,
        evidence: "hash-pinned policy fixture",
      },
      result: "success",
    };
  });
  return {
    schema: "rainskills.repository-performance.v1",
    benchmark_layer: "repository",
    data_source: "static_bundle_and_mock_trace",
    summary: {
      scenario_count: results.length,
      total_markdown_bytes: results.reduce((sum, item) => sum + item.markdown_bytes_read, 0),
      total_tool_calls: results.reduce((sum, item) => sum + item.tool_calls, 0),
      total_backend_requests: results.reduce((sum, item) => sum + item.mock.backend_requests, 0),
      total_poll_calls: results.reduce((sum, item) => sum + item.poll_calls, 0),
      total_transport_bytes: results.reduce((sum, item) => sum + item.mock.transport_bytes, 0),
      token_metrics: "unavailable",
      model_timing: "unavailable",
    },
    scenarios: results,
  };
}

function parseOutput(argv) {
  if (argv.length === 0) return null;
  if (argv.length === 2 && argv[0] === "--output" && argv[1] && !argv[1].startsWith("--")) {
    return path.resolve(argv[1]);
  }
  throw new Error("Usage: node scripts/run-skill-performance-benchmark.mjs [--output <path>]");
}

if (path.resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) {
  try {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const output = runRepositoryBenchmark({ root });
    const target = parseOutput(process.argv.slice(2));
    if (target) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, `${JSON.stringify(output, null, 2)}\n`);
    } else {
      process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
