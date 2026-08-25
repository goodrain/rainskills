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

Node.js 前置检查通过后，每次请求先执行本地 launcher + `["environment", "list", "--json"]`，按用户明确指定的运行环境选择不可变环境 ID；未指定时只用全局默认环境，默认环境不可用时停止且不回退。生成 UUID 后执行本地 launcher + `["operation", "begin", "--operation-id", "<uuid>", "--environment-id", "<id>", "--intent-json", "<intent-json>"]`，并在之后每个 Rainbond MCP 调用中加入 `rainskills_operation_id`。环境、团队和应用只属于本次操作，禁止保存项目级默认环境或绑定；同一项目可以在多个环境中查询。明确“团队”表示环境内团队；明确“运行环境/平台”表示环境；裸名称同时匹配环境和团队时必须询问。

构造命令前必须先创建完整 intent，并把同一 JSON 原样用于 `operation begin` 和 `runtime connect`。例如查询当前企业时固定为 `{"type":"platform-query","resource":"current-enterprise"}`；不得只传 `resource`。本地 intent 校验失败表示命令尚未发起连接或授权，必须如实报告参数错误，不得表述为授权被拒绝。

第一步检查 Node.js 是否存在且主版本不低于 18。Node.js 缺失或低于 18 时，只说明“Rainskills 执行组件需要 Node.js 18 或更高版本”并停止：不选择运行环境，不调用 MCP，不猜测替代命令。只有用户或 agent 明确同意后才安装或升级 Node.js，再从同一原始 intent 继续。

固定 launcher 是 `["node", "<home>/.rainbond/lib/rainskills/bin/rainskills.js"]`；运行包版本标记为 `rainskills@0.1.10`，且必须与本技能包 `package.json` 一致。把 launcher 与参数拼成 argv 数组直接执行，禁止 `rainskills@latest` 或执行 shell 字符串。

本地 launcher 必须从当前 Skill 所在目录的同级目录定位 `rainbond-platform-installer/scripts/local-runtime.js`，解析为绝对路径后使用 `["node", "<绝对路径>"]` 执行。`environment list`、`operation begin`、`operation complete` 和 `runtime message` 只能使用本地 launcher；本地 launcher 只读取已安装文件和本机受保护状态，不得访问 npm 或其它网络。只有用户选定连接运行环境后，才使用上面的固定本地 launcher。

所有 Rainbond 查询和变更必须通过本地 `~/.rainbond/bin/rainskills-tools.js` 执行，并绑定本次 operation ID。禁止 Agent 直接调用 Rainbond MCP，也不得启动本地 Rainskills MCP 服务；只允许执行 CLI 返回的结构化结果与确认续接 argv。

只有 CLI 返回并通过校验的 `rainskills.next-action.v1` argv 才能执行续接。普通失败一律禁止自动重试：不得再次执行原命令，不得执行 `--help`、`sleep`、`rg`、`grep`，不得搜索 Rainskills 源码；同一 `operation complete` 最多执行一次。

<!-- rainskills-runtime-contract:start -->
```json
{
  "schema": "rainskills.skill-runtime-contract.v1",
  "package_version": "rainskills@0.1.10",
    "launcher": ["node", "<home>/.rainbond/lib/rainskills/bin/rainskills.js"],
  "local_launcher": ["node", "<installed-skills-root>/rainbond-platform-installer/scripts/local-runtime.js"],
  "local_argv": {
    "environment-list": ["node", "<installed-skills-root>/rainbond-platform-installer/scripts/local-runtime.js", "environment", "list", "--json"],
    "operation-begin": ["node", "<installed-skills-root>/rainbond-platform-installer/scripts/local-runtime.js", "operation", "begin", "--operation-id", "<uuid>", "--intent-json", "<intent-json>"],
    "operation-complete": ["node", "<installed-skills-root>/rainbond-platform-installer/scripts/local-runtime.js", "operation", "complete", "--operation-id", "<uuid>"],
    "runtime-message": ["node", "<installed-skills-root>/rainbond-platform-installer/scripts/local-runtime.js", "runtime", "message", "--id", "<message-id>"]
  },
  "intents": {
    "platform-query": {"required": ["resource"], "optional": ["enterprise_id", "team_id", "app_id"], "enums": {"resource": ["current-user", "current-enterprise", "teams", "regions", "apps", "team-apps", "components"]}}
  },
  "routes": {"existing": ["saas", "private-existing"]},
  "connect_argv": {
    "saas": ["node", "<home>/.rainbond/lib/rainskills/bin/rainskills.js", "runtime", "connect", "<target>", "--saas", "--intent-json", "<intent-json>"],
    "private-existing": ["node", "<home>/.rainbond/lib/rainskills/bin/rainskills.js", "runtime", "connect", "<target>", "--rainbond-url", "<rainbond-url>", "--intent-json", "<intent-json>"]
  }
}
```
<!-- rainskills-runtime-contract:end -->

target 只允许 `codex`、`claude`、`pi`、`all`。校验 intent 后只执行 existing scope 的完整 argv；只消费 schema 为 `rainskills.next-action.v1` 且校验后的 `argv` 数组。

连接完成后用固定 `onboarding-id` 执行 launcher + `["intent", "resume", "--onboarding-id", "<同一 onboarding-id>"]`，恢复原始 intent 和 `resume_step`。401 先执行 launcher + `["runtime", "record-failure", "--onboarding-id", "<同一 onboarding-id>", "--step", "<当前固定步骤>", "--reason", "credential-expired"]`，再仅一次执行 launcher + `["runtime", "reconnect", "--onboarding-id", "<同一 onboarding-id>"]` 后 resume，只重试该步骤；第二次 401 停止。403 执行 launcher + `["runtime", "record-failure", "--onboarding-id", "<同一 onboarding-id>", "--step", "<当前固定步骤>", "--reason", "permission-denied"]` 后停止，不得 reconnect、重新授权或自动重试。
<!-- rainskills-runtime-gate:end -->

<!-- rainskills-runtime-routing:start -->
## 缺少运行环境时

先说：“可以，我会帮你查询 Rainbond 平台信息。不过目前还没有可用的应用运行环境。你刚安装的 Rainskills 是 AI 部署助手；应用实际运行在 Rainbond 上。Rainbond 是一套应用运行和管理平台，你不需要了解 Kubernetes。”

只让用户选择 `Rainbond Cloud` 或承载目标应用或待查询平台信息的`已有私有 Rainbond`。选择已有私有 Rainbond 时执行本地 launcher + `["runtime", "message", "--id", "private-console-origin"]` 并原样输出。不得为只读查询安装私有 Rainbond。
<!-- rainskills-runtime-routing:end -->

## Scope and routing

This lightweight skill handles only explicit, read-only platform questions. Route deployment or project delivery to `rainbond-app-assistant`; creation to `rainbond-project-init` or `rainbond-fullstack-bootstrap`; repair to `rainbond-fullstack-troubleshooter`; final acceptance to `rainbond-delivery-verifier`; publishing to `rainbond-app-version-assistant`.

Do not expand a narrow question into related resource queries. Never change resources, credentials, access control, or configuration.

## Fixed query contract

1. Reuse current session identity when available. If it is absent, call `rainbond_get_current_user` once.
2. For “current enterprise”, an administrator calls `rainbond_query_enterprises` with `{}` and selects the enterprise matching session `enterprise_id`. Do not then query teams or regions.
3. If enterprise or cluster-management Tools are not visible, state that the user can only view their current permission scope. Do not guess a Tool name or attempt discovery.
4. Resolve required context before the resource query and pass the exact Console-backed arguments below. A session may supply these values, but it does not make required arguments optional at the Tool boundary:
   - enterprises: `rainbond_query_enterprises({})`
   - teams: `rainbond_query_teams({enterprise_id})`
   - regions/clusters: `rainbond_query_regions({enterprise_id})`
   - all accessible apps: `rainbond_query_apps({enterprise_id})`
   - apps in one team/region: `rainbond_get_team_apps({team_name, region_name})`
   - components: `rainbond_query_components({enterprise_id, app_id})`
5. `enterprise_id`, `team_name`, and `region_name` must come from current session identity, an earlier query result, or explicit user context. `app_id` must be a positive integer; normalize a decimal string before the Tool call and reject values such as `app-123`.
6. Use the read contract `read <tool> --input -` when using the CLI. Keep stdout JSON separate from stderr; do not use `2>&1`, `grep`, or `head` to process its output.
7. Report only fields needed for the question. Avoid email addresses, internal IDs, connection addresses, and configuration unless explicitly requested.

## Examples

- “帮我查询当前企业的信息” → current identity if needed, then one `rainbond_query_enterprises {}` call for an administrator; no team or region query.
- “我有哪些团队？” → resolve `enterprise_id`, then `rainbond_query_teams({enterprise_id})` only.
- “这个应用有哪些组件？” → resolve `enterprise_id` and positive-integer `app_id`, then `rainbond_query_components({enterprise_id, app_id})` only.

## Result

State the requested scope, the observed facts, and any permission boundary. When facts are unavailable, say which required context is missing instead of inferring it.
