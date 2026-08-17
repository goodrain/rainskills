# Workflow and Convergence

- Read when: you are about to execute bootstrap, resume a partial run, or reason about dependency deferral and source convergence.
- Do not read when: you only need scope fitting or the final reply format.
- Depends on: [10-context-loading.md](10-context-loading.md), [30-creation-rules.md](30-creation-rules.md), [40-source-and-package-rules.md](40-source-and-package-rules.md) when source/package components are involved.
- Produces: the ordered execution plan, dependency-deferral decisions, and runtime-inspection sequence.

## Mainline Summary

Bootstrap follows this high-level flow:
1. read manifest, binding, env, and secrets
2. confirm the target app exists
3. create components in dependency-aware order
4. apply minimum ports, dependencies, and startup config
5. deploy affected components
6. inspect runtime evidence
7. decide whether to stop, hand off, or finish bootstrap

## Detailed Execution Order

Follow this order.

### 1. Resolve context and selected environment

- collect any user-explicit identifiers, environment choice, component overrides, or env overrides first
- read `.rainbond/local.json` if present for bound `team_name`, `region_name`, `app_name`, `app_id`, platform server, and `preferences.default_environment`
- if `.rainbond/local.json.runtime_components` exists, load it as a reuse hint for later role-to-runtime matching
- select the environment file with this order: user explicit input > `.rainbond/local.json.preferences.default_environment` > `preview`
- read `.rainbond/secrets.<environment>.json` if present and extract component-level secret env values
- read the selected `.rainbond/env.<environment>.json` if present and extract environment-layer component env overrides
- read `rainbond.app.json`; if absent, read legacy `rainbond.json` as the same lowest-priority baseline tier
- parse and validate `schema_version` for whichever baseline file is used
- merge app identity, topology, and env intent using the configuration-priority rules
- if `included_components` or `excluded_components` is present, compute the filtered execution set
- ask the user only for values still missing after all configured layers are resolved

### 2. Ensure app exists

- find the target app
- create it if missing
- if the app already exists, query current component data through Rainbond Tools first and use `.rainbond/local.json.runtime_components` only as a hint to align logical roles to existing runtime components before deciding whether to reuse or create resources

### 3. Ensure provider components exist

For executable database and middleware provider components such as databases, caches, brokers, and queues:
- if image-backed, create from manifest if missing
- if source-backed, create from source if explicitly supported
- if package-backed, create from local package path if explicitly supported
- if template-backed, skip and record that template installation must be handled upstream

Then:
- ensure startup env exists for the provider itself
- ensure the provider inner port is configured
- normalize provider port aliases when `port_alias` or a clear convention is available
- configure provider-side connection envs with `rainbond_manage_component_connection_envs`
- for stateful middleware providers, inspect component storage and ensure a durable volume is mounted at the known data directory before deploy/restart; use `rainbond_manage_component_storage` for the storage summary, volume creation, and mount creation path
- if stateful middleware storage cannot be created, record the persistence caveat immediately and do not present the component as production-safe

### 4. Ensure service components exist

- create services from manifest if missing
- proceed in dependency order
- for source-backed services, use source creation instead of image creation
- for package-backed services, use package upload instead of image creation
- for template-backed services, skip and report them as non-bootstrap components

### 5. Ensure frontend component exists

- create `web` from manifest if missing
- for source-backed frontends, use source creation instead of image creation
- for package-backed frontends, use package upload instead of image creation
- for template-backed frontends, skip and report them as non-bootstrap components

### 5a. Converge package uploads before topology configuration

For every package-backed component, treat local preparation, event initialization, client HTTP upload, local cleanup, remote status verification, and event-based component creation as one bounded transaction. Execute the concrete contract in [40-source-and-package-rules.md](40-source-and-package-rules.md) before configuring ports, envs, storage, dependencies, or deploy state for that component.

Convergence gates:
- `source.local_path` is client-local input and is read only by the local helper
- the initialization response must provide both `event_id` and the complete `upload_request`
- the local cleanup attempt happens immediately after the HTTP attempt, before any Rainbond Tool status or create call
- failed HTTP upload means local cleanup, remote upload-event deletion, and stop
- a successful HTTP response is not proof that Rainbond recorded the file; uploaded-file status must be non-empty before create-by-event
- empty status means remote upload-event deletion and stop
- only a successful create-by-event result makes the component eligible for the remaining topology and deploy steps

### 6. Ensure minimum topology

- ensure dependencies exist from manifest `depends_on` with `rainbond_manage_component_dependency`
- also wire accepted inferred topology edges such as `backend -> db` and `proxy/web -> backend` when the manifest or deployment reasoning used those links to make the app work
- for every multi-component topology, build an explicit dependency checklist before handoff:
  - list provider components such as databases, caches, brokers, queues, search services, object storage, and backend/API services
  - list consumer components such as backend/API services, workers, frontends/proxies, admin consoles, dashboards, migration jobs, and management UIs
  - include edges declared in the manifest and edges strongly inferred from README instructions, service roles, image conventions, env names, config hostnames, exposed internal ports, proxy upstreams, or connection workflows used by the application
  - query the current dependency summary before adding edges, add missing accepted edges, then query again to verify the visible Rainbond topology
- if the dependency tool reports `requires_open_inner`, open the target component's inner port or retry with `open_inner=true` and the target `container_port`
- do not report that Rainbond Tool lacks explicit dependency management; `rainbond_manage_component_dependency` is the explicit dependency management tool
- do not treat Nginx `proxy_pass`, application config hostnames, Kubernetes Service DNS, or manually written runtime envs as a replacement for a Rainbond dependency edge
- when adding a dependency to a middleware provider, prefer provider connection envs over duplicate consumer runtime envs
- set only the minimum frontend env required by the declared `access_mode`
- if a dependency target is source-backed and not yet converged, defer dependency creation until that target exposes usable runtime metadata
- if a consumer can start without its provider, do not use that startup success as proof the topology is complete; the accepted provider/consumer edge must still be present, deferred, or reported as a blocker

### 7. Deploy affected components

- deploy or restart only the components affected by creation or configuration changes

### 8. Run first-pass verification

- read app detail
- read summaries for all components
- for source-backed components or explicit build-failure questions:
  - read component events first
  - if events expose a failed build/deploy `event_id`, read the corresponding build log
  - read runtime logs only when build evidence no longer explains the failure
- read runtime logs for any abnormal component whose dominant issue is no longer a build problem
- for source-backed components, inspect recent events to determine whether the component is:
  - still building
  - compile-failed
  - waiting on unresolved runtime metadata

### 9. Decide whether to stop or hand off

- if frontend `access_mode` is unspecified, stop and hand off
- if source-backed components are still building or have compile/build failures, stop and hand off
- if there is a deeper runtime issue, hand off to `rainbond-fullstack-troubleshooter`
- if runtime components are converged and the remaining question is only user-facing access or delivery acceptance, hand off to `rainbond-delivery-verifier`
- if setup is structurally complete and frontend `access_mode` is specified, stop

## Build / Deploy Polling Discipline

Builds and deploys are slow and asynchronous. Java / CNB builds can take 2–5 minutes (JDK download + Maven dependencies + compile + image push). Reading status every iteration burns LLM iterations, multiplies tool-call cost, and crowds the message history without adding new evidence.

Apply this discipline whenever you are waiting on a build or deploy:

- Treat the same `event_id` as one polling target. Two consecutive reads of the same `event_id` (whether `rainbond_get_component_build_logs` or `rainbond_get_component_summary` against the same `service_id`) must be separated by meaningful new state — not just "let's check again".
- Cap polling: if four consecutive reads of the same `event_id` (or four consecutive same-status `rainbond_get_component_summary` reads on the same component) all show the same in-flight state, stop polling. Return a graceful intermediate reply to the user that says "build still in progress, expected ~N minutes; reply '继续' or 'check' to resume status check" and end the run.
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
- only call `rainbond_build_component` again when the previous build is terminal **and** one of the retry intents in [40-source-and-package-rules.md](40-source-and-package-rules.md) applies (source definition changed, build env tuned, explicit retry of same `git_url` + `code_version`)
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
