# RainSkills 审计语义统一实施规格

本规格执行 `docs/plans/2026-08-19-rainskills-audit-semantics-design.md`，只修改：

- `rainskills`：参数感知的本地确认分类，与服务端权威策略对齐。
- `rainbond-console`：根据真实 MCP 参数生成权威语义和目标。
- `rainbond-agent`：仅在 RainSkills importer 中消费新语义。
- `rainbond-agent-ui`：优先展示结构化目标并保留旧记录回退。

不修改 `rainbond` Go 核心、普通 Agent approval/projector、历史数据和统计字段。CLI 仅修改确认分类，不改变 metadata/journal 协议。不执行 `git add`、`git commit` 或 `git push`，不派发子 Agent。

完整的失败测试、实现顺序、文件行号和兼容约束见同名 YAML。
