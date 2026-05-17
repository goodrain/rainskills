---
name: rainbond-template-installer
description: Use when installing a local or cloud Rainbond app template into an existing or newly created target app through the current Rainbond MCP template-install workflow.
---

# Rainbond Template Installer

## MCP 认证失败恢复（JWT 过期 / 401 / 403）

当任何 `rainbond_*` MCP 工具返回 401 / 403 / `unauthorized` / `token expired` 类认证错误时，
禁止重装 skills，也禁止手工改 `~/.rainbond/mcp.env`。先用下面任一命令刷新 JWT：

```bash
bash <(curl -fsSL https://get.rainbond.com/rainskills/install.sh) refresh
# 或：bash ~/.rainbond/skills/install.sh refresh
```

刷新成功后必须提醒用户**重启 Claude Code 或 Codex**（MCP 客户端在进程启动时一次性读取
`RAINBOND_JWT`，刷新后的新 token 不会自动透传到正在运行的客户端）。在用户确认重启之前不要自动
重试同一个 MCP 工具调用。

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
