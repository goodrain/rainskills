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

## 2a. Deployment-plan readiness for multi-component image topologies

Before any mutating MCP call for a multi-component image deployment, build a short `DeploymentPlanReadiness` mentally and stop if it is not ready.

This gate applies when:
- the planned topology has more than one component
- the user supplied only a product/software name, not a concrete descriptor
- the plan contains image-backed components whose relationship is being inferred
- the product is a complex off-the-shelf suite such as Harbor, GitLab, a monitoring/observability stack, or any product normally deployed as coordinated services

Accepted evidence provenance for critical fields:
- `rainbond_template`: Rainbond app market/template selected by user or tool evidence
- `rainbond.app.json`: repository manifest with component topology
- `compose_profile`: `docker-compose.yml`, `compose.yaml`, or `rainbond_get_project_source_profile` output whose `topologySource` is compose and whose `services[]` carry image/build/ports/depends_on/env/volume evidence
- `official_descriptor`: official deployment descriptor supplied by the user or tool context, such as a vendor compose/Helm-derived service plan
- `existing_runtime`: components and edges already present in the Rainbond app
- `user_confirmed_plan`: the assistant presented a concrete plan and the user explicitly approved it in the current conversation

Fields that need provenance before writing:
- service list and one-to-one mapping to Rainbond components
- dependency edges between services
- required runtime env keys and secret sources
- container ports and which ports are internal or externally exposed
- durable storage paths for stateful components
- image references and tags, including registry/mirror choice
- product-level settings such as external URL, domain, TLS mode, admin/bootstrap password source, scanner/worker enablement, and retention/storage assumptions

Readiness decision:
- `ready`: every critical field has accepted provenance; continue with component creation and record the provenance in the final report
- `needs_user_confirmation`: a complete proposed plan exists, but one or more critical fields come from assistant inference; ask the user to confirm the plan before any create/update/dependency/env/storage call
- `blocked_missing_descriptor`: no descriptor/template/manifest/compose evidence exists; ask the user to provide or choose one before creating components

Do not downgrade this gate to a warning for production-like deployments. Inference-only service lists, dependencies, required env, or storage paths are blockers because an apparently successful multi-component creation can encode the wrong product topology.

### Complex suite examples

Harbor is a complex suite, not a simple `harbor:latest` single-image component. If the user says "deploy Harbor" and no Rainbond template, `rainbond.app.json`, compose profile, official descriptor, or explicit user-confirmed plan is available, stop and ask for one. Do not create `core`, `portal`, `registry`, `jobservice`, `database`, `redis`, `proxy`, scanner, or similar components from model knowledge alone.

GitLab and monitoring stacks follow the same rule: prefer a Rainbond template or official descriptor; otherwise present a plan for confirmation before writing.

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

## 5. Stateful service persistence must be visible

**Trigger (principle, not a closed list)**: any component that is a **stateful service — one whose data must survive container restart — requires persistence**. Use general knowledge to identify these. Categories include but are not exhaustive:
- Relational databases (MySQL, MariaDB, Postgres, CockroachDB, TiDB, …)
- NoSQL / document / key-value stores (MongoDB, Redis when persisted, etcd, Cassandra, ScyllaDB, DynamoDB-local, FoundationDB, …)
- Time-series / analytics databases (ClickHouse, InfluxDB, TimescaleDB, QuestDB, VictoriaMetrics, Druid, Pinot, …)
- Search engines (Elasticsearch, OpenSearch, Solr, Meilisearch, Typesense, …)
- Message queues / brokers with durable storage (RabbitMQ, Kafka, Pulsar, NATS-JetStream, …)
- Graph / vector / specialised stores (Neo4j, ArangoDB, Dgraph, Milvus, Qdrant, Weaviate, Chroma, …)
- Object stores / blob stores (MinIO, SeaweedFS, Garage, …)
- Workflow / state engines that persist state to disk (Temporal-server backed by SQLite, Airflow metadata DB, …)

The list illustrates the breadth; it is not exhaustive. For any service in your knowledge that follows the same pattern (data on disk that must survive restart), apply this rule.

**Data directory (fact — must be correct, not invented)**: use the **documented data directory for the specific image**. Common examples:
- MySQL / MariaDB: `/var/lib/mysql`
- Postgres: `/var/lib/postgresql/data`
- MongoDB: `/data/db`
- Redis: `/data`
- RabbitMQ: `/var/lib/rabbitmq`
- Kafka: `/var/lib/kafka/data` (Apache Kafka image) or `/bitnami/kafka` (Bitnami)
- Elasticsearch / OpenSearch: `/usr/share/elasticsearch/data`
- MinIO: `/data`
- ClickHouse: `/var/lib/clickhouse`
- Cassandra: `/var/lib/cassandra`
- InfluxDB: `/var/lib/influxdb2` (v2) or `/var/lib/influxdb` (v1)
- Neo4j: `/data`
- Milvus: `/var/lib/milvus`
- Qdrant: `/qdrant/storage`

For services not in this list, recall the documented data directory from the image's official documentation, state your assumption in the report, and invite the user to correct it. If genuinely unsure (rare image, conflicting variants), ask the user.

**Platform reality (fact, must be remembered)**:
- `rainbond_create_component_from_image` and `rainbond_create_component_from_source` do **not** expose `extend_method` as a parameter. Components created via these tools are stateless by default, and the platform exposes **no MCP tool to convert stateless → stateful in place**.
- Therefore: **image-mode / source-mode component creation always produces a stateless component**, regardless of whether the service is genuinely stateful.

**Persistence strategy for stateful services created via image/source mode**:
- Use `volume_type = share-file` (RWX shared file storage — works on stateless components). Mount it at the service's documented data directory.
- Do **not** attempt `volume_type = local` — Rainbond rejects this on stateless components with HTTP 400 (`数据中心操作故障 应用类型为'无状态'.不支持本地存储`). See "Volume type ↔ component type compatibility" below.
- This gives durable persistence (survives pod restart, container rebuild) but is file-backed not block-backed. For most workloads (analytics DBs, doc stores, queues, search) this is acceptable. For IOPS-critical workloads (high-throughput OLTP), see the template-install path below.

**Persistence strategy when stateful + local volume is genuinely required**:
- Path: **template install** via `rainbond_install_app_model` from the app market. Market templates can be pre-configured as stateful with local volumes.
- Image-mode creation cannot reach a stateful component on the current MCP surface.
- If the user explicitly needs `local` (block-backed) persistence and no template exists, report this as a delivery-mode limitation, not as a step the bootstrap can silently work around.

**Rules**:
- inspect existing component storage before deploying the stateful-service component
- if no durable storage is already mounted at the data directory, use `rainbond_manage_component_storage(operation=create_volume, volume_type=share-file, volume_path=<data-dir>)` **before** `rainbond_operate_app(action=deploy)`
- prefer the smallest durable storage binding accepted by the platform; do not invent a storage class, PVC name, host path, reclaim policy, or data-retention guarantee
- if the storage MCP call fails or the platform does not expose a usable storage provider, do not silently ignore it; report missing persistence as a bootstrap caveat or blocker depending on user intent
- if no stateful service component is present, no persistence check is required
- if a cache component is explicitly configured as ephemeral and user intent is clearly disposable (e.g., user said "just for testing" or `--ephemeral`), it may run without durable storage, but this must be reported as an intentional ephemeral caveat
- demo bootstrap may continue without persistence only when user intent is clearly ephemeral, or when storage creation is blocked and the caveat is explicitly reported
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

## 10. Image Registry Proxy Prompt

For any in-scope image-backed component, before calling component creation, evaluate the `image` field against the public-registry list below and ask the user once whether to keep the raw image or switch to a mirror. This is a creation-time prompt, not a post-failure recovery step — the goal is to avoid the "create → wait for build/pull → fails → read logs → finally suggest a mirror" cycle.

### What counts as "raw public registry"

Trigger when **any** of the following matches the `image` value:

1. **Bare Docker Hub references** (no registry hostname at all):
   - `<image>:<tag>` such as `nginx:latest`, `redis:7-alpine`
   - `<org>/<image>:<tag>` such as `library/nginx:latest`, `mysql/mysql-server:8.0`, `bitnami/postgresql:16`
   - These implicitly resolve to `docker.io/library/<image>:<tag>` or `docker.io/<org>/<image>:<tag>` respectively, and must be treated the same as explicit `docker.io/...`.

2. **Explicit public-registry prefixes**:
   - `docker.io/...`
   - `quay.io/...`
   - `gcr.io/...`
   - `ghcr.io/...`
   - `k8s.gcr.io/...`
   - `registry.k8s.io/...`

Do **not** trigger when the image is already on a known registry mirror or on a private registry (i.e. a hostname that is neither in the public list above nor a bare Docker Hub reference):
- known mirrors include `docker.1ms.run/...`, `m.daocloud.io/...`, `dockerhub.azk8s.cn/...`, `mirror.gcr.io/...`, and any host the manifest or user has already chosen for this run
- private hostnames such as `harbor.example.internal/...`, `registry.cn-hangzhou.aliyuncs.com/<your-namespace>/...`, or `<corp-registry>:5000/...` are assumed reachable and untouched

Also skip when the user already opted out of a mirror earlier in the same run.

### Prompt content

- ask once whether to keep the raw image reference or switch to a registry mirror
- recommend `docker.1ms.run/<full-path>` first; treat it as the default Docker mirror across this skill
  - for bare Docker Hub refs, expand to the full path first: `nginx:latest` → `docker.1ms.run/library/nginx:latest`
  - for explicit registry refs, preserve the registry segment: `docker.io/library/postgres:17` → `docker.1ms.run/library/postgres:17`, `quay.io/foo/bar:1` → `docker.1ms.run/quay.io/foo/bar:1`
- `m.daocloud.io/<full-path>` may be offered as an explicit alternate choice (e.g. `m.daocloud.io/docker.io/library/postgres:17`)
- do **not** propose less-established mirrors (e.g. `dockerpull.com`, vendor-specific community proxies) unless the user explicitly asks for them
- if another in-scope component or the existing `rainbond.app.json` already uses a specific mirror, reuse the same mirror instead of introducing a second one

### Scope and reuse

- treat this as a **one-time prompt per bootstrap run**: once the user picks "use mirror" or "keep raw" for the first matching image, apply the same choice to every remaining matching image in the same run without re-asking
- the mirror is a transport hint only; it does not change `execution_mode` or delivery mode, and is not a fallback signal
- if the user explicitly opts out, proceed with the raw image but record the opt-out in `actions_taken` so that a subsequent pull failure can be classified correctly as `external artifact unreachable` rather than as a missed prompt

### Boundary

- this rule only inspects the explicit `image` field; it does not try to predict which base images a source-backed Dockerfile or Buildpack will pull. Source-backed pulls that fail at build time still flow through the `external artifact unreachable` blocker bucket described in [40-source-and-package-rules.md](40-source-and-package-rules.md).

## 11. Allow component subset execution

When the run provides:
- `included_components`
- or `excluded_components`

apply bootstrap only to the filtered component set.

Rules:
- `included_components` wins over `excluded_components`
- template-backed components may still appear in the manifest, but should be skipped
- skipped components must be listed clearly in output

## 12. Prefer batch port operations

When calling `rainbond_manage_component_ports`, use the `ports` array form to fold multiple single-port calls into a single MCP call. The goal is to cut tool-call count and avoid partial-state windows where some ports are already created or enabled while others are still pending.

### Batch create (operation=add)

When the same component needs multiple ports, send one `add` call with the full list:

```
{
  "operation": "add",
  "ports": [
    {"port": 80,   "protocol": "http", "enable_inner": true},
    {"port": 8080, "protocol": "tcp"},
    {"port": 9090, "protocol": "http"}
  ]
}
```

### Batch enable inner / outer

When the same operation applies to multiple ports of the same component, send one call with `ports`:

```
{ "operation": "enable_inner", "ports": [{"port": 80}, {"port": 8080}] }
{ "operation": "enable_outer", "ports": [80, 443] }   // integer list also accepted
```

### Decision rule

- ≥2 ports on the same component with the same operation → MUST use `ports`
- single port → keep the original `port` field
- when both `ports` and `port` are provided, `ports` wins

### Caveats

- `enable_outer` requires inner already enabled on each target port; if not, batch `enable_inner` first, then batch `enable_outer` in a second call
- `enable_outer_only` does **not** support batching — call once per port
- `update_alias` (the provider port alias normalization from §4) is per-port today — do not try to batch it

## What This Module Does Not Cover

This module is intentionally general.

Read [40-source-and-package-rules.md](40-source-and-package-rules.md) for:
- source-kind preservation
- source-ref preservation
- GitHub proxy prompting
- source build parameter routing
- package upload flow
