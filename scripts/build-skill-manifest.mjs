#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXCLUDED_NAMES = new Set(["__pycache__", ".DS_Store"]);

function parseArgs(argv) {
  const values = {};
  const allowed = new Set(["--output", "--source-root", "--revision"]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!allowed.has(argument)) throw new Error(`unknown argument: ${argument}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`missing value for ${argument}`);
    values[argument.slice(2).replace(/-/g, "_")] = value;
    index += 1;
  }
  if (!values.output) throw new Error("--output is required");
  return values;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function assertRegularDirectory(directory, label) {
  const info = fs.lstatSync(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`${label} must be a regular directory`);
  }
}

function listBundleFiles(root, current = root) {
  const files = [];
  const entries = fs.readdirSync(current, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    if (EXCLUDED_NAMES.has(entry.name) || entry.name.endsWith(".pyc")) continue;
    const absolute = path.join(current, entry.name);
    const info = fs.lstatSync(absolute);
    if (info.isSymbolicLink()) {
      throw new Error(`symbolic link is not allowed in a Skill bundle: ${entry.name}`);
    }
    if (info.isDirectory()) files.push(...listBundleFiles(root, absolute));
    else if (info.isFile()) files.push(absolute);
    else throw new Error(`unsupported file type in Skill bundle: ${entry.name}`);
  }
  return files;
}

function bundleDigest(skillRoot) {
  const digest = crypto.createHash("sha256");
  for (const absolute of listBundleFiles(skillRoot)) {
    const relative = path.relative(skillRoot, absolute).split(path.sep).join("/");
    const content = fs.readFileSync(absolute);
    digest.update(Buffer.from(`${Buffer.byteLength(relative, "utf8")}:`, "utf8"));
    digest.update(Buffer.from(relative, "utf8"));
    digest.update(Buffer.from(`${content.length}:`, "utf8"));
    digest.update(content);
  }
  return digest.digest("hex");
}

function frontmatterName(content, fallback) {
  const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!frontmatter) return fallback;
  const name = frontmatter[1].match(/^name:\s*(.+?)\s*$/m);
  if (!name) return fallback;
  return name[1].replace(/^['"]|['"]$/g, "").slice(0, 128) || fallback;
}

function assertOutputOutsideSkills(output, skillDirectories) {
  const resolvedOutput = path.resolve(output);
  for (const skillDirectory of skillDirectories) {
    const relative = path.relative(skillDirectory, resolvedOutput);
    if (
      relative === ""
      || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
    ) {
      throw new Error("output must be outside Skill directories");
    }
  }
}

function writePrivateJson(output, value) {
  const resolvedOutput = path.resolve(output);
  const parent = path.dirname(resolvedOutput);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  if (fs.existsSync(resolvedOutput)) {
    const existing = fs.lstatSync(resolvedOutput);
    if (!existing.isFile() || existing.isSymbolicLink()) {
      throw new Error("output must be a regular file");
    }
  }
  const temporary = path.join(
    parent,
    `.${path.basename(resolvedOutput)}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`
  );
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    fs.chmodSync(temporary, 0o600);
    fs.renameSync(temporary, resolvedOutput);
    fs.chmodSync(resolvedOutput, 0o600);
  } catch (error) {
    try { fs.rmSync(temporary, { force: true }); } catch { /* preserve build error */ }
    throw error;
  }
}

export function buildSkillManifest({ source_root: sourceRoot, output, revision }) {
  const resolvedSource = path.resolve(sourceRoot || scriptRoot);
  assertRegularDirectory(resolvedSource, "source root");
  const packageInfo = JSON.parse(fs.readFileSync(path.join(resolvedSource, "package.json"), "utf8"));
  if (
    (packageInfo.name !== undefined && packageInfo.name !== "rainskills")
    || typeof packageInfo.version !== "string"
    || !packageInfo.version
  ) {
    throw new Error("source package.json is not a versioned RainSkills package");
  }
  const skillDirectories = fs.readdirSync(resolvedSource, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^rainbond-[a-z0-9-]+$/.test(entry.name))
    .map((entry) => path.join(resolvedSource, entry.name))
    .filter((directory) => fs.existsSync(path.join(directory, "SKILL.md")))
    .sort((left, right) => path.basename(left).localeCompare(path.basename(right)));
  if (skillDirectories.length === 0) throw new Error("no RainSkills Skill directories were found");
  for (const directory of skillDirectories) assertRegularDirectory(directory, "Skill directory");
  assertOutputOutsideSkills(output, skillDirectories);

  const skills = skillDirectories.map((directory) => {
    const id = path.basename(directory);
    const skillFile = path.join(directory, "SKILL.md");
    const info = fs.lstatSync(skillFile);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new Error(`Skill entrypoint must be a regular file: ${id}`);
    }
    const contentBuffer = fs.readFileSync(skillFile);
    const content = contentBuffer.toString("utf8");
    if (!Buffer.from(content, "utf8").equals(contentBuffer)) {
      throw new Error(`Skill entrypoint must contain valid UTF-8: ${id}`);
    }
    return {
      id,
      name: frontmatterName(content, id),
      profile: "cli",
      package_version: packageInfo.version,
      source_revision: revision || null,
      content_sha256: sha256(contentBuffer),
      bundle_sha256: bundleDigest(directory),
      content,
    };
  });
  const manifest = {
    schema: "rainskills.skill-manifest.v1",
    profile: "cli",
    package_version: packageInfo.version,
    source_revision: revision || null,
    skills,
  };
  writePrivateJson(output, manifest);
  return manifest;
}

if (path.resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) {
  try {
    buildSkillManifest(parseArgs(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
