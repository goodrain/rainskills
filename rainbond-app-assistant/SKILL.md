---
name: rainbond-app-assistant
description: "Use whenever a user asks to deploy, run, deliver, publish, inspect, repair, or troubleshoot source code, the current project or local project, a source directory/package, an ordinary bare Git repository URL, a private-image project, a named application that is not identified as a third-party open-source suite, or a new app/component built from one container image. Trigger phrases: 帮我部署当前项目 / 帮我把这个项目跑起来 / 帮我看看当前项目卡在哪 / 如果还没初始化就先初始化，然后自动继续到应该停止的位置 / 帮我处理一下这个应用 / 在团队下新建应用并使用镜像创建组件. Not for supplied third-party Compose, Helm, image-set descriptors, or an explicit named third-party open-source suite; use rainbond-opensource-app-deploy. Confirmed market templates use rainbond-template-installer."
---

# Rainbond App Assistant

这是源码与当前项目的 Rainbond 顶层入口。它根据现状编排 init、bootstrap、troubleshooter、delivery verifier 和显式请求的 dev-to-test promotion，但不替代下层 Skill。

## 路由所有权

- 当前项目或用户明确给出的源码 Git URL：由本 Skill 接管。
- 源码目录、源码包、私有镜像项目、普通裸 Git URL，以及未被明确识别为第三方开源套件的应用名称：由本 Skill 接管。
- 用户实际提供第三方 Docker Compose、Helm、镜像集合描述符，或明确要求部署 Harbor、Dify、n8n 等第三方开源套件：转到 rainbond-opensource-app-deploy。
- 已确认是 Rainbond 本地/云端市场模板：转到 rainbond-template-installer。

开始前读取 [routing](references/routing.md) 做静态归属判断。初始路由阶段只加载最终所属入口 Skill 的 Runtime Gate，不得提前读取专项 Skill 的 Gate。

## 渐进加载

所有 reference 必须按需加载；不得一次性加载全部 references，也不得提前读取无关 reference。

| 阶段 | 必须读取 | 禁止提前读取 |
|---|---|---|
| 初始部署或首次 Rainbond 操作 | 本根入口、[own runtime gate](references/runtime-gate.md)、[routing](references/routing.md) | 其余全部 |
| workspace context 已解析，需要编排或执行 app/component | [workflow rules](references/workflow-rules.md)；仅在核对路线或复盘时读取 [operational reference](references/operational-reference.md) | 输出与对象细节 |
| 需要对象边界或跨阶段状态语义 | [product object model](references/product-object-model.md) | 不相关工作流 |
| 需要生成最终结果或自动化契约 | [output contract](references/output-contract.md) | 不需要结果协议时不得读取 |

workspace context 包含 `enterprise_id`、`team_id`、`team_name` 和 `region_name`；app/component 标识只来自用户明确输入或本次实时查询/创建结果。它们都由当前任务携带，不写入 Runtime，也不得生成或传递 CLI 业务 operation ID、运行环境 ID 或 intent JSON。

## Runtime Gate

任何 Rainbond 查询、环境连接、平台安装或变更前，必须先读取 references/runtime-gate.md。当前 Skill 在本会话首次调用 Rainbond 前强制加载且只加载自己的 Runtime Gate；当前 profile 的 transport、鉴权、context、确认与运行时安全契约全部由该 Gate 提供。

不可弱化的不变量：

- 不得绕过 Gate 选择的 transport、context 或授权边界。进入专项阶段后，按 workflow rules 完整读取对应专项 Skill；其中重复的 Gate 只用于一致性核对，不得触发第二次连接、状态检查或 context 解析，除非 Gate 声明的失效条件已经发生。
- 401：只读调用仅可按 Gate 允许的恢复流程重试一次；写调用不得自动重放，必须先查询真实状态。403：立即停止，不做未授权重试。
- 可变调用必须先取得确认 ID，再用完全相同输入附加确认执行；不得绕过确认。
- JWT、凭据与密钥不得回显、复制到报告或通过替代 transport 绕过保护。

## 执行与安全

- 项目上下文只可来自当前 profile 与 Gate 允许的输入源；不得越权扫描，或把不可用的客户端文件当成事实。
- 一旦确认 source-backed 或 source ref，不得静默切换为 package/image/template 或改 branch；任何 delivery mode、workaround 或破坏性动作都需用户明确确认。
- 多 team/app 且无可靠本地提示时停止询问，禁止默认选择第一个；自动选择必须报告依据。
- 同类错误最多重试一次、同阶段最多两次，总流程默认不超过八分钟。
- 到达 code_or_build_handoff_needed 后硬停止，不自动改代码、运行本地测试、提交、推送或重试。
- 密钥只来自当前 profile 允许的输入源，永不回显或写入报告。

详细主线、context 复用、专项手册加载、构建/运行时证据链、依赖、确认边界与尝试预算只在需要执行时读取 [workflow rules](references/workflow-rules.md)。

## 简洁结果协议

普通请求只给用户可用的中文结果：

- 成功：说明项目、运行环境、工作空间、应用、真实 Rainbond 页面/访问地址及本轮实际完成操作；无法确认的字段省略，禁止猜测。
- 未完成：输出“部署失败。”、一句直接原因；仅在确有安全可执行方案时增加“解决办法”。
- 默认不得展示内部对象、状态枚举、Skill/工具名、YAML、JSON 或英文编排标题。
- 用户明确要求结构化结果或自动化契约时，读取 [output contract](references/output-contract.md)，不得自行发明字段、枚举或状态。

## 停止条件

项目未链接且 init 未完成、身份仍歧义、source ref 无效、多组件源码需选策略、平台后端异常、集群容量阻塞、缺少必需 secret、结果仅需人工验证、达到预算、需要破坏性/超范围动作，或进入 code/build handoff 时停止并报告唯一下一步。
