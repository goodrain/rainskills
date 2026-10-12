# Source topology and build rules

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
1. **Add the dependency edge** — `rainbond_manage_component_dependency(operation=add)` from the consumer to the provider (this is the same mandatory wiring as [creation rules](30-creation-rules.md)).
2. **Render the connection from dependency injection** — when a provider component has an enabled inner port, the platform auto-generates two `outer`-scope envs **on the provider**: `{ALIAS}_HOST` and `{ALIAS}_PORT` (the alias defaults to a `{UPPER_SERVICE_ALIAS}{PORT}` form such as `GR186CA1_5432`; read the provider's env list for the exact name). The dependency edge then **injects** the provider's `outer`/`both`-scope envs into the consumer container. So:
   - **Prefer consuming the injected variables directly.** If the application can read `{ALIAS}_HOST` / `{ALIAS}_PORT`, point it at those — no host literal is written at all.
   - **If the application requires a fixed variable name** (e.g. it hard-reads `DB_HOST`), first read the provider's auto-generated `{ALIAS}_HOST` env value (its **k8s service internal domain**) and put that value into the consumer's fixed variable.
   - **Forbidden:** writing a compose service name into the host. **Also forbidden:** unconditionally hard-coding `127.0.0.1`. `{ALIAS}_HOST` resolves to `127.0.0.1` **only** under the `BUILD_IN_SERVICE_MESH` governance mode; the default (kubernetes-native service) governance mode resolves it to the port's k8s service internal domain, so a blanket `127.0.0.1` is wrong outside built-in mesh.

dify-derived examples (❌ as the LLM copied from compose → ✅ after wiring the dependency edge and rendering from injection):
- `DB_HOST=db_postgres` ❌ → add dep api→db_postgres, then either let api read the injected `{ALIAS}_HOST`, or `DB_HOST=<provider's auto-generated {ALIAS}_HOST value, i.e. the db's k8s service internal domain>` ✅
- `REDIS_HOST=redis` ❌ → add dep api→redis, then `REDIS_HOST=<redis provider's injected {ALIAS}_HOST value>` ✅
- `SANDBOX_API_URL=http://sandbox:8194` ❌ → add dep api→sandbox, then `SANDBOX_API_URL=http://<sandbox provider's injected {ALIAS}_HOST value>:8194` ✅

This extends [creation rules](30-creation-rules.md) (connection contracts live on the provider) to the compose case explicitly — it does not contradict it. The provider still owns the connection contract; what this rule adds is "the compose service name is never the host, and the host comes from dependency injection (the provider's `{ALIAS}_HOST` internal domain), not a hard-coded `127.0.0.1`."

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
