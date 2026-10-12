"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");

test("repository performance scenarios produce deterministic diagnostics", async () => {
  const { runRepositoryBenchmark } = await import("../scripts/run-skill-performance-benchmark.mjs");
  const first = runRepositoryBenchmark({ root });
  const second = runRepositoryBenchmark({ root });
  assert.deepEqual(second, first);
  assert.equal(first.schema, "rainskills.repository-performance.v1");
  assert.equal(first.scenarios.length, 8);
  assert.equal(first.summary.scenario_count, 8);
  for (const scenario of first.scenarios) {
    assert.equal(scenario.benchmark_layer, "repository");
    assert.equal(scenario.data_source, "static_bundle_and_mock_trace");
    assert.equal(scenario.result, "success");
    assert.equal(scenario.routing.status, "pass");
    assert.equal(scenario.safety.status, "pass");
    assert(Number.isSafeInteger(scenario.markdown_bytes_read));
    assert(Number.isSafeInteger(scenario.mock.backend_requests));
    assert(Number.isSafeInteger(scenario.mock.transport_bytes));
  }
});
