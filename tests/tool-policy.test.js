"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const { classifyTool } = require("../bin/tool-policy.js");
test("only proven read operations bypass confirmation", () => {
  assert.equal(classifyTool("rainbond_wait_for_build_completion"), "read");
  for (const tool of ["ports", "dependency", "storage", "connection_envs", "envs"]) {
    assert.equal(classifyTool(`rainbond_manage_component_${tool}`, { operation: "summary" }), "read");
    assert.equal(classifyTool(`rainbond_manage_component_${tool}`, { operation: "delete" }), "destructive");
    assert.equal(classifyTool(`rainbond_manage_component_${tool}`, { operation: "unknown" }), "write");
  }
  assert.equal(classifyTool("rainbond_wait_and_deploy"), "write");
  assert.equal(classifyTool("rainbond_get_and_delete_resource"), "destructive");
});
