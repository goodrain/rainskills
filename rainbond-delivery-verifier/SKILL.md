---
name: rainbond-delivery-verifier
description: "Use only when the user explicitly asks for final delivery or access verification of an existing Rainbond app. Trigger phrases include: 只帮我确认当前应用是否已经交付成功，并给我访问地址 / verify delivery / confirm the access URL. Do not use for a generic current-project deployment request; route that to rainbond-app-assistant."
---

# Rainbond Delivery Verifier

<!-- rainskills-runtime-gate:start -->
## 运行环境门禁（最高优先级）

第一步检查 Node.js 是否存在且主版本不低于 18。Node.js 缺失或低于 18 时，只说明“Rainskills 执行组件需要 Node.js 18 或更高版本”并停止：不选择运行环境，不调用 MCP，不猜测替代命令。只有用户或 agent 明确同意后才安装或升级 Node.js，再从同一原始 intent 继续。

固定 launcher 是 `["npx", "--yes", "rainskills@0.1.0-rc.60"]`；版本必须与本技能包 `package.json` 一致。把 launcher 与参数拼成 argv 数组直接执行，禁止 `rainskills@latest` 或执行 shell 字符串。

前置检查通过后先执行 launcher + `["runtime", "status", "--json"]`，先于任何业务 MCP。`not_started` 不能因历史 MCP 跳过；只有 `connected`、`usable = true` 且本次 live probe 成功才继续，探针失败必须 reconnect。

<!-- rainskills-runtime-contract:start -->
```json
{
  "schema": "rainskills.skill-runtime-contract.v1",
  "launcher": ["npx", "--yes", "rainskills@0.1.0-rc.60"],
  "intents": {
    "delivery-verify": {"required": ["operation"], "optional": ["team_id", "app_id", "service_id"], "enums": {"operation": ["full", "runtime", "access"]}}
  },
  "routes": {"existing": ["saas", "private-existing"]},
  "connect_argv": {
    "saas": ["npx", "--yes", "rainskills@0.1.0-rc.60", "runtime", "connect", "<target>", "--saas", "--intent-json", "<intent-json>"],
    "private-existing": ["npx", "--yes", "rainskills@0.1.0-rc.60", "runtime", "connect", "<target>", "--rainbond-url", "<rainbond-url>", "--intent-json", "<intent-json>"]
  }
}
```
<!-- rainskills-runtime-contract:end -->

target 只允许 `codex`、`claude`、`all`。校验 intent 后只执行 existing scope 的完整 argv；只消费 schema 为 `rainskills.next-action.v1` 且校验后的 `argv` 数组。

连接完成后用固定 `onboarding-id` 执行 launcher + `["intent", "resume", "--onboarding-id", "<同一 onboarding-id>"]`，恢复原始 intent 和 `resume_step`。401 先执行 launcher + `["runtime", "record-failure", "--onboarding-id", "<同一 onboarding-id>", "--step", "<当前固定步骤>", "--reason", "credential-expired"]`，再仅一次执行 launcher + `["runtime", "reconnect", "--onboarding-id", "<同一 onboarding-id>"]` 后 resume，只重试该步骤；第二次 401 停止。403 执行 launcher + `["runtime", "record-failure", "--onboarding-id", "<同一 onboarding-id>", "--step", "<当前固定步骤>", "--reason", "permission-denied"]` 后停止，不得 reconnect、重新授权或自动重试。
<!-- rainskills-runtime-gate:end -->

<!-- rainskills-runtime-routing:start -->
## 缺少运行环境时

先说：“可以，我会帮你验证应用交付状态和访问地址。不过目前还没有可用的应用运行环境。你刚安装的 Rainskills 是 AI 部署助手；应用实际运行在 Rainbond 上。Rainbond 是一套应用运行和管理平台，你不需要了解 Kubernetes。”

只让用户选择 `Rainbond Cloud` 或承载目标应用的`已有私有 Rainbond`。不得为交付验证安装私有 Rainbond，也不得用新平台代替原应用。
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

Use `docs/product-object-model.md` as the repository-level source of truth for:

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

Target structured output:

- this skill must emit `DeliveryVerificationResult`
- minimum target fields:
  - `runtime_state`
  - `delivery_state`
  - `preferred_access_url`
  - `verification_mode`
  - `blocker`
  - `next_action`
- the human-readable sections below should be treated as the narrative view over that target object
- append a final `### Structured Output` section after the human-readable report and render `DeliveryVerificationResult` in fenced `yaml`
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

Always respond using exactly these sections:

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
