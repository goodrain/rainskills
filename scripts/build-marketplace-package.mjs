#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const marketplaceRoot = path.join(repoRoot, "marketplace", "rainskills");
const packageManifest = JSON.parse(
  fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")
);
const canonicalSkill = fs.readFileSync(path.join(repoRoot, "SKILL.md"), "utf8");

const packageName = packageManifest.name;
const version = packageManifest.version;
const repository = "https://github.com/goodrain/rainskills";
const homepage = `${repository}#readme`;
const description =
  "Install the complete Rainskills AI deployment skill suite as one product.";
const keywords = [
  "rainbond",
  "codex",
  "claude-code",
  "deepseek-harness",
  "workbuddy",
  "hermes-agent",
  "skills",
  "installer",
];

function serializeJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function buildVersionedSkill() {
  const unversionedCommand = `npx --yes ${packageName}`;
  const escapedCommand = unversionedCommand.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const unversionedPattern = new RegExp(`${escapedCommand}(?!@)`, "g");
  const occurrences = canonicalSkill.match(unversionedPattern)?.length || 0;
  if (occurrences !== 1) {
    throw new Error(
      `SKILL.md must contain exactly one fallback command: ${unversionedCommand}`
    );
  }
  return canonicalSkill.replace(
    unversionedPattern,
    `${unversionedCommand}@${version}`
  );
}

const claudePlugin = {
  name: packageName,
  version,
  description,
  author: {
    name: "Goodrain",
    url: "https://www.rainbond.com",
  },
  homepage,
  repository,
  license: packageManifest.license,
  keywords,
};

const codexPlugin = {
  ...claudePlugin,
  skills: "./skills/",
  interface: {
    displayName: "Rainskills",
    shortDescription: "Install the complete Rainskills AI deployment skill suite",
    longDescription:
      "Install every independent Rainskills capability. Application runtime selection and connection happen later, only when the user requests an action that needs them.",
    developerName: "Goodrain",
    category: "Engineering",
    capabilities: ["Interactive", "Write"],
    websiteURL: "https://www.rainbond.com",
    defaultPrompt: ["Install Rainskills for me."],
    brandColor: "#2563EB",
    screenshots: [],
  },
};

const claudeMarketplace = {
  name: "goodrain",
  owner: {
    name: "Goodrain",
    url: "https://www.rainbond.com",
  },
  description: "Goodrain AI development tools",
  plugins: [
    {
      name: packageName,
      displayName: "Rainskills",
      source: "./marketplace/rainskills",
      description,
      author: claudePlugin.author,
      homepage,
      repository,
      license: packageManifest.license,
      keywords,
      category: "development",
    },
  ],
};

const codexMarketplace = {
  name: "goodrain",
  interface: {
    displayName: "Goodrain",
  },
  plugins: [
    {
      name: packageName,
      source: {
        source: "local",
        path: "./marketplace/rainskills",
      },
      policy: {
        installation: "AVAILABLE",
        authentication: "ON_USE",
      },
      category: "Engineering",
    },
  ],
};

const outputs = new Map([
  [
    path.join(marketplaceRoot, "skills", "rainskills", "SKILL.md"),
    buildVersionedSkill(),
  ],
  [
    path.join(marketplaceRoot, ".claude-plugin", "plugin.json"),
    serializeJson(claudePlugin),
  ],
  [
    path.join(marketplaceRoot, ".codex-plugin", "plugin.json"),
    serializeJson(codexPlugin),
  ],
  [
    path.join(repoRoot, ".claude-plugin", "marketplace.json"),
    serializeJson(claudeMarketplace),
  ],
  [
    path.join(repoRoot, ".agents", "plugins", "marketplace.json"),
    serializeJson(codexMarketplace),
  ],
]);

function marketplaceFiles(root) {
  if (!fs.existsSync(root)) {
    return [];
  }
  const files = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...marketplaceFiles(entryPath));
    } else {
      files.push(entryPath);
    }
  }
  return files;
}

function checkOutputs({ quiet = false } = {}) {
  const errors = [];
  for (const [filePath, expected] of outputs) {
    if (!fs.existsSync(filePath)) {
      errors.push(`missing ${path.relative(repoRoot, filePath)}`);
      continue;
    }
    const actual = fs.readFileSync(filePath, "utf8");
    if (actual !== expected) {
      errors.push(`stale ${path.relative(repoRoot, filePath)}`);
    }
  }

  const expectedPluginFiles = new Set(
    [...outputs.keys()].filter((filePath) => filePath.startsWith(`${marketplaceRoot}${path.sep}`))
  );
  for (const filePath of marketplaceFiles(marketplaceRoot)) {
    if (!expectedPluginFiles.has(filePath)) {
      errors.push(`unexpected ${path.relative(repoRoot, filePath)}`);
    }
  }

  if (errors.length > 0) {
    for (const error of errors) {
      console.error(`Marketplace package is not current: ${error}`);
    }
    console.error("Run `npm run build:marketplace` and commit the generated files.");
    process.exitCode = 1;
    return;
  }

  if (!quiet) {
    console.log(`Marketplace package is current for ${packageName}@${version}.`);
  }
}

function writeAtomically(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(temporaryPath, content, "utf8");
  fs.renameSync(temporaryPath, filePath);
}

function writeOutputs() {
  fs.rmSync(marketplaceRoot, { recursive: true, force: true });
  for (const [filePath, content] of outputs) {
    writeAtomically(filePath, content);
  }
  console.log(`Built marketplace package for ${packageName}@${version}.`);
}

const args = process.argv.slice(2);
if (args.length === 0) {
  writeOutputs();
} else if (args.length === 1 && args[0] === "--check") {
  checkOutputs();
} else if (
  args.length === 2 &&
  args[0] === "--check" &&
  args[1] === "--quiet"
) {
  checkOutputs({ quiet: true });
} else {
  console.error(
    "Usage: node scripts/build-marketplace-package.mjs [--check [--quiet]]"
  );
  process.exitCode = 2;
}
