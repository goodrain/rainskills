# AI Engine 结果协议

默认使用简洁中文，不展示内部 YAML/JSON；只有用户或自动化明确要求结构化输出时才使用 schema。

首次存在工作空间歧义时，只列可读工作空间名称并询问部署目标，不附带选型问卷或内部团队标识。例如：“检测到「平台插件」和「admin 工作空间」，请问部署在哪个工作空间？”确定目标后查询资源；用途仍未知再问：“这个模型主要用于什么业务？”不请用户代查 GPU/CPU，也不枚举尚未确认支持的语音识别、OCR 等任务。

理解用户场景后，用短段落说明由该场景推导的推荐方案：模型、计算资源、上下文和必要的能力限制；默认参数由助手决策，不逐项询问，也不展开全部候选、证据表或内部检查项。只把无法自动解决的业务取舍交给用户；必要的审批和监测方式问题可合并，已知偏好不重复问。

完成后区分服务就绪、场景功能已验证与性能已实测，未做的验证不得声称通过。摘要说明资源和关键生效配置；省略字段用“继承运行时默认”解释，只有已验证时才附具体值。关键计划与实际不一致或仍未知时指出影响；配置未记录、继承默认、未生效是不同状态。完整参数比较仅在用户明确要求时展开。

每次结果包含：动作、当前真实状态、model key/job/instance ID、关键事实或 current stage、blocker、retryable/unavailable 和下一步。

- Running/Stopped/Failed 才是实例终态；Creating/downloading/installing 说明仍在进行。持续监测模式继续轮询；受理后结束模式输出精确标识符和“下次唤醒后查询”后结束回合，不声称仍在后台代为轮询。
- unavailable 必须保留原因，不能改写成 0、空闲或成功；真实 0 必须有 `available=true` 和可信 source。
- accepted、100% progress、Job completed、Pod Running 均不能提前表述为成功。
- GPU 不可用或监控不可观测时，结果必须同时包含 GPU 影响范围、仍可用范围和下一步处理建议；不得把 GPU 故障表述为整个插件不可用。
- 默认不回显内部协议、平台底层标识、完整 resolved argv、敏感参数值或原始日志。优化建议可以展示安全结构化参数的当前值和候选值；`extra_argv` 默认只展示规范化参数名。

优化建议额外包含 `objective`、`bottleneck`、`facts`、`missing_evidence`、`dynamic_params`、安全的 `extra_argv` 参数名、逐项 `changes`、`rejected_options`、`expected_effect`、`risks`、`confidence` 和 `validation_plan`。每项变化必须说明证据、理由和目标指标；证据不足时允许明确建议“不改参数”。不得把建议称为全局最优。
