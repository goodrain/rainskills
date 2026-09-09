# 插件生命周期恢复

| 情况 | 行为 |
|---|---|
| installed-state unavailable | 停止；保留原因，不安装 |
| Tool 缺失、认证失败或网络失败 | 停止并报告宿主能力；不切换传输 |
| install/upgrade/delete timeout、5xx、连接重置 | 结果未知；只调用对应 read/list 核实，不重放 |
| 审批拒绝、过期或审计不可用 | 不执行；说明阻塞条件 |
| operation 已记录/疑似重放 | 读取真实插件/应用状态 |
| 安装后长期非 RUNNING | 返回当前应用整体状态、最后可用事实和人工下一步 |

恢复原始 AI Engine 意图只发生在插件真实 RUNNING 后。失败时不要改为直接调用插件 backend、Console HTTP 或 Kubernetes。

