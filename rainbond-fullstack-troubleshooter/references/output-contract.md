# Troubleshooter verification and output contract

## Contents

- Verification standard
- TroubleshootResult fields
- Cross-field rules
- Human-readable sections
- Examples

## Verification Standard

`runtime_healthy` is a runtime conclusion, not a delivery conclusion.

A repair is only successful enough to hand off when:
- db is running and ready
- api is running and logs no longer show the dominant runtime blocker
- required dependency and ports are correctly configured
- no active source-build failure or capacity blocker still dominates the result
- the remaining question is delivery acceptance or user-facing URL validation, not further runtime repair

Do not declare repair success when:
- source-backed components are still building
- source-backed components have known compile or build failures
- required dependency edges are only pending because target components have not converged yet
- components are blocked by cluster scheduling or capacity constraints
- the dominant blocker has shifted to frontend access-path or build-layer work
- the same blocker bucket has already persisted after one repair-and-verify cycle in the current run

If the system is already `runtime_healthy`, stop and say so. Do not continue making changes.

## Output Format

Structured output contract:

- this skill must emit `TroubleshootResult`
- keep the human-readable sections below exactly as the narrative surface contract
- append one final `### Structured Output` section and render `TroubleshootResult` in fenced `yaml`
- do not place any prose after the final structured block

Canonical required top-level fields:
- `runtime_state`
- `blocker_bucket`
- `actions_taken`
- `verification_summary`
- `next_handoff`

Canonical required subfields:
- `runtime_state.label`
- `verification_summary.db_status`
- `verification_summary.api_status`
- `verification_summary.frontend_access_status`
- `verification_summary.evidence_chain`
- `verification_summary.dominant_evidence`
- `verification_summary.stop_reason`
- `verification_summary.recommended_next_action`
- `verification_summary.stop_boundary`

Optional extensions allowed inside the canonical object:
- `runtime_state.component_status`
- `runtime_state.dependency_readiness`
- `runtime_state.blocker_summary`
- `verification_summary.key_error_cleared`
- `verification_summary.app_endpoint_operational`

Do not add new top-level fields beyond the canonical contract unless the [product object model](../../rainbond-app-assistant/references/product-object-model.md) is updated first.

Live schema summary:

```yaml
TroubleshootResult:
  runtime_state:
    label: topology_missing | topology_building | runtime_unhealthy | runtime_healthy | capacity_blocked | code_or_build_handoff_needed
    component_status:
      api: building | waiting | running | abnormal | capacity-blocked | null
      db: building | waiting | running | abnormal | capacity-blocked | null
    dependency_readiness:
      db_dependency: resolved | deferred | deferred_by_upstream_convergence
    blocker_summary: string | null
  blocker_bucket: db not ready | dependency missing | env naming incompatibility | wrong connection values | api startup issue | frontend access-path issue | source build still running | source build failed | platform backend issue | external artifact unreachable | cluster capacity blocked | config_file_configmap_missing | null
  actions_taken:
    - string
  verification_summary:
    db_status: running | waiting | abnormal | capacity-blocked | null
    api_status: running | waiting | abnormal | capacity-blocked | null
    frontend_access_status: working | not_working | needs_validation | null
    key_error_cleared: boolean | null
    app_endpoint_operational: boolean | null
    evidence_chain:
      - app_detail | component_summary | component_events | build_logs | pod_list | pod_detail | runtime_logs | dependency_summary | connection_envs | runtime_envs | port_rules | frontend_access_check | scheduler_events | app_monitor
    dominant_evidence: string | null
    stop_reason: topology_missing | source_build_still_running | source_build_failed | external_artifact_unreachable | db_not_ready | dependency_missing | env_naming_incompatibility | wrong_connection_values | api_startup_issue | frontend_access_path_issue | cluster_capacity_blocked | code_or_build_handoff_needed | runtime_healthy_ready_for_delivery_verifier | null
    recommended_next_action: string | null
    stop_boundary:
      stopped: boolean
      delivery_verifier_allowed: boolean
      code_changes_allowed: false
      local_tests_allowed: false
      commit_or_push_allowed: false
      fallback_used: false
  next_handoff: none | delivery_verifier | code_build_handoff
```

Consistency rules:
- every non-null `blocker_bucket` must include a canonical bucket, `dominant_evidence`, `stop_reason`, and `recommended_next_action`
- `source build failed` must use the evidence order `component_events -> build_logs` before any runtime-log reasoning
- `external artifact unreachable` must use event or pod evidence before runtime logs; use build logs for build-time downloads and pod detail/events for image-pull or registry-layer failures
- `cluster capacity blocked` must stop with `next_handoff = none` and `delivery_verifier_allowed = false`
- `code_or_build_handoff_needed` must stop with `next_handoff = code_build_handoff` and must not allow code edits, local tests, commit, or push
- `fallback_used` must be `false`; do not silently switch to package, image, or template paths
- `Verification Result` overall status in prose must match `runtime_state.label`
- if `runtime_state.label = runtime_healthy`, `next_handoff` may be `delivery_verifier` or `none`, but should normally be `delivery_verifier`
- if `runtime_state.label = code_or_build_handoff_needed`, `next_handoff` must be `code_build_handoff`
- if `runtime_state.label = capacity_blocked`, `next_handoff` must be `none`
- if `blocker_bucket = cluster capacity blocked`, `runtime_state.label` must be `capacity_blocked`
- if `blocker_bucket = source build failed`, `external artifact unreachable`, or `frontend access-path issue`, `runtime_state.label` must be `code_or_build_handoff_needed`
- if `runtime_state.label = topology_building`, do not claim key runtime errors are cleared unless fresh evidence proves it
- `actions_taken` must contain only actions actually taken in the current run; if no mutation happened, say so explicitly
- when a layer does not exist in the current topology, prose may say `not applicable` and the structured field should be `null`
- no secret values may appear in prose or structured output

Example object:

```yaml
TroubleshootResult:
  runtime_state:
    label: runtime_healthy
    component_status:
      api: running
      db: running
    dependency_readiness:
      db_dependency: resolved
    blocker_summary: null
  blocker_bucket: env naming incompatibility
  actions_taken:
    - Updated provider connection envs on `db` so dependents receive the expected DB_* contract.
    - Added the missing `api -> db` dependency with dependency management.
    - Redeployed `api` after dependency wiring.
  verification_summary:
    db_status: running
    api_status: running
    frontend_access_status: needs_validation
    key_error_cleared: true
    app_endpoint_operational: null
    evidence_chain:
      - component_summary
      - connection_envs
      - runtime_logs
    dominant_evidence: "api logs expected DB_* names while provider connection envs were missing from the dependency contract."
    stop_reason: runtime_healthy_ready_for_delivery_verifier
    recommended_next_action: "Run delivery-verifier to confirm final access behavior."
    stop_boundary:
      stopped: true
      delivery_verifier_allowed: true
      code_changes_allowed: false
      local_tests_allowed: false
      commit_or_push_allowed: false
      fallback_used: false
  next_handoff: delivery_verifier
```

Example final reply:

````markdown
### Problem Judgment
Root cause is `env naming incompatibility` based on logs and component configuration. Affected layers: `api`, `overall`.

### Actions Taken
- updated provider connection envs on `db` so dependents receive the expected DB_* contract
- added the missing `api -> db` dependency with dependency management
- redeployed `api` after dependency wiring

### Verification Result
- **db status**: `running`
- **api status**: `running`
- **frontend-access status**: `needs validation`
- **overall status**: `runtime_healthy`
- key error disappeared from logs: `yes`
- app can serve user-facing requests: `not yet verified from this run`

### Follow-up Advice
Short-term: hand off to `rainbond-delivery-verifier` to confirm final access outcome. Long-term: keep connection variables on the provider component so every dependent service receives the same contract. handoff needed: yes.

### Structured Output
```yaml
TroubleshootResult:
  runtime_state:
    label: runtime_healthy
    component_status:
      api: running
      db: running
    dependency_readiness:
      db_dependency: resolved
    blocker_summary: null
  blocker_bucket: env naming incompatibility
  actions_taken:
    - Updated provider connection envs on `db` so dependents receive the expected DB_* contract.
    - Added the missing `api -> db` dependency with dependency management.
    - Redeployed `api` after dependency wiring.
  verification_summary:
    db_status: running
    api_status: running
    frontend_access_status: needs_validation
    key_error_cleared: true
    app_endpoint_operational: null
    evidence_chain:
      - component_summary
      - connection_envs
      - runtime_logs
    dominant_evidence: "api logs expected DB_* names while provider connection envs were missing from the dependency contract."
    stop_reason: runtime_healthy_ready_for_delivery_verifier
    recommended_next_action: "Run delivery-verifier to confirm final access behavior."
    stop_boundary:
      stopped: true
      delivery_verifier_allowed: true
      code_changes_allowed: false
      local_tests_allowed: false
      commit_or_push_allowed: false
      fallback_used: false
  next_handoff: delivery_verifier
```
````

Always respond using exactly these sections:

### Problem Judgment
- state the root cause clearly
- if inferred, say "based on logs and component configuration"
- specify which layer(s) are affected: db, api, frontend-access, overall
- if the current result is `topology_building`, `capacity_blocked`, or `code_or_build_handoff_needed`, say that explicitly here

### Actions Taken
- list the exact changes
- include env changes, dependency changes, port changes, and restart or deploy actions
- if no config change was applied, say so explicitly, for example: `- no changes applied; classified current blocker from fresh runtime evidence`

### Verification Result
Explicitly report four statuses:
- **db status**: `running` / `waiting` / `abnormal` / `capacity-blocked` / `not applicable`
- **api status**: `running` / `waiting` / `abnormal` / `capacity-blocked` / `not applicable`
- **frontend-access status**: `working` / `not working` / `needs validation` / `not applicable`
- **overall status**: `topology_missing` / `topology_building` / `runtime_unhealthy` / `runtime_healthy` / `capacity_blocked` / `code_or_build_handoff_needed`

Also:
- state whether the key error disappeared from logs
- state whether the app can serve user-facing requests or whether that still belongs to delivery validation

### Follow-up Advice
- separate short-term and long-term suggestions
- if a compatibility fix was used, recommend fixing variable compatibility in code or template later
- state handoff needed: yes or no
- if the blocker is cluster capacity, explicitly say application-level repair is paused until scheduling is restored
- if `topology_missing` is observed, explicitly say topology creation must be revisited before further troubleshooting

### Structured Output
- append a fenced `yaml` block as the final section
- render `TroubleshootResult`
- keep enum values and field names aligned with the schema above
- use canonical blocker buckets and runtime labels only
