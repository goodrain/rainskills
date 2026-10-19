# deliver

19. 对 reverse-proxy full-stack 项目，不要只因为根路径 URL 存在就把它当作最终交付成功或 Fast Path 的可信 URL；同 host 的 backend 路径（通常是 `/api`）必须也一致可用，或明确停在 blocker。

40. **对外访问地址必须引用工具返回的真实值，禁止按格式拼装。** 组件的对外访问地址是**事实信息**，权威来源是 `rainbond_get_component_detail` 或 `rainbond_get_component_summary` 返回的 `access_infos` 字段（都来自网关真实绑定）。只需状态和访问地址时优先调用轻量的 detail；只有异常组件确实需要端口、env、存储或事件证据时才调用 summary。
    - 本轮已通过上述任一工具拿到真实地址 → 报告里引用 `access_infos` 的真实值。
    - 本轮**未**通过上述工具拿到可用地址 → 最终报告必须写"请在控制台该组件的端口页查看对外访问地址"，**禁止**按记忆或文档示例的 URL 格式（`<name>.<ip>.nip.io`、`<service>-<port>-<team>.<ip>.nip.io` 等）拼装一个地址当成真的。
    - **禁止**把任何拼装/猜测出来的访问地址写进任何组件 env（如 `APP_WEB_URL` / `*_BASE_URL` / `*_PUBLIC_URL` 等）。需要把对外地址回填给某个组件时，同样只能用 `access_infos` 的真实值；拿不到真实值就停下来让用户在控制台确认后提供，不要先拼一个填进去。
    - 真实事故：模型在没有任何工具返回访问地址的情况下，照文档示例格式拼出 `http://dify.<ip>.nip.io`，既写进最终报告又配进了组件 `APP_WEB_URL`，全是编造的。这是 Iron Law 违反。

41. **部署位置和访问地址必须分开。** `project.deployment_location_url` 是 Rainbond 控制台应用概览地址；仅在可信 Console base（`RAINBOND_URL` 或等价 session context）、`team_name`、`region_name` 和 `app_id` 全部已知时生成：
    `<console_base>/#/team/<urlencoded-team>/region/<urlencoded-region>/apps/<urlencoded-app-id>/overview`。
    生成时去掉 `console_base` 末尾 `/`，逐段 URL encode；任一值缺失就写 `null`，禁止从公网访问域名反推 Console host。`delivery_state.preferred_access_url` 仍按 Iron Law 40 只引用网关真实返回值，两者禁止混用。
