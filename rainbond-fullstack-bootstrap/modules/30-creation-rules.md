# Creation rules: component creation

- Read when: you are about to create, reuse, configure, or deploy app components inside bootstrap.
- Do not read when: you only need source/package-specific routing or output formatting.
- Depends on: [../SKILL.md](../SKILL.md), [10-context-loading.md](10-context-loading.md), [20-scope-and-boundaries.md](20-scope-and-boundaries.md).
- Produces: the general bootstrap execution strategy for app creation, reuse, minimum topology, and subset handling.
- Proxy behavior always defers to **Always-on Guardrail 7** in the entrypoint; this module must not define another mirror policy.
- Never derive `docker.1ms.run/quay.io` or another cross-registry mirror by prefix substitution.

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

## 2a. Configure image components before their first deployment

Call `rainbond_create_component_from_image` with `is_deploy=false`. Reuse the returned `service_id`, configure the component's required ports, envs, dependencies, storage, config files, and probes, then trigger exactly one deployment with `rainbond_operate_app(action=deploy, service_ids=[<service_id>])`.

Do not accept the Console default `is_deploy=true` and then deploy the same component again after configuration. If an existing component was already deployed successfully, port and outer-access changes synchronize through the Console/Region APIs; do not rebuild it merely to apply those changes.

## 2b. Deployment-plan readiness for multi-component image topologies

Before any mutating Rainbond Tool call for a multi-component image deployment, build a short `DeploymentPlanReadiness` mentally and stop if it is not ready.

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

This gate also applies when adding one image-backed component to an existing app if the result is multi-component. Existing runtime proves which components exist, but it does not prove that the only existing component consumes the new provider. A generic request to “create related dependencies” does not establish an edge. Accept the consumer/provider relation only from manifest or Compose topology, env/config references, project documentation, runtime evidence, or explicit user confirmation. If no source identifies the consumer, ask once and perform no mutating call before the answer.

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

Only when the user explicitly identifies the target as demo, disposable, or ephemeral may bootstrap generate a high-entropy temporary secret. Fixed or reused demo passwords are forbidden. In every other scenario, a missing required secret source is a hard stop; ask for explicit input or `.rainbond/secrets.<environment>.json` before any mutating call that needs the secret.

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
- keep database root/admin credentials private to provider initialization; never publish them through provider connection envs. When a consumer needs database credentials, use a separate least-privilege application account supplied by the explicit secret source.
- **compose case:** a compose service name (`db_postgres`, `redis`, `sandbox`, …) is NOT a hostname after the topology lands in Rainbond — it does not resolve, and names with underscores are not even valid DNS labels. Never copy a compose service name into a consumer `*_HOST` / `*_URL` / `*_ADDR` env. Add the dependency edge, then render the host from dependency injection — consume the provider's auto-generated `{ALIAS}_HOST` (its k8s service internal domain), not a hard-coded `127.0.0.1` (that holds only under built-in-mesh governance). Full rule with examples: [source topology](42-source-topology.md).

Typical examples:
- MySQL provider exposes a normalized port alias such as `MYSQL` or `DATABASE` plus connection envs such as `DB_USER`, `DB_PASS`, and `DB_NAME`
- Redis provider exposes `REDIS_PASSWORD` or `REDIS_DB` when applicable
- Kafka provider exposes `KAFKA_BROKERS`, `KAFKA_USERNAME`, or `KAFKA_PASSWORD` when applicable

Consumer-specific runtime envs are still allowed only for values that are genuinely local to that consumer. Secrets must come from explicit input or `.rainbond/secrets.<environment>.json`; never print secret values.
