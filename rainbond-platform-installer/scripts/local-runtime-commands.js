"use strict";

const { createEnvironmentCredentialStore } = require("./environment-credentials.js");
const { createEnvironmentRegistry } = require("./environment-registry.js");
const { createRuntimeOperationStore } = require("./runtime-operations.js");
const { renderCatalogUserMessage } = require("./user-message.js");

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function requireFixedValue(args, index, flag) {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} 缺少参数值`);
  return value;
}

function createLocalRuntimeServices() {
  let operations;
  const registry = createEnvironmentRegistry({
    activeOperationIds: (environmentId) => operations?.activeOperationIds(environmentId) || [],
  });
  operations = createRuntimeOperationStore({ registry });
  return {
    environmentCredentialStore: createEnvironmentCredentialStore(),
    environmentRegistry: registry,
    operationStore: operations,
  };
}

function parseEnvironmentMutationArgs(args) {
  const action = args[1];
  if (!new Set(["rename", "set-default", "remove"]).has(action)) {
    throw new Error("environment action 无效");
  }
  if (args[2] !== "--environment-id" || !UUID_PATTERN.test(args[3] || "")) {
    throw new Error("环境 ID 无效");
  }
  if (action === "rename") {
    if (args.length !== 6 || args[4] !== "--name" || !args[5] || args[5].startsWith("--")) {
      throw new Error("environment rename 参数无效");
    }
    return { action, environmentId: args[3], name: args[5] };
  }
  if (args.length !== 4) throw new Error(`environment ${action} 参数无效`);
  return { action, environmentId: args[3] };
}

function parseOperationBeginArgs(args) {
  if (args[0] !== "operation" || args[1] !== "begin") {
    throw new Error("operation begin 参数无效");
  }
  let operationId = "";
  let environmentId = "";
  let intentInput = "";
  for (let index = 2; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--operation-id") {
      operationId = requireFixedValue(args, index, argument);
      index += 1;
    } else if (argument === "--environment-id") {
      environmentId = requireFixedValue(args, index, argument);
      index += 1;
    } else if (argument === "--intent-json") {
      intentInput = requireFixedValue(args, index, argument);
      index += 1;
    } else {
      throw new Error("operation begin 包含未知参数");
    }
  }
  if (!UUID_PATTERN.test(operationId)) throw new Error("operation ID 无效");
  if (environmentId && !UUID_PATTERN.test(environmentId)) throw new Error("环境 ID 无效");
  if (!intentInput || intentInput.length > 16384) throw new Error("operation begin 缺少 intent JSON");
  let intent;
  try {
    intent = JSON.parse(intentInput);
  } catch {
    throw new Error("operation begin intent JSON 无效");
  }
  return { operationId, environmentId: environmentId || undefined, intent };
}

function runLocalRuntimeCommand(args, {
  environmentCredentialStore,
  environmentRegistry,
  operationStore,
  write = (value) => process.stdout.write(value),
  controlPlatform = process.platform,
} = {}) {
  let services;
  const getServices = () => {
    services ||= createLocalRuntimeServices();
    return services;
  };
  const registry = () => environmentRegistry || getServices().environmentRegistry;
  const operations = () => operationStore || getServices().operationStore;
  const credentials = () => environmentCredentialStore
    || getServices().environmentCredentialStore;

  if (args[0] === "environment" && args[1] === "list") {
    if (args.length !== 3 || args[2] !== "--json") {
      throw new Error("environment list 只支持固定参数 --json");
    }
    const current = registry().read();
    write(`${JSON.stringify({
      schema: "rainskills.environment-list.v1",
      default_environment_id: current.default_environment_id,
      environments: current.environments,
    })}\n`);
    return true;
  }

  if (args[0] === "environment" && ["rename", "set-default", "remove"].includes(args[1])) {
    const input = parseEnvironmentMutationArgs(args);
    let environment;
    let action;
    if (input.action === "rename") {
      environment = registry().rename(input.environmentId, input.name);
      action = "renamed";
    } else if (input.action === "set-default") {
      environment = registry().setDefault(input.environmentId);
      action = "default-changed";
    } else {
      environment = registry().remove(input.environmentId);
      credentials().remove(input.environmentId);
      action = "removed";
    }
    write(`${JSON.stringify({
      schema: "rainskills.environment-result.v1",
      action,
      environment,
    })}\n`);
    return true;
  }

  if (args[0] === "operation" && args[1] === "begin") {
    const operation = operations().begin(parseOperationBeginArgs(args));
    write(`${JSON.stringify({
      schema: "rainskills.operation-begin-result.v1",
      operation_id: operation.operation_id,
      environment_id: operation.environment_id,
      intent: operation.intent,
      stage: operation.stage,
    })}\n`);
    return true;
  }

  if (args[0] === "operation" && args[1] === "complete") {
    if (
      args.length !== 4
      || args[2] !== "--operation-id"
      || !UUID_PATTERN.test(args[3] || "")
    ) {
      throw new Error("operation complete 参数无效");
    }
    const operation = operations().complete(args[3]);
    write(`${JSON.stringify({
      schema: "rainskills.operation-complete-result.v1",
      operation_id: operation.operation_id,
      environment_id: operation.environment_id,
      stage: operation.stage,
    })}\n`);
    return true;
  }

  if (args[0] === "runtime" && args[1] === "message") {
    if (args.length !== 4 || args[2] !== "--id") {
      throw new Error("runtime message 只支持固定参数 --id");
    }
    write(renderCatalogUserMessage(args[3], { controlPlatform }));
    return true;
  }

  return false;
}

module.exports = {
  createLocalRuntimeServices,
  parseEnvironmentMutationArgs,
  parseOperationBeginArgs,
  runLocalRuntimeCommand,
};
