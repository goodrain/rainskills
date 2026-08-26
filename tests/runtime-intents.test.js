"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const modulePath = path.resolve(
  __dirname,
  "..",
  "rainbond-platform-installer",
  "scripts",
  "runtime-intents.js"
);

const cases = [
  ["deploy", "rainbond-app-assistant", { project_root: "/workspace/app", source_kind: "local" }, "project-analysis"],
  ["create", "rainbond-app-assistant", { project_root: "/workspace/app", source_kind: "git", source_url: "https://github.com/example/app.git" }, "project-analysis"],
  ["template-install", "rainbond-template-installer", { template_id: "wordpress", install_scope: "new-app" }, "lookup"],
  ["query", "rainbond-app-assistant", { operation: "summary" }, "resolve-target"],
  ["platform-query", "rainbond-platform-query", { resource: "teams", enterprise_id: "enterprise-1" }, "resolve-context"],
  ["troubleshoot", "rainbond-app-assistant", { operation: "runtime", app_id: "app-1" }, "resolve-target"],
  ["modify", "rainbond-app-assistant", { team_id: "team-1", app_id: "app-1", operation: "env" }, "resolve-target"],
  ["delivery-verify", "rainbond-delivery-verifier", { operation: "full", app_id: "app-1" }, "resolve-target"],
  ["snapshot", "rainbond-app-version-assistant", { team_id: "team-1", app_id: "app-1", operation: "create" }, "resolve-target"],
  ["publish", "rainbond-app-version-assistant", { team_id: "team-1", app_id: "app-1", destination: "local-library", version: "1.2.3" }, "resolve-target"],
  ["rollback", "rainbond-app-version-assistant", { team_id: "team-1", app_id: "app-1", snapshot_id: "snapshot-1", operation: "preview" }, "resolve-target"],
  ["env-sync", "rainbond-env-sync", { project_root: "/workspace/app", environment: "preview", app_id: "app-1" }, "resolve-target"],
  ["project-init", "rainbond-project-init", { project_root: "/workspace/app", source_kind: "local" }, "project-analysis"],
  ["bootstrap", "rainbond-fullstack-bootstrap", { project_root: "/workspace/app", app_id: "app-1" }, "resolve-target"],
  ["troubleshoot-phase", "rainbond-fullstack-troubleshooter", { operation: "build", app_id: "app-1" }, "resolve-target"],
  ["opensource-deploy", "rainbond-opensource-app-deploy", { source_kind: "compose", source_url: "https://example.com/compose.yaml" }, "topology"],
];

test("every bounded runtime intent maps to a fixed Skill and first resume step", () => {
  const { createIntentContinuation, validateIntent } = require(modulePath);

  for (const [type, skillId, fields, resumeStep] of cases) {
    const intent = validateIntent({ type, ...fields });
    assert.equal(require("node:fs").existsSync(path.resolve(__dirname, "..", skillId, "SKILL.md")), true);
    assert.deepEqual(createIntentContinuation(intent), {
      schema: "rainskills.intent-continuation.v1",
      skill_id: skillId,
      intent,
      resume_step: resumeStep,
    });
  }
});

test("runtime Skills publish their bound mutable-call argv", () => {
  const fs = require("node:fs");
  const { INTENT_DEFINITIONS } = require(modulePath);
  const skillIds = new Set(Object.values(INTENT_DEFINITIONS)
    .map((definition) => definition.skillId)
    .filter((skillId) => fs.existsSync(path.resolve(__dirname, "..", skillId, "SKILL.md"))));

  for (const skillId of skillIds) {
    const skill = fs.readFileSync(path.resolve(__dirname, "..", skillId, "SKILL.md"), "utf8");
    assert.match(skill, new RegExp(`--skill-id ${skillId}`));
    assert.match(skill, /--confirm <confirmation-id>/);
  }
});

test("new deploy and create intents can defer application source until the runtime is ready", () => {
  const { createIntentContinuation, validateIntent } = require(modulePath);

  for (const type of ["deploy", "create"]) {
    const intent = validateIntent({ type });
    assert.deepEqual(intent, { type });
    assert.deepEqual(createIntentContinuation(intent), {
      schema: "rainskills.intent-continuation.v1",
      skill_id: "rainbond-app-assistant",
      intent: { type },
      resume_step: "project-analysis",
    });
  }
});

test("deferred application source fields remain bounded and internally consistent", () => {
  const { validateIntent } = require(modulePath);

  assert.deepEqual(validateIntent({ type: "deploy", project_root: "/workspace/app" }), {
    type: "deploy",
    project_root: "/workspace/app",
  });
  assert.deepEqual(validateIntent({ type: "create", source_kind: "git" }), {
    type: "create",
    source_kind: "git",
  });
  assert.throws(
    () => validateIntent({ type: "deploy", source_url: "https://example.com/app.git" }),
    /source_kind|应用来源/i
  );
});

test("intent validation rejects unknown and credential-like fields", () => {
  const { validateIntent } = require(modulePath);

  assert.throws(
    () => validateIntent({ resource: "current-enterprise" }),
    /intent.*缺少.*type/i
  );
  assert.throws(
    () => validateIntent({ type: "query", operation: "summary", prompt: "deploy everything" }),
    /unknown|未知/i
  );
  assert.throws(
    () => validateIntent({ type: "query", operation: "summary", access_token: "do-not-store" }),
    /credential|凭据/i
  );
  assert.throws(
    () => validateIntent({ type: "query", operation: "summary", app_id: "bad\nvalue" }),
    /control|控制/i
  );
  assert.throws(() => validateIntent({ type: "__proto__" }), /unknown|未知/i);
});

test("source_url is canonical HTTPS without credentials, query, or fragment", () => {
  const { validateIntent } = require(modulePath);
  const base = { type: "deploy", project_root: "/workspace/app", source_kind: "git" };

  assert.equal(validateIntent({ ...base, source_url: "https://github.com/example/app.git" }).source_url,
    "https://github.com/example/app.git");
  for (const source_url of [
    "http://github.com/example/app.git",
    "https://user:password@github.com/example/app.git",
    "https://github.com/example/app.git?token=secret",
    "https://github.com/example/app.git?",
    "https://github.com/example/app.git#access_token=secret",
    "https://github.com/example/app.git#",
  ]) {
    assert.throws(() => validateIntent({ ...base, source_url }), /source_url|HTTPS/i);
  }
});

test("image-backed intents use bounded OCI image fields instead of source_url", () => {
  const { validateIntent } = require(modulePath);

  assert.deepEqual(validateIntent({
    type: "create",
    source_kind: "image",
    image_ref: "nginx:1.27",
  }), {
    type: "create",
    source_kind: "image",
    image_ref: "nginx:1.27",
  });
  assert.deepEqual(validateIntent({
    type: "opensource-deploy",
    source_kind: "images",
    image_refs: [
      "registry.example.com:5000/team/web:v1",
      `redis@sha256:${"a".repeat(64)}`,
    ],
  }), {
    type: "opensource-deploy",
    source_kind: "images",
    image_refs: [
      "registry.example.com:5000/team/web:v1",
      `redis@sha256:${"a".repeat(64)}`,
    ],
  });

  assert.throws(
    () => validateIntent({ type: "create", source_kind: "image", source_url: "nginx:latest" }),
    /image_ref/
  );
  assert.throws(
    () => validateIntent({
      type: "opensource-deploy",
      source_kind: "images",
      source_url: "https://example.com/images.txt",
    }),
    /image_refs/
  );

  for (const intent of [
    { type: "create", source_kind: "local", source_url: "https://example.com/app.git" },
    { type: "project-init", project_root: "/workspace/app", source_url: "https://example.com/app.git" },
    { type: "create", source_kind: "git", image_ref: "nginx:1.27" },
    { type: "opensource-deploy", source_kind: "compose", image_refs: ["nginx:1.27"] },
  ]) {
    assert.throws(() => validateIntent(intent), /source_kind|source_url|image_ref|镜像/i);
  }

  for (const image_ref of [
    "",
    " nginx:1.27",
    "nginx:1.27 ",
    "https://docker.io/library/nginx:latest",
    "nginx:latest;touch-pwned",
    "nginx:latest\nredis:7",
    "registry.example.com:70000/team/web:v1",
    `nginx@sha256:${"a".repeat(63)}`,
  ]) {
    assert.throws(
      () => validateIntent({ type: "create", source_kind: "image", image_ref }),
      /image_ref|镜像/i
    );
  }
  assert.throws(
    () => validateIntent({ type: "opensource-deploy", source_kind: "images", image_refs: [] }),
    /image_refs|镜像/i
  );
});

test("project_root is a canonical absolute path without surrounding whitespace", () => {
  const nodePath = require("node:path");
  const { validateIntent } = require(modulePath);
  const base = { type: "deploy", source_kind: "local" };

  assert.equal(validateIntent({ ...base, project_root: "." }).project_root, process.cwd());
  assert.equal(
    validateIntent({ ...base, project_root: "../x" }).project_root,
    nodePath.resolve("../x")
  );
  for (const project_root of ["", "   ", " ./app", "./app ", "./bad\0root", "./bad\nroot"]) {
    assert.throws(() => validateIntent({ ...base, project_root }), /project_root|控制|空白/i);
  }
  assert.throws(() => validateIntent({ ...base, project_root: "a".repeat(2048) }), /project_root|2048/i);

  const pathApi = { resolve: (value) => `C:\\canonical\\${value.replaceAll("/", "\\")}` };
  assert.equal(validateIntent({ ...base, project_root: "src/app" }, { pathApi }).project_root,
    "C:\\canonical\\src\\app");
});

test("operation and destination values are closed enums", () => {
  const { validateIntent } = require(modulePath);
  for (const intent of [
    { type: "query", operation: "delete" },
    { type: "platform-query", resource: "credentials" },
    { type: "troubleshoot", operation: "shell" },
    { type: "modify", team_id: "team-1", app_id: "app-1", operation: "exec" },
    { type: "delivery-verify", operation: "credentials" },
    { type: "snapshot", team_id: "team-1", app_id: "app-1", operation: "delete" },
    { type: "publish", team_id: "team-1", app_id: "app-1", destination: "arbitrary-url" },
    { type: "rollback", team_id: "team-1", app_id: "app-1", snapshot_id: "snap-1", operation: "force" },
    { type: "env-sync", project_root: "/workspace/app", environment: "staging" },
    { type: "project-init", project_root: "/workspace/app", source_kind: "archive" },
    { type: "troubleshoot-phase", operation: "shell" },
  ]) {
    assert.throws(() => validateIntent(intent), /固定值|allowed/i);
  }
});

test("intent definitions are recursively immutable", () => {
  const { INTENT_DEFINITIONS } = require(modulePath);

  assert.equal(Object.isFrozen(INTENT_DEFINITIONS), true);
  assert.equal(Object.isFrozen(INTENT_DEFINITIONS.query), true);
  assert.equal(Object.isFrozen(INTENT_DEFINITIONS.query.steps), true);
  assert.equal(Object.isFrozen(INTENT_DEFINITIONS.query.enums), true);
  assert.equal(Object.isFrozen(INTENT_DEFINITIONS.query.enums.operation), true);
  assert.throws(() => INTENT_DEFINITIONS.query.steps.push("shell"), TypeError);
  assert.throws(() => { INTENT_DEFINITIONS.query.skillId = "unsafe-skill"; }, TypeError);
});

test("new platform setup rejects intents that require an existing app", () => {
  const { assertIntentCanInstallNewPlatform, validateIntent } = require(modulePath);

  assert.doesNotThrow(() => assertIntentCanInstallNewPlatform(validateIntent({
    type: "template-install",
    template_id: "wordpress",
    install_scope: "new-app",
  })));
  assert.throws(() => assertIntentCanInstallNewPlatform(validateIntent({
    type: "template-install",
    template_id: "wordpress",
    install_scope: "existing-app",
    app_id: "app-1",
  })), /existing|已有|现有/i);
  assert.throws(() => assertIntentCanInstallNewPlatform(validateIntent({
    type: "query",
    operation: "summary",
    app_id: "app-1",
  })), /existing|已有|现有/i);
  assert.throws(() => assertIntentCanInstallNewPlatform(validateIntent({
    type: "platform-query",
    resource: "teams",
    enterprise_id: "enterprise-1",
  })), /existing|已有|现有/i);
  assert.throws(() => assertIntentCanInstallNewPlatform(validateIntent({
    type: "env-sync",
    project_root: "/workspace/app",
    environment: "production",
  })), /existing|已有|现有/i);
  assert.throws(() => assertIntentCanInstallNewPlatform(validateIntent({
    type: "troubleshoot-phase",
    operation: "runtime",
  })), /existing|已有|现有/i);
  assert.doesNotThrow(() => assertIntentCanInstallNewPlatform(validateIntent({
    type: "project-init",
    project_root: "/workspace/app",
  })));
  assert.doesNotThrow(() => assertIntentCanInstallNewPlatform(validateIntent({
    type: "bootstrap",
    project_root: "/workspace/app",
  })));
  assert.throws(() => assertIntentCanInstallNewPlatform(validateIntent({
    type: "bootstrap",
    project_root: "/workspace/app",
    app_id: "app-1",
  })), /existing|已有|现有/i);
  assert.throws(() => assertIntentCanInstallNewPlatform(validateIntent({
    type: "bootstrap",
    project_root: "/workspace/app",
    service_id: "service-1",
  })), /existing|已有|现有/i);
});

test("bootstrap existing-app classification follows explicit identifier cases", () => {
  const { isExistingAppIntent, validateIntent } = require(modulePath);
  const cases = [
    [{ type: "bootstrap", project_root: "/workspace/app" }, false],
    [{ type: "bootstrap", project_root: "/workspace/app", team_id: "team-1" }, false],
    [{ type: "bootstrap", project_root: "/workspace/app", app_id: "app-1" }, true],
    [{ type: "bootstrap", project_root: "/workspace/app", service_id: "service-1" }, true],
    [{ type: "bootstrap", project_root: "/workspace/app", app_id: "app-1", service_id: "service-1" }, true],
  ];

  for (const [sample, expected] of cases) {
    assert.equal(isExistingAppIntent(validateIntent(sample)), expected, JSON.stringify(sample));
  }
});
