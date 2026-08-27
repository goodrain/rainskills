---
name: rainbond-opensource-app-deploy
description: "Use only when the user actually supplies a third-party Docker Compose file/content, Helm chart/values, or container image-set descriptor. Never use for a bare Git URL, source project/directory/package, named application without a descriptor, private-image project, or confirmed market template; route source and named-only requests to rainbond-app-assistant and market templates to rainbond-template-installer."
---

# Rainbond Open-source App Deploy

只处理用户实际提供的第三方 Compose、Helm 或容器镜像集合描述符。核心顺序是：先验证描述符，再加载 Runtime Gate；不得为了确认资格而接触 Rainbond 或外部源码。

## Phase 0：静态资格判断

只使用用户当前消息中明确提供的输入判断：

- 实际 Docker Compose 文件/内容、Helm chart/values、容器镜像集合描述符 → 留在本 Skill。
- 裸 Git URL、源码目录、源码项目、源码包、私有镜像项目，或只给应用名称而没有描述符 → 转到 rainbond-app-assistant。
- 已确认的 Rainbond 本地/云端市场模板 → 转到 rainbond-template-installer。

裸 Git URL 不是部署描述符。不得通过 clone、浏览 Git、搜索仓库或读取源码来寻找 Compose/Helm，从而把 App Assistant 的请求改判给本 Skill。描述符是否存在不清楚时，只询问用户是否能提供实际描述符。

未确认描述符时不得读取 references/runtime-gate.md；也不得加载任何 reference、查询/连接环境、安装平台、调用 Rainbond、克隆或浏览 Git、读取外部文档或做任何变更。

## 渐进加载

不得一次性加载全部 references，只加载当前阶段所需文件：

| 阶段 | 读取 |
|---|---|
| Phase 0：描述符未确认 | 不加载 reference；只做上述静态资格判断 |
| 描述符已确认，首次需要连接或调用 Rainbond | 只读取自己的 [runtime gate](references/runtime-gate.md) |
| workspace context 已解析，需要建模、部署、排障或交付 app/component | 读取 [deployment workflow](references/deployment-workflow.md) |
| 新鲜证据命中已知部署故障模式 | 再读取 [failure-mode playbook](references/failure-mode-playbook.md) |

正确流程只加载本 Skill 的 Runtime Gate，不得读取 rainbond-app-assistant 或其他相邻 Skill 的 Gate。workspace context 包含 `enterprise_id`、`team_id`、`team_name` 和 `region_name`；app/component 标识只来自用户明确输入或本次实时查询/创建结果。它们都由当前任务携带，不得生成 CLI 业务 operation ID、运行环境 ID 或 intent JSON。

## Runtime 与安全边界

静态确认描述符后，任何 Rainbond 查询、环境连接、平台安装或变更前必须先读取 references/runtime-gate.md；当前 profile 的 transport、鉴权、context、确认与运行时安全契约全部由该 Gate 提供。

- 不得绕过 Gate 选择的 transport、context 或授权边界，也不得读取相邻 Skill 的 Gate。
- 可变调用必须先取得确认 ID，再用完全相同输入确认执行；写调用不得自动重放。
- 401 只允许只读调用按 Gate 允许的恢复流程重试一次；403 立即停止且不做未授权重试。
- 不回显 JWT、密钥或凭据，不猜测 component state、内部地址或外部 URL。

## 执行边界

确认资格并解析 workspace context 后，按 [deployment workflow](references/deployment-workflow.md) 从官方描述符推导完整拓扑、配置组件与依赖、等待终态、检查健康、有限修复并通过真实入口交付门禁。只有证据匹配已知故障时才读取 [failure-mode playbook](references/failure-mode-playbook.md)。

不得把镜像已导入或容器全绿当成交付完成；真实访问地址必须来自 Rainbond，且需要完成应用 UI/core smoke。UI 自动化不可用时停在 needs manual UI validation。

## 确认与停止

低风险且证据充分的 Rainbond 侧动作可在既有授权范围内继续；破坏性、数据变更、范围较广或低置信度动作必须先确认。以下情况停止：缺少/无法确认描述符、确认市场模板、语义无法映射、缺少必需能力或 secret、镜像不可达、集群容量失败、源码/构建缺陷、预算耗尽、需要人工 UI 验证，或任何相邻 Skill 才拥有的请求。

最终只报告真实拓扑、组件健康、依赖/存储验证、来自 access_infos 的访问 URL、实际 smoke 结果，以及唯一未解决 blocker。
