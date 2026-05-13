---
name: rainbond-template-installer
description: Use when installing a local or cloud Rainbond app template into an existing or newly created target app through the current Rainbond MCP template-install workflow.
---

# Rainbond Template Installer

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
