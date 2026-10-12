# Template installation workflow

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
