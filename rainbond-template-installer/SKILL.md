---
name: rainbond-template-installer
description: "Use when the user explicitly asks to install a local or cloud Rainbond application template into a new or existing target app. Trigger phrases include: 从模板安装 WordPress 应用 / 安装应用模板 / install app template. Not for a third-party public image or upstream container stack; use rainbond-opensource-app-deploy."
---

# Rainbond Template Installer

## 用户可见结果协议（最高优先级）

普通用户回复默认使用简洁中文，只说明模板名称和版本、目标应用、安装结果、已安装服务及唯一下一步。内部 `TemplateInstallResult` 仍可用于校验，但不直接展示。

- 成功时说明模板是否安装完成，以及用户接下来可以访问或检查什么。
- 未完成时说明直接原因；只有确有安全可执行方案时才补充解决办法。
- 默认不得展示内部对象、状态枚举、team/region/app ID、模板内部 ID、Skill/工具名、YAML、JSON 或英文编排标题。
- 只有用户明确要求 YAML、JSON、调试详情，或自动化/评测明确要求结构化契约时，才使用后文的结构化输出格式。

<!-- rainskills-runtime-gate:start -->
## 单运行环境 CLI 门禁（最高优先级）

本机只允许连接一个 Rainbond 运行环境。当前 Skill 在本会话第一次调用 Rainbond 前，执行固定 launcher 的 `runtime status --json`。返回 `connected` 且 `usable=true` 后，所有查询和变更直接通过本地 `~/.rainbond/bin/rainskills-tools.js` 执行。不得配置或直接调用客户端 MCP，不得执行环境枚举或业务 operation 生命周期命令，也不得生成或传递运行环境 ID、业务 operation ID 或 intent JSON。

没有运行环境时，让用户选择 Rainbond Cloud 或一个已有/新建的私有 Rainbond，并执行对应的 `runtime connect`。连接和重新授权必须进入浏览器 Device Flow，不复用 Shell 中缓存的 JWT；新凭据通过 live probe 后才覆盖唯一运行环境。CLI 返回 401 时，只读调用可在 `runtime reconnect` 成功后重试一次；写调用不得自动重放，必须先查询平台真实状态。403 直接停止，不重新授权。

授权命令是同步门禁。执行工具返回“进程仍在运行”或会话 ID 时，必须只等待或轮询同一个命令会话；在该会话结束前，禁止读取专项 Skill、解析 context、调用业务 CLI 或执行任何后续业务步骤。浏览器页面显示成功不代表连接完成；只有原命令退出码为 0，并输出 `rainskills.runtime-connect-result.v1` 且 `state=connected`，才可继续。不得另起 `runtime status` 猜测完成，也不得重复提示用户授权。

Codex 中命令工具一旦返回 `session_id`，必须立即对该 `session_id` 反复调用 `write_stdin`（空输入轮询），直到工具返回 `exit_code`。连接器输出 `[RAINSKILLS_AGENT_WAIT_REQUIRED:runtime-connect]` 后进入上述轮询；看到 `[RAINSKILLS_AGENT_WAIT_COMPLETE:runtime-connect]` 后仍须继续轮询，直到取得退出码和最终 JSON。

Hermes Agent 中必须使用 `terminal` 以 `background=true` 启动授权命令；取得 `session_id` 后，只对同一会话按需调用 `process(action="poll")` 获取授权地址，再调用 `process(action="wait")` 等待退出。`wait` 超时时只能继续等待同一 `session_id`；不得把后台启动或浏览器成功页面当作授权完成，也不得另起 `runtime status`。

Hermes Agent 执行带 `--input -` 的一次性业务命令时，使用 `terminal` 前台执行，并用单引号 heredoc 将完整 JSON 只写入 stdin；不得用 `echo`、把 JSON 放入 argv、合并 stderr 或把该短命令后台化。

固定 contract 中的 `<target>` 必须替换为当前宿主：Codex=`codex`、Claude Code=`claude`、Pi Agent=`pi`、DeepSeek Harness=`dsh`、WorkBuddy=`workbuddy`、Hermes Agent=`hermes`。DeepSeek Harness 和 WorkBuddy 若返回持久终端或后台任务句柄，只轮询该原始句柄直到进程退出，不另起状态命令推测完成。

`context resolve` 是无状态调用：单一工作空间直接返回上下文，多个候选返回组合选项；用户选择后由当前任务直接携带 team/region 参数，不执行 `context select`，不写本地 operation。所有可变 `call` 仍需先取得 confirmation ID，再以完全相同的输入追加 `--confirm` 执行一次。

`required` 只声明要解析的维度，企业 ID 始终来自当前登录身份。用户明确给出的 team/region 必须放进 `hints` 做精确匹配；不得把企业名、team 名或选择对象作为顶层 `enterprise` / `workspace` 字段传入。多候选时只展示 CLI 返回的 label；用户选择后再次执行同一个无状态 `context resolve`，通过 `selection.option_id` 让 CLI 重新查询并验证当前候选，不写本地 context 状态。

```json
{
  "schema": "rainskills.single-runtime-contract.v1",
  "package_version": "rainskills@0.1.41",
  "runtime_status": [
    "node",
    "<home>/.rainbond/lib/rainskills/bin/rainskills.js",
    "runtime",
    "status",
    "--json"
  ],
  "runtime_connect": {
    "saas": [
      "node",
      "<home>/.rainbond/lib/rainskills/bin/rainskills.js",
      "runtime",
      "connect",
      "<target>",
      "--saas"
    ],
    "private_existing": [
      "node",
      "<home>/.rainbond/lib/rainskills/bin/rainskills.js",
      "runtime",
      "connect",
      "<target>",
      "--rainbond-url",
      "<console-origin>"
    ],
    "install_private": [
      "node",
      "<home>/.rainbond/lib/rainskills/bin/rainskills.js",
      "runtime",
      "connect",
      "<target>",
      "--install-private",
      "--location",
      "<local-or-server>"
    ],
    "reconnect": [
      "node",
      "<home>/.rainbond/lib/rainskills/bin/rainskills.js",
      "runtime",
      "reconnect",
      "<target>"
    ]
  },
  "input_commands": {
    "context_resolve": {
      "argv": [
        "node",
        "<home>/.rainbond/bin/rainskills-tools.js",
        "context",
        "resolve",
        "--input",
        "-",
        "--skill-id",
        "rainbond-template-installer"
      ],
      "stdin": {
        "default": {"required": ["enterprise", "workspace"]},
        "with_hints": {"required": ["enterprise", "workspace"], "hints": {"team_name": "<team-name>"}},
        "with_selection": {"required": ["enterprise", "workspace"], "selection": {"option_id": "<option-id>"}}
      }
    },
    "read": {
      "argv": [
        "node",
        "<home>/.rainbond/bin/rainskills-tools.js",
        "read",
        "<tool>",
        "--input",
        "-",
        "--skill-id",
        "rainbond-template-installer"
      ],
      "stdin_schema_source": "tool-catalog"
    },
    "call": {
      "argv": [
        "node",
        "<home>/.rainbond/bin/rainskills-tools.js",
        "call",
        "<tool>",
        "--input",
        "-",
        "--skill-id",
        "rainbond-template-installer"
      ],
      "stdin_schema_source": "tool-catalog"
    },
    "call_confirm": {
      "argv": [
        "node",
        "<home>/.rainbond/bin/rainskills-tools.js",
        "call",
        "<tool>",
        "--input",
        "-",
        "--skill-id",
        "rainbond-template-installer",
        "--confirm",
        "<confirmation-id>"
      ],
      "stdin_schema_source": "same-confirmed-input"
    }
  }
}
```
<!-- rainskills-runtime-gate:end -->

受限沙箱（包括 Codex）执行本地状态命令时，必须申请用户级受保护目录访问权限；在 Codex 中使用 `require_escalated`。不得修改 `~/.rainbond` 权限、复制受保护状态到工作区，或因沙箱权限错误建议重装。

`runtime connect` 的 Device Flow 不依赖 stdin TTY；Agent 必须执行固定 argv 并保持进程附着直到授权完成。能打开本机浏览器时由连接器自动跳转，SSH、容器等无浏览器场景原样展示授权地址并继续轮询。只有 Rainbond 不支持 Device Flow 且进入旧版 loopback 手动粘贴时才需要交互终端；不得要求用户在聊天中粘贴 JWT。

执行优化：同一会话内只检查一次 Node.js 和运行环境状态；仅在 Node.js、Rainskills、PATH 或唯一运行环境发生变化后失效。固定 launcher 和 argv 已在本 Skill 中，禁止读取、搜索或探测 `rainskills.js`，也禁止执行 `npm root -g`。

<!-- rainskills-runtime-routing:start -->
## 缺少运行环境时

先说：“可以，我会帮你从模板安装应用。不过目前还没有可用的应用运行环境。你刚安装的 Rainskills 是 AI 部署助手，它负责分析项目并执行部署；应用实际会运行在 Rainbond 上。Rainbond 是一套应用运行和管理平台，负责源码构建、容器运行、域名访问、日志和存储等工作，你不需要了解 Kubernetes。”

先根据 `install_scope` 确认 scope，确认前不展示环境选项：`new-app` 使用 new scope，`existing-app` 使用 existing scope。

### 新应用

#### 选择运行环境

请提示“请选择应用要运行的环境：”，并只显示：

1) 云端环境（免费体验）
2) 本机环境
3) 独立服务器
4) 已有 Rainbond

选择 1 时执行 `saas` route；选择 2 时执行 `install-private` route，并使用 `["--location", "local"]`；选择 3 时执行 `install-private` route，并使用 `["--location", "server"]`；选择 4 时执行本地 launcher + `["runtime", "message", "--id", "private-console-origin"]`，收到地址后执行 `private-existing`。不得显示“私有环境”或部署位置中间层，不得重复询问部署位置，也不得在环境准备完成前询问应用来源。

### 已有应用

已有应用的 template-install intent 不得进入 install-private：只让用户选择 Rainbond Cloud 或承载目标应用的已有私有 Rainbond；选择已有私有 Rainbond 时执行本地 launcher + `["runtime", "message", "--id", "private-console-origin"]` 并原样输出。已有应用不得安装新平台。
<!-- rainskills-runtime-routing:end -->

## Overview

Use this skill to install a Rainbond application template into a target app.

This skill is for the **template installation workflow**, not generic component bootstrap.

It should:
1. determine whether the user wants a local template or a cloud market template
2. query the correct template source
3. query available versions
4. ensure a target app exists
5. install the selected template into that app
6. return a structured result with what was installed

This skill is the correct execution path when a component or app is sourced from a template-install flow.

## Canonical Model Reference

Use [product object model](../rainbond-app-assistant/references/product-object-model.md) as the repository-level source of truth for:

- `ComponentSource.kind = template`
- `template_install` as a handoff path rather than bootstrap execution
- the boundary between template-install intent, deployment planning, and downstream runtime/delivery stages

This skill should describe how template-install intent is executed through MCP. It should not redefine the canonical object boundaries independently.

## When to Use

Use when:
- the user wants to install an app from a local template market
- the user wants to install an app from a cloud market
- a `template` source in project design should be translated into actual Rainbond installation steps
- the system must query template versions before installation
- the user wants to add a template-based app into an existing target app

Do not use when:
- the task is to create components directly from image or source
- the task is runtime troubleshooting
- the template source or target app context is completely unknown and cannot be resolved
- the user wants only template discovery without installation

## Preferred MCP Tools

Prefer this tool chain:
- `rainbond_query_cloud_markets`
- `rainbond_query_local_app_models`
- `rainbond_query_cloud_app_models`
- `rainbond_query_app_model_versions`
- `rainbond_create_app`
- `rainbond_install_app_model`

Avoid preferring:
- `rainbond_install_app_by_market`

Reason:
- the new chain separates discovery, version selection, target-app creation, and install more clearly
- `rainbond_install_app_model` supports both local and cloud flows

## Input Resolution

Resolve values in this order:
1. user explicit input
2. `.rainbond/local.json`
3. `rainbond.app.json`

Required installation context:
- `team_name`
- `region_name`
- target `app_id` or enough information to create a target app. At every Rainbond Tool boundary, normalize a decimal session string to a positive integer; reject non-numeric IDs.
- template source:
  - `local`
  - `cloud`

Required template identity:
- `app_model_id`
- `app_model_version`

Additional required value when `source = cloud`:
- `market_name`

## Source Types

### 1. Local template
Use:
- `rainbond_query_local_app_models`
- `rainbond_query_app_model_versions`
- `rainbond_install_app_model`

### 2. Cloud template
Use:
- `rainbond_query_cloud_markets`
- `rainbond_query_cloud_app_models`
- `rainbond_query_app_model_versions`
- `rainbond_install_app_model`

## Workflow

Follow this order.

1. Resolve target app context
- determine `team_name` and `region_name`
- determine whether a target `app_id` already exists
- if no target app exists, create one with `rainbond_create_app`

2. Resolve template source
- if the user explicitly said local or cloud, use that
- if not explicit and the template source is ambiguous, ask the user or inspect available context

3. Discover template
- for `cloud`:
  - query cloud markets if `market_name` is not yet known
  - query cloud app models
- for `local`:
  - query local app models

4. Resolve version
- query template versions
- if the user explicitly named a version, use it
- if exactly one version exists, use it
- if multiple versions exist and the user did not choose, prefer the latest stable-looking version and state that choice clearly

5. Install
- call `rainbond_install_app_model`
- pass:
  - `team_name`
  - `region_name`
  - `app_id`
  - `source`
  - `market_name` when cloud
  - `app_model_id`
  - `app_model_version`
  - `is_deploy = true` unless the user explicitly wants otherwise

6. Report
- confirm whether installation succeeded
- list target app
- summarize installed services

## App Creation Rules

If no target app exists:
- create one first using `rainbond_create_app`
- prefer the minimum safe parameters
- do not pass `k8s_app` unless the user explicitly asks for a custom application English name

Reason:
- `k8s_app` is optional
- passing it incorrectly can cause validation or duplication errors

### App name collision during creation

When `rainbond_create_app` fails because the target app name already exists
(error contains `应用名称已存在`, `app name exists`, `duplicate`, `already exists`,
or any equivalent name-conflict signal):

The user's original intent was a **new target app**, not "reuse whatever app
exists in the team". Preserve that intent by auto-retrying with a numeric
suffix instead of stopping or grabbing an unrelated app.

Default recovery:
1. Retry `rainbond_create_app` with a numeric suffix: first `<original-name>-2`,
   then `-3`, `-4` if those also collide. Stop after 3 suffix attempts.
2. On success, proceed with `rainbond_install_app_model` against the new app
   and **explicitly mention the rename in the final report** so the user can
   override:
   > `pinpoint-apm` 已被占用，已用 `pinpoint-apm-2` 创建新应用。如需复用现有
   > `pinpoint-apm` 应用，请告知。
3. If 3 suffix attempts all collide, then pause and ask the user — at that
   point the namespace is genuinely contested and a human decision is warranted.

Hard prohibitions (regardless of recovery path):
- never silently install into an existing app whose name does not match the
  user's original intent (e.g. requested `pinpoint-apm` → installing into
  `big-screen-vue-datav`). This violates user intent and is forbidden.
- never list team apps and "pick a reasonable one" as a substitute for the
  intended new app.
- never treat "an app with this name exists" as equivalent to "the user wants
  to reuse that app" without explicit user confirmation.

The user may still choose to reuse the existing same-name app — but only when
they explicitly say so, not as a silent fallback.

## Version Selection Rules

If version is missing:
- never install blindly without checking versions first
- query versions first

Selection policy:
- user-specified version wins
- if only one version exists, use it
- if multiple versions exist, choose the latest stable-looking version and say so explicitly

## Error Handling Rules

### Invalid `source`
Only allow:
- `local`
- `cloud`

### Missing `market_name` for cloud source
- query cloud markets first
- then resolve and retry

### Missing target app
- create it first

### App name conflict on create
- see `App Creation Rules > App name collision during creation`
- default: auto-retry with `-2`, `-3`, `-4` suffix and mention the rename in the report
- never substitute an unrelated existing app
- pause for user choice only after 3 suffix attempts all collide

### Installation fails
Before concluding the template is unavailable, verify:
- `team_name`
- `region_name`
- `app_id`
- `source`
- `market_name` when cloud
- `app_model_id`
- `app_model_version`

## Output Format

Target structured output（仅在用户或自动化/评测明确要求结构化结果时使用）：

- this skill should eventually be able to emit `TemplateInstallResult`
- minimum target fields:
  - `template_install_intent`
  - `install_status`
  - `services_summary`
  - `next_action`
- the human-readable sections below should be treated as the narrative view over that target object
- in explicit structured contract mode, append a final `### Structured Output` section after the human-readable report and render `TemplateInstallResult` in fenced `yaml`

Proposed schema:

```yaml
TemplateInstallResult:
  template_install_intent:
    source: local | cloud
    market_name: string | null
    app_model_id: string
    app_model_version: string
    version_selection_reason: user_choice | single_version | latest_stable
    target_app:
      team_name: string
      region_name: string
      app_id: positive integer
      app_reused: boolean
  install_status: pending | success | failed
  services_summary: string[]
  next_action: stop | review_installed_services | run_troubleshooter | resolve_missing_template_metadata
```

Example object:

```yaml
TemplateInstallResult:
  template_install_intent:
    source: cloud
    market_name: official-market
    app_model_id: model-123
    app_model_version: 1.0.3
    version_selection_reason: latest_stable
    target_app:
      team_name: rainbond-demo
      region_name: singapore
      app_id: 88
      app_reused: true
  install_status: success
  services_summary:
    - postgres
    - api
    - web
  next_action: run_troubleshooter
```

Example final reply:

````markdown
### Template Source
Installation source is `cloud`, `market_name` is `official-market`.

### Resolved Template
`app_model_id` model-123, `app_model_version` 1.0.3, version selection reason `latest_stable`.

### Target App
`team_name` rainbond-demo, `region_name` singapore, `app_id` 88, target app was reused.

### Install Result
Install succeeded. Installed services: `postgres`, `api`, `web`.

### Next Step
run troubleshooter

### Structured Output
```yaml
TemplateInstallResult:
  template_install_intent:
    source: cloud
    market_name: official-market
    app_model_id: model-123
    app_model_version: 1.0.3
    version_selection_reason: latest_stable
    target_app:
      team_name: rainbond-demo
      region_name: singapore
      app_id: 88
      app_reused: true
  install_status: success
  services_summary:
    - postgres
    - api
    - web
  next_action: run_troubleshooter
```
````

Only in explicit structured contract mode, respond using exactly these sections:

### Template Source
- state whether installation is from `local` or `cloud`
- include `market_name` when relevant

### Resolved Template
- state `app_model_id`
- state `app_model_version`
- state how the version was chosen

### Target App
- state `team_name`
- state `region_name`
- state `app_id`
- state whether the app was reused or created

### Install Result
- state whether install succeeded
- include `installed` or equivalent result
- summarize installed services if available

### Next Step
- one of:
  - `stop, install complete`
  - `review installed services`
  - `run troubleshooter`
  - `resolve missing template metadata`

### Structured Output
- append a fenced `yaml` block
- render `TemplateInstallResult`
- keep enum values and field names aligned with the schema above
- include `app_reused` and template version resolution details when known

## Common Mistakes

- using `rainbond_install_app_by_market` when the newer template-install chain is available
- installing without checking versions first
- forgetting `market_name` for cloud templates
- creating a target app but then not reusing its `app_id`
- passing `k8s_app` by default
- treating template installation as the same thing as component bootstrap
- on app-name collision, silently picking an unrelated existing app from the
  team list (e.g. requested `pinpoint-apm` exists → assistant installs into
  `big-screen-vue-datav` instead). This violates user intent and must never
  happen — auto-retry with suffix instead. See the collision handling rules above.
- on app-name collision, immediately pausing to ask the user which of 4 options
  they want. This is also wrong — silent retry with `-2/-3/-4` and a clear
  rename notice in the report is the default; only pause after 3 suffix
  attempts all collide.

## Quick Reference

Cloud flow:
1. query cloud markets
2. query cloud app models
3. query versions
4. create app if needed
5. install

Local flow:
1. query local app models
2. query versions
3. create app if needed
4. install

Current install MCP:
- `rainbond_install_app_model`
