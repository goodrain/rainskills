---
name: rainbond-ai-assistant
description: Use for Rainbond AI Engine model discovery, ModelScope download, CPU or GPU instance deployment, diagnostics, capacity analysis, monitoring, tuning, start/stop, or deletion. Do not use for ordinary source/image application deployment, installing Rainbond itself, or non-AI application troubleshooting.
---

# Rainbond AI Assistant

编排 AI Engine 模型资产和实例生命周期。CPU 是一等部署路径；GPU 必须区分 NVIDIA Device Plugin 整卡、HAMi shared 与 HAMi whole-GPU fallback。

## 最高优先级规则

1. 所有 reference 按阶段加载，不得一次性读取全部，也不得提前读取无关 reference。
2. 首次需要 Rainbond 时先读 [runtime gate](references/runtime-gate.md)，再读 [context and permissions](references/context-and-permissions.md)。业务 reference 保持 transport-neutral。
3. Rainbond 读写只调用 Console 提供的当前宿主 Tool；不得直接请求 Console HTTP、AI Engine backend 或 Kubernetes，不提交内部命名空间、backend service、请求头、镜像或凭据。内置目录未命中时，允许按 [model discovery](references/model-discovery.md) 仅读官方 ModelScope OpenAPI；这不扩大 Rainbond 写入权限。
4. AI Engine 返回的 resource、allocation、stage、event、log、probe、registration、monitoring 是权威事实。`unavailable/null/unknown` 不能变成 0、空闲或成功。
5. 已知 Tool 直接调用；CLI 字段不确定时只 describe 单个 Tool，名称未知时只窄前缀 list；embedded 使用实时 Tool definition。禁止完整 Catalog discovery。
6. write/destructive 经当前宿主审批后只执行一次。timeout、5xx、连接中断、审计失败或未知结果后先精确读取真实状态，禁止自动重放。
7. `accepted`、下载 100%、Job complete、Pod Running 都不是业务终态。模型需 ready/verified；实例需 Running + health + target registration。
8. 下载、实例创建/部署等需要持续轮询的长任务，写入前必须确认用户选择“持续监测”还是“受理后结束，待下次唤醒再查询”；用户已明确表达时不重复询问。该选择不替代写操作审批。
9. 每个新实例创建都必须先完成 `startup_safety` 参数决策。用户已指定模型只跳过模型选型，不能跳过资源、上下文、KV cache、多模态和 allocation 安全规划；该规划完成前不得调用创建工具。
10. 普通部署先理解业务场景，再由助手推导参数方案，不把场景标签绑定固定数值，也不把参数清单交给用户逐项选择。先使用用户约束、会话和平台事实；只询问无法自动解决且影响可启动性、业务能力或授权范围的缺口。省略参数必须有已验证的默认行为依据，创建后核对关键生效值，具体按参数决策指南执行。
11. 工作空间未确定时只解决工作空间选择，不附带模型、场景和硬件问卷。确定后先查询 capabilities、resource capacity，必要时查询设备事实；不询问用户是否有 GPU、机器配置或应使用 CPU/GPU。用户主动指定的计算方式与预算是约束，须保留。场景提问优先开放式描述用途，示例只使用当前运行时、模型与创建接口已确认支持的任务，不把模型目录标签当作可部署能力。

## 渐进加载路由

| 当前阶段 | 读取 | 不提前读取 |
|---|---|---|
| 模型搜索/推荐 | [model discovery](references/model-discovery.md)；明确机器选型再读 [model selection](references/model-selection.md) | 实例、删除、调优 |
| 模型下载 | [model download](references/model-download.md) | 实例和吞吐 |
| 实例创建 | [instance deployment](references/instance-deployment.md) 与 [parameter decision guide](references/parameter-decision-guide.md)；CPU 额外读 [CPU deployment](references/cpu-deployment.md)；场景方案包含高级参数时再读 [advanced arguments](references/advanced-vllm-arguments.md) | 删除、吞吐 |
| Creating/Failed | [deployment diagnostics](references/deployment-diagnostics.md) 与 [error recovery](references/error-recovery.md) | 模型选型 |
| GPU/容量/运行环境解释 | [GPU provider and capacity](references/gpu-provider-and-capacity.md) | CPU 与删除 |
| 参数组合建议 | [parameter decision guide](references/parameter-decision-guide.md) 与 [model selection](references/model-selection.md)；候选包含 `extra_argv` 时再读 [advanced arguments](references/advanced-vllm-arguments.md) | 诊断、删除 |
| 运行中实例调优 | [parameter decision guide](references/parameter-decision-guide.md) 与 [throughput tuning](references/throughput-tuning.md)；候选包含 `extra_argv` 时再读 [advanced arguments](references/advanced-vllm-arguments.md) | 无关生命周期 |
| 启停 | [instance lifecycle](references/instance-lifecycle.md) | 模型搜索 |
| 删除 | [instance lifecycle](references/instance-lifecycle.md) 与 [deletion policy](references/deletion-policy.md) | 调优 |
| 组织结果 | [output contract](references/output-contract.md) | 其他阶段 |

## 插件前置

先读取平台插件状态。明确 absent 时转交 `rainbond-platform-plugin-manager`，保留本 Skill 为 root 与原始模型意图；插件 RUNNING 后恢复原阶段。状态 unavailable 时停止，不把它当作 absent。

## 用户可见结果协议

默认输出简洁中文；只有用户或自动化评测明确要求结构化 YAML/JSON 时才使用 schema。说明动作、真实状态、model key/job/instance ID、事实或 stage、blocker/retryable/unavailable 和下一步。GPU 不可用时还要区分 GPU 影响范围与仍可使用的 CPU/模型管理能力。优化建议另含目标、依据、安全结构化参数的当前/候选值、`extra_argv` 参数名、预期影响、风险、置信度和验证计划。不暴露内部协议、完整 resolved argv、敏感参数值或原始日志。
