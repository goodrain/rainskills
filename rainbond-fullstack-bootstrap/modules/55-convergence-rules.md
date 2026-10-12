# Bootstrap convergence rules

## Build / Deploy Polling Discipline

Builds and deploys are slow and asynchronous. Java / CNB builds can take 2–5 minutes (JDK download + Maven dependencies + compile + image push). Reading status every iteration burns LLM iterations, multiplies tool-call cost, and crowds the message history without adding new evidence.

Apply this discipline whenever you are waiting on a build or deploy:

- Treat the same `event_id` as one polling target. Invoke protected `poll` once with the exact read Tool, status path, terminal values, attempt budget, and timeout; the CLI omits unchanged states and returns only transitions, terminal state, blocker, and retryability.
- Cap polling inside the CLI. When attempt or timeout budget is exhausted, return a graceful intermediate reply with the latest `event_id`, phase, blocker, and what should become true next; never emit repeated same-status results to model context.
- Do not bundle redundant reads in one iteration. Pulling `component_summary` + `pods` + `events` + `build_logs` together for the same component on the same iteration is almost always wasted; pick the single source that is most likely to have new information.
- A status worth re-reading is one where the state has likely changed: immediately after triggering `rainbond_operate_app`, after a manual approval was just granted, after a structurally relevant event (e.g., new `event_id`) appeared. "I want to see if it's done yet" alone is not a justification.
- If the user explicitly asks "看下进度", treat that as a single polling cycle and apply the same cap.
- When you stop polling and hand back to the user, include the latest `event_id`, the last observed phase, and a one-line "what should be true next" so the user can resume without re-explaining context.

This discipline keeps the run loop bounded for genuinely long-running builds. Failure to apply it is the dominant cause of "本次分析轮次已达上限" terminations on otherwise healthy build flows.

## Build Trigger Anchoring

Two concurrent builds on the same component produce two interleaved log streams that the user has to manually de-duplicate. Do not re-trigger `rainbond_build_component` unless the previous build's terminal state is known.

Capture every build trigger by `event_id`:
- `rainbond_create_component_from_source` returns the initial build `event_id` — record it as `build_event_id` immediately
- a later `rainbond_build_component` call returns a new `event_id` — overwrite `build_event_id` with the new value
- if the triggering response does not carry a usable `event_id`, record `trigger_at` and fall back to the most recent build event from `rainbond_get_component_events` for that `service_id`

`status = undeploy` in `rainbond_get_component_summary` is **runtime** state, not **build** state. It means no Pod is currently deployed for this component, and is consistent with:
- a source build still in progress that has not yet produced a deployable image
- a source build that failed downstream and never produced a Pod
- a component that was created but never built

`undeploy` is therefore **not** evidence that a fresh build is needed.

Before calling `rainbond_build_component` again on the same component:
- if `build_event_id` is known, confirm it is terminal via `rainbond_get_component_build_logs(event_id=build_event_id)` — look for `BUILD SUCCESS`, `BUILD FAILED`, or a fatal exit-code line
- if `build_event_id` was lost, read `rainbond_get_component_events` first; if the most recent build event is still in flight, treat that as the active build and wait — do not trigger a new one
- only call `rainbond_build_component` again when the previous build is terminal **and** one of the retry intents in [source rules](40-source-rules.md) applies (source definition changed, build env tuned, explicit retry of same `git_url` + `code_version`)
- never call `rainbond_build_component` purely because `status = undeploy`, `status = waiting`, or because the runtime is "not running yet"; runtime labels are not build signals

When verifying a freshly created source-backed component:
- prefer reading the build log for the captured `build_event_id` over re-reading `component_summary`; the build is the dominant evidence until it is terminal
- only fall back to `rainbond_get_component_events` when `build_event_id` was lost or the build log stream is empty

## Source Build Convergence Before Dependency Completion

For source-backed components:
- create the component first
- trigger the source build/deploy flow
- then re-read component summary, component events, and build/runtime logs before completing downstream dependency wiring

If a source-backed component is still:
- `undeploy`
- `waiting`
- building
- or reporting compile/build failure

then:
- do not force downstream dependency creation that depends on unresolved port metadata
- keep the dependency intent as pending
- report the dependency as deferred, not ignored

Important:
- `web -> api` is still desired for topology visibility
- but it should be created only after `api` has converged enough for dependency creation to succeed

If source creation or source build fails:
- keep the component classified as source-backed in reasoning and output
- read component events first and extract the failed build/deploy `event_id` if one is present
- read the build event log before reading runtime container logs
- only switch to runtime logs when the build has already succeeded or the evidence has clearly shifted from build failure to startup/runtime behavior
- if the failure evidence points to source code, build output, or source metadata, hand off with `blocking_bucket = source build failed` or `next_handoff = code_build_handoff`
- if the build or pull failure evidence points to an unreachable third-party artifact, registry layer, package tarball, or GitHub Release asset, use `blocking_bucket = external artifact unreachable` and `next_handoff = code_build_handoff`
- if the failure evidence points to Rainbond Console, Rainbond Tool, or control-plane exceptions while creating the source component, use `blocking_bucket = platform backend issue` and `next_handoff = none`
- do not retry the same component through the image path unless the user explicitly changes the source definition
- do not retry the same component with a different Git branch or ref unless the user explicitly changes the source definition

## Package Upload Failure Convergence

Package upload is a pre-create transaction, not a partially healthy component state:
- if prepare or initialization fails, no package component was created; record it as skipped/waiting with the concrete local-helper or platform blocker
- if the HTTP upload fails, local cleanup and remote upload deletion must both be attempted before reporting the stop
- if upload status is empty, delete the remote event and stop instead of calling create-by-event
- do not deploy, wire dependencies to, or report a package component as created until event-based creation returns a component identity
- after event-based creation succeeds, use the normal component summary, event, build, and runtime evidence paths; do not repeat the upload merely because runtime convergence is still pending

## Deferred Dependency Recording

If a dependency is intentionally left incomplete because an upstream source-backed component has not converged yet:
- record it in prose
- record it in `deployment_plan.workflow.deferred_dependencies`
- describe the reason as `deferred_by_upstream_convergence`

Do not hide this state inside a generic “unhealthy” summary.
