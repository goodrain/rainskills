---
name: rainbond-app-assistant
description: >
  Default top-level entry for a current Rainbond project request, including
  generic prompts such as deploy this project to Rainbond, run this project,
  or check what is blocking it. Use for linked projects and for unlinked
  current-project requests that may need project-init before bootstrap,
  troubleshooting, delivery verification, dev-to-test promotion, or
  code-layer handoff.
---

  # Rainbond App Assistant

  ## Overview

  Use this skill as the high-level entrypoint for a Rainbond project workflow.

  It coordinates existing lower-level skills so the user can say things like:
  - “帮我把这个项目在 Rainbond 上跑起来”
  - “帮我同步当前项目并修复它”
  - “帮我检查这个项目现在卡在哪”

  This skill does **not** replace the lower-level skills. It chooses and sequences them.

  The goal is to:
  1. load project context
  2. determine current project state
  3. decide whether sync, bootstrap, troubleshooting, delivery verification, promotion to testing, or code-layer handoff is needed
  4. drive the project toward a working state with the fewest possible user prompts

  ## Default Routing Ownership

  This skill is the repository's default top-level owner for generic current-project
  deployment, inspection, and repair requests.

  If the user says things like:
  - “帮我把当前项目部署到 Rainbond 上”
  - “帮我把这个项目跑起来”
  - “帮我看看当前项目卡在哪”
  - “如果还没初始化就先初始化，然后继续”

  then the request should start here, even when the next concrete phase later turns
  out to be `project-init`, `bootstrap`, `troubleshooter`, or `delivery-verifier`.

  Lower-level skills should only be chosen directly when the user has already made
  that narrower phase explicit.

  ## 用途速览

  这是顶层总控 skill。

  适合：
  - 用一句高层提示词推进整个 Rainbond 主线
  - 让模型自己决定是 init、bootstrap、troubleshoot、delivery verify 还是 dev-to-test promotion

  不适合：
  - 用户已经明确要求只跑某一个下层 skill
  - 已经转入代码修复任务

  语言约定：
  - 规则说明、流程说明、人类可读结论：优先中文
  - `### Structured Output` 里的对象名、字段名、enum：保持英文 canonical 形式

  ## Preflight Gate（最高优先级，先于硬规则执行）

  在读取其它 skill 文件、扫描用户项目、或调用任何业务 MCP 工具之前，必须先验证当前会话能力。

  Step 0 — Probe MCP availability：
  - 调用一个轻量探针，例如 `rainbond_query_enterprises`
  - 成功：记录 enterprise / team / region 上下文，进入"硬规则"和主线流程
  - 失败（auth / transport / timeout / not configured）：立即停止，不进入业务流程

  Preflight 失败时禁止做的事：
  - 读取其它 reference / SKILL 文件
  - 扫描用户项目目录、读取 `rainbond.app.json` 或 `.rainbond/local.json`
  - 在本地生成 `Dockerfile`、`docker-compose.yml`、`manifest`、部署脚本或临时部署文档
  - 手工编写或猜测 `~/.rainbond/mcp.env`、JWT、API token
  - 调用任何业务 MCP 工具

  Preflight 失败时必须给用户的动作建议：
  - 在 rainbond-skills 仓库根执行 `./install.sh codex` 或 `./install.sh all`
  - 安装脚本会配置 MCP server、保存 JWT、并验证 `/console/mcp/query` 可用
  - 配置完成后重新触发同一指令即可

  例外：用户在同一会话里已经成功用过任意 `rainbond_*` 工具，则视为 preflight 已通过，不必每轮重探。

  ## Installation Intent（高优先级）

  当用户的请求本身是"帮我把 rainskills / Rainbond MCP 装上"或等价表达（含 `github.com/goodrain/rainskills` URL）时，**禁止**走以下旁路：

  - 手工 `git clone` 后复制目录到 `~/.claude/skills` / `~/.codex/skills`
  - 手工编写 `~/.rainbond/mcp.env`、JWT、登录回调
  - 手工修改 `~/.claude.json` / `~/.codex/config.toml` 注册 MCP server

  必须给用户一行可直接复制的命令，由仓库内 `install.sh` 接管交互式登录、JWT 获取、MCP 注册和验证：

  ```bash
  bash <(curl -fsSL https://raw.githubusercontent.com/goodrain/rainskills/main/install.sh)
  ```

  如果用户当前会话所在仓库就是 `rainbond-skills` 本身，可建议 `./install.sh`。
  如果用户明确要求非默认仓库位置，告诉他用环境变量 `RAINBOND_SKILLS_HOME=<path>` 前置。

  说明给用户：脚本会自动克隆仓库到 `~/.rainbond/skills`、引导浏览器登录、写 `~/.rainbond/mcp.env`、注册 Codex / Claude Code 的 MCP，并验证 `/console/mcp/query`。不需要 AI 代办其中任何一步。

  ## 硬规则

  以下规则优先级最高。若后文示例、详细说明或历史注释与这里冲突，以这里为准。

  1. 只读取当前项目目录中的 `rainbond.app.json`、`.rainbond/local.json`、环境文件和 secrets 文件。
     不允许扫描 `$HOME`、上级目录或其他仓库来“补绑定”。
  2. 如果存在多个 team 或多个安全候选 app，必须先停下来让用户选；不能静默选择 `default` 或任意已有 app。
  3. 单入口主线一旦触发：
     `project-init -> bootstrap -> troubleshooter -> delivery-verifier -> version-assistant -> testing-app delivery-verifier`
     应按 gate 自动继续，不要在中途停成“下一步建议”。
  4. `project-init` 成功 linked 后，如果当前 run 是单入口部署/开发到测试主线，必须自动继续到 `bootstrap`。
5. 当前项目一旦被判定为 `source-backed`，不能静默改成 `package` 或 `image`。
   transport 代理只改“怎么拉”，不改 delivery mode。
6. 如果源码 Git URL 是原始 `https://github.com/...`，且用户没有明确给出代理地址，优先先问一次是否改用代理 URL，再继续主线。
7. 一旦 source ref 已确定，不能静默改 branch/ref。
   分支不存在时必须停住并报告 source definition needs confirmation。
8. `check_uuid` / `event_id` 默认不是标准 source create 的前置条件。
   除非后端明确返回它们必需，否则不能把它们当 blocker。
9. 如果 source create 返回 `multiple services detected` 或等价的多组件源码歧义，必须停住，要求用户明确选择策略。
   不允许自动切到 local package、手工上传、模板安装或其他 workaround。
10. 如果进入 `code_or_build_handoff_needed`，必须硬停止。
   不允许自动改代码、跑本地测试、commit、push、自动重试。
11. `delivery_state` 只表示 source app。
      在没有运行 `delivery-verifier` 之前必须是 `null`。
      `promotion_result` 只表示 snapshot 和 testing app；未进入 promotion 时必须是 `null`。
12. 顶层主线必须有尝试预算：
    - 同一类错误签名最多重试 1 次
    - 同一阶段最多尝试 2 次（首次 + 1 次重试）
    - 单次主线总时长默认不应超过 8 分钟；超时后必须停止并汇报当前停点。
13. 任何 delivery mode 或 workaround 策略切换都不允许隐式发生。
    source -> package、source -> image、source -> template 都必须先得到用户明确确认。
14. 如果用户明确在问“为什么构建失败”，顶层必须优先走 `component events -> build logs -> runtime logs` 的构建失败证据链。
    不要把运行容器日志当第一现场。
15. 如果用户要求调整源码构建参数，优先走 `rainbond_manage_component_envs(operation=replace_build_envs, build_env_dict=...)`。
    不要把语言构建参数塞进 `build_info`。
16. 如果源码检测同时命中 Dockerfile 和语言构建，只有用户明确要走 Dockerfile 时才建议 `prefer_dockerfile_when_detected = true`。
17. 当前 MCP 不支持显式 `dockerfile_path` 时，不要在顶层编排里承诺该能力。
18. 对 reverse-proxy full-stack 项目，不要只因为根路径 URL 存在就把它当作最终交付成功或 Fast Path 的可信 URL；同 host 的 backend 路径（通常是 `/api`）必须也一致可用，或明确停在 blocker。
19. 对数据库、Redis、Kafka 等中间件，优先把共享连接变量建在 provider 组件的 connection envs 上，并通过显式依赖注入到 consumer；不要优先在每个 consumer 上重复写 `DB_*`、`REDIS_*`、`KAFKA_*` 连接变量。
20. 如果依赖关系已经存在，但运行时仍出现 `ENOTFOUND db`、错误 host、错误 port、缺少 `DB_PASS` 等问题，优先把问题视为 provider connection env / dependency alias / compatibility env 问题，而不是把 baseline 里的硬编码主机名当作正确事实。
21. Rainbond MCP 已提供 `rainbond_manage_component_dependency` 用于显式组件依赖管理。只要项目拓扑存在 `depends_on`、provider/consumer 关系、反向代理链路、或运行时日志暴露出缺失依赖，就必须把显式依赖作为可执行能力处理；禁止回答“当前 MCP 没有创建组件依赖接口”。如果调用失败，按 MCP/控制面错误报告失败原因，而不是把它描述为工具不存在。
22. 对多组件拓扑，在进入最终交付验收前必须确保下层 bootstrap/troubleshooter 已完成依赖完整性 gate：列出已接受的 provider/consumer 边，查询现有依赖，补齐缺失显式依赖，再次验证依赖摘要。手工创建镜像组件、Compose 上传失败后的 fallback 路径、或组件本身能独立启动，都不能跳过这个 gate。
23. 不要自动拉起本地 Docker Desktop/OrbStack、执行本地 Docker build/push、或推送临时镜像作为兜底；这属于 delivery-mode 策略切换，必须先得到用户明确确认。
24. 每次运行内部仍必须形成 `AppAssistantResult` 结果对象，但默认用户答复不一定暴露 YAML。
    当 source app 已严格 `delivered`、`next_action = stop`、没有 promotion、没有 blocker，且用户没有要求结构化/调试输出时，默认使用简洁中文交付报告，不追加 `### Structured Output`。
25. 只有在自动化/评测/调试模式、用户明确要求结构化输出、结果未完全交付、需要人工验证、需要 handoff、或进入 dev-to-test promotion 时，才把 `AppAssistantResult` 渲染为最终 fenced `yaml`。
26. 如果本次使用了 Git、镜像仓库或其他传输代理，必须在默认交付报告的处理记录或注意事项中说明；在结构化模式下也必须写入 `actions_performed[].details`。
    代理事实属于执行记录，不是强制暴露 YAML 的理由。

  ## 主线流程

  1. 读取当前项目目录的本地绑定和 manifest，解析 team / region / app / environment。
  2. 如果 unlinked，执行 `rainbond-project-init`。
  3. 如果 linked 但 topology 不存在，执行 `rainbond-fullstack-bootstrap`。
  4. 如果 topology 已存在但 runtime 还没收敛，执行 `rainbond-fullstack-troubleshooter`。
  5. 如果 runtime 已足够健康且剩余问题只是交付判断，执行 `rainbond-delivery-verifier`。
  6. 如果用户明确要求开发到测试主线，且 source app 严格达到 `delivered`，才自动进入：
     `rainbond-app-version-assistant -> testing app -> rainbond-delivery-verifier`
  7. 最终返回一个 `AppAssistantResult`，顶层 `project` 仍然表示 source app。

  ## 停止条件

  以下情况必须停住，不再自动往下：

  - 项目未链接，且 init 还没有完成
  - team / app 选择仍然有歧义
  - source ref 无效
  - 多组件源码检测需要显式策略选择
  - MCP / 控制面后端异常
  - `delivery-verifier` 结果只是 `delivered-but-needs-manual-validation`
  - 进入 `code_or_build_handoff_needed`

  ## Canonical Model Reference

  Use `docs/product-object-model.md` as the repository-level source of truth for:

  - `Project` and `Environment` context boundaries
  - `RuntimeState` distinctions such as topology missing, topology building, and runtime unhealthy
  - `DeliveryState` outcomes such as delivered, delivered-but-needs-manual-validation, partially-delivered, and blocked
  - version-flow handoff boundaries into snapshot, release, and rollback operations

  This skill should orchestrate transitions across those shared objects and states. It should not redefine their canonical boundaries independently.

  ## Contract Surface

  This skill now has a live orchestration-level contract surface under:

  - `schemas/app-assistant-result.schema.yaml`
  - `scripts/validate_app_assistant_output.py`
  - `scripts/run_app_assistant_evals.py`
  - `evals/*.response.md`

  Scope note:

  - `AppAssistantResult` is the top-level orchestration contract for this skill
  - `delivery_state` is a consumed summary of `rainbond-delivery-verifier` output, not a redefinition of delivery-verifier rules
  - `promotion_result` is only a gated summary of the version/promotion flow after explicit dev-to-test intent and source-app `delivered`
  - bootstrap / troubleshooter / delivery-verifier contract details remain owned by their own schema + validator + eval surfaces

  ## When to Use

  Use when:
  - a current project should be brought up in Rainbond end-to-end, whether linked or not yet linked
  - the user gives a generic current-project deployment, run, inspection, or continue-the-mainline request
  - a linked project should be brought up in Rainbond end-to-end
  - the user wants a single entrypoint instead of manually choosing bootstrap or troubleshooting
  - the next action is unclear and depends on project state
  - the user wants the assistant to decide whether to sync env, create topology, diagnose runtime issues, verify delivery, or promote a delivered source app into a testing app
  - the user wants one top-level prompt to carry the project as far as the current strict gate allows

  Do not use when:
  - the user explicitly asks to run only one specific lower-level skill
  - the task is only to inspect a single known runtime issue and no orchestration is needed
  - the project is unrelated to Rainbond deployment
  - the task is a pure code refactor with no Rainbond interaction

  ## Managed Lower-Level Skills

  This skill orchestrates:
  - `rainbond-project-init`
  - `rainbond-env-sync`
  - `rainbond-fullstack-bootstrap`
  - `rainbond-template-installer`
  - `rainbond-fullstack-troubleshooter`
  - `rainbond-delivery-verifier`
  - `rainbond-app-version-assistant`

  This skill may also recommend handoff to:
  - a code/build agent
  - a frontend fix flow
  - a reverse-proxy/build configuration fix flow

  ## Input Model

  This skill should prefer local project files and explicit user input over repeated questioning.

  Configuration layers:
  1. user explicit input
  2. `.rainbond/secrets.preview.json` or `.rainbond/secrets.prod.json`
  3. `.rainbond/env.preview.json` or `.rainbond/env.prod.json`
  4. `.rainbond/local.json`
  5. `rainbond.app.json`

  Use these roles:
  - `rainbond.app.json`: project topology baseline
  - `.rainbond/local.json`: project binding and runtime mapping context
  - `.rainbond/secrets.*.json`: local-only secret source
  - `.rainbond/env.*.json`: non-sensitive environment delta reference
  - Rainbond MCP: runtime truth
  - `template` source or explicit template-install intent: app-model installation path

  ## Decision Rules

  ### 1. Link check first
  Before doing any deployment or repair work:
  - check whether `.rainbond/local.json` exists
  - check whether local binding identity is present
  - if `.rainbond/local.json.metadata.status == linked`, treat the project as linked
  - if local metadata is not `linked` but current-run MCP/runtime confirmation proves the same app identity exists and is accessible, continue as linked and record the local metadata drift explicitly instead of stopping
  - stop and ask for project linking only when neither local binding nor current-run MCP evidence can confirm a linked project state

  ### 2. Environment selection
  Select environment in this order:
  - user explicit input
  - `.rainbond/local.json.preferences.default_environment`
  - `preview`

  ### 3. Sync is optional, not automatic by default
  Do not always sync first.

  Run `rainbond-env-sync` when:
  - env file is missing
  - env file is clearly stale
  - the user explicitly asks to sync
  - troubleshooting would benefit from fresher env intent

  Do not block bootstrap or troubleshooting only because sync was not run.

  ### 3.1 Secret source check
  Before bootstrap or other execution that requires sensitive values:
  - check whether required secrets are available from user explicit input or `.rainbond/secrets.<environment>.json`
  - if required secret source is missing, stop and ask for local secret input rather than continuing blindly

  ### 4. Decide whether bootstrap is needed
  Bootstrap is needed when:
  - the app does not exist
  - the app exists but required components are missing
  - runtime components were intentionally cleared
  - project topology is not yet established in Rainbond

  Do not run bootstrap when:
  - the topology already exists and the problem is runtime-only

  ### 4.1 Decide whether template installation is needed
  Template installation is needed when:
  - the user explicitly asks to install from a local template, cloud market, app market, or app model
  - the current project or resolved design marks the next delivery step as `template`
  - the workflow is “install a template into an app” rather than “create raw components”

  Prefer `rainbond-template-installer` instead of `rainbond-fullstack-bootstrap` when:
  - template metadata is already known or can be queried
  - the target action is app-model installation

  Do not run template installer when:
  - the task is direct component creation from image or source
  - template metadata is completely absent and no template-install intent was given

  ### 5. Decide whether troubleshooting is needed
  Troubleshooting is needed when:
  - bootstrap stops with runtime blockers
  - the app exists but is not fully healthy
  - source-backed components are still building and need convergence inspection
  - components are `abnormal`, `waiting`, or otherwise runtime-unhealthy
  - the user asks to “修复” or “恢复服务”

  Do **not** treat these as troubleshooting by default:
  - a frontend-only or docs-style app whose container is already `running` but still lacks a preferred external access URL
  - a source app that appears runtime-healthy and only needs final delivery judgment

  In those cases, prefer `rainbond-delivery-verifier`.

  ### 5.1 Build-failure-first routing
  If the user explicitly asks why a source-backed component failed to build, or current evidence already points to build failure:
  - route to `rainbond-fullstack-troubleshooter`
  - inspect component events first
  - derive the failing build/deploy `event_id`
  - read build logs before runtime container logs
  - only continue to runtime logs when build evidence no longer explains the failure
  - if the user wants to tune source build parameters, prefer `replace_build_envs` over `build_info`

  ### 6. Decide whether code/build handoff is needed
  Recommend code/build handoff when:
  - frontend uses invalid browser-side host like `localhost`
  - build-time env mistakes are detected
  - reverse-proxy or nginx config is missing or wrong
  - root cause is clearly in source code, build output, or web serving config
  - lower-level Rainbond repairs have already restored db/api but frontend access still fails

  Hard stop rule:
  - once the run reaches `code_or_build_handoff_needed`, stop the Rainbond mainline there
  - do not automatically modify local source code
  - do not automatically run local quality gates such as `go test`, `go build`, `go vet`, `npm test`, or similar
  - do not automatically commit, push, or retry with a changed source tree
  - only continue into code changes if the user explicitly switches the task from Rainbond orchestration to code repair

  ### 7. Decide whether post-delivery promotion is needed
  Post-delivery promotion is needed when:
  - the user explicitly asks for the development-to-testing mainline
  - the user asks to create a testing app from the current delivered app
  - the user asks for snapshot creation plus a new testing app

  Strict gate:
  - only auto-continue into `rainbond-app-version-assistant` when `rainbond-delivery-verifier` has already returned `DeliveryState = delivered`
  - if delivery result is only `delivered-but-needs-manual-validation`, stop and report that manual validation is still required before automatic promotion
  - do not auto-enter version flow from `partially-delivered`, `blocked`, or any non-final runtime state

  ### 8. Normalize single-entry mainline intent
  Treat the user as asking for the full positive mainline when the request clearly means:
  - deploy this project to Rainbond and get it ready for testing
  - run the development-to-testing flow
  - deploy, verify, snapshot, and create a testing app

  In that case:
  - start from the top-level orchestration entrypoint
  - continue automatically across lower-level skills until the current strict gate says stop
  - do not require the user to rephrase into bootstrap, troubleshooter, delivery-verifier, or version-center steps

  ## High-Level Workflow

  Follow this order.

  1. Resolve context and intent
  - read user explicit goal
  - read `.rainbond/local.json`
  - read `rainbond.app.json`
  - read environment file for selected environment if present
  - scope all local file reads to the current project directory only
  - do not search the user's home directory or sibling repositories for alternate Rainbond bindings or manifests
  - determine whether the user asked only for source-app deployment or explicitly asked for the dev-to-test mainline
  - treat Docker registry mirrors and Git proxy URLs in the prompt as transport hints, not as permission to replace a source-backed project with an image-backed component
  - if the current source-backed project uses a raw `https://github.com/...` URL and no explicit proxy URL was provided, ask once whether to keep the raw URL or switch to a GitHub proxy URL before bootstrap
  - if the project is a monorepo, preserve repository-root build context intent when component builds depend on root-level lockfiles or project metadata
  - determine:
    - team_name
    - region_name
    - app_name
    - app_id
    - selected environment

  2. Assess project state
  Classify into one of these states:
  - `unlinked`
  - `linked-but-not-synced`
  - `linked-and-template-install-needed`
  - `linked-and-topology-missing`
  - `linked-and-topology-building`
  - `linked-and-cluster-capacity-blocked`
  - `linked-and-topology-present-but-runtime-unhealthy`
  - `linked-and-needs-delivery-verification`
  - `linked-and-healthy`
  - `linked-and-ready-for-promotion`
  - `linked-and-needs-code-handoff`

  Mapping note:
  - these are orchestration states, not replacements for canonical `RuntimeState` or `DeliveryState`
  - `linked-and-topology-missing` maps to `RuntimeState = topology_missing`
  - `linked-and-topology-building` maps to `RuntimeState = topology_building`
  - `linked-and-cluster-capacity-blocked` maps to `RuntimeState = capacity_blocked`
  - `linked-and-topology-present-but-runtime-unhealthy` maps to `RuntimeState = runtime_unhealthy`
  - `linked-and-needs-code-handoff` maps to `RuntimeState = code_or_build_handoff_needed`
  - `linked-and-needs-delivery-verification` is a handoff state that usually follows `RuntimeState = runtime_healthy` and precedes a final `DeliveryState`
  - `linked-and-healthy` should only be used once delivery has effectively reached `DeliveryState = delivered`
  - `linked-and-ready-for-promotion` should only be used when the user has asked for dev-to-test promotion and the source app has already reached `DeliveryState = delivered`
  - classify `linked-and-cluster-capacity-blocked` only when current-run MCP/runtime evidence still shows active scheduling failure caused by cluster resource shortage
  - if historical events mention `Unschedulable` but current node capacity and current component/app state no longer support an active capacity blocker, do not keep the project in `linked-and-cluster-capacity-blocked`; classify from the current dominant runtime state instead

  3. Choose next action
  - `unlinked` -> run `rainbond-project-init`
  - `linked-but-not-synced` -> optionally run `rainbond-env-sync` if needed
  - `linked-and-template-install-needed` -> run `rainbond-template-installer`
  - `linked-and-topology-missing` -> run `rainbond-fullstack-bootstrap`
  - `linked-and-topology-building` -> run `rainbond-fullstack-troubleshooter`
  - `linked-and-cluster-capacity-blocked` -> stop and recommend platform capacity action
  - `linked-and-topology-present-but-runtime-unhealthy` -> run `rainbond-fullstack-troubleshooter`
  - `linked-and-needs-delivery-verification` -> run `rainbond-delivery-verifier`
  - `linked-and-ready-for-promotion` -> run `rainbond-app-version-assistant`, then `rainbond-delivery-verifier` on the created testing app
  - `linked-and-needs-code-handoff` -> stop and recommend code/build fix
  - `linked-and-healthy` -> report healthy and stop

  4. Sequence lower-level skills
  If `rainbond-project-init` is run:
  - review init result
  - if init is incomplete, stop there
  - if init completes and the user asked to continue, proceed into `rainbond-fullstack-bootstrap`
  - if init completes during a top-level single-entry deploy or dev-to-test mainline run, proceed into `rainbond-fullstack-bootstrap` automatically
  - do not stop the overall app-assistant run at the init boundary unless the user explicitly asked to stop after initialization

  If `rainbond-template-installer` is run:
  - review install result
  - if template installation succeeds but the resulting app is unhealthy, continue into `rainbond-fullstack-troubleshooter`
  - if installation cannot proceed because template metadata is incomplete, stop and report the missing fields
  - do not fall back to `rainbond-fullstack-bootstrap` unless the user explicitly changes intent away from template install

  If bootstrap is run:
  - review bootstrap result
  - if bootstrap reports deferred dependencies because source-backed targets have not converged, treat the project as `linked-and-topology-building`
  - if bootstrap reports a source-build failure or source-create failure, keep the source execution path in reasoning; do not reinterpret the same component as image-backed unless the user explicitly changed the source definition
  - if bootstrap reports `external artifact unreachable`, keep the original delivery mode, stop at code/build handoff, and ask for reachable artifact/registry access or an explicit user-approved mirror/strategy change
  - if bootstrap reports an invalid source ref or missing branch, stop and report that the source definition itself needs confirmation; do not rewrite the branch automatically
  - do not block source-backed bootstrap only because `check_uuid` or `event_id` is absent unless the backend explicitly reports those fields as required
  - if bootstrap reports multi-component source detection, stop and ask for an explicit execution-path decision; do not automatically switch to local package or other workaround paths
  - if bootstrap reports `mcp backend issue`, stop and report that the control plane must be repaired before bootstrap can continue
  - if bootstrap says handoff to troubleshooter is needed, continue into troubleshooting in the same high-level flow unless
  the user asked to stop after creation
  - if bootstrap says the runtime is converged enough and the remaining question is delivery acceptance, continue into `rainbond-delivery-verifier`

  If troubleshooting is run:
  - if troubleshooting identifies a cluster capacity blocker, stop and report that platform capacity must be restored before continuing
  - review troubleshooting result
  - if troubleshooting identifies `external artifact unreachable`, stop and report the unreachable artifact or registry evidence; do not run local Docker or switch delivery mode automatically
  - if troubleshooting identifies a code/build issue, stop and hand off
  - if troubleshooting reaches `runtime_healthy`, or reaches the point where the remaining question is delivery acceptance rather than further repair, continue into `rainbond-delivery-verifier`

  If `rainbond-delivery-verifier` is run:
  - review delivery result
  - if the project is a reverse-proxy full-stack app and the root URL works but the same-host API path still fails, do not report success; keep the result blocked or route back to troubleshooting
  - if delivery outcome is `delivered` and the user did not ask for promotion, report success
  - if delivery outcome is `delivered` and the user explicitly asked for the development-to-testing mainline, continue into `rainbond-app-version-assistant`
  - if delivery outcome is `delivered-but-needs-manual-validation`, stop and report that explicitly
  - if delivery is blocked by runtime or platform issues, route back to the correct blocker category rather than pretending success

  If `rainbond-app-version-assistant` is run:
  - inspect version center first
  - create a snapshot from the delivered source app
  - create a new testing app directly from that snapshot
  - then run `rainbond-delivery-verifier` against the created testing app
  - if testing app delivery reaches `delivered` or `delivered-but-needs-manual-validation`, report the testing app identity and validation handoff summary
  - if testing app delivery is `blocked` or `partially-delivered`, stop and report that the testing app needs follow-up troubleshooting
  - do not recurse by treating the testing app as a new source app inside the same run

  5. Final report
  Always end with:
  - current project state
  - what actions were performed
  - the current canonical runtime or delivery outcome when one is available
  - the next most appropriate action
  - in `### Project State`, explicitly include the exact `orchestration_state` label in prose
  - in `### Current Health`, explicitly include the exact `runtime_state.phase` label in prose

  ## Autonomy Rules

  This skill should reduce unnecessary user confirmations.

  Safe-to-continue actions:
  - reading local config files
  - reading MCP runtime state
  - running env sync
  - running template installer when source, version, and target app context are already resolved
  - running bootstrap
  - continuing automatically from successful `rainbond-project-init` into `rainbond-fullstack-bootstrap` during a single-entry mainline run
  - running troubleshooter
  - running delivery verifier after create/install/repair stages
  - running app-version-assistant after strict `delivered` has been verified and the user explicitly asked for development-to-testing promotion
  - continuing automatically from bootstrap to troubleshooter when bootstrap explicitly recommends that handoff
  - continuing automatically from template install to troubleshooter when installation succeeded but health is still abnormal
  - continuing automatically from troubleshooter to delivery verifier when the remaining question is delivery completion
  - continuing automatically from strict `delivered` into snapshot creation, testing-app creation, and testing-app delivery verification when the user explicitly asked for promotion
  - completing classification and emitting the final structured report even when a downstream skill was intentionally skipped by user request

  Not safe to continue automatically:
  - editing source files after `code_or_build_handoff_needed`
  - running local build or test commands as a substitute for the Rainbond mainline after `code_or_build_handoff_needed`
  - committing or pushing code after `code_or_build_handoff_needed`
  - re-triggering bootstrap with modified source code unless the user explicitly asked to switch into a code-repair task
  - retrying the same stage a third time after the same error signature already occurred twice
  - changing delivery mode or workaround strategy without explicit user confirmation

  Continuation rule:
  - once the next safe action is determined, continue automatically instead of asking whether to continue
  - but stop immediately when the run hits its attempt budget, even if the higher-level goal is still unfinished
  - do not end the reply with a redundant confirmation request unless one of the pause conditions below is actually active

  Pause and ask the user only when:
  - the project is not linked
  - required identity is still ambiguous after reading local files
  - multiple accessible teams or multiple safe app targets exist and explicit user selection is required
  - the user’s request conflicts with current state
  - the next action is destructive or outside the supported scope
  - the cluster is capacity-blocked and a human must decide whether to scale capacity or reduce requests
  - a required secret source is missing
  - a code/build handoff is required and the user has not asked for code changes

  ## Output Format

  Result model and presentation modes:

  - this skill must emit `AppAssistantResult`
  - minimum target fields:
    - `project`
    - `environment`
    - `request_intent`
    - `execution_path`
    - `orchestration_state`
    - `runtime_state`
    - `delivery_state`
    - `actions_performed`
    - `next_action`
  - optional extension field:
    - `promotion_result`
  - `AppAssistantResult` is always the internal result model for routing, validation, and downstream automation
  - the user-facing reply has two presentation modes:
    - concise delivery report mode
    - structured contract mode

  ### Concise delivery report mode

  Use this mode by default when all of the following are true:
  - `request_intent = source_app_delivery`
  - `delivery_state.status = delivered`
  - `delivery_state.verification_mode = verified`
  - `next_action = stop`
  - `promotion_result = null`
  - there is no unresolved `runtime_state.blocker` or `delivery_state.blocker`
  - the user did not explicitly request structured output, YAML, JSON, debug output, or machine-readable output
  - this is not an eval/automation capture that needs deterministic schema validation

  In concise delivery report mode:
  - do not append `### Structured Output`
  - do not expose the fenced YAML block
  - keep the report short and directly useful to the user
  - include the access URL prominently
  - include component status and verification evidence
  - include proxy/mirror usage when it affected the deployment
  - include warnings that matter after delivery, such as development-only database auth or missing production persistence

  Default concise section order:
  - `### 部署结果`
  - `### 应用信息`
  - `### 组件状态`
  - `### 验证结果`
  - `### 处理记录` when non-trivial fixes, proxy changes, or local binding updates occurred
  - `### 注意事项` when there are production-readiness caveats

  Example concise delivery reply:

  ```markdown
  ### 部署结果
  已部署到 Rainbond 开发环境，访问地址：http://example.14.103.233.199.nip.io

  ### 应用信息
  - Team：开发环境 / kz5igqh4
  - Region：rainbond
  - App：spring-postgres-dev
  - App ID：180

  ### 组件状态
  - db：RUNNING，镜像使用代理 `m.daocloud.io/docker.io/library/postgres:17`
  - backend：RUNNING，源码使用代理 `https://ghfast.top/https://github.com/docker/awesome-compose.git?dir=spring-postgres/backend`

  ### 验证结果
  外部 8080 URL 已返回 Spring 页面，内容包含 `Hello from Docker!`。

  ### 处理记录
  - 已补充 `rainbond.app.json` 和 `.rainbond/local.json`
  - Compose 导入不可用，已改为显式创建 `db` 和 `backend`
  - 后端内存已调到 1024Mi，数据库地址已改为 Rainbond 内部服务名

  ### 注意事项
  开发环境数据库当前使用 `POSTGRES_HOST_AUTH_METHOD=trust`，不适合生产。
  ```

  ### Structured contract mode

  Use this mode when any of the following is true:
  - the user asks for structured output, YAML, JSON, debug details, or machine-readable output
  - an eval, wrapper, or automation flow needs deterministic schema validation
  - `delivery_state.status` is not `delivered`
  - `delivery_state.verification_mode` is `inferred` or `manual_validation_needed`
  - `next_action` is not `stop`
  - `promotion_result` is non-null or the user requested dev-to-test promotion
  - there is any unresolved blocker or handoff
  - another skill or wrapper will consume the result as input

  In structured contract mode:
  - the human-readable sections below are the narrative view over `AppAssistantResult`
  - the reply must end with a final `### Structured Output` section
  - the `### Structured Output` section must render `AppAssistantResult` in fenced `yaml`
  - the literal section order must be:
    - `### Project State`
    - `### Actions Performed`
    - `### Current Health`
    - `### Blocking Issue`
    - `### Next Step`
    - `### Structured Output`
  - each heading above must be rendered literally, including the leading `###`
  - headings such as `Project State` without `###`, translated heading labels, or `Structured Output` without the exact heading marker are contract failures
  - the fenced `yaml` block must appear immediately under `### Structured Output`
  - omitting the final structured block, changing its object name, or placing later prose after it is a contract failure

  Proposed schema:

  ```yaml
  AppAssistantResult:
    project:
      identity:
        team_name: string
        region_name: string
        app_name: string
        app_id: string | null
      linked: boolean
      selected_environment: preview | production
    environment:
      name: preview | production
      source: explicit | local_preference | default
      env_delta_present: boolean
      secrets_provided: boolean
    request_intent: source_app_delivery | dev_to_test_promotion
    execution_path:
      requested_kind: source | image | package | template | unknown
      resolved_kind: source | image | package | template | unknown
    orchestration_state: string
    runtime_state:
      phase: topology_missing | topology_building | runtime_unhealthy | runtime_healthy | capacity_blocked | code_or_build_handoff_needed | null
      db_status: building | waiting | running | abnormal | capacity-blocked | null
      api_status: building | waiting | running | abnormal | capacity-blocked | null
      frontend_status: building | waiting | running | abnormal | capacity-blocked | null
      blocker: string | null
    delivery_state:
      status: delivered | delivered-but-needs-manual-validation | partially-delivered | blocked
      preferred_access_url: string | null
      verification_mode: verified | inferred | manual_validation_needed | null
      blocker: string | null
      verifier_next_action: stop | manual_url_validation | run_troubleshooter | fix_cluster_capacity_first | code_build_handoff | null
    promotion_result:
      status: blocked | snapshot_created | testing_app_created | testing_app_verified
      snapshot:
        version_id: string | null
        version: string | null
        alias: string | null
      testing_app:
        team_name: string | null
        region_name: string | null
        app_name: string | null
        app_id: string | null
      testing_delivery_state:
        status: delivered | delivered-but-needs-manual-validation | partially-delivered | blocked
        preferred_access_url: string | null
        verification_mode: verified | inferred | manual_validation_needed | null
        blocker: string | null
        verifier_next_action: stop | manual_url_validation | run_troubleshooter | fix_cluster_capacity_first | code_build_handoff | null
    actions_performed:
      - skill: string
        status: string
        details: string
    next_action: string
  ```

  Construction rules:

  - `project.identity`
    - comes from the resolved current-run identity after applying explicit input, local binding, and manifest context
  - `project.linked`
    - must reflect whether current-run context confirms a linked project state
    - do not force `false` only because local metadata is stale when MCP confirms the same bound app in the current run
  - `project.selected_environment`
    - must match the resolved environment for the current run
  - `environment`
    - must describe the selected environment and whether env/secrets layers are present enough to matter to orchestration
  - `request_intent`
    - must normalize whether the run is only for the source app or explicitly asks for the dev-to-test promotion flow
  - `execution_path`
    - must preserve the requested and resolved delivery path
    - if the run is source-backed, `resolved_kind` must stay `source` unless the user explicitly changed delivery mode
  - `orchestration_state`
    - remains the workflow label used by the assistant
  - `runtime_state.phase`
    - must use canonical runtime labels
  - `runtime_state.db_status`, `api_status`, `frontend_status`
    - must be based on current runtime evidence when available
    - must use the canonical vocabulary `building`, `waiting`, `running`, `abnormal`, or `capacity-blocked`
    - map statuses by actual role presence rather than filling every lane mechanically
    - for frontend-only or docs-style projects, keep `api_status = null` unless a real service/API component exists
    - for service-only projects with no user-facing frontend component, keep `frontend_status = null` unless a real frontend/access component exists
    - do not emit raw platform labels such as `closed` as component status; translate them to the closest canonical status from the same evidence
    - if raw status is `closed`, `closed` is never allowed in the canonical field
    - raw `closed` or `undeploy` plus active unschedulable CPU/memory evidence maps to `capacity-blocked`
    - raw `closed` plus crash, probe, dependency, image-pull, or other runtime failure evidence maps to `abnormal`
    - raw app-level labels must not override stronger current component-level evidence
  - `runtime_state.blocker`
    - must capture the dominant unresolved blocker when one exists
    - prefer the blocker supported by current-run MCP/runtime truth over stale historical events when they disagree
  - `delivery_state`
    - may be `null` if delivery verifier has not run yet
    - must remain `null` when this run stopped before entering `rainbond-delivery-verifier`
    - must always describe the source app only, even when testing-app promotion later succeeds
    - should relay the lower-level delivery-verifier result instead of inventing a separate top-level delivery taxonomy
  - `promotion_result`
    - must remain `null` unless the user explicitly asked for development-to-testing promotion
    - must describe snapshot and testing-app outcomes without replacing the source-app meaning of the top-level `project`
    - must only be populated automatically after strict `delivery_state.status = delivered`
    - should advance monotonically through `snapshot_created` -> `testing_app_created` -> `testing_app_verified`, or stop at `blocked`
  - `actions_performed`
    - should list the lower-level skills actually invoked or explicitly skipped when relevant to the next step
    - if no lower-level skill was run, still record the inspection/classification pass and any intentionally skipped downstream skills that matter to the recommendation
  - `next_action`
    - must be the normalized form of the prose next-step recommendation

  Consistency rules:

  - `orchestration_state` and `runtime_state.phase` may differ in wording but must not conflict semantically
  - if current-run MCP evidence confirms the app exists and the dominant blocker is runtime/platform capacity, do not downgrade the project to unlinked solely because local metadata still says `pending_verification`
  - do not classify the project as `capacity_blocked` based only on old `Unschedulable` events when current node capacity and current app/component state indicate another blocker is now dominant
  - if app-level runtime labels say `closed` but current component evidence shows active capacity scheduling failure, canonical component status must still be `capacity-blocked`
  - only use `abnormal` for raw `closed` when no stronger canonical state can be supported from current evidence
  - if the app is still `part_running` due to a critical capacity blocker, `next_action` must not point to delivery verification
  - if delivery verifier has not run, do not invent a non-null delivery outcome
  - if the run stopped during `project-init`, `bootstrap`, or `troubleshooter`, `delivery_state` must be `null`
  - if the source app is runtime-healthy enough that the remaining issue is outer access or final URL selection, prefer `linked-and-needs-delivery-verification` over `linked-and-topology-present-but-runtime-unhealthy`
  - for reverse-proxy full-stack apps, do not treat a frontend root URL alone as a trustworthy final outcome if the same-host backend path is still unverified or failing
  - if a component was resolved as source-backed earlier in the same run, do not silently rewrite the reasoning as image-backed after a source-create or source-build failure
  - if a source ref was resolved earlier in the same run, do not silently rewrite it to another branch
  - do not treat missing optional source-create passthrough fields such as `check_uuid` or `event_id` as a blocker unless the backend explicitly requires them
  - if source detection reports multiple services/components, do not automatically pivot into local package, local build, manual upload, or template-install workaround flows without explicit user confirmation
  - if a GitHub source URL is still raw `https://github.com/...`, the assistant may ask once whether to use `https://ghfast.top/https://github.com/...` or `https://gh.rainbond.cc/https://github.com/...`, but must not silently rewrite the Git URL without either explicit user input or a repo-local proxy URL already present
  - transport hints for registry or Git mirrors must not be treated as a delivery-mode override unless the user explicitly asked to switch to image deployment
  - external artifact download failures, image layer pull timeouts, Docker Hub timeouts, and GitHub Release asset download failures should be reported as `external artifact unreachable` when that is the dominant evidence
  - if bootstrap reports `mcp backend issue`, do not classify the result as `linked-and-needs-code-handoff`; stop with the source app still incomplete and report the backend capability failure explicitly
  - if `delivery_state.status = delivered-but-needs-manual-validation`, `promotion_result` must stay `null` and `next_action` must not auto-enter version flow
  - if runtime logs show hard-coded dependency coordinates such as `db`, but current dependency wiring provides provider connection envs or alias-based connection envs, prefer provider connection contract repair, then compatibility-env troubleshooting, over accepting the hard-coded value as authoritative
  - if `promotion_result` is non-null, `delivery_state.status` must already be `delivered`
  - if `promotion_result.testing_delivery_state` is non-null, `promotion_result.testing_app.app_id` must also be non-null
  - for frontend-only or docs-style projects, do not mirror the same frontend component status into `api_status`
  - do not upgrade top-level `delivery_state` from `delivered-but-needs-manual-validation` to `delivered` only because the testing app later verified successfully
  - if testing-app verification ends in `blocked` or `partially-delivered`, `next_action` should point to troubleshooting the testing app rather than re-running the whole mainline
  - no secret values may appear in the structured object

  Example object:

  ```yaml
  AppAssistantResult:
    project:
      identity:
        team_name: rainbond-demo
        region_name: singapore
        app_name: storefront
        app_id: app-4fd2
      linked: true
      selected_environment: preview
    environment:
      name: preview
      source: local_preference
      env_delta_present: true
      secrets_provided: true
    request_intent: source_app_delivery
    execution_path:
      requested_kind: source
      resolved_kind: source
    orchestration_state: linked-and-topology-present-but-runtime-unhealthy
    runtime_state:
      phase: runtime_unhealthy
      db_status: running
      api_status: running
      frontend_status: abnormal
      blocker: frontend waiting on nginx host config
    delivery_state:
      status: blocked
      preferred_access_url: null
      verification_mode: null
      blocker: frontend access path still blocked
      verifier_next_action: run_troubleshooter
    promotion_result: null
    actions_performed:
      - skill: rainbond-fullstack-troubleshooter
        status: completed
        details: Detected frontend health check failing and suggested capacity warning.
      - skill: rainbond-delivery-verifier
        status: skipped
        details: Deferred until runtime is healthy.
    next_action: run troubleshooter
  ```

  Example final reply:

  ````markdown
  ### Project State
  The project is `linked-and-topology-present-but-runtime-unhealthy` for the `preview` environment with team `alpha-org`, region `us-south`, app `storefront`, and app_id `app-9a2b`.

  ### Actions Performed
  `rainbond-fullstack-troubleshooter` completed and identified converged API/DB components while the frontend stayed abnormal, prompting a focus on nginx host configuration; `rainbond-delivery-verifier` was skipped because runtime health remains outstanding.

  ### Current Health
  db status running, api/service status running, frontend-access status abnormal, overall status runtime_unhealthy.

  ### Blocking Issue
  frontend waiting on corrected nginx host config.

  ### Next Step
  run troubleshooter.

  ### Structured Output
  ```yaml
  AppAssistantResult:
    project:
      identity:
        team_name: alpha-org
        region_name: us-south
        app_name: storefront
        app_id: app-9a2b
      linked: true
      selected_environment: preview
    environment:
      name: preview
      source: default
      env_delta_present: false
      secrets_provided: true
    orchestration_state: linked-and-topology-present-but-runtime-unhealthy
    runtime_state:
      phase: runtime_unhealthy
      db_status: running
      api_status: running
      frontend_status: abnormal
      blocker: nginx host configuration missing
    delivery_state:
      status: blocked
      preferred_access_url: null
    promotion_result: null
    actions_performed:
      - skill: rainbond-fullstack-troubleshooter
        status: completed
        details: Diagnosed frontend health check failure while db/api remained healthy.
      - skill: rainbond-delivery-verifier
        status: skipped
        details: Deferred until runtime is healthy.
    next_action: run troubleshooter
  ```
  ````

  In structured contract mode, always respond using exactly these sections:

  ### Project State
  - state the current classification
  - explicitly include the exact `orchestration_state` label in prose, preferably in backticks
  - include selected environment
  - include resolved team, region, app, and app_id if available

  ### Actions Performed
  - list the lower-level skill(s) used
  - summarize what each one did
  - if no lower-level skill was executed, say that this run only performed context resolution and state classification
  - if a downstream skill was intentionally not entered because the user asked not to continue yet, say that explicitly
  - if development-to-testing promotion was entered, explicitly name the source delivery gate, snapshot creation, testing-app creation, and testing-app verification stages
  - if source creation failed, say so explicitly instead of describing the resulting component as if it had always been image-backed
  - if source creation failed because of a control-plane exception, say that this is a backend/MCP issue rather than code/build failure
  - if the source ref or branch was invalid, say that explicitly instead of auto-rewriting it

  ### Current Health
  Explicitly report:
  - **db status** using `building`, `waiting`, `running`, `abnormal`, or `capacity-blocked` when runtime evidence is available
  - **api/service status** using `building`, `waiting`, `running`, `abnormal`, or `capacity-blocked` when runtime evidence is available
  - **frontend-access status**
  - **overall status** using the canonical runtime or delivery term when one is available
  - explicitly include the exact `runtime_state.phase` label in prose, preferably in backticks
  - if MCP/runtime reports a raw label such as `closed`, explain it in prose if useful, but normalize the status field itself to the canonical vocabulary

  ### Blocking Issue
  - state the main blocker if the app is not fully healthy
  - when `runtime_state.blocker` or `delivery_state.blocker` is non-null, reuse that blocker sentence verbatim in plain text so prose and structured output stay aligned
  - do not wrap part of the blocker sentence in backticks or paraphrase only part of it
  - if none, say `none`
  - if the source app is healthy but the testing app blocked during promotion, state the testing-app blocker here
  - if the source app only lacks an external access URL, describe that as a delivery/access-path blocker rather than generic runtime failure

  ### Next Step
  - state the single most appropriate next action
  - examples:
    - `run env sync`
    - `run bootstrap`
    - `run troubleshooter`
    - `manual URL validation before promotion`
    - `create snapshot and testing app`
    - `run troubleshooter on testing app`
    - `stop, hand off testing app to human testers`
    - `handoff to code/build agent`
    - `stop, app is healthy`

  ### Structured Output
  - append a fenced `yaml` block as the final section
  - render `AppAssistantResult`
  - keep enum values and field names aligned with the schema above
  - if `runtime_state` or `delivery_state` is unavailable, use `null` rather than guessing
  - if post-delivery promotion was not entered, use `promotion_result: null`
  - do not place any prose after this section
  - the heading itself must be exactly `### Structured Output`
  - the opening fence must be exactly ````yaml` immediately after the heading
  - the closing fence must be the last non-whitespace line of the whole reply

  ## Common Mistakes

  - running bootstrap when the topology already exists
  - running bootstrap for a template-install intent
  - running troubleshooter before confirming the project is linked
  - assuming env sync is mandatory for every run
  - treating env files as runtime truth
  - exposing a large YAML block for a fully delivered, verified, stop-state source app when the user did not ask for structured/debug output
  - omitting the required `### Structured Output` section in structured contract mode
  - replacing the required five human-readable sections with freeform narrative in structured contract mode
  - treating a project as unlinked only because `.rainbond/local.json.metadata.status` is stale even though MCP confirms the same app in the current run
  - omitting `Actions Performed` detail when the run only did inspection/classification and intentionally skipped downstream skills
  - echoing raw platform labels such as `closed` instead of normalizing component status to the canonical vocabulary
  - stopping after bootstrap even when bootstrap explicitly recommends troubleshooting
  - skipping template version resolution before installation
  - treating source build convergence as a finished healthy topology
  - continuing application repair when scheduling is blocked by cluster capacity
  - stopping at “running” without verifying delivery state or reporting access URL
  - declaring the app healthy when only db/api are healthy but frontend access is still broken
  - continuing platform-level repairs when the issue is clearly in code or reverse proxy configuration
  - auto-entering version flow when delivery is only `delivered-but-needs-manual-validation`
  - replacing the source-app meaning of `project` with the created testing app instead of recording testing identity under `promotion_result`
  - recursively treating the created testing app as a brand-new source app in the same run
  - silently degrading a source-backed component into an image-backed component after a source creation error
  - silently rewriting the source branch or ref after a source creation error
  - inventing `delivery_state.partially-delivered` before `rainbond-delivery-verifier` has actually run
  - routing a control-plane or MCP backend failure into `code_build_handoff`
  - copying a frontend-only component state into `api_status`
  - stopping the top-level app-assistant run at successful init even though the user asked for deploy or dev-to-test continuation
  - silently selecting one team when multiple accessible teams existed and the user had not chosen one
  - searching outside the current project directory for `rainbond.app.json` or `.rainbond/local.json`
  - continuing into local code edits, local tests, commit, push, or automatic retry after reaching `code_build_handoff_needed`
  - automatically switching from source-backed bootstrap to local package because source detection found multiple services
  - starting local Docker/OrbStack, building locally, or pushing temporary images after a source/package/image path fails without explicit user confirmation
  - spending 20-30 minutes repeatedly trying the same path instead of stopping at the attempt budget
  - routing a clear source build failure straight to runtime logs without checking component events and build logs first
  - using `build_info` as the default container for source build parameters
  - promising `dockerfile_path` or defaulting to Dockerfile mode without explicit user intent

  ## Quick Reference

  Decision summary:
  - no link -> link first
  - no link -> `rainbond-project-init`
  - template install intent -> `rainbond-template-installer`
  - no topology -> bootstrap
  - source build still converging -> troubleshooter
  - explicit build failure question -> troubleshooter with `events -> build logs -> runtime logs`
  - external artifact unreachable -> stop and request reachable mirror/egress or explicit strategy change
  - cluster capacity blocked -> stop and fix platform capacity first
  - topology exists but unhealthy -> troubleshoot
  - runtime appears converged -> delivery verifier
  - strict delivered plus explicit dev-to-test intent -> create snapshot and testing app
  - delivered-but-needs-manual-validation -> stop for manual URL validation before promotion
  - runtime fixed but browser path broken -> code/build handoff
  - healthy -> stop

  Trust model:
  - local files provide context
  - MCP provides runtime truth

  Default orchestration:
  1. resolve context
  2. determine whether the run is source-only or dev-to-test mainline
  3. classify state
  4. choose lower-level skill
  5. continue until the current strict gate says stop
  6. if strict delivered and promotion was requested, snapshot and create testing app
  7. verify the testing app once
  8. report one next step
