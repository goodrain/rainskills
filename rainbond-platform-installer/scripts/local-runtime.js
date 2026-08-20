#!/usr/bin/env node
"use strict";

const { runLocalRuntimeCommand } = require("./local-runtime-commands.js");

async function main() {
  const handled = runLocalRuntimeCommand(process.argv.slice(2));
  if (!handled) throw new Error("不支持的本地运行环境命令");
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`错误：${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { main };
