# 实例部署

创建前使用 `rainbond_get_ai_engine_team_model`、`rainbond_get_ai_engine_capabilities`、`rainbond_get_ai_engine_resource_capacity`，并按 [parameter decision guide](parameter-decision-guide.md) 完成 `startup_safety` 参数规划；审批后的唯一 write 是 `rainbond_create_ai_engine_instance`。创建后使用 `rainbond_get_ai_engine_instance` 与 `rainbond_get_ai_engine_instance_deployment` 轮询。

1. 精确读取目标团队模型，要求 ready、registry/metadata verified 与 revision 一致。
2. 读取 capabilities 和 resource capacity。GPU 必须先按 [GPU provider](gpu-provider-and-capacity.md) 完成 GPU 前置检查；provider state 为 pending、degraded 或 conflict 时阻止 GPU 写操作。CPU 改读 [CPU deployment](cpu-deployment.md)。
3. 先按参数决策指南理解场景并推导参数，再形成 `startup_safety` 决策：记录模型任务/架构、模型声明上下文、用户必需上下文、compute mode、资源容量、GPU provider/allocation 语义、候选 `resources`、候选 `dynamic_params`、`missing_evidence`、风险和验证计划。模型已由用户指定时，参数规划仍不能跳过，只是不再重新推荐模型。
4. 权重或仓库 `file_size` 只说明制品规模，不能单独证明实例显存充足。容量判断必须同时覆盖模型权重、KV cache、运行时、多模态编码器和必要安全余量。
5. `hami_ready` 不等于实例获得整张 24 GB 物理卡。`hami_shared_auto` 必须按服务端给出的 `memory_mib_per_gpu` allocation 窗口规划；allocation 窗口未知时记录 `missing_evidence`，不得按物理 GPU 总显存宣称可部署。
6. 长上下文或 multimodal/多模态模型不得直接继承模型声明的最大上下文。`max_model_len` 必须来自用户所需上限或服务端明确的安全候选，并与 KV cache、并发和媒体输入边界联合检查；两者都没有时，先询问会改变部署参数的最少信息，不执行创建。
7. 使用结构化 `resources` / `dynamic_params`；调用方不提交 allocation、runtime image/digest、环境变量或线程绑定。`dynamic_params` 为空时不得直接创建，除非参数决策已用明确证据得出“运行时默认值安全且无需覆盖”的结论，并在结果中记录拒绝修改的理由。
8. 高级参数只使用 `extra_argv[]`，不构造 shell 字符串；确认摘要只展示安全目标与规范化参数名。
9. 写入前展示最终的安全参数方案及仍有影响的风险，并确认长任务监测方式：“持续监测”或“受理后结束，待下次唤醒再查询”。只有宿主审批界面能在写入前实际收集并保存监测选择时，才可合并到同一次交互；否则必须先询问并收到回答，再请求创建审批。用户已表达可确定偏好时不重复询问。
10. `startup_safety` 未完成、关键 `missing_evidence` 会改变可启动性、或方案仍依赖物理显存猜测时，禁止调用 `rainbond_create_ai_engine_instance`。
11. 审批后调用一次 `rainbond_create_ai_engine_instance`。结果未知时先 list/get 精确 instance ID/name/model key，不重放 create。
12. 持续监测时，按服务端建议轮询实例和 deployment 到业务终态，只在 current stage 变化时更新用户。Pod Running 不等于完成；目标实例必须 Running、health 成功且 `served_model_registered=true`。
13. 受理后结束时，取得 `instance_id` 后不启动周期轮询，报告当前 Creating 并结束当前回合。下次唤醒时按原 `instance_id` 只读 instance/deployment，不重放 create；仍未终态时报告本次结果并结束，除非用户改选持续监测。
14. GPU Running 后重新读取 `config.resources.gpu_allocation`，按实际 mode/request unit 解释；不要沿用创建前推测。
15. 核对计划值、保存配置和最终生效值。先读 instance details；关键默认或字段缺失时再有界读取启动日志，确认上下文、精度、KV cache、缓存开关和可见的调度参数。`resolved_argv` 只说明显式启动参数，缺少 flag 不等于功能关闭；`dynamic_params` 缺字段也不等于参数未生效。日志没有暴露的值保留未知，不从 CUDA graph 尺寸推算并发配置。
16. 生效值与计划冲突时报告具体差异和业务影响；涉及容量安全时转部署诊断，不自动修改或重建。容量估算或启动日志的最大并发仅是容量证据，不能当成压测结果。配置证据不完整与服务健康分别报告，不把健康实例改报 Failed，也不宣称参数已全部验证。

17. 健康与注册确认后，使用当前宿主实际提供且在授权范围内的推理能力验证代表性输入、输出长度和所需模态。无样本或无推理 Tool 时明确“服务已就绪，业务场景尚未验证”，不绕过平台直接请求内部服务。性能目标仅在对应负载验证后报告达标；部署请求不自动扩展为高负载压测或反复创建候选实例。

## 宿主部署方案记录

当前宿主若提供 `prepare_ai_engine_deployment`，完成上述规划后、调用创建前必须使用它记录方案。它不是平台容量预检，也不替代审批。`user_requirements` 按数组逐条引用用户已表达的用途、模型选择等原文，不把多条消息拼成一句；兼容旧宿主的 `user_requirement` 只传单条原文。用户只说“部署大模型”或指定模型/GPU 不代表已经说明用途，应先询问用途，不能自行编造场景。`deployment_arguments` 是符合实时创建 Tool schema 的完整参数，必须与后续创建保持一致；参数改变后重新规划并记录。

记录前显式传入同一 `team_name`、`region_name` 查询 capabilities、resource capacity 和精确 `model_key` 的团队模型详情，加载当前阶段 references。`parameter_reasoning` 说明上下文、资源、并发、KV cache 和 allocation 的事实依据，`defaults_reasoning` 说明哪些参数继承已验证的默认值及原因；关键 `missing_evidence` 未消除时停止。内部方案内容不作为业务 API 参数提交，也不把内部字段清单交给用户填写。当前宿主未提供此工具时仍执行完整 `startup_safety` 规划，不虚构工具。

方案记录与创建审批是不同阶段。新宿主通过 `monitoring_preference` 记录 `mode=continuous|deferred` 及真实用户选择原文 `user_quote`；该字段仅属于内部方案，不发送到平台创建 API。工具返回 `next_action=ask_monitoring_preference` 时先询问并等待回答，不调用创建工具；补录偏好后返回 `request_creation_approval` 才进入审批。已有同一实例的监测选择直接复用，参数调整不要求用户重复选择；新实例不能静默继承上一实例的偏好。批准创建不等于选择监测方式。

跨轮次以当前宿主实际激活列表和手册为准，不把历史 `loaded_skill` 回执当作当前状态。当前手册缺失时重新加载；不知道模块路径时，若宿主支持省略 `module_path` 的 `read_skill_module(skill_id=...)`，先查询索引再读准确路径，不用猜错路径探测。
