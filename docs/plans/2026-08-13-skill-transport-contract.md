# Rainskills CLI 传输契约

> 状态：已实施。Console 后端保留 MCP 协议兼容层；本机 Skill 不再注册、探测或回退到客户端 MCP。
>
> 适用 Skill：八个会调用 Rainbond 业务 Tool 的 Skill。

## 1. 文档组织

Skill 文档采用两层结构，避免八份规则复制和 Token 浪费：

```text
每个业务 SKILL.md
  ├─ 保留不超过 20 行的 Transport Preflight
  └─ 按需读取 transport-resolution.md
       ├─ 传输状态机
       ├─ Bridge 命令映射
       ├─ 错误分类
       └─ 写操作结果未知恢复
```

共享规则只维护在 `rainbond-app-assistant/references/transport-resolution.md`。顶层 Skill 使用 `references/transport-resolution.md`，其余业务 Skill 使用 `../rainbond-app-assistant/references/transport-resolution.md`。

这依赖当前官方安装器的既有产品契约：每次安装完整的 `rainbond-*` Skill 套件，并禁止手工只复制部分 Skill。与生成八份副本相比，它不需要同步脚本、生成物或摘要校验，更符合低复杂度原则。安装测试必须证明 POSIX、Windows、`--dest` 和更新场景都同时安装 `rainbond-app-assistant`，且所有相对引用可解析。非官方手工单 Skill 复制不承诺 CLI 调用能力。

## 2. 顶层 Skill 的 Preflight 替换规范

`rainbond-app-assistant/SKILL.md` 必须在读取下层 Skill、扫描项目或执行 Rainbond 业务操作前完成一次 CLI preflight。

### 建议正文

```markdown
## Rainbond CLI Preflight（最高优先级）

在读取下层 Skill、扫描项目或执行 Rainbond 业务操作前，运行一次
`node ~/.rainbond/bin/rainskills-tools.js status`，并在工作流结束前复用该 CLI。
按需读取 `references/transport-resolution.md`，不要复制其中规则。

CLI 不可用、未授权或 Console 入口不可用时停止并报告恢复动作；不得探测、注册或回退到客户端 MCP。写操作返回超时或结果未知时，禁止重放；先用 CLI 查询平台事实。
```

### 为什么必须这样写

- `status` 是唯一探针；不能调用真实业务 Tool 或写 Tool 做探针。
- Console 内部仍可使用 MCP JSON-RPC，但那不是客户端的 MCP 安装依赖。
- 同一工作流只使用该 CLI，避免重复写入。

## 3. 下层 Skill 的入口规范

以下八个 Skill 的开头统一放置短入口：

```markdown
## Rainbond CLI

如果上游已经完成本次工作流的 CLI preflight，直接复用；否则在第一次 Rainbond 调用前读取 `references/transport-resolution.md` 并运行一次 `status`。CLI 错误不得触发任何客户端 MCP 回退。
```

适用范围：

| Skill | 处理方式 |
|---|---|
| `rainbond-app-assistant` | 使用完整 Preflight |
| `rainbond-project-init` | 使用短入口；可由顶层传入选择 |
| `rainbond-fullstack-bootstrap` | 使用短入口；本地 package helper 行为不变 |
| `rainbond-fullstack-troubleshooter` | 使用短入口；故障读取仍走锁定传输 |
| `rainbond-delivery-verifier` | 使用短入口；只读验证不跨传输 |
| `rainbond-env-sync` | 使用短入口；运行时事实优先规则不变 |
| `rainbond-template-installer` | 使用短入口；模板业务序列不变 |
| `rainbond-app-version-assistant` | 使用短入口；快照和回滚写操作不可重放 |

根安装 Skill 和 `rainbond-platform-installer` 不加载业务选路参考。它们负责建立能力，不执行 Rainbond 业务 Tool。

## 4. 共享 transport-resolution.md 规范

共享文档控制在 150 行以内，并且包含以下完整状态机。

### 4.1 CLI 解析

```text
run CLI status exactly once
if status == ok:
    CLI is available for the workflow
else:
    stop with the status recovery action
```

规则：

- 不读取客户端 MCP 配置，不根据当前会话 Tool 判断可用性。
- CLI 必须使用稳定安装路径，不在业务工作流中临时执行 `npx` 下载。
- Node.js 或 CLI 不存在时报告适配限制，不尝试生成 Python/Shell 替代实现。

### 4.2 Tool 调用映射

| 需求 | CLI |
|---|---|
| 调用已知 Tool | `call <tool> --input -` |
| Tool Schema 不确定 | `describe <tool>`，单工作流最多一次 |
| 探索候选 Tool | `list --prefix <prefix>` |
| 检查能力 | `status` |

CLI `list` 默认只返回 Tool 名称。描述和 Schema 只能由 `describe` 返回；不要把完整 Catalog 放入模型上下文。

### 4.3 输入规则

- `call` 参数必须通过 stdin 提供，不能传本地 JSON 文件或拼入 Shell 命令字符串。
- Tool 名称必须来自 Skill 固定规则或 `list/describe` 结果，不猜测名字。
- 不在命令行传 URL、JWT、Authorization 或其他 Secret。
- 不把 `credentials.env` 或旧 `mcp.env` 内容复制到对话、日志或临时文件。

### 4.4 失败分类

| 失败 | 解释 | 动作 |
|---|---|---|
| CLI 文件不存在 | 安装不完整或客户端无 Node | 停止并给安装指引 |
| CLI status 返回配置缺失 | 未完成授权 | 执行安装或授权流程 |
| 401/403/token expired | 凭据过期或权限不足 | refresh；不自动重试原写操作 |
| CLI Endpoint 404 | Console 版本过旧 | 提示升级 Console；不回退通用 `/console/mcp/query` |
| Tool not found | Tool 删除、不可见或版本不兼容 | 可 `list --prefix` 一次；仍无候选则停止 |
| 参数校验失败 | Schema 漂移或输入错误 | `describe` 一次并修正；不切换传输 |
| 网络错误/超时 | 结果可能未知 | 读操作可有限重试；写操作先查询事实 |
| 业务错误 | 平台拒绝或状态不满足 | 按业务恢复 |

### 4.5 写操作结果未知

出现网络中断、客户端超时或响应解析失败时：

1. 将本次写操作标记为 `outcome_unknown`。
2. 不重复调用原 Tool，也不切换调用通道。
3. 使用 CLI 调用对应查询 Tool，按应用、组件、事件、记录或快照 ID 核对事实。
4. 只有能证明原操作未执行，且原业务规则允许重试时，才能再次调用。
5. 无法确认时停止并报告已知标识、最后响应和人工核对入口。

禁止使用笼统的“重试一次”规则覆盖创建、删除、部署、回滚、发布和上传初始化操作。

## 5. 安装文档规范

### 5.1 默认模式

默认安装统一采用 CLI 语义：

```text
安装全部 Skills
安装版本化 CLI
授权并写 credentials.env
验证固定 CLI 入口
验证成功 -> 安装成功；Codex、Claude Code 与 Pi 只加载 Skill，不注册 MCP 或 Extension
验证失败 -> 安装失败，并报告 CLI API 原因
```

Node.js 18+ 是运行 CLI 的硬性前提。没有 Node.js 18+ 时，安装在写入任何 Skill 或凭据前失败。

### 5.2 兼容参数

为保证旧自动化不立刻中断，暂时接受下列参数：

```text
npx --yes rainskills codex --api-only
npx --yes rainskills claude --api-only
npx --yes rainskills all --api-only
npx --yes rainskills --dest <client-skill-dir> --api-only
```

它们均为弃用兼容参数，语义固定为：

```text
安装全部 Skills
安装 CLI
完成授权并写 credentials.env
验证 /console/mcp/rainskills/api/query
不修改任何客户端 MCP 配置
```

默认安装已经是该路径，用户不需要选择。`--api-only` 与 `--skip-mcp` 不再改变安装、授权或运行时行为；未来大版本可移除。

### 5.3 Node 缺失

CDN/POSIX 安装在没有 Node.js 时直接失败，且必须明确：

```text
RainSkills CLI 需要 Node.js 18+；请升级 Node 后重新执行安装。
```

本期不增加第二个 Python Bridge。

## 6. 用户可见恢复文案

Skill 不应统一把所有失败都说成“重启客户端”。建议固定四类短文案。

### 6.1 JWT 过期

```text
Rainbond 认证已过期。请刷新 JWT；本次工作流保持原传输，不会自动重放刚才的操作：
bash <(curl -fsSL https://get.rainbond.com/rainskills/install.sh) refresh
```

### 6.2 Bridge 缺失

```text
本机 RainSkills CLI 不存在或无法运行。请安装 Node.js 18+ 后重新运行默认 Rainskills 安装器；安装器不会修改 MCP 客户端配置。完成后重新触发当前请求。
```

### 6.3 Console 版本过旧

```text
当前 Rainbond Console 未提供 Rainskills CLI API 入口。请先升级 Console；本机 Skill 不会回退到客户端 MCP。
```

### 6.4 写操作结果未知

```text
请求在返回结果前中断，操作是否已执行尚不确定。为避免重复创建或部署，我不会直接重试；接下来只通过 CLI 查询平台实际状态。
```

## 7. 文档验收矩阵

至少增加以下静态和行为评测：

| 场景 | Skill 必须执行 |
|---|---|
| CLI status 成功 | CLI；不探测 MCP |
| CLI 文件不存在 | unavailable |
| CLI status 401 | CLI 认证恢复；不尝试 MCP |
| CLI Endpoint 404 | 要求升级；不调用通用 endpoint |
| CLI Tool 参数校验失败 | describe 一次；保持 CLI |
| 写 Tool 超时 | 查询事实；不得自动重放 |
| CLI list | 只出现 Tool 名称，不出现 Schema |

必须额外校验：

- 每个业务 Skill 都包含短入口。
- 每个业务 Skill 的共享相对引用在官方安装布局中可解析。
- POSIX、Windows 和 `--dest` 都继续安装完整 Skill 套件。
- 顶层 Skill 只执行 CLI status，不包含 MCP 探针或回退规则。
- `rainbond_query_enterprises` 不作为通用探针。
- 既有 package upload、版本回滚、部署和排障规则没有因传输抽象而改变。
- Root Installer 与 Platform Installer 不加载业务传输规则。

## 8. 明确禁止的文档写法

- “MCP 失败就改走 API。”
- “优先 MCP，失败自动降级。”
- “调用 `rainbond_query_enterprises` 检测 MCP。”
- “如果不确定就重试一次。”
- “列出所有 Tool 和 Schema 后再决定。”
- “API-only 等于 skip-mcp。”
- “新增 api 子命令并重新实现一套目标选择。”
- “Bridge 不存在时临时用 curl 拼 Authorization。”
- “手工只复制一个业务 Skill 后仍承诺 CLI 调用能力。”

这些表述会分别造成错误切换、权限误判、重复写、Token 膨胀、安装语义混淆或 Secret 风险。
