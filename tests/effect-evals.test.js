"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");

test("effect eval corpus is complete, unique, routed, and hash-pinned", async () => {
  const { loadEffectCases } = await import("../scripts/validate-effect-evals.mjs");
  const cases = loadEffectCases({ root });
  assert.equal(cases.length, 28);
  assert.equal(new Set(cases.map((entry) => entry.skill_id)).size, 14);
  assert.equal(new Set(cases.map((entry) => entry.id)).size, 28);
});
