"use strict";

const { BridgeError, EXIT } = require("./bridge-errors.js");
const SCHEMA = "rainskills.confirmed-batch.v1.request";
const CONFIG_OPERATIONS = Object.freeze({
  rainbond_manage_component_envs: ["upsert"],
  rainbond_manage_component_ports: ["add", "enable_inner", "enable_outer", "disable_outer", "update_protocol", "update_alias"],
  rainbond_manage_component_connection_envs: ["create", "update"],
  rainbond_manage_component_dependency: ["add"],
});
const plain = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const validString = (v) => typeof v === "string" && v.length > 0 && v.length <= 128 && !/[\u0000-\u001f\u007f]/u.test(v);
function invalid() { throw new BridgeError("invalid batch; use the confirmed-batch schema and one verified app scope", EXIT.USAGE); }
function keys(value, allowed) { if (!plain(value) || Object.keys(value).some((key) => !allowed.includes(key))) invalid(); }
function validateBatch(input) {
  if (Buffer.byteLength(JSON.stringify(input) || "") > 128 * 1024) invalid();
  keys(input, ["schema", "scope", "steps"]);
  if (input.schema !== SCHEMA) invalid();
  keys(input.scope, ["team_name", "region_name", "app_id"]);
  const scope = input.scope;
  if (!validString(scope.team_name) || !validString(scope.region_name) || !Number.isInteger(scope.app_id) || scope.app_id < 1) invalid();
  if (!Array.isArray(input.steps) || input.steps.length < 1 || input.steps.length > 32) invalid();
  const names = new Set();
  return input.steps.map((step) => {
    keys(step, ["key", "tool", "arguments"]);
    if (!validString(step.key) || Buffer.byteLength(step.key) > 64 || names.has(step.key) || !plain(step.arguments)) invalid();
    names.add(step.key);
    if (!Object.hasOwn(CONFIG_OPERATIONS, step.tool) || !CONFIG_OPERATIONS[step.tool].includes(step.arguments.operation)) invalid();
    if (!validString(step.arguments.service_id)) invalid();
    for (const [key, value] of Object.entries(scope)) {
      if (Object.hasOwn(step.arguments, key) && step.arguments[key] !== value) invalid();
    }
    return { key: step.key, tool: step.tool, arguments: { ...step.arguments, ...scope } };
  });
}
function projectResult(value) {
  const output = {};
  for (const key of ["service_id", "event_id", "app_id", "created", "updated", "status"]) {
    if (["string", "boolean", "number"].includes(typeof value?.[key])) output[key] = typeof value[key] === "string" ? value[key].slice(0, 128) : value[key];
  }
  return output;
}
function boundedResult(output) {
  if (Buffer.byteLength(JSON.stringify(output)) <= 8192) return output;
  return { ...output, details_omitted: true, steps: output.steps.map(({ key, status }) => ({ key, status })) };
}
function configurationSatisfied(tool, args, snapshot) {
  if (!snapshot || typeof snapshot !== "object") return false;
  if (tool === "rainbond_manage_component_ports") {
    const items = snapshot.ports?.items;
    if (!Array.isArray(items)) return false;
    const desired = args.ports || [{ port: args.port, protocol: args.protocol, port_alias: args.port_alias, is_inner_service: args.is_inner_service ?? args.enable_inner }];
    return desired.length > 0 && desired.every((item) => {
      const port = typeof item === "number" ? item : item.port;
      const current = items.find((value) => (value.container_port ?? value.port) === port);
      if (!current) return false;
      if (args.operation === "add") {
        const requested = typeof item === "number" ? {} : { ...item, is_inner_service: item.is_inner_service ?? item.enable_inner };
        return ["protocol", "port_alias", "is_inner_service", "k8s_service_name"].every((key) => requested[key] === undefined || current[key] === requested[key]);
      }
      if (args.operation === "enable_inner") return current.is_inner_service === true;
      if (args.operation === "enable_outer") return current.is_outer_service === true;
      if (args.operation === "disable_outer") return current.is_outer_service === false;
      return args.operation === "update_protocol" ? current.protocol === args.protocol : args.operation === "update_alias" && ["port_alias", "k8s_service_name"].some((key) => args[key] !== undefined) && ["port_alias", "k8s_service_name"].every((key) => args[key] === undefined || current[key] === args[key]);
    });
  }
  if (tool === "rainbond_manage_component_dependency") {
    if (!Array.isArray(snapshot.dependencies) || args.open_inner) return false;
    const desired = args.dep_service_ids || [args.dep_service_id];
    return desired.length > 0 && desired.every((id) => id && snapshot.dependencies.some((value) => (typeof value === "string" ? value : value.service_id) === id));
  }
  if (tool === "rainbond_manage_component_envs" && args.operation === "upsert") {
    const items = snapshot.custom_envs?.items;
    const desired = args.envs || [{ attr_name: args.attr_name || args.name, attr_value: args.attr_value, is_change: args.is_change }];
    if (!Array.isArray(items) || !desired.length) return false;
    return desired.every((env) => items.some((item) => item.attr_name === (env.attr_name || env.name)
      && item.attr_value !== "[REDACTED]" && item.attr_value === env.attr_value
      && (env.is_change === undefined || item.is_change === env.is_change)));
  }
  if (tool === "rainbond_manage_component_connection_envs") {
    const items = snapshot.connection_envs?.items;
    if (!Array.isArray(items) || args.operation !== "create") return false;
    return items.some((item) => item.attr_name === (args.attr_name || args.name) && item.attr_value !== "[REDACTED]" && item.attr_value === args.attr_value);
  }
  return false;
}
async function executeBatch(input, { validate, call, signal, isSatisfied = async () => false, onProgress = async () => {} }) {
  const steps = validateBatch(input);
  for (const step of steps) await validate(step.tool, step.arguments);
  const output = { schema: "rainskills.confirmed-batch.v1.result", status: "succeeded", completed: 0, skipped: 0, steps: steps.map(({ key }) => ({ key, status: "not_executed" })), blocker: null };
  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index];
    try {
      if (signal?.aborted) throw Object.assign(new Error("cancelled"), { code: "E_CANCELLED" });
      if (await isSatisfied(step)) {
        output.skipped += 1;
        output.steps[index] = { key: step.key, status: "skipped" };
        await onProgress(output);
        continue;
      }
      if (signal?.aborted) throw Object.assign(new Error("cancelled"), { code: "E_CANCELLED" });
      const value = await call(step.tool, step.arguments);
      output.steps[index] = { key: step.key, status: "succeeded", ...projectResult(value) };
      // The batch status describes execution, not a platform-specific status field.
      output.steps[index].status = "succeeded";
      output.completed += 1;
    } catch (error) {
      const unknown = error.code === "E_WRITE_RESULT_UNKNOWN" || error.exitCode === EXIT.TRANSPORT;
      output.steps[index] = { key: step.key, status: unknown ? "unknown" : "failed" };
      output.status = unknown ? "unknown" : output.completed ? "partial" : "failed";
      const code = unknown ? "E_WRITE_RESULT_UNKNOWN" : ["E_CANCELLED", "E_PLAN_STALE"].includes(error.code) ? error.code : "E_PLATFORM";
      output.blocker = { key: step.key, code, next_action: unknown ? "query_state" : "inspect_error" };
      await onProgress(output);
      return boundedResult(output);
    }
    await onProgress(output);
  }
  return boundedResult(output);
}
module.exports = { validateBatch, executeBatch, projectResult, configurationSatisfied };
