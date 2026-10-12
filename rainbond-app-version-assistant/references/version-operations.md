# App version operation rules

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
