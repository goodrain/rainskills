# App version workflow

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
