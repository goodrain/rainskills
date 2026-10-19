# source-build

17. 如果源码检测同时命中 Dockerfile 和语言构建，按 `rainbond-fullstack-bootstrap` 的 Build Mode Selection 优先级链解决：manifest `source.build.strategy` 优先 → 启发式按 Dockerfile 分类 + 意图信号判断（"语言 buildpack 能否产生等价运行时行为"，原则驱动而非固定清单）→ 真正模糊时才问一次并建议用户写回 manifest。决策必须双轨可审计：prose 输出"Build mode for `<name>`: `<picked>` (`<source>` — `<reason>`; to override: `<hint>`)"逐组件展示，且 bootstrap 的结构化输出 `deployment_plan.workflow.build_strategy_decisions[<name>]` 同步记录（仅给有 dual detection 的组件填）。`dockerfile` 决策映射到 `rainbond_create_component_from_source` 的 `prefer_dockerfile_when_detected = true`。详见 `rainbond-fullstack-bootstrap/references/source-build-parameter-guide.md § Build Mode Selection`。
    - **恢复例外按状态决定**：`checking` / `checked` / 未完成组件可以通过 `rainbond_get_component_check_result(prefer_dockerfile_when_detected=true)` 在原拓扑中取得 Dockerfile 证据，禁止删除。只有 `create_status=complete` 的 CNB 组件不存在通用原地切换能力时，才允许在已保存 topology and configuration snapshot、已向用户展示该完成状态并获得 explicit user confirmation 后删除并重建；任一证据缺失时只读停止。

18. 当前 Rainbond Tool catalog 不支持显式 `dockerfile_path` 时，不要在顶层编排里承诺该能力。

33. **`rainbond_update_component_build_source` 只改 DB 不触发检测**，调完之后下一个 Rainbond 写调用**必须**是 `rainbond_check_component(service_id=..., is_again=true)`，不允许中间夹任何其他工具，也不允许跳过它直接读 check_result 或调 build。
    背景（必读）：后端 `update_component_build_source` 视图仅把 `git_url`/`subdirectories`/`code_version`/凭证字段写进 DB（`service.save()` 结束），**没有调用 `app_check_service.check_service`**。因此：
    - 改完 build_source 后调 `rainbond_get_component_check_result` → 返回的依然是**上一轮**（最初 create 时）的 `check_uuid` 和 "源码目录不存在" 旧结果，给人"我的修改没生效"的假象，实际是检测根本没重跑
    - 改完 build_source 后调 `rainbond_build_component` → 组件还停留在 `service_source=source_code` + 上轮检测未通过的状态，build 任务会被卡在 `checking`，无法真正启动
    - 唯一能让后端重跑源码检测的方式是 `rainbond_check_component(is_again=true)`（对应 `app_check_service.check_service(team, service, is_again=True, ...)`，会清掉旧的 `check_uuid` 并发起新一轮 check_event）
    强制时序模板：
    ```
    rainbond_update_component_build_source(service_id, git_url?, subdirectories?, code_version?, ...)
      ↓ 立刻
    rainbond_check_component(service_id, is_again=true)
      ↓ 拿到新的 check_event_id / check_uuid
    rainbond_get_component_check_result(service_id)   # 轮询直到 check_status != "checking"
      ↓ 通过
    rainbond_build_component(service_id, build_info=...)
    ```
    禁止序列：
    - `update_component_build_source` → `get_component_check_result`（中间没 `check_component`）
    - `update_component_build_source` → `build_component`（中间没 `check_component`，组件仍 `checking`，build 必失败）
    - 多次 `update_component_build_source` 之间不夹 `check_component`（等价于在改了 DB 但没触发检测的情况下又改一遍，每次轮询的还是同一个旧 `check_uuid`）
    与 Iron Law 30 配套：30 管"换参数重试"的预算（同 `service_cname` 最多 2 次 create / 同 service_id 同字段最多 N 次 update），33 管"改完后必须走完一个完整 check 闭环"。两者一起堵住"猜参数 → 改了又不重检测 → 又看到旧错误 → 再猜"的死循环。
