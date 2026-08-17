---
name: rainbond-template-installer
description: "Use when the user explicitly asks to install a local or cloud Rainbond application template into a new or existing target app. Trigger phrases include: 从模板安装 WordPress 应用 / 安装应用模板 / install app template."
---

# Rainbond Template Installer

<!-- rainskills-runtime-gate:start -->
## 运行环境门禁（最高优先级）

第一步检查 Node.js 是否存在且主版本不低于 18。Node.js 缺失或低于 18 时，只说明“Rainskills 执行组件需要 Node.js 18 或更高版本”并停止：不选择运行环境，不调用 MCP，不猜测替代命令。只有用户或 agent 明确同意后才安装或升级 Node.js，再从同一原始 intent 继续。

固定 launcher 是 `["npx", "--yes", "rainskills@0.1.0-rc.61"]`；版本必须与本技能包 `package.json` 一致。把 launcher 与参数拼成 argv 数组直接执行，禁止 `rainskills@latest` 或执行 shell 字符串。

前置检查通过后先执行 launcher + `["runtime", "status", "--json"]`，先于任何业务 MCP。`not_started` 不能因历史 MCP 跳过；只有 `connected`、`usable = true` 且本次 live probe 成功才继续，探针失败必须 reconnect。

<!-- rainskills-runtime-contract:start -->
```json
{
  "schema": "rainskills.skill-runtime-contract.v1",
  "launcher": ["npx", "--yes", "rainskills@0.1.0-rc.61"],
  "intents": {
    "template-install": {"required": ["template_id", "install_scope"], "optional": ["team_id", "app_id"], "enums": {"install_scope": ["new-app", "existing-app"]}}
  },
  "routes": {
    "new": ["saas", "private-existing", "install-private"],
    "existing": ["saas", "private-existing"]
  },
  "connect_argv": {
    "saas": ["npx", "--yes", "rainskills@0.1.0-rc.61", "runtime", "connect", "<target>", "--saas", "--intent-json", "<intent-json>"],
    "private-existing": ["npx", "--yes", "rainskills@0.1.0-rc.61", "runtime", "connect", "<target>", "--rainbond-url", "<rainbond-url>", "--intent-json", "<intent-json>"],
    "install-private": ["npx", "--yes", "rainskills@0.1.0-rc.61", "runtime", "connect", "<target>", "--install-private", "--intent-json", "<intent-json>"]
  }
}
```
<!-- rainskills-runtime-contract:end -->

`install_scope=new-app` 使用 new route，`install_scope=existing-app` 使用 existing route；existing 路径绝不执行 `install-private`。target 只允许 `codex`、`claude`、`all`。校验 intent 后只执行对应 scope 的完整 argv；只消费 schema 为 `rainskills.next-action.v1` 且校验后的 `argv` 数组。

连接完成后用固定 `onboarding-id` 执行 launcher + `["intent", "resume", "--onboarding-id", "<同一 onboarding-id>"]`，恢复原始 intent 和 `resume_step`。401 先执行 launcher + `["runtime", "record-failure", "--onboarding-id", "<同一 onboarding-id>", "--step", "<当前固定步骤>", "--reason", "credential-expired"]`，再仅一次执行 launcher + `["runtime", "reconnect", "--onboarding-id", "<同一 onboarding-id>"]` 后 resume，只重试该步骤；第二次 401 停止。403 执行 launcher + `["runtime", "record-failure", "--onboarding-id", "<同一 onboarding-id>", "--step", "<当前固定步骤>", "--reason", "permission-denied"]` 后停止，不得 reconnect、重新授权或自动重试。
<!-- rainskills-runtime-gate:end -->

<!-- rainskills-runtime-routing:start -->
## 缺少运行环境时

先说：“可以，我会帮你从模板安装应用。不过目前还没有可用的应用运行环境。你刚安装的 Rainskills 是 AI 部署助手，它负责分析项目并执行部署；应用实际会运行在 Rainbond 上。Rainbond 是一套应用运行和管理平台，负责源码构建、容器运行、域名访问、日志和存储等工作，你不需要了解 Kubernetes。”

先根据 `install_scope` 确认 scope，确认前不展示环境选项：`new-app` 使用 new scope，`existing-app` 使用 existing scope。

### 新应用

#### 第一次选择

请提示“请选择应用要运行的环境：”，并只显示：

1) Rainbond Cloud（在线，无需安装）
2) 私有 Rainbond（自己的环境）

#### 选择私有 Rainbond 后

只有用户选择私有 Rainbond 后，才继续显示：

a) 连接已有私有 Rainbond
b) 帮我安装私有 Rainbond

选择 a 时执行 `private-existing` route；选择 b 时执行 `install-private` route。第一问不得并列展示已有私有和安装私有。

### 已有应用

已有应用的 template-install intent 不得进入 install-private：只让用户选择 Rainbond Cloud 或承载目标应用的已有私有 Rainbond，已有应用不得安装新平台。
<!-- rainskills-runtime-routing:end -->

## Overview

Use this skill to install a Rainbond application template into a target app.

This skill is for the **template installation workflow**, not generic component bootstrap.

It should:
1. determine whether the user wants a local template or a cloud market template
2. query the correct template source
3. query available versions
4. ensure a target app exists
5. install the selected template into that app
6. return a structured result with what was installed

This skill is the correct execution path when a component or app is sourced from a template-install flow.

## Canonical Model Reference

Use `docs/product-object-model.md` as the repository-level source of truth for:

- `ComponentSource.kind = template`
- `template_install` as a handoff path rather than bootstrap execution
- the boundary between template-install intent, deployment planning, and downstream runtime/delivery stages

This skill should describe how template-install intent is executed through MCP. It should not redefine the canonical object boundaries independently.

## When to Use

Use when:
- the user wants to install an app from a local template market
- the user wants to install an app from a cloud market
- a `template` source in project design should be translated into actual Rainbond installation steps
- the system must query template versions before installation
- the user wants to add a template-based app into an existing target app

Do not use when:
- the task is to create components directly from image or source
- the task is runtime troubleshooting
- the template source or target app context is completely unknown and cannot be resolved
- the user wants only template discovery without installation

## Preferred MCP Tools

Prefer this tool chain:
- `rainbond_query_cloud_markets`
- `rainbond_query_local_app_models`
- `rainbond_query_cloud_app_models`
- `rainbond_query_app_model_versions`
- `rainbond_create_app`
- `rainbond_install_app_model`

Avoid preferring:
- `rainbond_install_app_by_market`

Reason:
- the new chain separates discovery, version selection, target-app creation, and install more clearly
- `rainbond_install_app_model` supports both local and cloud flows

## Input Resolution

Resolve values in this order:
1. user explicit input
2. `.rainbond/local.json`
3. `rainbond.app.json`

Required installation context:
- `team_name`
- `region_name`
- target `app_id` or enough information to create a target app
- template source:
  - `local`
  - `cloud`

Required template identity:
- `app_model_id`
- `app_model_version`

Additional required value when `source = cloud`:
- `market_name`

## Source Types

### 1. Local template
Use:
- `rainbond_query_local_app_models`
- `rainbond_query_app_model_versions`
- `rainbond_install_app_model`

### 2. Cloud template
Use:
- `rainbond_query_cloud_markets`
- `rainbond_query_cloud_app_models`
- `rainbond_query_app_model_versions`
- `rainbond_install_app_model`

## Workflow

Follow this order.

1. Resolve target app context
- determine `team_name` and `region_name`
- determine whether a target `app_id` already exists
- if no target app exists, create one with `rainbond_create_app`

2. Resolve template source
- if the user explicitly said local or cloud, use that
- if not explicit and the template source is ambiguous, ask the user or inspect available context

3. Discover template
- for `cloud`:
  - query cloud markets if `market_name` is not yet known
  - query cloud app models
- for `local`:
  - query local app models

4. Resolve version
- query template versions
- if the user explicitly named a version, use it
- if exactly one version exists, use it
- if multiple versions exist and the user did not choose, prefer the latest stable-looking version and state that choice clearly

5. Install
- call `rainbond_install_app_model`
- pass:
  - `team_name`
  - `region_name`
  - `app_id`
  - `source`
  - `market_name` when cloud
  - `app_model_id`
  - `app_model_version`
  - `is_deploy = true` unless the user explicitly wants otherwise

6. Report
- confirm whether installation succeeded
- list target app
- summarize installed services

## App Creation Rules

If no target app exists:
- create one first using `rainbond_create_app`
- prefer the minimum safe parameters
- do not pass `k8s_app` unless the user explicitly asks for a custom application English name

Reason:
- `k8s_app` is optional
- passing it incorrectly can cause validation or duplication errors

### App name collision during creation

When `rainbond_create_app` fails because the target app name already exists
(error contains `应用名称已存在`, `app name exists`, `duplicate`, `already exists`,
or any equivalent name-conflict signal):

The user's original intent was a **new target app**, not "reuse whatever app
exists in the team". Preserve that intent by auto-retrying with a numeric
suffix instead of stopping or grabbing an unrelated app.

Default recovery:
1. Retry `rainbond_create_app` with a numeric suffix: first `<original-name>-2`,
   then `-3`, `-4` if those also collide. Stop after 3 suffix attempts.
2. On success, proceed with `rainbond_install_app_model` against the new app
   and **explicitly mention the rename in the final report** so the user can
   override:
   > `pinpoint-apm` 已被占用，已用 `pinpoint-apm-2` 创建新应用。如需复用现有
   > `pinpoint-apm` 应用，请告知。
3. If 3 suffix attempts all collide, then pause and ask the user — at that
   point the namespace is genuinely contested and a human decision is warranted.

Hard prohibitions (regardless of recovery path):
- never silently install into an existing app whose name does not match the
  user's original intent (e.g. requested `pinpoint-apm` → installing into
  `big-screen-vue-datav`). This violates user intent and is forbidden.
- never list team apps and "pick a reasonable one" as a substitute for the
  intended new app.
- never treat "an app with this name exists" as equivalent to "the user wants
  to reuse that app" without explicit user confirmation.

The user may still choose to reuse the existing same-name app — but only when
they explicitly say so, not as a silent fallback.

## Version Selection Rules

If version is missing:
- never install blindly without checking versions first
- query versions first

Selection policy:
- user-specified version wins
- if only one version exists, use it
- if multiple versions exist, choose the latest stable-looking version and say so explicitly

## Error Handling Rules

### Invalid `source`
Only allow:
- `local`
- `cloud`

### Missing `market_name` for cloud source
- query cloud markets first
- then resolve and retry

### Missing target app
- create it first

### App name conflict on create
- see `App Creation Rules > App name collision during creation`
- default: auto-retry with `-2`, `-3`, `-4` suffix and mention the rename in the report
- never substitute an unrelated existing app
- pause for user choice only after 3 suffix attempts all collide

### Installation fails
Before concluding the template is unavailable, verify:
- `team_name`
- `region_name`
- `app_id`
- `source`
- `market_name` when cloud
- `app_model_id`
- `app_model_version`

## Output Format

Target structured output:

- this skill should eventually be able to emit `TemplateInstallResult`
- minimum target fields:
  - `template_install_intent`
  - `install_status`
  - `services_summary`
  - `next_action`
- the human-readable sections below should be treated as the narrative view over that target object
- once implemented, append a final `### Structured Output` section after the human-readable report and render `TemplateInstallResult` in fenced `yaml`

Proposed schema:

```yaml
TemplateInstallResult:
  template_install_intent:
    source: local | cloud
    market_name: string | null
    app_model_id: string
    app_model_version: string
    version_selection_reason: user_choice | single_version | latest_stable
    target_app:
      team_name: string
      region_name: string
      app_id: string
      app_reused: boolean
  install_status: pending | success | failed
  services_summary: string[]
  next_action: stop | review_installed_services | run_troubleshooter | resolve_missing_template_metadata
```

Example object:

```yaml
TemplateInstallResult:
  template_install_intent:
    source: cloud
    market_name: official-market
    app_model_id: model-123
    app_model_version: 1.0.3
    version_selection_reason: latest_stable
    target_app:
      team_name: rainbond-demo
      region_name: singapore
      app_id: app-88
      app_reused: true
  install_status: success
  services_summary:
    - postgres
    - api
    - web
  next_action: run_troubleshooter
```

Example final reply:

````markdown
### Template Source
Installation source is `cloud`, `market_name` is `official-market`.

### Resolved Template
`app_model_id` model-123, `app_model_version` 1.0.3, version selection reason `latest_stable`.

### Target App
`team_name` rainbond-demo, `region_name` singapore, `app_id` app-88, target app was reused.

### Install Result
Install succeeded. Installed services: `postgres`, `api`, `web`.

### Next Step
run troubleshooter

### Structured Output
```yaml
TemplateInstallResult:
  template_install_intent:
    source: cloud
    market_name: official-market
    app_model_id: model-123
    app_model_version: 1.0.3
    version_selection_reason: latest_stable
    target_app:
      team_name: rainbond-demo
      region_name: singapore
      app_id: app-88
      app_reused: true
  install_status: success
  services_summary:
    - postgres
    - api
    - web
  next_action: run_troubleshooter
```
````

Always respond using exactly these sections:

### Template Source
- state whether installation is from `local` or `cloud`
- include `market_name` when relevant

### Resolved Template
- state `app_model_id`
- state `app_model_version`
- state how the version was chosen

### Target App
- state `team_name`
- state `region_name`
- state `app_id`
- state whether the app was reused or created

### Install Result
- state whether install succeeded
- include `installed` or equivalent result
- summarize installed services if available

### Next Step
- one of:
  - `stop, install complete`
  - `review installed services`
  - `run troubleshooter`
  - `resolve missing template metadata`

### Structured Output
- append a fenced `yaml` block
- render `TemplateInstallResult`
- keep enum values and field names aligned with the schema above
- include `app_reused` and template version resolution details when known

## Common Mistakes

- using `rainbond_install_app_by_market` when the newer template-install chain is available
- installing without checking versions first
- forgetting `market_name` for cloud templates
- creating a target app but then not reusing its `app_id`
- passing `k8s_app` by default
- treating template installation as the same thing as component bootstrap
- on app-name collision, silently picking an unrelated existing app from the
  team list (e.g. requested `pinpoint-apm` exists → assistant installs into
  `big-screen-vue-datav` instead). This violates user intent and must never
  happen — auto-retry with suffix instead. See the collision handling rules above.
- on app-name collision, immediately pausing to ask the user which of 4 options
  they want. This is also wrong — silent retry with `-2/-3/-4` and a clear
  rename notice in the report is the default; only pause after 3 suffix
  attempts all collide.

## Quick Reference

Cloud flow:
1. query cloud markets
2. query cloud app models
3. query versions
4. create app if needed
5. install

Local flow:
1. query local app models
2. query versions
3. create app if needed
4. install

Current install MCP:
- `rainbond_install_app_model`
