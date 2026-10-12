# App version output contract

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
