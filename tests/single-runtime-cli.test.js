"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const bridge = require("../bin/rainskills-tools.js");
const { createSingleRuntimeStore } = require(
  "../rainbond-platform-installer/scripts/single-runtime.js"
);

const SKILL = "rainbond-app-assistant";

test("business CLI requires a Skill but no runtime operation", () => {
  assert.deepEqual(bridge.parseCommand([
    "read", "rainbond_query_apps", "--input", "-", "--skill-id", SKILL,
  ]), {
    command: "read",
    toolName: "rainbond_query_apps",
    input: "-",
    skillId: SKILL,
  });

  assert.deepEqual(bridge.parseCommand([
    "call", "rainbond_create_app", "--input", "-", "--skill-id", SKILL,
  ]), {
    command: "call",
    toolName: "rainbond_create_app",
    input: "-",
    skillId: SKILL,
  });

  assert.throws(() => bridge.parseCommand([
    "read", "rainbond_query_apps", "--input", "-",
  ]), /skill-id/i);
  assert.throws(() => bridge.parseCommand([
    "read", "rainbond_query_apps", "--input", "-", "--skill-id", SKILL,
    "--operation-id", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  ]), /invalid|operation-id|unsupported/i);
});

test("business CLI loads the one protected runtime without environment ids", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "rainskills-single-cli-"));
  createSingleRuntimeStore({ home }).write({
    consoleOrigin: "https://rainbond.example.com",
    kind: "private",
    token: "header.payload.signature",
  });

  const config = bridge.loadConfig({ homeDir: home, includeRuntime: true, env: {} });

  assert.equal(config.baseUrl, "https://rainbond.example.com");
  assert.equal(config.jwt, "header.payload.signature");
  assert.equal(config.isInsecureHttp, false);
  assert.equal(Object.hasOwn(config, "environmentId"), false);
  assert.equal(Object.hasOwn(config, "operationId"), false);
  assert.equal(Object.hasOwn(config, "requiredSkillId"), false);
});

test("stored runtime overrides stale shell credentials unless CI mode is explicit", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "rainskills-single-cli-precedence-"));
  createSingleRuntimeStore({ home }).write({
    consoleOrigin: "http://10.0.0.8:7070",
    kind: "private",
    token: "stored.payload.signature",
    allowInsecureHttp: true,
  });

  const stored = bridge.loadConfig({
    homeDir: home,
    includeRuntime: true,
    env: {
      RAINBOND_URL: "https://stale.example.com",
      RAINBOND_JWT: "stale.payload.signature",
    },
  });
  assert.equal(stored.baseUrl, "http://10.0.0.8:7070");
  assert.equal(stored.jwt, "stored.payload.signature");
  assert.equal(stored.allowInsecureHttp, true);

  const ci = bridge.loadConfig({
    homeDir: home,
    includeRuntime: true,
    env: {
      RAINSKILLS_CREDENTIAL_SOURCE: "environment",
      RAINBOND_URL: "https://ci.example.com",
      RAINBOND_JWT: "ci.payload.signature",
    },
  });
  assert.equal(ci.baseUrl, "https://ci.example.com");
  assert.equal(ci.jwt, "ci.payload.signature");
});

test("write confirmation is scoped to the confirmed call, not a runtime operation", () => {
  const source = fs.readFileSync(path.resolve(__dirname, "../bin/rainskills-tools.js"), "utf8");
  assert.doesNotMatch(source, /runtime_operation_id/);
});
