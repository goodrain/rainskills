# Troubleshooter diagnosis context

Load this reference only after the Runtime Gate and app identity are resolved.

## Shared Runtime Vocabulary

When describing observed runtime state, use the canonical terms from the product object model:

- `RuntimeState`: `topology_missing`, `topology_building`, `runtime_unhealthy`, `runtime_healthy`, `capacity_blocked`, `code_or_build_handoff_needed`
- component convergence: `building`, `waiting`, `running`, `abnormal`, `capacity-blocked`
- dependency readiness: `resolved`, `deferred`
- blocker buckets and structured enum spellings come from the generated contract; root-cause sections below explain behavior without redefining the enum

Keep the canonical `RuntimeState` explicit in both prose and structured output. Do not collapse it into ad hoc labels such as "mostly healthy" or "repair complete."

## Console failure classification mapping

Use `rainbond_get_operation_failure_context` after a write failure or when a component becomes abnormal immediately afterwards. Map `classified_reason` once before choosing a repair; `unknown` uses the existing evidence chain and never authorizes a replay. Treat `event_log_tail` as sensitive evidence: never copy, quote, or display its raw 原文.

| Console classified_reason | Troubleshoot blocker_bucket | stop_reason |
| --- | --- | --- |
| `config_file_configmap_missing` | `config_file_configmap_missing` | `api_startup_issue` |
| `volume_mount_failed` | resolve from affected component role and storage evidence | existing evidence chain |
| `image_pull_failed` | `external artifact unreachable` | `external_artifact_unreachable` |
| `crash_loop` | resolve from affected component role and runtime evidence | existing evidence chain |
| `probe_failed` | resolve from affected component role and probe evidence | existing evidence chain |
| `unschedulable` | `cluster capacity blocked` | `cluster_capacity_blocked` |
| `k8s_api_rejected` | `platform backend issue` | `platform_backend_issue` |
| `unknown` | existing evidence chain | existing evidence chain |

For normal runtime inspection, call `rainbond_get_app_health_overview` first. Only abnormal or unknown components need component summaries, events, logs, or storage detail.

## When to Use

Use when:
 - `rainbond-fullstack-bootstrap` or `rainbond-app-assistant` has handed off a linked app in `topology_building` or `runtime_unhealthy`
 - a full-stack app already has Rainbond topology, but runtime convergence is still pending
 - the likely blocker is dependency wiring, env compatibility, wrong connection values, source build convergence, api startup behavior, or frontend runtime access path
 - the workflow needs a bounded answer before delivery verification: continue low-risk Rainbond repair, wait for build convergence, stop for platform capacity, or hand off to code/build work

Do not use when:
 - the user gives a generic current-project deployment or mainline request and the next phase is not yet explicit; route that to `rainbond-app-assistant`
 - required topology has not been created yet
 - the task is final delivery acceptance or access URL confirmation
 - the task requires source-code changes, build script changes, reverse-proxy edits, or destructive cleanup
- the database must be reset or modified directly
- the issue is clearly unrelated to Rainbond runtime state
- the user wants to restart or modify Rainbond platform system components (`rbd-*` such as `rbd-gateway`, `rbd-api`, `rbd-worker`, `rbd-chaos`, `rbd-db`, `rbd-mq`, `rbd-monitor`, `rbd-node`); these are platform infrastructure, not user app components — MCP write operations are not supported on them; direct the user to `kubectl rollout restart` or the Rainbond cluster management console instead

## Configuration Priority

Use file sources to resolve context, but never treat them as live runtime truth.

Shared file layers:
1. **Highest priority**: user explicit input for the current troubleshooting run
2. **Secret reference layer**: `.rainbond/secrets.preview.json` or `.rainbond/secrets.prod.json`
3. **Environment reference layer**: `.rainbond/env.preview.json` or `.rainbond/env.prod.json`
4. **Project binding context**: `.rainbond/local.json`
5. **Lowest priority**: `rainbond.app.json` as the project topology baseline

Backward compatibility:
- If `rainbond.app.json` is absent, legacy `rainbond.json` may be read as the same lowest-priority baseline tier
- Legacy `rainbond.json` never overrides user input, secret files, environment reference files, or local binding context

Operational rules:
- Resolve `app_id`, `team_name`, and `region_name` from user explicit input first, then `.rainbond/local.json`
- Resolve selected environment in this order: user explicit input > `.rainbond/local.json.preferences.default_environment` > `preview`
- Use `.rainbond/secrets.<environment>.json` and `.rainbond/env.<environment>.json` only as reference input for intended values or compatibility expectations; they are not proof of current deployed env
- Use `rainbond.app.json` only as a baseline hint for topology, naming, ports, and non-sensitive defaults
- Real state must come from Rainbond MCP queries: app detail, component summaries, pod runtime diagnostics, deployed envs, dependencies, ports, events, and logs
- If persisted files conflict with Rainbond MCP results, trust MCP and report the mismatch explicitly
- Never print secret values in prose or structured output

## Runtime Configuration Source Precedence

This is about which source the *running process* actually reads, not which local file resolves context.

- Effective runtime config resolves as: mounted config-file volume (`config.yml` / `application.yml` / `application.properties` / `.env` / `nginx.conf` / `*.conf` at a config path) > runtime environment variables > image baked-in defaults.
- A correct env change does NOT take effect if a mounted config file overrides the same key. Fix the override source, not just env.

## Scope

Typical components:
- `web`: frontend
- `api`: backend
- `postgres` or equivalent: database

Primary positive-mainline entry states:
- `topology_building`
- `runtime_unhealthy`

Other legal observed outcomes during troubleshooting:
- `runtime_healthy`
- `capacity_blocked`
- `code_or_build_handoff_needed`
- `topology_missing`, but only when current evidence proves bootstrap never established required topology; treat this as an out-of-mainline regression and report it explicitly rather than pretending troubleshooting converged

Configuration source roles:
- `.rainbond/local.json`: preferred binding context for `app_id`, `team_name`, `region_name`, and default environment
- `.rainbond/secrets.preview.json` / `.rainbond/secrets.prod.json`: reference-only expected secret inputs, never runtime truth
- `.rainbond/env.preview.json` / `.rainbond/env.prod.json`: reference-only expected env overrides, not runtime truth
- `rainbond.app.json`: baseline topology hints such as component names, roles, ports, and non-sensitive default envs
- Rainbond MCP: the only valid source for live component state, pod runtime diagnostics, deployed envs, dependencies, logs, and health

Allowed actions:
- read app detail, component summary, component detail, component pods, pod detail, logs, and monitor data
- read component events and build logs for source-backed components
- modify provider component connection envs with `rainbond_manage_component_connection_envs`
- modify consumer runtime envs only as a fallback compatibility repair after provider connection envs and dependency wiring are confirmed
- modify source build envs through `rainbond_manage_component_envs(operation=replace_build_envs, build_env_dict=...)` when build evidence clearly points to a low-risk parameter fix
- add dependencies such as `api -> db`, `api -> redis`, or service -> middleware with `rainbond_manage_component_dependency`
- open provider inner ports when explicitly required to satisfy a confirmed dependency edge, including by retrying dependency creation with `open_inner=true` and the provider `container_port`
- restart or deploy the `api` component

Known limitation — one-shot tasks: Rainbond components are long-running workloads.
Do not create a temporary component just to run a one-shot script: `stateless_multiple`
containers that exit immediately go into restart loops, and database images run their own
entrypoint instead of a custom CMD. For one-off commands prefer `rainbond_exec` into a
running container; for database initialization prefer the image's native init mechanism
(e.g. PostgreSQL `/docker-entrypoint-initdb.d`).

Disallowed actions:
- delete app
- delete components
- clear database data
- modify source code
- make large speculative changes across multiple components
- loop through repeated repairs after the dominant blocker is already classified as platform or code/build

## Pod-Level Runtime Diagnosis

Use Pod-level diagnostics when:
- a component status is not `running`
- the user mentions Pod startup failure, image pull failure, `CrashLoopBackOff`, init container issues, or probe/startup problems
- component logs do not yet explain the blocker

Runtime diagnosis order for these cases:
1. `rainbond_get_component_summary`
2. `rainbond_get_component_pods`
3. choose a target Pod, preferring:
   - `group == new_pods`
   - a Pod whose `pod_status` is not `RUNNING`
   - the first returned item as fallback
4. `rainbond_get_pod_detail`
5. extract the root cause in this order:
   - `status.reason`
   - `status.message`
   - `events` entries containing `Warning`, `Failed`, or `BackOff`
   - `init_containers[*].reason`
   - `containers[*].reason`
6. only then read `rainbond_get_component_logs(action=container, pod_name, container_name)` when more context is still needed

Tool semantics:
- call Pod tools with `team_name`, `region_name`, `app_id`, and `service_id`; do not switch back to console `serviceAlias` routing assumptions
- do not treat `rainbond_get_component_summary` as the Pod-level root-cause source; it can show that a component is unhealthy, but not always why
- `rainbond_get_pod_detail` returns the Pod diagnostic object directly, not a `data.bean` wrapper
- `rainbond_get_pod_detail` already handles `kubeblocks_component` internally; do not add a separate skill-side branch for that case
- do not invent a separate Pod-log tool; container logs still come from `rainbond_get_component_logs(action=container, ...)`

## Operation Anchoring (HARD RULE)

When this skill triggers an action (build, deploy, upgrade, start, stop, check), the action returns an `event_id`. That `event_id` is the only safe anchor for "did **my** action finish, and how." Treat the `event_id` as required state for the rest of the run.

Capture-on-trigger:
- `rainbond_build_component` → store as `build_event_id`
- `rainbond_operate_app` (deploy / upgrade / start / stop) → store as `operation_event_id`
- `rainbond_check_component` → store as `check_event_id` and pair with the returned `check_uuid`
- if a triggering call's response does not contain a recognizable event id field, record `trigger_at` (timestamp) instead and downgrade to the pod-based observation path below

Polling signal priority (use in order, do not skip):
- **P1 — anchored build log** (default for build / deploy / upgrade)
  - call `rainbond_get_component_build_logs(event_id=<my_event_id>)` and look for terminal markers (`BUILD SUCCESS`, `BUILD FAILED`, exit-code lines, fatal error keywords)
  - this stream is keyed by `event_id` at the platform level; concurrent operations on the same component cannot pollute it
  - for large projects (Maven monorepo, multi-stage Node.js, etc.), **prefer narrowing the response** with `tail=500` (last N entries — errors almost always live at the tail) or `grep="ERROR"` / `grep="BUILD FAILURE"` / `grep="Caused by"` (substring filter on message field). `offset` + `limit` also supported. Without these the upstream LLM truncates the middle and the actual error vanishes; if you ever see `_truncated: true` or `_dropped_items_count > 0` in the response, **the very next call must add tail/grep** — never refetch with the same arguments
- **P2 — pod truth** (default for start / stop / runtime convergence, also fallback for P1)
  - `rainbond_get_component_pods` then `rainbond_get_pod_detail`
  - judge by `pod_status`, `containers[*].state`, `restart_count`, and pod-level events
  - pods reflect Kubernetes reality and are not contaminated by user-level operation events
- **P3 — filtered event stream** (only when P1/P2 are insufficient)
  - `rainbond_get_component_events` and **client-side filter** by:
    - event id ≥ `my_event_id`, AND
    - event type matches the operation class (build / deploy / upgrade / start / stop)
  - never use "the latest event in the page" as the signal; the page is shared across all operation types

Forbidden polling patterns:
- repeatedly calling `rainbond_get_component_summary` inside a polling loop to read `recent_events` or `status` as the primary signal
- repeatedly calling `rainbond_query_components` (same `app_id` + same `query`/`service_id`) to re-check whether a component has converged after a restart, deploy, or `rainbond_operate_app` — it returns a component-list snapshot, not an action-anchored signal, and identical-arg re-reads are served from a short server-side cache, so the `status` field looks unchanged and feeds an endless re-poll; verify convergence through P2 (pods anchored to the operation) instead
- judging "my action finished" from `summary.status` string changes — `status` is an aggregate field that other concurrent operations also mutate
- treating "the most recent event" or "the first event in the events page" as the signal for the action this run triggered, when no `event_id` was captured at trigger time
- assuming an event without `event_id` correlation belongs to the action this run just triggered, just because it is recent

Allowed `summary` usage:
- one baseline snapshot when entering troubleshooting (topology, envs, ports, resources, autoscaler)
- one confirmation read after a configuration mutation (envs, dependencies, ports) to verify the change applied
- never as a polling-loop signal source

Concurrency note:
- if the user is interacting with the same component through the UI or another client during this run, P2 (pods) is the most robust signal — it reflects platform-side actuation, not the operation event mix
- if `event_id` returned from a trigger is empty, do not silently proceed as if anchoring is in place; switch to P2 with the recorded `trigger_at` and report this gap in `actions_performed[].details`

### Write-result confirmation under async inconsistency

Mutating MCP calls (storage update, env change, restart, upgrade) can return a 5xx error
while the platform still applies the change asynchronously.

- a 5xx response to a write is **not** proof of failure: query the related component events
  or re-read the resource once before concluding
- if the event stream reports success but the pod is still failing, trust the pod-level
  runtime evidence, not the event
- per blocker, perform at most one repair retry when the control plane looks inconsistent;
  repeated writes against an inconsistent control plane make state strictly worse
