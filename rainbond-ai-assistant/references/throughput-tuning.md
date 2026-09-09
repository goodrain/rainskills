# 吞吐与时延调优

先按 [parameter decision guide](parameter-decision-guide.md) 识别用户目标和主要瓶颈，再执行实验：

1. 读取当前实例配置和 `rainbond_get_ai_engine_monitoring_overview`。GPU 再读 device/binding/usage；CPU 改读 CPU/内存/架构事实。
2. 将“延迟”拆分为 TTFT、decode/TPOT 或完整响应时间；同时区分总 tokens/s、并发吞吐、长上下文、质量和成本约束。无法区分时先补齐决定性信息，不盲调参数。
3. 用相同模型、请求集、采样参数和观察窗口建立基线，记录输入/输出 token 分布、并发、tokens/s、时延、排队、错误率和资源压力。指标 unavailable 时明确缺口。
4. 每轮只调整一组强相关参数，创建新的候选实例，原实例保持运行。每项变化都说明触发证据、预期改善指标、风险和未选择的相邻参数。
5. 候选 Running 后用相同负载比较目标指标、错误率、OOM/稳定性和相应资源压力；无改善、质量回归或稳定性下降即回退。
6. 用户确认前不停止或删除原实例。

队列为空且单请求 decode 慢时，增加 batch/concurrency 通常不是正确候选，应评估模型大小、量化和设备。`stream_interval` 只改变流式分块频率，不能作为实际 tokens/s 提升证据。CPU 内存紧张先降 KV cache、上下文或并发；GPU 显存紧张按真实 allocation 窗口判断。
