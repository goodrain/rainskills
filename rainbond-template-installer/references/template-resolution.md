# Template resolution rules

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
- target `app_id` or enough information to create a target app. At every Rainbond Tool boundary, normalize a decimal session string to a positive integer; reject non-numeric IDs.
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
