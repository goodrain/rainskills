"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { pathToFileURL } = require("node:url");

const repoRoot = path.resolve(__dirname, "..");
const dshEntryPath = path.join(repoRoot, "dsh", "index.mjs");

async function loadDshEntry() {
  return import(pathToFileURL(dshEntryPath).href);
}

test("npm package declares an installable DeepSeek Harness bundle", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  const patch = fs.readFileSync(path.join(repoRoot, "dsh", "cordis.patch.yml"), "utf8");

  assert.deepEqual(manifest.dsh, {
    bundle: {
      patch: "./dsh/cordis.patch.yml",
    },
  });
  assert(manifest.files.includes("dsh/"));
  assert.match(patch, /id:\s*rainskills/);
  assert.match(patch, /name:\s*\.\/index\.mjs/);
});

test("README documents the DSH bundle install path and the marketplace runbook", () => {
  const readme = fs.readFileSync(path.join(repoRoot, "README.md"), "utf8");

  assert.match(readme, /dsh plugin --profile web add rainskills/);
  assert.match(readme, /marketplace-publishing\.md/);
});

test("DSH entry parses the generated bootstrap Skill as its single source of truth", async () => {
  const entry = await loadDshEntry();
  const skillPath = path.join(
    repoRoot,
    "marketplace",
    "rainskills",
    "skills",
    "rainskills",
    "SKILL.md",
  );
  const source = fs.readFileSync(skillPath, "utf8");
  const parsed = entry.parseSkillSource(source, skillPath);

  assert.equal(parsed.name, "rainskills");
  assert.match(parsed.description, /single Rainskills runtime/i);
  assert.match(parsed.content, /^# Rainskills/m);
  assert.doesNotMatch(parsed.content, /^---$/m);
});

test("DSH entry registers only the bootstrap Skill and owns its disposer", async () => {
  const entry = await loadDshEntry();
  const registrations = [];
  const effects = [];
  const disposer = () => {};
  const ctx = {
    effect(factory, label) {
      effects.push({ factory, label });
      return factory();
    },
    skills: {
      register(registration) {
        registrations.push(registration);
        return disposer;
      },
    },
  };

  entry.apply(ctx);

  assert.equal(effects.length, 1);
  assert.equal(effects[0].label, "rainskills-dsh: register bootstrap skill");
  assert.equal(registrations.length, 1);
  assert.equal(registrations[0].name, "rainskills");
  assert.equal(registrations[0].source, "bundled");
  assert.equal(registrations[0].provider, "rainskills-dsh");
  assert.deepEqual(registrations[0].invocation, {
    modelInvocable: true,
    userInvocable: true,
  });
  assert.equal(registrations[0].resourceBase.kind, "directory");
  assert.equal(path.basename(registrations[0].resourceBase.path), "rainskills");
  assert.equal(registrations[0].path, path.join(registrations[0].resourceBase.path, "SKILL.md"));
  assert.match(registrations[0].content, /^# Rainskills/m);
  assert.equal(effects[0].factory(), disposer);
});

test("DSH entry rejects malformed or mismatched bootstrap Skills", async () => {
  const entry = await loadDshEntry();

  assert.throws(() => entry.parseSkillSource("# missing frontmatter"), /frontmatter/i);
  assert.throws(
    () => entry.parseSkillSource("---\nname: other\ndescription: Wrong skill\n---\n# Other\n"),
    /Unexpected skill name/i,
  );
  assert.throws(
    () => entry.parseSkillSource("---\nname: rainskills\n---\n# Rainskills\n"),
    /description/i,
  );
});
