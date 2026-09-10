# 模型与参数建议

模型候选只基于 capabilities、resource capacity、AI Engine recommendations、模型 metadata 和用户目标，返回 1～3 个候选。每个候选说明 compute mode、资源依据、主要取舍、不确定项、风险和 `high|medium|caution` 置信度。

为已有 ready 模型生成参数时先读 [parameter decision guide](parameter-decision-guide.md)。`startup_safe`、`balanced` 等 profile 只能是待验证的候选标签，不能根据“通用对话”等宽泛描述直接套用固定参数。

已有模型的建议至少包含：

```yaml
objective: startup_safety | latency | ttft | decode_latency | throughput | concurrency | long_context | memory_fit | quality | cost | multimodal | stability
bottleneck: memory_capacity | prefill | decode_compute | queue_capacity | cache_reuse | cpu_compute | communication | model_choice | multimodal_capacity | stability | unknown
facts: []
dynamic_params: {}
extra_argv: []
changes: []
rejected_options: []
missing_evidence: []
expected_effect: ""
risks: []
confidence: high | medium | caution
validation_plan: ""
```

CPU 另说明 architecture、CPU/内存 request/limit、`cpu_kvcache_space_gb`、量化兼容、主要瓶颈与验证指标。GPU 另说明实际 provider/allocation/request unit。信息不足时给保守起点或不改参数结论，不能称为绝对最佳。
