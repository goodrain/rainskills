---
name: rainbond-fullstack-troubleshooter
description: Use only when the current task is already known to be runtime or build troubleshooting for an existing Rainbond app. Do not use as the first or default response to a generic current-project deployment request; route those to rainbond-app-assistant.
---

# Rainbond Fullstack Troubleshooter

## Rainbond 传输

如果上游已初始化本次工作流的 RainSkills CLI，直接复用，不重新探测。否则在第一次 Rainbond 调用前读取 [../rainbond-app-assistant/references/transport-resolution.md](../rainbond-app-assistant/references/transport-resolution.md) 并初始化一次。CLI 锁定后，认证、网络、超时和业务错误均不得触发替代调用通道。

## Overview

Use this skill after a Rainbond full-stack app has already been linked and bootstrapped, but the runtime has not yet cleanly converged.

Positive-path-first goal:
1. accept the bootstrap handoff with current project context
2. classify the canonical `RuntimeState`
3. apply only the smallest low-risk Rainbond-side repair when the blocker is platform-configurable
4. verify with fresh runtime evidence
5. hand off cleanly to `rainbond-delivery-verifier` once `runtime_healthy` is reached

This skill is not a replacement for bootstrap, delivery verification, or source-code remediation.

## Canonical Model Reference

Use [product object model](../rainbond-app-assistant/references/product-object-model.md) as the repository-level source of truth for:

- `RuntimeState` boundaries and shared runtime evidence terminology
- deferred dependency and source-convergence semantics
- the separation between runtime diagnosis, delivery acceptance, and version operations
- the target `TroubleshootResult` contract and handoff vocabulary

This skill should explain how runtime evidence is interpreted, repaired, and handed off. It should not redefine canonical state boundaries independently.

For this contract convergence pass, the live troubleshooter output contract is frozen by:
- [schemas/troubleshoot-result.schema.yaml](schemas/troubleshoot-result.schema.yaml)
- [scripts/validate_troubleshoot_output.py](scripts/validate_troubleshoot_output.py)
- [scripts/run_troubleshooter_evals.py](scripts/run_troubleshooter_evals.py)
- [evals/](evals/)

The schema and validator keep the existing `TroubleshootResult` top-level fields, and place blocker evidence-chain and stop-boundary details inside `verification_summary`.

## Shared Runtime Vocabulary

When describing observed runtime state, use the canonical terms from the product object model:

- `RuntimeState`: `topology_missing`, `topology_building`, `runtime_unhealthy`, `runtime_healthy`, `capacity_blocked`, `code_or_build_handoff_needed`
- component convergence: `building`, `waiting`, `running`, `abnormal`, `capacity-blocked`
- dependency readiness: `resolved`, `deferred`
- blocker buckets: `db not ready`, `dependency missing`, `env naming incompatibility`, `wrong connection values`, `api startup issue`, `frontend access-path issue`, `source build still running`, `source build failed`, `platform backend issue`, `external artifact unreachable`, `cluster capacity blocked`, `config_file_configmap_missing`

Keep the canonical `RuntimeState` explicit in both prose and structured output. Do not collapse it into ad hoc labels such as "mostly healthy" or "repair complete."

## Console failure classification mapping

Use `rainbond_get_operation_failure_context` after a write failure or when a component becomes abnormal immediately afterwards. Map Console `classified_reason` exactly once before choosing a repair; `unknown` uses the existing evidence chain and never authorizes a replay.

Treat `event_log_tail` as sensitive evidence. Never copy, quote, or display its raw 原文; report only `classified_reason`, non-sensitive summaries, and already-redacted fields.

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

After a build or deploy trigger, use `rainbond_wait_for_build_completion` with an explicit maximum call count. At the bound, read final state once and stop rather than replaying the build.

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
- the user wants to restart or modify Rainbond platform system components (`rbd-*` such as `rbd-gateway`, `rbd-api`, `rbd-worker`, `rbd-chaos`, `rbd-db`, `rbd-mq`, `rbd-monitor`, `rbd-node`); these are platform infrastructure, not user app components — Rainbond Tool write operations are not supported on them; direct the user to `kubectl rollout restart` or the Rainbond cluster management console instead

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
- Real state must come through the locked Rainbond transport: app detail, component summaries, pod runtime diagnostics, deployed envs, dependencies, ports, events, and logs
- If persisted files conflict with platform responses, trust the locked Rainbond transport and report the mismatch explicitly
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
- Locked Rainbond transport: the only valid source for live component state, pod runtime diagnostics, deployed envs, dependencies, logs, and health

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

Mutating Rainbond Tool calls (storage update, env change, restart, upgrade) can return a 5xx error
while the platform still applies the change asynchronously.

- a 5xx response to a write is **not** proof of failure: query the related component events
  or re-read the resource once before concluding
- if the event stream reports success but the pod is still failing, trust the pod-level
  runtime evidence, not the event
- per blocker, perform at most one repair retry when the control plane looks inconsistent;
  repeated writes against an inconsistent control plane make state strictly worse

## Workflow

Follow this order unless there is strong evidence to do otherwise.

Attempt budget:
- the same blocker bucket should not trigger more than 1 repeated repair attempt in a single run
- if the same blocker remains after one repair-and-verify cycle, stop and report the bounded blocker instead of trying a third variation
- if the run spends too long without materially changing runtime evidence, stop and report the current blocker rather than continuing indefinite retries
- read-only status re-reads count toward this budget too: repeating any status check (`rainbond_get_component_summary`, `rainbond_query_components`, `rainbond_get_component_events`) against the same target with the same arguments, with no new anchored evidence (a fresh `event_id`, a pod-state change, a just-granted approval) in between, is "no material change" — after at most 2 such repeats, stop and return a graceful intermediate reply with the last observed state plus "reply 继续 to resume the status check", then end the run

1. Resolve context and handoff
- Collect any user-explicit identifiers, environment choice, or component names first
- Read `.rainbond/local.json` if present and prefer it for `app_id`, `team_name`, `region_name`, and default environment
- Read `.rainbond/secrets.<environment>.json` and `.rainbond/env.<environment>.json` only as reference inputs for expected values
- Read `rainbond.app.json`; if absent, read legacy `rainbond.json` only as a topology hint
- Query the locked Rainbond transport for app detail and component list
- If any local file conflicts with platform runtime facts, trust the platform response and report the drift
- Identify `web`, `api`, and db components from platform data first, then use files only as hints
- Treat bootstrap handoff context as useful input, but let current platform runtime truth decide the current state

2. Read current runtime evidence
- Read `api` component summary first
- Inspect `api` status, envs, connection envs, ports, probes, and recent events
- For source-backed components or explicit build-failure questions:
  - read component events first
  - extract the failed build/deploy `event_id` when one exists
  - read the build log for that `event_id`
  - read runtime container logs only when the build has already succeeded or the evidence has shifted from build failure to runtime startup
- For runtime-unhealthy or startup-blocked components:
  - if the component is not `running`, or the blocker mentions Pod startup, image pull, init container, `CrashLoopBackOff`, or probe issues, read `rainbond_get_component_pods`
  - choose the target Pod by preferring `new_pods`, then a non-`RUNNING` Pod, then the first Pod as fallback
  - read `rainbond_get_pod_detail`
  - classify the dominant runtime blocker from `status.reason`, `status.message`, warning/failure events, `init_containers[*].reason`, then `containers[*].reason`
  - read container logs only if Pod detail still does not explain the blocker or additional app context is needed
- Read recent `api` runtime logs only when runtime behavior is part of the blocker judgment and build or Pod evidence is still insufficient
- Read db component summary
- Confirm whether db is running and ready
- If db is not running or its startup reason is still unclear, use the same `component_pods -> pod_detail -> container logs` order for db
- Read `web` summary only when frontend runtime access path is part of the blocker judgment

3. Classify the current canonical `RuntimeState` before changing anything
- `topology_building`
  - source-backed components are still converging
  - recent events show build or compile is still running
  - dependency wiring is legitimately deferred by upstream convergence
- `runtime_unhealthy`
  - topology exists, but runtime evidence shows abnormal, waiting, probe failure, env mismatch, or broken connectivity
- `runtime_healthy`
  - topology exists and current runtime evidence no longer shows an operational blocker
- `capacity_blocked`
  - active scheduling failure or resource shortage is the dominant blocker
- `code_or_build_handoff_needed`
  - the dominant blocker is source build failure, frontend access-path/build configuration, or another code/build issue outside low-risk Rainbond repair
- `topology_missing`
  - required topology is unexpectedly absent; report it explicitly instead of pretending this skill can replace bootstrap

4. Choose the smallest valid repair path
- `dependency missing`
  - first ensure the provider component exposes the needed port alias and connection envs
  - add the missing dependency with `rainbond_manage_component_dependency`
  - if the tool returns `requires_open_inner`, open the provider inner port or retry with `open_inner=true` and the provider `container_port`
  - do not claim Rainbond Tool lacks a dependency capability; if dependency creation fails, report the concrete Rainbond Tool/control-plane error
- `env naming incompatibility`
  - prefer fixing provider connection env names and port aliases so every dependent service receives the same contract
  - add consumer compatibility envs only when provider-side repair is unsafe or cannot express the app's expected names
- `wrong connection values`
  - **config-override gate (run BEFORE mutating env)**: enumerate the component's mounted config-file volumes from `rainbond_get_component_summary`. If any mounted volume targets a known config path (`config.yml` / `application.yml` / `application.properties` / `.env` / `nginx.conf` / `*.conf`), treat that file as the authoritative config source per Runtime Configuration Source Precedence. The repair must target that file (or remove the stale override), not just env, because the mounted file wins. Compare values for the override, but report mismatches structurally (e.g. "mounted config.yml overrides env: db host mismatch") and never print the raw secret value.
  - **capability limit**: detection that a config-file volume is mounted at a config path works today via `component_summary`. Content verification (what the file actually contains) needs pod exec or a config-file read API that may not exist yet. If content cannot be read, flag the override risk explicitly and escalate or instruct the user; do not silently edit env and declare success.
  - correct provider connection envs or port aliases first when the wrong values come from provider metadata
  - correct consumer envs only when they are truly consumer-local overrides
- `api startup issue`
  - **config-override gate (run BEFORE mutating env)**: same as `wrong connection values` — if a config-file volume is mounted at a known config path, that file outranks env. Repair the file or remove the stale override; do not assume an env edit fixes a value the mounted file re-supplies. When file content cannot be verified with current Rainbond Tool capability, flag the override risk and escalate rather than claiming the env fix worked.
  - report clearly that the issue is not primarily the db path
  - apply only a confirmed platform-side fix; otherwise keep the state as `runtime_unhealthy`
- `source build still running`
  - do not keep patching envs or dependency wiring blindly
  - keep the state as `topology_building`
- `source build failed`
  - if the build failure is caused by unreachable external artifacts, registry layers, package tarballs, GitHub Release assets, or native binary downloads, classify as `external artifact unreachable` rather than generic source-code failure
  - **Source-file-pointing errors (escalate immediately, no env attempt)**: when the build log error explicitly names a file that lives in the user's source repository (`pnpm-lock.yaml` / `package-lock.json` / `yarn.lock` / `package.json` / `Dockerfile` / `go.mod` / `go.sum` / `requirements.txt` / `Pipfile.lock` / `pom.xml` / `build.gradle` etc.), or names an in-repo configuration like `.nvmrc` / `.python-version` / `packageManager` field, the fix has to happen INSIDE that file. Build envs from outside the repo cannot edit file contents. Skip env tweaking; classify `code_or_build_handoff_needed` on the first observation of this error signature.
  - **Build env attempt budget**: if (and only if) the failure looks env-fixable AND the candidate env key exists in `rainbond-fullstack-bootstrap/references/source-build-parameter-guide.md`, **one minimal `replace_build_envs` repair attempt is allowed**. If that one attempt does not change the build error signature on the next build, escalate to `code_or_build_handoff_needed`. Do not iterate through env variations (`CNB_X=v1`, then `BUILD_X=v1`, then `CNB_X=v2`, etc.) — each variation needs its own build + user authorization, and the cumulative cost is worse than escalating.
  - **Fabricated env keys are not "one attempt"** — they are zero attempts because the runtime silently ignores them. If you discover the key you used isn't in the reference doc, do not "try a different env" — escalate.
  - otherwise stop Rainbond-side repair and classify as `code_or_build_handoff_needed`
- `external artifact unreachable`
  - stop Rainbond-side repair after collecting component events and build logs
  - recommend restoring artifact/registry reachability or providing an explicit reachable mirror
  - do not switch to local Docker build, temporary image push, package upload, or image fallback without explicit user confirmation
- `frontend access-path issue`
  - stop Rainbond-side repair and classify as `code_or_build_handoff_needed`
- `cluster capacity blocked`
  - stop application-level repair and classify as `capacity_blocked`

5. Verify after repair or after a bounded no-change judgment
Always re-check:
- `api` summary
- db summary
- recent `api` logs
- app monitor if useful

Then restate:
- canonical `runtime_state.label`
- blocker bucket
- whether the key error disappeared from logs
- whether the remaining question is delivery acceptance rather than runtime repair

6. Apply handoff rules
- if `runtime_state.label = runtime_healthy`, use `next_handoff = delivery_verifier`
- if `runtime_state.label = code_or_build_handoff_needed`, use `next_handoff = code_build_handoff`
- if `runtime_state.label = topology_building`, `runtime_unhealthy`, `capacity_blocked`, or `topology_missing`, use `next_handoff = none`
- if `topology_missing` is encountered, explain in prose that bootstrap or topology creation must be revisited; do not extend the structured enum beyond the canonical `next_handoff` values

Do not claim recovery without fresh status and log evidence.

## On-demand references

After the overview and evidence chain identify the dominant class, load only the matching detail:

- [references/root-cause-rules.md](references/root-cause-rules.md) — root-cause branches A–J and bounded repairs.
- [references/output-contract.md](references/output-contract.md) — verification standard and TroubleshootResult rendering.
- [references/operational-reference.md](references/operational-reference.md) — common mistakes and quick reference.
