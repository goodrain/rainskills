"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const launcherPath = path.resolve(__dirname, "../bin/rainskills.js");
const {
  classifyNodeMajor,
  parseRuntimeConnectArgs,
  resolveInvocation,
  runtimeChildEnvironment,
  runtimeConnectionInvocation,
  runBuiltin,
} = require(launcherPath);

test("launcher exposes the supported Node policy", () => {
  assert.equal(classifyNodeMajor(17), "unsupported");
  assert.equal(classifyNodeMajor(18), "eol");
  assert.equal(classifyNodeMajor(20), "eol");
  assert.equal(classifyNodeMajor(22), "supported");
});

test("launcher rejects the removed local MCP entry point", () => {
  assert.throws(
    () => resolveInvocation(["mcp", "serve", "--client", "codex"]),
    /不再提供本地 MCP 服务/
  );
});

test("runtime connect accepts one environment route without a business intent", () => {
  assert.deepEqual(parseRuntimeConnectArgs([
    "runtime", "connect", "codex", "--saas",
  ]), {
    targetClient: "codex",
    environmentChoice: "saas",
    rainbondUrl: "",
    allowInsecureHttp: false,
    privateLocation: undefined,
  });
  assert.deepEqual(parseRuntimeConnectArgs([
    "runtime", "connect", "claude", "--rainbond-url", "https://console.example.com",
  ]), {
    targetClient: "claude",
    environmentChoice: "private-existing",
    rainbondUrl: "https://console.example.com",
    allowInsecureHttp: false,
    privateLocation: undefined,
  });
  assert.throws(() => parseRuntimeConnectArgs([
    "runtime", "connect", "codex", "--saas", "--rainbond-url", "https://other.example.com",
  ]), /互斥/);
});

test("runtime connector child never inherits a cached credential", () => {
  const token = "header.payload.signature";
  const forwarded = runtimeChildEnvironment({
    HOME: "/tmp/home",
    PATH: "/usr/bin",
    RAINBOND_URL: "https://console.example.com/",
    RAINBOND_JWT: token,
    UNRELATED_SECRET: "no",
  }, {}, "https://console.example.com");
  assert.equal(forwarded.RAINBOND_JWT, undefined);
  assert.equal(forwarded.RAINBOND_URL, undefined);
  assert.equal(forwarded.UNRELATED_SECRET, undefined);

  const rejected = runtimeChildEnvironment({
    RAINBOND_URL: "https://other.example.com",
    RAINBOND_JWT: token,
  }, {}, "https://console.example.com");
  assert.equal(rejected.RAINBOND_JWT, undefined);
});

test("POSIX runtime connection uses fixed installer argv", () => {
  const invocation = runtimeConnectionInvocation({
    targetClient: "codex",
    environmentChoice: "private-existing",
    allowInsecureHttp: true,
  }, "http://10.0.0.8:7070");
  assert.deepEqual(invocation, {
    executable: "bash",
    args: [
      path.resolve(__dirname, "../install.sh"),
      "connect", "codex", "--self-hosted", "--rainbond-url", "http://10.0.0.8:7070",
      "--allow-insecure-http", "--no-cached-token",
    ],
  });
});

test("private platform installation returns one bounded next action", async () => {
  const output = [];
  const next = {
    schema: "rainskills.next-action.v1",
    action: "install-platform",
    onboarding_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    argv: ["platform", "install", "--onboarding-id", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"],
  };
  assert.equal(await runBuiltin([
    "runtime", "connect", "codex", "--install-private", "--location", "local",
  ], {
    privateInstallerScheduler(input) {
      assert.equal(input.intent, undefined);
      assert.equal(input.privateLocation, "local");
      return next;
    },
    write: (value) => output.push(value),
  }), true);
  assert.deepEqual(JSON.parse(output.join("")), next);
});

test("runtime status remains an in-process command", async () => {
  const output = [];
  assert.equal(await runBuiltin(["runtime", "status", "--json"], {
    runtimeStateManager: {
      status: async () => ({
        schema: "rainskills.runtime-status.v1",
        state: "connected",
        usable: true,
      }),
    },
    write: (value) => output.push(value),
  }), true);
  assert.equal(JSON.parse(output.join("")).usable, true);
});
