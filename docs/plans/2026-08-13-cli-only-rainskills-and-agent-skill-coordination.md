# RainSkills CLI-only 与 rainbond-agent Skill 协调设计

> 状态：实施中；CLI-only 本机发行链路与 embedded profile 生成、分发和 vendor 同步已落地，仍以本文件的边界和回归要求作为验收标准。
>
> 决策：**RainSkills 的用户本机发行版统一以受控 CLI 调用 Rainbond 能力；Rainbond Console 后端 MCP 不删除；rainbond-agent 继续使用服务端内嵌 MCP Tool 执行。**

## 1. 背景、目标与非目标

### 1.1 当前情况

RainSkills 已有本地 Bridge：`bin/rainskills-tools.js`。它从本地受限文件读取配置，向 Console 的专用入口
`/console/mcp/rainskills/api/query` 发送 MCP JSON-RPC `tools/list` 和 `tools/call`。

目前产品层还保留两条运行时路径：

```text
用户本机 Skill
  └─ rainskills-tools.js → Console MCP HTTP

rainbond-agent
  └─ 服务端 LLM Tool → 内置 RainbondMcpClient → /console/mcp/query
```

`rainbond-agent/skills-src/rainbond` 是 RainSkills 主体的 vendor 副本，但不是原样复制：生成产物显式带 `mode: embedded` 和版本化 `runtime_contract`；可选的 `workflow`、`tool_policy`、`output_contract` machine blocks 仍由 Agent 侧保留。服务端执行器负责委托凭据、审批、审计、幂等保护与轮询保护。

### 1.2 目标

1. 对 Codex、Claude Code、Pi 等具备本地命令执行能力的用户，移除 RainSkills 对原生 MCP 客户端注册、自动加载与客户端差异的依赖。
2. 所有本机业务 Skill 固定通过一个受控 CLI 调用既有 Console MCP 后端能力；不让 Skill 自由拼 `curl`。
3. 不修改、不删除 `rainbond-console` 的 MCP Tool 实现、权限模型、工具目录和 HTTP endpoint。
4. 保证 rainbond-agent 不被本机 CLI 规则污染，继续通过其现有 embedded Tool + server-side MCP client 运行。
5. 建立一份业务主体的唯一事实来源，并用明确 profile 生成两端文本，防止以后 vendor sync 产生逻辑漂移。

### 1.3 非目标

- 不将 Console 的 107 个 MCP Tool 重写为 REST endpoint。
- 不要求 rainbond-agent 在容器中安装或执行用户本机的 `rainskills-tools.js`。
- 不把用户 JWT 复制到 rainbond-agent，或通过 Shell 参数传递 JWT。
- 不改变现有业务能力的名称、参数、RBAC、写操作审批或 Console 审计。
- 第一阶段不支持没有 Node.js 18+ 的本机客户端，也不新增 Python/Shell/Go 的第二套 Bridge。

## 2. 架构与边界

### 2.1 目标运行架构

```text
                    Shared Skill Core
        (业务顺序、能力语义、停止条件、验收规则)
                         │
        ┌────────────────┴────────────────┐
        │                                 │
CLI profile                         embedded profile
        │                                 │
RainSkills 本机发行版                 rainbond-agent vendor 发行版
Skill → rainskills-tools.js           Skill → 内嵌 LLM Tool
        │                                 │
        └─────── Console MCP HTTP ────────┘
```

两端共享“做什么”，但不共享“如何执行”。

| 责任 | 本机 RainSkills | rainbond-agent |
|---|---|---|
| 能力调用 | 本地 CLI `call <tool>` | 当前 session 的内嵌同名 Tool |
| 凭据 | CLI 私有配置文件或 CI 环境变量 | 服务身份 / 委托身份凭据提供器 |
| 工具 Schema | `describe` 按需加载 | `tools/list` 后由服务端 Tool registry 管理 |
| 写操作防护 | Skill 的 outcome-unknown 规则 + Console 语义 | 现有审批、去重、审计、轮询、破坏性调用 guard |
| 禁止行为 | 不直连 curl、不传 JWT argv | 不执行用户本机 CLI、不读取用户 home 配置 |

### 2.2 为什么 rainbond-agent 不能改为 CLI-only

rainbond-agent 是服务端嵌入式执行器，而非用户工作站。它当前：

- 在 `src/server/integrations/rainbond-mcp/client.ts` 中直接调用 `/console/mcp/query`；
- 在 `src/server/runtime/service-mcp-credential-provider.ts` 获取服务、飞书委托和群委托凭据；
- 在 `src/server/runtime/server-llm-executor.ts` 执行 Tool 过滤、审批、审计 trace、写操作去重与超时恢复；
- 在 `src/server/workflows/mcp-tool-registry.ts` 缓存真实 Tool Schema。

将上游 Skill 直接改为“执行 `node ~/.rainbond/bin/rainskills-tools.js`”会使服务容器缺少 CLI 与用户凭据，并绕开上述服务端安全控制。因此 Agent profile 必须显式禁止 Shell/CLI 作为平台能力调用通道。

### 2.3 官方行为与代码事实的交叉结论

| 判断点 | 官方文档事实 | 当前代码事实 | 结论 |
|---|---|---|---|
| Codex MCP 配置影响范围 | Codex Desktop、CLI、IDE Extension 共用 MCP 配置 | `install.sh` 写 `codex mcp add rainbond` | 清理旧配置必须在 CLI 验证后进行、严格匹配并备份，不能按名称盲删。 |
| Claude MCP 配置范围 | Claude 有 local/project/user scope，且优先级不同 | 当前安装器只用 `claude mcp add --scope user` | 只允许清理脚本管理的 user-scope entry，绝不删除项目 `.mcp.json`。 |
| Pi 是否依赖 Extension 才能加载 Skill | Pi package 可以只声明 `skills`；Extension 用于注册工具/事件 | `package.json` 同时声明 Pi extension 和 skills；extension 将全部 MCP tools 注册到 Pi | CLI-only 本机包可移除 Pi MCP extension，但保留 Pi skill package。 |
| 受限/托管环境支持 | ChatGPT Web 不读取本地 Codex 配置，也无本地命令菜单 | Bridge 是本地 Node 文件 | CLI-only 只能承诺有本地执行环境的客户端；不能承诺 Hosted Chat/Web。 |

参考： [Codex MCP 官方文档](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)、[Claude Code MCP 官方文档](https://code.claude.com/docs/id/mcp)、[Pi package 官方文档](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md)。

## 3. Skill 内容组织与协调机制

### 3.1 唯一主体与 profile 注入

不能长期维护两份完整 `SKILL.md`。将每个可共享 Skill 划分为：

```text
<skill>/
  SKILL.core.md                 # 唯一业务主体
  profiles/cli.md               # RainSkills 本机调用规则
  profiles/embedded.md          # rainbond-agent 调用规则
  modules/ references/ schemas/ evals/  # 共享，除明确 profile 差异外一致
```

`SKILL.core.md` 只描述能力与约束，例如：

```text
调用逻辑能力 `rainbond_query_apps`。
若写操作超时或结果未知，禁止重放，先查询平台事实。
```

核心主体禁止出现下列运行环境细节：

- “调用 MCP Tool”；
- `node ~/.rainbond/bin/rainskills-tools.js`；
- `~/.rainbond/credentials.env`；
- `Mcp-Session-Id`、MCP endpoint、客户端配置路径；
- rainbond-agent 的服务身份、审批、trace 实现细节。

生成器把 core、对应 profile、以及 embedded machine blocks 合成为目标项目最终加载的 `SKILL.md`。最终产物而不是源码分片才是 Skill Loader 和外部客户端的输入。

### 3.2 CLI profile 固定规则

本机 profile 必须规定：

1. 每个业务工作流开始时，仅运行一次 `node ~/.rainbond/bin/rainskills-tools.js status`；成功后 CLI 锁定到工作流结束。
2. 已知能力调用 `call <tool> --input -`；通用调用的参数只通过 stdin 传入，禁止把任意本地 JSON 文件作为输入。
3. Schema 不确定时，单个 Tool 最多执行一次 `describe <tool>`；工具名不确定时，最多一次 `list --prefix <prefix>`。
4. 禁止检测当前会话里的 `rainbond_*` Tool；禁止从 CLI 模式回退到原生 MCP。
5. 禁止在命令行传 URL、JWT、Authorization 或秘密；禁止 `curl` 调用 Console。
6. 读操作可按业务预算有限重试；写操作网络中断、超时或响应解析失败时为 `outcome_unknown`，先查询事实、不得盲目重放。

### 3.3 embedded profile 固定规则

rainbond-agent profile 必须规定：

1. 只调用当前 session 暴露的同名 embedded Tool；不运行 shell 命令作为 Rainbond 平台调用渠道。
2. 不读取 `~/.rainbond/*`、不要求用户 JWT、不假设 Node CLI 或用户本机文件存在。
3. 只使用 server executor 注入的 Tool Schema、凭据、审批和审计机制。
4. Tool 不可用时遵循服务端 Tool 可见性错误；不得建议 CLI fallback。
5. 写结果未知时仍按共享业务规则查事实；额外的服务端去重、审批与 trace 不可被 Skill 绕过。
6. `runtime_contract` 固定为 `session_tools`、`client_workspace=unavailable`、`local_package_upload=unsupported`：上下文只能来自用户显式输入、当前 UI/会话上下文和 Tool 返回的平台事实；遇到客户端文件或本地打包需求必须停止并交给本机 CLI profile。

### 3.4 同步模型演进

现有 `rainbond-agent/scripts/sync-rainbond-skills.mjs` 是 `rsync → 回注 mode/machine blocks`。它不能保护未来上游 CLI transport 章节，因此必须迁移为受控 profile 构建：

```text
指定 RainSkills revision
  → 校验 Shared Core
  → build --profile embedded
  → 注入已审批的 embedded machine blocks
  → 写入 skills-src/rainbond
  → 校验 manifest 与语义一致性
```

在新构建器稳定前，过渡同步器至少要：

- 移除/替换上游 CLI profile，而不是仅附加 machine blocks；
- 对同步出的 `SKILL.md` 拒绝出现 `rainskills-tools.js`、`~/.rainbond/credentials.env`、`--api-only` 等 CLI-only 标记；
- 强制存在 embedded profile 标记和原有 machine blocks；
- 在同步结果写入前输出并记录上游 Git SHA。

### 3.5 分阶段降低文档构建复杂度

最终目标是 `SKILL.core.md + profiles/*`，但第一期不能为了消除两份文档又立即引入一个大型 Markdown 编译系统。先在现有 `SKILL.md` 中定义唯一、具名且可替换的 execution-profile 标记块：

```markdown
<!-- RAINSKILLS_EXECUTION_PROFILE:BEGIN -->
... profile-specific instructions ...
<!-- RAINSKILLS_EXECUTION_PROFILE:END -->
```

- 上游 source 仅维护共享业务正文和 CLI profile；
- Agent vendor builder 精确替换该完整标记块为 embedded profile，并回注现有 machine blocks；
- CI 对标记块外的正文、modules、schemas、evals 做一致性校验；
- 当两端同步机制和契约测试稳定后，再把该标记块物理拆分为 core/profile 文件。

这样首期只增加一个可审计的替换点，避免 profile 差异散落在正文中。

## 4. RainSkills 本机 CLI-only 改造计划

### 4.1 CLI 契约与安全实现

目标文件：

- `bin/rainskills-tools.js`
- `bin/rainskills.js`
- `tests/api-bridge.test.js`

工作项：

1. 保留现有 `status`、`list`、`describe`、`call`，它们仍通过 `/console/mcp/rainskills/api/query` 使用后端 MCP 协议。
2. 将该程序从“API Bridge fallback”重命名为用户可见的 “RainSkills CLI”；可保留脚本路径以兼容已安装版本。
3. 固定 endpoint 和 RPC method：`status/list/describe` 只能使用 `tools/list`，`call` 只能使用 `tools/call`；不新增任意 URL、任意 JSON-RPC method 或自定义 Authorization 参数，避免 CLI 成为内部 API 逃逸通道。
4. Skill 的通用调用只接受 `--input -`；输入 JSON 必须经 stdin 传递。默认拒绝任意文件路径，避免提示注入诱导 CLI 读取并上传本机 JSON/秘密文件。将来确有大文件上传需求时，另设专用子命令与私有临时目录，不能放开通用 `call --input <path>`。
5. 保持 1 MiB 输入限制、180 秒总超时、JWT/参数字段级脱敏与结构化 exit code。网络响应可接受上限仍为 10 MiB 以防内存耗尽，但**面向模型的 stdout 默认不超过 128 KiB**；列表走分页，日志走尾部行数窗口，超出时返回 `truncated`、`next_cursor`、摘要和必要的操作标识，不能以无结构字符串截断代替。
6. 默认仅允许 HTTPS。对于可信内网私有化环境，用户可在安装时显式传 `--allow-insecure-http` 并确认风险；安装器在私有凭据中写入受控 allow 标记。CLI 只在该标记存在时允许同一配置的 `http://` URL，并在 stderr 给出不含凭据的明文传输警告。未显式授权的 HTTP 必须拒绝，避免 JWT 被无意发送到明文链路。
7. 增加稳定的 CLI 版本输出和 machine-readable 运行时信息（例如 `status` 中的 `cli_version`、`tool_count`、`catalog_age`）；不得回显 endpoint、JWT 或完整工具目录。
8. 为每次写调用生成 `operation_id`，写入私有、本机受限权限的 operation journal；成功、失败和结果未知都记录最小元数据。首期 operation ID 只保证本地关联与审计；只有在 Console 实现与所用 MCP 协议均确认接受请求 metadata 后，才可透传该 ID。未获服务端关联/幂等支持的既有 Tool 仍不得自动重放。
9. 根据随 CLI 发布、版本化的最小 Tool 风险清单区分 `read`、`write`、`destructive`，不能由模型猜测。写/破坏性操作必须携带与当前 `operation_id` 绑定的显式确认；交互终端显示摘要后确认，非交互模式必须显式传递确认参数。该确认补充用户意图，不替代 Console RBAC。

验收：既有 Console 返回 107 工具时，`status`、`list`、`describe`、`call` 仍可用；stdin-only、风险确认、输出预算、HTTP 显式授权和 operation journal 均有负向测试；错误中不泄露 token、URL 或输入中的秘密。

### 4.2 能力目录、Schema 与输出预算

当前 `status`、`list`、`describe` 都会请求完整 `tools/list`。这不必立刻改变 Console 协议，但 CLI 应增加一个小型、私有的 capability cache，避免每轮工作流重复拉取完整目录和把无关信息输出给模型：

```text
~/.rainbond/capabilities.json
  endpoint identity + protocol version + fetched_at
  tool name + description + inputSchema + schema digest
  不保存 JWT、业务调用输入或业务结果
```

规则：

1. 缓存目录 `0700`、文件 `0600`，拒绝符号链接；按 Console 地址和 protocol version 隔离。
2. 正常 TTL 取短值（建议 5 分钟）；`status` 只输出 `tool_count`、`catalog_age` 和 CLI 版本。
3. `list --prefix` 只输出名称；`describe` 只输出一个 Tool 的描述与 schema。
4. 收到 `tool not found`、参数校验失败、协议版本变化或认证刷新后，缓存只失效并刷新一次；同一失败不循环刷新。
5. CLI 可基于已获取的 JSON Schema 做本地早期参数校验，Console 仍是最终 schema/RBAC 裁决者。
6. Skill 优先使用限定查询、分页、时间窗口和日志 tail 参数；不能把完整 `tools/list` 或大业务响应直接转写入 LLM 上下文。

验收：同一工作流中 schema 已知时不重复拉取 catalog；schema 漂移最多触发一次刷新和一次按需 describe；大结果不会超过 stdout 上下文预算。

### 4.3 写操作确认与结果未知处置

CLI-only 不能因为失去客户端原生 Tool UI 就弱化用户确认和幂等边界。首期采用一个尽量小的本地协议：

```text
generate operation_id
  → 按版本化风险清单判定 read/write/destructive
  → write/destructive 展示目标、影响摘要与 operation_id
  → 用户显式确认
  → 单次 call
  → 写 journal(success|failed|unknown)
  → unknown 时只查询平台事实，不重放
```

规则：

1. 风险清单由发布包维护并有版本号；未知 Tool 默认按 write 处理，拒绝在没有确认的情况下执行。
2. 交互模式中确认文本必须绑定当前 `operation_id`；非交互模式必须显式传入同一 ID 的确认值，不能通过环境变量或 `--force` 静默跳过。
3. timeout、连接中断和无法解析响应都标记为 `unknown`。此时 Skill 先查询目标资源、部署/发布记录或任务事件；只有能证明请求未到达服务端时，才由用户重新确认后再发起新 operation。
4. journal 只保存 operation ID、Tool 名、风险级别、时间、脱敏目标摘要、状态和关联线索，不保存 JWT、完整请求、完整响应或秘密字段；保留期限和清理策略需文档化。
5. 后续 Console 若支持 `operation_id` 去重或查询，可无缝提升确定性；在此前，local journal 是辅助审计，不得宣称提供跨进程幂等保证，也不应先行向既有 Tool schema 注入未验证字段。

验收：未确认写调用、未知 Tool 调用和未知结果后的自动重放均被拒绝；journal 不含秘密；同一超时场景只能进入事实查询路径。

### 4.4 安装器与认证重构（POSIX）

目标文件：

- `install.sh`
- `SKILL.md`
- `README.md`
- `marketplace/rainskills/skills/rainskills/SKILL.md`
- `tests/install.sh.test`
- `tests/install_test_suite_tty_test.py`
- `tests/npx-launcher.test.js`

工作项：

1. 默认安装流程改为：安装完整 Skill 套件 → Node 18+ preflight → 原子安装 CLI → 浏览器/设备码授权 → CLI 连通性校验 → 写私有凭据 → 可选旧 MCP 配置迁移清理。
2. 删除 `--api-only`，因为 CLI 已是唯一标准路径；删除 `--skip-mcp` 作为“跳过客户端 MCP”的语义。若保留 `--skip-mcp` 兼容旧 CLI，必须显示弃用错误或严格限定为只复制 Skill，不能导致半安装的业务运行态。
3. 删除 `configure_codex_mcp`、`configure_claude_mcp`、`configure_pi_mcp`、`validate_mcp_connectivity` 及 Codex/Claude/Pi 专用 endpoint 验证与迁移。
4. `validate_api_connectivity` 改名为 CLI 连通性校验，仍验证 API endpoint 的 `tools/list`，不得改用真实业务 Tool。
5. Node.js 18+ 变为成功安装的前置条件；无 Node 时明确失败并给出安装 Node 的恢复动作，不生成 Python/Shell Bridge。
6. `refresh` 只刷新 CLI 凭据、失效 capability cache 并验证 CLI；不修改任何客户端 MCP 配置。
7. 交互式安装在需要写/破坏性操作确认的环境中保留 TTY；非交互安装不暗示后续写操作已获批准。

### 4.5 凭据迁移与本地文件安全

目标文件：

- `install.sh`
- `bin/rainskills-tools.js`
- POSIX 安装器与配置测试

工作项：

1. 新路径定为 `~/.rainbond/credentials.env`，权限 `0600`；目录权限 `0700`。读取时必须拒绝符号链接、非普通文件和权限宽于上述限制的文件。
2. CLI 按优先级读取 `RAINBOND_URL`/`RAINBOND_JWT` 环境变量，再读取 `credentials.env`；环境变量只用于显式用户/CI 覆盖，安装器不再写 shell startup 文件。环境变量模式在状态输出中只标注来源类型，不输出值。
3. 凭据文件还保存由安装器写入的 `RAINBOND_ALLOW_INSECURE_HTTP=true`；它是唯一允许 HTTP 的持久化开关，且只有用户显式确认 `--allow-insecure-http` 后才能写入。
4. 旧 `~/.rainbond/mcp.env` 仅作为一次性迁移输入。新凭据写入、CLI 校验成功后，再删除或以私有备份方式归档旧文件。
5. 删除 shell RC 中由本项目管理的 `source ~/.rainbond/mcp.env` 区块；不修改非本项目管理的内容。
6. 设备码 endpoint 与授权 scope 可以暂时保留 MCP 命名，因为这属于 Console 兼容协议，不能在本项目单方面更改。

### 4.6 业务 Skill 文档迁移

目标范围：

- `rainbond-app-assistant/SKILL.md`
- `rainbond-project-init/SKILL.md`
- `rainbond-fullstack-bootstrap/SKILL.md`
- `rainbond-fullstack-troubleshooter/SKILL.md`
- `rainbond-delivery-verifier/SKILL.md`
- `rainbond-env-sync/SKILL.md`
- `rainbond-template-installer/SKILL.md`
- `rainbond-app-version-assistant/SKILL.md`
- 共享 `references/transport-resolution.md` 及各模块/参考文件中的 MCP 专有表述

工作项：

1. 先抽取共同业务主体；不得把 CLI 命令散落复制到八个 Skill。
2. 替换双传输状态机。CLI profile 成为唯一入口，不再观察本会话是否已有 MCP Tool。
3. 业务规则中将“调用 MCP”改为“调用逻辑能力”；仅 CLI profile 写明命令方式。
4. 保留所有既有高风险业务约束：写结果未知、创建预算、依赖完整性、配置覆盖 gate、升级/回滚和上传事务等。
5. 将写操作规则升级为：先生成 `operation_id` → 展示或获取显式确认 → 执行一次 → 若结果未知，读取本机 journal 和平台事实 → 只在能证明未执行且业务预算允许时才再次请求确认；没有服务端关联能力的 Tool 永不自动重放。
6. 保留 CLI 的按需 Schema 和 capability cache 策略，避免完整 `tools/list` schema 或大结果带来 Token 膨胀。

### 4.7 本机客户端插件/扩展清理

目标文件：

- `src/pi/rainskills-mcp.ts`
- `pi/rainskills-mcp.ts`
- `scripts/build-pi-extension.mjs`
- `package.json`
- `package-lock.json`
- `tests/pi-extension.test.js`
- `tests/marketplace-entry.test.js`
- `tests/npm-package.test.js`

工作项：

1. 移除 Pi MCP extension 与构建任务，移除 `@modelcontextprotocol/sdk` 依赖。
2. `package.json` 的 `pi` manifest 仅保留 `skills`，使 Pi 继续正常发现 Skill。
3. 删除 Codex/Claude MCP 注册逻辑与对应测试；不要删除用户自行配置的任意其他 MCP server。
4. 重新定义安装 target 的含义：target 只决定 Skill 的安装目录/市场入口和用户提示，不再决定 Rainbond 的调用传输。

## 5. 旧 MCP 客户端配置的安全迁移

### 5.1 清理原则

迁移清理是可选且可恢复的后置步骤，先满足：CLI 已安装、凭据已写入、`status` 校验成功。清理失败不能回滚成功的 CLI 安装，但必须报告残留。

| 客户端 | 可自动识别与清理的条件 | 禁止处理的对象 |
|---|---|---|
| Codex | server 名 `rainbond`，URL 为当前 Console 已知 RainSkills/通用 MCP 路径，认证环境字段仍是 `RAINBOND_JWT` | 其他名称、其他域名、静态 header、自定义 Tool 策略、项目级配置 |
| Claude | 脚本管理的 `rainbond` **user scope**，URL 与 Header 模板均匹配 | `.mcp.json`、local/project scope、自定义 URL/header |
| Pi | 精确文件 `~/.pi/agent/extensions/rainskills-mcp.ts` 且内容识别为本项目生成物 | 其他 extension、用户修改过或无法验证来源的文件 |

每个自动删除前创建私有备份并记录恢复命令。配置不匹配时只报告人工清理说明，不删除。

### 5.2 两阶段发布

为降低误删风险，建议分两个兼容版本发布：

```text
2.0: CLI-only 安装；检测并报告旧 MCP 配置，默认不自动删除
2.1: 在明确 --cleanup-legacy-mcp 或交互确认后，执行严格匹配清理
```

若产品必须在 2.0 自动清理，也应提供 `--keep-legacy-mcp` 逃生选项，并在每个可删除对象前使用明确的交互确认；非交互模式默认只报告、不删除。

## 6. rainbond-agent 配套计划

### 6.1 保留的服务端实现

以下组件继续保留，不随 RainSkills CLI-only 移除：

- `src/server/integrations/rainbond-mcp/client.ts`
- `src/server/integrations/rainbond-mcp/query-tools.ts`
- `src/server/integrations/rainbond-mcp/mutable-tools.ts`
- `src/server/runtime/service-mcp-credential-provider.ts`
- `src/server/runtime/server-llm-executor.ts`
- `src/server/workflows/mcp-tool-registry.ts`

它们是 server-side execution boundary，不是用户客户端 MCP 注册逻辑。

### 6.2 vendor/build 机制改造

目标文件：

- `rainbond-agent/scripts/sync-rainbond-skills.mjs`
- `rainbond-agent/scripts/sync-skills.sh`
- `rainbond-agent/skills-src/rainbond/*`
- `rainbond-agent/src/server/skills/skill-source.ts`
- `rainbond-agent` 的 Skill sync/source 测试

工作项：

1. 将当前“rsync 后回注”脚本替换或包装为 profile-aware builder。
2. vendor build 必须以明确 RainSkills SHA 或发布版本为输入，并在输出 manifest 中记录该 SHA、profile=`embedded`、生成器版本、Skill 清单和不可放宽的 `runtime_contract`。
3. 同步时保留 embedded machine blocks，但将 CLI profile 完整替换为 embedded profile；不能依赖关键字删除零散行。
4. `sync-skills.sh` 不得再提供可绕过 profile 构建的裸 `rsync` 路径；应委托同一生成器或在有 vendor-local delta 时强制失败。
5. CDN 模式下载的公共 RainSkills 包应在 Agent 端进行 embedded 编译/注入，或改为下载明确的 embedded profile artifact；不得直接将 CLI-only 成品当作 Agent runtime Skill。
6. 更新 `skill-source.ts` 的 allowlist、source manifest 验证和 cache key，使 profile 与 SHA 共同决定缓存路径；避免 CLI artifact 与 embedded artifact 混用。

### 6.3 运行期安全回归

在 Agent profile 与执行器中加静态/运行期防线：

- 拒绝 vendor Skill 正文包含本地 CLI 命令或 `~/.rainbond` 用户凭据路径，并通过 `runtime_contract` 拒绝任何声称可访问客户端工作区或本地上传的 embedded artifact；
- Agent system prompt 明确平台能力只能通过暴露的 Tool 调用；
- 不因 Tool 缺失建议本机 CLI fallback；
- 继续保留现有 Tool filter、权限、审批、trace、mutating guard 和 polling guard。

## 7. 一致性、测试与验收

### 7.1 产物一致性测试

生成两份最终 Skill 后，以受控忽略规则比较：

允许不同：

- `mode` / profile frontmatter；
- CLI vs embedded transport profile；
- Agent 的 `workflow`、`tool_policy`、`output_contract` machine blocks；
- Agent 专属审计、审批、委托身份说明。

必须一致：

- 业务阶段顺序、调用能力名、参数语义；
- 高风险写操作的停止、幂等和 outcome-unknown 规则；
- 业务 modules、references、schemas、evals（除明确 profile 文件）；
- 能力调用的验收条件和错误恢复逻辑。

CI 必须输出结构化差异，禁止只依赖人工 diff。

### 7.2 能力契约测试

从两个产物抽取 `rainbond_*` 能力引用，生成比较清单：

```text
skill_id, capability_name, operation_class(read|write), required_profile_rule
```

验证：

1. 两端能力集合相同，或差异被 profile allowlist 明确批准。
2. 同名写能力在两端都包含“不盲目重放”的规则。
3. Agent 端实际 Tool policy 可允许的能力与 Skill 文档引用不冲突。
4. Console 的 `tools/list` schema 漂移时，CLI `describe` 与 Agent Tool registry 都可检测并报告，而不会静默伪造字段。

### 7.3 双执行环境 E2E

用同一组 mock Console 场景运行两套 profile：

| 场景 | CLI profile 预期 | embedded profile 预期 |
|---|---|---|
| 工具目录可用 | CLI `status` 一次，按需 `call` | server MCP registry 获取 schema，内嵌 Tool 调用 |
| Schema 不确定 | 一次 `describe` | 使用 registry 中真实 schema |
| 401/403 | 提示 refresh，不重放写操作 | 刷新/委托凭据策略，不重放写操作 |
| 写超时 | 查询事实，不重放 | trace + guard 后查询事实，不重放 |
| 工具缺失 | `list --prefix` 至多一次后停止 | 报告当前 Tool catalog 不可用，不建议 CLI |
| CLI-only 标记进入 Agent vendor | 构建失败 | 不允许启动/发布 |
| HTTP 未授权 | 本地拒绝且不给请求发送 JWT | 不适用（Agent 走服务端受控连接） |
| 本地 JSON 文件路径 | 通用 `call` 拒绝，只接 stdin | 不适用 |
| 大型结果 | stdout 截断为摘要/游标，结果不超预算 | Tool 输出按现有 policy 截断/过滤 |
| 未确认写操作 | 本地拒绝；无 `operation_id` 不执行 | 继续由 Agent approval/mutating guard 决定 |

还需保留并扩展：

- RainSkills：`npm test`、`npm pack --dry-run`、POSIX/Windows/npx 安装测试；
- rainbond-agent：类型检查、现有 MCP client、mutable tool policy、Skill Loader、workflow executor、approval/trace 相关测试；
- 跨仓库：使用 `check-api-compat` 核对工具名、接口路径与错误语义，不更改 Console 协议。

### 7.4 发布与回滚

建议作为 major release：

```text
RainSkills 1.x: legacy hybrid client transport (superseded)
RainSkills 2.x: local CLI-only
rainbond-agent: embedded MCP profile, pinned to compatible shared-core SHA
```

发布顺序：

1. 先交付 shared core/profile builder 与 Agent embedded profile 验证；
2. 让 rainbond-agent canary 使用指定 SHA 的 embedded artifact；
3. 发布 RainSkills CLI-only canary，保留旧 MCP 配置但只报告；
4. 完成双环境 E2E 与真实 Console 验证；
5. 提升 stable，随后再启用可选旧配置清理；
6. 任一严重问题通过 pin 回上一共享 core SHA / 上一 RainSkills release 回滚，Agent 不下载 CLI artifact。

## 8. 实施顺序与提交分组

### Commit 1：定义共享 Core 与 Profile 格式

- 在 RainSkills 创建 core/profile 文件格式、生成器与静态校验。
- 将一个最小 Skill（建议 `rainbond-delivery-verifier`）试迁移。
- 生成 CLI 和 embedded 两个 fixture，验证仅允许差异存在。

验收：不改实际安装器；两个 fixture 的业务能力集合一致。

### Commit 2：rainbond-agent 构建器与 vendor 保护

- 在 rainbond-agent 改造 `sync-rainbond-skills.mjs`，接入 embedded profile 与 SHA manifest。
- 阻断裸 rsync 覆盖 profile。
- 增加 vendor artifact 防污染测试。

验收：从同一 upstream SHA 构建 Agent artifact，不包含 CLI 指令；现有 embedded loader 可加载。

### Commit 3：全部业务 Skill 迁移到共享 core

- 迁移八个业务 Skill、模块引用、schemas/evals 和 transport 规则。
- 更新 RainSkills CLI profile 与 Agent embedded profile。

验收：核心一致性、能力契约、双 profile mock E2E 通过；原有业务规则未回归。

### Commit 4：RainSkills CLI-only 运行时、安装器与凭据迁移

- 实现 stdin-only、风险确认、operation journal、能力缓存、Schema 早期校验、响应预算和 HTTPS 默认拒绝。
- 重构 POSIX CLI 安装、refresh、Node preflight、凭据路径与文档。
- 保留 Console MCP HTTP 调用，不注册客户端 MCP。

验收：干净机器安装、refresh、Node 缺失、JWT 脱敏、未经授权 HTTP、文件路径输入、未确认写调用、CLI endpoint 404、缓存失效、输出截断及写超时测试通过。

### Commit 5：Windows 与 Pi 包清理

- 对齐 Windows onboarding、私有凭据/capability cache/journal 目录、stdin-only、HTTP 授权、确认语义与 CLI 验证。
- 移除 Pi extension/MCP SDK，保留 Pi skills manifest。

验收：Windows 私有目录与原子安装测试仍通过；Pi 包可发现 Skill；无 MCP extension 产物。

### Commit 6：旧 MCP 配置检测与可选清理

- 首先只检测/报告/备份。
- 在后续兼容版本经明确确认后增加严格匹配删除。

验收：自定义和项目级配置绝不删除；受管理配置可恢复；CLI 安装不依赖清理成功。

## 9. 风险与决策门

| 风险 | 缓解措施 | 必须通过的决策门 |
|---|---|---|
| 把 CLI-only 文本 vendor 到 Agent | shared core + profile build + 禁词测试 | Agent artifact 不含 CLI 用户路径和命令 |
| 误删用户 MCP | 先 report-only、严格匹配、私有备份、非交互默认不删 | 三客户端自定义配置保护测试 |
| Node 缺失导致用户无法使用 | 安装最早期检查、明确支持矩阵 | 产品确认 Node 18+ 是正式前提 |
| CLI Secret 泄露 | 私有配置、stdin 输入、脱敏、禁止 shell autoload | stdout/stderr/argv/history 负向测试 |
| 明文 HTTP 误用 | HTTPS 默认拒绝；仅显式 `--allow-insecure-http` 写入受控标记并逐次告警 | 无标记的 HTTP 请求绝不发出；授权 HTTP 有告警测试 |
| 本地文件被诱导上传 | 通用调用仅接 stdin；大文件另设专用受限通道 | `--input <path>` 和符号链接输入负向测试 |
| 写调用结果未知后重复执行 | operation ID、最小 journal、事实查询、重新确认；不自动重放 | timeout/断连场景无第二次写请求 |
| 工具目录与大结果挤占上下文 | 短 TTL 私有缓存、按需 describe、分页/tail、128 KiB stdout 预算 | 缓存命中、一次刷新、截断/游标测试 |
| CLI 缺少原生 Tool 表单确认 | 版本化风险清单 + operation ID 绑定确认，Console 保留 RBAC | 未确认/未知 Tool/非交互绕过负向测试 |
| Schema 或工具目录漂移 | CLI describe + Agent registry + tool contract CI | 真实 Console `tools/list` 兼容测试 |
| Agent 丢失审批/审计 | Agent 不调用本地 CLI，保留内嵌 Tool executor | mutable tool policy/approval/trace 回归测试 |
| 两端核心规则漂移 | SHA manifest、产物比较、双 profile E2E | CI 强制通过，不允许手工绕过 |

## 10. 最终验收标准

1. 本机 RainSkills 安装后，Codex/Claude/Pi 不再需要或注册 Rainbond MCP；所有业务 Skill 固定调用受控 CLI。
2. RainSkills CLI 继续通过既有 Console MCP endpoint 工作，Console 无需改变。
3. Node.js 18+、本地命令执行权限和到 Console 的网络可达性被清晰声明为本机支持前提。
4. `rainbond-agent` 继续通过服务端 MCP client 与 embedded Tool 执行，所有审批、委托身份、审计和去重防护仍有效。
5. 同一共享 core SHA 可以生成两端 Skill；业务能力、停止条件、验收规则可自动验证一致。
6. Agent artifact 永远不包含本机 CLI/用户凭据指令；本机 artifact 不包含 Agent 的服务身份与 machine blocks。
7. 旧 MCP 客户端配置不会被未经确认或无法识别的迁移逻辑删除。
8. 本机 CLI 默认不向 HTTP 端点发送 JWT；仅在显式授权后允许明文内网连接，并持续给出警告。
9. 通用 CLI 调用只从 stdin 接收 JSON；stdout 受预算限制；本地缓存、凭据和 journal 均不含 JWT 或业务秘密，且具备私有权限校验。
10. 写/破坏性调用有与 operation ID 绑定的显式确认；结果未知时只走平台事实查询，绝不自动重放。
11. RainSkills 与 rainbond-agent 的全部相关测试、构建和跨仓库兼容检查通过后才发布稳定版本。
