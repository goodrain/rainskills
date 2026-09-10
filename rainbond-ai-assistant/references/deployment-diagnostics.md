# Deployment 诊断

先读 `rainbond_get_ai_engine_instance_deployment`，保留 `available/unavailable_reason/current_stage/failure/poll_after_seconds`。legacy `deployment_history_unavailable` 时明确降级到 instance details、events 和 logs，不伪造历史。

诊断 read Tool 分别是 `rainbond_get_ai_engine_instance`、`rainbond_list_ai_engine_instance_events` 与 `rainbond_get_ai_engine_instance_logs`；日志用 `previous`/`since_seconds` 有界读取。

| stage | 首选证据 |
|---|---|
| request/model/resource/runtime resolution | failure + stable error |
| namespace/network/deployment/service submit | deployment safe details |
| pod scheduling | filtered events；CPU 同时读 capacity |
| image pull / volume mount | events |
| container start / model precheck | events + current/previous logs |
| runtime initialization | current logs；崩溃时 previous |
| health probe | details + events + logs |
| model registration | details + logs |

区分 FailedScheduling、ImagePullBackOff、FailedMount、CrashLoopBackOff、OOM、probe failure 与 registration missing。日志 unavailable 不是空日志成功；只摘要必要事实，不复述原文。
