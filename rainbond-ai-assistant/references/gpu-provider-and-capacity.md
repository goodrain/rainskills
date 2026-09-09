# GPU provider 与容量

创建前交叉读取 capabilities allocation 与 resource capacity 节点 provider/state/count/conflict。先完成 GPU 前置检查；pending、degraded 或 conflict 阻止 GPU 写操作。

按需使用 read Tool：`rainbond_list_ai_engine_gpu_devices` 查设备事实，`rainbond_get_ai_engine_gpu_device_timeseries` 查 1h/24h 趋势，`rainbond_list_ai_engine_gpu_instance_bindings` 查实例绑定，`rainbond_list_ai_engine_gpu_instance_usage` 查真实使用量。不得用其中一个响应推造另一个响应的事实。

## 运行环境就绪判断

按服务端返回的节点 `gpu_provider_state` 处理，不用单一的 GPU 数量或监控空结果替代整条运行环境事实：

| state | GPU 写操作 | 用户提示 |
|---|---|---|
| `no_gpu` | 阻止 | 未检测到可用 GPU；不能据此断言驱动缺失或没有驱动 |
| `standard_pending` | 阻止 | 已有 NVIDIA 硬件信号但整卡资源未就绪；问题可能位于驱动、Container Toolkit、Runtime 或 Device Plugin，逐层报告已知事实 |
| `standard_ready` | 允许 | 标准 NVIDIA 整卡资源已就绪，继续按资源容量预检 |
| `hami_ready` | 允许 | HAMi 已就绪，继续按 shared 或 whole fallback 的实际 allocation 判断 |
| `hami_degraded` | 阻止 | HAMi 控制面、设备注册或容量未收敛，保留服务端 reason |
| `device_plugin_conflict` | 阻止 | 同一节点存在互斥的 GPU Device Plugin 覆盖，禁止不安全分配 |

只有 read Tool 明确返回某一层状态或等价证据时，才报告 `hardware_detected`、`driver_state`、`device_plugin_state`、`observer_state`。未返回的层保持 `unknown` 或 `unavailable` 并原样保留，不得猜测。特别是：

- GPU 监控 `unavailable` 或设备列表为空不能证明驱动缺失；资源调度事实与 Observer/指标采集事实分别解释。
- 有 `nvidia.com/gpu` 可分配量也不能证明监控正常；可以说明 GPU 调度已就绪、监控仍不可观测。
- 只有驱动校验器、Observer 错误或服务端稳定错误明确指向驱动时，才使用“驱动缺失/异常”。

## 影响范围与回退

GPU 不可用不等于整个插件或全部功能不可用。模型搜索、下载和删除等资产管理仍可用；已有 CPU 实例的生命周期与诊断也不受 GPU 监控缺失影响。

GPU 部署被阻止时，读取模型兼容性、CPU runtime、节点 CPU/内存和存储约束。只有模型支持 CPU 且预检通过时，才把 CPU 部署作为候选；这是需要用户确认的显式方案，不做静默回退。FP8 或其他 CPU 不兼容模型不能回退到 CPU。

输出至少说明：当前 GPU 状态、证据来源、GPU 影响范围、仍可用能力、是否存在兼容的 CPU 候选，以及管理员下一步。不得自动安装 GPU Operator；仅在证据支持时建议由管理员通过明确确认的集群基础设施流程安装或修复驱动、Container Toolkit、Device Plugin 或 GPU Operator。

| provider / allocation | request unit | 语义 |
|---|---|---|
| `standard_nvidia` + `standard_whole_gpu` | `physical_gpu` | NVIDIA Device Plugin 原生整卡独占 |
| `hami` + `hami_shared_auto` | `hami_vgpu` | HAMi shared；按实例 `memory_mib_per_gpu` 显存窗口 |
| `hami` + `hami_whole_gpu_fallback` | `physical_gpu` | HAMi whole-GPU fallback；整卡占用，不再按切片解释 |

HAMi shared 创建后读取 binding 的 `gpu_ids`、`binding_source`、`binding_scope`、`available_memory_mib_per_gpu`、`available_vgpu_capacity`、`share_available`。已有 shared binding 且服务端仍返回可共享时可以部署候选；不要只因同一物理 UUID 已绑定就阻止。

`gpu_memory_utilization` 作用于实例 allocation 窗口：8 GiB vGPU 的 0.5 约是 4 GiB，不是物理 24 GiB 的一半。standard whole 与 whole fallback 都按 physical GPU 解释。

只有 `available=true + source=real + used_memory_bytes=0` 才是真实 0；`available=false + source=unavailable + used_memory_bytes=null` 是不可观测。不得用 physical/virtual count 相除推导可创建实例数。
