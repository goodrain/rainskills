# Troubleshooter diagnosis workflow

Load this reference for evidence collection, operation anchoring, bounded repair, and fresh verification.

For a build, restart, or redeploy that needs repeated status reads, invoke protected `poll` once. The CLI owns the bounded loop and returns only state transitions, final state, blocker, retryability, attempts, and elapsed time; unchanged states never enter model context.

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
- Query Rainbond MCP for app detail and component list
- If any local file conflicts with MCP runtime facts, trust MCP and report the drift
- Identify `web`, `api`, and db components from MCP data first, then use files only as hints
- Treat bootstrap handoff context as useful input, but let current MCP/runtime truth decide the current state

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
  - do not claim MCP lacks a dependency API; if dependency creation fails, report the concrete MCP/control-plane error
- `env naming incompatibility`
  - prefer fixing provider connection env names and port aliases so every dependent service receives the same contract
  - add consumer compatibility envs only when provider-side repair is unsafe or cannot express the app's expected names
- `wrong connection values`
  - **config-override gate (run BEFORE mutating env)**: enumerate the component's mounted config-file volumes from `rainbond_get_component_summary`. If any mounted volume targets a known config path (`config.yml` / `application.yml` / `application.properties` / `.env` / `nginx.conf` / `*.conf`), treat that file as the authoritative config source per Runtime Configuration Source Precedence. The repair must target that file (or remove the stale override), not just env, because the mounted file wins. Compare values for the override, but report mismatches structurally (e.g. "mounted config.yml overrides env: db host mismatch") and never print the raw secret value.
  - **capability limit**: detection that a config-file volume is mounted at a config path works today via `component_summary`. Content verification (what the file actually contains) needs pod exec or a config-file read API that may not exist yet. If content cannot be read, flag the override risk explicitly and escalate or instruct the user; do not silently edit env and declare success.
  - correct provider connection envs or port aliases first when the wrong values come from provider metadata
  - correct consumer envs only when they are truly consumer-local overrides
- `api startup issue`
  - **config-override gate (run BEFORE mutating env)**: same as `wrong connection values` — if a config-file volume is mounted at a known config path, that file outranks env. Repair the file or remove the stale override; do not assume an env edit fixes a value the mounted file re-supplies. When file content cannot be verified with current MCP capability, flag the override risk and escalate rather than claiming the env fix worked.
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
