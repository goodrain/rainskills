"use strict";

const path = require("node:path");

const HOST_TARGETS = Object.freeze([
  "codex",
  "claude",
  "pi",
  "dsh",
  "workbuddy",
  "all",
]);
const HOST_TARGET_SET = new Set(HOST_TARGETS);

function isHostTarget(value) {
  return HOST_TARGET_SET.has(value);
}

function telemetryClientForTarget(target) {
  if (target === "claude") return "claude_code";
  if (target === "dsh") return "deepseek_harness";
  if (isHostTarget(target)) return target;
  return "unknown";
}

function dshSkillsDirectory(home, env = process.env) {
  const dshHome = typeof env.DSH_HOME === "string" && env.DSH_HOME.trim()
    ? env.DSH_HOME.trim()
    : path.join(home, ".dsh");
  return path.join(path.resolve(dshHome), "skills");
}

function workBuddySkillsDirectory(home, env = process.env) {
  const configHome = typeof env.WORKBUDDY_CONFIG_DIR === "string"
    && env.WORKBUDDY_CONFIG_DIR.trim()
    ? env.WORKBUDDY_CONFIG_DIR.trim()
    : path.join(home, ".workbuddy-ai");
  return path.join(path.resolve(configHome), "skills");
}

function destinationsForHostTarget(target, home, env = process.env) {
  const destinations = {
    claude: path.join(home, ".claude", "skills"),
    codex: path.join(home, ".codex", "skills"),
    pi: path.join(home, ".pi", "agent", "skills"),
    dsh: dshSkillsDirectory(home, env),
    workbuddy: workBuddySkillsDirectory(home, env),
  };
  if (target === "all") return Object.values(destinations);
  if (Object.hasOwn(destinations, target)) return [destinations[target]];
  throw new Error(`未知安装目标：${target}`);
}

module.exports = {
  HOST_TARGETS,
  destinationsForHostTarget,
  dshSkillsDirectory,
  isHostTarget,
  telemetryClientForTarget,
  workBuddySkillsDirectory,
};
