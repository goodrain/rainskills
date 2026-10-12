# Environment sync workflow

## Workflow

Follow this order.

### Fixed Tool fast path and conflict gate

Read `rainbond_query_components`, `rainbond_manage_component_envs(operation=summary)`, and `rainbond_manage_component_connection_envs(operation=summary)` for the requested components. Before any write, call `rainbond_analyze_env_conflicts`. Conflict gate has higher priority than drift reconciliation. If any conflict is reported, must not write any file, including status, timestamps, or sync metadata; stop and show only non-sensitive key names. Drift reconciliation runs only when there are no conflicts. Do not overwrite automatically and do not run `list` or `describe` to discover known Tools.

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
- identify components from MCP data first
- use local files only as hints for naming and roles

4. Gather env candidates
For each relevant component:
- inspect current envs and connection envs from Rainbond MCP
- compare with project baseline in `rainbond.app.json`
- identify values that represent meaningful non-sensitive overrides
- classify provider connection envs and dependency-injected connection values as runtime connection metadata before delta evaluation
- classify `DB_NAME` by source and ownership using the three explicit branches above; unknown provenance is `ambiguous`, not a writable delta

5. Filter values
- keep only values that satisfy the Keep rules
- remove platform runtime metadata
- remove provider connection envs and dependency-injected connection values even when they differ from baseline
- skip all sensitive values
- skip values that are identical to the baseline manifest
- if unsure, prefer skipping and explain why

6. Write target file
- execute this step only when conflict analysis returned no conflicts
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

If Rainbond runtime differs from local files and conflict analysis returned no conflicts:
- trust MCP
- update the env file based on MCP-derived, filtered values
- explicitly report the drift in output

Drift reconciliation is only allowed when there are no conflicts. A conflict stops the run without changing env content, `synced_at`, `metadata.status`, or `metadata.synced_by`.

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
