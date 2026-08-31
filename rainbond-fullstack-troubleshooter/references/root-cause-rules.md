# Troubleshooter root-cause rules

## Contents

- Database and dependency failures
- Environment and connection failures
- API and frontend failures
- Build and artifact failures
- Capacity and ConfigMap failures

The parent Skill defines the Console classification mapping and raw-event security boundary because both apply before any branch below is selected.

## Root Cause Rules

After the health overview identifies an abnormal component, apply the parent Skill's Console-reason mapping before selecting the detailed diagnosis below.

### A. Database not ready
Symptoms:
- db not running
- db not ready
- db logs show startup failure

Action:
- do not start by editing `api` env
- report db readiness as the blocking issue

Expected result:
- `runtime_state.label = runtime_unhealthy`
- `next_handoff = none`

### B. Missing dependency
Symptoms:
- `api` cannot resolve or reach db
- `api` lacks expected db connection info
- dependency list does not include db

Action:
- inspect the provider port alias and connection envs first
- add or repair missing provider connection envs on the provider component
- add `api -> db` dependency with `rainbond_manage_component_dependency`
- if the tool returns `requires_open_inner`, open the provider inner port or retry with `open_inner=true` and the provider `container_port`
- runtime DNS reachability, hard-coded service names, Nginx upstreams, or manually written consumer envs do not count as the Rainbond console-visible dependency edge

Expected result:
- if `api` recovers, `runtime_state.label = runtime_healthy`
- otherwise remain `runtime_unhealthy`

### C. Env naming incompatibility
Symptoms:
- db is healthy
- dependency exists or db connection envs are visible
- logs still show connection failure
- db exports `POSTGRES_*` but app expects `DB_*`
- or the app still expects a hard-coded host like `db` even though Rainbond dependency alias envs are available

Action:
- prefer provider-side repair: normalize the provider port alias and add or update provider connection envs such as `DB_USER`, `DB_PASS`, `DB_NAME`, `REDIS_PASSWORD`, or `KAFKA_BROKERS`
- values must come from current provider connection information, explicit input, or `.rainbond/secrets.<environment>.json`
- if the app expects `DATABASE_HOST` / `DATABASE_PORT`, `DB_HOST` / `DB_PORT`, or similar names, prefer a provider port alias that generates those names for all dependents
- add the smallest consumer compatibility env set only when provider-side repair is unsafe, would break existing consumers, or cannot express the expected names
- explicitly report whether the fix was provider connection contract repair or consumer compatibility fallback

Expected result:
- if the key db error clears and `api` becomes healthy, `runtime_state.label = runtime_healthy`
- otherwise remain `runtime_unhealthy`

### D. Wrong connection values
Symptoms:
- wrong host, password, port, db name
- authentication failure
- connection refused
- name resolution failure
- a manifest or runtime env pins a literal dependency hostname that does not resolve in the current Rainbond topology

Action:
- **before mutating env, run the config-override gate**: enumerate mounted config-file volumes from `rainbond_get_component_summary`; if one targets a known config path (`config.yml` / `application.yml` / `application.properties` / `.env` / `nginx.conf` / `*.conf`), that file is authoritative and outranks env (see Runtime Configuration Source Precedence). Repair the file or remove the stale override; an env-only fix silently reverts when the mounted file re-supplies the value
- when comparing config values against env for the gate, report mismatches structurally (e.g. "mounted config.yml overrides env: db host differs from intended") and never print the raw secret value
- if file content cannot be read with current Rainbond Tool capability, flag the override risk and escalate or instruct the user; do not edit env and declare success
- fix only the incorrect values
- when dependency wiring already exists, prefer provider connection envs and the currently resolvable Rainbond dependency alias/service coordinates over stale literal hostnames
- if stale consumer envs duplicate provider connection values, remove or replace the consumer-local override only after confirming the dependency-injected provider values are present
- do not invent values without evidence
- known limitation: cross-team service DNS does not resolve — a component in one team
  cannot resolve another team's component by its Rainbond service alias. If the evidence
  shows a cross-team hostname, do not keep retrying DNS-based fixes; recommend exposing
  the provider through a gateway/external address or moving the components into one team,
  and ask the user to choose

Expected result:
- if corrected values restore startup, `runtime_state.label = runtime_healthy`
- otherwise remain `runtime_unhealthy`

### E. API issue unrelated to db
Symptoms:
- logs point to app startup, port binding, or non-db runtime error
- logs show file-not-found or permission errors for file-backed config/secret paths

Action:
- **before mutating env, run the config-override gate**: if a config-file volume is mounted at a known config path (`config.yml` / `application.yml` / `application.properties` / `.env` / `nginx.conf` / `*.conf`), that mounted file outranks runtime env (see Runtime Configuration Source Precedence). A startup value driven by the mounted file will not change from an env edit; repair the file or remove the stale override instead. When file content cannot be verified with current Rainbond Tool capability, flag the override risk and escalate rather than declaring the env fix successful
- report clearly that the issue is not primarily the db path
- do not force db-oriented repairs
- if the evidence shows a source/build defect rather than a runtime config issue, reclassify to `code_or_build_handoff_needed`
- for file-backed config/secret mounts, treat Rainbond mount path as a directory when a config filename is present; adjust the consuming env to `<mount_dir>/<config_name>` once. Comparing mounted config values against env for the override gate is allowed and expected, but never print raw file contents or secret values verbatim — report only structural mismatches

Expected result:
- `runtime_unhealthy` for unresolved runtime issues
- `code_or_build_handoff_needed` only when the dominant blocker is outside platform-side repair

### F. Frontend access-path issue
Symptoms:
- browser still fails after db and api are healthy
- frontend calls localhost, invalid absolute URL, or missing `/api` proxy
- issue is caused by build-time env injection or reverse proxy config

Action:
- do not continue platform-level env or dependency edits
- report the frontend/runtime access-path issue clearly
- hand off to code/build work

Expected result:
- `runtime_state.label = code_or_build_handoff_needed`
- `next_handoff = code_build_handoff`

### G. Source build still running
Symptoms:
- source-backed components are `undeploy`, `waiting`, or otherwise not yet converged
- recent events show build or compile is still in progress
- dependency creation is blocked because target component runtime metadata is not ready yet

Action:
- do not keep patching envs or dependency wiring blindly
- report this as a build-convergence state, not a completed runtime diagnosis
- identify which dependency edges are still pending
- continue only after fresh state or build completion is available

Expected result:
- `runtime_state.label = topology_building`
- `next_handoff = none`

### H. Source build failed
Symptoms:
- recent events explicitly show compile failure or build failure
- source-backed component remains `undeploy` with failed build events
- build log or event evidence points to source/build issues rather than platform runtime configuration
- build log may show unreachable external artifacts; classify those separately as `external artifact unreachable`

Action:
- do not continue platform-level env or dependency edits as the primary fix
- read component events first and collect the relevant failing component and build `event_id`
- read the build event log before reading runtime container logs
- if the build log shows a missing or incorrect low-risk build parameter, apply the smallest viable `build_env_dict` change through `replace_build_envs`
- do **not** try to fix a source build failure by moving build parameters into `build_info`
- if the low-risk build-env repair is not clearly justified, or one repair attempt does not clear the build failure, classify the issue as code/build handoff
- only return to platform-side repair after the source/build issue is fixed

Expected result:
- `runtime_state.label = code_or_build_handoff_needed`
- `next_handoff = code_build_handoff`

### H2. External artifact unreachable
Symptoms:
- build logs fail while downloading GitHub Release assets, native binary packages, package tarballs, language installer binaries, or registry layers
- image pull events show registry, Docker Hub, or layer download timeouts
- examples include sharp/libvips release downloads and Docker Hub image pull timeouts

Action:
- keep the original component delivery mode
- read component events first and the relevant build or pull evidence second
- do not start local Docker/OrbStack, push a temporary image, or switch to package/image fallback automatically
- do not attempt build-env fixes for registry or network failures: no documented build key affects network reachability, and inventing one (mirror/proxy-style names) burns the retry budget on a no-op
- recommend a reachable registry/artifact mirror, restoring cluster egress, or explicit user-approved delivery-mode change

Expected result:
- `runtime_state.label = code_or_build_handoff_needed`
- `blocker_bucket = external artifact unreachable`
- `next_handoff = code_build_handoff`

### I. Cluster capacity blocked
Symptoms:
- recent events contain `Unschedulable`
- scheduler reports CPU or memory shortage
- the repaired or newly built component cannot start because the cluster cannot place the workload

Action:
- stop application-level env and dependency repair loops
- classify the issue as a platform capacity blocker
- state which component is blocked on scheduling
- recommend reducing requested resources or restoring cluster capacity
- only return to application verification after scheduling can proceed

Expected result:
- `runtime_state.label = capacity_blocked`
- `next_handoff = none`

### J. Config-file ConfigMap missing
Symptoms:
- pod events show `FailedMount` with `configmap ... not found`
- the component has config-file volumes in its storage summary
- upgrade/deploy succeeds at the build stage but the pod never starts

Action:
- read the component storage summary and locate every config-file volume and its mount path
- read `rainbond_get_config_file` for each config-file volume to confirm the platform-side content exists
- read pod detail and extract the missing ConfigMap name from the `FailedMount` event
- apply at most one low-risk repair: re-save the config-file volume content via `rainbond_manage_component_storage(update_volume)`. 路径不变时省略 `new_volume_path`; when repairing the config-file content, `new_file_content` is required, then restart once
- if the ConfigMap is still missing after one repair attempt, or the storage update returns a 5xx error, stop. Report a platform-side sync blocker; do not loop on config edits

Expected result:
- if the mount recovers, `runtime_state.label = runtime_healthy`
- otherwise `runtime_state.label = runtime_unhealthy` with `blocker_bucket = config_file_configmap_missing`
