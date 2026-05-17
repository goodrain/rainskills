---
name: rainbond-app-assistant
description: >
  Use for any request to deploy, run, deliver, publish, or troubleshoot the
  current project — regardless of whether the user mentions "Rainbond" by name.
  Triggers on generic intents such as: 帮我把项目跑起来 / 部署这个项目 / 发布上线 /
  看看为什么跑不起来 / 帮我交付 / 排查一下 / deploy this project / run this app /
  check what is blocking it. Prefer this skill when a Rainbond MCP connection
  is configured in the session. Handles the full lifecycle: project-init,
  bootstrap, troubleshooting, delivery verification, dev-to-test promotion,
  and code-layer handoff.
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

  Preflight 失败时必须给用户的动作建议，需要先区分场景：

  - 如果用户机器上已存在 `~/.rainbond/mcp.env` 或 `~/.rainbond/skills/install.sh`，
    判定为「已装过，多半是 JWT 过期 / 401 / 403」，给出 refresh 指引：

    ```bash
    bash <(curl -fsSL https://get.rainbond.com/rainskills/install.sh) refresh
    # 或：bash ~/.rainbond/skills/install.sh refresh
    ```

    成功后必须提醒用户**重启 Claude Code 或 Codex**（MCP 客户端在进程启动时一次性
    读取 `RAINBOND_JWT`，文件刷新不会自动透传到运行中的客户端），用户重启完成后再让其重新
    触发同一指令。本轮不要自动重试同一个 MCP 工具调用。

  - 否则视为首次安装，给完整安装命令：

    ```bash
    bash <(curl -fsSL https://get.rainbond.com/rainskills/install.sh)
    ```

    安装脚本会配置 MCP server、保存 JWT、并验证 `/console/mcp/query` 可用。
    配置完成后重新触发同一指令即可。

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
  2. **team / app 智能选择**：
     - 单个 team 可访问 → 直接用，不询问。
     - 多个 team 但 manifest（`rainbond.app.json` / `.rainbond/local.json`）显式指定了 `team_name` 且该 team 在可访问列表里 → 直接用，在报告里明确说"已选 team = X（来自 manifest）"。
     - 多个 team 且无 manifest 提示 → 停下来询问用户，**禁止**静默选 `default` / 第一个 / 任意已有 team。
     - app 选择同上逻辑：manifest 指定且可解析 → 直接用；无提示且多候选 → 询问。
     - 任何自动选择的结果都必须在最终报告里以"已选 X（理由：来自 manifest / 单一可选）"形式告知，邀请用户覆盖。
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
17. 如果源码检测同时命中 Dockerfile 和语言构建，只有用户明确要走 Dockerfile 时才建议 `prefer_dockerfile_when_detected = true`。
18. 当前 MCP 不支持显式 `dockerfile_path` 时，不要在顶层编排里承诺该能力。
19. 对 reverse-proxy full-stack 项目，不要只因为根路径 URL 存在就把它当作最终交付成功或 Fast Path 的可信 URL；同 host 的 backend 路径（通常是 `/api`）必须也一致可用，或明确停在 blocker。
20. 对数据库、Redis、Kafka 等中间件，优先把共享连接变量建在 provider 组件的 connection envs 上，并通过显式依赖注入到 consumer；不要优先在每个 consumer 上重复写 `DB_*`、`REDIS_*`、`KAFKA_*` 连接变量。
21. 如果依赖关系已经存在，但运行时仍出现 `ENOTFOUND db`、错误 host、错误 port、缺少 `DB_PASS` 等问题，优先把问题视为 provider connection env / dependency alias / compatibility env 问题，而不是把 baseline 里的硬编码主机名当作正确事实。
22. Rainbond MCP 已提供 `rainbond_manage_component_dependency` 用于显式组件依赖管理。只要项目拓扑存在 `depends_on`、provider/consumer 关系、反向代理链路、或运行时日志暴露出缺失依赖，就必须把显式依赖作为可执行能力处理；禁止回答“当前 MCP 没有创建组件依赖接口”。如果调用失败，按 MCP/控制面错误报告失败原因，而不是把它描述为工具不存在。
23. 对多组件拓扑，在进入最终交付验收前必须确保下层 bootstrap/troubleshooter 已完成依赖完整性 gate：列出已接受的 provider/consumer 边，查询现有依赖，补齐缺失显式依赖，再次验证依赖摘要。手工创建镜像组件、Compose 上传失败后的 fallback 路径、或组件本身能独立启动，都不能跳过这个 gate。
24. 不要自动拉起本地 Docker Desktop/OrbStack、执行本地 Docker build/push、或推送临时镜像作为兜底；这属于 delivery-mode 策略切换，必须先得到用户明确确认。
25. 每次运行内部仍必须形成 `AppAssistantResult` 结果对象，但默认用户答复不一定暴露 YAML。
    当 source app 已严格 `delivered`、`next_action = stop`、没有 promotion、没有 blocker，且用户没有要求结构化/调试输出时，默认使用简洁中文交付报告，不追加 `### Structured Output`。
26. 只有在自动化/评测/调试模式、用户明确要求结构化输出、结果未完全交付、需要人工验证、需要 handoff、或进入 dev-to-test promotion 时，才把 `AppAssistantResult` 渲染为最终 fenced `yaml`。
27. 如果本次使用了 Git、镜像仓库或其他传输代理，必须在默认交付报告的处理记录或注意事项中说明；在结构化模式下也必须写入 `actions_performed[].details`。
    代理事实属于执行记录，不是强制暴露 YAML 的理由。
28. `rbd-*` 组件（rbd-gateway、rbd-api、rbd-worker、rbd-chaos、rbd-db、rbd-mq、rbd-monitor、rbd-node 等）是 Rainbond 平台自身的基础设施组件，不是用户应用组件。
    - 可以用 `rainbond_query_region_rbd_components` 查询并展示它们的状态
    - 不能通过 MCP 对它们执行重启、部署、修改等写操作；当前 MCP 工具集不支持此类操作
    - 如果用户要求操作这些组件，明确告知：需要通过 Kubernetes 命令（如 `kubectl rollout restart deployment/<name> -n rbd-system`）或 Rainbond 集群管理控制台进行，超出本技能的操作范围，不要假装可以执行
29. 如果用户提示词中**仅包含一个外部 Git URL**（无本地 manifest 文件，当前目录不属于该项目），在进入 project-init 之前必须先询问：
    - 要部署的是仓库根目录，还是某个具体子目录？
    - **禁止**根据模型对该仓库的先验知识，自动把多个子目录展开成多个组件后直接创建
    - 用户明确给出子目录（或确认部署根目录）后，才继续进入 project-init → bootstrap 主线
    - 此规则与 `rainbond-project-init` 硬规则 11 配套，共同防止多 example 仓库触发批量"数据中心异常"
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
31. **任何 Rainbond MCP 写工具调用之前**，必须先按下面的映射调用对应的 `select_skill_<id>` 工具，把该阶段的执行手册加载进会话上下文；没先调 `select_skill_<id>` 就直接动手等于**无授权操作**，是 Iron Law 违反。
    触发动作（凡是这类，第一次调之前都必须先 `select_skill_<id>`）：
    - 创建/更新/部署组件：`rainbond_create_component_from_source`、`rainbond_create_component_from_image`、`rainbond_create_component_from_package`、`rainbond_create_component_from_local_package`、`rainbond_create_component`、`rainbond_build_component`、`rainbond_update_component_build_source`、`rainbond_change_component_image`
    - 组件配置：`rainbond_manage_component_envs`、`rainbond_manage_component_ports`、`rainbond_manage_component_connection_envs`、`rainbond_manage_component_dependency`、`rainbond_manage_component_storage`、`rainbond_manage_component_probe`、`rainbond_manage_component_autoscaler`
    - 应用操作：`rainbond_operate_app`、`rainbond_horizontal_scale_component`、`rainbond_vertical_scale_component`、`rainbond_delete_component`
    映射表：
    - 当前 run 是**首次部署/创建组件/补齐拓扑**（含从源码/镜像/包/本地包创建） → 在第一个 MCP 写调用之前调 `select_skill_rainbond-fullstack-bootstrap`
    - 当前 run 是**排查运行态/构建失败**（CrashLoopBackOff / ImagePullBackOff / 构建报错 / 端口/依赖不通） → 在第一个 MCP 写调用之前调 `select_skill_rainbond-fullstack-troubleshooter`
    - 当前 run 是**交付验收**（验证 URL 可达、reverse-proxy 路径连通） → 调 `select_skill_rainbond-delivery-verifier`
    - 当前 run 是**开发到测试 promotion**（创建快照 + 测试 app） → 调 `select_skill_rainbond-app-version-assistant`
    - 当前 run 是**模板安装**（本地/云端 Rainbond 应用模板） → 调 `select_skill_rainbond-template-installer`
    规则细节：
    - `select_skill_<id>` 本身不需用户审批、不消耗 MCP，但它的调用是**前置门控**，没调不允许走下去
    - 一个 skill 在同一次 run 内只需调一次（重复调用工具会返回 "already active" ack）
    - **判断依据**：用户消息中只要含"部署 / 跑起来 / 上线 / 创建组件 / 发布"等部署意图，且当前 app 还没有对应组件，就必然要先 `select_skill_rainbond-fullstack-bootstrap`，不论用户是不是显式说"先 deep dive"
    - 如果一次 run 内场景跨阶段（先创建后排障），按需追加 `select_skill_<id>`，旧的不会被卸载
32. **用户对你的提问做了简短回答后，第一动作必须用这个回答继续上一个被中断的操作，禁止重新走诊断流程。**
    当你的上一轮回复明确问了用户某个参数值（"请问正确的子目录路径是什么"、"请告诉我用哪个 git 分支"、"请确认仓库地址是不是 X"），用户给了任何**简短或单值**回复（"maven-demo"、"试试 master"、"对的就是 X"、"不是，是 Y"），你的**下一个动作必须是**：
    - 找到上一轮诊断里相关的 `service_id`、`app_id` 等上下文（在 priorTurnMessages / 已有 tool result 里）
    - **直接**用用户的新值调对应的**修改类工具**：
      - 子目录 / git_url / 分支 / 凭证类参数 → `rainbond_update_component_build_source(service_id=..., subdirectories=<新值>)` → **必须**接 `rainbond_check_component(service_id=..., is_again=true)` 重新触发源码检测，再轮询 `rainbond_get_component_check_result`。不要直接调 `rainbond_build_component`——组件还在 `checking` 状态时构建会被卡住（见 Iron Law 33）
      - 构建参数（语言版本、入口命令）→ `rainbond_manage_component_envs(operation=replace_build_envs, build_env_dict=...)` 然后 `rainbond_build_component`
      - 镜像地址 → `rainbond_change_component_image` 然后 `rainbond_build_component`
    - **禁止**的反应：
      - 重新调用 `rainbond_get_app_detail` / `rainbond_query_components` / `rainbond_get_component_summary` / `rainbond_get_component_build_source` / `rainbond_get_component_events` / `rainbond_get_component_check_result` 重新走"诊断"——你上一轮已经诊断过了，组件、错误、上下文都在对话历史里
      - 重新加载 skill manual（"加载 bootstrap"）—— 同 run 内只加载一次，priorTurnMessages 里已经看得到 `loaded_skill` ack
      - 再次反问用户"是不是要这样"做确认——用户已经给了答案，直接执行
      - 重新走"询问子目录 → 等用户回答"流程
    - **判断"是不是简短回答"**：用户的消息长度 < 一句长句、不含完整指令性句子（如"现在帮我重启 X 组件"才算指令）、且明显是对上一个提问的回应——就视作简短回答。
    - **简短回复必须继承上一轮被问的字段，不允许换 intent**：上一轮你问的是字段 X 的值（如"正确的子目录路径"），本轮用户的简短回复**只能**解释为 X 的新值。即便回复字面在其他上下文里有歧义（例如在询问子目录时用户回 `java/jar`——可能是路径，也可能被误读成"用 java 或 jar 模式"），也**禁止**把它当成换 intent；如果你认为字面有 ≥2 种合理解释，**必须 follow-up 反问澄清一句**（"你是说子目录路径是 java/jar，还是想换部署方式？"），不允许自己挑一个走下去。
    - 例外：用户的新消息明确**改了任务方向**（"算了别部署了"、"换个项目部署"、"先停下"），这时不算简短回答，按新任务处理。
    反例（**禁止**）：用户上一轮回答"试试 maven-demo"，你再去调 `rainbond_get_app_detail`、`rainbond_query_components`、`rainbond_get_component_summary`、`rainbond_get_component_build_source`、`rainbond_get_component_events`、`rainbond_get_component_check_result` 重新走诊断 → 又得到同样的"源码目录不存在" → 又问用户。这是浪费用户时间 + 浪费 LLM 轮次预算，属于 Iron Law 违反。
    另一反例（**禁止**）：上一轮问"子目录路径"，用户答"试试 java/jar 可以吗"，你把它当成"用 Java JAR 上传方式"反问用户走偏。正确做法：要么按子目录处理（调 `update_component_build_source(subdirectories='java/jar')` → `check_component(is_again=true)`），要么明确反问"你是说子目录 `java/jar`，还是换部署方式？"
    正确路径：用户说"试试 maven-demo" → 你直接调 `rainbond_update_component_build_source(service_id=已知的, subdirectories='maven-demo')` → `rainbond_check_component(service_id=已知的, is_again=true)` → 轮询 `rainbond_get_component_check_result` 直到拿到新一轮 `check_event_id`/`check_uuid` 的结果。
33. **`rainbond_update_component_build_source` 只改 DB 不触发检测**，调完之后下一个 MCP 写调用**必须**是 `rainbond_check_component(service_id=..., is_again=true)`，不允许中间夹任何其他工具，也不允许跳过它直接读 check_result 或调 build。
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
34. **service_id provenance：任何 MCP 写工具传入的 `service_id` 必须有明确出处**，不允许凭模型记忆或上下文里飘着的 UUID 猜。
    合法的 `service_id` 来源（按优先级）：
    - 本会话内 `rainbond_query_components` 的返回结果（最新一次）
    - 本会话内 `rainbond_create_component_*` 工具的返回值
    - `session.localBinding.serviceId` / `priorTurnMessages` 里同一 `service_cname` 的 ack
    不合法的 `service_id` 来源（**禁止**）：
    - 从对话历史里随手抓一个看起来像 UUID 的字符串（可能是 `check_event_id` / `check_uuid` / `event_id` / 历史 service_id）
    - 凭"我记得是这个"或"上次也是这个 ID"做猜测
    - 用户消息里粘的、但本会话没验证过的 ID
    强制流程：动手前如果不能 100% 确定 `service_id` 出处，**第一动作**必须是 `rainbond_query_components(team_name, region_name, app_id)`，按 `service_cname` 或 `k8s_component_name` 匹配出真实 `service_id`，再调写工具。
    反例（**禁止**）：日志里出现"修改组件 `7059eb62cccc3a16f22c9415c905bbcc` 的构建源" — 这个 ID 在本会话所有 query 结果里都没出现过，是模型从某处幻觉出来的。正确做法：调 update 之前先 `rainbond_query_components` 拿到真实 `service_id`，再 update。
    与 Iron Law 31 配套：31 管"写工具前必须 select skill"，34 管"写工具的 service_id 必须有明确出处"。两条共同把"模型自由发挥参数"这条路堵死。
35. **会话内部叙述纪律 + 内部 preflight 工具不要主动调**。下列四类是"内部会话状态"，对用户**无信息量**，禁止外漏到 assistant 可见消息：
    - **`select_skill_*` 工具调用本身**：这是 server 内部 hookup，把指定 skill 的执行手册拼到 system prompt 用的。调用前**不要**说"我先加载 bootstrap 手册"、"现在调用 select_skill_..."；调用后**不要**说"Bootstrap 手册已加载"、"skill ready" 这类回声。server 返回的 `loaded_skill` / `already active` ack 是给你看的内部信号，**直接进入下一个真实工具调用**，保持沉默。
    - **`rainbond_get_current_user`**：本工具被 server 端 AuthSubjectResolver 在每次 HTTP 请求的 preflight 里跑过了。当前 user_id / username / enterprise_id / team_name / region_name **已经在 system prompt 的 session-context 段提供**，需要时直接读那里，**不要发 tool call 重新拉**。例外：用户明确说"我换了团队/企业，重新认一下"这种 explicit 重认证需求才调。
    - **`rainbond_query_components` 同入参重复轮询**：服务端 30s 内的同 args 调用会走缓存；你**不要**在每个新 user turn 开头都"先查一下组件列表"，priorTurnMessages 里上一次的 query 结果在 contextSignature 不变时仍然有效。
    - **规则推理过程 / MCP 工具内部限制**：你内部基于哪条 Iron Law / hard rule / 推断信号做的决策，以及具体 MCP 工具签名 / 字段限制，属于内部状态，对用户**无信息量**。
      
      **禁止**这类叙述：
      - "根据推断规则——ClickHouse 是公认的列式分析数据库，所以采用 image 模式"
      - "根据镜像代理规则，clickhouse:latest 解析为 docker.io/library/clickhouse:latest，应使用代理 docker.1ms.run"
      - "由于 rainbond_create_component_from_image 不支持直接设置 extend_method，需要先创建再修改"
      - "根据 hard rule 2 我需要先查 team 列表"
      - "Iron Law 14 要求尝试预算最多 2 次，所以..."
      
      **应该改为**结果导向的用户语言：
      - "已用镜像代理 docker.1ms.run/library/clickhouse:latest 加速拉取"
      - "ClickHouse 是持久化数据库，已挂载存储到 /var/lib/clickhouse"
      - "需要确认 team 选择，请选一个："
      
      原则：用户关心**结果和你即将做什么**，不关心你**为什么决定这么做**。规则名 / 工具字段限制 / 推断信号在最终报告的 `actions_performed[].details` 或 `decision_reasons` 里出现是允许的（结构化字段），但 prose 流水里出现就是噪音。
    
    **同一个 `<skill_id>` 在 session 内最多 select 一次（跨 user turn 也算）**，但**不同 skill 之间切换永远允许**（典型流程：bootstrap 部署 → troubleshooter 排障 → delivery-verifier 验收 → version-assistant promote，每切一个阶段调一次新的 select_skill_<id>）。判断方式：如果当前会话的 priorTurnMessages 里已经出现过该 `skill_id` 的 `loaded_skill` 或 `already active` tool_result，**不要再调** `select_skill_<that-same-id>`；但如果你要切到另一个 skill_id（如从 bootstrap 切到 troubleshooter），就**必须**调 `select_skill_<new-id>` 一次。
    
    反例（**禁止**）：上一轮已经 `select_skill_rainbond-fullstack-bootstrap` 过了，本轮 user 简短回复 "java/jar"，你又调一次 `select_skill_rainbond-fullstack-bootstrap` 并叙述"先加载 bootstrap"。正确做法：priorTurnMessages 已有 ack → 直接 `rainbond_update_component_build_source(...)` 继续。
    正例：上一轮 `select_skill_rainbond-fullstack-bootstrap`，本轮用户说"组件起不来帮我排查下" → 现在阶段从部署切到排障 → 调一次 `select_skill_rainbond-fullstack-troubleshooter`（新 skill，允许）→ 沉默地进入诊断流程，不复述"troubleshooter 已加载"。
36. **用户给出的字面值（URL / 镜像地址 / 分支名 / 凭证）必须 verbatim 传给工具，禁止 LLM 凭训练知识"补全"、"修正"、"猜测"**。
    适用字段：`git_url` / `image_address` / `code_version`（分支/tag/commit）/ `username` / `password` / `token` / `subdirectories` 等任何用户在消息里给出的字面值。
    **禁止行为**：
    - 看到 `service_cname=java-maven-demo` 就自创 `git_url=https://gitee.com/mirrors_123/java-maven-demo.git`（按训练数据里"常见仓库地址"补全）
    - 用户给的 URL 没 `.git` 后缀就自动加上
    - 用户给的 URL 是 `gitee.com/xxx/yyy`，你"知道这个仓库其实在 GitHub" 就改成 `github.com/...`
    - 用户给了主仓库 URL（`https://gitee.com/rainbond/sourcecode-examples`），你把它换成你以为的子项目独立仓库（`https://gitee.com/some-org/java-maven-demo.git`）—— 同一个仓库下的不同子项目应该用**同一个 URL + subdirectories 参数**区分，而不是换 URL
    - 用户没说分支，你自己写 `code_version=main` 或 `master` 当默认值（应该让后端/MCP 默认值生效，传 `master` 的前提是用户说过 master 或者你是 carrying over 从已有组件 build_source 拿到的字面值）
    
    **正确做法**：
    - 用户消息里出现的 URL/分支/凭证，**逐字符 copy** 传给工具
    - 用户消息**没有**给某个字段（如只说"部署 X 项目"没给 git_url）→ 必须**问用户**要这个字段，不允许自创
    - 如果你认为用户给的值有问题（域名错、路径不对），**让后端报错**而不是预先"修正"——后端的报错是把决定权交回用户的正确路径
    - 唯一允许"非用户消息字面"的 git_url 来源：本会话内 `rainbond_get_component_build_source` 的返回（即"维持已有组件的 git_url 不变"场景）；这种情况下你必须能在 priorTurnMessages 的 tool_result 里指出该值的来源
    
    **wire 层 gate（Iron Law 36 enforcement）**：server 会拦截 `rainbond_create_component_from_source` / `rainbond_update_component_build_source` 调用，验证 `git_url` 的 host+owner（如 `gitee.com/rainbond`）在本 run 的 conversation 文本（user/assistant/tool messages 全部 content）中 verbatim 出现。命不中直接 reject 并要求 LLM 停下来问用户。所以**自创 URL 不会过 wire**，只是浪费一次 LLM 轮次。
    
    反例（**禁止**）：用户说"帮我部署 https://gitee.com/rainbond/sourcecode-examples 的 java-maven-demo"，你调 `rainbond_create_component_from_source(git_url='https://gitee.com/mirrors_123/java-maven-demo.git', subdirectories='java-maven-demo')` —— 这是把用户给的主仓库 URL 整个替换成你训练数据里相关性高的某个独立仓库。
    正确做法：`rainbond_create_component_from_source(git_url='https://gitee.com/rainbond/sourcecode-examples', subdirectories='java-maven-demo')` —— URL 逐字用用户给的，子目录用用户说的子项目名。
37. **组件创建方式智能推断（image vs source）**：用户请求创建组件时，**根据用户消息里的信号自动推断创建方式**，不要停下来问"用镜像还是源码？"。
    
    推断信号优先级（从强到弱）：
    - 用户提到 Git URL / 分支 / commit / `subdirectories` → **source 模式**
    - 用户提到 image tag / registry 路径（如 `<name>:<tag>`、`docker.io/...`、`harbor.../...`）→ **image 模式**
    - 用户只说组件名，且该名指向**公认的、通常以容器镜像形式部署的基础设施软件**（数据库、消息队列、缓存、对象存储、观测/监控、Web 服务器、反向代理/负载均衡、注册中心、密钥管理等类别下被广泛使用、有官方/社区维护镜像的项目）→ **image 模式**，默认镜像名 `<name>:latest`（再经 Iron Law 6 代理改写）。这里用你自己的通用知识判断，**不要**等清单或穷举匹配。
    - 用户只说组件名，且该名是项目专属或来历不明（如 `my-api`、`order-service`、`payment-svc` 等业务命名风格） → 信号不足，**这时才**问"用镜像还是源码？"
    
    判断标准（principle 而非清单）：
    - 在你的知识里，这个名字是不是**一个有公开镜像的成熟基础设施软件**？是 → image。
    - 这个名字是不是**业务领域命名风格**（含动词、含组织名、含具体业务概念）？是 → 问。
    - 介于两者之间不确定？**优先按 image 默认**（更常见的部署方式）并在报告里告知推断理由，邀请用户覆盖。
    
    自动推断的结果必须在最终报告里说明，例如："已按 image 模式创建 clickhouse 组件（推断依据：该名为公认的列式分析数据库）。如需改用源码请告知。"
    
    **禁止行为**：
    - 用户给了 git_url 还问"用镜像还是源码？"（信号已经明确）
    - 用户给了 image tag 还问"用镜像还是源码？"（信号已经明确）
    - 对一个你的训练知识里明显是基础设施软件的名字（不管是否在某个示例清单里）问"用镜像还是源码？" —— Nginx、Redis、ClickHouse、Jaeger、Loki、OpenTelemetry Collector 都属于这一类，未来出现的新项目也会属于这一类，用判断不要用穷举
    
    **stateful 服务的持久化要求**：当推断结果是 image 模式 **且** 该服务属于 stateful 范畴（数据库 / 持久化消息队列 / 搜索引擎 / 时序库 / 对象存储 / 向量库 / 图库等 — 数据必须跨重启存活的任何服务），**必须**在 deploy 之前配好持久化。
    
    **平台现实（fact）**：`rainbond_create_component_from_image` 和 `rainbond_create_component_from_source` 都不暴露 `extend_method` 参数，平台也没有 stateless→stateful 的转换工具。所以镜像/源码模式创建的组件**必然是 stateless**。不要尝试创建后再"改成 stateful"，做不到。
    
    **持久化方案**：
    1. 用 `rainbond_manage_component_storage(operation=create_volume, volume_type=share-file, volume_path=<官方数据目录>)` 在服务的数据目录挂 RWX 共享文件存储（stateless 组件能挂）
    2. 然后 `rainbond_operate_app(action=deploy)` — **先挂存储再 deploy**，顺序不能反
    3. **禁止**用 `volume_type=local`（local 强制要求 stateful，平台会 HTTP 400 拒绝）
    
    **需要 stateful + local volume（高 IOPS 数据库）的唯一路径**：通过 `rainbond_install_app_model` 从应用市场安装预配置的 stateful 模板。镜像/源码模式做不到这件事，不要假装能做。
    
    具体的官方数据目录清单、`volume_type` 兼容矩阵、识别 stateful 服务的范畴边界详见 bootstrap skill 的 `modules/30-creation-rules.md § 5`。stateful 服务用 image 模式部署却没配持久化是真实回归 bug（pod 重启数据丢失），禁止以"模型不知道这个 service 是 stateful"或"工具不支持 extend_method"为由跳过持久化步骤。

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

  在主线流程进入每个专项阶段的**第一个动作之前**，调用对应的 `select_skill_<id>` 工具一次（同一个 skill 在同一次 run 内只需调一次，后续都已生效）。具体映射：

  | 主线阶段 | 触发条件 | 必须先调的工具 |
  |---------|---------|---------------|
  | 步骤 3：topology 创建 | linked 但拓扑/组件不存在；或要从源码/镜像/包创建/补齐组件 | `select_skill_rainbond-fullstack-bootstrap` |
  | 步骤 4：运行态排障 | 组件已存在但运行不健康；构建失败、CrashLoopBackOff、ImagePullBackOff 等 | `select_skill_rainbond-fullstack-troubleshooter` |
  | 步骤 5：交付验收 | 运行态健康，剩下的问题是用户能否访问、URL 是否可达、文件是否落盘等 | `select_skill_rainbond-delivery-verifier` |
  | 步骤 6：dev-to-test promotion | 已 `delivered`，用户要求创建快照 + 测试 app | `select_skill_rainbond-app-version-assistant` |
  | 模板安装路径 | 用户要求安装本地/云端 Rainbond 应用模板到目标 app | `select_skill_rainbond-template-installer` |

  ### 调用语义

  - `select_skill_<id>` 是当前会话的载入指令，不消耗 MCP 工具，无副作用，无需用户审批
  - 调用后该 skill 的完整执行手册立即进入系统提示，后续动作必须严格按该 skill 的判断顺序、术语、输出契约执行
  - 多个专项 skill 可以叠加加载（例如 bootstrap → 发现需要排障 → 再 `select_skill_rainbond-fullstack-troubleshooter`），新加载的 skill 在主题冲突时优先级更高
  - 不能用调用 `select_skill_<id>` 来"探索这个 skill 是什么意思"——只在确认要进入对应阶段时调用

  ### 边界

  - 顶层路由判断（"用户的意图是不是部署/排障/交付"）仍然由本 skill 负责，不要在专项 skill 加载之后回头改路由
  - 工具行为约束（如本 skill 硬规则第 30 条"源码失败后必须先 query 不能直接重 create"）即使在专项 skill 加载之后仍然有效，专项 skill 只是补充更细的操作规则
  - `rainbond-project-init` 是 workspace 型 skill，只在 Claude/Codex CLI 等有本地项目目录的客户端有意义；在 Web 端 rainagent 中**不存在** `select_skill_rainbond-project-init`，主线遇到 unlinked 时直接停下来让用户在 UI 中绑定项目

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
