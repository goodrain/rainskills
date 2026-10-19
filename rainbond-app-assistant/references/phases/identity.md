# identity

34. **service_id provenance：任何 Rainbond 写工具传入的 `service_id` 必须有明确出处**，不允许凭模型记忆或上下文里飘着的 UUID 猜。
    合法的 `service_id` 来源（按优先级）：
    - 本会话内 `rainbond_query_components` 的返回结果（最新一次）
    - 本会话内 `rainbond_create_component_*` 工具的返回值
    - `session.localBinding.serviceId` / `priorTurnMessages` 里同一 `service_cname` 的 ack
    不合法的 `service_id` 来源（**禁止**）：
    - 从对话历史里随手抓一个看起来像 UUID 的字符串（可能是 `check_event_id` / `check_uuid` / `event_id` / 历史 service_id）
    - 凭"我记得是这个"或"上次也是这个 ID"做猜测
    - 用户消息里粘的、但本会话没验证过的 ID
    强制流程：动手前如果不能 100% 确定 `service_id` 出处，**第一动作**必须是 `rainbond_query_components({enterprise_id, app_id})`，必要时携带 `query=<service_cname 或 service_id>`，按 `service_cname` 或 `k8s_component_name` 匹配出真实 `service_id`，再调写工具。
    反例（**禁止**）：日志里出现"修改组件 `7059eb62cccc3a16f22c9415c905bbcc` 的构建源" — 这个 ID 在本会话所有 query 结果里都没出现过，是模型从某处幻觉出来的。正确做法：调 update 之前先 `rainbond_query_components` 拿到真实 `service_id`，再 update。
    与 Iron Law 31 配套：31 管"写工具前必须加载对应专项手册"，34 管"写工具的 service_id 必须有明确出处"。两条共同把"模型自由发挥参数"这条路堵死。

    **同样的 provenance 规则对 `event_id` 生效**：调 `rainbond_get_component_build_logs` / `rainbond_get_app_upgrade_record` 等需要 `event_id` 的工具时，`event_id` 必须是**真实 UUID**（如 `805f6397871d467b968d14c3575082a6`），合法来源仅限：
    - 本会话内 `rainbond_get_component_events` 返回的 `events[*].event_id`
    - 本会话内写工具（`rainbond_build_component` / `rainbond_operate_app` / `rainbond_check_component` 等）响应里的 `event_id` / `build_event_id` / `check_event_id`

    不合法 `event_id` 来源（**禁止**）：
    - `rainbond_get_component_summary` 返回的 `recent_events[*].ID` — 这是**数据库自增行号**（如 `17740`），**不是** UUID
    - 任何看起来是短整数的字段（4-6 位数字）
    - 历史会话里飘着的、本会话未通过 events 查询验证过的字符串

    强制流程：调用任何 `event_id`-required 工具前，如果不能 100% 确定 `event_id` 出处，**第一动作**必须是 `rainbond_get_component_events(team_name, region_name, app_id, service_id, page=1, page_size=10)`，从 `events[*].event_id` 拿真实 UUID，再调下游工具。

    反例（来自真实回归 case `cs_1779149681822_3u`，2026-05-19）：模型从 `rainbond_get_component_summary` 响应的 `recent_events` 段看到形如 `{"ID": 17740, "event_id": "...", "opt_type": "build-service"}`，直接把 `17740` 当成 `event_id` 传给 `rainbond_get_component_build_logs`，工具返回 `items: []`（找不到该 UUID 的日志）。正确做法：从同一 `recent_events[i].event_id` 字段取出 UUID 字符串，或调 `rainbond_get_component_events` 重查。
