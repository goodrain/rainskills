---
name: rainbond-app-assistant
description: "Use whenever a user asks to deploy, run, deliver, publish, inspect, repair, or troubleshoot source code, the current project, a source directory/package, a bare Git repository URL without a supplied Compose/Helm/image-set descriptor, or a named application without a descriptor. Trigger phrases: 帮我把当前项目部署到 Rainbond 上 / 帮我把这个项目跑起来 / 帮我看看当前项目卡在哪 / 如果还没初始化就先初始化，然后自动继续到应该停止的位置 / 帮我处理一下这个应用. Not for supplied third-party Compose, Helm, or image-set descriptors; use rainbond-opensource-app-deploy. Not for a confirmed market template; use rainbond-template-installer."
---

# Rainbond App Assistant

这是源码与当前项目的 Rainbond 顶层入口。它根据现状编排 init、bootstrap、troubleshooter、delivery verifier 和显式请求的 dev-to-test promotion，但不替代下层 Skill。

## 路由所有权

- 当前项目或用户明确给出的源码 Git URL：由本 Skill 接管。
- 源码目录、源码包、私有镜像项目、裸 Git URL，以及仅给应用名称且没有描述符：由本 Skill 接管。
- 用户实际提供第三方 Docker Compose、Helm 或镜像集合描述符：转到 rainbond-opensource-app-deploy。
- 已确认是 Rainbond 本地/云端市场模板：转到 rainbond-template-installer。

开始前读取 [routing](references/routing.md) 做静态归属判断。只加载最终所属 Skill 的 Runtime Gate，不得读取相邻 Skill 的 Gate。

## 渐进加载

所有 reference 必须按需加载；不得一次性加载全部 references，也不得提前读取无关 reference。

| 阶段 | 必须读取 | 禁止提前读取 |
|---|---|---|
| 初始部署或首次 Rainbond 操作 | 本根入口、[own runtime gate](references/runtime-gate.md)、[routing](references/routing.md) | 其余全部 |
| operation/context 已建立，需要编排或执行 | [workflow rules](references/workflow-rules.md)；仅在核对路线或复盘时读取 [operational reference](references/operational-reference.md) | 输出与对象细节 |
| 需要对象边界或跨阶段状态语义 | [product object model](references/product-object-model.md) | 不相关工作流 |
| 需要生成最终结果或自动化契约 | [output contract](references/output-contract.md) | 不需要结果协议时不得读取 |

这里的 operation/context 是当前任务内的业务操作与 team/region/app 上下文；不得生成或传递 CLI 业务 operation ID、运行环境 ID 或 intent JSON。

## Runtime Gate

任何 Rainbond 查询、环境连接、平台安装或变更前，必须先读取 references/runtime-gate.md。当前 Skill 在本会话首次调用 Rainbond 前强制加载且只加载自己的 Runtime Gate；随后按其中固定 launcher、skill-id、context、确认与鉴权契约执行。

不可弱化的不变量：

- 本机只连接一个 Rainbond 运行环境；不得配置或直接调用客户端 MCP。
- 连接/重新授权走浏览器 Device Flow；需要交互时附加 TTY（Codex 使用 tty: true），不得要求用户粘贴 JWT。
- 401：只读调用可在 reconnect 后重试一次；写调用不得自动重放，必须先查询真实状态。403：立即停止，不重新授权。
- 可变调用必须先取得确认 ID，再用完全相同输入附加确认执行；不得绕过确认。
- 不修改 ~/.rainbond 权限，不复制受保护状态，不搜索 launcher，不运行 npm root -g。

## 执行与安全

- 只读取当前项目内的 manifest、binding、env 与 secrets 文件，不扫描 home、父目录或相邻仓库补绑定。
- 一旦确认 source-backed 或 source ref，不得静默切换为 package/image/template 或改 branch；任何 delivery mode、workaround 或破坏性动作都需用户明确确认。
- 多 team/app 且无可靠本地提示时停止询问，禁止默认选择第一个；自动选择必须报告依据。
- 同类错误最多重试一次、同阶段最多两次，总流程默认不超过八分钟。
- 到达 code_or_build_handoff_needed 后硬停止，不自动改代码、运行本地测试、提交、推送或重试。
- 密钥只来自用户明确输入或本地 secrets 文件，永不回显或写入报告。

详细主线、operation/context 复用、代理规则、构建/运行时证据链、依赖、确认边界与尝试预算只在需要执行时读取 [workflow rules](references/workflow-rules.md)。

## 简洁结果协议

普通请求只给用户可用的中文结果：

- 成功：说明项目、运行环境、工作空间、应用、真实 Rainbond 页面/访问地址及本轮实际完成操作；无法确认的字段省略，禁止猜测。
- 未完成：输出“部署失败。”、一句直接原因；仅在确有安全可执行方案时增加“解决办法”。
- 用户明确要求结构化结果或自动化契约时，读取 [output contract](references/output-contract.md)，不得自行发明字段、枚举或状态。

## 停止条件

项目未链接且 init 未完成、身份仍歧义、source ref 无效、多组件源码需选策略、平台后端异常、集群容量阻塞、缺少必需 secret、结果仅需人工验证、达到预算、需要破坏性/超范围动作，或进入 code/build handoff 时停止并报告唯一下一步。
