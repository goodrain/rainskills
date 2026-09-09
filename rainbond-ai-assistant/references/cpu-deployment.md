# CPU 一等部署路径

CPU 部署不是 GPU 错误后的隐式降级。用户明确要求 CPU，或无 GPU 但 CPU runtime/模型兼容时，继续完整生命周期；GPU 不可用或未安装不是 CPU 成功门禁，也不阻止 CPU 创建。

## 创建前事实

- capabilities：目标 `architecture` 的 CPU runtime、version、image digest 配置状态。
- resource capacity：可调度 CPU、内存、节点架构和存储节点约束。
- model metadata：weight bytes、文件大小、量化、上下文和 CPU 兼容性。

请求固定 `compute_mode=cpu`、`gpu_count=0`。允许 CPU request/limit、memory request/limit、shared memory、node name，以及 `cpu_kvcache_space_gb`、max model len、runner、dtype、batch/concurrency、prefix caching 等服务端支持的结构化字段。

必须满足 `cpu_request_cores <= cpu_limit_cores` 与 `memory_request_gib <= memory_limit_gib`。内存预检覆盖模型权重、`cpu_kvcache_space_gb` 和运行时余量；不足时先降低 KV cache、上下文或并发。

CPU 模式禁止 `gpu_memory_utilization`，禁止 `kv_cache_memory_bytes`，禁止 `tensor_parallel_size`，禁止 `pipeline_parallel_size`，并禁止非 auto GPU KV cache dtype 或任何 GPU allocation/type 参数。GPU 模式反向禁止 `cpu_kvcache_space_gb`。

CPU runtime/digest 或目标架构不可用时返回 blocker，不选择未验证镜像。FP8 不进入通用 CPU 路径；ARM64 的 AWQ/GPTQ 限制保留服务端稳定错误与恢复建议。

Creating/Failed 使用 deployment、events、current/previous logs，重点定位架构/image、模型兼容、内存 OOM、线程预算和 KV cache 初始化。成功仍要求 Running、health 与 `served_model_registered=true`。

性能基线使用 tokens/s、时延、排队、错误率及 CPU/内存事实；GPU 指标 unavailable 对 CPU 不是故障。增加 CPU 核数不承诺线性提速。

