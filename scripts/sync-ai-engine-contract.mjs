#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const upstreamRoot = process.env.RAINBOND_AI_ENGINE_ROOT || path.resolve(root, "..", "rainbond-ai-engine");
const source = path.join(upstreamRoot, "contracts", "skills-prerequisites-v1.json");
const destination = path.join(root, "contracts", "ai-engine-skills-prerequisites-v1.json");
const check = process.argv.slice(2).includes("--check");

if (!fs.existsSync(source)) {
  throw new Error(`authoritative AI Engine contract is missing: ${source}`);
}
const normalized = `${JSON.stringify(JSON.parse(fs.readFileSync(source, "utf8")), null, 2)}\n`;
if (check) {
  const current = fs.existsSync(destination) ? fs.readFileSync(destination, "utf8") : "";
  if (current !== normalized) throw new Error("vendored AI Engine contract is stale; run npm run sync:ai-engine-contract");
  process.stdout.write("AI Engine contract is current.\n");
} else {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, normalized, "utf8");
  process.stdout.write("Synced AI Engine contract.\n");
}

