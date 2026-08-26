---
name: rainbond-fullstack-bootstrap
description: "Use only when the user explicitly asks to create the Rainbond app and component topology for a known current project or manifest. Trigger phrases include: 只帮我创建应用和组件，不要继续排障 / create topology / bootstrap only. Do not use for a generic current-project deployment request; route that to rainbond-app-assistant."
---

# Rainbond Fullstack Bootstrap

<!-- rainskills-runtime-gate:start -->
## 运行环境门禁（最高优先级）

### CLI 调用格式（强制）

所有可变 `call` 都必须使用完整 argv：`call <tool> --input - --operation-id <uuid> --skill-id rainbond-fullstack-bootstrap`。CLI 返回确认 ID 后，只能在同一 argv 末尾加入 `--confirm <confirmation-id>`；不得省略 `--skill-id`、猜测参数，或根据泛化错误反复重试。

### 多运行环境操作契约

  Node.js 前置检查通过后，每次请求先执行本地 launcher + `["environment", "list", "--json"]`，按用户明确指定的运行环境选择不可变环境 ID；未指定时只用全局默认环境，默认不可用时停止且不回退。生成 UUID 后执行本地 launcher + `["operation", "begin", "--operation-id", "<uuid>", "--environment-id", "<id>", "--intent-json", "<intent-json>"]`，并在之后每个 Rainbond MCP 调用中加入 `rainskills_operation_id`。环境、团队和应用只属于本次操作，禁止保存项目绑定；同一项目可以部署到多个环境。明确“团队”表示环境内团队；明确“运行环境/平台”表示环境；裸名称同时匹配环境和团队时必须询问。

第一步检查 Node.js 是否存在且主版本不低于 18。Node.js 缺失或低于 18 时，只说明“Rainskills 执行组件需要 Node.js 18 或更高版本”并停止：不选择运行环境，不调用 MCP，不猜测替代命令。只有用户或 agent 明确同意后才安装或升级 Node.js，再从同一原始 intent 继续。

固定 launcher 是 `["node", "<home>/.rainbond/lib/rainskills/bin/rainskills.js"]`；运行包版本标记为 `rainskills@0.1.11`，且必须与本技能包 `package.json` 一致。把 launcher 与参数拼成 argv 数组直接执行，禁止 `rainskills@latest` 或执行 shell 字符串。

本地 launcher 必须从当前 Skill 所在目录的同级目录定位 `rainbond-platform-installer/scripts/local-runtime.js`，解析为绝对路径后使用 `["node", "<绝对路径>"]` 执行。`environment list`、`operation begin`、`operation complete` 和 `runtime message` 只能使用本地 launcher；本地 launcher 只读取已安装文件和本机受保护状态，不得访问 npm 或其它网络。只有用户选定连接或安装运行环境后，才使用上面的固定本地 launcher。

所有 Rainbond 查询和变更必须通过本地 `~/.rainbond/bin/rainskills-tools.js` 执行，并绑定本次 operation ID。禁止 Agent 直接调用 Rainbond MCP，也不得启动本地 Rainskills MCP 服务；只允许执行 CLI 返回的结构化结果与确认续接 argv。

只有 CLI 返回并通过校验的 `rainskills.next-action.v1` argv 才能执行续接。普通失败一律禁止自动重试：不得再次执行原命令，不得执行 `--help`、`sleep`、`rg`、`grep`，不得搜索 Rainskills 源码；同一 `operation complete` 最多执行一次。

<!-- rainskills-runtime-contract:start -->
```json
{
  "schema": "rainskills.skill-runtime-contract.v1",
  "package_version": "rainskills@0.1.11",
    "launcher": ["node", "<home>/.rainbond/lib/rainskills/bin/rainskills.js"],
  "local_launcher": ["node", "<installed-skills-root>/rainbond-platform-installer/scripts/local-runtime.js"],
  "local_argv": {
    "environment-list": ["node", "<installed-skills-root>/rainbond-platform-installer/scripts/local-runtime.js", "environment", "list", "--json"],
    "operation-begin": ["node", "<installed-skills-root>/rainbond-platform-installer/scripts/local-runtime.js", "operation", "begin", "--operation-id", "<uuid>", "--intent-json", "<intent-json>"],
    "operation-complete": ["node", "<installed-skills-root>/rainbond-platform-installer/scripts/local-runtime.js", "operation", "complete", "--operation-id", "<uuid>"],
    "runtime-message": ["node", "<installed-skills-root>/rainbond-platform-installer/scripts/local-runtime.js", "runtime", "message", "--id", "<message-id>"]
  },
  "intents": {
    "bootstrap": {"required": ["project_root"], "optional": ["team_id", "app_id", "service_id"], "enums": {}}
  },
  "route_conditions": {
    "new": {"app_id": "absent", "service_id": "absent"},
    "existing": {"any_present": ["app_id", "service_id"]}
  },
  "routes": {
    "new": ["saas", "private-existing", "install-private"],
    "existing": ["saas", "private-existing"]
  },
  "connect_argv": {
    "saas": ["node", "<home>/.rainbond/lib/rainskills/bin/rainskills.js", "runtime", "connect", "<target>", "--saas", "--intent-json", "<intent-json>"],
    "private-existing": ["node", "<home>/.rainbond/lib/rainskills/bin/rainskills.js", "runtime", "connect", "<target>", "--rainbond-url", "<rainbond-url>", "--intent-json", "<intent-json>"],
    "install-private": ["node", "<home>/.rainbond/lib/rainskills/bin/rainskills.js", "runtime", "connect", "<target>", "--install-private", "--location", "<private-location>", "--intent-json", "<intent-json>"]
  }
}
```
<!-- rainskills-runtime-contract:end -->

target 只允许 `codex`、`claude`、`pi`、`all`。校验 intent 后按 `route_conditions` 选择 scope：`app_id` 和 `service_id` 都没有时是 new；任一存在时是 existing。只执行该 scope 允许的完整 argv；只消费 schema 为 `rainskills.next-action.v1` 且校验后的 `argv` 数组。

连接完成后用固定 `onboarding-id` 执行 launcher + `["intent", "resume", "--onboarding-id", "<同一 onboarding-id>"]`，恢复原始 intent 和 `resume_step`。401 先执行 launcher + `["runtime", "record-failure", "--onboarding-id", "<同一 onboarding-id>", "--step", "<当前固定步骤>", "--reason", "credential-expired"]`，再仅一次执行 launcher + `["runtime", "reconnect", "--onboarding-id", "<同一 onboarding-id>"]` 后 resume，只重试该步骤；第二次 401 停止。403 执行 launcher + `["runtime", "record-failure", "--onboarding-id", "<同一 onboarding-id>", "--step", "<当前固定步骤>", "--reason", "permission-denied"]` 后停止，不得 reconnect、重新授权或自动重试。
<!-- rainskills-runtime-gate:end -->

受限沙箱（包括 Codex）执行本地状态命令时，必须申请用户级受保护目录访问权限；在 Codex 中使用 `require_escalated`。不得修改 `~/.rainbond` 权限、复制受保护状态到工作区，或因沙箱权限错误建议重装。

涉及浏览器或设备授权的 `runtime connect`，以及恢复/安装场景中的 `rainskills <target> --self-hosted`，必须在附加交互终端（TTY）中运行；在 Codex 中设置 `tty: true` 并保持进程附着直到授权完成。禁止通过非交互命令要求用户粘贴 JWT；非交互模式只可复用已存在的受保护凭据。

执行优化：同一会话内只检查一次 Node.js（首次使用本地 CLI 前）；仅在 Node.js 或 Rainskills 安装、升级，或 PATH 变更后失效。固定 launcher 和 argv 已在本 Skill 中，禁止读取、搜索或探测 `rainskills.js`，也禁止执行 `npm root -g`。每个新的业务操作仍需要刷新一次环境列表；带已有 `operation_id` 或 `onboarding-id` 的续接复用已绑定的环境 ID，不重复枚举环境。

<!-- rainskills-runtime-routing:start -->
## 缺少运行环境时

先说：“可以，我会帮你创建应用和组件拓扑。不过目前还没有可用的应用运行环境。你刚安装的 Rainskills 是 AI 部署助手，它负责分析项目并执行部署；应用实际会运行在 Rainbond 上。Rainbond 是一套应用运行和管理平台，负责源码构建、容器运行、域名访问、日志和存储等工作，你不需要了解 Kubernetes。”

先根据 intent 确认 scope，确认前不展示环境选项：`app_id` 和 `service_id` 都不存在是 new scope，任一存在是 existing scope。

### 新建目标

#### 选择运行环境

intent 不含 `app_id` 和 `service_id` 时，请提示“请选择应用要运行的环境：”，并只显示：

1) 云端环境（免费体验）
2) 私有环境（去对接）

用户选择私有环境后，立即执行本地 launcher + `["runtime", "message", "--id", "private-deployment-location"]`，并原样输出固定消息：

请选择部署位置：

1、部署到本机
2、部署到独立服务器
3、部署到已有 Rainbond

选择 1 时执行 `install-private` route，并使用 `["--location", "local"]`；选择 2 时执行 `install-private` route，并使用 `["--location", "server"]`；选择 3 时执行本地 launcher + `["runtime", "message", "--id", "private-console-origin"]`，收到地址后执行 `private-existing`。不得显示额外的接入方式中间步骤，不得重复询问部署位置，也不得在环境准备完成前询问应用来源。

### 已有目标

intent 含 `app_id` 或 `service_id` 时，已有应用只让用户选择 `Rainbond Cloud` 或承载目标应用的`已有私有 Rainbond`。选择已有私有 Rainbond 时执行本地 launcher + `["runtime", "message", "--id", "private-console-origin"]` 并原样输出。
<!-- rainskills-runtime-routing:end -->

## Overview

Use this skill to create a Rainbond application topology from prepared component definitions.

The goal is to complete the initial platform setup:
1. create or locate the target app
2. create or locate executable components from manifest
3. apply the minimum required topology and configuration
4. deploy affected components
5. stop at the first deeper runtime issue and hand off correctly

This skill is for **bootstrapping**, not deep repair, and not the default top-level
entry for generic current-project deployment requests.

语言约定：
- 规则说明和流程说明优先中文
- `### Structured Output` 中的对象名、字段名、enum 保持英文 canonical 形式

## Canonical Model Reference

Use [product object model](../rainbond-app-assistant/references/product-object-model.md) as the repository-level source of truth for:

- `ComponentSource` resolution outcomes and execution-path intent
- `DeploymentPlan` action semantics such as create, reuse, skip, handoff, and wait
- deferred dependency wiring when source-backed components have not yet converged
- the shared runtime evidence vocabulary used before handing off to troubleshooting or delivery verification

This skill explains how bootstrap executes those decisions in today’s workflow. It should not redefine canonical object boundaries independently.

For this modular pilot, the **live bootstrap output contract** is frozen by:
- [modules/70-output-contract.md](modules/70-output-contract.md)
- [schemas/bootstrap-result.schema.yaml](schemas/bootstrap-result.schema.yaml)

Do not switch back to the older top-level `created_components` / `reused_components` / `skipped_components` shape from the current object-model draft.

## 用途速览

这是“把拓扑真正建起来”的 skill。

它负责：
- 按 manifest 创建 app 内组件
- 补最小端口、依赖和启动配置
- 把项目推进到“可继续排障 / 可继续交付验收”的状态

它不负责：
- 深入运行态修复
- 代码修复
- 自动切换 delivery mode

## When to Use

Use when:
 - the next action is already known to be creating app topology or executable components
 - a new Rainbond app must be created from a manifest
 - manifest components should be created from supported delivery modes
 - a team needs a repeatable setup flow before runtime debugging
 - the objective is to stand up the minimum viable topology in Rainbond

Do not use when:
 - the user gives a generic current-project deployment request such as “帮我把当前项目部署到 Rainbond 上” or “帮我把这个项目跑起来”; route that to `rainbond-app-assistant`
 - the main task is runtime fault diagnosis
 - the app and components already exist and only need repair
 - the issue requires code changes
- the issue requires frontend build or reverse-proxy fixes
- the task involves deleting or rebuilding an existing app from scratch

When runtime repair is already the main task, use `rainbond-fullstack-troubleshooter` instead.

## Always-on Guardrails

These rules are always in force. If any module, example, or lower-priority note conflicts with them, these rules win.

1. Only use `rainbond.app.json`, legacy `rainbond.json`, `.rainbond/local.json`, `.rainbond/env.<environment>.json`, and `.rainbond/secrets.<environment>.json` from the **current project directory**. Do not cross directories to guess context.
2. Once a component resolves to `source-backed`, preserve the source execution path for the current run. Do not silently downgrade it to `image` or `package`.
3. Once a source ref is resolved, do not silently rewrite branch or ref names.
4. If source creation or source detection returns `multiple services detected` or another multi-component ambiguity, stop and ask for an explicit strategy. Do not auto-switch to package upload, manual artifact upload, template install, or other workaround paths.
5. If source creation hits MCP / Rainbond console / control-plane exceptions, stop and report `mcp backend issue`. Do not continue with fallback execution modes.
6. `check_uuid` and `event_id` are optional passthrough fields for standard source creation unless the backend explicitly requires them for the current request.
7. **Transport proxy: auto-apply for known pairs, ask only on failure for the rest.** Apply a proxy silently **only when there is a known-working proxy for the specific source registry / Git host**. Mention the substitution in the final report so the user can override.

   **Known-working proxy pairs (this is a closed list — proxy URLs are facts, not principles; the model must not invent proxy paths):**
   - `github.com` Git URL → `https://ghfast.top/<full-original-url>` (covers `https://github.com/...`, `https://raw.githubusercontent.com/...`)
   - `docker.io` container image (including bare refs like `nginx:latest` or `library/...` that implicitly resolve to `docker.io/library/...`) → `docker.1ms.run/<dockerhub-path>`

   **Other public registries / Git hosts** (`quay.io`, `gcr.io`, `ghcr.io`, `k8s.gcr.io`, `registry.k8s.io`, `nvcr.io`, `mcr.microsoft.com`, `public.ecr.aws`, `gitlab.com`, `codeberg.org`, and similar):
   - **Do not fabricate proxy URLs.** Patterns like `docker.1ms.run/quay.io/...` or `docker.1ms.run/nvcr.io/...` are invalid — each public proxy only covers its declared upstream.
   - Default: try the original URL directly.
   - If the user provided an explicit proxy URL in the message, use it verbatim.
   - On pull failure (`ImagePullBackOff`, `Manifest not found`, `connection refused`), **then** ask the user: "Failed to pull `<original-url>`, possibly a network issue. Do you have a working proxy, or should I retry the original URL?"

   **Private / self-hosted registries:** never proxy; pass the URL through as-is. Recognisable signals (principle, not a list): `.internal` / `.local` suffixes, corporate domains, bare IPs with ports, cloud-vendor private paths (`registry.cn-*.aliyuncs.com`, `<aws-account>.dkr.ecr.<region>.amazonaws.com`, etc.).

   **Already-mirrored URLs** (prefix already on `docker.1ms.run`, `m.daocloud.io`, `mirror.gcr.io`, `ghfast.top/...`, etc.): pass through unchanged, do not double-proxy.

   Reuse the same proxy prefix within a run. If the user explicitly opts out of proxying ("use the raw URL"), skip all proxy substitution for the remainder of the run.

   > Note on principle vs list: the proxy-pair mapping above is a **closed list of facts** (which proxy actually works for which source). It is the one place in this skill where enumeration is correct, because the model cannot infer a working proxy URL from general knowledge. The in/out-of-scope source-side recognition below is still principle-driven.
8. If Dockerfile and language-build detection both exist, resolve the build mode by priority — see `references/source-build-parameter-guide.md § Build Mode Selection` for the full rule. Summary:
   1. **Manifest declaration wins**: if the component manifest sets `source.build.strategy` to `dockerfile` or `cnb`, honor it without re-deriving.
   2. **Heuristic by intent signal**: if the manifest is silent or `auto`, classify the Dockerfile (`needs-prebuilt` / `runtime-only` / `self-contained`); a `self-contained` Dockerfile with intent signals the language buildpack cannot express or would overwrite (custom runtime configs, system packages, non-standard base image, process-level details) defaults to Dockerfile. Otherwise default to language build.
   3. **Ask only when ambiguous**: if signals conflict or evidence is insufficient, ask one concrete question and recommend the user persist the answer in `source.build.strategy`.
   The decision MUST be surfaced in BOTH the prose output (per-component "Build mode for `<name>`: …" line) and the structured output (populate `deployment_plan.workflow.build_strategy_decisions[<name>]` for components that actually had a dual detection); see the guide for the exact shape. The current MCP surface exposes `prefer_dockerfile_when_detected` on `rainbond_create_component_from_source`, not `dockerfile_path`; map a `dockerfile` decision to that boolean.
9. Build parameters go through `rainbond_manage_component_envs(operation=replace_build_envs, build_env_dict=...)`. Runtime envs and connection envs must stay on their own tool paths.

   **Build env keys must come from the documented allowed list** in `references/source-build-parameter-guide.md § Current MCP-Facing Build Keys`. Do NOT fabricate keys based on training-data familiarity with buildpacks / Heroku-style naming conventions. The Rainbond build runtime silently ignores unrecognized keys — so a fabricated key looks like a successful tool call to the LLM but has zero effect on the actual build, wasting both the turn and the user's authorization.

   Failure-mode signal: any key shaped like `CNB_<TOOL>_VERSION`, `CNB_<TOOL>_<OPTION>`, `BP_<UNKNOWN>`, or `BUILD_<UNKNOWN>` that you cannot point to a specific line of the reference doc for — that's a fabrication. Stop and consult the reference doc before calling `replace_build_envs`.

   The allowed-list test is literal, not shape-based: a key is legitimate only if you can point to the exact line of the reference doc that documents it. Plausible-looking platform-style names (`DOCKER_MIRROR_URL`, `MIRROR_URL`, `REGISTRY_PROXY`, or any other invented `*_MIRROR_*` / `*_PROXY_*` / `*_REGISTRY_*` variable) are fabrications regardless of how official they sound. Build envs configure build behavior for the language runner; **no build env changes network reachability** — registry timeouts, image-pull failures, and blocked egress cannot be fixed from `build_env_dict`, so do not spend a single call trying.

   When a build failure points to something not controllable by any documented key (specific tool version mismatches, lockfile incompatibility, framework version pinning beyond what `CNB_NODE_VERSION` exposes, etc.), that's evidence the fix is **code-side**, not a missing build env. Route to `code_or_build_handoff_needed` rather than guessing env names.
10. Component connection information must be configured on the provider component with `rainbond_manage_component_connection_envs`; do not use `rainbond_manage_component_envs(scope=outer)` for that path. Consumers receive those values through explicit dependencies.
11. Explicit component dependencies are a required topology artifact, not just a runtime networking convenience. Use `rainbond_manage_component_dependency` for every declared `depends_on` edge and every inferred provider/consumer edge that bootstrap accepts into the topology. Do not claim MCP lacks a component dependency API; if the tool call fails, report the actual MCP/control-plane failure.
12. Before bootstrap can hand off as structurally complete, run a dependency completeness gate for every multi-component topology, including manual component creation or fallback paths: list accepted provider/consumer edges, query current dependency evidence, add missing edges with `rainbond_manage_component_dependency`, then verify the dependency evidence again. If an accepted edge cannot be created yet, record it as a deferred dependency or blocker instead of treating runtime reachability as sufficient.
13. Bootstrap has a retry budget: the same error signature may be retried at most once, and the same component-creation path may be attempted at most twice. After that, stop and report the blocker.
14. If runtime has already converged enough and the remaining question is access URL or delivery acceptance, hand off to `rainbond-delivery-verifier` instead of stretching bootstrap or defaulting to troubleshooter.
15. Local Docker daemon actions are not an implicit bootstrap fallback. Do not run local Docker builds, start Docker Desktop/OrbStack, push temporary images, or switch to local package upload unless the user explicitly changes the delivery strategy.
16. The final reply must end with `### Structured Output`, render `BootstrapResult` in fenced `yaml`, and never leak secret plaintext.
17. **Component creation method inference (image vs source vs complex suite).** When the user requests a component, infer the creation method from the strongest signal in their message instead of pausing to ask. Mention the inference in the final report so the user can override. First distinguish a simple single-image infrastructure service from a complex off-the-shelf app suite; the latter must not be hand-built from model memory alone.
   - User mentioned Git URL / branch / commit / `subdirectories` → **source mode**
   - User mentioned an image tag or registry path (`<name>:<tag>`, `docker.io/...`, `harbor.../...`) → **image mode**
   - User gave only a component name and that name refers to a **well-known simple infrastructure service that is commonly deployed as one main container image** (databases, message queues, caches, object stores, web servers, reverse proxies, load balancers, service registries, secret stores, etc.) → **image mode** with default `<name>:latest` (then rewritten via rule 7). Use your own general knowledge to make this judgment — do not wait for an enumerated whitelist.
   - User gave only a software/product name and that name refers to a **complex off-the-shelf app suite** (Harbor, GitLab, monitoring/observability stacks, or any product normally shipped as multiple coordinated services such as UI/API/core, registry, database, cache, worker/jobservice, proxy, scanner, metrics, etc.) → **complex suite mode**. Before any mutating MCP call, require one of: `docker-compose` / compose profile (including a project source profile with `topologySource == "compose"`), `rainbond.app.json`, an official deployment descriptor supplied by user/tool, an explicit user-confirmed deployment plan, or — only when the user explicitly chooses the template path — a Rainbond app-market template.

     **Evidence arbitration:** once `rainbond_get_project_source_profile` returns compose/manifest topology evidence (`topologySource == "compose"`, a service-list `rainbond.app.json`, or an official descriptor), the complex-suite gate is already satisfied — that profile is the authoritative topology. Do not then go hunting templates (`rainbond_query_local_app_models` / `rainbond_query_cloud_app_models`) "for more reliable evidence", and do not promote a same-named template to the default path. When the user also gave an explicit Git URL, lock the source / compose-profile path per `rainbond-app-assistant` Iron Law 38; a market template is at most a one-line suggestion. Full compose-topology mapping: `modules/40-source-and-package-rules.md` § compose.
   - User gave a business-domain name (`my-api`, `order-service`, `payment-svc`) with no further signal → only then ask "image or source?"

   Decision principle, not a list:
   - In your knowledge, is this name a mature infrastructure software project with a public container image and a credible single-service minimum deployment? → image.
   - Is it a product suite whose correct service list, dependencies, required env, storage paths, domains, TLS, or bootstrap secrets normally come from an official descriptor/template? → complex suite; stop for evidence or user confirmation before creating components.
   - Is this name in a business-domain naming style (verbs, organisation tags, concrete business concepts)? → ask.
   - Uncertain in between? → default to image (more common), mention the inference, invite override.

   Forbidden: asking "image or source?" when a clear signal is present, or when the name is obviously a public infrastructure software project (Nginx, Redis, ClickHouse, Jaeger, Loki, OpenTelemetry Collector, and equivalent newer ones). Use judgment, not enumeration.
   Also forbidden: creating a multi-component topology for a complex suite from generic model knowledge alone. If no allowed evidence exists, ask the user for a compose / official descriptor / permission to proceed with a named plan (a Rainbond template only when the user picks that path), and do not call create/update/dependency/env/storage tools yet. But if a compose/manifest profile is already in hand, the gate is met (see Evidence arbitration above) — proceed on that path, do not stall asking for more evidence.

   **Stateful service follow-up**: when image mode is chosen for a stateful service (databases, persistent queues, search engines, time-series, object stores, vector / graph stores — any service whose data must survive container restart), persistence is required before deploy.

   **Platform reality**: `rainbond_create_component_from_image` / `_from_source` do not accept `extend_method`, and the platform exposes no MCP tool to convert stateless → stateful. Image/source-mode creation always yields a stateless component. Do not waste turns trying to "make it stateful" after creation — the tools to do so do not exist.

   **What to do instead**:
   1. Call `rainbond_manage_component_storage(operation=create_volume, volume_name=<short-name>, volume_type=share-file, volume_path=<data-dir>)` to attach RWX shared-file persistence to the stateless component (`volume_name` is required — omitting it fails the call)
   2. Then `rainbond_operate_app(action=deploy)` — storage first, deploy second
   3. Do **not** attempt `volume_type=local` (platform returns HTTP 400 for stateless + local)

   **If the user genuinely needs `local` (high-IOPS database)**: the only path is `rainbond_install_app_model` from the app market with a pre-configured stateful template. Image-mode cannot reach a stateful component on the current MCP surface — report this as a delivery-mode limitation, not a step bootstrap can silently work around.

   Full data-directory list per service and `volume_type` ↔ component-type compatibility matrix live in `modules/30-creation-rules.md § 5`. Deploying a stateful service via image mode without persistence is a real data-loss regression — do not skip this step because "I'm not sure if X is stateful." If unsure, ask the user; do not default to no-persistence image deployment for anything that might store data.

18. **Deployment-plan readiness gate for multi-component image deployments.** Before any mutating MCP call for a multi-component image topology, establish provenance for the service list, dependency edges, required env/secrets, ports, storage paths, external URL/TLS assumptions, and image tags. Accepted provenance is: Rainbond template, `rainbond.app.json`, `docker-compose` / compose profile, official deployment descriptor supplied by user/tool, existing Rainbond runtime state, or explicit user-confirmed plan. Inference-only critical fields are blockers, not TODOs.

   **Explicit user source intent overrides template installs.** When the user gave a Git URL (or said "deploy this repo's source"), the deploy path is locked to the source / compose-profile path; an app-market template is a suggestion to mention, never the default to install before the user explicitly picks it. Do not install a market template and then abandon it to hand-build image components — that strands a half-installed app. If you must switch strategy, first clean up the abandoned half-built app or tell the user it exists and ask. (Enforced at the routing layer by `rainbond-app-assistant` Iron Law 38.)

19. **Source component creation prerequisites (HARD RULE).** These rules previously lived only in `modules/40-source-and-package-rules.md` and were skipped in practice; they live here because violating them wastes creation calls and user approvals.
   - **Profile before create**: when the `rainbond_get_project_source_profile` tool is available in this session (rainagent runtime), you MUST call it once for the repository before the FIRST `rainbond_create_component_from_source` of that repository, and fill creation parameters from the profile (subdirectories, default branch, dockerfile preference, ports, env keys). In CLI runtimes without that tool, derive the same facts by reading the local project files before creating. Creating source components by guess is forbidden.
   - **Always pass `code_version`**: set it to the repository's real default branch — the profile's `repo.defaultBranch` when available, otherwise the ref the user gave or the detected default. Omitting it makes the backend silently default to `master`, so any `main`-default repository fails creation and the recovery path loses the build-mode preference. Never blind-guess `master`/`main`.
   - **`create_volume` requires `volume_name`**: every `rainbond_manage_component_storage(operation=create_volume)` call must include a short explicit `volume_name`; omitting it fails the call and wastes a turn.
   - Full source/package detail remains in `modules/40-source-and-package-rules.md`; still read it before the first source-backed creation.

20. **Dockerfile base-image pulls are not platform-proxyable (HARD RULE).** In Dockerfile build mode the `FROM` images are pulled by the cluster build runtime directly from the registry written in the Dockerfile; rule 7's URL proxying does not apply (the URL lives in user code), and no build env redirects it. When a Dockerfile build fails pulling its base image (timeout / unreachable registry), that is a platform-side network blocker. The only legal moves, in order:
   1. If the language is supported by the CNB build path, propose switching that component to the language build (CNB has a working mirror mechanism) and ask the user to confirm — this changes build behavior, never switch silently.
   2. Otherwise report the blocker with the concrete options: fix the Dockerfile `FROM` to point at a reachable mirror (code-side handoff), configure a cluster-level registry mirror (platform admin), or deploy a prebuilt image instead.
   Do not invent build envs, do not retry the same build hoping the network recovers, and do not modify the Dockerfile yourself.

21. **Compose topology mapping (HARD RULE — index; full text in `modules/40-source-and-package-rules.md`).** When deploying a docker-compose topology:
   - **Compose service names are not hostnames.** Never write a compose service name (`db_postgres`, `redis`, `sandbox`, …) into a consumer `*_HOST` / `*_URL` / `*_ADDR` env — it does not resolve in Rainbond and underscored names are not valid DNS labels. Add the dependency edge (`rainbond_manage_component_dependency`), then render the host from dependency injection: consume the provider's auto-generated `{ALIAS}_HOST` (its k8s service internal domain), never a hard-coded `127.0.0.1` (that holds only under built-in-mesh governance). (dify example: `DB_HOST=db_postgres` ❌ → `DB_HOST=<db provider's injected {ALIAS}_HOST internal domain>` ✅ after wiring the dep.) Full text in `modules/40-source-and-package-rules.md`.
   - **Do not silently drop a reverse-proxy / gateway service.** If the frontend relies on same-origin path routing (relative-path API envs, or multi-upstream path forwarding), keep the proxy as a component and make it the sole external entry point (only it gets `enable_outer`; `web`/`api` stay inner-only). Omit the proxy only when it is a simple single-upstream port forwarder. **A kept proxy must NOT be deployed until its routing config (`nginx.conf` etc.) is mounted as a config-file AND every `proxy→upstream` dependency edge is wired; if either cannot be completed, report a delivery blocker instead of deploying — never deploy the proxy with its default/stock config.**
   - **Dependency edges = `depends_on` edges + env-reference edges.** Wire not only every compose `depends_on` edge but every edge where a consumer's env *value* references another component (`SANDBOX_API_ENDPOINT=http://sandbox:8194`, `DIFY_INNER_API_URL=http://api:5001`, …); `depends_on` is necessary but not sufficient. After configuring envs, enumerate per consumer the components referenced in its env values, diff against already-wired edges, and add the missing edges before deploy.
   - **`optionalServices` are not part of the default deploy set.** Deploy only `services[]`; disclose `optionalServices[]` once; prompt the user to pick one only when they ask or when the default-active set lacks a required capability.
   Full rules, decision tables, and config-sourcing details: [modules/40-source-and-package-rules.md § Compose / Multi-service Topology](modules/40-source-and-package-rules.md).

## Reading Order

Use the skill in this order:

1. Start here for fit check, hard rules, and output contract entry.
2. Read [modules/10-context-loading.md](modules/10-context-loading.md) to resolve project context, environment, config layering, and component filters.
3. Read [modules/20-scope-and-boundaries.md](modules/20-scope-and-boundaries.md) to confirm what bootstrap may and may not do.
4. Read [modules/30-creation-rules.md](modules/30-creation-rules.md) for the general bootstrap strategy.
5. Read [modules/40-source-and-package-rules.md](modules/40-source-and-package-rules.md) if **any** in-scope component is source-backed or package-backed.
6. Read [modules/50-workflow-and-convergence.md](modules/50-workflow-and-convergence.md) before executing or resuming the mainline.
7. Read [modules/60-verification-and-handoffs.md](modules/60-verification-and-handoffs.md) before deciding stop conditions, blocker buckets, or `next_handoff`.
8. Read [modules/70-output-contract.md](modules/70-output-contract.md) before writing the final reply.

Load references only when the corresponding module tells you to.

## Module Map

- [modules/10-context-loading.md](modules/10-context-loading.md)
  - 配置分层、环境选择、binding 读取、过滤 `included_components` / `excluded_components`
- [modules/20-scope-and-boundaries.md](modules/20-scope-and-boundaries.md)
  - 支持范围、delivery mode、允许动作、禁止动作、期望输入
- [modules/30-creation-rules.md](modules/30-creation-rules.md)
  - 通用创建规则、幂等策略、数据库最小启动配置、前端 `access_mode` 约束、image registry proxy prompt
- [modules/40-source-and-package-rules.md](modules/40-source-and-package-rules.md)
  - source / package 路径、GitHub proxy、build 参数路由、多服务歧义、source-path 保持规则、compose 多服务拓扑（逐服务建 / create 时定死分支+Dockerfile / 卡 CNB 需 Dockerfile 的删建特例 / compose 服务名非主机名 / 反代不可静默丢弃 / `optionalServices` 披露但不默认部署）
- [modules/50-workflow-and-convergence.md](modules/50-workflow-and-convergence.md)
  - 主线执行顺序、source convergence、`deferred_dependencies`、build/debug 读取顺序
- [modules/60-verification-and-handoffs.md](modules/60-verification-and-handoffs.md)
  - canonical vocabulary、停止条件、bootstrap 成功标准、handoff 边界
- [modules/70-output-contract.md](modules/70-output-contract.md)
  - 人类可读 section 顺序、`BootstrapResult` 组装规则、cross-field consistency

## References

These are intentionally low-frequency references. Do not load them by default unless the module tells you to.

- [references/manifest-v1-reference.md](references/manifest-v1-reference.md)
  - `rainbond.app.json` baseline example, role types, frontend access modes, v1/v2 source mapping summary
- [references/source-build-parameter-guide.md](references/source-build-parameter-guide.md)
  - current MCP-facing build keys and build-parameter routing guidance
- [references/quick-reference.md](references/quick-reference.md)
  - common mistakes, source/package shortcuts, debug order, stopping reminders

## Schemas

- [schemas/bootstrap-result.schema.yaml](schemas/bootstrap-result.schema.yaml)
  - the minimal source of truth for `BootstrapResult` field names, enum values, and nested shape

The schema is intentionally minimal in this pilot. It defines the current structured output contract; it does **not** replace the execution rules in `modules/`.

## Final Reply Contract

Every final reply must use exactly these sections, in this order:

1. `### Creation Result`
2. `### Actions Taken`
3. `### Current State`
4. `### Handoff Recommendation`
5. `### Structured Output`

Additional rules:
- `### Structured Output` must be the final section
- the fenced block under it must be valid `yaml`
- the top-level object name must be `BootstrapResult`
- `next_handoff` must agree with the prose handoff recommendation
- use canonical runtime labels such as `building`, `waiting`, `running`, `abnormal`, and `capacity-blocked`
- use canonical blocker buckets such as `source build failed`, `mcp backend issue`, `external artifact unreachable`, and `cluster capacity blocked`
- mask all secrets, certificates, private keys, and tokens

Read [modules/70-output-contract.md](modules/70-output-contract.md) before composing the final response.
