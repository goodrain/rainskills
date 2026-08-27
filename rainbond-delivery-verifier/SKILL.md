---
name: rainbond-delivery-verifier
description: "Use only when the user explicitly asks for final delivery or access verification of an existing Rainbond app. Trigger phrases include: 只帮我确认当前应用是否已经交付成功，并给我访问地址 / verify delivery / confirm the access URL. Do not use for a generic current-project deployment request; route that to rainbond-app-assistant."
---

# Rainbond Delivery Verifier

<!-- rainskills-user-result:start -->
## 用户可见结果协议（最高优先级）

普通用户部署或交付验证的最终回复必须保持简短、中文。内部可以维护 `DeliveryVerificationResult`，但不得默认把内部验收格式直接展示给用户。

部署成功时按下面的内容输出。所有名称和地址必须来自本轮真实返回值；某项无法确认时省略该项，不得猜测或推测：

```text
部署成功。

- 项目：<用户项目名称>
- 运行环境：<本次实际使用的运行环境名称>
- 工作空间：<本次实际部署到的 Rainbond 工作空间名称>
- 应用：<创建或使用的 Rainbond 应用名称>
- 运行环境地址：<Rainbond Console 或应用管理页面地址>
- 应用访问地址：<部署完成后真实可访问的应用地址>
- 已完成操作：<用一句话概括本轮实际完成的项目识别、应用创建、组件构建、启动和访问验证；只列真实执行过的操作>
```

部署失败或未完成时只输出：

```text
部署失败。

失败原因：<用用户能理解的一句话说明直接原因>

解决办法：<确实存在安全、可执行的解决方案时才输出；没有就省略整项>
```

只有“解决办法”确实存在并且可执行时才输出该项。默认用户回复不得出现 `Problem Judgment`、`Actions Taken`、`Verification Result`、`Follow-up Advice`、`Structured Output` 等诊断标题；不得展示内部状态码、枚举、对象字段、YAML、JSON、工具调用记录或英文状态表。只有用户明确要求结构化结果，或者自动化/评测明确要求结构化契约时，才允许输出后文的结构化格式。
<!-- rainskills-user-result:end -->

<!-- rainskills-runtime-gate:start -->
## 单运行环境 CLI 门禁（最高优先级）

本机只允许连接一个 Rainbond 运行环境。当前 Skill 在本会话第一次调用 Rainbond 前，执行固定 launcher 的 `runtime status --json`。返回 `connected` 且 `usable=true` 后，所有查询和变更直接通过本地 `~/.rainbond/bin/rainskills-tools.js` 执行。不得配置或直接调用客户端 MCP，不得执行环境枚举或业务 operation 生命周期命令，也不得生成或传递运行环境 ID、业务 operation ID 或 intent JSON。

没有运行环境时，让用户选择 Rainbond Cloud 或一个已有/新建的私有 Rainbond，并执行对应的 `runtime connect`。连接和重新授权必须进入浏览器 Device Flow，不复用 Shell 中缓存的 JWT；新凭据通过 live probe 后才覆盖唯一运行环境。CLI 返回 401 时，只读调用可在 `runtime reconnect` 成功后重试一次；写调用不得自动重放，必须先查询平台真实状态。403 直接停止，不重新授权。

授权命令是同步门禁。执行工具返回“进程仍在运行”或会话 ID 时，必须只等待或轮询同一个命令会话；在该会话结束前，禁止读取专项 Skill、解析 context、调用业务 CLI 或执行任何后续业务步骤。浏览器页面显示成功不代表连接完成；只有原命令退出码为 0，并输出 `rainskills.runtime-connect-result.v1` 且 `state=connected`，才可继续。不得另起 `runtime status` 猜测完成，也不得重复提示用户授权。

Codex 中命令工具一旦返回 `session_id`，必须立即对该 `session_id` 反复调用 `write_stdin`（空输入轮询），直到工具返回 `exit_code`。连接器输出 `[RAINSKILLS_AGENT_WAIT_REQUIRED:runtime-connect]` 后进入上述轮询；看到 `[RAINSKILLS_AGENT_WAIT_COMPLETE:runtime-connect]` 后仍须继续轮询，直到取得退出码和最终 JSON。

固定 contract 中的 `<target>` 必须替换为当前宿主：Codex=`codex`、Claude Code=`claude`、Pi Agent=`pi`、DeepSeek Harness=`dsh`、WorkBuddy=`workbuddy`。DeepSeek Harness 和 WorkBuddy 若返回持久终端或后台任务句柄，只轮询该原始句柄直到进程退出，不另起状态命令推测完成。

`context resolve` 是无状态调用：单一工作空间直接返回上下文，多个候选返回组合选项；用户选择后由当前任务直接携带 team/region 参数，不执行 `context select`，不写本地 operation。所有可变 `call` 仍需先取得 confirmation ID，再以完全相同的输入追加 `--confirm` 执行一次。

`required` 只声明要解析的维度，企业 ID 始终来自当前登录身份。用户明确给出的 team/region 必须放进 `hints` 做精确匹配；不得把企业名、team 名或选择对象作为顶层 `enterprise` / `workspace` 字段传入。多候选时只展示 CLI 返回的 label；用户选择后再次执行同一个无状态 `context resolve`，通过 `selection.option_id` 让 CLI 重新查询并验证当前候选，不写本地 context 状态。

```json
{
  "schema": "rainskills.single-runtime-contract.v1",
  "package_version": "rainskills@0.1.29",
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
        "rainbond-delivery-verifier"
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
        "rainbond-delivery-verifier"
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
        "rainbond-delivery-verifier"
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
        "rainbond-delivery-verifier",
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

先说：“可以，我会帮你验证应用交付状态和访问地址。不过目前还没有可用的应用运行环境。你刚安装的 Rainskills 是 AI 部署助手；应用实际运行在 Rainbond 上。Rainbond 是一套应用运行和管理平台，你不需要了解 Kubernetes。”

只让用户选择 `Rainbond Cloud` 或承载目标应用的`已有私有 Rainbond`。选择已有私有 Rainbond 时执行本地 launcher + `["runtime", "message", "--id", "private-console-origin"]` 并原样输出。不得为交付验证安装私有 Rainbond，也不得用新平台代替原应用。
<!-- rainskills-runtime-routing:end -->

## Overview

Use this skill to perform the final delivery verification stage for a Rainbond application.

This skill is not responsible for creating or repairing resources. It is responsible for determining whether the app has actually converged and whether there is a usable access path.

The goal is to:
1. inspect final app and component runtime state
2. distinguish converged deployments from still-building or blocked ones
3. identify the user-facing access URL
4. perform the lightest safe verification possible
5. produce a final delivery report

## Canonical Model Reference

Use [product object model](../rainbond-app-assistant/references/product-object-model.md) as the repository-level source of truth for:

- `RuntimeState` versus `DeliveryState`
- shared component convergence labels and blocker buckets
- final delivery outcomes such as `delivered`, `delivered-but-needs-manual-validation`, `partially-delivered`, and `blocked`

This skill should evaluate and report delivery acceptance using those shared terms. It should not redefine canonical delivery-state boundaries independently.

For the current contract-convergence pass, the live delivery-verifier output contract is frozen by:
- [schemas/delivery-verification-result.schema.yaml](schemas/delivery-verification-result.schema.yaml)
- [scripts/validate_delivery_verifier_output.py](scripts/validate_delivery_verifier_output.py)
- [scripts/run_delivery_verifier_evals.py](scripts/run_delivery_verifier_evals.py)

## When to Use

Use when:
 - bootstrap, template install, or troubleshooting has already run
 - the next question is “did it really deploy successfully?”
 - the user needs the final access address
 - the workflow needs a delivery acceptance step

Do not use when:
 - the user gives a generic current-project deployment or continue-the-mainline request and delivery verification has not been reached yet; route that to `rainbond-app-assistant`
 - the app has not been created yet
 - runtime repair is still actively in progress
 - the system is clearly blocked on code/build handoff
- the task is to fix platform or app configuration rather than verify delivery

## Scope

This skill may:
- read app detail
- read component list
- read component summaries and details
- read component storage summaries for database and other stateful middleware components
- inspect recent logs and events if needed
- inspect access information
- report deployment convergence
- report the most appropriate user-facing access URL

This skill must not:
- perform destructive actions
- modify source code
- continue speculative repairs
- pretend delivery is complete when evidence is incomplete

## Verification Principles

### 1. Deployment convergence is not the same as component existence
Do not declare success only because components exist.

At minimum, distinguish:
- `building`
- `waiting`
- `running`
- `abnormal`
- `capacity-blocked`

### 2. Delivery completion is not the same as “all backend components running”
If the app is user-facing, final delivery requires a usable access path.

### 3. If evidence is incomplete, report partial completion
If an access URL exists but cannot be externally validated from the current environment, report:
- the access URL
- what was verified
- what still needs manual confirmation

### 4. Reverse-proxy full-stack delivery needs both the page path and the API path
If the app is a frontend + backend project and the frontend is expected to call the backend through the same host, do not treat a root-page URL alone as sufficient delivery proof.

Use current-run evidence such as:
- frontend access mode `reverse-proxy`
- frontend runtime env like `VITE_API_URL=/api`
- local project code or manifest hints that the frontend calls `/api`

In those cases:
- verify the preferred root URL for the frontend document path
- also verify the same host's backend path, typically `/api`
- if the frontend is served under a base prefix (e.g. `/system`), also verify the API path
  under that prefix (e.g. `/system/api`); `/api` succeeding alone does not prove the page's
  actual requests succeed
- if `/` works but `/api` returns 4xx/5xx, empty reply, placeholder page, or cloud-provider intercept page, do not classify the app as delivered
- classify the result as `blocked` unless a narrower partial state is better supported by evidence

### 5. Stateful delivery must not hide missing persistence
If the app includes a database or stateful middleware component:
- inspect its storage summary before final classification
- for common middleware images, expect a durable mount at the standard data directory such as Postgres `/var/lib/postgresql/data`, MySQL `/var/lib/mysql`, MongoDB `/data/db`, Redis `/data`, RabbitMQ `/var/lib/rabbitmq`, Kafka `/var/lib/kafka/data`, Elasticsearch/OpenSearch `/usr/share/elasticsearch/data`, or MinIO `/data`
- if no durable storage is mounted, do not silently report a clean `delivered` result
- if the user explicitly required durable data, classify delivery as `blocked` with blocker `stateful middleware persistence not configured`
- if the run is clearly only an ephemeral demo, report the missing persistence caveat in `Verification Result` and avoid wording that implies production-safe stateful middleware storage

### 6. Static frontend delivery has its own acceptance checklist
When the delivered app serves a built frontend (SPA or static site), verify beyond the
root page returning 200:
- the entry HTML actually contains the app shell, not a placeholder or directory listing
- JS/CSS assets return correct MIME types (not `text/html` from an SPA fallback)
- a deep link (any non-root route) returns the SPA fallback page instead of 404
- responses for large JS/CSS assets include `content-encoding: gzip` or `br`; if a single
  asset exceeds ~2 MB uncompressed and is served without compression, report it as a
  delivery caveat
- static assets carry a cache-control header

Report failed items as caveats or blockers depending on user impact; do not silently
pass a frontend that only returned a 200 on `/`.

### 7. Performance findings get layered recommendations, not a rewrite verdict
When verification surfaces a performance problem (oversized bundle, missing compression,
no caching), recommend in two layers:
1. deployment-layer mitigation first — enable gzip/br, add cache headers, adjust proxy
   config; low risk, no code change
2. code-layer fix second — code splitting, lazy loading, dependency dieting; hand off as
   code/build work
Never present a source-code refactor as the only path when a deployment-layer mitigation
exists.

## Workflow

Follow this order.

### Fixed Tool fast path

Call `rainbond_get_app_detail`, then `rainbond_get_app_health_overview` before per-component inspection. Use `rainbond_query_components` and component/storage summaries only for abnormal or unknown components. Do not run `list` or `describe` to discover these known Tool names.

1. Resolve app context
- determine `team_name`, `region_name`, `app_name`, and `app_id`
- prefer user input, then `.rainbond/local.json`

2. Read deployment state
- get app detail
- get component list
- get component summaries

3. Classify component convergence
For each important component, classify:
- `building`
- `waiting`
- `running`
- `abnormal`
- `capacity-blocked`

If recent events show:
- `Unschedulable`
- CPU or memory shortage

then classify that component as `capacity-blocked`.

4. Inspect stateful storage
- identify database and stateful middleware components from role, name, image, port, and dependency position
- read storage summaries for those components
- record whether durable storage is mounted at the component's data directory
- carry any missing-persistence finding into the final delivery report

5. Determine access target
Access URL selection priority:
1. frontend component access info
2. explicitly exposed service access info
3. component detail access info
4. if none exist, report “no external access URL available”

When reverse-proxy full-stack behavior is expected:
- keep the preferred root URL as the candidate user-facing URL
- also derive an API verification path on the same host, usually `/api`
- do not switch to the backend component's direct URL as the preferred user-facing URL unless the app is actually backend-only

6. Verify user-facing path as far as safely possible
- if an access URL is available and safe to inspect, check whether the route appears reachable
- if reverse-proxy full-stack behavior is expected, check both the root path and the API path on the same host
- if the root path returns HTML but the API path fails, returns a provider intercept page, or routes to the wrong upstream, treat delivery as not complete
- if current environment cannot directly verify the external URL, do not fake success
- report the final delivery outcome as `delivered-but-needs-manual-validation`
- when the app serves a built frontend, run the static frontend checklist from
  Verification Principle 6 as far as the current environment allows, and record
  unverifiable items as manual-confirmation leftovers

7. Produce final delivery report

## Final Status Model

Use one of these final outcomes:

- `delivered`
  - all critical components converged
  - user-facing access path is verified

- `delivered-but-needs-manual-validation`
  - app appears converged
  - access URL is known
  - but external user path was not directly verified

- `partially-delivered`
  - topology exists
  - some components running
  - but one or more critical components are still building, waiting, or abnormal

- `blocked`
  - cluster capacity blocked
  - build failed
  - external artifact or registry download remains unreachable
  - runtime remains unhealthy
  - no usable access path exists
  - root path and same-host API path do not both work for a reverse-proxy full-stack app

## Output Format

Target structured output（仅在用户或自动化明确要求结构化结果时使用）：

- this skill must emit `DeliveryVerificationResult`
- minimum target fields:
  - `runtime_state`
  - `delivery_state`
  - `preferred_access_url`
  - `verification_mode`
  - `blocker`
  - `next_action`
- the human-readable sections below should be treated as the narrative view over that target object
- 在明确结构化模式中追加最终 `### Structured Output` section，并用 fenced `yaml` 渲染 `DeliveryVerificationResult`
- the schema and validator under `schemas/` and `scripts/` are the current live contract

Current schema shape:

```yaml
DeliveryVerificationResult:
  runtime_state: topology_missing | topology_building | runtime_unhealthy | runtime_healthy | capacity_blocked | code_or_build_handoff_needed
  delivery_state: delivered | delivered-but-needs-manual-validation | partially-delivered | blocked
  preferred_access_url: string | null
  verification_mode: verified | inferred | manual_validation_needed
  blocker: string | null
  next_action: stop | manual_url_validation | run_troubleshooter | fix_cluster_capacity_first | code_build_handoff
```

Example object:

```json
{
  "runtime_state": "runtime_healthy",
  "delivery_state": "delivered-but-needs-manual-validation",
  "preferred_access_url": "https://example-team-cn.rainbond.me/my-app",
  "verification_mode": "inferred",
  "blocker": null,
  "next_action": "manual_url_validation"
}
```

Example final reply:

````markdown
### Deployment State
The overall delivery outcome is `delivered-but-needs-manual-validation` for app `my-app`, environment `preview`.

### Component Runtime
- `db status`: `running`
- `api/service status`: `running`
- `frontend status`: `running`
- `overall runtime status`: `runtime_healthy`

### Access URL
Preferred user-facing URL: `https://example-team-cn.rainbond.me/my-app`

### Verification Result
Verified MCP runtime convergence and resolved the best access URL. User-facing access was inferred rather than directly checked from the current environment, so manual validation is still needed.

### Next Step
manual URL validation

### Structured Output
```yaml
DeliveryVerificationResult:
  runtime_state: runtime_healthy
  delivery_state: delivered-but-needs-manual-validation
  preferred_access_url: https://example-team-cn.rainbond.me/my-app
  verification_mode: inferred
  blocker: null
  next_action: manual_url_validation
```
````

Only in explicit structured contract mode, respond using exactly these sections:

### Deployment State
- state the overall delivery outcome
- include `app_name` and selected environment
- do not include `team_name`, `region_name`, or `app_id` in prose; those are available in `### Structured Output` only

### Component Runtime
- report:
  - `db status`
  - `api/service status`
  - `frontend status`
  - `overall runtime status`

### Access URL
- provide the best user-facing URL if available
- if there are multiple candidate URLs, say which one is preferred
- if no URL exists, say so explicitly

### Verification Result
- state what was actually verified
- state whether user-facing access was verified, inferred, or still needs manual validation
- for apps with stateful middleware, state whether persistence was verified; if missing, report `stateful middleware persistence not configured`

### Next Step
- one of:
  - `stop, delivery complete`
  - `manual URL validation`
  - `run troubleshooter`
  - `fix cluster capacity first`
  - `handoff to code/build agent`

### Structured Output
- append a fenced `yaml` block
- render `DeliveryVerificationResult`
- keep enum values and field names aligned with the schema above
- prefer `manual_validation_needed` over ad hoc wording in the structured object
- for `blocked`, include a non-null `blocker`

## Common Mistakes

- declaring delivery complete while components are still building
- treating `running` as equivalent to “user can access it”
- failing to report access URL explicitly
- hiding cluster capacity blockers inside generic unhealthy status
- continuing repairs when the right next step is manual URL validation
- treating a reverse-proxy frontend root URL as delivered when the same-host `/api` path is still broken
- counting a cloud-provider intercept page or placeholder page as successful app delivery
- reporting an app with stateful middleware as cleanly delivered without checking storage persistence

## Quick Reference

Delivery checks:
1. app detail
2. component summaries
3. recent events/logs if needed
4. access info
5. final delivery report

Final truth rules:
- MCP gives runtime truth
- access URL must be explicitly reported
- if external validation is not possible, use the final outcome `delivered-but-needs-manual-validation`
