---
name: rainbond-fullstack-bootstrap
description: Use only when the next step is already known to be topology creation for the current project or manifest. Do not use as the first or default response to a generic current-project deployment request; route those to rainbond-app-assistant.
---

# Rainbond Fullstack Bootstrap

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

Use [../docs/product-object-model.md](../docs/product-object-model.md) as the repository-level source of truth for:

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

   When a build failure points to something not controllable by any documented key (specific tool version mismatches, lockfile incompatibility, framework version pinning beyond what `CNB_NODE_VERSION` exposes, etc.), that's evidence the fix is **code-side**, not a missing build env. Route to `code_or_build_handoff_needed` rather than guessing env names.
10. Component connection information must be configured on the provider component with `rainbond_manage_component_connection_envs`; do not use `rainbond_manage_component_envs(scope=outer)` for that path. Consumers receive those values through explicit dependencies.
11. Explicit component dependencies are a required topology artifact, not just a runtime networking convenience. Use `rainbond_manage_component_dependency` for every declared `depends_on` edge and every inferred provider/consumer edge that bootstrap accepts into the topology. Do not claim MCP lacks a component dependency API; if the tool call fails, report the actual MCP/control-plane failure.
12. Before bootstrap can hand off as structurally complete, run a dependency completeness gate for every multi-component topology, including manual component creation or fallback paths: list accepted provider/consumer edges, query current dependency evidence, add missing edges with `rainbond_manage_component_dependency`, then verify the dependency evidence again. If an accepted edge cannot be created yet, record it as a deferred dependency or blocker instead of treating runtime reachability as sufficient.
13. Bootstrap has a retry budget: the same error signature may be retried at most once, and the same component-creation path may be attempted at most twice. After that, stop and report the blocker.
14. If runtime has already converged enough and the remaining question is access URL or delivery acceptance, hand off to `rainbond-delivery-verifier` instead of stretching bootstrap or defaulting to troubleshooter.
15. Local Docker daemon actions are not an implicit bootstrap fallback. Do not run local Docker builds, start Docker Desktop/OrbStack, push temporary images, or switch to local package upload unless the user explicitly changes the delivery strategy.
16. The final reply must end with `### Structured Output`, render `BootstrapResult` in fenced `yaml`, and never leak secret plaintext.
17. **Component creation method inference (image vs source).** When the user requests a component, infer the creation method from the strongest signal in their message instead of pausing to ask. Mention the inference in the final report so the user can override.
   - User mentioned Git URL / branch / commit / `subdirectories` → **source mode**
   - User mentioned an image tag or registry path (`<name>:<tag>`, `docker.io/...`, `harbor.../...`) → **image mode**
   - User gave only a component name and that name refers to a **well-known piece of infrastructure software that is commonly deployed as a container image** (databases, message queues, caches, object stores, observability/monitoring agents, web servers, reverse proxies, load balancers, service registries, secret stores, etc.) → **image mode** with default `<name>:latest` (then rewritten via rule 7). Use your own general knowledge to make this judgment — do not wait for an enumerated whitelist.
   - User gave a business-domain name (`my-api`, `order-service`, `payment-svc`) with no further signal → only then ask "image or source?"

   Decision principle, not a list:
   - In your knowledge, is this name a mature infrastructure software project with a public container image? → image.
   - Is this name in a business-domain naming style (verbs, organisation tags, concrete business concepts)? → ask.
   - Uncertain in between? → default to image (more common), mention the inference, invite override.

   Forbidden: asking "image or source?" when a clear signal is present, or when the name is obviously a public infrastructure software project (Nginx, Redis, ClickHouse, Jaeger, Loki, OpenTelemetry Collector, and equivalent newer ones). Use judgment, not enumeration.

   **Stateful service follow-up**: when image mode is chosen for a stateful service (databases, persistent queues, search engines, time-series, object stores, vector / graph stores — any service whose data must survive container restart), persistence is required before deploy.

   **Platform reality**: `rainbond_create_component_from_image` / `_from_source` do not accept `extend_method`, and the platform exposes no MCP tool to convert stateless → stateful. Image/source-mode creation always yields a stateless component. Do not waste turns trying to "make it stateful" after creation — the tools to do so do not exist.

   **What to do instead**:
   1. Call `rainbond_manage_component_storage(operation=create_volume, volume_type=share-file, volume_path=<data-dir>)` to attach RWX shared-file persistence to the stateless component
   2. Then `rainbond_operate_app(action=deploy)` — storage first, deploy second
   3. Do **not** attempt `volume_type=local` (platform returns HTTP 400 for stateless + local)

   **If the user genuinely needs `local` (high-IOPS database)**: the only path is `rainbond_install_app_model` from the app market with a pre-configured stateful template. Image-mode cannot reach a stateful component on the current MCP surface — report this as a delivery-mode limitation, not a step bootstrap can silently work around.

   Full data-directory list per service and `volume_type` ↔ component-type compatibility matrix live in `modules/30-creation-rules.md § 5`. Deploying a stateful service via image mode without persistence is a real data-loss regression — do not skip this step because "I'm not sure if X is stateful." If unsure, ask the user; do not default to no-persistence image deployment for anything that might store data.

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
  - source / package 路径、GitHub proxy、build 参数路由、多服务歧义、source-path 保持规则、compose 多服务拓扑（逐服务建 / create 时定死分支+Dockerfile / 卡 CNB 需 Dockerfile 的删建特例）
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
