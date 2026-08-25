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
## 运行环境门禁（最高优先级）

### CLI 调用格式（强制）

所有可变 `call` 都必须使用完整 argv：`call <tool> --input - --operation-id <uuid> --skill-id rainbond-delivery-verifier`。CLI 返回确认 ID 后，只能在同一 argv 末尾加入 `--confirm <confirmation-id>`；不得省略 `--skill-id`、猜测参数，或根据泛化错误反复重试。

### 多运行环境操作契约

  Node.js 前置检查通过后，每次请求先执行本地 launcher + `["environment", "list", "--json"]`，按用户明确指定的运行环境选择不可变环境 ID；未指定时只用全局默认环境，默认不可用时停止且不回退。生成 UUID 后执行本地 launcher + `["operation", "begin", "--operation-id", "<uuid>", "--environment-id", "<id>", "--intent-json", "<intent-json>"]`，并在之后每个 Rainbond MCP 调用中加入 `rainskills_operation_id`。环境、团队和应用只属于本次操作，禁止保存项目绑定；同一项目可以部署到多个环境。明确“团队”表示环境内团队；明确“运行环境/平台”表示环境；裸名称同时匹配环境和团队时必须询问。

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
    "delivery-verify": {"required": ["operation"], "optional": ["team_id", "app_id", "service_id"], "enums": {"operation": ["full", "runtime", "access"]}}
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

受限沙箱（包括 Codex）执行本地状态命令时，必须申请用户级受保护目录访问权限；在 Codex 中使用 `require_escalated`。不得修改 `~/.rainbond` 权限、复制受保护状态到工作区，或因沙箱权限错误建议重装。

执行优化：同一会话内只检查一次 Node.js（首次使用本地 CLI 前）；仅在 Node.js 或 Rainskills 安装、升级，或 PATH 变更后失效。固定 launcher 和 argv 已在本 Skill 中，禁止读取、搜索或探测 `rainskills.js`，也禁止执行 `npm root -g`。每个新的业务操作仍需要刷新一次环境列表；带已有 `operation_id` 或 `onboarding-id` 的续接复用已绑定的环境 ID，不重复枚举环境。

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
