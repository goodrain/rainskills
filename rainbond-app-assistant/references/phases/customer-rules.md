# customer-rules

12. `delivery_state` 只表示 source app。
      在没有运行 `delivery-verifier` 之前必须是 `null`。
      `promotion_result` 只表示 snapshot 和 testing app；未进入 promotion 时必须是 `null`。

25. 每次运行内部仍必须形成 `AppAssistantResult` 结果对象，但默认用户答复不暴露 YAML。
    当 `source_app_delivery` 的 runtime healthy、没有 blocker 且 delivery 已 `delivered` 或只剩浏览器人工确认时，默认正文只输出结果、应用、状态和已验证地址，同一字段只出现一次；不附加固定下一步列表。

26. 只有在自动化/评测明确要求结构化契约，或用户明确要求 YAML、JSON、调试详情、内部状态对象时，才把 `AppAssistantResult` 渲染为最终 fenced `yaml`。部署失败、仍在构建、存在 blocker/handoff/身份歧义或进入 dev-to-test promotion 都不是默认暴露 YAML 的理由。

27. 如果本次使用了 Git、镜像仓库或其他传输代理，必须在默认交付报告的处理记录或注意事项中说明；在结构化模式下也必须写入 `actions_performed[].details`。
    代理事实属于执行记录，不是强制暴露 YAML 的理由。
