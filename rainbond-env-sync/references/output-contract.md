# Environment sync output contract

## Output Format

Target structured output（仅在用户或自动化/评测明确要求结构化结果时使用）：

- this skill should eventually be able to emit an `Environment`-centered sync result
- minimum target fields:
  - `environment`
  - `project`
  - `env_delta`
  - `skip_reasons`
  - `next_action`
- the human-readable sections below should be treated as the narrative view over that target object
- in explicit structured contract mode, append a final `### Structured Output` section after the human-readable report and render the sync result object in fenced `yaml`

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
    synced_by: rainbond-env-sync
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
    "runtime_metadata": ["DB_HOST", "API_PORT"],
    "baseline_match": ["TZ"],
    "ambiguous": []
  },
  "synced_at": "2026-04-14T03:55:00Z",
  "metadata": {
    "status": "synced",
    "synced_by": "rainbond-env-sync"
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
- runtime metadata: `DB_HOST`, `API_PORT`, and provider-injected `DB_NAME`
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
      - API_PORT
    baseline_match:
      - TZ
    ambiguous: []
  synced_at: "2026-04-14T03:55:00Z"
  metadata:
    status: synced
    synced_by: rainbond-env-sync
  next_action: bootstrap
```
````

Only in explicit structured contract mode, respond using exactly these sections:

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
- using local files as runtime truth when MCP says otherwise

## Quick Reference

Priority summary:
1. explicit input
2. `.rainbond/local.json`
3. `rainbond.app.json`
4. runtime truth from MCP only

Keep:
- durable, non-sensitive, app-meaningful deltas relative to baseline

Skip:
- secrets
- certs
- keys
- passwords
- usernames tied to secrets
- platform runtime metadata
- provider connection envs and dependency-injected connection values (`DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASS`, `REDIS_PASSWORD`, `KAFKA_BROKERS`, `PORT*_HOST`, `PORT*_PORT`, `API_HOST`, `API_PORT`)
- `DB_NAME` only when it came from provider `connection_envs` or dependency injection; keep ordinary durable non-sensitive deltas, and classify unknown provenance as ambiguous without writing
- any value identical to `rainbond.app.json`

Typical next actions after sync:
- run `rainbond-fullstack-bootstrap`
- run `rainbond-fullstack-troubleshooter`
- sync production env
- compare preview vs production overrides
