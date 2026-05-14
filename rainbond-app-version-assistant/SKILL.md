---
name: rainbond-app-version-assistant
description: Use when working in the Rainbond app version center flow under `/team/.../apps/:appID/version`, especially to create snapshots, publish to the local library or cloud market, inspect publish drafts and events, or rollback app runtime to a snapshot.
---

# Rainbond App Version Assistant

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

Use this skill for the real app version center workflow behind the `/version` route.

This skill is for:
- snapshot timeline inspection
- snapshot creation
- publish draft creation and editing
- publish event execution
- publish completion or give-up
- snapshot rollback and rollback record tracking

This skill is **not** the market-app upgrade flow under `/upgrade`.

## Canonical Model Reference

Use `docs/product-object-model.md` as the repository-level source of truth for:

- `Release`, `Snapshot`, and `Rollback` object boundaries
- the distinction between delivery acceptance and version-center operations
- orchestrator-level handoff expectations from delivery flow into version flow

This skill should model version-center operations themselves. It should not redefine the broader product lifecycle independently.

## When to Use

Use when:
- the user wants to inspect the app version center
- the user wants to create a snapshot from current runtime state
- the user wants to publish a snapshot to the local component library
- the user wants to publish a snapshot to the cloud app market
- the user needs to continue an unfinished publish draft
- the user needs to inspect publish events or publish records
- the user wants to rollback current runtime to a historical snapshot
- the user wants to inspect snapshot rollback records

Do not use when:
- the task is market app upgrade under `/upgrade`
- the task is first-time bootstrap or template install
- the task is runtime troubleshooting after publish/rollback is already complete
- the task is component image rollback or build-history rollback

## Route Reality

Important:
- `/publish` now redirects to `/version`
- snapshot creation and publish both start from `/version`
- `/share/:shareId/one` is the draft configuration step
- `/share/:shareId/two` is the event execution step
- `/share/:shareId/three` is the finish page

So this skill should model the `/version` center, not the old standalone publish page.

## Preferred MCP Tools

### Version Center
- `rainbond_get_app_version_overview`
- `rainbond_list_app_version_snapshots`
- `rainbond_get_app_version_snapshot_detail`
- `rainbond_list_app_version_rollback_records`
- `rainbond_get_app_version_rollback_record_detail`

### Snapshot Actions
- `rainbond_create_app_version_snapshot`
- `rainbond_delete_app_version_snapshot`
- `rainbond_rollback_app_version_snapshot`
- `rainbond_delete_app_version_rollback_record`
- `rainbond_create_app_from_snapshot_version`

### Publish Draft and Events
- `rainbond_get_app_publish_candidates`
- `rainbond_create_app_share_record`
- `rainbond_list_app_share_records`
- `rainbond_get_app_share_record`
- `rainbond_delete_app_share_record`
- `rainbond_get_app_share_info`
- `rainbond_submit_app_share_info`
- `rainbond_list_app_share_events`
- `rainbond_start_app_share_event`
- `rainbond_get_app_share_event`
- `rainbond_complete_app_share`
- `rainbond_giveup_app_share`

## Input Resolution

Resolve in this order:
1. user explicit input
2. `.rainbond/local.json`
3. `rainbond.app.json`

Required context:
- `team_name`
- `region_name`
- `app_id`

Common optional context:
- `version_id`
- `record_id`
- `share_id`
- publish `scope`
- `market_name`

## Workflow

Follow this order.

### 1. Inspect version center first
- call `rainbond_get_app_version_overview`
- call `rainbond_list_app_version_snapshots`
- if the user is asking about rollback history, also call `rainbond_list_app_version_rollback_records`

Use this to answer:
- whether a hidden snapshot template exists
- what the current baseline version is
- whether there are unsaved runtime changes
- how many snapshots exist
- whether rollback history already exists

### 2. Creating a snapshot

There are two safe paths.

#### Path A: direct snapshot creation
Use `rainbond_create_app_version_snapshot` when:
- the user already knows version, alias, and note
- there is no need to mimic the draft page step-by-step
- you already know the exact share payload or can omit it safely

#### Path B: UI-parity draft path
Use this when the user wants parity with `/share/:shareId/one?mode=snapshot`:
1. `rainbond_create_app_share_record` with `snapshot_mode=true`
2. `rainbond_get_app_share_info`
3. adjust payload as needed
4. `rainbond_create_app_version_snapshot`
5. `rainbond_giveup_app_share`

Important:
- the draft share record is only a temporary container for the snapshot step-one page
- snapshot creation is not finished until `rainbond_create_app_version_snapshot` succeeds
- after success, give up the temporary draft record

### 2.1 Creating a new app directly from a snapshot

Snapshot creation already produces a hidden local template.

That means you do **not** need to publish the snapshot to the local library first when the real goal is:
- pick one snapshot
- create a brand-new app in the same team
- install that snapshot template immediately

Prefer this direct path:
1. `rainbond_get_app_version_overview`
2. `rainbond_list_app_version_snapshots`
3. `rainbond_get_app_version_snapshot_detail`
4. `rainbond_create_app_from_snapshot_version`

Use `rainbond_create_app_from_snapshot_version` when:
- the source app and target app stay in the same team
- publish visibility is not required
- the user wants a new app from a chosen snapshot, not a library artifact

Inputs:
- `source_app_id`
- `version_id`
- `target_app_name`
- optional `target_app_note`
- optional `k8s_app`
- optional `is_deploy`

Do not route this through the publish flow unless the user explicitly wants:
- a visible local library publish record
- a cloud market publish
- the share draft and event steps themselves

### 3. Publishing a snapshot

The publish flow should mirror `/version -> /share/:shareId/one -> /two`.

1. choose target publish scope
   - local library: use `scope=local`
   - cloud market: use `scope=goodrain`

2. fetch candidate app models
   - call `rainbond_get_app_publish_candidates`
   - for cloud publish, include `market_name`

3. create draft share record
   - call `rainbond_create_app_share_record`
   - for local publish, keep `scope=""`
   - for cloud publish, use `scope="goodrain"` and `target.store_id`
   - pass `snapshot_app_id` and `snapshot_version`

4. inspect draft content
   - call `rainbond_get_app_share_info`
   - if `publish_mode=snapshot`, the content is already frozen from the selected snapshot
   - if `publish_mode=runtime`, you are looking at live component data

5. submit draft metadata
   - call `rainbond_submit_app_share_info`
   - `app_version_info` is required
   - include `share_service_list`, `share_plugin_list`, `share_k8s_resources` when needed

6. execute publish events
   - call `rainbond_list_app_share_events`
   - for each event:
     - `rainbond_start_app_share_event`
     - `rainbond_get_app_share_event`
   - component media sync uses `event_type=service`
   - plugin sync uses `event_type=plugin`

7. finish publish
   - when all events are successful, call `rainbond_complete_app_share`

### 4. Continuing or abandoning publish

If the user wants to continue an unfinished publish:
- call `rainbond_list_app_share_records`
- locate the record with `status=0`
- inspect it with `rainbond_get_app_share_record`
- continue with `rainbond_get_app_share_info`

If the user wants to abandon a draft:
- call `rainbond_giveup_app_share`

If the user wants to delete a finished publish record from the drawer:
- call `rainbond_delete_app_share_record`

## Rollback Rules

Snapshot rollback is the `/version` route rollback, not upgrade-record rollback.

Use:
1. `rainbond_get_app_version_snapshot_detail`
2. `rainbond_rollback_app_version_snapshot`
3. `rainbond_list_app_version_rollback_records`
4. `rainbond_get_app_version_rollback_record_detail`

Behavior:
- rollback creates a rollback record
- the rollback record should be polled until terminal
- finished rollback records may be deleted with `rainbond_delete_app_version_rollback_record`

Do not confuse this with:
- `rainbond_rollback_app_upgrade_record`

That one belongs to the `/upgrade` market-app upgrade flow.

## Decision Rules

### Snapshot creation
- if overview says there are no new changes and a current baseline already exists, do not force-create another snapshot
- if no baseline snapshot exists yet, creating the first snapshot is valid even without a previous version

### Publish scope
- use `local` candidate discovery for local library publishing
- use `goodrain` candidate discovery only when the user explicitly wants cloud market publishing

### Event execution
- never call `rainbond_complete_app_share` before all events are successful
- if any event remains non-success, keep the workflow in “event execution” state

### Rollback
- before rollback, inspect the target snapshot detail
- after rollback starts, shift focus to rollback record tracking rather than snapshot list refresh alone

### Direct snapshot reuse
- if the user wants a new app from a snapshot and does not need a published library record, prefer `rainbond_create_app_from_snapshot_version`
- do not create a publish draft just to obtain a reusable template from a snapshot

## Output Format

Target structured output:

- this skill should eventually be able to emit `VersionCenterSession`
- minimum target fields:
  - `flow_type`
  - `release`
  - `snapshot`
  - `rollback`
  - `state_snapshot`
  - `action_plan`
  - `next_step`
- the human-readable sections below should be treated as the narrative view over that target object
- once implemented, append a final `### Structured Output` section after the human-readable report and render `VersionCenterSession` in fenced `yaml`

Proposed schema:

```yaml
VersionCenterSession:
  flow_type: snapshot | publish | rollback
  context:
    team_name: string
    region_name: string
    app_id: string
  state_snapshot:
    baseline_version: string | null
    unsaved_runtime_changes: boolean
    unfinished_records: string[]
  release: map | null
  snapshot: map | null
  rollback: map | null
  action_plan: string[]
  next_step: stop | create_snapshot | create_new_app_from_snapshot | submit_publish_draft | run_publish_events | complete_publish | track_rollback_record | give_up_draft
```

Example object:

```yaml
VersionCenterSession:
  flow_type: publish
  context:
    team_name: rainbond-demo
    region_name: singapore
    app_id: app-4fd2
  state_snapshot:
    baseline_version: v12
    unsaved_runtime_changes: false
    unfinished_records:
      - share-102
  release:
    share_record_id: share-102
    status: draft
  snapshot:
    version_id: version-12
  rollback: null
  action_plan:
    - rainbond_get_app_version_overview
    - rainbond_create_app_share_record
    - rainbond_submit_app_share
  next_step: submit_publish_draft
```

Example final reply:

````markdown
### Context
Resolved `team_name` rainbond-demo, `region_name` singapore, `app_id` app-4fd2, flow type `publish`.

### Current State
Current baseline version is `v12`, unsaved runtime changes do not exist, and there is one unfinished publish record: `share-102`.

### Action Plan
Next MCP tools: `rainbond_get_app_version_overview`, `rainbond_create_app_share_record`, `rainbond_submit_app_share`. The flow is draft-based.

### Result
Prepared the publish session, reused snapshot `version-12`, and confirmed the draft share record `share-102` remains the active publish target.

### Next Step
submit publish draft

### Structured Output
```yaml
VersionCenterSession:
  flow_type: publish
  context:
    team_name: rainbond-demo
    region_name: singapore
    app_id: app-4fd2
  state_snapshot:
    baseline_version: v12
    unsaved_runtime_changes: false
    unfinished_records:
      - share-102
  release:
    share_record_id: share-102
    status: draft
  snapshot:
    version_id: version-12
  rollback: null
  action_plan:
    - rainbond_get_app_version_overview
    - rainbond_create_app_share_record
    - rainbond_submit_app_share
  next_step: submit_publish_draft
```
````

Always respond using exactly these sections:

### Context
- resolved `team_name`
- resolved `region_name`
- resolved `app_id`
- whether the task is snapshot, publish, or rollback

### Current State
- overview summary
- current baseline version
- whether unsaved runtime changes exist
- whether there is an unfinished publish or rollback record

### Action Plan
- exact MCP tools to call next
- whether the flow is direct or draft-based

### Result
- what changed
- created snapshot / created share record / started event / completed publish / started rollback

### Next Step
- one of:
  - `stop, version center is up to date`
  - `create snapshot`
  - `create new app from snapshot`
  - `submit publish draft`
  - `run publish events`
  - `complete publish`
  - `track rollback record`
  - `give up draft`

### Structured Output
- append a fenced `yaml` block
- render `VersionCenterSession`
- keep enum values and field names aligned with the schema above
- include only operation state the skill can actually observe in the current run

## Common Mistakes

- using `/upgrade` tools when the user is actually in `/version`
- treating `/publish` as a separate workflow even though it redirects to `/version`
- forgetting that snapshot creation via UI uses a temporary share draft
- routing snapshot reuse through publish when direct hidden-template install is enough
- calling `complete publish` before events finish
- mixing snapshot rollback with market-app upgrade rollback
