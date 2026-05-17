---
name: rainbond-project-init
description: Use when onboarding a local project into Rainbond for the first time, especially when the project is not yet linked and may not yet have a rainbond.app.json manifest.
---

# Rainbond Project Init

## MCP 认证失败恢复（JWT 过期 / 401 / 403）

当任何 `rainbond_*` MCP 工具返回 401 / 403 / `unauthorized` / `token expired` 类认证错误时，
禁止重装 skills，也禁止手工改 `~/.rainbond/mcp.env`。先用下面任一命令刷新 JWT：

```bash
bash <(curl -fsSL https://get.rainbond.com/rainskills/install.sh) refresh
# 或：bash ~/.rainbond/skills/install.sh refresh
```

刷新成功后必须提醒用户**重启 Claude Code 或 Codex**（MCP 客户端在进程启动时一次性读取
`RAINBOND_JWT`，刷新后的新 token 不会自动透传到正在运行的客户端）。在用户确认重启之前不要自动
重试同一个 MCP 工具调用。

## Overview

Use this skill to perform the **first-time onboarding** of a local project into Rainbond.

This skill is the initialization phase before normal day-2 operations can use `rainbond-app-assistant`.

It should:
1. detect whether the project already has a Rainbond manifest
2. generate a first draft manifest if missing
3. infer a component topology and the most appropriate current delivery mode
4. determine whether the project is already linked
5. create or locate the target Rainbond app
6. write `.rainbond/local.json`
7. produce an execution summary for the current component sources
8. either stop after initialization or hand off to downstream Rainbond deployment flow

This skill is for **first-time setup**, not ongoing operations.

## Canonical Model Reference

Use `docs/product-object-model.md` as the repository-level source of truth for:

- `Project` identity and topology baseline boundaries
- `Environment` selection and local config layering
- `ComponentSource` kinds, readiness semantics, and external projection rules

This skill should describe how onboarding produces or resolves those objects. It should not redefine their canonical boundaries independently.

## 用途速览

这是首次接入 Rainbond 的初始化 skill。

它负责：
- 判断当前项目是否已经有 manifest / local binding
- 在缺失时生成 `rainbond.app.json`
- 创建或定位 Rainbond app
- 写入 `.rainbond/local.json`

它不负责：
- 运行态排障
- 代码修复
- 深入交付验收

语言约定：
- 规则说明和流程说明优先中文
- `### Structured Output` 中的对象名、字段名、enum 保持英文 canonical 形式

## 硬规则

以下规则优先级最高。若后文示例或详细说明与这里冲突，以这里为准。

1. 只检查当前项目目录中的 `rainbond.app.json` 和 `.rainbond/local.json`。
   不允许扫描 `$HOME` 或其他仓库寻找绑定文件。
2. 如果 `rainbond.app.json` 已存在，默认复用它；不要无故重生成。
3. 如果没有 manifest，按仓库结构保守推断。
   对 Git 仓库里的业务代码组件，优先推成 `source`，不要轻易推成通用镜像。
4. 对 docs / Docusaurus / frontend Git 项目，默认优先 `source-backed`。
5. Docker 镜像代理、Git 代理只是 transport hint，不改变 `execution_mode`。
6. 如果源码 Git URL 是原始 `https://github.com/...`，且用户没有明确给出代理地址，优先先问一次是否改用代理地址，再继续。
7. **team 智能选择**：
   - 单个 team 可访问 → 直接用，不询问。
   - 多个 team 但 manifest 显式指定了 `team_name` 且该 team 在可访问列表里 → 直接用，在报告里说"已选 team = X（来自 manifest）"。
   - 多个 team 且无 manifest 提示 → 停下来询问；**禁止**静默选 `default` / 第一个 / 任意已有 team。
8. 如果这个 skill 是由 `rainbond-app-assistant` 的单入口主线调用的，init 成功后应该把 `next_action` 交给 bootstrap，而不是停在 init。
9. `team_name = default` 只有在用户明确给出或明确确认时才允许。
10. 不要把本地 Docker 构建、临时镜像仓库推送、启动 Docker Desktop/OrbStack 当成 init 的自动兜底；这些都是 delivery-mode 策略切换，必须先得到用户明确确认。
11. 如果当前工作目录没有任何项目特征文件（无 `rainbond.app.json`、`Dockerfile`、`package.json`、`go.mod`、`pom.xml`、`requirements.txt` 等），且用户仅提供了一个外部 Git URL，则：
    - **禁止**凭模型对该 URL 仓库结构的先验知识自动枚举或推断子目录
    - 必须先询问用户：要部署的是仓库根目录，还是某个具体子目录？若是子目录，请用户给出路径（如 `java/spring-boot`）
    - 只生成**一个**组件；除非用户在回复中明确列出了多个目标子目录
    - 此规则防止把多 example 仓库（如 sourcecode-examples）的所有子目录批量展开为组件，避免造成批量"数据中心异常"

## 主线流程

1. 读取当前项目目录里的 manifest / local binding。
2. 如果没有 manifest，就按仓库结构推断生成 `rainbond.app.json`。
3. 如果推断出的源码地址是原始 GitHub URL，且用户未显式给出代理地址，先询问是否改用 GitHub 代理。
4. 解析 `team_name / region_name / app_name`。
5. 通过 MCP 查找或创建 Rainbond app。
6. 写入 `.rainbond/local.json`。
7. 输出 `ProjectInitResult`，并决定是 stop 还是 bootstrap。

## 停止条件

以下情况必须停住：

- 多个 team 但用户还没选
- region / app identity 仍不明确
- MCP 不可用，无法完成 online verification
- 用户明确要求 stop-after-init

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
- `template`: supported when template install metadata is complete enough to drive the current MCP install flow

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
- if MCP runtime facts later conflict with inferred topology, the inferred draft should be corrected
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
- never silently invent `team_name`; if it cannot be resolved from explicit input, manifest, or a single unambiguous MCP result, ask the user directly
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
- if the current MCP/source path cannot express the needed build context safely, mark that component `needs_confirmation` with a build-context reason instead of switching to local package or image fallback

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
- `binding.app_id`
- `mcp.server_name`
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

## Workflow

Follow this order.

1. Inspect local project state
- check whether `rainbond.app.json` exists
- check whether `.rainbond/local.json` exists
- check whether the project is already linked
- scope this inspection to the current project directory only
- do not run broad filesystem searches such as `find $HOME ...` to locate bindings from other repositories

2. Resolve or generate project baseline
- if `rainbond.app.json` exists, read it
- if missing, inspect the repo and generate a draft `rainbond.app.json`
- choose default executable v1 mode unless the user explicitly requests v2 draft mode
- if the repo clearly resolves to source-backed business code, keep that source-oriented baseline even when the user also supplied transport hints for image registries or Git mirrors

3. Resolve target project identity
- determine `team_name`, `region_name`, and `app_name`
- prefer explicit input, then manifest, then repository inference
- team / region selection follows hard rule 7 (smart default): use silently when single candidate or manifest match; ask only when genuinely ambiguous
- do not silently choose `default` as `team_name`

4. Resolve selected environment
- resolve selected environment using the Configuration Priority rules above
- never emit `local`, `default`, `binding`, or any other non-environment label as the selected environment
- if in doubt, use `preview`

5. Query Rainbond
- check whether an app with the resolved identity already exists
- if it exists, capture `app_id`
- if it does not exist, create it
- do not stop at "app missing"; missing app means initialization must continue into app creation

6. Write local binding
- create or update `.rainbond/local.json`
- if app existence and `app_id` were confirmed through MCP, set `metadata.status = linked`
- if MCP is unavailable and online verification cannot be completed, set `metadata.status = pending_verification`
- do not present the project as fully initialized until online verification succeeds

7. Build execution summary
- for each component, classify the immediate execution path using the Execution Summary Rules above
- report whether the current initialized project is immediately executable with the current bootstrap chain or still partially blocked
- if a component was inferred as source-backed, say so explicitly rather than silently presenting a fallback image path

8. Decide next action
- if the user asked only for initialization, stop after binding
- if the user asked to initialize and continue, hand off to `rainbond-fullstack-bootstrap`
- if this skill was entered by `rainbond-app-assistant` during a single-entry deployment or dev-to-test mainline run, treat that as initialize-and-continue rather than stop-after-init
- if the user intent is ambiguous, prefer stopping after initialization and state the next step explicitly

Hard rule:
- if `app_id` is still unknown, initialization is not complete
- if MCP is unavailable and app existence cannot be verified online, initialization is only partially complete
- if initialization is not complete, do not hand off to `rainbond-fullstack-troubleshooter`
- `rainbond-fullstack-troubleshooter` is only valid after app creation and binding are complete
- if the user requested stop-after-init, do not hand off to `rainbond-fullstack-bootstrap`

## Verification Standard

Initialization is successful when:
- `rainbond.app.json` exists or has been generated
- the target Rainbond app exists
- `.rainbond/local.json` exists
- `app_id` is known
- selected environment is resolved to `preview` or `production`
- the project is now in a linked state
- an execution summary is available

If MCP is unavailable:
- manifest generation or reuse may still complete
- a provisional `.rainbond/local.json` may still be written
- but initialization must be reported as pending online verification rather than fully complete

Initialization is not required to:
- create components
- deploy topology
- fix runtime problems
- verify frontend access

Those belong to downstream skills.

## Output Format

Structured output contract:

- this skill must emit `ProjectInitResult`
- minimum target fields:
  - `project`
  - `environment`
  - `component_sources`
  - `init_status`
  - `next_action`
- the human-readable sections below are the narrative view over that object
- the reply must end with a final `### Structured Output` section
- the `### Structured Output` section must render `ProjectInitResult` in fenced `yaml`
- the literal shape of the final section must be:
  - line 1: `### Structured Output`
  - line 2: ````yaml`
  - middle: `ProjectInitResult: ...`
  - final line: ````
- omitting the final structured block, changing its object name, or placing later prose after it is a contract failure
- this contract still applies when the result is `pending_verification` or `blocked`
- do not create sidecar result artifacts such as `.rainbond/init.result.json` as a substitute for the final reply contract; current-run status must be expressed in the prose sections and `ProjectInitResult`

Proposed schema:

```yaml
ProjectInitResult:
  project:
    identity:
      team_name: string
      region_name: string
      app_name: string
      app_id: string | null
    binding_source: manifest | local_binding | inferred
  environment:
    name: preview | production
    selection_source: explicit | local_preference | default
  component_sources:
    - name: string
      role: frontend | service | database | cache | other
      execution_mode: image | source | template | blocked
      status: ready | needs_confirmation | blocked
      blocking_reason: string | null
  init_status: linked | pending_verification | blocked
  next_action: stop | bootstrap | reconnect_mcp | ask_identity | ask_manifest_review
```

Construction rules:

- `project.identity`
  - comes from the resolved current-run identity
  - prefer explicit input, then valid local binding, then manifest, then conservative inference
- `project.binding_source`
  - use `local_binding` when reused `.rainbond/local.json` is the dominant resolved source
  - use `manifest` when existing manifest data is the dominant resolved source and local binding was not the primary driver
  - use `inferred` when repo inspection or manifest generation supplied the dominant baseline
  - if `rainbond.app.json` was generated in the current run, prefer `inferred` rather than `manifest`, even when the generated manifest is then written to disk
- file action reporting
  - determine `reused`, `created`, and `updated` from the pre-run baseline versus the end-of-run result, not from the final filesystem snapshot alone
  - if `rainbond.app.json` was absent at run start and exists at run end, report it as generated/created in both `Init Result` and `Files Created Or Updated`
  - if `.rainbond/local.json` existed at run start and only status/timestamps changed, report it as updated rather than reused
- `environment.name`
  - must be `preview` or `production`
- `environment.selection_source`
  - use `explicit` when the user provided the environment
  - use `local_preference` when `.rainbond/local.json.preferences.default_environment` supplied it
  - otherwise use `default`
- `component_sources`
  - must contain one entry per component listed in the execution summary
  - must reuse the same `execution_mode`, `status`, and `blocking_reason` semantics as the prose summary
  - use canonical status spelling: `ready`, `needs_confirmation`, `blocked`
- `init_status`
  - use `linked` only when current-run MCP verification confirmed the app/binding
  - use `pending_verification` when local binding or generated state exists but current-run MCP verification did not complete
  - use `blocked` when identity or other critical preconditions remain unresolved
- `next_action`
  - must be the normalized form of the prose `Next Step`
  - must represent exactly one decision for the current run, not multiple possible downstream branches
  - use `stop` when the current run intentionally ends at the init boundary, including user-requested stop-after-init
  - when the user asked only for initialization, reuse, or status/result reporting, treat that as stop-at-init unless they explicitly asked to continue
  - use `bootstrap` only when the current run is expected to continue directly into `rainbond-fullstack-bootstrap`
  - use `reconnect_mcp`, `ask_identity`, or `ask_manifest_review` only when that specific external action is the true gating step
- `runtime_components`
  - may be written into `.rainbond/local.json` as a reuse hint, but it does not belong inside `ProjectInitResult`

Consistency rules:

- prose and `ProjectInitResult` must agree on app identity, selected environment, component count, and next step
- if prose says online verification was not performed in the current run, `init_status` must not be `linked`
- a newly generated manifest may still pair with an already-existing Rainbond app; do not force `binding_source = local_binding` only because the app already existed
- `.rainbond/local.json.runtime_components` is a reuse hint, not topology truth
- logical role names and runtime component names may differ; record the drift as reusable context instead of treating it as an automatic failure
- if multiple accessible teams existed in the current run and no explicit team choice was obtained, `init_status` must not be `linked`
- if a field is unknown but applicable, prefer `null` over invention
- never place secret values in the structured object

Example object:

```json
{
  "project": {
    "identity": {
      "team_name": "demo-team",
      "region_name": "cn-north-1",
      "app_name": "shopping-cart",
      "app_id": "app-7321"
    },
    "binding_source": "local_binding"
  },
  "environment": {
    "name": "preview",
    "selection_source": "default"
  },
  "component_sources": [
    {
      "name": "api",
      "role": "service",
      "execution_mode": "image",
      "status": "ready",
      "blocking_reason": null
    },
    {
      "name": "frontend",
      "role": "frontend",
      "execution_mode": "source",
      "status": "needs_confirmation",
      "blocking_reason": "missing git_url in manifest"
    }
  ],
  "init_status": "linked",
  "next_action": "bootstrap"
}
```

Example final reply:

````markdown
### Init Result
Initialization succeeded with a freshly inferred manifest; the missing `rainbond.app.json` was generated and the Rainbond app was created via MCP, so the project is now linked and ready for bootstrap.

### Resolved Project
App `storefront`, environment `preview`.

### Files Created Or Updated
`rainbond.app.json` (created from repository inference), `.rainbond/local.json` (created with verified binding metadata, status `linked`).

### Execution Summary
- Component `api`: `execution_mode` image, `status` ready, blocking reason none.
- Component `frontend`: `execution_mode` source, `status` needs_confirmation, blocking reason “git_url inferred from remote needs user confirmation”.
- Component `postgres`: `execution_mode` image, `status` needs_confirmation, blocking reason “startup password TBD; no secure source yet”.

### Open Questions
Need explicit confirmation that the inferred git_url is the correct code source for `frontend`; postgresql password source remains unspecified.

### Next Step
run rainbond-fullstack-bootstrap

### Structured Output
```yaml
ProjectInitResult:
  project:
    identity:
      team_name: demo-team
      region_name: us-west-2
      app_name: storefront
      app_id: app-9123
    binding_source: inferred
  environment:
    name: preview
    selection_source: default
  component_sources:
    - name: api
      role: service
      execution_mode: image
      status: ready
      blocking_reason: null
    - name: frontend
      role: frontend
      execution_mode: source
      status: needs_confirmation
      blocking_reason: git_url inference needs confirmation
    - name: postgres
      role: database
      execution_mode: image
      status: needs_confirmation
      blocking_reason: database password source missing
  init_status: linked
  next_action: bootstrap
```
````

Always respond using exactly these sections:

### Init Result
- state whether the project was initialized successfully
- state whether the manifest was reused or generated
- state whether the Rainbond app was reused or created
- if MCP was unavailable, explicitly say initialization is pending online verification
- describe manifest/app/file actions from what happened in the current run, not merely from what exists by the time the reply is written

### Resolved Project
- state `app_name`
- state `selected environment`
- do not include `team_name`, `region_name`, or `app_id` in this section; those are available in `### Structured Output` only

### Files Created Or Updated
- list:
  - `rainbond.app.json`
  - `.rainbond/local.json`
- these two files must always be reported in this section, even when additional local helper files were created
- optional `.rainbond/env.<env>.json` or `.rainbond/secrets.<env>.json` files may be mentioned only when they were actually created or updated, but they do not replace the required pair above
- state whether each file was reused, created, or updated
- decide reused/created/updated from file state before the run versus after the run; do not call a newly generated file "reused" just because it now exists
- if `.rainbond/local.json` was written without MCP verification, state that its status is `pending_verification`
- do not introduce additional result-carrier files just to store current-run init status

### Execution Summary
- list each component
- state:
  - `execution_mode`
  - `status`
  - `blocking_reason` if any
- make it clear which components are immediately executable by the current validated workflow
- use `ready` only for components that can be executed immediately with currently available inputs
- use `needs_confirmation` when execution probably works but still depends on a missing confirmation such as image availability or secret source

### Open Questions
- list any remaining ambiguity
- if none, say `none`
- if a database component was generated without a safe bootstrap secret source, explicitly record that as an open question
- if a v2 draft uses `template` but required install metadata is incomplete, explicitly list the missing fields as open questions

### Next Step
- one of:
  - `run rainbond-fullstack-bootstrap`
  - `stop, initialization complete`
  - `reconnect MCP and verify app existence`
  - `stop, initialization pending online verification`
  - `ask user to confirm missing identity`
  - `ask user to review generated manifest`
  - never `run rainbond-fullstack-troubleshooter` while app creation or local binding is incomplete
- choose exactly one line for the current run; do not present alternative downstream branches in this section
- if the user explicitly requested initialization only and init reached a stable boundary, use `stop, initialization complete`
- if the user asked to reuse existing config and report the result, that is still initialization-only and should end with `stop, initialization complete`
- if the user requested initialize-and-continue, use `run rainbond-fullstack-bootstrap`

### Structured Output
- append a fenced `yaml` block as the final section
- render `ProjectInitResult`
- keep enum values and field names aligned with the schema above
- do not place any prose after this section
- do not duplicate secrets or invent missing values
- when MCP is unavailable or identity is blocked, still use the same required section headings and final `ProjectInitResult`; only field values change
- bare YAML under `### Structured Output` is a contract failure; the object must appear inside fenced markdown code block with `yaml`
- the opening fence must be exactly ````yaml` immediately after the heading
- the closing fence must be the last non-whitespace line of the whole reply
- emit the backticks literally; do not paraphrase, omit, or replace the fenced block with plain indented YAML
- use this exact final tail shape:
  - `### Structured Output`
  - ````yaml`
  - `ProjectInitResult:`
  - `...`
  - ````

## Common Mistakes

- treating first-time init as the same as day-2 app operations
- skipping manifest generation when no baseline exists
- writing secrets into local project files
- generating a manifest schema that the current bootstrap skill cannot consume
- dropping docker-compose database volume intent during manifest generation
- narrowing a monorepo component to a child directory when its build depends on root-level lockfiles or project metadata
- starting local Docker/OrbStack or pushing temporary images as an implicit fallback
- silently generating v2-only source structures when the user asked for an immediately executable manifest
- omitting the execution summary, leaving users unable to tell which components can actually run now
- omitting the required `### Structured Output` section
- emitting bare YAML instead of fenced `yaml` under `### Structured Output`
- omitting either the opening ````yaml` fence or the final closing fence
- generating `binding_source: manifest` when the manifest itself was newly generated from repo inference in the current run
- reporting a file as reused simply because it exists at reply time, even though it was created during the current run
- writing `.rainbond/init.result.json` or a similar sidecar result file instead of emitting the required final `ProjectInitResult`
- replacing the required section headings with freeform narrative when the result is `pending_verification` or `blocked`
- writing `Next Step` as multiple alternatives while `next_action` chooses only one of them
- creating duplicate Rainbond apps without checking first
- over-inferring topology from weak hints
- trying to troubleshoot runtime issues inside init
- continuing without resolving critical identity fields
- handing off to `rainbond-fullstack-troubleshooter` before the app exists and `.rainbond/local.json` is valid
- emitting `local` or another invalid selected environment value
- auto-continuing into bootstrap when the user asked to stop after initialization
- declaring initialization complete when MCP is unavailable and app existence was not verified online

## Quick Reference

If missing:
- `rainbond.app.json` -> generate draft manifest
- `.rainbond/local.json` -> create local binding
- Rainbond app -> create app

If already present:
- reuse manifest
- reuse binding if valid
- reuse app if found

Component source kinds:
- `image`
- `source`
- `template`

Current conservative default:
- for standard middleware, prefer `template` when template metadata or curated mapping exists; otherwise use `image` as the safe fallback
- use `source` when a business-code component has enough Git metadata to drive the current source creation flow safely
- use `template` when install metadata is sufficient or can be resolved from a curated mapping; otherwise fall back to `image` in executable v1 mode or keep it as a confirmation-needed draft in v2 mode

Hand off after init:
- `rainbond-fullstack-bootstrap` for topology creation
- later `rainbond-fullstack-troubleshooter` for runtime repair

Execution summary reminder:
- `image` is the most reliable current executable path
- `source` should only be marked ready when the source metadata is truly sufficient
- `template` remains a reserved schema path until template-install support is implemented

Environment rule:
- selected environment must always resolve to `preview` or `production`
- if invalid or missing, use `preview`

Stop-after-init rule:
- if the user asks only for initialization, stop after writing `.rainbond/local.json`
- do not continue into bootstrap automatically

Verification rule:
- if `.rainbond/local.json` was written without MCP verification, mark it `pending_verification`
- in that case, the correct next step is to reconnect MCP and verify app existence before claiming full initialization
