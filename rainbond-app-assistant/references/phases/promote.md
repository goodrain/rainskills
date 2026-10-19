# Explicit promotion

只有用户明确要求 dev-to-test promotion 才进入此分支。先验证 source app 的实际交付结果，读取 app-version-assistant 的版本/快照规则，保留来源、ref 和绑定；不能把 source app 的 delivery_state 当作目标测试应用的验收结果。目标 app 重新验证访问和数据边界。
