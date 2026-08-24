# Rainbond 传输解析

在第一次 Rainbond 调用前初始化一次本机 RainSkills CLI。本规则只决定“怎样调用逻辑能力”，不改变任何 Skill 的业务顺序、权限或停止条件。

## 状态机

```text
transport = unresolved
run CLI status exactly once
transport = cli if status succeeds else unavailable
lock transport until workflow ends
```

- 不检测当前会话是否暴露 `rainbond_*` Tool，也不读取客户端配置猜测可用性。
- 每个业务工作流只运行一次 `node ~/.rainbond/bin/rainskills-tools.js status`；成功后锁定 `cli`，失败后锁定 `unavailable` 并停止。
- 不用真实业务能力探测，尤其不用写能力或企业管理员能力。
- CLI 或 Node.js 18+ 不存在时，提示重新运行默认安装器；不生成 Python/Shell 替代实现。

## CLI 映射

| 需求 | CLI |
|---|---|
| 调用已知只读能力 | `read <tool> --input -` |
| 调用写入或破坏性能力 | `call <tool> --input - --skill-id <active_leaf_skill_id>` |
| Schema 不确定 | `describe <tool>`，同一工作流对该 Tool 最多一次 |
| 探索候选能力 | `list --prefix <prefix>` |
| 检查能力目录 | `status`，每个工作流一次 |

- `list` 只返回能力名称；不要把完整 Catalog 或 Schema 注入上下文。
- 仅通过 `describe` 按需加载单个 Schema。
- `read` 与 `call` 只通过 stdin 接收 JSON，不把 JSON 拼入 Shell 命令字符串，也不把任意本机文件路径传给 CLI。
- `read` 在联网前校验 Tool 必须属于只读分类；不得用 `read` 调用写入或破坏性能力，也不得把只读查询改回 `call`。
- Tool 名称来自 Skill 固定规则或 `list` / `describe` 结果，不猜测名字。
- 不在命令行传 URL、JWT、Authorization 或其他 Secret，不读取或回显 `~/.rainbond/credentials.env`。
- `active_leaf_skill_id` 是当前实际承载该业务阶段规则的 leaf Skill 目录名，不是用户自然语言、Tool 名或猜测值；顶层编排存在时追加 `--root-skill-id <root_skill_id>`，否则 CLI 将 leaf 同时作为 root。
- 写/破坏性能力首次调用只会返回 `operation_id`。首次调用与确认调用必须传同一 `--skill-id`、可选 `--root-skill-id` 和完全相同的 stdin；展示目标和影响摘要并获得用户确认后，再追加 `--confirm <operation_id>` 执行一次。不得伪造、复用或绕过确认。
- CLI 只从安装器保护的 Skill manifest 读取版本、摘要和 `SKILL.md` 正文，并在确认调用中发送给 Console 审计；不得自行构造 `_meta`，也不得把 Skill 正文放入业务 arguments、stdout 或用户摘要。

## 常用只读契约

下表中的意图、Tool 和参数是当前版本的固定契约。命中时直接 `read`，**不执行 `list` 或 `describe`**；不要为了确认 Tool 存在或重复阅读 Schema 而增加调用和上下文。

| 用户意图 | Tool | 必需参数 | 范围 |
|---|---|---|---|
| 当前企业摘要 | `rainbond_query_enterprises` | 无；用 session-context 的 `enterprise_id` 从结果中定位当前企业 | 只返回企业信息 |
| 企业团队列表 | `rainbond_query_teams` | `enterprise_id` | 用户明确要求团队时才调用 |
| 企业应用列表 | `rainbond_query_apps` | `enterprise_id` | 用户明确要求企业全部应用时才调用 |
| 某团队、某集群的应用 | `rainbond_get_team_apps` | `team_name`、`region_name` | 仅限已明确团队和集群 |
| 企业集群概览 | `rainbond_query_regions` | `enterprise_id` | 用户明确要求集群时才调用 |

- session-context 已有身份时，不调用 `rainbond_get_current_user`；身份缺失或用户明确要求重新确认时才调用它。
- 用户只要求企业信息时，不得因为用户只要求企业信息而额外查询团队或集群；先返回企业摘要，再由用户决定是否展开。
- 无法由固定契约覆盖的意图，才可 `list --prefix <prefix>` 一次选择候选；仅当选定 Tool 的参数不在契约中时才 `describe <tool>` 一次。
- 只有 CLI 明确返回参数校验或 Schema 不兼容时，读操作可 `describe` 一次并修正后重试；写操作仍遵循确认与“写结果未知”规则，不自动重放。
- CLI 的 stdout 是 JSON 结果，stderr 是诊断；不得使用 `2>&1`、`grep` 或 `head` 处理 CLI 的 JSON 输出，也不得将完整结果、Secret 或内部 ID 原样复述给用户。
- 企业摘要默认只展示名称、别名、创建时间和有文档定义的状态；邮箱、内部 ID、连接地址与配置仅在用户明确需要时展示。`is_active`、CPU/内存等字段的业务含义不明确时，展示原始字段值或说明待确认，不推断“已启用”“超卖”等结论。

## 失败处理

传输一旦锁定，401、403、认证过期、网络、超时、响应解析和业务错误都不得触发替代调用通道。

| 失败 | 动作 |
|---|---|
| CLI 文件或 Node.js 缺失 | 停止并提示重新运行默认安装器 |
| CLI 配置缺失 | 停止并完成安装或授权 |
| 401 / 403 / token expired | 刷新 JWT；保持原传输，不自动重放写操作 |
| API Endpoint 404 | 提示升级 Console；不得回退到通用入口 |
| Tool not found | 可 `list --prefix` 一次，仍无候选则停止 |
| 参数校验失败或 Schema 漂移 | `describe` 一次并修正输入 |
| 读操作网络错误或超时 | 可在 CLI 内有限重试 |
| 写操作网络错误、超时或响应解析失败 | 按“写结果未知”处理 |
| 业务错误 | 按业务规则恢复，不切换传输 |

认证过期时提示：

```bash
bash <(curl -fsSL https://get.rainbond.com/rainskills/install.sh) refresh
# 或：bash ~/.rainbond/skills/install.sh refresh
```

API Endpoint 固定为 `/console/mcp/rainskills/api/query`。404 表示 Console 版本不支持 RainSkills CLI；不要调用通用入口。

## 写结果未知

当写操作在返回前发生网络中断、客户端超时或响应解析失败时：

1. 标记为 `outcome_unknown`。
2. 不重复原 Tool，不切换传输。
3. 使用 CLI 调用对应查询能力，按应用、组件、事件、记录或快照标识核对平台事实。
4. 只有能证明原操作未执行且业务规则允许时，才可再次调用。
5. 无法确认时停止，报告已知标识和人工核对入口；不泄露原始 Secret 或敏感响应。

这条规则覆盖创建、上传初始化、删除、部署、发布、快照和回滚。

## 安装边界

- 官方 POSIX 和 Windows 安装器始终安装完整 `rainbond-*` Skill 套件，因此本相对引用可用；更新、强制覆盖和自定义目标也保持完整套件布局。
- 非官方手工复制单个业务 Skill 不承诺 CLI 调用能力；不要为此复制规则副本或添加生成/同步脚本。
- 默认安装会安装并验证 RainSkills CLI；客户端 target 只决定 Skill 安装目录。
- CLI 不可用时安装失败；不再注册、探测或回退到任何客户端 MCP。
- `--api-only` 与 `--skip-mcp` 是兼容用废弃参数，不改变 CLI-only 安装路径。
