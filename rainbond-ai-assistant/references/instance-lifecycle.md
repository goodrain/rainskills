# 实例生命周期

`rainbond_list_ai_engine_instances`、`rainbond_get_ai_engine_instance` 与 `rainbond_get_ai_engine_instance_deployment` 是 read；启停唯一 write 为 `rainbond_update_ai_engine_instance_state`；删除唯一 destructive Tool 为 `rainbond_delete_ai_engine_instance`。

- 创建/启动/停止的 `accepted=true` 仅表示受理。
- 启动后可经历 Creating；轮询 get/deployment 到 Running 或 Failed，并要求新一轮 deployment current stage，不复用旧 terminal。
- 停止后轮询到 `Stopped`，确认 desired/available replicas 为 0。
- 删除后按精确 instance ID 重新 list/get 确认消失，不能按列表位置、名称数量或旧快照推断。
- timeout、5xx、连接重置或 operation already recorded 后不重放写操作，只读精确状态。
- `cleanup_verified=false` 必须保留限制：记录消失不等于所有底层资源已验证清理。
