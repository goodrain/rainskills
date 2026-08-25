"use strict";

const path = require("node:path");

const CONTROL_PATTERN = /[\u0000-\u001f\u007f-\u009f]/u;
const CREDENTIAL_KEY_PATTERN = /(?:^|_)(?:auth|authorization|cookie|credential|jwt|password|secret|token)(?:_|$)|(?:api|private)[_-]?key/i;
const IDENTIFIER_FIELDS = new Set(["enterprise_id", "team_id", "app_id", "service_id", "template_id", "snapshot_id", "market_id"]);
const MAX_IDENTIFIER_LENGTH = 128;
const MAX_PATH_LENGTH = 2048;
const MAX_VERSION_LENGTH = 128;

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

const INTENT_DEFINITIONS = deepFreeze({
  "environment-add": {
    skillId: "rainskills",
    required: [],
    optional: [],
    enums: {},
    steps: ["connect"],
  },
  deploy: {
    skillId: "rainbond-app-assistant",
    required: [],
    optional: ["project_root", "source_kind", "source_url", "service_id"],
    enums: { source_kind: ["local", "git", "image", "package"] },
    steps: ["project-analysis", "topology", "build", "runtime", "access-verification"],
  },
  create: {
    skillId: "rainbond-app-assistant",
    required: [],
    optional: ["project_root", "source_kind", "source_url", "service_id"],
    enums: { source_kind: ["local", "git", "image", "package"] },
    steps: ["project-analysis", "topology", "build", "runtime", "access-verification"],
  },
  "template-install": {
    skillId: "rainbond-template-installer",
    required: ["template_id", "install_scope"],
    optional: ["team_id", "app_id"],
    enums: { install_scope: ["new-app", "existing-app"] },
    steps: ["lookup", "install", "verify"],
  },
  query: {
    skillId: "rainbond-app-assistant",
    required: ["operation"],
    optional: ["team_id", "app_id", "service_id"],
    enums: { operation: ["summary", "components", "events", "logs", "access"] },
    steps: ["resolve-target", "read"],
  },
  "platform-query": {
    skillId: "rainbond-platform-query",
    required: ["resource"],
    optional: ["enterprise_id", "team_id", "app_id"],
    enums: { resource: ["current-user", "current-enterprise", "teams", "regions", "apps", "team-apps", "components"] },
    steps: ["resolve-context", "read"],
  },
  troubleshoot: {
    skillId: "rainbond-app-assistant",
    required: ["operation"],
    optional: ["team_id", "app_id", "service_id"],
    enums: { operation: ["auto", "build", "runtime", "access"] },
    steps: ["resolve-target", "diagnose", "repair", "verify"],
  },
  modify: {
    skillId: "rainbond-app-assistant",
    required: ["team_id", "app_id", "operation"],
    optional: ["service_id"],
    enums: { operation: ["component-config", "build-source", "ports", "env", "storage", "dependency"] },
    steps: ["resolve-target", "apply", "verify"],
  },
  "delivery-verify": {
    skillId: "rainbond-delivery-verifier",
    required: ["operation"],
    optional: ["team_id", "app_id", "service_id"],
    enums: { operation: ["full", "runtime", "access"] },
    steps: ["resolve-target", "runtime", "access"],
  },
  snapshot: {
    skillId: "rainbond-app-version-assistant",
    required: ["team_id", "app_id", "operation"],
    optional: ["snapshot_id"],
    enums: { operation: ["create", "inspect"] },
    steps: ["resolve-target", "prepare", "apply", "verify"],
  },
  publish: {
    skillId: "rainbond-app-version-assistant",
    required: ["team_id", "app_id", "destination"],
    optional: ["snapshot_id", "market_id", "version"],
    enums: { destination: ["local-library", "cloud-market"] },
    steps: ["resolve-target", "prepare", "apply", "verify"],
  },
  rollback: {
    skillId: "rainbond-app-version-assistant",
    required: ["team_id", "app_id", "snapshot_id", "operation"],
    optional: [],
    enums: { operation: ["preview", "apply"] },
    steps: ["resolve-target", "prepare", "apply", "verify"],
  },
  "env-sync": {
    skillId: "rainbond-env-sync",
    required: ["project_root", "environment"],
    optional: ["team_id", "app_id", "service_id"],
    enums: { environment: ["preview", "production"] },
    steps: ["resolve-target", "sync", "verify"],
  },
  "project-init": {
    skillId: "rainbond-project-init",
    required: ["project_root"],
    optional: ["source_kind", "source_url"],
    enums: { source_kind: ["local", "git", "image", "package"] },
    steps: ["project-analysis", "manifest", "link"],
  },
  bootstrap: {
    skillId: "rainbond-fullstack-bootstrap",
    required: ["project_root"],
    optional: ["team_id", "app_id", "service_id"],
    enums: {},
    steps: ["resolve-target", "topology", "build"],
  },
  "troubleshoot-phase": {
    skillId: "rainbond-fullstack-troubleshooter",
    required: ["operation"],
    optional: ["team_id", "app_id", "service_id"],
    enums: { operation: ["auto", "build", "runtime", "access"] },
    steps: ["resolve-target", "diagnose", "repair", "verify"],
  },
  "opensource-deploy": {
    skillId: "rainbond-opensource-app-deploy",
    required: ["source_kind"],
    optional: ["project_root", "source_url"],
    enums: { source_kind: ["compose", "helm", "images"] },
    steps: ["topology", "model", "deploy", "verify"],
  },
});

function assertBoundedString(value, field, maximum) {
  if (typeof value !== "string" || !value || value.length > maximum) {
    throw new Error(`${field} 必须是长度不超过 ${maximum} 的非空字符串`);
  }
  if (CONTROL_PATTERN.test(value)) throw new Error(`${field} 不能包含控制字符`);
  return value;
}

function canonicalHttpsSourceUrl(value) {
  assertBoundedString(value, "source_url", MAX_PATH_LENGTH);
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("source_url 必须是规范的 HTTPS URL");
  }
  if (
    parsed.protocol !== "https:"
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
    || value.includes("?")
    || value.includes("#")
  ) {
    throw new Error("source_url 必须是无 userinfo、query 和 fragment 的 HTTPS URL");
  }
  return parsed.toString();
}

function validateIntent(input, { pathApi = path } = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("intent 必须是对象");
  }
  for (const key of Object.keys(input)) {
    if (CREDENTIAL_KEY_PATTERN.test(key)) throw new Error(`intent 不能包含凭据字段：${key}`);
  }
  const type = input.type;
  if (type === undefined || type === null || type === "") {
    throw new Error("intent 缺少必填字段：type");
  }
  if (!Object.hasOwn(INTENT_DEFINITIONS, type)) throw new Error(`未知 intent type：${String(type)}`);
  const definition = INTENT_DEFINITIONS[type];
  const allowed = new Set(["type", ...definition.required, ...definition.optional]);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) throw new Error(`intent 包含未知字段：${key}`);
  }

  const result = { type };
  for (const field of definition.required) {
    if (input[field] === undefined || input[field] === null || input[field] === "") {
      throw new Error(`intent 缺少必填字段：${field}`);
    }
  }
  for (const field of [...definition.required, ...definition.optional]) {
    const value = input[field];
    if (value === undefined) continue;
    if (definition.enums[field]) {
      if (!definition.enums[field].includes(value)) {
        throw new Error(`${field} 不是允许的固定值`);
      }
      result[field] = value;
    } else if (field === "source_url") {
      result[field] = canonicalHttpsSourceUrl(value);
    } else if (field === "project_root") {
      const projectRoot = assertBoundedString(value, field, MAX_PATH_LENGTH);
      if (!projectRoot.trim() || projectRoot.trim() !== projectRoot) {
        throw new Error("project_root 不能是纯空白或包含前后空白");
      }
      if (!pathApi || typeof pathApi.resolve !== "function") throw new Error("project_root path API 无效");
      result[field] = assertBoundedString(pathApi.resolve(projectRoot), field, MAX_PATH_LENGTH);
    } else if (field === "version") {
      result[field] = assertBoundedString(value, field, MAX_VERSION_LENGTH);
    } else if (IDENTIFIER_FIELDS.has(field)) {
      result[field] = assertBoundedString(value, field, MAX_IDENTIFIER_LENGTH);
    }
  }
  if (["deploy", "create"].includes(type) && result.source_url && !result.source_kind) {
    throw new Error("应用来源 URL 必须同时指定 source_kind");
  }
  return result;
}

function isExistingAppIntent(intent) {
  if (["query", "platform-query", "troubleshoot", "troubleshoot-phase", "env-sync", "modify", "delivery-verify", "snapshot", "publish", "rollback"].includes(intent.type)) {
    return true;
  }
  if (intent.type === "template-install") return intent.install_scope === "existing-app";
  if (intent.type === "bootstrap") return Boolean(intent.app_id || intent.service_id);
  return ["deploy", "create"].includes(intent.type) && Boolean(intent.service_id);
}

function assertIntentCanInstallNewPlatform(input) {
  const intent = validateIntent(input);
  if (isExistingAppIntent(intent)) {
    throw new Error("existing-app intent 不能进入新平台安装分支");
  }
  return intent;
}

function createIntentContinuation(input, resumeStep) {
  const intent = validateIntent(input);
  const definition = INTENT_DEFINITIONS[intent.type];
  const fixedStep = resumeStep || definition.steps[0];
  if (!definition.steps.includes(fixedStep)) throw new Error("resume step 不是该 intent 的固定步骤");
  return {
    schema: "rainskills.intent-continuation.v1",
    skill_id: definition.skillId,
    intent,
    resume_step: fixedStep,
  };
}

module.exports = {
  INTENT_DEFINITIONS,
  assertIntentCanInstallNewPlatform,
  canonicalHttpsSourceUrl,
  createIntentContinuation,
  deepFreeze,
  isExistingAppIntent,
  validateIntent,
};
