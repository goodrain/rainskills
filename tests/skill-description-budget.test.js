"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const YAML = require("yaml");

const root = path.resolve(__dirname, "..");

function description(relativePath) {
  const source = fs.readFileSync(path.join(root, relativePath), "utf8");
  const frontmatter = source.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  assert(frontmatter, `${relativePath} must have frontmatter`);
  return YAML.parse(frontmatter[1]).description;
}

test("app assistant discovery metadata is compact and preserves routing boundaries", () => {
  const value = description("rainbond-app-assistant/SKILL.md");
  assert(Buffer.byteLength(value, "utf8") <= 450, "top-level description exceeds 450-byte budget");
  assert.match(value, /Rainbond|Rainskills/);
  assert.match(value, /rainbond\.app\.json/);
  assert.match(value, /\.rainbond\/local\.json/);
  assert.match(value, /ordinary Git/i);
  assert.match(value, /rainbond-opensource-app-deploy/);
  assert.match(value, /rainbond-template-installer/);
});

test("open-source deploy discovery metadata is compact and preserves routing boundaries", () => {
  const value = description("rainbond-opensource-app-deploy/SKILL.md");
  assert(Buffer.byteLength(value, "utf8") <= 320, "specialist description exceeds 320-byte budget");
  assert.match(value, /Compose/i);
  assert.match(value, /Helm/i);
  assert.match(value, /image-set/i);
  assert.match(value, /named (?:third-party )?open-source suites/i);
  assert.match(value, /rainbond-app-assistant/);
  assert.match(value, /rainbond-template-installer/);
});

test("troubleshooter discovery metadata is compact and preserves routing boundaries", () => {
  const value = description("rainbond-fullstack-troubleshooter/SKILL.md");
  assert(Buffer.byteLength(value, "utf8") <= 320, "specialist description exceeds 320-byte budget");
  assert.match(value, /build/i);
  assert.match(value, /runtime/i);
  assert.match(value, /access/i);
  assert.match(value, /existing Rainbond app/i);
  assert.match(value, /rainbond-app-assistant/);
});

test("delivery verifier discovery metadata is compact and preserves routing boundaries", () => {
  const value = description("rainbond-delivery-verifier/SKILL.md");
  assert(Buffer.byteLength(value, "utf8") <= 320, "specialist description exceeds 320-byte budget");
  assert.match(value, /delivery/i);
  assert.match(value, /access/i);
  assert.match(value, /existing Rainbond app/i);
  assert.match(value, /rainbond-app-assistant/);
});

test("bootstrap discovery metadata is compact and preserves routing boundaries", () => {
  const value = description("rainbond-fullstack-bootstrap/SKILL.md");
  assert(Buffer.byteLength(value, "utf8") <= 320, "specialist description exceeds 320-byte budget");
  assert.match(value, /component topology/i);
  assert.match(value, /current project|manifest/i);
  assert.match(value, /bootstrap only/i);
  assert.match(value, /rainbond-app-assistant/);
});

test("project init discovery metadata is compact and preserves routing boundaries", () => {
  const value = description("rainbond-project-init/SKILL.md");
  assert(Buffer.byteLength(value, "utf8") <= 320, "specialist description exceeds 320-byte budget");
  assert.match(value, /local project/i);
  assert.match(value, /rainbond\.app\.json/);
  assert.match(value, /\.rainbond\/local\.json/);
  assert.match(value, /rainbond-app-assistant/);
  assert.match(value, /bare Git URL/i);
});

test("template installer discovery metadata is compact and preserves routing boundaries", () => {
  const value = description("rainbond-template-installer/SKILL.md");
  assert(Buffer.byteLength(value, "utf8") <= 320, "specialist description exceeds 320-byte budget");
  assert.match(value, /local or cloud Rainbond application template/i);
  assert.match(value, /new or existing app/i);
  assert.match(value, /从模板安装 WordPress 应用/);
  assert.match(value, /public images/i);
  assert.match(value, /rainbond-opensource-app-deploy/);
});

test("app version discovery metadata is compact and preserves routing boundaries", () => {
  const value = description("rainbond-app-version-assistant/SKILL.md");
  assert(Buffer.byteLength(value, "utf8") <= 320, "specialist description exceeds 320-byte budget");
  assert.match(value, /existing Rainbond app/i);
  assert.match(value, /snapshot/i);
  assert.match(value, /local library or cloud market/i);
  assert.match(value, /rollback/i);
  assert.match(value, /回滚到快照/);
});

test("AI assistant discovery metadata is compact and preserves routing boundaries", () => {
  const value = description("rainbond-ai-assistant/SKILL.md");
  assert(Buffer.byteLength(value, "utf8") <= 320, "specialist description exceeds 320-byte budget");
  assert.match(value, /Rainbond AI Engine/i);
  assert.match(value, /ModelScope/i);
  assert.match(value, /CPU\/GPU/i);
  assert.match(value, /monitor/i);
  assert.match(value, /ordinary apps/i);
});

test("env sync discovery metadata is compact and preserves routing boundaries", () => {
  const value = description("rainbond-env-sync/SKILL.md");
  assert(Buffer.byteLength(value, "utf8") <= 320, "specialist description exceeds 320-byte budget");
  assert.match(value, /non-sensitive/i);
  assert.match(value, /preview or production/i);
  assert.match(value, /linked Rainbond project/i);
  assert.match(value, /local env files/i);
  assert.match(value, /同步生产环境配置到本地/);
});

test("plugin manager discovery metadata is compact and preserves routing boundaries", () => {
  const value = description("rainbond-platform-plugin-manager/SKILL.md");
  assert(Buffer.byteLength(value, "utf8") <= 320, "specialist description exceeds 320-byte budget");
  assert.match(value, /Rainbond Console plugins/i);
  assert.match(value, /install/i);
  assert.match(value, /upgrade/i);
  assert.match(value, /uninstall/i);
  assert.match(value, /AI model operations/i);
});

test("platform query discovery metadata is compact and preserves routing boundaries", () => {
  const value = description("rainbond-platform-query/SKILL.md");
  assert(Buffer.byteLength(value, "utf8") <= 320, "specialist description exceeds 320-byte budget");
  assert.match(value, /explicit read-only Rainbond questions/i);
  assert.match(value, /current user, enterprise, team, region, app, or component/i);
  assert.match(value, /deployment/i);
  assert.match(value, /mutation/i);
  assert.match(value, /troubleshooting/i);
});

test("platform installer discovery metadata is compact and preserves routing boundaries", () => {
  const value = description("rainbond-platform-installer/SKILL.md");
  assert(Buffer.byteLength(value, "utf8") <= 320, "specialist description exceeds 320-byte budget");
  assert.match(value, /Install Rainbond/i);
  assert.match(value, /local, server, multi-node, or existing-Kubernetes/i);
  assert.match(value, /Rainskills confirms no reachable platform/i);
  assert.match(value, /Exclude application deployment/i);
});

test("root skill discovery metadata is compact and preserves routing boundaries", () => {
  const value = description("SKILL.md");
  assert(Buffer.byteLength(value, "utf8") <= 320, "root description exceeds 320-byte budget");
  assert.match(value, /single Rainskills runtime/i);
  assert.match(value, /Install/i);
  assert.match(value, /connect/i);
  assert.match(value, /reconnect/i);
  assert.match(value, /not application deployment/i);
});
