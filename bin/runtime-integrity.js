"use strict";

const fs = require("node:fs");
const path = require("node:path");
const MODULES = Object.freeze({
  "rainskills-tools.js": "main",
  "handoff-context.js": "createHandoffContext",
  "read-snapshot.js": "executeReadSnapshot",
  "protected-poll.js": "executeProtectedPoll",
  "delivery-probe.js": "createDeliveryProbe",
  "bridge-errors.js": "errorResult",
  "confirmed-batch.js": "validateBatch",
  "component-recipe.js": "prepareRecipe",
  "tool-policy.js": "classifyTool",
});
function checkRuntimeIntegrity(directory = __dirname) {
  const missing = [];
  for (const [name, entrypoint] of Object.entries(MODULES)) {
    try {
      const target = path.join(directory, name);
      const info = fs.lstatSync(target);
      if (!info.isFile() || info.isSymbolicLink() || typeof require(target)[entrypoint] !== "function") missing.push(name);
    } catch { missing.push(name); }
  }
  return { status: missing.length ? "failed" : "ok", missing };
}
module.exports = { checkRuntimeIntegrity };
