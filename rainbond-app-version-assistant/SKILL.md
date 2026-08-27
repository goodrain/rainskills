---
name: rainbond-app-version-assistant
description: "Use when a user explicitly asks for an existing Rainbond app version operation: create or inspect a snapshot, publish to a local library or cloud market, or preview/apply a rollback. Trigger phrases include: 为这个已有应用创建快照 / 发布到本地组件库 / 回滚到快照 / create snapshot."
---

# Rainbond App Version Assistant

## 用户可见结果协议（最高优先级）

普通用户回复默认使用简洁中文，只说明应用、版本操作、实际结果、重要风险和唯一下一步。快照、发布或回滚的内部状态对象仍可用于校验和续接，但不直接展示。

- 成功时说明实际创建、发布或回滚的版本，以及用户接下来能做什么。
- 未完成时说明直接原因；只有确有安全可执行方案时才补充解决办法。
- 默认不得展示内部对象、状态枚举、team/region/app ID、发布记录 ID、Skill/工具名、YAML、JSON 或英文编排标题。
- 只有用户明确要求 YAML、JSON、调试详情，或自动化/评测明确要求结构化契约时，才使用后文的结构化输出格式。

<!-- rainskills-runtime-gate:start -->
## 单运行环境 CLI 门禁（最高优先级）

本机只允许连接一个 Rainbond 运行环境。当前 Skill 在本会话第一次调用 Rainbond 前，执行固定 launcher 的 `runtime status --json`。返回 `connected` 且 `usable=true` 后，所有查询和变更直接通过本地 `~/.rainbond/bin/rainskills-tools.js` 执行。不得配置或直接调用客户端 MCP，不得执行环境枚举或业务 operation 生命周期命令，也不得生成或传递运行环境 ID、业务 operation ID 或 intent JSON。

没有运行环境时，让用户选择 Rainbond Cloud 或一个已有/新建的私有 Rainbond，并执行对应的 `runtime connect`。连接和重新授权必须进入浏览器 Device Flow，不复用 Shell 中缓存的 JWT；新凭据通过 live probe 后才覆盖唯一运行环境。CLI 返回 401 时，只读调用可在 `runtime reconnect` 成功后重试一次；写调用不得自动重放，必须先查询平台真实状态。403 直接停止，不重新授权。

授权命令是同步门禁。执行工具返回“进程仍在运行”或会话 ID 时，必须只等待或轮询同一个命令会话；在该会话结束前，禁止读取专项 Skill、解析 context、调用业务 CLI 或执行任何后续业务步骤。浏览器页面显示成功不代表连接完成；只有原命令退出码为 0，并输出 `rainskills.runtime-connect-result.v1` 且 `state=connected`，才可继续。不得另起 `runtime status` 猜测完成，也不得重复提示用户授权。

`context resolve` 是无状态调用：单一工作空间直接返回上下文，多个候选返回组合选项；用户选择后由当前任务直接携带 team/region 参数，不执行 `context select`，不写本地 operation。所有可变 `call` 仍需先取得 confirmation ID，再以完全相同的输入追加 `--confirm` 执行一次。

`required` 只声明要解析的维度，企业 ID 始终来自当前登录身份。用户明确给出的 team/region 必须放进 `hints` 做精确匹配；不得把企业名、team 名或选择对象作为顶层 `enterprise` / `workspace` 字段传入。多候选时只展示 CLI 返回的 label；用户选择后再次执行同一个无状态 `context resolve`，通过 `selection.option_id` 让 CLI 重新查询并验证当前候选，不写本地 context 状态。

```json
{
  "schema": "rainskills.single-runtime-contract.v1",
  "package_version": "rainskills@0.1.25",
  "runtime_status": [
    "node",
    "<home>/.rainbond/lib/rainskills/bin/rainskills.js",
    "runtime",
    "status",
    "--json"
  ],
  "runtime_connect": {
    "saas": [
      "node",
      "<home>/.rainbond/lib/rainskills/bin/rainskills.js",
      "runtime",
      "connect",
      "<target>",
      "--saas"
    ],
    "private_existing": [
      "node",
      "<home>/.rainbond/lib/rainskills/bin/rainskills.js",
      "runtime",
      "connect",
      "<target>",
      "--rainbond-url",
      "<console-origin>"
    ],
    "install_private": [
      "node",
      "<home>/.rainbond/lib/rainskills/bin/rainskills.js",
      "runtime",
      "connect",
      "<target>",
      "--install-private",
      "--location",
      "<local-or-server>"
    ],
    "reconnect": [
      "node",
      "<home>/.rainbond/lib/rainskills/bin/rainskills.js",
      "runtime",
      "reconnect",
      "<target>"
    ]
  },
  "input_commands": {
    "context_resolve": {
      "argv": [
        "node",
        "<home>/.rainbond/bin/rainskills-tools.js",
        "context",
        "resolve",
        "--input",
        "-",
        "--skill-id",
        "rainbond-app-version-assistant"
      ],
      "stdin": {
        "default": {"required": ["enterprise", "workspace"]},
        "with_hints": {"required": ["enterprise", "workspace"], "hints": {"team_name": "<team-name>"}},
        "with_selection": {"required": ["enterprise", "workspace"], "selection": {"option_id": "<option-id>"}}
      }
    },
    "read": {
      "argv": [
        "node",
        "<home>/.rainbond/bin/rainskills-tools.js",
        "read",
        "<tool>",
        "--input",
        "-",
        "--skill-id",
        "rainbond-app-version-assistant"
      ],
      "stdin_schema_source": "tool-catalog"
    },
    "call": {
      "argv": [
        "node",
        "<home>/.rainbond/bin/rainskills-tools.js",
        "call",
        "<tool>",
        "--input",
        "-",
        "--skill-id",
        "rainbond-app-version-assistant"
      ],
      "stdin_schema_source": "tool-catalog"
    },
    "call_confirm": {
      "argv": [
        "node",
        "<home>/.rainbond/bin/rainskills-tools.js",
        "call",
        "<tool>",
        "--input",
        "-",
        "--skill-id",
        "rainbond-app-version-assistant",
        "--confirm",
        "<confirmation-id>"
      ],
      "stdin_schema_source": "same-confirmed-input"
    }
  }
}
```
<!-- rainskills-runtime-gate:end -->

受限沙箱（包括 Codex）执行本地状态命令时，必须申请用户级受保护目录访问权限；在 Codex 中使用 `require_escalated`。不得修改 `~/.rainbond` 权限、复制受保护状态到工作区，或因沙箱权限错误建议重装。

`runtime connect` 的 Device Flow 不依赖 stdin TTY；Agent 必须执行固定 argv 并保持进程附着直到授权完成。能打开本机浏览器时由连接器自动跳转，SSH、容器等无浏览器场景原样展示授权地址并继续轮询。只有 Rainbond 不支持 Device Flow 且进入旧版 loopback 手动粘贴时才需要交互终端；不得要求用户在聊天中粘贴 JWT。

执行优化：同一会话内只检查一次 Node.js 和运行环境状态；仅在 Node.js、Rainskills、PATH 或唯一运行环境发生变化后失效。固定 launcher 和 argv 已在本 Skill 中，禁止读取、搜索或探测 `rainskills.js`，也禁止执行 `npm root -g`。

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

Target structured output（仅在用户或自动化/评测明确要求结构化结果时使用）：

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
- in explicit structured contract mode, append a final `### Structured Output` section after the human-readable report and render `VersionCenterSession` in fenced `yaml`

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

Only in explicit structured contract mode, respond using exactly these sections:

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
