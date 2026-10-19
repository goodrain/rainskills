# troubleshoot

11. 如果进入 `code_or_build_handoff_needed`，必须硬停止。
   不允许自动改代码、跑本地测试、commit、push、自动重试。

13. 顶层主线必须有尝试预算：
    - 同一类错误签名最多重试 1 次
    - 同一阶段最多尝试 2 次（首次 + 1 次重试）
    - 单次主线总时长默认不应超过 8 分钟；超时后必须停止并汇报当前停点。

15. 如果用户明确在问“为什么构建失败”，顶层必须优先走 `component events -> build logs -> runtime logs` 的构建失败证据链。
    不要把运行容器日志当第一现场。

16. 如果用户要求调整源码构建参数，优先走 `rainbond_manage_component_envs(operation=replace_build_envs, build_env_dict=...)`。
    不要把语言构建参数塞进 `build_info`。

28. `rbd-*` 组件（rbd-gateway、rbd-api、rbd-worker、rbd-chaos、rbd-db、rbd-mq、rbd-monitor、rbd-node 等）是 Rainbond 平台自身的基础设施组件，不是用户应用组件。
    - 可以用 `rainbond_query_region_rbd_components` 查询并展示它们的状态
    - 不能通过 Rainbond Tool 对它们执行重启、部署、修改等写操作；当前 Tool catalog 不支持此类操作
     - 如果用户要求操作这些组件，明确告知：需要通过 Kubernetes 命令（如 `kubectl rollout restart deployment/<name> -n rbd-system`）或 Rainbond 集群管理控制台进行，超出本技能的操作范围，不要假装可以执行
28a. 已知 `service_id` 的组件在构建、部署或运行操作后失败或立即异常时，调用 `rainbond_get_operation_failure_context({team_name, region_name, app_id, service_id, event_id?})`，按其 `classified_reason` 决定停下、只读核实或低风险修复；`unknown` 回退既有证据链，禁止盲目重放写操作。CLI 在确认令牌生成前报告的 missing/invalid field 属于参数校验失败，尚未进入组件操作：按 Console Tool schema 修正参数一次，不调用 failure context，也不查询组件残留。
    `event_log_tail` 只作为敏感诊断证据使用，绝不能复制、引用或向用户展示其原文；输出只能使用 `classified_reason`、非敏感摘要和已脱敏字段。
28b. 运行态或交付健康检查先用一次 `snapshot app|delivery` 聚合已知只读请求（包含 `rainbond_get_app_health_overview`）；仅 `abnormal` 或 `unknown` 组件再读取有 cursor/time/tail 边界的明细。
