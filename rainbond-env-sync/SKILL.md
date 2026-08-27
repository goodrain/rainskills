---
name: rainbond-env-sync
description: "Use when a user explicitly asks to sync non-sensitive preview or production environment overrides for a linked Rainbond project into local env files. Trigger phrases include: 同步生产环境配置到本地 / 同步预览环境配置到本地 / sync environment overrides."
---

# Rainbond Env Sync

## 用户可见结果协议（最高优先级）

普通用户回复默认使用简洁中文，只说明同步的环境、更新的本地文件、保留或跳过的配置类别，以及唯一下一步。内部同步结果对象仍可用于校验，但不直接展示。

- 成功时说明哪个环境文件已更新，以及哪些非敏感配置发生了变化。
- 未完成时说明直接原因；不得为了完整报告而回显运行时元数据或敏感值。
- 默认不得展示内部对象、状态枚举、team/region/app ID、Skill/工具名、YAML、JSON 或英文编排标题。
- 只有用户明确要求 YAML、JSON、调试详情，或自动化/评测明确要求结构化契约时，才使用后文的结构化输出格式。

<!-- rainskills-runtime-gate:start -->
## 单运行环境 CLI 门禁（最高优先级）

本机只允许连接一个 Rainbond 运行环境。当前 Skill 在本会话第一次调用 Rainbond 前，执行固定 launcher 的 `runtime status --json`。返回 `connected` 且 `usable=true` 后，所有查询和变更直接通过本地 `~/.rainbond/bin/rainskills-tools.js` 执行。不得配置或直接调用客户端 MCP，不得执行环境枚举或业务 operation 生命周期命令，也不得生成或传递运行环境 ID、业务 operation ID 或 intent JSON。

没有运行环境时，让用户选择 Rainbond Cloud 或一个已有/新建的私有 Rainbond，并执行对应的 `runtime connect`。连接和重新授权必须进入浏览器 Device Flow，不复用 Shell 中缓存的 JWT；新凭据通过 live probe 后才覆盖唯一运行环境。CLI 返回 401 时，只读调用可在 `runtime reconnect` 成功后重试一次；写调用不得自动重放，必须先查询平台真实状态。403 直接停止，不重新授权。

授权命令是同步门禁。执行工具返回“进程仍在运行”或会话 ID 时，必须只等待或轮询同一个命令会话；在该会话结束前，禁止读取专项 Skill、解析 context、调用业务 CLI 或执行任何后续业务步骤。浏览器页面显示成功不代表连接完成；只有原命令退出码为 0，并输出 `rainskills.runtime-connect-result.v1` 且 `state=connected`，才可继续。不得另起 `runtime status` 猜测完成，也不得重复提示用户授权。

Codex 中命令工具一旦返回 `session_id`，必须立即对该 `session_id` 反复调用 `write_stdin`（空输入轮询），直到工具返回 `exit_code`。连接器输出 `[RAINSKILLS_AGENT_WAIT_REQUIRED:runtime-connect]` 后进入上述轮询；看到 `[RAINSKILLS_AGENT_WAIT_COMPLETE:runtime-connect]` 后仍须继续轮询，直到取得退出码和最终 JSON。

`context resolve` 是无状态调用：单一工作空间直接返回上下文，多个候选返回组合选项；用户选择后由当前任务直接携带 team/region 参数，不执行 `context select`，不写本地 operation。所有可变 `call` 仍需先取得 confirmation ID，再以完全相同的输入追加 `--confirm` 执行一次。

`required` 只声明要解析的维度，企业 ID 始终来自当前登录身份。用户明确给出的 team/region 必须放进 `hints` 做精确匹配；不得把企业名、team 名或选择对象作为顶层 `enterprise` / `workspace` 字段传入。多候选时只展示 CLI 返回的 label；用户选择后再次执行同一个无状态 `context resolve`，通过 `selection.option_id` 让 CLI 重新查询并验证当前候选，不写本地 context 状态。

```json
{
  "schema": "rainskills.single-runtime-contract.v1",
  "package_version": "rainskills@0.1.27",
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
        "rainbond-env-sync"
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
        "rainbond-env-sync"
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
        "rainbond-env-sync"
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
        "rainbond-env-sync",
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

先说：“可以，我会帮你同步已有应用的环境配置。不过目前还没有可用的应用运行环境。你刚安装的 Rainskills 是 AI 部署助手；应用实际运行在 Rainbond 上。Rainbond 是一套应用运行和管理平台，你不需要了解 Kubernetes。”

只让用户选择 `Rainbond Cloud` 或承载目标应用的`已有私有 Rainbond`。选择已有私有 Rainbond 时执行本地 launcher + `["runtime", "message", "--id", "private-console-origin"]` 并原样输出。不得为环境同步安装私有 Rainbond，也不得用新平台代替原应用。
<!-- rainskills-runtime-routing:end -->

## Overview

Use this skill to synchronize **non-sensitive environment override intent** from a linked Rainbond application into local project files.

This skill does **not** replace live runtime inspection. It maintains local environment reference files so future bootstrap, release, and troubleshooting flows need fewer manual inputs.

The goal is to:
1. resolve the linked Rainbond project
2. select the target environment (`preview` or `production`)
3. query current component env state from Rainbond MCP
4. keep only **non-sensitive values that differ from the project baseline**
5. treat provider connection envs and dependency-injected connection values as runtime connection metadata and skip them
6. write the result into `.rainbond/env.preview.json` or `.rainbond/env.prod.json`

## Canonical Model Reference

Use [product object model](../rainbond-app-assistant/references/product-object-model.md) as the repository-level source of truth for:

- the `Environment` object boundary
- `.rainbond/env.<env>.json` as a non-sensitive delta projection
- `.rainbond/secrets.<env>.json` as the separate secret layer that must not be merged into env-sync output

This skill should describe how environment intent is synchronized locally. It should not redefine the canonical projection boundaries independently.

## When to Use

Use when:
- a linked project needs a local preview or production env snapshot
- local env files are missing, stale, or intentionally being refreshed
- bootstrap or troubleshooting should rely less on repeated manual parameters
- environment-specific overrides should be captured without storing secrets

Do not use when:
- the project is not yet linked
- the task is to repair runtime issues directly
- the desired output is a live runtime status report rather than a local reference file
- the goal is to persist passwords, tokens, certificates, or private keys

## Scope

This skill manages only:
- `.rainbond/env.preview.json`
- `.rainbond/env.prod.json`

This skill reads context from:
- `rainbond.app.json`
- `.rainbond/local.json`
- user explicit input

This skill trusts for runtime facts only:
- Rainbond MCP responses

This skill writes only:
- project identity fields
- non-sensitive **environment deltas** relative to `rainbond.app.json`
- sync metadata

## Configuration Priority

Resolve context in this order:

1. **Highest priority**: user explicit input for the current sync
2. **Project binding context**: `.rainbond/local.json`
3. **Lowest priority**: `rainbond.app.json` as the project baseline

Rules:
- environment selection: explicit input > `.rainbond/local.json.preferences.default_environment` > `preview`
- app identity: explicit input > `.rainbond/local.json.binding` > `rainbond.app.json.project`
- runtime env facts: Rainbond MCP only
- if local files disagree with MCP, trust MCP and report the drift

## Output File Model

Expected target files:
- `.rainbond/env.preview.json`
- `.rainbond/env.prod.json`

Recommended structure:

```json
{
  "schema_version": 1,
  "environment": "preview",
  "project": {
    "team_name": "xzlgdo9u",
    "region_name": "rainbond",
    "app_name": "fullstack-demo-v2",
    "app_id": 20
  },
  "component_env_overrides": {
    "api": {
      "env": {
        "NODE_ENV": "preview",
        "ENABLE_BETA": "true"
      }
    }
  },
  "synced_at": "2026-04-01T14:30:00Z",
  "metadata": {
    "status": "synced",
    "synced_by": "Claude Code"
  }
}
```

## Keep vs Skip Rules

### Keep

Keep a value only if it is:
- non-sensitive
- clearly consumed by the application or deployment model
- stable enough to be useful across future runs
- **different from the baseline value in `rainbond.app.json`**

Examples:
- `NODE_ENV=preview`
- a consumer-local feature flag such as `ENABLE_BETA=true`
- a frontend API base URL only if it differs from baseline

### Skip

Do not persist:
- passwords
- tokens
- certificates
- private keys
- usernames tied to secrets
- platform runtime metadata
- provider connection envs
- dependency-injected connection values
- auto-generated helper variables
- values that are identical to the baseline manifest

Examples to skip:
- `*_PASSWORD`
- `*_TOKEN`
- `*_KEY`
- `DB_HOST`
- `DB_PORT`
- `DB_USER`
- `DB_PASS`
- `DB_NAME`
- `REDIS_PASSWORD`
- `KAFKA_BROKERS`
- `PORT*_HOST`
- `PORT*_PORT`
- `API_HOST`
- `API_PORT`

### Important Distinction

This skill stores **environment override intent**, not a raw runtime dump.

Provider connection envs and dependency-derived runtime connection values are always treated as **runtime connection metadata**, even when they differ from `rainbond.app.json` or from older local env files.

Examples of runtime connection metadata that must always be skipped:
- `DB_HOST`
- `DB_PORT`
- `DB_USER`
- `DB_PASS`
- `DB_NAME`
- `REDIS_PASSWORD`
- `KAFKA_BROKERS`
- `PORT*_HOST`
- `PORT*_PORT`
- `API_HOST`
- `API_PORT`

If a value is:
- ephemeral
- auto-generated by the platform
- only useful at runtime
- a dependency-derived runtime connection coordinate
- a provider connection env intended to be injected into dependents
- identical to `rainbond.app.json`
- not something a human should maintain

then skip it.

## Workflow

Follow this order.

### Fixed Tool fast path and conflict gate

Read `rainbond_query_components`, `rainbond_manage_component_envs(operation=summary)`, and `rainbond_manage_component_connection_envs(operation=summary)` for the requested components. Before any write, call `rainbond_analyze_env_conflicts`; if it reports a conflict, stop and show only non-sensitive key names. Do not overwrite automatically and do not run `list` or `describe` to discover known Tools.

1. Resolve context
- read user explicit target environment if provided
- read `.rainbond/local.json`
- read `rainbond.app.json` as baseline
- determine:
  - `team_name`
  - `region_name`
  - `app_name`
  - `app_id`
  - target environment file

2. Validate link state
- if `.rainbond/local.json` is missing or `metadata.status != linked`, stop and tell the user to link first
- do not guess `app_id`

3. Query Rainbond runtime state
- query app detail
- query component list
- identify components from MCP data first
- use local files only as hints for naming and roles

4. Gather env candidates
For each relevant component:
- inspect current envs and connection envs from Rainbond MCP
- compare with project baseline in `rainbond.app.json`
- identify values that represent meaningful non-sensitive overrides
- classify provider connection envs and dependency-injected connection values as runtime connection metadata before delta evaluation

5. Filter values
- keep only values that satisfy the Keep rules
- remove platform runtime metadata
- remove provider connection envs and dependency-injected connection values even when they differ from baseline
- skip all sensitive values
- skip values that are identical to the baseline manifest
- if unsure, prefer skipping and explain why

6. Write target file
- update:
  - `schema_version`
  - `environment`
  - `project`
  - `component_env_overrides`
  - `synced_at`
  - `metadata.status = synced`
  - `metadata.synced_by`

7. Report result
- summarize what was kept as deltas
- summarize what was removed as runtime metadata
- summarize what was skipped as sensitive
- summarize what was skipped because it matched baseline
- note any detected drift between local files and Rainbond runtime state

## Drift Reporting

If Rainbond runtime differs from local files:
- trust MCP
- update the env file based on MCP-derived, filtered values
- explicitly report the drift in output

Examples:
- local app name differs from bound app
- expected override key differs from deployed override key
- local config references a component name that no longer matches runtime

## Verification Standard

A sync is successful when:
- the target environment file exists
- project identity fields are correct
- non-sensitive, durable deltas are captured
- sensitive values are omitted
- runtime metadata noise is omitted
- values identical to baseline are omitted
- sync metadata is updated

A sync is **not** required to:
- prove app health
- repair runtime problems
- ensure preview and production files are identical

## Output Format

Target structured output（仅在用户或自动化/评测明确要求结构化结果时使用）：

- this skill should eventually be able to emit an `Environment`-centered sync result
- minimum target fields:
  - `environment`
  - `project`
  - `env_delta`
  - `skip_reasons`
  - `next_action`
- the human-readable sections below should be treated as the narrative view over that target object
- in explicit structured contract mode, append a final `### Structured Output` section after the human-readable report and render the sync result object in fenced `yaml`

Proposed schema:

```yaml
EnvironmentSyncResult:
  environment:
    name: preview | production
    source: explicit | local_preference | default
  project:
    team_name: string
    region_name: string
    app_name: string
    app_id: positive integer | null # normalize a decimal session string at every Rainbond Tool boundary; reject non-numeric IDs
  env_delta:
    component_env_overrides: map
  skip_reasons:
    sensitive: string[]
    runtime_metadata: string[]
    baseline_match: string[]
    ambiguous: string[]
  synced_at: string
  metadata:
    status: synced | drifted | unlinked
    synced_by: string
  next_action: string
```

Example object:

```json
{
  "environment": {
    "name": "preview",
    "source": "local_preference"
  },
  "project": {
    "team_name": "xzlgdo9u",
    "region_name": "rainbond",
    "app_name": "fullstack-demo-v2",
    "app_id": 20
  },
  "env_delta": {
    "component_env_overrides": {
      "api": {
        "env": {
          "NODE_ENV": "preview",
          "ENABLE_BETA": "true"
        }
      }
    }
  },
  "skip_reasons": {
    "sensitive": ["DB_PASSWORD"],
    "runtime_metadata": ["DB_HOST", "DB_NAME", "API_PORT"],
    "baseline_match": ["TZ"],
    "ambiguous": []
  },
  "synced_at": "2026-04-14T03:55:00Z",
  "metadata": {
    "status": "synced",
    "synced_by": "env-sync v1"
  },
  "next_action": "bootstrap"
}
```

Example final reply:

````markdown
### Sync Result
Sync succeeded and updated `.rainbond/env.preview.json`.

### Resolved Project
`team_name` xzlgdo9u, `region_name` rainbond, `app_name` fullstack-demo-v2, `app_id` 20, selected environment `preview`.

### Captured Overrides
- `api`: kept `NODE_ENV=preview` and `ENABLE_BETA=true`.
- `web`: kept `API_BASE_URL=https://preview.example.com/api`.

### Skipped Values
- sensitive values: `DB_PASSWORD`
- runtime metadata: `DB_HOST`, `DB_NAME`, `API_PORT`
- values skipped because they matched baseline: `TZ`
- ambiguous values intentionally not persisted: `none`

### Next Step
bootstrap

### Structured Output
```yaml
EnvironmentSyncResult:
  environment:
    name: preview
    source: local_preference
  project:
    team_name: xzlgdo9u
    region_name: rainbond
    app_name: fullstack-demo-v2
    app_id: 20
  env_delta:
    component_env_overrides:
      api:
        env:
          NODE_ENV: preview
          ENABLE_BETA: "true"
      web:
        env:
          API_BASE_URL: https://preview.example.com/api
  skip_reasons:
    sensitive:
      - DB_PASSWORD
    runtime_metadata:
      - DB_HOST
      - DB_NAME
      - API_PORT
    baseline_match:
      - TZ
    ambiguous: []
  synced_at: "2026-04-14T03:55:00Z"
  metadata:
    status: synced
    synced_by: env-sync v1
  next_action: bootstrap
```
````

Only in explicit structured contract mode, respond using exactly these sections:

### Sync Result
- state whether the sync succeeded
- state which environment file was updated

### Resolved Project
- state `team_name`, `region_name`, `app_name`, `app_id`
- state which environment was selected

### Captured Overrides
- list kept values by component
- show only non-sensitive values that differ from baseline

### Skipped Values
Split into:
- sensitive values
- runtime metadata
- values skipped because they matched baseline
- ambiguous values intentionally not persisted

### Next Step
- suggest the most appropriate next action
- examples:
  - bootstrap
  - troubleshooter
  - production sync
  - drift review

### Structured Output
- append a fenced `yaml` block
- render `EnvironmentSyncResult`
- keep enum values and field names aligned with the schema above
- never include secrets in the structured object

## Common Mistakes

- treating env sync as a runtime health check
- persisting passwords or tokens
- dumping all runtime env vars into the file
- keeping platform-generated connection metadata
- copying baseline values into the env file
- guessing app identity when the project is not linked
- using local files as runtime truth when MCP says otherwise

## Quick Reference

Priority summary:
1. explicit input
2. `.rainbond/local.json`
3. `rainbond.app.json`
4. runtime truth from MCP only

Keep:
- durable, non-sensitive, app-meaningful deltas relative to baseline

Skip:
- secrets
- certs
- keys
- passwords
- usernames tied to secrets
- platform runtime metadata
- provider connection envs and dependency-injected connection values (`DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASS`, `DB_NAME`, `REDIS_PASSWORD`, `KAFKA_BROKERS`, `PORT*_HOST`, `PORT*_PORT`, `API_HOST`, `API_PORT`)
- any value identical to `rainbond.app.json`

Typical next actions after sync:
- run `rainbond-fullstack-bootstrap`
- run `rainbond-fullstack-troubleshooter`
- sync production env
- compare preview vs production overrides
