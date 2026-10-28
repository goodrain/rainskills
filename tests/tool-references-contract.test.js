const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const repoRoot = path.resolve(__dirname, "..");
const contractPath = path.join(repoRoot, "contracts", "tool-references.json");

test("tool-references contract is up to date", async () => {
  const { renderToolReferences } = await import(
    path.join(repoRoot, "scripts", "export-tool-references.mjs")
  );
  assert.equal(
    fs.readFileSync(contractPath, "utf8"),
    renderToolReferences(repoRoot),
    "contracts/tool-references.json 已过期，请运行 node scripts/export-tool-references.mjs"
  );
});

test("tool-references contains the delivery probe adapter", () => {
  const contract = JSON.parse(fs.readFileSync(contractPath, "utf8"));
  const names = new Set(contract.tools.map((tool) => tool.name));
  assert.equal(
    names.has("rainbond_probe_delivery_url"),
    true,
    "delivery verifier must reference a real probe adapter"
  );
  assert.equal(
    contract.tools.some((tool) => tool.name === "rainbond_delete_platform_plugin"),
    false,
    "negative references (do not call X) must not be recorded as required tools"
  );
});
