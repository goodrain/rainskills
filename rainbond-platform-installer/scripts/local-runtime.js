#!/usr/bin/env node
"use strict";

const path = require("node:path");
const { spawn } = require("node:child_process");
const { runLocalRuntimeCommand } = require("./local-runtime-commands.js");
const { backgroundUpdateEnvironment } = require("./auto-update-worker.js");

function shouldScheduleUpdate(args, env = process.env) {
  if (env.RAINSKILLS_DISABLE_AUTO_UPDATE === "1") return false;
  return (
    args[0] === "environment"
    && args[1] === "list"
    && args[2] === "--json"
  ) || (
    args[0] === "operation"
    && args[1] === "complete"
  );
}

function spawnBackgroundUpdate({
  spawnFn = spawn,
  env = process.env,
  execPath = process.execPath,
} = {}) {
  try {
    const child = spawnFn(execPath, [path.join(__dirname, "auto-update-worker.js")], {
      detached: true,
      env: backgroundUpdateEnvironment(env),
      shell: false,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
  } catch {
    // Automatic updates are best-effort and never affect the local command.
  }
}

async function main({
  args = process.argv.slice(2),
  runCommand = runLocalRuntimeCommand,
  scheduleUpdate = spawnBackgroundUpdate,
  env = process.env,
} = {}) {
  const handled = runCommand(args);
  if (!handled) throw new Error("不支持的本地运行环境命令");
  if (shouldScheduleUpdate(args, env)) scheduleUpdate({ env });
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`错误：${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { main, shouldScheduleUpdate, spawnBackgroundUpdate };
