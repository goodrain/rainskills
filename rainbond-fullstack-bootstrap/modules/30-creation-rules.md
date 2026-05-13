# Creation Rules

- Read when: you are about to create, reuse, configure, or deploy app components inside bootstrap.
- Do not read when: you only need source/package-specific routing or output formatting.
- Depends on: [../SKILL.md](../SKILL.md), [10-context-loading.md](10-context-loading.md), [20-scope-and-boundaries.md](20-scope-and-boundaries.md).
- Produces: the general bootstrap execution strategy for app creation, reuse, minimum topology, and subset handling.

## 1. Be idempotent

Always check whether the app or component already exists before creating it.

If a resource already exists:
- reuse it
- report that it was reused
- do not create duplicates

## 2. Prefer minimum viable setup

Create only what is needed to establish the topology:
- app
- executable components from manifest
- minimum ports
- provider-side connection information
- minimum dependencies
- minimum database bootstrap env
- frontend env only if `access_mode` is explicitly declared

Do not try to solve every runtime problem inside this skill.

## 3. Database bootstrap is allowed

Unlike the troubleshooter skill, bootstrap may add the minimum startup env required for the database image to initialize successfully.

Examples of the kind of settings this refers to:
- `POSTGRES_PASSWORD`
- `POSTGRES_USER`
- `POSTGRES_DB`

Preferred source for sensitive values:
- user explicit input for the current run
- otherwise `.rainbond/secrets.<environment>.json`

When the scenario is clearly a demo bootstrap and the user did not provide secrets, safe demo defaults are still acceptable. Do not guess beyond that boundary.

Do not require secrets to exist in `rainbond.app.json`, and do not print secret values in plaintext.

## 4. Middleware connection contracts live on the provider component

For database and middleware provider components such as MySQL, PostgreSQL, Redis, Kafka, RabbitMQ, MongoDB, and similar services, treat connection information as a provider-side contract.

Rules:
- use `rainbond_manage_component_ports(operation=update_alias)` to normalize provider port aliases when a manifest or clear convention provides a stable alias
- use `rainbond_manage_component_connection_envs` to create or update connection envs exposed by the provider component
- then use `rainbond_manage_component_dependency(operation=add)` to connect consumers to the provider
- treat this dependency call as mandatory topology wiring whenever a provider/consumer relation is accepted; do not substitute hard-coded service hostnames, Nginx upstreams, or consumer runtime envs for the Rainbond explicit dependency edge
- if the dependency target lacks an enabled inner port, use the dependency tool's `open_inner` flow with the target `container_port`, or first open the target inner port and retry
- when a relationship is already reachable by Kubernetes/Rainbond DNS but is not visible in Rainbond dependencies, still add the explicit dependency edge so the console topology and connection-env injection are correct
- do not put provider connection values such as `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASS`, `REDIS_PASSWORD`, `KAFKA_BROKERS`, or similar values directly on each consumer when the same value belongs to the provider contract
- do not use `rainbond_manage_component_envs(scope=outer)` for connection information; that path belongs to `rainbond_manage_component_connection_envs`

Typical examples:
- MySQL provider exposes a normalized port alias such as `MYSQL` or `DATABASE` plus connection envs such as `DB_USER`, `DB_PASS`, and `DB_NAME`
- Redis provider exposes `REDIS_PASSWORD` or `REDIS_DB` when applicable
- Kafka provider exposes `KAFKA_BROKERS`, `KAFKA_USERNAME`, or `KAFKA_PASSWORD` when applicable

Consumer-specific runtime envs are still allowed only for values that are genuinely local to that consumer. Secrets must come from explicit input or `.rainbond/secrets.<environment>.json`; never print secret values.

## 5. Stateful middleware persistence must be visible

For database, cache, broker, queue, search, and similar stateful middleware components, check whether the manifest, image convention, role, or repository evidence carries a persistence requirement.

Common middleware data directories:
- MySQL / MariaDB: `/var/lib/mysql`
- Postgres: `/var/lib/postgresql/data`
- MongoDB: `/data/db`
- Redis: `/data`
- RabbitMQ: `/var/lib/rabbitmq`
- Kafka: `/var/lib/kafka/data`
- Elasticsearch / OpenSearch: `/usr/share/elasticsearch/data`
- MinIO: `/data`

Rules:
- for stateful middleware components whose image, role, or component name identifies one of the standard data directories above, treat persistence as required for a normal Rainbond bootstrap
- inspect existing component storage before deploying the middleware component
- if no durable storage is already mounted at the middleware data directory, use `rainbond_manage_component_storage` to create or reuse a component volume and mount it at that directory before deploying the component
- prefer the smallest durable storage binding accepted by the platform; do not invent a storage class, PVC name, host path, reclaim policy, or data-retention guarantee
- if the storage MCP call fails or the platform does not expose a usable storage provider, do not silently ignore it; report missing middleware persistence as a bootstrap caveat or blocker depending on user intent
- if no stateful middleware component is present, no persistence check is required
- if a cache component is explicitly configured as ephemeral and the user intent is clearly disposable, it may run without durable storage, but this must be reported as an intentional ephemeral caveat
- demo bootstrap may continue only when the user intent is clearly ephemeral or when storage creation is blocked and the caveat is explicitly reported
- do not invent storage classes, PVC names, host paths, or data-retention guarantees

### Volume type ↔ component type compatibility

Rainbond rejects `volume_type = local` on stateless components with HTTP 400:
> 数据中心操作故障 应用类型为'无状态'.不支持本地存储

Rules:
- `local` volume_type requires the component to be stateful (`extend_method = state`); it cannot be attached to a stateless component, and the platform exposes no MCP tool to convert a stateless component into stateful in place
- for stateless components that need persistence, use `share-file` (RWX shared file) or `config-file` (small text payload) volume_type instead of `local`
- for genuine stateful middleware (mysql, postgres, mongodb, redis when persisted, etc.), the component must be created as stateful from the start; verify component type before issuing `create_volume` with `local`
- when a stateful middleware component arrives via app-market template install, the template usually pre-configures storage; do **not** layer an extra manual `create_volume` on top — first inspect existing storage and only add what's missing
- if `rainbond_manage_component_storage` returns the 400 above, treat it as deterministic: do not retry the same call; report it as a component-type blocker and offer the user three options: (a) recreate the component as stateful, (b) switch to `share-file` / `config-file`, (c) accept ephemeral storage

## 6. File-backed config and secret mounts

When creating or repairing file-backed config/secret mounts, Rainbond mount path and config filename are separate concepts.

Rules:
- treat the configured mount path as a directory unless current platform evidence proves it is a file path
- when `config_name` or equivalent filename is present, the application-readable file path is usually `<mount_dir>/<config_name>`
- set app envs that point to file secrets/configs to the resolved file path, not only the mount directory
- do not create repeated alternate mounts just to guess a path; inspect the mount metadata and adjust the consuming env once
- never print the file content when the file may contain a secret

## 7. Frontend `access_mode` must be explicit

If `frontend.access_mode` is **not specified** in config or by user:
- create all resources
- but always return that handoff is needed for frontend validation
- do not declare `setup complete`

If `frontend.access_mode` **is specified**:
- set only the minimum frontend env required by that mode
- for `reverse-proxy`: set `VITE_API_URL=/api`
- for `runtime-env`: set the minimum runtime env required by that mode
- for `build-time-env`: note that build-time config is outside bootstrap scope

## 8. Do not over-repair

Bootstrap may:
- create resources
- wire dependencies
- make minimum startup config valid

Bootstrap should **not**:
- deeply debug failed application logic
- repeatedly patch env incompatibilities
- repair frontend runtime access-path problems
- fix reverse proxy or build-time frontend configuration problems

When setup reaches the first deeper runtime issue, stop and hand off.

## 9. Treat runtime component mapping as a hint, not as truth

If `.rainbond/local.json.runtime_components` exists:
- use it to help align logical roles to already-existing runtime components
- use it to decide whether reuse is plausible
- do not trust it over MCP runtime facts

If local mapping and MCP disagree:
- trust MCP
- report drift
- keep going with MCP-discovered runtime components

## 10. Allow component subset execution

When the run provides:
- `included_components`
- or `excluded_components`

apply bootstrap only to the filtered component set.

Rules:
- `included_components` wins over `excluded_components`
- template-backed components may still appear in the manifest, but should be skipped
- skipped components must be listed clearly in output

## What This Module Does Not Cover

This module is intentionally general.

Read [40-source-and-package-rules.md](40-source-and-package-rules.md) for:
- source-kind preservation
- source-ref preservation
- GitHub proxy prompting
- source build parameter routing
- package upload flow
