# 错误恢复

- 401：按当前宿主认证规则处理；embedded 不切换 CLI。403/跨团队拒绝直接停止。
- confirmation/approval 过期、拒绝、audit unavailable：不执行，重新确认前先读事实。
- timeout、5xx、连接错误：mutation 结果未知；精确查询插件、model key/job 或 instance ID，不自动重放。
- `operation_already_recorded`：读取真实资源状态。
- deployment history unavailable：使用 details/events/current/previous logs 降级，保留 unavailable reason。
- read Tool 本身失败或缺失：报告宿主能力不足，不调用 HTTP/backend/Kubernetes 兜底。
- 服务端稳定错误保持原 error code 与安全 details；只给与证据一致的恢复建议。


- `invalid_tool_arguments_json` / `invalid_tool_arguments_schema`：调用尚未进入平台业务处理。按实时 schema 修正对象结构，业务参数放在工具参数顶层，`resources` 等字段保持嵌套对象，禁止用 `arguments` 字符串再次包裹。相同格式错误重复出现时报告宿主参数编码/流式拼接异常，不重复申请写审批。
- `invalid model_key`：先区分字段缺失/类型错误和模型不存在；查询已确认的 key 必须原样保留，不通过移除 `modelscope:` 前缀、换名称或换模型试创建。保留安全的错误字段路径，由宿主核实最终发送参数。
- `ai_deployment_plan_required`：按部署指南完成或更新方案记录，不把此错误解释为模型不可部署。实例创建一旦发出，先查询实际结果；同一错误不通过改参数反复申请审批。

- `ai_user_requirement_required`：逐条校对 `user_requirements` 数组中的引用，每项对应一条真实用户消息，不拼接多条消息；已有用途不因引用格式错误而重新询问用户。旧宿主只支持 `user_requirement` 时引用一条原文。
- `ai_monitoring_preference_required`：先查当前会话是否已有同一实例的监测选择；已知则补录或复用，未知才询问。不得用创建审批代替监测选择，不在实例受理后才首次询问。
