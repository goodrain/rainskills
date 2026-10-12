# Creation rules: runtime topology

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
- `rainbond_create_component_from_image` and `rainbond_create_component_from_source` do **not** expose `extend_method` as a parameter. Components created via these tools are stateless by default, and the platform exposes **no Rainbond Tool to convert stateless → stateful in place**.
- Therefore: **image-mode / source-mode component creation always produces a stateless component**, regardless of whether the service is genuinely stateful.

**Persistence strategy for stateful services created via image/source mode**:
- Use `volume_type = share-file` (RWX shared file storage — works on stateless components). Mount it at the service's documented data directory.
- Do **not** attempt `volume_type = local` — Rainbond rejects this on stateless components with HTTP 400 (`数据中心操作故障 应用类型为'无状态'.不支持本地存储`). See "Volume type ↔ component type compatibility" below.
- This gives durable persistence (survives pod restart, container rebuild) but is file-backed not block-backed. For most workloads (analytics DBs, doc stores, queues, search) this is acceptable. For IOPS-critical workloads (high-throughput OLTP), see the template-install path below.

**Persistence strategy when stateful + local volume is genuinely required**:
- Path: **template install** via `rainbond_install_app_model` from the app market. Market templates can be pre-configured as stateful with local volumes.
- Image-mode creation cannot reach a stateful component on the current Rainbond Tool surface.
- If the user explicitly needs `local` (block-backed) persistence and no template exists, report this as a delivery-mode limitation, not as a step the bootstrap can silently work around.

**Rules**:
- inspect existing component storage before deploying the stateful-service component
- if no durable storage is already mounted at the data directory, use `rainbond_manage_component_storage(operation=create_volume, volume_name=<short-name>, volume_type=share-file, volume_path=<data-dir>)` **before** `rainbond_operate_app(action=deploy)`
- prefer the smallest durable storage binding accepted by the platform; do not invent a storage class, PVC name, host path, reclaim policy, or data-retention guarantee
- if the storage Tool call fails or the platform does not expose a usable storage provider, do not silently ignore it; report missing persistence as a bootstrap caveat or blocker depending on user intent
- if no stateful service component is present, no persistence check is required
- if a cache component is explicitly configured as ephemeral and user intent is clearly disposable (e.g., user said "just for testing" or `--ephemeral`), it may run without durable storage, but this must be reported as an intentional ephemeral caveat
- demo bootstrap may continue without persistence only when user intent is clearly ephemeral, or when storage creation is blocked and the caveat is explicitly reported
- do not invent storage classes, PVC names, host paths, or data-retention guarantees

### Volume type ↔ component type compatibility

Rainbond rejects `volume_type = local` on stateless components with HTTP 400:
> 数据中心操作故障 应用类型为'无状态'.不支持本地存储

Rules:
- `local` volume_type requires the component to be stateful (`extend_method = state`); it cannot be attached to a stateless component, and the platform exposes no Rainbond Tool to convert a stateless component into stateful in place
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
- do not trust it over current platform runtime facts

If local mapping and current platform evidence disagree:
- trust current platform runtime facts
- report drift
- keep going with runtime components discovered through Rainbond Tools

## 10. Transport proxy policy

Apply `../SKILL.md` **Always-on Guardrail 7** exactly; it is the only proxy policy.

- Bare or explicit Docker Hub references use the canonical `docker.1ms.run` mapping automatically unless the user explicitly opted out or supplied another proxy.
- Other public registries use the original URL first. Ask for a proxy only after an observed pull failure.
- Private registries and already-mirrored URLs pass through unchanged.
- Never derive mappings such as `docker.1ms.run/quay.io/...`; proxy URLs are closed-list facts.
- This module only evaluates the explicit `image` field. Source-build pull failures follow the source blocker path.

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

When calling `rainbond_manage_component_ports`, use the `ports` array form to fold multiple single-port calls into a single Rainbond Tool call. The goal is to cut tool-call count and avoid partial-state windows where some ports are already created or enabled while others are still pending.

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

Read [source rules](40-source-rules.md), [source topology](42-source-topology.md), [source build rules](44-source-build-rules.md), or [package rules](45-package-rules.md) only for the active delivery branch:
- source-kind preservation
- source-ref preservation
- GitHub proxy prompting
- source build parameter routing
- package upload flow
