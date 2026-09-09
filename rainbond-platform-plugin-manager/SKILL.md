---
name: rainbond-platform-plugin-manager
description: Use for discovering, installing, enabling, upgrading, uninstalling, or checking a Rainbond Console platform plugin or feature extension. Do not use for installing Rainbond itself, deploying ordinary apps, or managing AI models after the plugin is ready.
---

# Rainbond Platform Plugin Manager

管理通用平台插件/功能扩展；AI Engine 只是其中一种插件。安装 Rainbond 平台本身交给 `rainbond-platform-installer`，模型搜索、下载、部署和调优交给 `rainbond-ai-assistant`。

## 最高优先级规则

1. 所有 reference 按阶段读取，不得一次性读取全部；进入某阶段前只读取该阶段列出的文件。
2. 首次需要 Rainbond 时先读取 [runtime gate](references/runtime-gate.md)。CLI 使用受保护的单运行环境；embedded 只使用当前会话 Tool。业务 reference 不决定传输方式。
3. `team_name`、`region_name` 只来自可信会话上下文或用户明确选择。不得请求或提交平台内部命名空间、backend service、请求头或凭据。
4. 只把 `installed=true && status=RUNNING` 当作 ready。installed-state `unavailable` 不是 absent；安装请求 accepted 也不是 ready。
5. write/destructive 必须走当前宿主审批并只执行一次。timeout、5xx、连接中断或未知结果后先读状态，禁止重放原写请求。
6. 升级读取 `team_name/app_id` 后复用 `rainbond_upgrade_app`；卸载复用 `rainbond_delete_app`。不得发明插件专用删除 Tool，也不得直接操作 Kubernetes/RBDPlugin。
7. 插件安装、升级等需要持续轮询的长任务，写入前必须确认用户选择“持续监测”还是“受理后结束，待下次唤醒再查询”；用户已明确表达时不重复询问。该选择不替代写操作审批。

## 渐进加载路由

| 当前阶段 | 读取 | 不提前读取 |
|---|---|---|
| 首次平台访问 | [runtime gate](references/runtime-gate.md) | 插件生命周期和恢复 |
| 发现、版本与 installed-state | [plugin discovery](references/plugin-discovery.md) | 升级、卸载、恢复 |
| 安装、轮询、升级或卸载 | [plugin lifecycle](references/plugin-lifecycle.md) | 故障恢复（除非失败） |
| unavailable、失败或未知结果 | [recovery](references/recovery.md) | 无关业务 reference |
| 需要组织用户结果 | [output contract](references/output-contract.md) | 其他阶段 |

已知 Tool 名直接使用；CLI 只有字段不确定时才 describe 单个 Tool，只有名称未知时才用窄前缀 list。禁止无前缀加载完整 Catalog。embedded 使用会话实时 Tool definition，不运行 CLI discovery。

## 跨 Skill 恢复

若由 `rainbond-ai-assistant` 因插件 absent 转交：保留原始模型意图和 root Skill；完成安装并观察到 RUNNING 后，在同一任务恢复原模型阶段。状态不可用、审批拒绝或安装失败时停止，不丢失原意图，也不改走另一条传输路径。

## 用户可见结果协议

默认输出简洁中文；只有用户或自动化评测明确要求结构化 YAML/JSON 时才使用结构化模式。说明做了什么、当前真实状态、插件 ID/app ID、关键事实、blocker/retryable/unavailable 和下一步。不要输出内部协议、凭据、低层资源名或原始日志。
