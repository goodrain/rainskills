---
name: rainbond-platform-query
description: Use for a user-requested, read-only Rainbond platform query about the current user, enterprise, team, region, app, or component. Do not use for deployment, changes, publishing, troubleshooting, or installation.
---

# Rainbond Platform Query

<!-- rainskills-runtime-gate:start -->
## 运行环境门禁（最高优先级）

### CLI 调用格式（强制）

所有可变 `call` 都必须使用完整 argv：`call <tool> --input - --operation-id <uuid> --skill-id rainbond-platform-query`。CLI 返回确认 ID 后，只能在同一 argv 末尾加入 `--confirm <confirmation-id>`；不得省略 `--skill-id`、猜测参数，或根据泛化错误反复重试。

### 多运行环境操作契约

Node.js 前置检查通过后，平台只读查询只执行一次本地 `rainskills-tools.js query`。用户未指定运行环境时，不得先执行 `environment list`，由 CLI 直接使用全局默认环境；默认环境缺失或不可用时停止且不回退。用户明确指定运行环境时，才允许执行一次本地 launcher + `["environment", "list", "--json"]` 解析不可变环境 ID，随后执行带 `--environment-id` 的单次查询。CLI 直接从受保护环境注册表读取环境与凭据，校验完整 `platform-query` intent 后调用 Rainbond；只读查询不创建 `operation_id` 或 operation 记录。Agent 禁止生成 UUID、禁止传 `--intent-json`，也禁止调用 `operation begin` 或 `operation complete`。环境、团队和应用只属于本次查询，禁止保存项目级默认环境或绑定；同一项目可以在多个环境中查询。明确“团队”表示环境内团队；明确“运行环境/平台”表示环境；裸名称同时匹配环境和团队时必须询问。

查询入口只接受固定 Tool 映射：`rainbond_get_current_user`、`rainbond_query_enterprises`、`rainbond_query_teams`、`rainbond_query_regions`、`rainbond_query_apps`、`rainbond_get_team_apps`、`rainbond_query_components`。resource 和 intent 由 CLI 从 Tool 与输入参数构造并校验，Agent 不得自行拼接。CLI 参数校验失败表示命令尚未发起 Rainbond 查询，必须如实报告本地参数错误，不得表述为授权被拒绝。

对 `rainbond_query_teams({})` 等企业范围查询，CLI 会在同一条 `query` 命令内部自动调用 `rainbond_get_current_user`，从当前身份取得 `enterprise_id`，再调用 `rainbond_query_teams` 等目标 Tool。Agent 不得要求用户提供或输入 `enterprise_id`，也不得为了取得该字段额外执行一条身份查询命令。

第一步检查 Node.js 是否存在且主版本不低于 18。Node.js 缺失或低于 18 时，只说明“Rainskills 执行组件需要 Node.js 18 或更高版本”并停止：不选择运行环境，不调用 MCP，不猜测替代命令。只有用户或 agent 明确同意后才安装或升级 Node.js，再从同一原始 intent 继续。

固定 launcher 是 `["node", "<home>/.rainbond/lib/rainskills/bin/rainskills.js"]`；运行包版本标记为 `rainskills@0.1.17`，且必须与本技能包 `package.json` 一致。把 launcher 与参数拼成 argv 数组直接执行，禁止 `rainskills@latest` 或执行 shell 字符串。

本地 launcher 必须从当前 Skill 所在目录的同级目录定位 `rainbond-platform-installer/scripts/local-runtime.js`，解析为绝对路径后使用 `["node", "<绝对路径>"]` 执行。仅在用户明确指定环境时使用 `environment list`；`runtime message` 仍使用本地 launcher。本地 launcher 只读取已安装文件和本机受保护状态，不得访问 npm 或其它网络。

所有 Rainbond 查询必须通过本地 `~/.rainbond/bin/rainskills-tools.js` 的单次 `query` 命令执行。默认环境 argv 固定为 `["node", "<home>/.rainbond/bin/rainskills-tools.js", "query", "<tool>", "--input", "-"]`；明确环境 argv 固定为 `["node", "<home>/.rainbond/bin/rainskills-tools.js", "query", "<tool>", "--environment-id", "<environment-id>", "--input", "-"]`。JSON 只经 stdin 输入。禁止 Agent 直接调用 Rainbond MCP，也不得启动本地 Rainskills MCP 服务；不得把一次查询拆成 `environment list`、`operation begin`、`read`、`operation complete` 四次执行。

只有 CLI 返回并通过校验的 `rainskills.next-action.v1` argv 才能执行续接。普通失败一律禁止自动重试：不得再次执行原命令，不得执行 `--help`、`sleep`、`rg`、`grep`，不得搜索 Rainskills 源码；只读查询不得手工补跑 `operation begin` 或 `operation complete`。

<!-- rainskills-runtime-contract:start -->
```json
{
  "schema": "rainskills.skill-runtime-contract.v1",
  "package_version": "rainskills@0.1.17",
  "launcher": ["node", "<home>/.rainbond/lib/rainskills/bin/rainskills.js"],
  "local_launcher": ["node", "<installed-skills-root>/rainbond-platform-installer/scripts/local-runtime.js"],
  "local_argv": {
    "environment-list": ["node", "<installed-skills-root>/rainbond-platform-installer/scripts/local-runtime.js", "environment", "list", "--json"],
    "runtime-message": ["node", "<installed-skills-root>/rainbond-platform-installer/scripts/local-runtime.js", "runtime", "message", "--id", "<message-id>"],
    "platform-query-default": ["node", "<home>/.rainbond/bin/rainskills-tools.js", "query", "<tool>", "--input", "-"],
    "platform-query-selected": ["node", "<home>/.rainbond/bin/rainskills-tools.js", "query", "<tool>", "--environment-id", "<environment-id>", "--input", "-"]
  },
  "intents": {
    "platform-query": {
      "type": "platform-query",
      "required": ["type", "resource"],
      "optional": ["enterprise_id", "team_id", "app_id"],
      "enums": {
        "resource": ["current-user", "current-enterprise", "teams", "regions", "apps", "team-apps", "components"]
      },
      "example": {
        "type": "platform-query",
        "resource": "components",
        "app_id": "app"
      }
    }
  },
  "routes": {
    "existing": ["saas", "private-existing"]
  },
  "connect_argv": {
    "saas": ["node", "<home>/.rainbond/lib/rainskills/bin/rainskills.js", "runtime", "connect", "<target>", "--saas", "--intent-json", "<intent-json>"],
    "private-existing": ["node", "<home>/.rainbond/lib/rainskills/bin/rainskills.js", "runtime", "connect", "<target>", "--rainbond-url", "<rainbond-url>", "--intent-json", "<intent-json>"]
  },
  "input_commands": {
    "query-default": {
      "argv": ["node", "<home>/.rainbond/bin/rainskills-tools.js", "query", "<tool>", "--input", "-"],
      "stdin_schema_source": "tool-catalog"
    },
    "query-selected": {
      "argv": ["node", "<home>/.rainbond/bin/rainskills-tools.js", "query", "<tool>", "--environment-id", "<environment-id>", "--input", "-"],
      "stdin_schema_source": "tool-catalog"
    }
  }
}
```
<!-- rainskills-runtime-contract:end -->

target 只允许 `codex`、`claude`、`pi`、`all`。校验 intent 后只执行 existing scope 的完整 argv；只消费 schema 为 `rainskills.next-action.v1` 且校验后的 `argv` 数组。

连接完成后用固定 `onboarding-id` 执行 launcher + `["intent", "resume", "--onboarding-id", "<同一 onboarding-id>"]`，恢复原始 intent 和 `resume_step`。401 先执行 launcher + `["runtime", "record-failure", "--onboarding-id", "<同一 onboarding-id>", "--step", "<当前固定步骤>", "--reason", "credential-expired"]`，再仅一次执行 launcher + `["runtime", "reconnect", "--onboarding-id", "<同一 onboarding-id>"]` 后 resume，只重试该步骤；第二次 401 停止。403 执行 launcher + `["runtime", "record-failure", "--onboarding-id", "<同一 onboarding-id>", "--step", "<当前固定步骤>", "--reason", "permission-denied"]` 后停止，不得 reconnect、重新授权或自动重试。
<!-- rainskills-runtime-gate:end -->

受限沙箱（包括 Codex）执行本地状态命令时，必须申请用户级受保护目录访问权限；在 Codex 中使用 `require_escalated`。不得修改 `~/.rainbond` 权限、复制受保护状态到工作区，或因沙箱权限错误建议重装。

涉及浏览器或设备授权的 `runtime connect`，以及恢复/安装场景中的 `rainskills <target> --self-hosted`，必须在附加交互终端（TTY）中运行；在 Codex 中设置 `tty: true` 并保持进程附着直到授权完成。禁止通过非交互命令要求用户粘贴 JWT；非交互模式只可复用已存在的受保护凭据。

执行优化：同一会话内只检查一次 Node.js（首次使用本地 CLI 前）；仅在 Node.js 或 Rainskills 安装、升级，或 PATH 变更后失效。固定 launcher 和 argv 已在本 Skill 中，禁止读取、搜索或探测 `rainskills.js`，也禁止执行 `npm root -g`。每个新的业务操作仍按其契约刷新环境列表；平台只读查询未指定环境时由 CLI 使用全局默认环境，不枚举环境。带已有 `operation_id` 或 `onboarding-id` 的续接复用已绑定的环境 ID，不重复枚举环境。

<!-- rainskills-runtime-routing:start -->
## 缺少运行环境时

先说：“可以，我会帮你查询 Rainbond 平台信息。不过目前还没有可用的应用运行环境。你刚安装的 Rainskills 是 AI 部署助手；应用实际运行在 Rainbond 上。Rainbond 是一套应用运行和管理平台，你不需要了解 Kubernetes。”

只让用户选择 `Rainbond Cloud` 或承载目标应用或待查询平台信息的`已有私有 Rainbond`。选择已有私有 Rainbond 时执行本地 launcher + `["runtime", "message", "--id", "private-console-origin"]` 并原样输出。不得为只读查询安装私有 Rainbond。
<!-- rainskills-runtime-routing:end -->

## Scope and routing

This lightweight skill handles only explicit, read-only platform questions. Route deployment or project delivery to `rainbond-app-assistant`; creation to `rainbond-project-init` or `rainbond-fullstack-bootstrap`; repair to `rainbond-fullstack-troubleshooter`; final acceptance to `rainbond-delivery-verifier`; publishing to `rainbond-app-version-assistant`.

Do not expand a narrow question into related resource queries. Never change resources, credentials, access control, or configuration.

## Fixed query contract

1. Execute exactly one local `query` command for the requested resource. For enterprise-scoped Tools, omit `enterprise_id` when it is not already known; the CLI resolves it internally from `rainbond_get_current_user` without exposing the identity response.
2. For “current enterprise”, call `rainbond_query_enterprises` with `{}`. Do not then query teams or regions.
3. If enterprise or cluster-management Tools are not visible, state that the user can only view their current permission scope. Do not guess a Tool name or attempt discovery.
4. Pass only user-known context to the one-shot CLI query. The CLI fills the required enterprise context before invoking the Console-backed target Tool:
   - enterprises: `rainbond_query_enterprises({})`
   - teams: `rainbond_query_teams({})`
   - regions/clusters: `rainbond_query_regions({})`
   - all accessible apps: `rainbond_query_apps({})`
   - apps in one team/region: `rainbond_get_team_apps({team_name, region_name})`
   - components: `rainbond_query_components({app_id})`
5. `enterprise_id` is internal context resolved by the CLI and must not be requested from the user. `team_name` and `region_name` come from an earlier query result or explicit user context. `app_id` must be a positive integer; normalize a decimal string before the Tool call and reject values such as `app-123`.
6. Use the one-shot contract `query <tool> --input -` when using the CLI. Keep stdout JSON separate from stderr; do not use `2>&1`, `grep`, or `head` to process its output.
7. Report only fields needed for the question. Avoid email addresses, internal IDs, connection addresses, and configuration unless explicitly requested.

## Examples

- “帮我查询当前企业的信息” → one `rainbond_query_enterprises({})` query; no team or region query.
- “我有哪些团队？” → one `rainbond_query_teams({})` query; the CLI resolves enterprise context internally.
- “这个应用有哪些组件？” → one `rainbond_query_components({app_id})` query; the CLI resolves enterprise context internally.

## Result

State the requested scope, the observed facts, and any permission boundary. When facts are unavailable, say which required context is missing instead of inferring it.
