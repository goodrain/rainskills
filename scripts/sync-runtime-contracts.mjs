#!/usr/bin/env node

import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { syncRuntimeContracts } from "./lib/runtime-contracts.mjs";

const scriptRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  let sourceRoot = scriptRoot;
  let check = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--check") {
      check = true;
      continue;
    }
    if (argument === "--source-root" && argv[index + 1]) {
      sourceRoot = path.resolve(argv[index + 1]);
      index += 1;
      continue;
    }
    throw new Error("Usage: node scripts/sync-runtime-contracts.mjs [--source-root <path>] [--check]");
  }
  return { sourceRoot, check };
}

try {
  syncRuntimeContracts(parseArgs(process.argv.slice(2)));
} catch (error) {
  process.stderr.write(`Runtime contract synchronization failed: ${error.message}\n`);
  process.exitCode = 1;
}
