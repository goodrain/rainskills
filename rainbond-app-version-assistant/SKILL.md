---
name: rainbond-app-version-assistant
description: "Use when a user explicitly asks for an existing Rainbond app version operation: create or inspect a snapshot, publish to a local library or cloud market, or preview/apply a rollback. Trigger phrases include: 为这个已有应用创建快照 / 发布到本地组件库 / 回滚到快照 / create snapshot."
---

# Rainbond App Version Assistant

  <!-- rainskills-runtime-gate:start -->
  ## 运行环境门禁（最高优先级）

  ### 多运行环境操作契约

  Node.js 前置检查通过后，每次请求先执行本地 launcher + `["environment", "list", "--json"]`，按用户明确指定的运行环境选择不可变环境 ID；未指定时只用全局默认环境，默认不可用时停止且不回退。生成 UUID 后执行本地 launcher + `["operation", "begin", "--operation-id", "<uuid>", "--environment-id", "<id>", "--intent-json", "<intent-json>"]`，并在之后每个 Rainbond MCP 调用中加入 `rainskills_operation_id`。环境、团队和应用只属于本次操作，禁止保存项目绑定；同一项目可以部署到多个环境。明确“团队”表示环境内团队；明确“运行环境/平台”表示环境；裸名称同时匹配环境和团队时必须询问。

第一步检查 Node.js 是否存在且主版本不低于 18。Node.js 缺失或低于 18 时，只说明“Rainskills 执行组件需要 Node.js 18 或更高版本”并停止：不选择运行环境，不调用 MCP，不猜测替代命令。只有用户或 agent 明确同意后才安装或升级 Node.js，再从同一原始 intent 继续。

固定 launcher 是 `["npx", "--yes", "rainskills@0.1.0-rc.68"]`；版本必须与本技能包 `package.json` 一致。把 launcher 与参数拼成 argv 数组直接执行，禁止 `rainskills@latest` 或执行 shell 字符串。

本地 launcher 必须从当前 Skill 所在目录的同级目录定位 `rainbond-platform-installer/scripts/local-runtime.js`，解析为绝对路径后使用 `["node", "<绝对路径>"]` 执行。`environment list`、`operation begin`、`operation complete` 和 `runtime message` 只能使用本地 launcher；本地 launcher 只读取已安装文件和本机受保护状态，不得访问 npm 或其它网络。只有用户选定连接运行环境后，才使用上面的固定 npx launcher。

<!-- rainskills-runtime-contract:start -->
```json
{
  "schema": "rainskills.skill-runtime-contract.v1",
  "launcher": ["npx", "--yes", "rainskills@0.1.0-rc.68"],
  "local_launcher": ["node", "<installed-skills-root>/rainbond-platform-installer/scripts/local-runtime.js"],
  "local_argv": {
    "environment-list": ["node", "<installed-skills-root>/rainbond-platform-installer/scripts/local-runtime.js", "environment", "list", "--json"],
    "operation-begin": ["node", "<installed-skills-root>/rainbond-platform-installer/scripts/local-runtime.js", "operation", "begin", "--operation-id", "<uuid>", "--intent-json", "<intent-json>"],
    "operation-complete": ["node", "<installed-skills-root>/rainbond-platform-installer/scripts/local-runtime.js", "operation", "complete", "--operation-id", "<uuid>"],
    "runtime-message": ["node", "<installed-skills-root>/rainbond-platform-installer/scripts/local-runtime.js", "runtime", "message", "--id", "<message-id>"]
  },
  "intents": {
    "snapshot": {"required": ["team_id", "app_id", "operation"], "optional": ["snapshot_id"], "enums": {"operation": ["create", "inspect"]}},
    "publish": {"required": ["team_id", "app_id", "destination"], "optional": ["snapshot_id", "market_id", "version"], "enums": {"destination": ["local-library", "cloud-market"]}},
    "rollback": {"required": ["team_id", "app_id", "snapshot_id", "operation"], "optional": [], "enums": {"operation": ["preview", "apply"]}}
  },
  "routes": {"existing": ["saas", "private-existing"]},
  "connect_argv": {
    "saas": ["npx", "--yes", "rainskills@0.1.0-rc.68", "runtime", "connect", "<target>", "--saas", "--intent-json", "<intent-json>"],
    "private-existing": ["npx", "--yes", "rainskills@0.1.0-rc.68", "runtime", "connect", "<target>", "--rainbond-url", "<rainbond-url>", "--intent-json", "<intent-json>"]
  }
}
```
<!-- rainskills-runtime-contract:end -->

target 只允许 `codex`、`claude`、`all`。校验 intent 后只执行 existing scope 的完整 argv；只消费 schema 为 `rainskills.next-action.v1` 且校验后的 `argv` 数组。

连接完成后用固定 `onboarding-id` 执行 launcher + `["intent", "resume", "--onboarding-id", "<同一 onboarding-id>"]`，恢复原始 intent 和 `resume_step`。401 先执行 launcher + `["runtime", "record-failure", "--onboarding-id", "<同一 onboarding-id>", "--step", "<当前固定步骤>", "--reason", "credential-expired"]`，再仅一次执行 launcher + `["runtime", "reconnect", "--onboarding-id", "<同一 onboarding-id>"]` 后 resume，只重试该步骤；第二次 401 停止。403 执行 launcher + `["runtime", "record-failure", "--onboarding-id", "<同一 onboarding-id>", "--step", "<当前固定步骤>", "--reason", "permission-denied"]` 后停止，不得 reconnect、重新授权或自动重试。
<!-- rainskills-runtime-gate:end -->

<!-- rainskills-runtime-routing:start -->
## 缺少运行环境时

先说：“可以，我会帮你继续版本中心操作。不过目前还没有可用的应用运行环境。你刚安装的 Rainskills 是 AI 部署助手；应用实际运行在 Rainbond 上。Rainbond 是一套应用运行和管理平台，你不需要了解 Kubernetes。”

只让用户选择 `Rainbond Cloud` 或承载目标应用的`已有私有 Rainbond`。选择已有私有 Rainbond 时执行本地 launcher + `["runtime", "message", "--id", "private-console-origin"]` 并原样输出。不得为快照、发布或回滚安装私有 Rainbond，也不得用新平台代替原应用。
<!-- rainskills-runtime-routing:end -->

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

Use [product object model](../rainbond-app-assistant/references/product-object-model.md) as the repository-level source of truth for:

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
- `app_id` (at every Rainbond MCP tool boundary, normalize a decimal session string to a positive integer; reject non-numeric IDs)

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
    app_id: positive integer
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
    app_id: 42
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
    - rainbond_submit_app_share_info
  next_step: submit_publish_draft
```

Example final reply:

````markdown
### Context
App `rainbond-demo`, flow type `publish`.

### Current State
Current baseline version is `v12`, unsaved runtime changes do not exist, and there is one unfinished publish record: `share-102`.

### Action Plan
Next MCP tools: `rainbond_get_app_version_overview`, `rainbond_create_app_share_record`, `rainbond_submit_app_share_info`. The flow is draft-based.

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
    app_id: 42
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
    - rainbond_submit_app_share_info
  next_step: submit_publish_draft
```
````

Always respond using exactly these sections:

### Context
- state `app_name` (from `.rainbond/local.json`) and flow type
- whether the task is snapshot, publish, or rollback
- do not include `team_name`, `region_name`, or `app_id` in prose; those are available in `### Structured Output` only

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
