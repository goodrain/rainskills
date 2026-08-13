# MCP 优先、API 备用传输实施计划

状态：**仅计划，尚未实施**。

完整架构与取舍见 `docs/plans/2026-08-12-api-fallback-transport-design.md`；可执行任务的唯一事实源见 `.claude/specs/api-fallback-transport.yaml`。

## 目标结果

最终保留一套 Console Tool 目录和执行器，同时提供两种客户端传输：

```text
当前会话有原生 rainbond_* Tool -> MCP
当前会话无 Tool、但本地 Bridge 可用 -> API Bridge
两者均不可用 -> 停止并报告缺失条件
```

API Bridge 不是新的 REST 平台。它用现有 JWT 调用 Console 的 `tools/list` 和 `tools/call`，并以 `status/list/describe/call` 四个紧凑命令给 Skill 使用。

## 关键决策

- MCP 永远优先；传输在工作流第一次 Rainbond 调用前选择并锁定。
- 认证、网络、超时和业务错误都不触发跨传输切换。
- 写操作结果未知时先查询平台事实，禁止从另一传输盲重试。
- Tool 增删改由实时 `tools/list` 自动反映，不维护本地 Catalog。
- `list` 不返回 Schema，`describe` 每次只返回一个 Tool，`call` 只输出 `structuredContent`。
- 新增 `/console/mcp/rainskills/api/query` 只为固定 Rainskills/API 客户端语义，不新增 View 或执行逻辑。
- 专用路由 404 时要求升级 Console，不回退到权限语义不同的通用 MCP 路由。
- 正常安装把 Bridge 稳定放到 `~/.rainbond/bin`；运行时不依赖 npx 和网络。
- 默认安装继续保留原生 MCP 注册失败即失败的语义；显式 `--api-only` 才只建立 Bridge，不修改客户端 MCP 配置，并复用现有目标选择。
- `--skip-mcp` 和 `--dest` 保持历史“只复制 Skill”语义，不作为 API-only 模式。
- 顶层 Skill 只判断会话是否暴露任意 `rainbond_*` Tool：有则锁定 MCP，完全没有才探测 API；单 Tool 缺失或调用失败都不能触发切换。
- 共享规则只维护在 `rainbond-app-assistant/references/`；其余业务 Skill 通过官方完整套件布局引用它，不增加生成或同步脚本。
- Bridge `list` 只输出名称，`describe` 才返回描述和 Schema；请求超时固定为 180 秒。

## 执行顺序

1. 评审并冻结两仓协议，记录当前测试基线。
2. 在 `rainbond-console` 先增加 API 专用路由和隐藏 Tool 执行保护。
3. 在 `rainskills` 实现无依赖 Bridge、Launcher 和打包测试。
4. 增加 POSIX/Windows 稳定安装与共享 Skill 选路规则。
5. 运行跨仓契约检查、完整测试矩阵、安全审查和全量验证。
6. 先发布 Console，再发布 Rainskills；先灰度 API fallback，再扩大范围。

## 提交分组

| 顺序 | 仓库 | Commit |
|---|---|---|
| 1 | rainbond-console | `fix: enforce rainskills tool visibility` |
| 2 | rainskills | `feat: add api fallback bridge` |
| 3 | rainskills | `feat: install api fallback transport` |

每组都遵循先失败测试、再实现、再规格审查和代码质量审查。未通过相关测试和仓库全量门禁不得提交。

## 主要验收场景

- 当前会话有 MCP Tool 时完全不运行 Bridge。
- MCP 缺失而 Bridge 可用时锁定 API。
- MCP Tool 存在但返回 401、403 或超时时保持 MCP，禁止探测 API。
- MCP/Bridge 都不可用时停止，不猜测能力。
- JWT 过期时刷新后仍走原传输。
- 旧 Console 返回升级提示，不静默降级。
- Tool 新增、Schema 修改、删除在下一次 `list/describe` 中生效。
- 知道隐藏 Tool 名称也不能从 Rainskills 路径直接调用。
- 写操作服务端完成但客户端超时时，不会跨传输重复执行。
- 默认、api、skip-mcp、custom-dest、refresh 和缺少 Node 的安装语义分别通过测试。
- 完整 Catalog、紧凑 list、单 Schema 和结构化结果的字节体积有可审计基准。
- `rainbond-console` 与 `rainskills` 全量验证通过。

## 回滚

优先回滚 Rainskills，使 Skill 不再选择 API；原生 MCP 不受影响。Bridge 文件可以安全残留，因为没有 Skill 会调用它。Console 的隐藏 Tool 执行保护属于安全修复，原则上保留。无数据库迁移或数据修复。

Skill 文案、Preflight 替换内容和评测矩阵见 `docs/plans/2026-08-13-skill-transport-contract.md`。
