"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const { verifyPublishedPackage } = require("../scripts/verify-published-package.js");

test("published package verification always disables telemetry and isolates HOME", () => {
  const calls = [];
  const status = verifyPublishedPackage("0.1.41", {
    env: { HOME: "/real/home", PATH: "/usr/bin" },
    platform: "linux",
    temporaryDirectory: "/tmp/rainskills-published-test",
    spawnImpl(command, args, options) {
      calls.push({ command, args, options });
      return { status: 0 };
    },
  });

  assert.equal(status, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "npx");
  assert.deepEqual(calls[0].args, [
    "--yes", "--package=rainskills@0.1.41", "rainskills", "all", "--force", "--no-telemetry",
  ]);
  assert.equal(calls[0].options.env.HOME, "/tmp/rainskills-published-test/home");
  assert.equal(calls[0].options.env.HERMES_HOME, "/tmp/rainskills-published-test/hermes");
  assert.equal(calls[0].options.env.RAINSKILLS_TELEMETRY_DISABLED, "1");
  assert.equal(calls[0].options.env.RAINSKILLS_PACKAGE_VERSION, "test");
  assert.equal(calls[0].options.cwd, path.resolve("/tmp/rainskills-published-test"));
});

test("published package verification rejects unsafe package selectors", () => {
  for (const value of ["", "1.2", "1.2.3;touch /tmp/x", "../latest", "next beta"]) {
    assert.throws(() => verifyPublishedPackage(value, { spawnImpl() {} }), /版本/);
  }
});
