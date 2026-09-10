# 删除策略

1. 模型有实例引用时禁止删除；先列出引用关系。
2. 删除顺序始终是实例先于模型，每个 destructive 动作分别审批并只执行一次。
3. `rainbond_delete_ai_engine_instance` 后按精确 ID 核实消失；`cleanup_verified=false` 不得升级为完整清理成功。
4. 所有引用消失后才调用 `rainbond_delete_ai_engine_team_model`，再查询 model key 直到 absent 或明确失败。
5. 未知结果先读，不重放 delete；不得直接清理下载 Job、PVC、Deployment 或其他底层资源。

