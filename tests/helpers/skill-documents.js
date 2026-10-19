"use strict";
const fs = require("node:fs");
const path = require("node:path");
// Contract audits inspect the maintained documents together. Agent loading is
// checked separately by the progressive-disclosure path and budget tests.
function readSkillDocument(root, relative) {
  const base = "rainbond-app-assistant/references/";
  const folders = { "workflow-rules.md": ["phases"], "product-object-model.md": ["objects"], "output-contract.md": ["results"] };
  const name = relative.startsWith(base) ? relative.slice(base.length) : "";
  const content = fs.readFileSync(path.join(root, relative), "utf8");
  if (!folders[name]) return content;
  const files = folders[name].flatMap((folder) => fs.readdirSync(path.join(root, base, folder)).filter((file) => file.endsWith(".md")).sort().map((file) => path.join(root, base, folder, file)));
  if (name === "output-contract.md") files.push(path.join(root, base, "customer-result.md"), path.join(root, base, "structured-result.md"));
  return [content, ...files.map((file) => fs.readFileSync(file, "utf8"))].join("\n");
}
module.exports = { readSkillDocument };
