---
name: rainbond-opensource-app-deploy
description: "Use when the user supplies a third-party Docker Compose file/content, Helm chart/values, or container image-set descriptor, or explicitly asks to deploy a named third-party open-source suite such as Harbor, Dify, or n8n. Not for the current/local project, source directory/package, an ordinary bare Git repository, private-image project, or confirmed market template; use rainbond-app-assistant for project/source requests and rainbond-template-installer for market templates."
---

# Rainbond Open-source App Deploy

处理用户实际提供的第三方 Compose、Helm、镜像集合描述符，以及 **explicit named third-party open-source suite**。先从官方来源取得可审计的部署清单，再进入 Rainbond Runtime Gate；联网取材不等于已经授权连接或修改 Rainbond。

## Phase 0：静态归属与资料取证

只根据用户意图决定归属：

- 第三方 Compose/Helm/镜像集合，或明确要求部署 Harbor、Dify、n8n 等开源套件 → 留在本 Skill。
- 当前/本地项目、源码目录或包、普通裸 Git URL、私有镜像项目 → 转到 rainbond-app-assistant。若用户同时明确说明该 Git URL 是要按上游开源套件部署，则留在本 Skill。
- 已确认的 Rainbond 本地/云端市场模板 → 转到 rainbond-template-installer。

归属确认后、任何 Rainbond 动作前，读取 [source acquisition](references/source-acquisition.md)，完成 active upstream fetch 和部署清单。普通裸 Git URL 不因仓库里可能存在 Compose 而自动改判；明确的开源套件意图才允许主动获取其官方资料。

资料尚未形成可验证清单时不得读取 references/runtime-gate.md，不得查询/连接 Rainbond、安装平台或执行 Rainbond 写操作；允许读取公开的官方仓库、文档和 Release。不得读取本机凭据、用户主目录或无关私有仓库。

## 渐进加载

不得一次性加载全部 references：

| 阶段 | 读取 |
|---|---|
| Phase 0：归属已确认、部署清单尚未验证 | 只读取 [source acquisition](references/source-acquisition.md) |
| 官方部署清单已验证，首次需要连接或调用 Rainbond | 只读取自己的 [runtime gate](references/runtime-gate.md) |
| workspace context 已解析，需要建模、部署、排障或交付 app/component | 读取 [deployment workflow](references/deployment-workflow.md) |
| 新鲜证据命中已知部署故障模式 | 再读取 [failure-mode playbook](references/failure-mode-playbook.md) |

正确顺序是：先验证官方部署清单，再加载 Runtime Gate。这里只允许加载本 Skill 的 Gate。workspace context 包含 `enterprise_id`、`team_id`、`team_name` 和 `region_name`；app/component 标识只来自用户明确输入或本次实时查询/创建结果。它们都由当前任务携带，不得生成 CLI 业务 operation ID、运行环境 ID 或 intent JSON。

## Runtime 与安全边界

官方部署清单验证后，任何 Rainbond 查询、环境连接、平台安装或变更前必须读取 references/runtime-gate.md；transport、鉴权、context、确认与运行时安全契约全部由该 Gate 提供。

- 不得绕过 Gate 或读取相邻 Skill 的 Gate。
- 可变调用先取得 confirmation ID，再用完全相同输入确认执行；写调用不得自动重放。
- 401 只允许只读调用按 Gate 恢复一次；403 立即停止。
- 不回显 JWT、密钥或凭据，不猜测组件状态、内部地址或外部 URL。

## 执行边界

解析 workspace context 后，按 [deployment workflow](references/deployment-workflow.md) 执行 **per-component image modeling**：Compose、Helm 和 installer-generated topology 都是证据来源，不是必须走的平台黑盒导入路径。配置组件、显式依赖、配置文件与存储后再部署，等待终态，有限修复，并通过真实入口和 UI/core smoke。只有证据匹配已知故障时才读取 [failure-mode playbook](references/failure-mode-playbook.md)。

Helm is evidence, not a deployment path。不得因 Rainbond Helm 解析失败就停止，也不得在没有确认上传全链路时承诺“改用 Compose”；先判断能否根据官方证据逐组件建模。配置、初始化任务、特权能力或存储语义无法完整映射时，在创建裸组件之前停止。

## 确认与停止

低风险且证据充分的动作仍受 CLI confirmation 机制约束；破坏性、数据变更、范围较广或低置信度动作必须单独确认。以下情况停止：官方来源无法形成完整清单、语义无法映射、缺少安全的必需 secret 输入、镜像不可达、集群容量失败、预算耗尽或需要人工 UI 验证。

最终只报告实际创建的拓扑、组件健康、依赖/存储验证、来自 `access_infos` 的真实地址、实际 smoke 结果和唯一未解决 blocker。
