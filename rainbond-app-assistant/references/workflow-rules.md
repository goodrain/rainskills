# App Assistant workflow rules

## Contents

- When and how to use the orchestrator
- Managed lower-level skills and input model
- Decision rules
- High-level workflow
- Autonomy rules

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
  - locked Rainbond transport: runtime truth
  - `template` source or explicit template-install intent: app-model installation path

  ## Decision Rules

  ### 1. Link check first
  Before doing any deployment or repair work:
  - check whether `.rainbond/local.json` exists
  - check whether local binding identity is present
  - if `.rainbond/local.json.metadata.status == linked`, treat the project as linked
  - if local metadata is not `linked` but current-run platform confirmation proves the same app identity exists and is accessible, continue as linked and record the local metadata drift explicitly instead of stopping
  - stop and ask for project linking only when neither local binding nor current-run platform evidence can confirm a linked project state

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
  - `linked-and-source-build-failed` maps to `RuntimeState = source_build_failed`
  - `linked-and-topology-present-but-runtime-unhealthy` maps to `RuntimeState = runtime_unhealthy`
  - `linked-and-needs-code-handoff` maps to `RuntimeState = code_or_build_handoff_needed`
  - `linked-and-needs-delivery-verification` is a handoff state that usually follows `RuntimeState = runtime_healthy` and precedes a final `DeliveryState`
  - `linked-and-healthy` should only be used once delivery has effectively reached `DeliveryState = delivered`
  - `linked-and-ready-for-promotion` should only be used when the user has asked for dev-to-test promotion and the source app has already reached `DeliveryState = delivered`
  - classify `linked-and-cluster-capacity-blocked` only when current-run platform evidence still shows active scheduling failure caused by cluster resource shortage
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
  - if bootstrap reports `platform backend issue`, stop and report that the control plane must be repaired before bootstrap can continue
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
  - reading platform runtime state
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

  ## 硬规则

  以下规则优先级最高。若后文示例、详细说明或历史注释与这里冲突，以这里为准。

  1. 只读取当前项目目录中的 `rainbond.app.json`、`.rainbond/local.json`、环境文件和 secrets 文件。
     不允许扫描 `$HOME`、上级目录或其他仓库来“补绑定”。
  2. **team / app 智能选择**：
     - 单个 team 可访问 → 直接用，不询问。
     - 多个 team 但 manifest（`rainbond.app.json` / `.rainbond/local.json`）显式指定了 `team_name` 且该 team 在可访问列表里 → 直接用，在报告里明确说"已选 team = X（来自 manifest）"。
     - 多个 team 且无 manifest 提示 → 停下来询问用户，**禁止**静默选 `default` / 第一个 / 任意已有 team。
     - app 选择同上逻辑：manifest 指定且可解析 → 直接用；无提示且多候选 → 询问。
     - 任何自动选择的结果都必须在最终报告里以"已选 X（理由：来自 manifest / 单一可选）"形式告知，邀请用户覆盖。
     - 每个 Rainbond Tool 边界都要把十进制字符串 `app_id` 规范化为正整数；非数字 ID 必须拒绝。
  3. 单入口主线一旦触发：
     `project-init -> bootstrap -> troubleshooter -> delivery-verifier -> version-assistant -> testing-app delivery-verifier`
     应按 gate 自动继续，不要在中途停成“下一步建议”。
  4. `project-init` 成功 linked 后，如果当前 run 是单入口部署/开发到测试主线，必须自动继续到 `bootstrap`。
5. 当前项目一旦被判定为 `source-backed`，不能静默改成 `package` 或 `image`。
   transport 代理只改“怎么拉”，不改 delivery mode。
6. **传输代理自动决策（Git URL + image 公网拉取统一处理）**：当组件源指向**已知有可工作代理的公网服务**时，**默认自动套用代理**，不打断流程问用户，在最终报告里明确告知"已用 X 代理拉取 Y"，邀请用户覆盖。其它情况按下面分类处理。

   **已知可工作的代理 pair（限定清单 — 这里必须用清单，不能用 principle，因为代理 URL 是事实，不能让模型推断）**：
   - `github.com` Git URL → `https://ghfast.top/<原完整 URL>`（含 `https://github.com/...`、`https://raw.githubusercontent.com/...`）
   - `docker.io` 容器镜像（含裸 `nginx:latest`、`library/...` 这种隐式解析为 `docker.io/library/...` 的引用）→ `docker.1ms.run/<dockerhub-path>`

   **其它公网 registry / Git 托管**（`quay.io`、`gcr.io`、`ghcr.io`、`k8s.gcr.io`、`registry.k8s.io`、`nvcr.io`、`mcr.microsoft.com`、`public.ecr.aws`、`gitlab.com`、`codeberg.org` 等及其它公网服务）：
   - **禁止瞎拼代理 URL**（如 `docker.1ms.run/quay.io/...`、`docker.1ms.run/nvcr.io/...` 都不是有效路径 — 这些公网代理只针对自己声明的源仓库工作）
   - 默认**先用原 URL 试**，不主动套代理
   - 如果用户在消息里明确给出了代理 URL（如 `请用 https://my-proxy/quay.io/calico/node`），照用
   - 如果出现拉取失败（`ImagePullBackOff`、`Manifest not found`、`connection refused`），**这时才**询问用户："`quay.io/...` 拉取失败，可能是网络问题。您是否有可用的代理？或者继续重试原 URL？"

   **私有 / 自建 registry**：直接用原 URL，**绝不代理**。判断特征（principle）：URL 包含 `.internal` / `.local` 后缀、企业自有域名（`harbor.<corp>.com`、`registry.<corp>.cn`）、IP+端口（`10.x.x.x:5000`、`<host>:443/...`）、云厂商私有仓库子域名（`registry.cn-*.aliyuncs.com`、`<aws-account>.dkr.ecr.<region>.amazonaws.com` 等用户专属路径）。模型用通用知识识别，不需要等清单。

   **已在镜像源的 URL**（前缀已是 `docker.1ms.run`、`m.daocloud.io`、`mirror.gcr.io`、`ghfast.top/...` 等）：直接通过，不重复代理。

   一次 run 内复用同一代理前缀，不并存多个。用户明确说"不用代理"或"用原始地址" → 当次 run 内对所有 in-scope URL 都跳过代理。

   > 编号说明：原 Iron Law 7（image 代理 ask once）已合并到本条；后续 Iron Law 编号保留原值（8、9、10…），不重编号以免破坏跨规则引用。
   > 措辞说明：代理 URL 是**事实信息**（哪个代理服务真的能 proxy 哪个源），必须写清单 — 这跟 Iron Law 37 把"基础设施软件"写成 principle 是不同性质。不要把这里的清单也"principle 化"，否则模型会瞎拼无效代理 URL。
8. 一旦 source ref 已确定，不能静默改 branch/ref。
   分支不存在时必须停住并报告 source definition needs confirmation。
9. `check_uuid` / `event_id` 默认不是标准 source create 的前置条件。
   除非后端明确返回它们必需，否则不能把它们当 blocker。
10. 如果 source create 返回 `multiple services detected` 或等价的多组件源码歧义，必须停住，要求用户明确选择策略。
   不允许自动切到 local package、手工上传、模板安装或其他 workaround。
11. 如果进入 `code_or_build_handoff_needed`，必须硬停止。
   不允许自动改代码、跑本地测试、commit、push、自动重试。
12. `delivery_state` 只表示 source app。
      在没有运行 `delivery-verifier` 之前必须是 `null`。
      `promotion_result` 只表示 snapshot 和 testing app；未进入 promotion 时必须是 `null`。
13. 顶层主线必须有尝试预算：
    - 同一类错误签名最多重试 1 次
    - 同一阶段最多尝试 2 次（首次 + 1 次重试）
    - 单次主线总时长默认不应超过 8 分钟；超时后必须停止并汇报当前停点。
14. 任何 delivery mode 或 workaround 策略切换都不允许隐式发生。
    source -> package、source -> image、source -> template 都必须先得到用户明确确认。
15. 如果用户明确在问“为什么构建失败”，顶层必须优先走 `component events -> build logs -> runtime logs` 的构建失败证据链。
    不要把运行容器日志当第一现场。
16. 如果用户要求调整源码构建参数，优先走 `rainbond_manage_component_envs(operation=replace_build_envs, build_env_dict=...)`。
    不要把语言构建参数塞进 `build_info`。
17. 如果源码检测同时命中 Dockerfile 和语言构建，按 `rainbond-fullstack-bootstrap` 的 Build Mode Selection 优先级链解决：manifest `source.build.strategy` 优先 → 启发式按 Dockerfile 分类 + 意图信号判断（"语言 buildpack 能否产生等价运行时行为"，原则驱动而非固定清单）→ 真正模糊时才问一次并建议用户写回 manifest。决策必须双轨可审计：prose 输出"Build mode for `<name>`: `<picked>` (`<source>` — `<reason>`; to override: `<hint>`)"逐组件展示，且 bootstrap 的结构化输出 `deployment_plan.workflow.build_strategy_decisions[<name>]` 同步记录（仅给有 dual detection 的组件填）。`dockerfile` 决策映射到 `rainbond_create_component_from_source` 的 `prefer_dockerfile_when_detected = true`。详见 `rainbond-fullstack-bootstrap/references/source-build-parameter-guide.md § Build Mode Selection`。
    - **恢复例外按状态决定**：`checking` / `checked` / 未完成组件可以通过 `rainbond_get_component_check_result(prefer_dockerfile_when_detected=true)` 在原拓扑中取得 Dockerfile 证据，禁止删除。只有 `create_status=complete` 的 CNB 组件不存在通用原地切换能力时，才允许在已保存 topology and configuration snapshot、已向用户展示该完成状态并获得 explicit user confirmation 后删除并重建；任一证据缺失时只读停止。
18. 当前 Rainbond Tool catalog 不支持显式 `dockerfile_path` 时，不要在顶层编排里承诺该能力。
19. 对 reverse-proxy full-stack 项目，不要只因为根路径 URL 存在就把它当作最终交付成功或 Fast Path 的可信 URL；同 host 的 backend 路径（通常是 `/api`）必须也一致可用，或明确停在 blocker。
20. **组件依赖与连接变量管理**（合并自原 20-23 四条）：多组件拓扑里，provider/consumer 关系必须用显式依赖 + provider 侧连接变量管理，不要让 consumer 端硬编码或重复声明。

    **可执行工具（fact）**：
    - 显式依赖：`rainbond_manage_component_dependency` — 不要回答"没有依赖接口"；调用失败时按 Rainbond Tool / 控制面真实错误报告，不要描述为工具不存在
    - Provider 连接变量：`rainbond_manage_component_connection_envs(scope=outer)` — 这是 provider 暴露给 consumer 的接口面
    - Consumer 自身的本地 env：`rainbond_manage_component_envs` — 仅放该 consumer 真正本地的值

    **判断顺序（principle）**：
    - 拓扑里出现 provider/consumer 关系（`depends_on`、反向代理链路、运行时日志暴露的连接错误）→ 用 `rainbond_manage_component_dependency` 建显式依赖
    - 共享连接信息（数据库连接串、缓存地址、消息队列 broker 等任何"provider 拥有的连接 fact"）→ 配在 provider 的 connection envs 上，**不要**在每个 consumer 上重复写
    - 运行时报 `connection refused` / `ENOTFOUND <provider-name>` / 错 host / 错 port / 缺密码等连接类错误 → 先看 provider connection env / dependency alias / compatibility env，**不要**把 baseline 里的硬编码主机名当成事实
    - 多组件拓扑进入交付验收前 → 必须跑一遍依赖完整性 gate（列已接受边 → 查现有依赖 → 补齐缺失 → 再次验证依赖摘要）。手工创建镜像组件、Compose fallback 路径、组件能独立启动都**不能**跳过 gate
    - **配置覆盖 gate（backend 组件，设完 env 后、宣布健康/可交付前必跑）**：从 `rainbond_get_component_summary` 枚举该组件挂载的 config-file 卷。若有卷挂到已知配置路径（`config.yml` / `application.yml` / `application.properties` / `.env` / `nginx.conf` / `*.conf`），运行态有效配置由该文件决定而非 env（mounted config-file > env > 镜像默认值）。这时必须警告"env 可能被挂载的配置文件覆盖"，并先确认该文件反映了预期值，再宣布交付健康。比较配置值用于该 gate 是允许的，但**禁止**回显原始文件内容或密钥明文，只报结构化不一致。文件内容无法用当前 Rainbond Tool catalog 读取时，显式标注覆盖风险并停下来让用户确认，不要默默改 env 就当成功

    具体的 provider 命名约定、connection env 变量名（`DB_*` / `REDIS_*` / `KAFKA_*` 等是示例，按 provider 文档实际名字为准）、以及依赖 alias 细节，详见 bootstrap modules/30-creation-rules.md 的相关章节。
24. 不要自动拉起本地 Docker Desktop/OrbStack、执行本地 Docker build/push、或推送临时镜像作为兜底；这属于 delivery-mode 策略切换，必须先得到用户明确确认。
25. 每次运行内部仍必须形成 `AppAssistantResult` 结果对象，但默认用户答复不一定暴露 YAML。
    当 `source_app_delivery` 的 runtime healthy、没有 blocker、控制台部署位置和公网访问地址都已确定，且 delivery 已 `delivered` 或只剩浏览器人工确认时，默认使用简洁中文交付报告，不追加 `### Structured Output`。报告的全部现有内容结束后，必须以以下固定动作块收尾；动作块只出现一次，后面不得再追加文字：

    ```text
    你接下来可以：

    1. 修改代码并重新部署
    2. 将当前应用创建快照发布版本，用于部署到生产环境
    3. 查看运行日志
    4. 将应用迁移到自己的 Rainbond
    ```
26. 只有在自动化/评测明确要求结构化契约，或用户明确要求 YAML、JSON、调试详情、内部状态对象时，才把 `AppAssistantResult` 渲染为最终 fenced `yaml`。部署失败、仍在构建、存在 blocker/handoff/身份歧义或进入 dev-to-test promotion 都不是默认暴露 YAML 的理由。
27. 如果本次使用了 Git、镜像仓库或其他传输代理，必须在默认交付报告的处理记录或注意事项中说明；在结构化模式下也必须写入 `actions_performed[].details`。
    代理事实属于执行记录，不是强制暴露 YAML 的理由。
28. `rbd-*` 组件（rbd-gateway、rbd-api、rbd-worker、rbd-chaos、rbd-db、rbd-mq、rbd-monitor、rbd-node 等）是 Rainbond 平台自身的基础设施组件，不是用户应用组件。
    - 可以用 `rainbond_query_region_rbd_components` 查询并展示它们的状态
    - 不能通过 Rainbond Tool 对它们执行重启、部署、修改等写操作；当前 Tool catalog 不支持此类操作
     - 如果用户要求操作这些组件，明确告知：需要通过 Kubernetes 命令（如 `kubectl rollout restart deployment/<name> -n rbd-system`）或 Rainbond 集群管理控制台进行，超出本技能的操作范围，不要假装可以执行
28a. 已知 `service_id` 的组件在构建、部署或运行操作后失败或立即异常时，调用 `rainbond_get_operation_failure_context({team_name, region_name, app_id, service_id, event_id?})`，按其 `classified_reason` 决定停下、只读核实或低风险修复；`unknown` 回退既有证据链，禁止盲目重放写操作。CLI 在确认令牌生成前报告的 missing/invalid field 属于参数校验失败，尚未进入组件操作：按 Console Tool schema 修正参数一次，不调用 failure context，也不查询组件残留。
    `event_log_tail` 只作为敏感诊断证据使用，绝不能复制、引用或向用户展示其原文；输出只能使用 `classified_reason`、非敏感摘要和已脱敏字段。
28b. 运行态或交付健康检查先调用 `rainbond_get_app_health_overview`；仅 `abnormal` 或 `unknown` 组件再读取 component summary、日志、事件或存储明细。
29. **仅给 bare Git URL 时默认 root + 空 `subdirectories`**：当用户给的只是一个 Git URL（无本地 manifest、无明确子目录提示），默认 `subdirectories=""`（仓库根）进入 source 检测，让后端判断这个仓库结构。**不要**先问用户"根目录还是子目录"。
    - 单项目仓库（一个 buildable root）→ 后端检测通过，正常 build
    - 多组件 / 多 example 仓库 → 后端返回 `multiple services detected` 或等价歧义信号 → 按 Iron Law 10 停下问用户选哪个子目录
    - 模型**禁止**凭训练知识枚举子目录或猜测路径（由 Iron Law 36 强制 — `subdirectories` 是受 verbatim 保护的字段之一）
    - 把"是否需要选子目录"这个判断**外包给后端检测**，不要前置询问；前置询问只在用户的需求文本本身就说了"我只要这个仓库的 X 子目录"这类显式信号时才有意义（这时直接 verbatim 用用户给的子目录字面值）
30. 源码创建一旦失败，**绝对禁止**第二次调用 `rainbond_create_component_from_source` 来"换参数重试"，也**绝对禁止**通过 `rainbond_delete_component` 删掉失败组件再 create 这种伪装手段绕过预算。
    `rainbond_create_component_from_source` 是"检测 + 创建 + 构建"三合一工具，**不是幂等重试工具**，每次调用都会写入一个新的 `service_id`。调用报错不代表组件没建出来——组件行、端口、env、依赖可能已经存在，错误只发生在下游检测或构建阶段；不能凭"上次 create 调用我没拿到 service_id 所以肯定没建出来"做臆测。
    本轮任何源码失败（包括"源码目录不存在 / 子目录识别不到 / 多组件歧义 / 仓库不可达 / 检测识别不到语言 / 构建失败"等）之后，第二个动作**必须**按以下纪律走：
    - 第一步永远先 `rainbond_query_components` 查目标 app，按 `service_cname` 或 `k8s_component_name` 匹配；只要查到一条同名/相近的组件，就视为已存在
    - 命中已存在：
      - 同 `git_url` 同 `code_version`，只想重跑构建 → `rainbond_build_component(service_id, build_info=...)`
      - 源码定义改了（`git_url` / `code_version` / `subdirectories` / `server_type` / 凭据） → `rainbond_update_component_build_source` 然后 `rainbond_build_component`
      - 只调构建参数 → `rainbond_manage_component_envs(operation=replace_build_envs, build_env_dict=...)` 然后 `rainbond_build_component`
    - 未命中（`rainbond_query_components` 确认目标 app 下不存在任何对应组件）才允许重新调 `rainbond_create_component_from_source`，且仍然受 Iron Law 14 的尝试预算约束。
    典型反例（**禁止**）：第一次报"源码目录不存在" → 第二次换个 `subdirectories` 再 create → 第三次又换大小写再 create。每次都会产出新的 service_id，留下多个垃圾组件需要用户清理。正确路径：先 `rainbond_query_components`，如果已经留下了某个 `java-maven-demo` 组件，就 `rainbond_update_component_build_source` 改 `subdirectories` 再 `rainbond_build_component`；只有确认 app 下完全没有同名组件，才可以重新 create，并且必须遵守"同一阶段最多 2 次"。
    **以 `service_cname` 为预算基本单位**：Iron Law 14 的"同一阶段最多尝试 2 次"按 `service_cname` 累计计数，**`rainbond_delete_component` 不重置这个计数**。换句话说，对同一个 `service_cname`（例如 `java-maven-demo`）在本轮 run 内 `create_from_source` 类工具的调用总次数最多 2 次，不管中间有没有 `delete_component` 把上一次的失败组件清掉；超过即必须停下来按下面"用户输入错误"流程走。
    **用户输入错误必须停下来问用户，不允许猜参数**：当源码检测明确报"源码目录不存在 / 语言识别失败 / 仓库不可达 / 凭证错误"等**用户输入相关**的错误时，根因是用户给的 `git_url` / `subdirectories` / `code_version` / 凭证本身有问题——这类错误**不能通过 AI 自己换参数**（去掉 subdirectories、改大小写、换分支名、换 case）来解决。必须**停下来**显式询问用户：
    - 列出已尝试的参数组合和对应的错误信息
    - 请用户确认仓库的真实子目录路径（建议用户在浏览器打开仓库或贴 tree 截图）
    - 或者请用户提供另一个分支 / 凭证 / 子路径
    - **不允许**根据"模型对该仓库的先验知识"猜常见名字（Java-maven-demo、java_maven_demo、demo/java-maven 等）
    - 这与 Iron Law 29 入口"必须问用户"配套：29 管入口、30 管中途用户输入验证失败的二次询问。
    猜测换参数 + 删-再-create 循环是典型 anti-pattern，server 端可能直接 reject 重复 create 调用。
31. **任何 Rainbond 写工具调用之前**，必须先完整读取当前阶段对应专项 Skill 的 `SKILL.md`，再按其渐进加载规则读取本次动作需要的 modules / references；没有执行手册就直接动手等于**无授权操作**，是 Iron Law 违反。
    触发动作（凡是这类，第一次调用之前都必须先加载对应专项手册）：
    - 创建/更新/部署组件：`rainbond_create_component_from_source`、`rainbond_create_component_from_image`、`rainbond_create_component_from_package`、`rainbond_create_component`、`rainbond_build_component`、`rainbond_update_component_build_source`、`rainbond_change_component_image`
    - 包上传事务：`rainbond_init_package_upload`、`rainbond_delete_package_upload`；包内容必须由 bootstrap 的客户端 helper 上传，完成后再用上面的 event-based package create
    - 组件配置：`rainbond_manage_component_envs`、`rainbond_manage_component_ports`、`rainbond_manage_component_connection_envs`、`rainbond_manage_component_dependency`、`rainbond_manage_component_storage`、`rainbond_manage_component_probe`、`rainbond_manage_component_autoscaler`
    - 应用操作：`rainbond_operate_app`、`rainbond_horizontal_scale_component`、`rainbond_vertical_scale_component`、`rainbond_delete_component`
    映射表：
    - 当前 run 是**首次部署/创建组件/补齐拓扑**（含从源码/镜像创建，以及客户端 package upload + event-based package create） → `rainbond-fullstack-bootstrap`
    - 当前 run 是**排查运行态/构建失败**（CrashLoopBackOff / ImagePullBackOff / 构建报错 / 端口/依赖不通） → `rainbond-fullstack-troubleshooter`
    - 当前 run 是**交付验收**（验证 URL 可达、reverse-proxy 路径连通） → `rainbond-delivery-verifier`
    - 当前 run 是**开发到测试 promotion**（创建快照 + 测试 app） → `rainbond-app-version-assistant`
    - 当前 run 是**模板安装**（本地/云端 Rainbond 应用模板） → `rainbond-template-installer`
    规则细节：
    - 从当前主机提供的可用 Skills 清单定位专项 Skill；不得把 Skill 名当作 Rainbond Tool 名称或通过业务工具目录调用
    - 一个专项 Skill 在同一会话内只需读取一次；跨阶段时再读取新阶段的专项 Skill
    - **判断依据**：用户消息中只要含"部署 / 跑起来 / 上线 / 创建组件 / 发布"等部署意图，且当前 app 还没有对应组件，就必然要先加载 `rainbond-fullstack-bootstrap`，不论用户是不是显式说"先 deep dive"
    - App Assistant 已完成的唯一运行环境检查和无状态 context 解析可在专项阶段复用；除非 Node.js、Rainskills、PATH、唯一运行环境或用户目标发生变化，不得重新检查或重新解析
    正确路径：用户说"试试 maven-demo" → 你直接调 `rainbond_update_component_build_source(service_id=已知的, subdirectories='maven-demo')` → `rainbond_check_component(service_id=已知的, is_again=true)` → 轮询 `rainbond_get_component_check_result` 直到拿到新一轮 `check_event_id`/`check_uuid` 的结果。
32. **简短回复继承上一轮被中断的操作**：当上一轮你向用户提了问、或在 prose 里邀请用户回复（"回复继续 / check / OK / 完成 / 重试" 等），用户给了简短或单值回复（"继续"、"OK"、"试试 X"、"对的就是 Y"、"换 master"），你的**下一个动作必须基于 priorTurnMessages 的最新状态继续上一个被中断的操作**，**禁止**把它当成一次"全新的开始"。
    - 看 priorTurnMessages 里上一条 assistant 消息：以问号结尾 / 含"回复 X / 你看 / 是否 / 请确认 / 请选" → 视为对你提问的回答
    - 用户上一轮如果在等"build 完成"、"poll status"、"check 进度"等异步状态，简短回复就是"继续轮询" → 直接调对应的状态查询工具（`rainbond_get_component_summary` / `_build_logs` / `_events` 等）
    - 用户上一轮在等"换参数后的重新检测结果"，简短回复就是"用新值重跑" → 直接调修改类工具（update_build_source → check → poll，见 Iron Law 33）
    - **禁止**：本轮重新走"加载 skill / 询问意图 / 查 app 详情 / 列能力清单"的初始化流程
    - **例外**：用户消息明显是新任务（"换个项目"、"算了别部署了"、"先停下"），按新任务处理
    - 信号词识别："继续 / check / OK / 完成了吗 / 现在怎样 / 进度 / 试 X" 这类短词 → 多半属于回答；超过一句完整描述新任务的才算 fresh intent
33. **`rainbond_update_component_build_source` 只改 DB 不触发检测**，调完之后下一个 Rainbond 写调用**必须**是 `rainbond_check_component(service_id=..., is_again=true)`，不允许中间夹任何其他工具，也不允许跳过它直接读 check_result 或调 build。
    背景（必读）：后端 `update_component_build_source` 视图仅把 `git_url`/`subdirectories`/`code_version`/凭证字段写进 DB（`service.save()` 结束），**没有调用 `app_check_service.check_service`**。因此：
    - 改完 build_source 后调 `rainbond_get_component_check_result` → 返回的依然是**上一轮**（最初 create 时）的 `check_uuid` 和 "源码目录不存在" 旧结果，给人"我的修改没生效"的假象，实际是检测根本没重跑
    - 改完 build_source 后调 `rainbond_build_component` → 组件还停留在 `service_source=source_code` + 上轮检测未通过的状态，build 任务会被卡在 `checking`，无法真正启动
    - 唯一能让后端重跑源码检测的方式是 `rainbond_check_component(is_again=true)`（对应 `app_check_service.check_service(team, service, is_again=True, ...)`，会清掉旧的 `check_uuid` 并发起新一轮 check_event）
    强制时序模板：
    ```
    rainbond_update_component_build_source(service_id, git_url?, subdirectories?, code_version?, ...)
      ↓ 立刻
    rainbond_check_component(service_id, is_again=true)
      ↓ 拿到新的 check_event_id / check_uuid
    rainbond_get_component_check_result(service_id)   # 轮询直到 check_status != "checking"
      ↓ 通过
    rainbond_build_component(service_id, build_info=...)
    ```
    禁止序列：
    - `update_component_build_source` → `get_component_check_result`（中间没 `check_component`）
    - `update_component_build_source` → `build_component`（中间没 `check_component`，组件仍 `checking`，build 必失败）
    - 多次 `update_component_build_source` 之间不夹 `check_component`（等价于在改了 DB 但没触发检测的情况下又改一遍，每次轮询的还是同一个旧 `check_uuid`）
    与 Iron Law 30 配套：30 管"换参数重试"的预算（同 `service_cname` 最多 2 次 create / 同 service_id 同字段最多 N 次 update），33 管"改完后必须走完一个完整 check 闭环"。两者一起堵住"猜参数 → 改了又不重检测 → 又看到旧错误 → 再猜"的死循环。
34. **service_id provenance：任何 Rainbond 写工具传入的 `service_id` 必须有明确出处**，不允许凭模型记忆或上下文里飘着的 UUID 猜。
    合法的 `service_id` 来源（按优先级）：
    - 本会话内 `rainbond_query_components` 的返回结果（最新一次）
    - 本会话内 `rainbond_create_component_*` 工具的返回值
    - `session.localBinding.serviceId` / `priorTurnMessages` 里同一 `service_cname` 的 ack
    不合法的 `service_id` 来源（**禁止**）：
    - 从对话历史里随手抓一个看起来像 UUID 的字符串（可能是 `check_event_id` / `check_uuid` / `event_id` / 历史 service_id）
    - 凭"我记得是这个"或"上次也是这个 ID"做猜测
    - 用户消息里粘的、但本会话没验证过的 ID
    强制流程：动手前如果不能 100% 确定 `service_id` 出处，**第一动作**必须是 `rainbond_query_components({enterprise_id, app_id})`，必要时携带 `query=<service_cname 或 service_id>`，按 `service_cname` 或 `k8s_component_name` 匹配出真实 `service_id`，再调写工具。
    反例（**禁止**）：日志里出现"修改组件 `7059eb62cccc3a16f22c9415c905bbcc` 的构建源" — 这个 ID 在本会话所有 query 结果里都没出现过，是模型从某处幻觉出来的。正确做法：调 update 之前先 `rainbond_query_components` 拿到真实 `service_id`，再 update。
    与 Iron Law 31 配套：31 管"写工具前必须加载对应专项手册"，34 管"写工具的 service_id 必须有明确出处"。两条共同把"模型自由发挥参数"这条路堵死。

    **同样的 provenance 规则对 `event_id` 生效**：调 `rainbond_get_component_build_logs` / `rainbond_get_app_upgrade_record` 等需要 `event_id` 的工具时，`event_id` 必须是**真实 UUID**（如 `805f6397871d467b968d14c3575082a6`），合法来源仅限：
    - 本会话内 `rainbond_get_component_events` 返回的 `events[*].event_id`
    - 本会话内写工具（`rainbond_build_component` / `rainbond_operate_app` / `rainbond_check_component` 等）响应里的 `event_id` / `build_event_id` / `check_event_id`

    不合法 `event_id` 来源（**禁止**）：
    - `rainbond_get_component_summary` 返回的 `recent_events[*].ID` — 这是**数据库自增行号**（如 `17740`），**不是** UUID
    - 任何看起来是短整数的字段（4-6 位数字）
    - 历史会话里飘着的、本会话未通过 events 查询验证过的字符串

    强制流程：调用任何 `event_id`-required 工具前，如果不能 100% 确定 `event_id` 出处，**第一动作**必须是 `rainbond_get_component_events(team_name, region_name, app_id, service_id, page=1, page_size=10)`，从 `events[*].event_id` 拿真实 UUID，再调下游工具。

    反例（来自真实回归 case `cs_1779149681822_3u`，2026-05-19）：模型从 `rainbond_get_component_summary` 响应的 `recent_events` 段看到形如 `{"ID": 17740, "event_id": "...", "opt_type": "build-service"}`，直接把 `17740` 当成 `event_id` 传给 `rainbond_get_component_build_logs`，工具返回 `items: []`（找不到该 UUID 的日志）。正确做法：从同一 `recent_events[i].event_id` 字段取出 UUID 字符串，或调 `rainbond_get_component_events` 重查。
35. **会话内部叙述纪律 + 内部 preflight 工具不要主动调**。下列四类是"内部会话状态"，对用户**无信息量**，禁止外漏到 assistant 可见消息：
    - **专项 Skill 手册加载过程**：这是当前任务的内部准备。不要说"我先加载 bootstrap 手册"、"手册已加载"或"skill ready"；读完直接进入下一个真实工具调用。
    - **`rainbond_get_current_user`**：不得由 Agent 单独调用。`enterprise_id`、`team_id`、`team_name` 和 `region_name` 统一由受保护的 `context resolve` 命令无状态解析并由当前任务携带；`team_id` 可继续用于后续平台调用，但不得在过程消息或最终报告中展示。只有 CLI 明确返回需要选择时才询问用户，并且只展示名称标签。
    - **`rainbond_query_components` 同入参重复轮询**：服务端 30s 内的同 args 调用会走缓存；你**不要**在每个新 user turn 开头都"先查一下组件列表"。只有本次调用使用的 `enterprise_id`、`app_id` 和查询条件均未变化，且没有新的平台动作时，才可复用 priorTurnMessages 里的最近结果。
    - **规则推理过程 / Rainbond Tool 内部限制 / 分类决策叙述**：你内部基于哪条 Iron Law / hard rule / 推断信号做的决策、具体 Tool 签名 / 字段限制、对组件 / 服务的分类判断（"ClickHouse 是公认的列式分析数据库"这类），都属于内部状态，对用户**无信息量**。

      **禁止**这类叙述（来自真实回归 case 的典型模式）：
      - "ClickHouse 是公认的列式分析数据库，属于基础设施软件，按 image 模式创建"
      - "通过代理 docker.1ms.run/library/clickhouse:latest 加速拉取"（应改为"用镜像代理加速拉取"，不要把代理 URL 暴露给用户读）
      - "由于 rainbond_create_component_from_image 不支持直接设置 extend_method，需要先创建再修改"
      - "先加载 bootstrap skill" / "现在我来加载 bootstrap 手册"（参见本规则第 1 类）
      - "根据 hard rule 2 我需要先查 team 列表"
      - "Iron Law 14 要求尝试预算最多 2 次，所以..."
      - "接下来需要：1. 配置端口 2. 挂载存储 3. 部署组件"（流程清单 — 直接调工具，不预告步骤）

      **判断捷径**：消息里出现 `X 是 Y` / `属于 X 类` / `公认的 X` / `按 X 模式` / `根据 X 规则` / `由于 X 工具不支持` / `先加载 X skill` / `接下来需要：1. 2. 3.` 这些短语多半要删。

      **改写为结果导向的用户语言**：
      - 一句话开场（"好的，我帮你部署 X" — 1 句，超过 1 句就是噪音）
      - 真需要用户回答的问题（多 team 无 manifest 提示 / 关键参数缺失）
      - 工具失败的真实报错信号
      - 最终结构化报告（按 Output Format 章节，结构化字段允许包含 `decision_reasons`）

      原则：用户关心**结果和你正在做的事**，不关心你**为什么决定这么做**。规则推理 / 工具字段限制 / skill 加载 / 上下文重述对用户无信息量。规则名 / 决策依据 / 工具限制可以在最终报告的 `actions_performed[].details` 或 `decision_reasons` 结构化字段里出现，但 prose 流水里出现就是噪音。

      > rainagent 运行时通过 server-side "最终覆盖规则" 段也强制了同一条规则；本条主要服务 CLI / Codex 端使用者（他们没有 runtime tail 注入）。

    **同一个专项 Skill 在 session 内最多读取一次（跨 user turn 也算）**，但**切换到不同阶段时必须读取新阶段的专项 Skill**。判断方式：如果当前会话已经完整读取过该专项 `SKILL.md` 及本次需要的 supporting resources，就直接复用；若阶段从 bootstrap 变为 troubleshooter，则读取 troubleshooter 的手册后继续。

    反例（**禁止**）：上一轮已经完整读取 `rainbond-fullstack-bootstrap`，本轮 user 简短回复 "java/jar"，又重新读取同一手册并叙述"先加载 bootstrap"。正确做法：直接 `rainbond_update_component_build_source(...)` 继续。
    正例：上一轮处于 bootstrap，本轮用户说"组件起不来帮我排查下" → 阶段变为 troubleshooter → 完整读取 `rainbond-fullstack-troubleshooter` 后进入诊断，不复述内部加载过程。
36. **用户给出的字面值（URL / 镜像地址 / 分支名 / 凭证）必须 verbatim 传给工具，禁止 LLM 凭训练知识"补全"、"修正"、"猜测"**。
    适用字段：`git_url` / `image`（用户所说的镜像地址映射到 Console Tool 的 `image` 字段）/ `code_version`（分支/tag/commit）/ `username` / `password` / `token` / `subdirectories` 等任何用户在消息里给出的字面值。
    **禁止行为**：
    - 看到 `service_cname=java-maven-demo` 就自创 `git_url=https://gitee.com/mirrors_123/java-maven-demo.git`（按训练数据里"常见仓库地址"补全）
    - 用户给的 URL 没 `.git` 后缀就自动加上
    - 用户给的 URL 是 `gitee.com/xxx/yyy`，你"知道这个仓库其实在 GitHub" 就改成 `github.com/...`
    - 用户给了主仓库 URL（`https://gitee.com/rainbond/sourcecode-examples`），你把它换成你以为的子项目独立仓库（`https://gitee.com/some-org/java-maven-demo.git`）—— 同一个仓库下的不同子项目应该用**同一个 URL + subdirectories 参数**区分，而不是换 URL
    - 用户没说分支，你自己写 `code_version=main` 或 `master` 当默认值（应该让后端/Tool 默认值生效，传 `master` 的前提是用户说过 master 或者你是 carrying over 从已有组件 build_source 拿到的字面值）

    **正确做法**：
    - 用户消息里出现的 URL/分支/凭证，**逐字符 copy** 传给工具
    - 用户消息**没有**给某个字段（如只说"部署 X 项目"没给 git_url）→ 必须**问用户**要这个字段，不允许自创
    - 如果你认为用户给的值有问题（域名错、路径不对），**让后端报错**而不是预先"修正"——后端的报错是把决定权交回用户的正确路径
    - 唯一允许"非用户消息字面"的 git_url 来源：本会话内 `rainbond_get_component_build_source` 的返回（即"维持已有组件的 git_url 不变"场景）；这种情况下你必须能在 priorTurnMessages 的 tool_result 里指出该值的来源

    **wire 层 gate（Iron Law 36 enforcement）**：server 会拦截 `rainbond_create_component_from_source` / `rainbond_update_component_build_source` 调用，验证 `git_url` 的 host+owner（如 `gitee.com/rainbond`）在本 run 的 conversation 文本（user/assistant/tool messages 全部 content）中 verbatim 出现。命不中直接 reject 并要求 LLM 停下来问用户。所以**自创 URL 不会过 wire**，只是浪费一次 LLM 轮次。

    反例（**禁止**）：用户说"帮我部署 https://gitee.com/rainbond/sourcecode-examples 的 java-maven-demo"，你调 `rainbond_create_component_from_source(git_url='https://gitee.com/mirrors_123/java-maven-demo.git', subdirectories='java-maven-demo')` —— 这是把用户给的主仓库 URL 整个替换成你训练数据里相关性高的某个独立仓库。
    正确做法：`rainbond_create_component_from_source(git_url='https://gitee.com/rainbond/sourcecode-examples', subdirectories='java-maven-demo')` —— URL 逐字用用户给的，子目录用用户说的子项目名。
37. **组件创建方式智能推断（image vs source vs complex suite）**：本规则只处理已经由 App Assistant 静态归属的请求。若用户明确要求部署 Harbor、Dify、n8n 等第三方开源套件且没有当前/本地项目或普通源码仓库信号，必须在 Runtime Gate 前转到 `rainbond-opensource-app-deploy`，不得在本规则内继续。留在本 Skill 的请求根据用户消息自动推断创建方式，不要停下来问"用镜像还是源码？"。

    推断信号优先级（从强到弱）：
    - 用户提到 Git URL / 分支 / commit / `subdirectories` → **source 模式**
    - 用户提到 image tag / registry 路径（如 `<name>:<tag>`、`docker.io/...`、`harbor.../...`）→ **image 模式**
    - 用户只说组件名，且该名指向**简单单镜像基础设施软件**（数据库、消息队列、缓存、对象存储、Web 服务器、反向代理/负载均衡、注册中心、密钥管理等类别下被广泛使用、有官方/社区维护镜像，且通常一个主容器即可形成最小可运行服务的项目）→ **image 模式**，默认镜像名 `<name>:latest`（再经 Iron Law 6 代理改写）。这里用你自己的通用知识判断，**不要**等清单或穷举匹配。
    - 当前/本地项目或普通源码仓库被识别为**复杂现成软件套件 / 多服务发行版** → **local complex suite 模式**：读取项目画像中的 `docker-compose` / compose profile、`rainbond.app.json` 或用户仓库内描述符；证据缺失前禁止创建组件。不要把本地项目重新路由为上游开源套件，也不要静默改成市场模板。

      **证据仲裁（complex suite 门槛何时已满足）**：当 `rainbond_get_project_source_profile` 已经返回 compose / manifest 拓扑证据（`topologySource == "compose"`、含服务清单的 `rainbond.app.json` 或官方描述符）时，complex suite 的证据门槛**就已满足**——这份画像本身就是权威拓扑来源。此时**禁止**再以"去找更可靠的证据"为名跳去查 `rainbond_query_local_app_models` / `rainbond_query_cloud_markets` / `rainbond_query_cloud_app_models` 等模板库，更不允许把"找到了同名模板"升格成默认部署路径。尤其当用户消息里**显式给了 Git URL** 时，按 Iron Law 38 把本轮路径锁定为源码 / compose 画像路径，应用市场模板至多作为一句建议提及，不得安装。
    - 用户只说组件名，且该名是项目专属或来历不明（如 `my-api`、`order-service`、`payment-svc` 等业务命名风格） → 信号不足，**这时才**问"用镜像还是源码？"

    判断标准（principle 而非清单）：
    - 在你的知识里，这个名字是不是**一个有公开镜像、单主服务可运行的成熟基础设施软件**？是 → image。
    - 这个名字是不是**一个产品套件**，通常由多个互相依赖的组件组成，且 service list / depends_on / env / storage / external_url / TLS 这些字段需要官方描述符才能可靠？是 → complex suite，先要证据或用户确认。
    - 这个名字是不是**业务领域命名风格**（含动词、含组织名、含具体业务概念）？是 → 问。
    - 介于两者之间不确定？**优先按 image 默认**（更常见的部署方式）并在报告里告知推断理由，邀请用户覆盖。

    自动推断的结果必须在最终报告里说明，例如："已按 image 模式创建 clickhouse 组件（推断依据：该名为公认的列式分析数据库）。如需改用源码请告知。"
    对 local complex suite 的报告必须说明缺失的项目内拓扑证据；如果画像已返回 compose/manifest 证据，门槛即已满足，按该用户项目证据继续，不要查找或安装同名市场模板。

    **禁止行为**：
    - 用户给了 git_url 还问"用镜像还是源码？"（信号已经明确）
    - 用户给了 image tag 还问"用镜像还是源码？"（信号已经明确）
    - 对一个你的训练知识里明显是基础设施软件的名字（不管是否在某个示例清单里）问"用镜像还是源码？" —— Nginx、Redis、ClickHouse、Jaeger、Loki、OpenTelemetry Collector 都属于这一类，未来出现的新项目也会属于这一类，用判断不要用穷举
    - 把明确的第三方开源套件部署留在 App Assistant，而不是在 Runtime Gate 前转到 `rainbond-opensource-app-deploy`
    - 对当前/本地 complex suite 项目，在没有 compose profile、`rainbond.app.json` 或仓库内描述符时，凭通用知识创建多个组件、依赖、env、存储或端口
    - 已经拿到 compose / manifest 画像证据（门槛已满足）时，还以"找更可靠证据"为由去查模板库（`rainbond_query_local_app_models` / `rainbond_query_cloud_app_models`），或把找到的同名模板当默认路径——尤其用户已显式给了 Git URL 时（违反证据仲裁与 Iron Law 38）

    **stateful 服务的持久化要求**：当推断结果是 image 模式 **且** 该服务属于 stateful 范畴（数据库 / 持久化消息队列 / 搜索引擎 / 时序库 / 对象存储 / 向量库 / 图库等 — 数据必须跨重启存活的任何服务），**必须**在 deploy 之前配好持久化。

    **平台现实（fact）**：`rainbond_create_component_from_image` 和 `rainbond_create_component_from_source` 都不暴露 `extend_method` 参数，平台也没有 stateless→stateful 的转换工具。所以镜像/源码模式创建的组件**必然是 stateless**。不要尝试创建后再"改成 stateful"，做不到。

    **持久化方案**：
    1. 用 `rainbond_manage_component_storage(operation=create_volume, volume_type=share-file, volume_path=<官方数据目录>)` 在服务的数据目录挂 RWX 共享文件存储（stateless 组件能挂）
    2. 然后 `rainbond_operate_app(action=deploy)` — **先挂存储再 deploy**，顺序不能反
    3. **禁止**用 `volume_type=local`（local 强制要求 stateful，平台会 HTTP 400 拒绝）

    **需要 stateful + local volume（高 IOPS 数据库）的唯一路径**：通过 `rainbond_install_app_model` 从应用市场安装预配置的 stateful 模板。镜像/源码模式做不到这件事，不要假装能做。

    具体的官方数据目录清单、`volume_type` 兼容矩阵、识别 stateful 服务的范畴边界详见 bootstrap skill 的 `modules/30-creation-rules.md § 5`。stateful 服务用 image 模式部署却没配持久化是真实回归 bug（pod 重启数据丢失），禁止以"模型不知道这个 service 是 stateful"或"工具不支持 extend_method"为由跳过持久化步骤。
38. **用户显式源码意图优先（禁止"先装模板再改主意手搓"）**：当用户消息里**明确给出了 Git 仓库 URL**（或明确说"部署这个仓库 / 这个项目的源码"），本轮部署路径**锁定为源码 / compose 画像路径**。
    - 应用市场模板（`rainbond_install_app_model` / 云市场版本）只能作为**建议提及**（"该应用市场也有现成的 X 模板，需要的话可以改用"），在用户**明确选择**模板之前**禁止执行模板安装**。
    - **禁止**这条真实反例链路：用户给了 GitHub URL → 模型先建应用装了云市场模板（`is_deploy=true`）→ 发现不对又放弃 → 另建应用手搓镜像组件 → 留下一个半装的废弃应用没清理。每一步都消耗用户授权、且制造垃圾资源。
    - 如果策略切换确实发生（例如确认源码路径走不通、用户改主意要用模板），切换前**必须先清理废弃的半成品应用**（删掉上一条路径建出来的应用/组件），或在切换时**明确告知用户存在这个半成品并征求处理意见**，不允许默默留着。
    - 与 Iron Law 14（delivery mode 切换必须用户确认）配套：14 管 source↔package↔image↔template 的策略切换需用户确认，38 管"用户已经显式给了源码意图时，模板不是默认路径、且切换必须清理残留"。
39. **轮次纪律：复用已知值，不重复无变化的调用**（与 Iron Law 35 的"内部 preflight 工具不要主动调"配套，35 管哪些工具不该调，39 管已拿到的值要复用）：
    - **复用创建返回的 `service_id` / `service_alias`**：`rainbond_create_component_*` 成功后会返回 `service_id` 和 `service_alias`（k8s component name），**记住并在本轮后续 mutating 操作里直接复用**。**禁止**在每次 `rainbond_manage_component_*` / `rainbond_operate_app` 之前都先 `rainbond_query_components` 重查一遍 alias —— 创建时已经返回过，重查只是浪费轮次（仅当 `service_id` 出处不明、按 Iron Law 34 必须重新建立 provenance 时才查）。
    - **不重复调 `rainbond_get_current_user`**：复用当前任务直接携带的 enterprise/team/region 参数；只有唯一运行环境变化、上下文失效或用户明确切换目标时才重新执行无状态 `context resolve`。
    - **同一 mutating 调用成功后禁止原样重复**：一个写工具用相同入参成功返回后，不要在同一轮再发一次相同调用"确认一下"——成功就是成功，要确认状态用读工具（`rainbond_get_component_summary` 等），不要重发写调用。
40. **对外访问地址必须引用工具返回的真实值，禁止按格式拼装。** 组件的对外访问地址是**事实信息**，权威来源是 `rainbond_get_component_detail` 或 `rainbond_get_component_summary` 返回的 `access_infos` 字段（都来自网关真实绑定）。只需状态和访问地址时优先调用轻量的 detail；只有异常组件确实需要端口、env、存储或事件证据时才调用 summary。
    - 本轮已通过上述任一工具拿到真实地址 → 报告里引用 `access_infos` 的真实值。
    - 本轮**未**通过上述工具拿到可用地址 → 最终报告必须写"请在控制台该组件的端口页查看对外访问地址"，**禁止**按记忆或文档示例的 URL 格式（`<name>.<ip>.nip.io`、`<service>-<port>-<team>.<ip>.nip.io` 等）拼装一个地址当成真的。
    - **禁止**把任何拼装/猜测出来的访问地址写进任何组件 env（如 `APP_WEB_URL` / `*_BASE_URL` / `*_PUBLIC_URL` 等）。需要把对外地址回填给某个组件时，同样只能用 `access_infos` 的真实值；拿不到真实值就停下来让用户在控制台确认后提供，不要先拼一个填进去。
    - 真实事故：模型在没有任何工具返回访问地址的情况下，照文档示例格式拼出 `http://dify.<ip>.nip.io`，既写进最终报告又配进了组件 `APP_WEB_URL`，全是编造的。这是 Iron Law 违反。
41. **部署位置和访问地址必须分开。** `project.deployment_location_url` 是 Rainbond 控制台应用概览地址；仅在可信 Console base（`RAINBOND_URL` 或等价 session context）、`team_name`、`region_name` 和 `app_id` 全部已知时生成：
    `<console_base>/#/team/<urlencoded-team>/region/<urlencoded-region>/apps/<urlencoded-app-id>/overview`。
    生成时去掉 `console_base` 末尾 `/`，逐段 URL encode；任一值缺失就写 `null`，禁止从公网访问域名反推 Console host。`delivery_state.preferred_access_url` 仍按 Iron Law 40 只引用网关真实返回值，两者禁止混用。

  ## 主线流程

  1. 读取当前项目目录的本地绑定和 manifest，解析 team / region / app / environment。
  2. 如果 unlinked，执行 `rainbond-project-init`。
  3. 如果 linked 但 topology 不存在，执行 `rainbond-fullstack-bootstrap`。
  4. 如果 topology 已存在但 runtime 还没收敛，执行 `rainbond-fullstack-troubleshooter`。
  5. 如果 runtime 已足够健康且剩余问题只是交付判断，执行 `rainbond-delivery-verifier`。
  6. 如果用户明确要求开发到测试主线，且 source app 严格达到 `delivered`，才自动进入：
     `rainbond-app-version-assistant -> testing app -> rainbond-delivery-verifier`
  7. 最终返回一个 `AppAssistantResult`，顶层 `project` 仍然表示 source app。

  ## 深入子流程（deep-dive into specialized skills）

  本 skill 的主线只承诺路由+顶层判断；具体的拓扑创建、排障、交付、版本中心等执行逻辑都写在专项 skill 里（`rainbond-fullstack-bootstrap`、`rainbond-fullstack-troubleshooter`、`rainbond-delivery-verifier`、`rainbond-app-version-assistant`、`rainbond-template-installer`）。当主线判断"现在需要进入某个专项阶段"时，必须显式把该 skill 的执行手册拉到当前会话上下文中，否则你只会看到本 skill 的顶层指引、看不到专项 skill 的详细规则。

  ### 触发时机

  在主线流程进入每个专项阶段的**第一个动作之前**，从主机的可用 Skills 清单定位并完整读取对应专项 Skill 的 `SKILL.md`，再按其渐进加载规则读取本次需要的 supporting resources。同一个专项 Skill 在同一会话内只读一次。具体映射：

  | 主线阶段 | 触发条件 | 必须读取的专项 Skill |
  |---------|---------|---------------|
  | 步骤 3：topology 创建 | linked 但拓扑/组件不存在；或要从源码/镜像/包创建/补齐组件 | `rainbond-fullstack-bootstrap` |
  | 步骤 4：运行态排障 | 组件已存在但运行不健康；构建失败、CrashLoopBackOff、ImagePullBackOff 等 | `rainbond-fullstack-troubleshooter` |
  | 步骤 5：交付验收 | 运行态健康，剩下的问题是用户能否访问、URL 是否可达、文件是否落盘等 | `rainbond-delivery-verifier` |
  | 步骤 6：dev-to-test promotion | 已 `delivered`，用户要求创建快照 + 测试 app | `rainbond-app-version-assistant` |
  | 模板安装路径 | 用户要求安装本地/云端 Rainbond 应用模板到目标 app | `rainbond-template-installer` |

  ### 加载语义

  - 手册读取是本地只读动作，无需用户审批；它不是 Rainbond Tool 调用
  - 读取后必须严格按专项 Skill 的判断顺序、术语、输出契约执行，并只加载其明确路由到的 supporting resources
  - 阶段可以顺序叠加（例如 bootstrap → troubleshooter），新阶段手册在阶段性细节冲突时优先
  - 只在确认进入对应阶段后读取专项手册，不要把加载动作当作能力探索

  ### 边界

  - 顶层路由判断（"用户的意图是不是部署/排障/交付"）仍然由本 skill 负责，不要在专项 skill 加载之后回头改路由
  - 工具行为约束（如本 skill 硬规则第 30 条"源码失败后必须先 query 不能直接重 create"）即使在专项 skill 加载之后仍然有效，专项 skill 只是补充更细的操作规则
  - `rainbond-project-init` 是 workspace 型 skill，只在 Claude/Codex CLI 等有本地项目目录的客户端有意义；Web 端没有本地项目目录时，主线遇到 unlinked 直接停下来让用户在 UI 中绑定项目

  ## 停止条件

  以下情况必须停住，不再自动往下：

  - 项目未链接，且 init 还没有完成
  - team / app 选择仍然有歧义
  - source ref 无效
  - 多组件源码检测需要显式策略选择
  - Rainbond Tool / 控制面后端异常
  - `delivery-verifier` 结果只是 `delivered-but-needs-manual-validation`
  - 进入 `code_or_build_handoff_needed`
