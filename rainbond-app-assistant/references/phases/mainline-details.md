# mainline-details

3. 单入口主线一旦触发：
     `project-init -> bootstrap -> troubleshooter -> delivery-verifier -> version-assistant -> testing-app delivery-verifier`
     应按 gate 自动继续，不要在中途停成“下一步建议”。

31. **任何 Rainbond 写工具调用之前**，必须先完整读取当前阶段对应专项 Skill 的 `SKILL.md`，再按其渐进加载规则读取本次动作需要的 modules / references；没有执行手册就直接动手等于**无授权操作**，是 Iron Law 违反。
    触发动作（凡是这类，第一次调用之前都必须先加载对应专项手册）：
    - 创建/更新/部署组件：`rainbond_create_component_from_source`、`rainbond_create_component_from_image`、`rainbond_create_component_from_package`、`rainbond_replace_component_package`、`rainbond_create_component`、`rainbond_build_component`、`rainbond_update_component_build_source`、`rainbond_change_component_image`
    - 包上传事务：`rainbond_init_package_upload`、`rainbond_delete_package_upload`；包内容必须由 bootstrap 的客户端 helper 上传，完成后根据组件是否存在选择 event-based package create 或 replace
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

39. **轮次纪律：复用已知值，不重复无变化的调用**（与 Iron Law 35 的"内部 preflight 工具不要主动调"配套，35 管哪些工具不该调，39 管已拿到的值要复用）：
    - **复用创建返回的 `service_id` / `service_alias`**：`rainbond_create_component_*` 成功后会返回 `service_id` 和 `service_alias`（k8s component name），**记住并在本轮后续 mutating 操作里直接复用**。**禁止**在每次 `rainbond_manage_component_*` / `rainbond_operate_app` 之前都先 `rainbond_query_components` 重查一遍 alias —— 创建时已经返回过，重查只是浪费轮次（仅当 `service_id` 出处不明、按 Iron Law 34 必须重新建立 provenance 时才查）。
    - **不重复调 `rainbond_get_current_user`**：复用当前任务直接携带的 enterprise/team/region 参数；只有唯一运行环境变化、上下文失效或用户明确切换目标时才重新执行无状态 `context resolve`。
    - **同一 mutating 调用成功后禁止原样重复**：一个写工具用相同入参成功返回后，不要在同一轮再发一次相同调用"确认一下"——成功就是成功，要确认状态用读工具（`rainbond_get_component_summary` 等），不要重发写调用。

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
