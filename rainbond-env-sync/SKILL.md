---
name: rainbond-env-sync
description: Use when syncing non-sensitive Rainbond preview or production environment overrides for a linked project into local env files before bootstrap, release, or troubleshooting.
---

# Rainbond Env Sync

## Rainbond 传输

如果上游已初始化本次工作流的 RainSkills CLI，直接复用，不重新探测。否则在第一次 Rainbond 调用前读取 [../rainbond-app-assistant/references/transport-resolution.md](../rainbond-app-assistant/references/transport-resolution.md) 并初始化一次。CLI 锁定后，认证、网络、超时和业务错误均不得触发替代调用通道。

## Overview

Use this skill to synchronize **non-sensitive environment override intent** from a linked Rainbond application into local project files.

This skill does **not** replace live runtime inspection. It maintains local environment reference files so future bootstrap, release, and troubleshooting flows need fewer manual inputs.

The goal is to:
1. resolve the linked Rainbond project
2. select the target environment (`preview` or `production`)
3. query current component env state through the locked Rainbond transport
4. keep only **non-sensitive values that differ from the project baseline**
5. treat provider connection envs and dependency-injected connection values as runtime connection metadata and skip them
6. write the result into `.rainbond/env.preview.json` or `.rainbond/env.prod.json`

## Canonical Model Reference

Use [product object model](../rainbond-app-assistant/references/product-object-model.md) as the repository-level source of truth for:

- the `Environment` object boundary
- `.rainbond/env.<env>.json` as a non-sensitive delta projection
- `.rainbond/secrets.<env>.json` as the separate secret layer that must not be merged into env-sync output

This skill should describe how environment intent is synchronized locally. It should not redefine the canonical projection boundaries independently.

## When to Use

Use when:
- a linked project needs a local preview or production env snapshot
- local env files are missing, stale, or intentionally being refreshed
- bootstrap or troubleshooting should rely less on repeated manual parameters
- environment-specific overrides should be captured without storing secrets

Do not use when:
- the project is not yet linked
- the task is to repair runtime issues directly
- the desired output is a live runtime status report rather than a local reference file
- the goal is to persist passwords, tokens, certificates, or private keys

## Scope

This skill manages only:
- `.rainbond/env.preview.json`
- `.rainbond/env.prod.json`

This skill reads context from:
- `rainbond.app.json`
- `.rainbond/local.json`
- user explicit input

This skill trusts for runtime facts only:
- responses from the locked Rainbond transport

This skill writes only:
- project identity fields
- non-sensitive **environment deltas** relative to `rainbond.app.json`
- sync metadata

## Configuration Priority

Resolve context in this order:

1. **Highest priority**: user explicit input for the current sync
2. **Project binding context**: `.rainbond/local.json`
3. **Lowest priority**: `rainbond.app.json` as the project baseline

Rules:
- environment selection: explicit input > `.rainbond/local.json.preferences.default_environment` > `preview`
- app identity: explicit input > `.rainbond/local.json.binding` > `rainbond.app.json.project`
- runtime env facts: the locked Rainbond transport only
- if local files disagree with platform facts, trust the platform response and report the drift

## Output File Model

Expected target files:
- `.rainbond/env.preview.json`
- `.rainbond/env.prod.json`

Recommended structure:

```json
{
  "schema_version": 1,
  "environment": "preview",
  "project": {
    "team_name": "xzlgdo9u",
    "region_name": "rainbond",
    "app_name": "fullstack-demo-v2",
    "app_id": 20
  },
  "component_env_overrides": {
    "api": {
      "env": {
        "NODE_ENV": "preview",
        "ENABLE_BETA": "true"
      }
    }
  },
  "synced_at": "2026-04-01T14:30:00Z",
  "metadata": {
    "status": "synced",
    "synced_by": "Claude Code"
  }
}
```

## Keep vs Skip Rules

### Keep

Keep a value only if it is:
- non-sensitive
- clearly consumed by the application or deployment model
- stable enough to be useful across future runs
- **different from the baseline value in `rainbond.app.json`**

Examples:
- `NODE_ENV=preview`
- a consumer-local feature flag such as `ENABLE_BETA=true`
- a frontend API base URL only if it differs from baseline

### Skip

Do not persist:
- passwords
- tokens
- certificates
- private keys
- usernames tied to secrets
- platform runtime metadata
- provider connection envs
- dependency-injected connection values
- auto-generated helper variables
- values that are identical to the baseline manifest

Examples to skip:
- `*_PASSWORD`
- `*_TOKEN`
- `*_KEY`
- `DB_HOST`
- `DB_PORT`
- `DB_USER`
- `DB_PASS`
- `DB_NAME`
- `REDIS_PASSWORD`
- `KAFKA_BROKERS`
- `PORT*_HOST`
- `PORT*_PORT`
- `API_HOST`
- `API_PORT`

### Important Distinction

This skill stores **environment override intent**, not a raw runtime dump.

Provider connection envs and dependency-derived runtime connection values are always treated as **runtime connection metadata**, even when they differ from `rainbond.app.json` or from older local env files.

Examples of runtime connection metadata that must always be skipped:
- `DB_HOST`
- `DB_PORT`
- `DB_USER`
- `DB_PASS`
- `DB_NAME`
- `REDIS_PASSWORD`
- `KAFKA_BROKERS`
- `PORT*_HOST`
- `PORT*_PORT`
- `API_HOST`
- `API_PORT`

If a value is:
- ephemeral
- auto-generated by the platform
- only useful at runtime
- a dependency-derived runtime connection coordinate
- a provider connection env intended to be injected into dependents
- identical to `rainbond.app.json`
- not something a human should maintain

then skip it.

## Workflow

Follow this order.

### Fixed Tool fast path and conflict gate

Read `rainbond_query_components`, `rainbond_manage_component_envs(operation=summary)`, and `rainbond_manage_component_connection_envs(operation=summary)` for the requested components. Before any write, call `rainbond_analyze_env_conflicts`; if it reports a conflict, stop and show only non-sensitive key names. Do not overwrite automatically and do not run `list` or `describe` to discover known Tools.

1. Resolve context
- read user explicit target environment if provided
- read `.rainbond/local.json`
- read `rainbond.app.json` as baseline
- determine:
  - `team_name`
  - `region_name`
  - `app_name`
  - `app_id`
  - target environment file

2. Validate link state
- if `.rainbond/local.json` is missing or `metadata.status != linked`, stop and tell the user to link first
- do not guess `app_id`

3. Query Rainbond runtime state
- query app detail
- query component list
- identify components from locked-transport data first
- use local files only as hints for naming and roles

4. Gather env candidates
For each relevant component:
- inspect current envs and connection envs through the locked Rainbond transport
- compare with project baseline in `rainbond.app.json`
- identify values that represent meaningful non-sensitive overrides
- classify provider connection envs and dependency-injected connection values as runtime connection metadata before delta evaluation

5. Filter values
- keep only values that satisfy the Keep rules
- remove platform runtime metadata
- remove provider connection envs and dependency-injected connection values even when they differ from baseline
- skip all sensitive values
- skip values that are identical to the baseline manifest
- if unsure, prefer skipping and explain why

6. Write target file
- update:
  - `schema_version`
  - `environment`
  - `project`
  - `component_env_overrides`
  - `synced_at`
  - `metadata.status = synced`
  - `metadata.synced_by`

7. Report result
- summarize what was kept as deltas
- summarize what was removed as runtime metadata
- summarize what was skipped as sensitive
- summarize what was skipped because it matched baseline
- note any detected drift between local files and Rainbond runtime state

## Drift Reporting

If Rainbond runtime differs from local files:
- trust the locked Rainbond transport
- update the env file based on platform-derived, filtered values
- explicitly report the drift in output

Examples:
- local app name differs from bound app
- expected override key differs from deployed override key
- local config references a component name that no longer matches runtime

## Verification Standard

A sync is successful when:
- the target environment file exists
- project identity fields are correct
- non-sensitive, durable deltas are captured
- sensitive values are omitted
- runtime metadata noise is omitted
- values identical to baseline are omitted
- sync metadata is updated

A sync is **not** required to:
- prove app health
- repair runtime problems
- ensure preview and production files are identical

## Output Format

Target structured output:

- this skill should eventually be able to emit an `Environment`-centered sync result
- minimum target fields:
  - `environment`
  - `project`
  - `env_delta`
  - `skip_reasons`
  - `next_action`
- the human-readable sections below should be treated as the narrative view over that target object
- once implemented, append a final `### Structured Output` section after the human-readable report and render the sync result object in fenced `yaml`

Proposed schema:

```yaml
EnvironmentSyncResult:
  environment:
    name: preview | production
    source: explicit | local_preference | default
  project:
    team_name: string
    region_name: string
    app_name: string
    app_id: positive integer | null # normalize a decimal session string at every Rainbond Tool boundary; reject non-numeric IDs
  env_delta:
    component_env_overrides: map
  skip_reasons:
    sensitive: string[]
    runtime_metadata: string[]
    baseline_match: string[]
    ambiguous: string[]
  synced_at: string
  metadata:
    status: synced | drifted | unlinked
    synced_by: string
  next_action: string
```

Example object:

```json
{
  "environment": {
    "name": "preview",
    "source": "local_preference"
  },
  "project": {
    "team_name": "xzlgdo9u",
    "region_name": "rainbond",
    "app_name": "fullstack-demo-v2",
    "app_id": 20
  },
  "env_delta": {
    "component_env_overrides": {
      "api": {
        "env": {
          "NODE_ENV": "preview",
          "ENABLE_BETA": "true"
        }
      }
    }
  },
  "skip_reasons": {
    "sensitive": ["DB_PASSWORD"],
    "runtime_metadata": ["DB_HOST", "DB_NAME", "API_PORT"],
    "baseline_match": ["TZ"],
    "ambiguous": []
  },
  "synced_at": "2026-04-14T03:55:00Z",
  "metadata": {
    "status": "synced",
    "synced_by": "env-sync v1"
  },
  "next_action": "bootstrap"
}
```

Example final reply:

````markdown
### Sync Result
Sync succeeded and updated `.rainbond/env.preview.json`.

### Resolved Project
`team_name` xzlgdo9u, `region_name` rainbond, `app_name` fullstack-demo-v2, `app_id` 20, selected environment `preview`.

### Captured Overrides
- `api`: kept `NODE_ENV=preview` and `ENABLE_BETA=true`.
- `web`: kept `API_BASE_URL=https://preview.example.com/api`.

### Skipped Values
- sensitive values: `DB_PASSWORD`
- runtime metadata: `DB_HOST`, `DB_NAME`, `API_PORT`
- values skipped because they matched baseline: `TZ`
- ambiguous values intentionally not persisted: `none`

### Next Step
bootstrap

### Structured Output
```yaml
EnvironmentSyncResult:
  environment:
    name: preview
    source: local_preference
  project:
    team_name: xzlgdo9u
    region_name: rainbond
    app_name: fullstack-demo-v2
    app_id: 20
  env_delta:
    component_env_overrides:
      api:
        env:
          NODE_ENV: preview
          ENABLE_BETA: "true"
      web:
        env:
          API_BASE_URL: https://preview.example.com/api
  skip_reasons:
    sensitive:
      - DB_PASSWORD
    runtime_metadata:
      - DB_HOST
      - DB_NAME
      - API_PORT
    baseline_match:
      - TZ
    ambiguous: []
  synced_at: "2026-04-14T03:55:00Z"
  metadata:
    status: synced
    synced_by: env-sync v1
  next_action: bootstrap
```
````

Always respond using exactly these sections:

### Sync Result
- state whether the sync succeeded
- state which environment file was updated

### Resolved Project
- state `team_name`, `region_name`, `app_name`, `app_id`
- state which environment was selected

### Captured Overrides
- list kept values by component
- show only non-sensitive values that differ from baseline

### Skipped Values
Split into:
- sensitive values
- runtime metadata
- values skipped because they matched baseline
- ambiguous values intentionally not persisted

### Next Step
- suggest the most appropriate next action
- examples:
  - bootstrap
  - troubleshooter
  - production sync
  - drift review

### Structured Output
- append a fenced `yaml` block
- render `EnvironmentSyncResult`
- keep enum values and field names aligned with the schema above
- never include secrets in the structured object

## Common Mistakes

- treating env sync as a runtime health check
- persisting passwords or tokens
- dumping all runtime env vars into the file
- keeping platform-generated connection metadata
- copying baseline values into the env file
- guessing app identity when the project is not linked
- using local files as runtime truth when the locked Rainbond transport says otherwise

## Quick Reference

Priority summary:
1. explicit input
2. `.rainbond/local.json`
3. `rainbond.app.json`
4. runtime truth from the locked Rainbond transport only

Keep:
- durable, non-sensitive, app-meaningful deltas relative to baseline

Skip:
- secrets
- certs
- keys
- passwords
- usernames tied to secrets
- platform runtime metadata
- provider connection envs and dependency-injected connection values (`DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASS`, `DB_NAME`, `REDIS_PASSWORD`, `KAFKA_BROKERS`, `PORT*_HOST`, `PORT*_PORT`, `API_HOST`, `API_PORT`)
- any value identical to `rainbond.app.json`

Typical next actions after sync:
- run `rainbond-fullstack-bootstrap`
- run `rainbond-fullstack-troubleshooter`
- sync production env
- compare preview vs production overrides
