# Rainskills Skill 双传输契约

> 状态：待评审，尚未应用到生产 `SKILL.md`
>
> 目标：在不破坏原生 MCP 链路的前提下，为不能加载 MCP、但能执行本地 Node 命令的客户端提供 API Bridge。
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

这依赖当前官方安装器的既有产品契约：每次安装完整的 `rainbond-*` Skill 套件，并禁止手工只复制部分 Skill。与生成八份副本相比，它不需要同步脚本、生成物或摘要校验，更符合低复杂度原则。安装测试必须证明 POSIX、Windows、`--dest` 和更新场景都同时安装 `rainbond-app-assistant`，且所有相对引用可解析。非官方手工单 Skill 复制不承诺 API fallback。

## 2. 顶层 Skill 的 Preflight 替换规范

`rainbond-app-assistant/SKILL.md` 当前的“MCP 失败立即停止”必须整体替换为下面的语义，不得只在后文追加补丁规则。

### 建议正文

```markdown
## Rainbond Transport Preflight（最高优先级）

在读取下层 Skill、扫描项目或执行 Rainbond 业务操作前，先为本次工作流解析一次传输，并在工作流结束前保持不变。按需读取 `references/transport-resolution.md`，不要复制其中规则。

1. 如果当前会话实际暴露本步骤所需的 `rainbond_*` Tool，选择 `mcp`。
2. 只有当前会话没有暴露任何 `rainbond_*` Tool 时，才运行：
   `node ~/.rainbond/bin/rainskills-tools.js status`。
3. Bridge status 成功时选择 `api`；失败时停止并按共享规则报告恢复动作。
4. 已选择 `mcp` 后发生 401、403、超时、网络或业务错误，不得改走 API。
5. 已选择 `api` 后发生任何错误，不得改走 MCP。
6. 写操作返回超时或结果未知时，禁止重放；先用当前传输查询平台事实。

不要通过调用一个真实业务 Tool 来判断“Tool 是否存在”。能力存在性由当前会话的 Tool 列表判断；认证和调用失败表示该传输发生错误，不表示 MCP 不存在。
```

### 为什么必须这样写

- “当前会话没有加载 Rainbond MCP”和“某个 Tool 不存在/调用失败”是不同状态。只要会话暴露任意 `rainbond_*` Tool，本次工作流就锁定 MCP；单个 Tool 缺失属于服务端版本或可见性问题，不能改走 API 绕过。
- Preflight 本身不能使用 `rainbond_query_enterprises` 一类企业管理员能力作为通用探针；普通用户可能没有该 Tool，但仍有团队级能力。
- 不能调用写 Tool 做探针。
- 同一次工作流不能同时使用两条传输，以免写操作重复。

## 3. 下层 Skill 的入口规范

以下八个 Skill 的开头统一放置短入口，替换现有仅面向 MCP 的认证恢复段：

```markdown
## Rainbond 传输

如果上游已解析本次工作流的 Rainbond 传输，直接复用，不重新探测。否则在第一次 Rainbond 调用前读取 `references/transport-resolution.md` 并解析一次。传输锁定后，认证、网络、超时和业务错误均不得触发 MCP/API 切换。
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

### 4.1 传输解析

```text
transport = unresolved

if current_session_has_any_rainbond_tool:
    transport = mcp
else:
    run bridge status exactly once
    if status == ok:
        transport = api
    else:
        transport = unavailable

lock transport until workflow ends
```

规则：

- 只根据当前会话是否暴露任意 `rainbond_*` Tool 判断 MCP，不读取客户端配置文件猜测。
- MCP 已加载但当前工作流所需 Tool 缺失时保持 MCP，报告 Tool 不可用或版本不兼容；不得借 API 绕过客户端可见性。
- 同一会话曾成功调用 Rainbond Tool，可以视为 MCP 已可用；无需重复探测。
- Bridge status 只在 MCP Tool 不存在时运行一次。
- API 模式必须使用稳定安装路径，不在业务工作流中临时执行 `npx` 下载。
- Node.js 或 Bridge 不存在时报告适配限制，不尝试生成 Python/Shell 替代实现。

### 4.2 Tool 调用映射

| 需求 | MCP | API |
|---|---|---|
| 调用已知 Tool | 原生 Tool 调用 | `call <tool> --input -` |
| Tool Schema 不确定 | 使用当前 Tool Schema | `describe <tool>`，单工作流最多一次 |
| 探索候选 Tool | 使用当前 Tool 列表 | `list --prefix <prefix>` |
| 检查 API 能力 | 不需要 | `status` |

API `list` 默认只返回 Tool 名称。描述和 Schema 只能由 `describe` 返回；不要把完整 Catalog 放入模型上下文。

### 4.3 输入规则

- `call` 参数必须以 JSON 文件或 stdin 提供，不能拼入 Shell 命令字符串。
- Tool 名称必须来自 Skill 固定规则或 `list/describe` 结果，不猜测名字。
- 不在命令行传 URL、JWT、Authorization 或其他 Secret。
- 不把 `mcp.env` 内容复制到对话、日志或临时文件。

### 4.4 失败分类

| 失败 | 解释 | 动作 |
|---|---|---|
| 当前会话没有任何 `rainbond_*` Tool，Bridge 文件不存在 | 安装不完整或客户端无 Node | 停止并给安装/API-only 指引 |
| Bridge status 返回配置缺失 | 未完成授权 | 执行安装或授权流程 |
| 401/403/token expired | 凭据过期或权限不足 | refresh；不切换传输，不自动重试原写操作 |
| API Endpoint 404 | Console 版本过旧 | 提示升级 Console；不回退通用 `/console/mcp/query` |
| Tool not found | Tool 删除、不可见或版本不兼容 | 可 `list --prefix` 一次；仍无候选则停止 |
| 参数校验失败 | Schema 漂移或输入错误 | `describe` 一次并修正；不切换传输 |
| 网络错误/超时 | 结果可能未知 | 读操作可在原传输有限重试；写操作先查询事实 |
| 业务错误 | 平台拒绝或状态不满足 | 按业务恢复，不切换传输 |

### 4.5 写操作结果未知

出现网络中断、客户端超时或响应解析失败时：

1. 将本次写操作标记为 `outcome_unknown`。
2. 不重复调用原 Tool，不切换传输。
3. 使用同一传输调用对应查询 Tool，按应用、组件、事件、记录或快照 ID 核对事实。
4. 只有能证明原操作未执行，且原业务规则允许重试时，才能再次调用。
5. 无法确认时停止并报告已知标识、最后响应和人工核对入口。

禁止使用笼统的“重试一次”规则覆盖创建、删除、部署、回滚、发布和上传初始化操作。

## 5. 安装文档规范

### 5.1 默认模式

默认安装保持现有稳定语义：

```text
安装全部 Skills
安装 Bridge
授权并写 mcp.env
验证并注册原生 MCP
MCP 注册失败 -> 默认安装仍失败
```

不能因为 Bridge 可用就把默认 MCP 注册失败改成成功，否则会掩盖已有客户端配置问题。

### 5.2 API-only 模式

新增一个正交的显式标志：

```text
npx --yes rainskills codex --api-only
npx --yes rainskills claude --api-only
npx --yes rainskills all --api-only
npx --yes rainskills --dest <client-skill-dir> --api-only
```

其语义固定为：

```text
安装全部 Skills
安装 Bridge
完成授权并写 mcp.env
验证 /console/mcp/rainskills/api/query
不修改 Codex/Claude MCP 配置
```

API-only 不是 `--skip-mcp` 的别名：

- `--skip-mcp`：只复制 Skill，不承诺授权或 Bridge 可用，保持历史语义。
- `--dest` 单独使用：只复制到自定义目录，保持历史语义。
- `--api-only`：在选定目标或自定义目录之外，明确完成授权、Bridge 安装和 API Endpoint 验证。
- `--api-only` 与 `--skip-mcp` 互斥，参数解析阶段直接拒绝组合使用。

### 5.3 Node 缺失

CDN/POSIX 安装在没有 Node.js 时仍允许安装原生 MCP Skills，但必须明确：

```text
MCP 可用：继续使用 MCP
API-only：不支持，提示安装 Node.js 18+
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
当前会话没有加载 Rainbond MCP，并且本地 API Bridge 不存在。请使用 `--api-only` 运行 Rainskills 安装器；完成后重新触发当前请求。
```

### 6.3 Console 版本过旧

```text
当前 Rainbond Console 未提供 Rainskills API 入口。原生 MCP 若已加载仍可继续使用；API 模式需要先升级 Console。
```

### 6.4 写操作结果未知

```text
请求在返回结果前中断，操作是否已执行尚不确定。为避免重复创建或部署，我不会切换传输或直接重试；接下来只查询平台实际状态。
```

## 7. 文档验收矩阵

至少增加以下静态和行为评测：

| 场景 | Skill 必须选择 |
|---|---|
| 会话暴露任意 MCP Tool，所需 Tool 存在且调用成功 | MCP；不执行 Bridge |
| 会话暴露任意 MCP Tool，调用返回 401 | MCP 错误恢复；不执行 Bridge |
| 会话暴露任意 MCP Tool，调用超时 | MCP 结果未知；不执行 Bridge |
| 会话暴露任意 MCP Tool，但所需 Tool 缺失 | MCP 版本/可见性错误；不执行 Bridge |
| 会话没有任何 MCP Tool，Bridge status 成功 | API |
| 会话没有任何 MCP Tool，Bridge 也不存在 | unavailable |
| API status 401 | API 认证恢复；不尝试 MCP |
| API Endpoint 404 | 要求升级；不调用通用 endpoint |
| API Tool 参数校验失败 | describe 一次；保持 API |
| 写 Tool 超时 | 查询事实；不得自动重放 |
| API list | 只出现 Tool 名称，不出现 Schema |

必须额外校验：

- 每个业务 Skill 都包含短入口。
- 每个业务 Skill 的共享相对引用在官方安装布局中可解析。
- POSIX、Windows 和 `--dest` 都继续安装完整 Skill 套件。
- 顶层 Skill 不再包含“MCP 探针失败立即停止”的旧规则。
- `rainbond_query_enterprises` 不再作为所有用户的强制通用探针。
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
- “手工只复制一个业务 Skill 后仍承诺 API fallback。”

这些表述会分别造成错误切换、权限误判、重复写、Token 膨胀、安装语义混淆或 Secret 风险。
