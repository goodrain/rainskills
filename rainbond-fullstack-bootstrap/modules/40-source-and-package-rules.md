# Source and Package Rules

- Read when: any in-scope component resolves to `source` or `package`, or when build-parameter tuning is under discussion.
- Do not read when: all components are image-backed and no source/package routing is needed.
- Depends on: [../SKILL.md](../SKILL.md), [10-context-loading.md](10-context-loading.md), [30-creation-rules.md](30-creation-rules.md), [../references/source-build-parameter-guide.md](../references/source-build-parameter-guide.md).
- Produces: the correct execution path, build-parameter routing, and stop conditions for source-backed and package-backed components.

## Source-backed Components

For v2-style source components:
- `source.kind = source` means the component should be created through the Rainbond source-creation flow
- map:
  - `source.git.remote_url` -> `git_url`
  - `source.git.ref` -> `code_version`
  - `source.subdirectories` -> `subdirectories`

### Source-kind Preservation

Once a component resolves to `source.kind = source`:
- preserve that execution path for the current run
- if source creation or source build later fails, classify that as `source build failed` or `code_build_handoff`
- do **not** silently downgrade the component to `image`
- do **not** guess a fallback image unless an explicit higher-priority image override was provided for the current run
- do **not** switch to local Docker build, temporary registry push, or package upload as an implicit workaround

### Source-ref Preservation

Once `code_version` or source ref has been resolved:
- preserve it for the current run
- if the remote branch or ref does not exist, stop and report the source-ref problem explicitly
- do **not** silently rewrite `newmain` to `master`, `main`, or any other branch
- do **not** probe alternative refs unless the user explicitly changes the source definition for the run

### `code_from` Mapping

- generic Git or Gitee repositories -> `git`
- GitHub repositories -> `github` or `git`; prefer `github` when clearly supported, otherwise use `git`
- OAuth-backed repositories -> preserve the provided `oauth_xxx` value

If `code_from` cannot be determined safely:
- mark the source component as `needs-confirmation`
- do not guess

If the user provides a proxied Git URL:
- preserve `source.kind = source`
- use the provided proxied URL as `git_url`
- do not reinterpret a Git proxy URL as an image hint or fallback signal

### GitHub Proxy Prompt

If all of the following are true:
- `git_url` is a raw `https://github.com/...` URL
- the user did not explicitly provide a proxy URL
- the URL is not already under `https://ghfast.top/` or `https://gh.rainbond.cc/`

Then:
- ask once whether to keep the raw GitHub URL or switch to a proxy URL before calling source creation
- recommend `https://ghfast.top/https://github.com/...` first
- `https://gh.rainbond.cc/https://github.com/...` may be offered as an explicit alternate

### Source-create Precheck

For standard source-backed creation:
- required inputs are `git_url`, `code_version`, `code_from`, and optional `subdirectories`
- **always pass `code_version` as the repository's real default branch** — from the project source profile's `repo.defaultBranch` when available (e.g. `rainbond_get_project_source_profile`), otherwise the ref the user gave or the detected default. Omitting `code_version` makes the backend default to `master`, so any `main`-default repo fails creation and forces a recovery path that loses the build-mode preference (see Retry Discipline). Do not blind-guess `master`/`main`.
- `check_uuid` and `event_id` are optional passthrough fields only when a prior detection flow already produced them
- do **not** invent a blocker just because `check_uuid` or `event_id` is absent
- only stop on this point if the backend explicitly returns that those fields are required for the current request

### Source-create Retry Discipline

`rainbond_create_component_from_source` is a create-and-build tool, not an idempotent retry tool. Every call mints a new `service_id`. A failed source-creation flow does **not** mean the component is absent — the component row, ports, envs, and dependency edges may already exist with the build merely failing downstream.

Before calling `rainbond_create_component_from_source` after any earlier source failure in the same run:
- query the target app with `rainbond_query_components` and look for a matching `service_cname` or `k8s_component_name`
- if a matching component already exists, do **not** call `rainbond_create_component_from_source` again — switch to the retry path below

Pick the retry path by intent:
- same `git_url` + same `code_version`, want to retrigger the build → `rainbond_build_component(service_id, build_info=...)`
- source definition changed (`git_url`, `code_version`, `server_type`, credentials) → `rainbond_update_component_build_source` then `rainbond_build_component`
- build env tuning only → `rainbond_manage_component_envs(operation=replace_build_envs, build_env_dict=...)` then `rainbond_build_component`

Rules:
- never call `rainbond_create_component_from_source` twice for the same logical component in one run; that produces duplicate `service_id` rows the user has to clean up
- a build failure surfaced by events or build logs is **not** evidence the component was not created; verify with `rainbond_query_components` before any retry
- the existing source-failure handling in [50-workflow-and-convergence.md](50-workflow-and-convergence.md) (read events, read build log, classify blocker) still applies; this section only governs which tool to call when retry is justified

**CNB/Dockerfile recovery:** use `rainbond_get_component_check_result` with `prefer_dockerfile_when_detected=true` for a `checking`/`checked` component. Console persists and applies that preference while `create_status` is not `complete`; inspect the returned Dockerfile evidence before continuing. A `complete` CNB component has no general in-place build-mode switch. Only after recording its topology/configuration snapshot, showing `create_status=complete`, and receiving explicit user confirmation may the workflow delete and recreate it with `prefer_dockerfile_when_detected=true`, then restore ports, envs, dependencies, and storage. Missing status evidence or confirmation is a read-only stop condition.

### Multi-service Source Ambiguity

If source detection reports `multiple services detected` or equivalent multi-component ambiguity:
- stop the current bootstrap path immediately
- report that the repository requires an explicit component-selection strategy
- do **not** automatically switch the component from source to local package
- do **not** automatically build jars locally, upload artifacts manually, or install middleware templates as a workaround
- only continue on a package-backed or manually selected path after the user explicitly confirms that strategy

### Compose / Multi-service Topology

When the project is a docker-compose application — a `docker-compose.yml` / `compose.yaml`, or a project source profile with `topologySource == "compose"` — deploy the whole topology as one Rainbond app with **one component per compose service**. Create each service **individually with its own `subdirectories`** (its compose `build.context`), so every create call is single-service and does not trip the "multiple services detected" stop above.

Per service, by kind (from the profile's `deployKind`):
- `image` (compose `image:`) → `rainbond_create_component_from_image` (image proxied per guardrail 7).
- `source` (compose `build:`) → `rainbond_create_component_from_source` with its `subdirectories`, `code_version = repo.defaultBranch`, and `prefer_dockerfile_when_detected = true` when the service ships a Dockerfile (compose `build:` almost always does). Get these right **at create** (see Source-create Precheck + Build Mode) so no recovery path is needed.

Completeness:
- create one component per service, then confirm the created-component count matches the profile's service count.
- one-shot / init-only services (seed, migrate, fixtures — run once and exit, not long-running) MAY be skipped, but the skip and its reason MUST be stated explicitly in the report. Never silently drop a service.

#### Optional services (`optionalServices`) — disclose, do not auto-deploy

A compose project source profile now splits services into two lists:
- `services[]` — only the services that the profile's default `COMPOSE_PROFILES` actually activates. This is the default deploy set.
- `optionalServices[]` — profile-gated services that are **not** activated by default (alternative vector stores / databases / backends a user could swap in, e.g. dify's optional `weaviate` / `qdrant` / `pgvector` choices behind a profile flag).

Rules:
- **By default deploy only `services[]`.** Do not create components for anything in `optionalServices[]` unless a trigger below fires.
- **Disclose their existence once**, briefly, in the report — e.g. "该 compose 还提供了可选向量库 `qdrant` / `weaviate`（默认未部署）。"
- **Only prompt the user to pick from `optionalServices[]` when** the user explicitly asks for one, OR `services[]` is missing a capability the app genuinely requires (e.g. the app needs a vector store but the default-active set has none). If the default-active set already supplies that capability (e.g. `weaviate` is already in `services[]`), do **not** ask — the requirement is met.
- Never silently activate an optional service to "complete" the topology; an optional service is a user-facing choice, not a missing default.

#### Compose service names are NOT hostnames (R1 — highest priority)

Compose service names (`db_postgres`, `redis`, `sandbox`, `plugin_daemon`, …) resolve to each other **inside the compose network only**. They do **not** resolve once the topology lands in Rainbond: a compose service name is not a cluster DNS name, and names with underscores (`db_postgres`, `plugin_daemon`) are not even valid DNS labels. So **forbidden**: writing a compose service name into any consumer connection variable (`*_HOST`, `*_URL`, `*_ADDR`, `*_ENDPOINT`, `*_BROKERS`, a DSN host segment, …).

Translate each compose `depends_on` + service-name reference into the two Rainbond steps:
1. **Add the dependency edge** — `rainbond_manage_component_dependency(operation=add)` from the consumer to the provider (this is the same mandatory wiring as `30-creation-rules.md § 4`).
2. **Render the connection from dependency injection** — when a provider component has an enabled inner port, the platform auto-generates two `outer`-scope envs **on the provider**: `{ALIAS}_HOST` and `{ALIAS}_PORT` (the alias defaults to a `{UPPER_SERVICE_ALIAS}{PORT}` form such as `GR186CA1_5432`; read the provider's env list for the exact name). The dependency edge then **injects** the provider's `outer`/`both`-scope envs into the consumer container. So:
   - **Prefer consuming the injected variables directly.** If the application can read `{ALIAS}_HOST` / `{ALIAS}_PORT`, point it at those — no host literal is written at all.
   - **If the application requires a fixed variable name** (e.g. it hard-reads `DB_HOST`), first read the provider's auto-generated `{ALIAS}_HOST` env value (its **k8s service internal domain**) and put that value into the consumer's fixed variable.
   - **Forbidden:** writing a compose service name into the host. **Also forbidden:** unconditionally hard-coding `127.0.0.1`. `{ALIAS}_HOST` resolves to `127.0.0.1` **only** under the `BUILD_IN_SERVICE_MESH` governance mode; the default (kubernetes-native service) governance mode resolves it to the port's k8s service internal domain, so a blanket `127.0.0.1` is wrong outside built-in mesh.

dify-derived examples (❌ as the LLM copied from compose → ✅ after wiring the dependency edge and rendering from injection):
- `DB_HOST=db_postgres` ❌ → add dep api→db_postgres, then either let api read the injected `{ALIAS}_HOST`, or `DB_HOST=<provider's auto-generated {ALIAS}_HOST value, i.e. the db's k8s service internal domain>` ✅
- `REDIS_HOST=redis` ❌ → add dep api→redis, then `REDIS_HOST=<redis provider's injected {ALIAS}_HOST value>` ✅
- `SANDBOX_API_URL=http://sandbox:8194` ❌ → add dep api→sandbox, then `SANDBOX_API_URL=http://<sandbox provider's injected {ALIAS}_HOST value>:8194` ✅

This extends `30-creation-rules.md § 4` (connection contracts live on the provider) to the compose case explicitly — it does not contradict it. The provider still owns the connection contract; what this rule adds is "the compose service name is never the host, and the host comes from dependency injection (the provider's `{ALIAS}_HOST` internal domain), not a hard-coded `127.0.0.1`."

#### Reverse-proxy / gateway services must not be silently dropped (R2)

When the compose topology contains a pure reverse-proxy / gateway service (`nginx`, `traefik`, `caddy`, an `*-proxy` / `*-gateway` service whose only job is routing), do **not** silently drop it. Decide by routing semantics:

- **The proxy carries same-origin path routing** — the frontend env points API calls at relative paths (`CONSOLE_API_URL=/api`, `VITE_API_URL=/api`, a base-path of `/`), or the proxy config fans one host out to several upstreams by path (`/console/api`, `/api`, `/v1` → `api:5001`). In this case **keep the proxy as a component and make it the single external entry point**: only the proxy gets an external port (`enable_outer`); `web` / `api` get inner ports only and are NOT exposed directly. Exposing `web` directly while its frontend expects same-origin `/api` produces guaranteed frontend 404s (the dify failure mode: `web` configured `CONSOLE_API_URL=/api` but nothing served `/api`).
  - The proxy needs its routing config (e.g. `nginx.conf`). When the profile does not carry that config, either ask the user for it, or generate it from the config-file evidence sitting next to the compose file in the same directory. State which you did.
  - **The proxy's upstream addresses follow R1 — they are not `127.0.0.1`.** A compose `nginx.conf` typically writes `proxy_pass http://api:5001;` or `proxy_pass http://127.0.0.1:5001;`. Neither survives in Rainbond: the compose service name does not resolve, and `127.0.0.1` only works under built-in-mesh governance. Wire the proxy→upstream dependency edge (`rainbond_manage_component_dependency`) and rewrite each upstream to the upstream provider's dependency-injected `{ALIAS}_HOST` value (its k8s service internal domain) and port. Do **not** leave `proxy_pass http://127.0.0.1:5001;` or `proxy_pass http://api:5001;` in the rendered config.
- **The proxy is only a simple port forwarder** (one upstream, no path-routing semantics) — then it MAY be omitted, and the backend exposed through the Rainbond gateway directly.

When in doubt (frontend uses relative API paths, or multiple upstreams are routed by path), keep the proxy. Dropping a path-routing reverse proxy is the failure, not keeping it.

**Proxy deploy blocker (HARD — must complete before deploying the proxy component):** a kept proxy/gateway component must NOT be deployed until **both** of the following are done:
1. **Routing config mounted** — the proxy's routing config (`nginx.conf` / equivalent) is mounted onto the proxy component as a config-file volume, with each `proxy_pass` upstream rewritten per R1 to the provider's dependency-injected `{ALIAS}_HOST` (not a compose service name, not `127.0.0.1`). A reverse proxy with **no** routing config mounted defaults to its image's stock config (a bare web root / `localhost` upstreams) — it does not route to the app at all. Deploying nginx "naked" (no config mounted) is the failure mode observed in the real session.
2. **proxy→upstream edges wired** — every `proxy→<upstream>` dependency edge (api, web, every backend the config routes to) is added with `rainbond_manage_component_dependency`, so the injected `{ALIAS}_HOST` values the config relies on actually exist.

If either is incomplete — config cannot be mounted (config-file mount failed, or the routing config could not be obtained) or an upstream edge cannot be wired — **do not deploy the proxy**. Report it to the user as a **delivery blocker** stating exactly what is missing and why (no routing config ⇒ proxy would serve its default page instead of routing; missing upstream edge ⇒ upstream unresolvable). Deploying the proxy with its default/stock config silently is forbidden: the default config = entry must be mounted.

Configure and bring up (reuse existing rules, do not invent tools):
- per-service config: ports (provider/infra such as db, redis → `enable_inner` only; web/public-facing → `enable_inner` + `enable_outer`); runtime envs; persistence for stateful services (storage before deploy, guardrail 17); provider connection envs.
- dependencies: wire **both** (a) every compose `depends_on` edge **and** (b) every **env-reference consumption edge** — any edge where a consumer's env *value* references another component's internal domain / compose alias / service name (`SANDBOX_API_ENDPOINT=http://sandbox:8194/v1`, `DIFY_INNER_API_URL=http://api:5001`, a `*_HOST` / `*_URL` / `*_ENDPOINT` / DSN pointing at another service, …) — with `rainbond_manage_component_dependency`. `depends_on` is necessary but **not sufficient**: compose frequently omits `depends_on` for services that are still consumed through env (the dify failure mode — api/worker referenced `sandbox` / `ssrf_proxy` / `plugin_daemon` in env, plugin_daemon referenced `db` / `api` in env, yet `depends_on` only declared api/worker→db/redis). A missing env-reference edge means the injected `{ALIAS}_HOST` is absent and the consumer cannot resolve the provider at runtime.

  **Dependency-completeness gate — executable three steps (run after envs are configured, before deploy):**
  1. **Enumerate per consumer** — for each component, scan its full env set and list every other component referenced by an env *value* (by k8s internal domain, compose alias, or service name). Combine with the compose `depends_on` edges.
  2. **Diff against wired edges** — query the current dependency evidence with `rainbond_manage_component_dependency(operation=summary)` and subtract it from the set in step 1.
  3. **Close the diff before deploy** — if the diff is non-empty, add the missing edges with `rainbond_manage_component_dependency` **first**, then re-verify; only deploy once the diff is empty (or each still-unwirable edge is explicitly recorded as a deferred dependency / blocker). The final report must list the complete edge set (depends_on edges + env-reference edges) so the user can audit it.
- bring-up differs by kind: image components deploy directly (`rainbond_operate_app`); **source components must be built** (`rainbond_build_component`) — a source component that was only created/detected has no runnable image and stays `undeploy` if you merely `operate_app deploy` it. Deploy the infra (db/redis) first, then build the source services that depend on them.

## Source Build Parameter Rules

Use source build parameter tools only when there is:
- explicit build-tuning intent
- or build evidence that points to a missing or incorrect build setting

Tool boundaries:
- build parameters -> `rainbond_manage_component_envs(operation=replace_build_envs, build_env_dict=...)`
- runtime envs -> `rainbond_manage_component_envs` with normal env operations such as `upsert`
- provider connection envs -> `rainbond_manage_component_connection_envs`
- dependencies -> `rainbond_manage_component_dependency`
- source repository / ref / credentials -> `rainbond_create_component_from_source` inputs and `rainbond_build_component.build_info`

Minimal-parameter strategy:
- determine the component language from explicit user input first, then source detection or current component build metadata
- if the language is still ambiguous, stop and read the detection result before modifying `build_env_dict`
- add only the smallest set of build keys needed for the current evidence or explicit request
- do **not** dump a full language template into `build_env_dict` "just in case"

Guardrails:
- do **not** put runtime-oriented variables such as `NODE_OPTIONS`, `JAVA_TOOL_OPTIONS`, `BPL_*`, `PORT`, or db connection envs into `build_env_dict` by default
- do **not** use consumer runtime envs as a substitute for provider connection envs plus explicit dependencies
- do **not** echo secret example values
- Python build tuning does **not** get a made-up Node-style `CNB_BUILD_SCRIPT`
- when a Dockerfile is detected alongside a language build, resolve the build mode by priority: manifest `source.build.strategy` first; then heuristic on Dockerfile classification + intent signals (see `../references/source-build-parameter-guide.md § Build Mode Selection`); only ask the user when signals are genuinely ambiguous. Map a `dockerfile` decision to `prefer_dockerfile_when_detected = true` on `rainbond_create_component_from_source`. Record the per-component decision in BOTH the prose ("Build mode for `<name>`: …") and the structured output (`deployment_plan.workflow.build_strategy_decisions[<name>]`) so the user can audit and override.
  - **Recovery is state-dependent.** `rainbond_get_component_check_result(prefer_dockerfile_when_detected=true)` can apply a Dockerfile preference while `create_status` is not `complete`; use its returned evidence, not a guessed build strategy. A completed CNB component has no general in-place switch and may only be recreated through the confirmed, snapshotted exception in Source-create Retry Discipline.
  - **Check-timeout recovery:** after a checking/timeout create, call `rainbond_get_component_check_result` and pass `prefer_dockerfile_when_detected=true` when Dockerfile was selected. The response fields `prefer_dockerfile_when_detected`, `dockerfile_preference_applied`, and `build_mode_note` are the evidence. If preference is not applied because no Dockerfile was detected, stop for an explicit source-path or delivery-mode decision; do not retry create speculatively.

### Bounded build wait

After a build/deploy trigger, prefer `rainbond_wait_for_build_completion` with an explicit maximum call count. If it reaches its bound, query final platform facts once and stop; never replay the build merely because the wait timed out.
  - **.NET version trap:** dotnet/.NET Core is treated as CNB-capable, but the CNB version policy only allows .NET 8/9/10. A repo on a CNB-rejected version (e.g. .NET 7 → `dotnet version 7.0 is not allowed by cnb version policy`) that ships a usable Dockerfile MUST be created with `prefer_dockerfile_when_detected = true`, or its CNB build dead-ends with no in-place recovery.
- if build logs fail while downloading third-party build artifacts such as GitHub Release assets, native binary packages, image layers, or package-manager tarballs, classify the blocker as `external artifact unreachable` when the dominant evidence is network reachability rather than app source code
- examples include sharp/libvips release downloads, registry layer pulls, Docker Hub timeouts, package tarball download timeouts, or language installer binary downloads
- for `external artifact unreachable`, stop after one evidence-backed retry or mirror attempt; do not convert the component to a different delivery mode automatically

### Monorepo Build Context

For source-backed components in monorepos:
- preserve repository-root build context when the component Dockerfile or build command depends on root-level files such as `pyproject.toml`, `uv.lock`, `pnpm-lock.yaml`, `package-lock.json`, `bun.lock`, `go.work`, `settings.gradle`, or `pom.xml`
- use component subdirectory metadata only when it does not hide required root build files from the builder
- if the current Rainbond source interface cannot express the required build context safely, stop with a source/build handoff or manifest review instead of staging a local package silently

Read [../references/source-build-parameter-guide.md](../references/source-build-parameter-guide.md) for the current Rainbond Tool key list and minimal examples.

### SQL Initialization Assets

If the source repository ships SQL initialization files (`sql/*.sql`, `db/init/*.sql`, similar) and the database component is not a pre-baked image that auto-imports them:
- treat SQL initialization as a first-class delivery concern; do **not** wait for runtime errors like `Table 'X' doesn't exist` to surface it
- pick exactly one delivery path from [../references/sql-init-recipe.md](../references/sql-init-recipe.md) and stick to it
- the default path is Recipe A (Init-Job Component) when the application source is in a git repo reachable by the cluster
- do **not** use public file-sharing services, manual `kubectl exec`, or import containers without `depends_on` as workarounds
- do **not** silently choose local-package upload as the SQL transport; require explicit user opt-in

## Package-backed Components

For v2-style package components:
- `source.kind = package` means the component should be created through the Rainbond package-upload flow
- map:
  - `source.local_path` -> input read by the local upload helper only
  - `source.archive_name` -> optional zip filename when `local_path` is a directory

### Client Upload Contract

Package bytes live on the client machine. The local helper is the only process allowed to resolve, read, archive, or upload the local source. Never pass `source.local_path` to a Rainbond Tool.

Follow this transaction in the exact order below:

1. Run `upload_local_package.py prepare` locally:
   - resolve `source.local_path` relative to the current project directory unless it is already absolute
   - use a workspace-local staging root such as `.rainbond/staging/<component>/`; never stage under `/tmp`
   - pass `source.archive_name` only when supplied
   - capture the helper's `archive_path`, `file_name`, `generated`, and `staging_root` result fields
   - a supported package file is reused directly; a directory is converted to a zip archive by the helper
2. Call `rainbond_init_package_upload` with Rainbond context only. It must return a non-empty `event_id` and an `upload_request`. Do not continue when either is absent or malformed.
3. Run `upload_local_package.py upload` locally with `archive_path` plus the exact returned `upload_request` contract:
   - `upload_request.url` -> `--upload-url`
   - `upload_request.url_scope` -> `--url-scope`
   - `upload_request.method` -> `--method`
   - `upload_request.content_type` -> `--content-type`
   - `upload_request.file_field` -> `--file-field`
   - `upload_request.authorization` -> `--authorization`
   - do not invent a URL, authorization mode, form field, HTTP method, or content type; the helper validates the same-Console-origin upload contract before invoking HTTP
4. Run `upload_local_package.py cleanup` immediately after the HTTP attempt returns, whether upload succeeded, failed, or timed out. Pass the captured `archive_path`, `staging_root`, and `generated` flag. This cleanup must finish or be reported before any upload-status or component-create call.
5. If and only if the HTTP upload succeeded, call `rainbond_get_package_upload_status(event_id=...)`. The returned uploaded-file status must be non-empty and must identify at least one uploaded file.
6. If and only if status is non-empty, call `rainbond_create_component_from_package(event_id=...)`. Package creation is event-based; no local filesystem path belongs in this call.

The helper command is `python3 rainbond-fullstack-bootstrap/scripts/upload_local_package.py <prepare|upload|cleanup> ...`. Preserve its JSON result fields exactly between phases; do not reconstruct paths or upload parameters from memory.

### Cleanup and Stop Rules

- prepare failure -> stop before initialization; there is no upload event to delete
- initialization failure or a response without a complete `event_id` / `upload_request` -> run local helper cleanup using the prepare result, then stop
- HTTP upload failure or timeout -> run local helper cleanup first, then call `rainbond_delete_package_upload(event_id=...)`, then stop; never query status or create a component
- empty uploaded-file status -> call `rainbond_delete_package_upload(event_id=...)` and stop; never create a component from an empty event
- if remote deletion also fails, report both the original failure and the deletion failure; do not continue to create
- a create-by-event failure does not justify exposing `source.local_path` to a platform Tool or switching delivery mode; stop with the event evidence and apply the normal attempt budget

### Compatibility Boundary

The legacy server-local tools `rainbond_upload_package_file` and `rainbond_create_component_from_local_package` remain compatibility-only server interfaces. They are not RainSkills execution options because their filesystem view is the platform server's, not the user's client workspace. RainSkills always uses the local helper plus the event-based Rainbond Tool sequence above.

If `source.local_path` cannot be resolved safely:
- mark the package component as `needs-confirmation`
- do not guess a different path

If the local helper reports that the path does not exist or is unsafe:
- resolve the path once from the current project process and correct only an objective relative-path resolution error
- otherwise classify the issue as a local package preparation blocker and stop
- do not pivot to local Docker, image push, or a server-local compatibility tool without explicit user confirmation
