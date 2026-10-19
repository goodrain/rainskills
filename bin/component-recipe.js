"use strict";
const { BridgeError, EXIT } = require("./bridge-errors.js");
const { validateBatch, executeBatch, projectResult } = require("./confirmed-batch.js");
const CREATE_TOOLS = Object.freeze({ image: "rainbond_create_component_from_image", source: "rainbond_create_component_from_source", package: "rainbond_create_component_from_package" });
const PLACEHOLDER = "0".repeat(32);
function invalid(message = "invalid component recipe; use the component-recipe schema") { throw new BridgeError(message, EXIT.USAGE); }
function prepareRecipe(input) {
  if (!input || input.schema !== "rainskills.component-recipe.v1.request" || Buffer.byteLength(JSON.stringify(input)) > 128 * 1024) invalid();
  if (Object.keys(input).some((key) => !["schema", "scope", "enterprise_id", "kind", "create", "configure", "stateful", "storage"].includes(key))) invalid();
  if (!Object.hasOwn(CREATE_TOOLS, input.kind) || typeof input.enterprise_id !== "string" || !input.enterprise_id) invalid();
  if (!input.create || Array.isArray(input.create) || typeof input.create.service_cname !== "string" || !input.create.service_cname) invalid();
  if (input.create.is_deploy !== undefined && input.create.is_deploy !== false) invalid("creation recipes configure before deployment");
  if (input.stateful !== undefined && typeof input.stateful !== "boolean") invalid();
  if (input.stateful && (!input.storage || !input.storage.volume_path || !input.storage.volume_name || !input.storage.volume_type)) invalid("stateful providers require explicit persistent storage before deployment");
  if (input.kind === "image" && !input.create.image) invalid();
  if (input.kind === "source" && (!input.create.git_url || !input.create.code_from)) invalid();
  if (input.kind === "package" && !input.create.event_id) invalid();
  const configuration = input.configure || [];
  if (!Array.isArray(configuration) || configuration.length > 32 || configuration.some((s) => !s || typeof s !== "object" || Array.isArray(s) || !s.arguments || typeof s.arguments !== "object" || Array.isArray(s.arguments) || Object.hasOwn(s.arguments, "service_id"))) invalid();
  const steps = configuration.map((step) => ({ ...step, arguments: { ...step.arguments, service_id: PLACEHOLDER } }));
  // Reuse the same scope and configuration policy even for an empty recipe.
  validateBatch({ schema: "rainskills.confirmed-batch.v1.request", scope: input.scope, steps: steps.length ? steps : [{ key: "scope-validation", tool: "rainbond_manage_component_ports", arguments: { service_id: PLACEHOLDER, operation: "add", port: 80, protocol: "http" } }] });
  for (const [key, value] of Object.entries(input.scope)) if (Object.hasOwn(input.create, key) && input.create[key] !== value) invalid();
  if (input.storage && Object.keys(input.storage).some((key) => ["service_id", "team_name", "region_name", "app_id", "operation"].includes(key))) invalid();
  return { tool: CREATE_TOOLS[input.kind], arguments: { ...input.create, ...input.scope, is_deploy: false }, steps };
}
async function preflightRecipe(input, { validate, read }) {
  const plan = prepareRecipe(input);
  await validate(plan.tool, plan.arguments);
  for (const step of plan.steps) await validate(step.tool, { ...step.arguments, ...input.scope });
  if (input.storage) await validate("rainbond_manage_component_storage", { ...input.storage, ...input.scope, service_id: PLACEHOLDER, operation: "create_volume" });
  const query = { enterprise_id: input.enterprise_id, app_id: input.scope.app_id, query: input.create.service_cname, page: 1, page_size: 20 };
  await validate("rainbond_query_components", query);
  const observed = await read("rainbond_query_components", query);
  const items = observed?.list || observed?.items;
  if (!Array.isArray(items) || (typeof observed.total === "number" && observed.total > items.length)) invalid("component lookup is incomplete; resolve the exact existing topology first");
  if (items.some((item) => item.service_cname === input.create.service_cname || item.service_alias === input.create.service_cname)) invalid("component already exists; adopt its verified service_id instead of creating again");
  if (input.kind === "package") {
    const args = { team_name: input.scope.team_name, region_name: input.scope.region_name, event_id: input.create.event_id };
    await validate("rainbond_get_package_upload_status", args);
    const status = await read("rainbond_get_package_upload_status", args);
    if (!Array.isArray(status?.uploaded_packages) || !status.uploaded_packages.length) invalid("package upload is empty; complete the protected upload and local cleanup before creation");
  }
  return plan;
}
async function executeRecipe(input, adapters) {
  const plan = await preflightRecipe(input, adapters);
  if (adapters.signal?.aborted) throw new BridgeError("recipe cancelled", EXIT.USAGE, undefined, "E_CANCELLED");
  const created = await adapters.call(plan.tool, plan.arguments);
  const serviceId = created?.service_id || created?.component?.service_id || created?.service?.service_id;
  if (typeof serviceId !== "string" || !serviceId || serviceId.length > 128) throw new BridgeError("creation result lacks a verified service_id; query the exact target before continuing", EXIT.TRANSPORT, undefined, "E_WRITE_RESULT_UNKNOWN");
  const identity = { service_id: serviceId, ...projectResult(created) };
  delete identity.status;
  if (adapters.onCreated) await adapters.onCreated(identity);
  if (adapters.signal?.aborted) return { schema: "rainskills.component-recipe.v1.result", ...identity, status: "partial", blocker: { code: "E_CANCELLED" }, next_action: "query_state" };
  if (input.storage) {
    try { await adapters.call("rainbond_manage_component_storage", { ...input.storage, ...input.scope, service_id: serviceId, operation: "create_volume" }); }
    catch (error) {
      return { schema: "rainskills.component-recipe.v1.result", status: error.exitCode === EXIT.TRANSPORT ? "unknown" : "partial", ...identity, blocker: { code: error.exitCode === EXIT.TRANSPORT ? "E_WRITE_RESULT_UNKNOWN" : "E_PLATFORM" }, next_action: "query_state" };
    }
  }
  let configured = { status: "succeeded", completed: 0, steps: [], blocker: null };
  if (plan.steps.length) configured = await executeBatch({ schema: "rainskills.confirmed-batch.v1.request", scope: input.scope, steps: plan.steps.map((step) => ({ ...step, arguments: { ...step.arguments, service_id: serviceId } })) }, adapters);
  return { schema: "rainskills.component-recipe.v1.result", ...identity, status: configured.status === "failed" ? "partial" : configured.status, configured: configured.completed, steps: configured.steps, blocker: configured.blocker, next_action: configured.status === "succeeded" ? "deploy_and_verify" : "query_state" };
}
module.exports = { prepareRecipe, preflightRecipe, executeRecipe };
