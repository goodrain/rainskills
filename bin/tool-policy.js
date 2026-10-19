"use strict";

const RISK_POLICY = Object.freeze({
  version: "2",
  readPrefixes: ["rainbond_query_", "rainbond_get_", "rainbond_list_", "rainbond_check_", "rainbond_describe_", "rainbond_validate_", "rainbond_verify_", "rainbond_search_"],
  destructiveFragments: ["delete", "remove", "purge", "destroy"],
});
const SUMMARY_TOOLS = new Set(["ports", "dependency", "storage", "connection_envs", "envs"].map((name) => `rainbond_manage_component_${name}`));
function classifyTool(toolName, argumentsValue = {}) {
  const name = String(toolName || "").toLowerCase();
  const operation = typeof argumentsValue.operation === "string" ? argumentsValue.operation.trim().toLowerCase() : "";
  if (SUMMARY_TOOLS.has(name)) {
    if (operation === "summary") return "read";
    if (RISK_POLICY.destructiveFragments.some((part) => operation.includes(part))) return "destructive";
    return "write";
  }
  if (RISK_POLICY.destructiveFragments.some((part) => name.includes(part))) return "destructive";
  if (name === "rainbond_wait_for_build_completion" || RISK_POLICY.readPrefixes.some((prefix) => name.startsWith(prefix))) return "read";
  return "write";
}
module.exports = { RISK_POLICY, classifyTool };
