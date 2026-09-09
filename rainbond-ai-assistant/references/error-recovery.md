# 错误恢复

- 401：按当前宿主认证规则处理；embedded 不切换 CLI。403/跨团队拒绝直接停止。
- confirmation/approval 过期、拒绝、audit unavailable：不执行，重新确认前先读事实。
- timeout、5xx、连接错误：mutation 结果未知；精确查询插件、model key/job 或 instance ID，不自动重放。
- `operation_already_recorded`：读取真实资源状态。
- deployment history unavailable：使用 details/events/current/previous logs 降级，保留 unavailable reason。
- read Tool 本身失败或缺失：报告宿主能力不足，不调用 HTTP/backend/Kubernetes 兜底。
- 服务端稳定错误保持原 error code 与安全 details；只给与证据一致的恢复建议。

