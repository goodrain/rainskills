# Bootstrap workflow

- Read when: you are about to execute bootstrap, resume a partial run, or reason about dependency deferral and source convergence.
- Do not read when: you only need scope fitting or the final reply format.
- Depends on: [10-context-loading.md](10-context-loading.md), [30-creation-rules.md](30-creation-rules.md), and only the active source/package module named by the entrypoint.
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

For every package-backed component, treat local preparation, event initialization, client HTTP upload, local cleanup,
remote status verification, and the final event-based create-or-replace action as one bounded workflow. Execute the
concrete contract in [package rules](45-package-rules.md) before configuring ports, envs,
storage, dependencies, or deploy state for a newly created component. Existing components keep their current topology
and use `rainbond_replace_component_package` with the same `service_id`.

Convergence gates:
- `source.local_path` is client-local input and is read only by the local helper
- the initialization response must provide both `event_id` and the complete `upload_request`
- the local cleanup attempt happens immediately after the HTTP attempt, before any Rainbond Tool status or create call
- failed HTTP upload means local cleanup, remote upload-event deletion, and stop
- a successful HTTP response is not proof that Rainbond recorded the file; uploaded-file status must be non-empty before create-by-event
- empty status means remote upload-event deletion and stop
- only a successful create-by-event result makes a new component eligible for the remaining topology and deploy steps
- only a successful replace-by-event result with a build `event_id` starts existing-component convergence; wait for that
  build and verify health without recreating the component

### 6. Ensure minimum topology

- ensure dependencies exist from manifest `depends_on` with `rainbond_manage_component_dependency`
- apply the accepted provenance in parent `SKILL.md` **Always-on Guardrail 18**; dependency direction is always consumer `service_id` -> provider `dep_service_id`
- also wire topology edges such as `backend -> db` and `proxy/web -> backend` only when the edge is supported by manifest/Compose, env or config references, project documentation, current runtime evidence, or explicit user confirmation
- for every multi-component topology, build an explicit dependency checklist before handoff:
  - list provider components such as databases, caches, brokers, queues, search services, object storage, and backend/API services
  - list consumer components such as backend/API services, workers, frontends/proxies, admin consoles, dashboards, migration jobs, and management UIs
  - include edges declared in the manifest and accepted edges supported by README instructions, env/config references, proxy upstreams, runtime evidence, or explicit user confirmation; roles or image conventions alone are not evidence
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
