"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  TEST_SCRIPTS,
  runTestSuite,
} = require("../scripts/run-test-suite.js");

test("test suite runner isolates every child from production telemetry", () => {
  const calls = [];
  const status = runTestSuite({
    env: { PATH: "/usr/bin", RAINSKILLS_TELEMETRY_DISABLED: "0" },
    platform: "win32",
    spawnImpl(command, args, options) {
      calls.push({ command, args, options });
      return { status: 0 };
    },
  });

  assert.equal(status, 0);
  assert.equal(calls.length, TEST_SCRIPTS.length);
  assert(calls.every((call) => call.command === "npm.cmd"));
  assert.deepEqual(
    calls.map((call) => call.args),
    TEST_SCRIPTS.map((script) => ["run", script])
  );
  assert(calls.every((call) => call.options.env.RAINSKILLS_TELEMETRY_DISABLED === "1"));
  assert(calls.every((call) => call.options.env.RAINSKILLS_PACKAGE_VERSION === "test"));
  assert(calls.every((call) => call.options.stdio === "inherit"));
});

test("test suite runner stops after the first failed child", () => {
  let calls = 0;
  const status = runTestSuite({
    spawnImpl() {
      calls += 1;
      return { status: calls === 2 ? 7 : 0 };
    },
  });

  assert.equal(status, 7);
  assert.equal(calls, 2);
});
