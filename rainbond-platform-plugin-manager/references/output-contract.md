# 插件管理结果协议

默认使用简洁中文，不展示内部 YAML/JSON；用户或自动化明确要求机器可读输出时才输出结构化数据。

至少说明：动作、当前状态、plugin ID、app ID（如有）、事实来源、blocker、retryable/unavailable 和下一步。

- `accepted=true` 不等于插件 `RUNNING`。
- 完成条件是 `installed=true` 且 `status=RUNNING`。
- 用户选择“受理后结束”时，正在安装/启动不是失败或 blocker；输出当前状态、`plugin_id/app_id`和“下次唤醒后查询”，不声称仍在后台代为轮询。
- `unavailable` 不是“未安装”，也不等于 absent。
- 卸载需以列表中的 `installed=false` 收敛；未知结果不能表述为成功。
- 不回显凭据、内部资源标识、原始响应或低层日志。
