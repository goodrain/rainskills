# Project initialization and manifest rules

## Contents

- Use and scope
- Manifest output modes
- Delivery source handling
- Execution summaries and initialization modes
- Configuration priority
- Repository and source inference
- Generated manifest rules
- Local binding rules

## When to Use

Use when:
- a local project should be connected to Rainbond for the first time
- `.rainbond/local.json` does not exist
- `rainbond.app.json` may not exist yet
- the user wants to bring a brand-new local project into Rainbond
- the next step is unclear because the project has not been onboarded yet

Do not use when:
- the project is already linked and the user wants routine deploy or repair operations
- the topology already exists and only runtime troubleshooting is needed
- the task is to repair code or build artifacts
- the user explicitly wants only environment sync, bootstrap, or troubleshooting

## Scope

This skill may:
- inspect the local repository structure
- read project files such as:
  - `package.json`
  - `Dockerfile`
  - `docker-compose.yml`
  - `README.md`
  - `frontend/`
  - `backend/`
- infer likely component roles
- infer likely component delivery sources
- generate a first-draft `rainbond.app.json`
- query Rainbond for existing app matches
- create a new Rainbond app if needed
- write `.rainbond/local.json`
- optionally hand off immediately to `rainbond-fullstack-bootstrap`

This skill must not:
- scan outside the current project directory for `rainbond.app.json`, `.rainbond/local.json`, or other binding files
- search the user's home directory to locate other Rainbond projects or bindings
- deeply troubleshoot runtime failures
- modify application source code
- repair frontend build or reverse-proxy issues
- store secrets in project config
- guess destructive actions

## Manifest Output Modes

### Default mode: executable v1 manifest
By default, when generating `rainbond.app.json`, produce a manifest that the current validated execution chain can consume immediately.

This means:
- `schema_version: 1`
- top-level `image` for image-backed components
- top-level source execution inputs for source-backed components when they can already be mapped safely
- `env` as an object map
- roles and fields compatible with `rainbond-fullstack-bootstrap`

Use this mode unless the user explicitly asks for a v2 draft.

### Optional mode: v2 draft manifest
If the user explicitly asks for a v2 draft, architecture draft, or multi-source manifest:
- generate `schema_version: 2`
- allow per-component `source.kind`
- prefer `image` and `source`
- allow `template` only as a reserved schema option, not an executable default

When generating a v2 draft:
- clearly state it is a design-layer manifest
- do not imply the current bootstrap skill will execute every source kind directly
- if needed, recommend converting the v2 draft into a current executable plan

## Delivery Source Handling

This skill may internally infer whether a component is best understood as:
- image-based
- source-oriented
- template-like infrastructure

However, for the current validated workflow, the generated `rainbond.app.json` must default to a **bootstrap-compatible schema v1**:
- `schema_version: 1`
- component image stored at top-level `image` for image-backed components
- source-backed components may instead use top-level executable source fields when they are safely inferable:
  - `code_from`
  - `git_url`
  - `code_version`
  - `subdirectories`
- component env stored as an object map
- no `source.kind` block by default

If the repository strongly suggests a future `source` or `template` workflow, record that in `Open Questions` or `Follow-up Advice` rather than generating a schema that the current bootstrap skill cannot consume.

Current execution support:
- `image`: supported
- `source`: supported at the design layer and intended to map to Rainbond source-creation flow
- `template`: supported when template install metadata is complete enough to drive the current platform install flow

## Execution Summary Rules

After resolving or generating a manifest, produce an execution summary for each component.

The execution summary should classify each component into:
- `execution_mode`
- `status`
- `blocking_reason` if needed

### Execution modes
- `image`
- `source`
- `template`
- `blocked`

### Status values
- `ready`
- `needs_confirmation`
- `blocked`

### Current mapping rules

#### `image`
Use when the component has a stable top-level `image` value.

Result:
- `execution_mode = image`
- `status = ready` only when the image reference is concrete and there is no known missing prerequisite for execution
- otherwise `needs_confirmation`

Typical reasons for `needs_confirmation` even with `execution_mode = image`:
- image existence in the target registry is not yet verified
- a required startup secret is known to be missing
- a required bootstrap env source is still unresolved

#### `source`
Use when the component is clearly business code and there is enough Git information to map it into a source creation flow.

Result:
- `execution_mode = source`
- `status = ready` if repo source is complete and `code_from` can be determined safely
- otherwise `needs_confirmation`

#### `template`
Use when the resolved execution path is template-backed, including default mode when explicit template metadata or a curated middleware mapping makes template the preferred execution strategy.

Current rule:
- `template` is a valid schema concept
- template execution is supported only when install metadata is complete
- required fields depend on template source:
  - `install.source` must be `local` or `cloud`
  - `install.app_model_id` is required
  - `install.app_model_version` is required
  - `install.market_name` is required when `install.source = cloud`

Result:
- `execution_mode = template`
- `status = ready` if template install metadata is complete
- otherwise `needs_confirmation`
- if a template source is chosen but mandatory install metadata is missing, include a `blocking_reason`

#### `blocked`
Use when execution cannot safely continue with the current information.

Examples:
- required Git source metadata is missing
- team or region is still unknown
- template execution was chosen but required install metadata could not be resolved safely

## Initialization Modes

### Mode A: Manifest exists
If `rainbond.app.json` exists:
- use it as the project topology baseline
- do not regenerate it
- proceed directly to link / create app / write local binding

### Mode B: Manifest missing
If `rainbond.app.json` does not exist:
- inspect the repository
- infer a draft topology
- generate a first-draft manifest in the requested output mode
- ask for minimal confirmation only if critical fields remain ambiguous
- then proceed to linking

## Configuration Priority

During initialization, resolve values in this order:

1. **Highest priority**: user explicit input
2. existing `.rainbond/local.json` if present
3. existing `rainbond.app.json` if present
4. repository inference from source tree and config files

Rules:
- if `rainbond.app.json` exists, prefer it over repository inference
- if `.rainbond/local.json` exists and is linked, do not recreate linking blindly
- if platform runtime facts later conflict with inferred topology, the inferred draft should be corrected
- selected environment may only be `preview` or `production`
- resolve selected environment in this order:
  - user explicit input
  - `.rainbond/local.json.preferences.default_environment`
  - default `preview`
- if the resolved value is anything other than `preview` or `production`, fall back to `preview`
- if `team_name` is not explicitly provided and no manifest value exists, query available teams first
- team selection follows hard rule 7 (smart default):
  - single accessible team → use silently
  - multiple accessible teams + manifest `team_name` matches one of them → use silently, mention `已选 team = X（来自 manifest）` in the report
  - multiple accessible teams, no manifest hint → ask the user directly; do not fall through to `default` / first / any existing team
- never silently invent `team_name`; if it cannot be resolved from explicit input, manifest, or a single unambiguous platform result, ask the user directly
- `team_name = default` is allowed only when it came from explicit user input or explicit user confirmation

## Repository Inference Rules

When `rainbond.app.json` is missing, inspect the repo conservatively.

Look for:
- frontend indicators:
  - `frontend/`
  - `docs/`
  - `docusaurus.config.*`
  - `vite.config.*`
  - React / Vue package metadata
  - static web Dockerfile
- backend/service indicators:
  - `backend/`
  - Express / FastAPI / Spring / Go service entrypoints
  - API-oriented Dockerfile
- database indicators:
  - `docker-compose.yml`
  - named volumes or bind mounts attached to database services
  - service names like `postgres`, `mysql`, `redis`
  - db image references
- worker/cache/broker indicators:
  - service names and image names
  - queue or cache packages
- dependency indicators:
  - Compose `depends_on`, `links`, shared networks, and service hostnames in env values
  - README or docs that tell the operator to configure one component to connect to another
  - service roles, image conventions, exposed internal ports, and well-known admin/consumer images
  - env names such as `DB_HOST`, `DATABASE_URL`, `REDIS_URL`, `KAFKA_BROKERS`, `*_HOST`, and `*_PORT`

Inference principles:
- prefer obvious structure
- avoid over-inference
- if uncertain, generate fewer components and mark ambiguity clearly
- do not invent secrets
- do not invent access modes without evidence
- if the repo is a valid Git repo with a usable remote, prefer source inference for obvious business code components
- treat transport hints such as Docker registry mirrors or Git proxy URLs as connectivity hints, not as permission to change the inferred source kind

Dependency inference rule:
- infer `depends_on` from explicit Compose fields when present
- also infer provider/consumer edges from strong cross-evidence in repository files, not only machine-readable Compose fields
- strong evidence includes README connection instructions, matching service hostnames in env/config, provider port references, image/service role pairs, or a UI/admin/worker/backend component whose primary purpose is to connect to a database, cache, broker, queue, search, or API provider
- common provider roles include database, cache, broker, queue, search, object storage, and backend/API components
- common consumer roles include backend/API services, workers, frontends/proxies, admin consoles, dashboards, migration jobs, and management UIs
- if a consumer can start without its provider, still record the dependency when the product workflow requires that provider connection for the app to be usable
- if the edge is plausible but not strongly supported, leave it out of `depends_on` and call it out in `Open Questions` instead of inventing topology

Compose persistence rule:
- when a `docker-compose.yml` service uses a named volume or bind mount for a database data directory, preserve that storage intent in the generated baseline or call it out in `Open Questions`
- common data directories include MySQL `/var/lib/mysql`, Postgres `/var/lib/postgresql/data`, MariaDB `/var/lib/mysql`, MongoDB `/data/db`, and Redis `/data`
- if a database image is inferred without a durable data mount and the compose file also lacks one, report "database persistence not configured" as an open question instead of silently treating it as production-ready
- do not invent a storage class, PVC name, or host path; record only the evidence-backed persistence requirement

Monorepo build-context rule:
- when a component Dockerfile or subdirectory build depends on root-level files such as `pyproject.toml`, `uv.lock`, `pnpm-lock.yaml`, `package-lock.json`, `bun.lock`, `go.work`, `settings.gradle`, or `pom.xml`, keep the repository root as the conceptual build context and record the component subdirectory separately
- do not infer a child-directory-only source if that would omit required root build metadata
- if the current platform source path cannot express the needed build context safely, mark that component `needs_confirmation` with a build-context reason instead of switching to local package or image fallback

## Source Inference Rules

When generating an executable manifest, infer the **current bootstrap input shape**, not a future schema.

Conservative defaults:
- for obvious business code components in a Git repo, prefer current executable `source` fields over image placeholders
- for docs/static site projects that are still clearly repository-backed business code, such as Docusaurus or docs sites with `docusaurus.config.*` or a substantial `docs/` tree, also prefer current executable `source` fields over a generic static image
- for standard infrastructure-like middleware components, prefer template when explicit template intent, complete template metadata, or a curated middleware-to-template mapping exists
- otherwise use image as the safe executable fallback for infrastructure-like components
- do not invent Git URLs
- do not invent template IDs, market names, or template versions
- if the repository strongly suggests a non-image flow, either:
  - note it as a follow-up item in default mode, or
  - generate it in v2 draft mode when explicitly requested

Current `code_from` mapping rules:
- generic Git or Gitee repositories -> `git`
- GitHub repositories -> `git` by default unless a more specific supported provider mode is explicitly required
- OAuth-backed repositories -> preserve or request the explicit `oauth_xxx` value

Transport hint rule:
- mirror hints such as `docker.1ms.run/...` or Git proxy URLs such as `https://ghfast.top/...` only change how an already-chosen image or Git source should be fetched
- they do **not** change `execution_mode`
- they do **not** justify replacing a source-backed component with a generic image-backed component

GitHub proxy prompt rule:
- if the inferred `git_url` is a raw `https://github.com/...` URL
- and the user did not explicitly provide a Git proxy URL
- and the URL is not already proxied through `https://ghfast.top/` or `https://gh.rainbond.cc/`
- ask once whether to keep the raw GitHub URL or switch to a proxy URL before writing the manifest
- recommend `https://ghfast.top/https://github.com/...` first
- `https://gh.rainbond.cc/https://github.com/...` may be offered as an alternate explicit choice

Docker registry proxy rule:
- if a referenced image is on `docker.io`, `quay.io`, `gcr.io`, `ghcr.io`, `k8s.gcr.io`, or `registry.k8s.io`
- and the image is not already proxied through a registry mirror
- and the user did not explicitly opt out of using a mirror
- prefer `docker.1ms.run/<original-path>` first; treat it as the default Docker mirror across this skill
- `m.daocloud.io/<original-path>` may be offered as an alternate explicit choice
- do **not** propose less-established mirrors (e.g. `dockerpull.com`, vendor-specific community proxies) unless the user explicitly asks for them
- if the project's existing `rainbond.app.json` (or another component in the same manifest) already uses a specific mirror, reuse the same mirror instead of introducing a second one
- this rule also applies when troubleshooting recommends switching to a reachable mirror after an image pull failure

## Generated Manifest Rules

This section is the installable on-demand reference for delivery-mode and ID-boundary rules once initialization reaches manifest generation.

If generating `rainbond.app.json` in default mode, produce a **bootstrap-compatible schema v1**:
- `schema_version: 1`
- `project.team_name`
- `project.region_name`
- `project.app_name`
- `components[]`

Each generated component should include only fields that can be justified:
- `name`
- `role`
- either:
  - top-level `image` when image-backed
  - or top-level source execution inputs when source-backed
- `port` if known
- `port_alias` if a stable provider alias can be justified
- `env` as an object map only when non-sensitive defaults are justified
- `connection_envs` on middleware provider components only when values can be justified without exposing secrets
- `depends_on` if clearly inferred
- `access_mode` only when strongly supported by repo structure
- storage intent only when the current manifest/tooling path can execute it; otherwise keep the component executable fields minimal and list persistence as an open question

Role defaults:
- obvious frontend -> `frontend`
- obvious backend/API -> `service`
- obvious postgres/mysql/redis-like data service -> `database` or `cache` as appropriate
- Kafka, RabbitMQ, and similar broker middleware may use `other` unless the current schema supports a more specific role

Source defaults:
- if `frontend/` or equivalent is clearly present in a Git repo, prefer source-backed `web`
- if `docs/`, `docusaurus.config.*`, or equivalent docs-site structure is clearly present in a Git repo, prefer source-backed `web`
- if `backend/` or equivalent is clearly present in a Git repo, prefer source-backed `api`
- for same-repo multi-component projects, store:
  - `git_url` as the repo root remote URL
  - `code_version` as the current branch/ref
  - `subdirectories` as the component subdirectory

Do **not** generate a generic nginx image component for a docs/static site project unless at least one of these is true:
- the repository already provides an explicit image reference
- the user explicitly asked to deploy a prebuilt image instead of source
- the repository is not safely usable as source and the user explicitly approved an image fallback

Frontend defaults:
- if nginx-style `/api` reverse proxy is strongly implied, set `access_mode: reverse-proxy`
- otherwise prefer `access_mode: unspecified`

Database defaults:
- never write passwords into the generated manifest
- non-sensitive items like `POSTGRES_DB` may be written if justified
- if downstream services depend on the database, prefer `connection_envs` on the database component over duplicated consumer envs
- if a stable alias is clear, include `port_alias` such as `DATABASE`, `MYSQL`, `POSTGRES`, or `REDIS`
- if runtime startup will require a password or secret not present in the repo, put that in `Open Questions`
- if a required database startup secret is missing, the execution summary for that component should be `needs_confirmation`, not `ready`
- if compose or image conventions show a database data directory, note whether persistence is configured; missing persistence should not block demo bootstrap by itself, but must be visible in the execution summary or open questions

Middleware provider defaults:
- for Redis, Kafka, RabbitMQ, MongoDB, and similar provider components, put reusable connection values in `connection_envs`
- use placeholders for sensitive connection values and require explicit input or `.rainbond/secrets.<environment>.json`
- do not put shared provider connection values on each dependent service during init

Example component:

```json
{
  "name": "api",
  "role": "service",
  "git_url": "https://gitee.com/example/repo",
  "code_version": "main",
  "subdirectories": "backend",
  "port": 8080,
  "depends_on": ["postgres"]
}
```

If critical values are unknown:
- leave them out
- or ask the user only for the missing critical values

## Generated Manifest Rules: v2 Draft Mode

If generating `rainbond.app.json` in v2 draft mode, produce:
- `schema_version: 2`
- `project.team_name`
- `project.region_name`
- `project.app_name`
- optional top-level `repo`
- `components[]`

Each generated component may include:
- `name`
- `role`
- `port`
- `port_alias`
- `depends_on`
- `env`
- `connection_envs`
- `access_mode`
- `source`

Supported draft source shapes:

### `image`
```json
"source": {
  "kind": "image",
  "image": "goodrain.me/demo-api:latest"
}
```

### `source`
```json
"source": {
  "kind": "source",
  "git": {
    "remote_url": "https://gitee.com/example/repo",
    "ref": "main"
  },
  "subdirectories": "backend"
}
```

### `template`
```json
"source": {
  "kind": "template",
  "install": {
    "source": "local",
    "app_model_id": "",
    "app_model_version": ""
  }
}
```

Rules for v2 draft mode:
- prefer `source.kind = image` when executable image references are known
- prefer `source.kind = source` when the repository is clearly the component source and Git metadata is available
- prefer `source.kind = template` for standard middleware when template install metadata can be supplied or confirmed
- fall back to `source.kind = image` for standard middleware only when template metadata or curated mapping is unavailable
- if template install metadata is incomplete, mark the component `needs_confirmation`
- do not silently invent `app_model_id`, `app_model_version`, or `market_name`

## Local Binding Rules

`.rainbond/local.json` should contain:
- `schema_version`
- `binding.team_name`
- `binding.region_name`
- `binding.app_name`
- `binding.app_id` (at every Rainbond Tool boundary, normalize a decimal session string to a positive integer; reject non-numeric IDs)
- `platform.server_name`
- `preferences.default_environment`
- `preferences.auto_use_manifest`
- `metadata.linked_at`
- `metadata.linked_by`
- `metadata.status`
- optional empty `runtime_components`

Do not store:
- tokens
- passwords
- certs
- private keys
- registry secrets
