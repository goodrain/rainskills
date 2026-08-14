# RainSkills / rainbond-agent 双传输适配执行规格

## 目标

在不改变共享 Rainbond 业务逻辑的前提下，建立两套不可混用的执行产物：

- CLI profile 只通过 RainSkills API `/console/mcp/rainskills/api/query` 调用平台能力。
- Agent embedded profile 只通过 rainbond-agent 会话内 MCP Tool 和 `/console/mcp/query` 调用平台能力。

CDN、缓存和 vendor 只负责 Skill 文本分发，任何失败均不得造成 API 与 MCP 之间的传输回退。

## 提交划分

1. `rainskills`：把 CLI/API 与 embedded/MCP 写入 profile manifest 和 channel manifest，并保留两个独立 tarball。
2. `rainbond-agent`：只读取 embedded channel，安全使用 `tarball_url`，按 profile 隔离缓存并验证产物 manifest。
3. `rainbond-agent`：vendor 统一由上游 embedded builder 生成，删除裸 rsync 和 CLI 文本回注路径。

## 上线门禁

- RainSkills 全量测试通过。
- rainbond-agent 全量测试和 server build 通过。
- embedded artifact 静态扫描不包含 CLI/API/本机凭据标记。
- 255 环境启动日志显示目标 embedded SHA、channel 和 CDN source。
- Agent 的只读与写操作均确认走 MCP，审批、审计和委托身份不退化。

## 回滚

- Skill 内容异常：固定 `RAINBOND_SKILLS_VERSION` 到上一 embedded SHA 并重启。
- CDN 异常：切换 `RAINBOND_SKILLS_SOURCE=local` 使用 embedded vendor。
- Agent loader 异常：回滚 rainbond-agent 构建版本。
- CLI 与 Agent channel 独立回滚，禁止跨 profile 取包。

完整任务、代码片段、验收命令和引用见同名 YAML。
