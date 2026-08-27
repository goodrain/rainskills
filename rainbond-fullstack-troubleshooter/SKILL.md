---
name: rainbond-fullstack-troubleshooter
description: "Use only when the user explicitly asks for a bounded build, runtime, or access troubleshooting phase for an existing Rainbond app. Trigger phrases include: 只帮我看看 backend 为什么构建失败，先查事件和构建日志 / why build failed / troubleshoot runtime only. Do not use for a generic current-project deployment request; route that to rainbond-app-assistant."
---

# Rainbond Fullstack Troubleshooter

<!-- rainskills-user-result:start -->
## 用户可见结果协议（最高优先级）

普通用户部署流程中的排障结果必须保持简短、中文。内部可以维护 `TroubleshootResult`，但不得默认把内部诊断格式直接展示给用户。

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

`context resolve` 是无状态调用：单一工作空间直接返回上下文，多个候选返回组合选项；用户选择后由当前任务直接携带 team/region 参数，不执行 `context select`，不写本地 operation。所有可变 `call` 仍需先取得 confirmation ID，再以完全相同的输入追加 `--confirm` 执行一次。

```json
{
  "schema": "rainskills.single-runtime-contract.v1",
  "package_version": "rainskills@0.1.23",
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
        "rainbond-fullstack-troubleshooter"
      ],
      "stdin": {
        "required": [
          "enterprise",
          "workspace"
        ]
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
        "rainbond-fullstack-troubleshooter"
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
        "rainbond-fullstack-troubleshooter"
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
        "rainbond-fullstack-troubleshooter",
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

执行优化：同一会话内只检查一次 Node.js（首次使用本地 CLI 前）；仅在 Node.js 或 Rainskills 安装、升级，或 PATH 变更后失效。固定 launcher 和 argv 已在本 Skill 中，禁止读取、搜索或探测 `rainskills.js`，也禁止执行 `npm root -g`。每个新的业务操作仍需要刷新一次环境列表；带已有 `operation_id` 或 `onboarding-id` 的续接复用已绑定的环境 ID，不重复枚举环境。

<!-- rainskills-runtime-routing:start -->
## 缺少运行环境时

先说：“可以，我会帮你排查已有应用的构建或运行问题。不过目前还没有可用的应用运行环境。你刚安装的 Rainskills 是 AI 部署助手；应用实际运行在 Rainbond 上。Rainbond 是一套应用运行和管理平台，你不需要了解 Kubernetes。”

只让用户选择 `Rainbond Cloud` 或承载目标应用的`已有私有 Rainbond`。选择已有私有 Rainbond 时执行本地 launcher + `["runtime", "message", "--id", "private-console-origin"]` 并原样输出。不得为排障安装私有 Rainbond，也不得用新平台代替原应用。
<!-- rainskills-runtime-routing:end -->

## Overview

Use this skill after a Rainbond full-stack app has already been linked and bootstrapped, but the runtime has not yet cleanly converged.

Positive-path-first goal:
1. accept the bootstrap handoff with current project context
2. classify the canonical `RuntimeState`
3. apply only the smallest low-risk Rainbond-side repair when the blocker is platform-configurable
4. verify with fresh runtime evidence
5. hand off cleanly to `rainbond-delivery-verifier` once `runtime_healthy` is reached

This skill is not a replacement for bootstrap, delivery verification, or source-code remediation.

## Canonical Model Reference

Use `docs/product-object-model.md` as the repository-level source of truth for:

- `RuntimeState` boundaries and shared runtime evidence terminology
- deferred dependency and source-convergence semantics
- the separation between runtime diagnosis, delivery acceptance, and version operations
- the target `TroubleshootResult` contract and handoff vocabulary

This skill should explain how runtime evidence is interpreted, repaired, and handed off. It should not redefine canonical state boundaries independently.

For this contract convergence pass, the live troubleshooter output contract is frozen by:
- [schemas/troubleshoot-result.schema.yaml](schemas/troubleshoot-result.schema.yaml)
- [scripts/validate_troubleshoot_output.py](scripts/validate_troubleshoot_output.py)
- [scripts/run_troubleshooter_evals.py](scripts/run_troubleshooter_evals.py)
- [evals/](evals/)

The schema and validator keep the existing `TroubleshootResult` top-level fields, and place blocker evidence-chain and stop-boundary details inside `verification_summary`.

## Shared Runtime Vocabulary

When describing observed runtime state, use the canonical terms from the product object model:

- `RuntimeState`: `topology_missing`, `topology_building`, `runtime_unhealthy`, `runtime_healthy`, `capacity_blocked`, `code_or_build_handoff_needed`
- component convergence: `building`, `waiting`, `running`, `abnormal`, `capacity-blocked`
- dependency readiness: `resolved`, `deferred`
- blocker buckets: `db not ready`, `dependency missing`, `env naming incompatibility`, `wrong connection values`, `api startup issue`, `frontend access-path issue`, `source build still running`, `source build failed`, `external artifact unreachable`, `cluster capacity blocked`, `config_file_configmap_missing`

Keep the canonical `RuntimeState` explicit in both prose and structured output. Do not collapse it into ad hoc labels such as "mostly healthy" or "repair complete."

## Console failure classification mapping

Use `rainbond_get_operation_failure_context` after a write failure or when a component becomes abnormal immediately afterwards. Map `classified_reason` once before choosing a repair; `unknown` uses the existing evidence chain and never authorizes a replay. Treat `event_log_tail` as sensitive evidence: never copy, quote, or display its raw 原文.

| Console classified_reason | Troubleshoot blocker_bucket | stop_reason |
| --- | --- | --- |
| `config_file_configmap_missing` | `config_file_configmap_missing` | `api_startup_issue` |
| `volume_mount_failed` | resolve from affected component role and storage evidence | existing evidence chain |
| `image_pull_failed` | `external artifact unreachable` | `external_artifact_unreachable` |
| `crash_loop` | resolve from affected component role and runtime evidence | existing evidence chain |
| `probe_failed` | resolve from affected component role and probe evidence | existing evidence chain |
| `unschedulable` | `cluster capacity blocked` | `cluster_capacity_blocked` |
| `k8s_api_rejected` | `platform backend issue` | `platform_backend_issue` |
| `unknown` | existing evidence chain | existing evidence chain |

For normal runtime inspection, call `rainbond_get_app_health_overview` first. Only abnormal or unknown components need component summaries, events, logs, or storage detail.

## When to Use

Use when:
 - `rainbond-fullstack-bootstrap` or `rainbond-app-assistant` has handed off a linked app in `topology_building` or `runtime_unhealthy`
 - a full-stack app already has Rainbond topology, but runtime convergence is still pending
 - the likely blocker is dependency wiring, env compatibility, wrong connection values, source build convergence, api startup behavior, or frontend runtime access path
 - the workflow needs a bounded answer before delivery verification: continue low-risk Rainbond repair, wait for build convergence, stop for platform capacity, or hand off to code/build work

Do not use when:
 - the user gives a generic current-project deployment or mainline request and the next phase is not yet explicit; route that to `rainbond-app-assistant`
 - required topology has not been created yet
 - the task is final delivery acceptance or access URL confirmation
 - the task requires source-code changes, build script changes, reverse-proxy edits, or destructive cleanup
- the database must be reset or modified directly
- the issue is clearly unrelated to Rainbond runtime state
- the user wants to restart or modify Rainbond platform system components (`rbd-*` such as `rbd-gateway`, `rbd-api`, `rbd-worker`, `rbd-chaos`, `rbd-db`, `rbd-mq`, `rbd-monitor`, `rbd-node`); these are platform infrastructure, not user app components — MCP write operations are not supported on them; direct the user to `kubectl rollout restart` or the Rainbond cluster management console instead

## Configuration Priority

Use file sources to resolve context, but never treat them as live runtime truth.

Shared file layers:
1. **Highest priority**: user explicit input for the current troubleshooting run
2. **Secret reference layer**: `.rainbond/secrets.preview.json` or `.rainbond/secrets.prod.json`
3. **Environment reference layer**: `.rainbond/env.preview.json` or `.rainbond/env.prod.json`
4. **Project binding context**: `.rainbond/local.json`
5. **Lowest priority**: `rainbond.app.json` as the project topology baseline

Backward compatibility:
- If `rainbond.app.json` is absent, legacy `rainbond.json` may be read as the same lowest-priority baseline tier
- Legacy `rainbond.json` never overrides user input, secret files, environment reference files, or local binding context

Operational rules:
- Resolve `app_id`, `team_name`, and `region_name` from user explicit input first, then `.rainbond/local.json`
- Resolve selected environment in this order: user explicit input > `.rainbond/local.json.preferences.default_environment` > `preview`
- Use `.rainbond/secrets.<environment>.json` and `.rainbond/env.<environment>.json` only as reference input for intended values or compatibility expectations; they are not proof of current deployed env
- Use `rainbond.app.json` only as a baseline hint for topology, naming, ports, and non-sensitive defaults
- Real state must come from Rainbond MCP queries: app detail, component summaries, pod runtime diagnostics, deployed envs, dependencies, ports, events, and logs
- If persisted files conflict with Rainbond MCP results, trust MCP and report the mismatch explicitly
- Never print secret values in prose or structured output

## Runtime Configuration Source Precedence

This is about which source the *running process* actually reads, not which local file resolves context.

- Effective runtime config resolves as: mounted config-file volume (`config.yml` / `application.yml` / `application.properties` / `.env` / `nginx.conf` / `*.conf` at a config path) > runtime environment variables > image baked-in defaults.
- A correct env change does NOT take effect if a mounted config file overrides the same key. Fix the override source, not just env.

## Scope

Typical components:
- `web`: frontend
- `api`: backend
- `postgres` or equivalent: database

Primary positive-mainline entry states:
- `topology_building`
- `runtime_unhealthy`

Other legal observed outcomes during troubleshooting:
- `runtime_healthy`
- `capacity_blocked`
- `code_or_build_handoff_needed`
- `topology_missing`, but only when current evidence proves bootstrap never established required topology; treat this as an out-of-mainline regression and report it explicitly rather than pretending troubleshooting converged

Configuration source roles:
- `.rainbond/local.json`: preferred binding context for `app_id`, `team_name`, `region_name`, and default environment
- `.rainbond/secrets.preview.json` / `.rainbond/secrets.prod.json`: reference-only expected secret inputs, never runtime truth
- `.rainbond/env.preview.json` / `.rainbond/env.prod.json`: reference-only expected env overrides, not runtime truth
- `rainbond.app.json`: baseline topology hints such as component names, roles, ports, and non-sensitive default envs
- Rainbond MCP: the only valid source for live component state, pod runtime diagnostics, deployed envs, dependencies, logs, and health

Allowed actions:
- read app detail, component summary, component detail, component pods, pod detail, logs, and monitor data
- read component events and build logs for source-backed components
- modify provider component connection envs with `rainbond_manage_component_connection_envs`
- modify consumer runtime envs only as a fallback compatibility repair after provider connection envs and dependency wiring are confirmed
- modify source build envs through `rainbond_manage_component_envs(operation=replace_build_envs, build_env_dict=...)` when build evidence clearly points to a low-risk parameter fix
- add dependencies such as `api -> db`, `api -> redis`, or service -> middleware with `rainbond_manage_component_dependency`
- open provider inner ports when explicitly required to satisfy a confirmed dependency edge, including by retrying dependency creation with `open_inner=true` and the provider `container_port`
- restart or deploy the `api` component

Known limitation — one-shot tasks: Rainbond components are long-running workloads.
Do not create a temporary component just to run a one-shot script: `stateless_multiple`
containers that exit immediately go into restart loops, and database images run their own
entrypoint instead of a custom CMD. For one-off commands prefer `rainbond_exec` into a
running container; for database initialization prefer the image's native init mechanism
(e.g. PostgreSQL `/docker-entrypoint-initdb.d`).

Disallowed actions:
- delete app
- delete components
- clear database data
- modify source code
- make large speculative changes across multiple components
- loop through repeated repairs after the dominant blocker is already classified as platform or code/build

## Pod-Level Runtime Diagnosis

Use Pod-level diagnostics when:
- a component status is not `running`
- the user mentions Pod startup failure, image pull failure, `CrashLoopBackOff`, init container issues, or probe/startup problems
- component logs do not yet explain the blocker

Runtime diagnosis order for these cases:
1. `rainbond_get_component_summary`
2. `rainbond_get_component_pods`
3. choose a target Pod, preferring:
   - `group == new_pods`
   - a Pod whose `pod_status` is not `RUNNING`
   - the first returned item as fallback
4. `rainbond_get_pod_detail`
5. extract the root cause in this order:
   - `status.reason`
   - `status.message`
   - `events` entries containing `Warning`, `Failed`, or `BackOff`
   - `init_containers[*].reason`
   - `containers[*].reason`
6. only then read `rainbond_get_component_logs(action=container, pod_name, container_name)` when more context is still needed

Tool semantics:
- call Pod tools with `team_name`, `region_name`, `app_id`, and `service_id`; do not switch back to console `serviceAlias` routing assumptions
- do not treat `rainbond_get_component_summary` as the Pod-level root-cause source; it can show that a component is unhealthy, but not always why
- `rainbond_get_pod_detail` returns the Pod diagnostic object directly, not a `data.bean` wrapper
- `rainbond_get_pod_detail` already handles `kubeblocks_component` internally; do not add a separate skill-side branch for that case
- do not invent a separate Pod-log tool; container logs still come from `rainbond_get_component_logs(action=container, ...)`

## Operation Anchoring (HARD RULE)

When this skill triggers an action (build, deploy, upgrade, start, stop, check), the action returns an `event_id`. That `event_id` is the only safe anchor for "did **my** action finish, and how." Treat the `event_id` as required state for the rest of the run.

Capture-on-trigger:
- `rainbond_build_component` → store as `build_event_id`
- `rainbond_operate_app` (deploy / upgrade / start / stop) → store as `operation_event_id`
- `rainbond_check_component` → store as `check_event_id` and pair with the returned `check_uuid`
- if a triggering call's response does not contain a recognizable event id field, record `trigger_at` (timestamp) instead and downgrade to the pod-based observation path below

Polling signal priority (use in order, do not skip):
- **P1 — anchored build log** (default for build / deploy / upgrade)
  - call `rainbond_get_component_build_logs(event_id=<my_event_id>)` and look for terminal markers (`BUILD SUCCESS`, `BUILD FAILED`, exit-code lines, fatal error keywords)
  - this stream is keyed by `event_id` at the platform level; concurrent operations on the same component cannot pollute it
  - for large projects (Maven monorepo, multi-stage Node.js, etc.), **prefer narrowing the response** with `tail=500` (last N entries — errors almost always live at the tail) or `grep="ERROR"` / `grep="BUILD FAILURE"` / `grep="Caused by"` (substring filter on message field). `offset` + `limit` also supported. Without these the upstream LLM truncates the middle and the actual error vanishes; if you ever see `_truncated: true` or `_dropped_items_count > 0` in the response, **the very next call must add tail/grep** — never refetch with the same arguments
- **P2 — pod truth** (default for start / stop / runtime convergence, also fallback for P1)
  - `rainbond_get_component_pods` then `rainbond_get_pod_detail`
  - judge by `pod_status`, `containers[*].state`, `restart_count`, and pod-level events
  - pods reflect Kubernetes reality and are not contaminated by user-level operation events
- **P3 — filtered event stream** (only when P1/P2 are insufficient)
  - `rainbond_get_component_events` and **client-side filter** by:
    - event id ≥ `my_event_id`, AND
    - event type matches the operation class (build / deploy / upgrade / start / stop)
  - never use "the latest event in the page" as the signal; the page is shared across all operation types

Forbidden polling patterns:
- repeatedly calling `rainbond_get_component_summary` inside a polling loop to read `recent_events` or `status` as the primary signal
- repeatedly calling `rainbond_query_components` (same `app_id` + same `query`/`service_id`) to re-check whether a component has converged after a restart, deploy, or `rainbond_operate_app` — it returns a component-list snapshot, not an action-anchored signal, and identical-arg re-reads are served from a short server-side cache, so the `status` field looks unchanged and feeds an endless re-poll; verify convergence through P2 (pods anchored to the operation) instead
- judging "my action finished" from `summary.status` string changes — `status` is an aggregate field that other concurrent operations also mutate
- treating "the most recent event" or "the first event in the events page" as the signal for the action this run triggered, when no `event_id` was captured at trigger time
- assuming an event without `event_id` correlation belongs to the action this run just triggered, just because it is recent

Allowed `summary` usage:
- one baseline snapshot when entering troubleshooting (topology, envs, ports, resources, autoscaler)
- one confirmation read after a configuration mutation (envs, dependencies, ports) to verify the change applied
- never as a polling-loop signal source

Concurrency note:
- if the user is interacting with the same component through the UI or another client during this run, P2 (pods) is the most robust signal — it reflects platform-side actuation, not the operation event mix
- if `event_id` returned from a trigger is empty, do not silently proceed as if anchoring is in place; switch to P2 with the recorded `trigger_at` and report this gap in `actions_performed[].details`

### Write-result confirmation under async inconsistency

Mutating MCP calls (storage update, env change, restart, upgrade) can return a 5xx error
while the platform still applies the change asynchronously.

- a 5xx response to a write is **not** proof of failure: query the related component events
  or re-read the resource once before concluding
- if the event stream reports success but the pod is still failing, trust the pod-level
  runtime evidence, not the event
- per blocker, perform at most one repair retry when the control plane looks inconsistent;
  repeated writes against an inconsistent control plane make state strictly worse

## Workflow

Follow this order unless there is strong evidence to do otherwise.

Attempt budget:
- the same blocker bucket should not trigger more than 1 repeated repair attempt in a single run
- if the same blocker remains after one repair-and-verify cycle, stop and report the bounded blocker instead of trying a third variation
- if the run spends too long without materially changing runtime evidence, stop and report the current blocker rather than continuing indefinite retries
- read-only status re-reads count toward this budget too: repeating any status check (`rainbond_get_component_summary`, `rainbond_query_components`, `rainbond_get_component_events`) against the same target with the same arguments, with no new anchored evidence (a fresh `event_id`, a pod-state change, a just-granted approval) in between, is "no material change" — after at most 2 such repeats, stop and return a graceful intermediate reply with the last observed state plus "reply 继续 to resume the status check", then end the run

1. Resolve context and handoff
- Collect any user-explicit identifiers, environment choice, or component names first
- Read `.rainbond/local.json` if present and prefer it for `app_id`, `team_name`, `region_name`, and default environment
- Read `.rainbond/secrets.<environment>.json` and `.rainbond/env.<environment>.json` only as reference inputs for expected values
- Read `rainbond.app.json`; if absent, read legacy `rainbond.json` only as a topology hint
- Query Rainbond MCP for app detail and component list
- If any local file conflicts with MCP runtime facts, trust MCP and report the drift
- Identify `web`, `api`, and db components from MCP data first, then use files only as hints
- Treat bootstrap handoff context as useful input, but let current MCP/runtime truth decide the current state

2. Read current runtime evidence
- Read `api` component summary first
- Inspect `api` status, envs, connection envs, ports, probes, and recent events
- For source-backed components or explicit build-failure questions:
  - read component events first
  - extract the failed build/deploy `event_id` when one exists
  - read the build log for that `event_id`
  - read runtime container logs only when the build has already succeeded or the evidence has shifted from build failure to runtime startup
- For runtime-unhealthy or startup-blocked components:
  - if the component is not `running`, or the blocker mentions Pod startup, image pull, init container, `CrashLoopBackOff`, or probe issues, read `rainbond_get_component_pods`
  - choose the target Pod by preferring `new_pods`, then a non-`RUNNING` Pod, then the first Pod as fallback
  - read `rainbond_get_pod_detail`
  - classify the dominant runtime blocker from `status.reason`, `status.message`, warning/failure events, `init_containers[*].reason`, then `containers[*].reason`
  - read container logs only if Pod detail still does not explain the blocker or additional app context is needed
- Read recent `api` runtime logs only when runtime behavior is part of the blocker judgment and build or Pod evidence is still insufficient
- Read db component summary
- Confirm whether db is running and ready
- If db is not running or its startup reason is still unclear, use the same `component_pods -> pod_detail -> container logs` order for db
- Read `web` summary only when frontend runtime access path is part of the blocker judgment

3. Classify the current canonical `RuntimeState` before changing anything
- `topology_building`
  - source-backed components are still converging
  - recent events show build or compile is still running
  - dependency wiring is legitimately deferred by upstream convergence
- `runtime_unhealthy`
  - topology exists, but runtime evidence shows abnormal, waiting, probe failure, env mismatch, or broken connectivity
- `runtime_healthy`
  - topology exists and current runtime evidence no longer shows an operational blocker
- `capacity_blocked`
  - active scheduling failure or resource shortage is the dominant blocker
- `code_or_build_handoff_needed`
  - the dominant blocker is source build failure, frontend access-path/build configuration, or another code/build issue outside low-risk Rainbond repair
- `topology_missing`
  - required topology is unexpectedly absent; report it explicitly instead of pretending this skill can replace bootstrap

4. Choose the smallest valid repair path
- `dependency missing`
  - first ensure the provider component exposes the needed port alias and connection envs
  - add the missing dependency with `rainbond_manage_component_dependency`
  - if the tool returns `requires_open_inner`, open the provider inner port or retry with `open_inner=true` and the provider `container_port`
  - do not claim MCP lacks a dependency API; if dependency creation fails, report the concrete MCP/control-plane error
- `env naming incompatibility`
  - prefer fixing provider connection env names and port aliases so every dependent service receives the same contract
  - add consumer compatibility envs only when provider-side repair is unsafe or cannot express the app's expected names
- `wrong connection values`
  - **config-override gate (run BEFORE mutating env)**: enumerate the component's mounted config-file volumes from `rainbond_get_component_summary`. If any mounted volume targets a known config path (`config.yml` / `application.yml` / `application.properties` / `.env` / `nginx.conf` / `*.conf`), treat that file as the authoritative config source per Runtime Configuration Source Precedence. The repair must target that file (or remove the stale override), not just env, because the mounted file wins. Compare values for the override, but report mismatches structurally (e.g. "mounted config.yml overrides env: db host mismatch") and never print the raw secret value.
  - **capability limit**: detection that a config-file volume is mounted at a config path works today via `component_summary`. Content verification (what the file actually contains) needs pod exec or a config-file read API that may not exist yet. If content cannot be read, flag the override risk explicitly and escalate or instruct the user; do not silently edit env and declare success.
  - correct provider connection envs or port aliases first when the wrong values come from provider metadata
  - correct consumer envs only when they are truly consumer-local overrides
- `api startup issue`
  - **config-override gate (run BEFORE mutating env)**: same as `wrong connection values` — if a config-file volume is mounted at a known config path, that file outranks env. Repair the file or remove the stale override; do not assume an env edit fixes a value the mounted file re-supplies. When file content cannot be verified with current MCP capability, flag the override risk and escalate rather than claiming the env fix worked.
  - report clearly that the issue is not primarily the db path
  - apply only a confirmed platform-side fix; otherwise keep the state as `runtime_unhealthy`
- `source build still running`
  - do not keep patching envs or dependency wiring blindly
  - keep the state as `topology_building`
- `source build failed`
  - if the build failure is caused by unreachable external artifacts, registry layers, package tarballs, GitHub Release assets, or native binary downloads, classify as `external artifact unreachable` rather than generic source-code failure
  - **Source-file-pointing errors (escalate immediately, no env attempt)**: when the build log error explicitly names a file that lives in the user's source repository (`pnpm-lock.yaml` / `package-lock.json` / `yarn.lock` / `package.json` / `Dockerfile` / `go.mod` / `go.sum` / `requirements.txt` / `Pipfile.lock` / `pom.xml` / `build.gradle` etc.), or names an in-repo configuration like `.nvmrc` / `.python-version` / `packageManager` field, the fix has to happen INSIDE that file. Build envs from outside the repo cannot edit file contents. Skip env tweaking; classify `code_or_build_handoff_needed` on the first observation of this error signature.
  - **Build env attempt budget**: if (and only if) the failure looks env-fixable AND the candidate env key exists in `rainbond-fullstack-bootstrap/references/source-build-parameter-guide.md`, **one minimal `replace_build_envs` repair attempt is allowed**. If that one attempt does not change the build error signature on the next build, escalate to `code_or_build_handoff_needed`. Do not iterate through env variations (`CNB_X=v1`, then `BUILD_X=v1`, then `CNB_X=v2`, etc.) — each variation needs its own build + user authorization, and the cumulative cost is worse than escalating.
  - **Fabricated env keys are not "one attempt"** — they are zero attempts because the runtime silently ignores them. If you discover the key you used isn't in the reference doc, do not "try a different env" — escalate.
  - otherwise stop Rainbond-side repair and classify as `code_or_build_handoff_needed`
- `external artifact unreachable`
  - stop Rainbond-side repair after collecting component events and build logs
  - recommend restoring artifact/registry reachability or providing an explicit reachable mirror
  - do not switch to local Docker build, temporary image push, package upload, or image fallback without explicit user confirmation
- `frontend access-path issue`
  - stop Rainbond-side repair and classify as `code_or_build_handoff_needed`
- `cluster capacity blocked`
  - stop application-level repair and classify as `capacity_blocked`

5. Verify after repair or after a bounded no-change judgment
Always re-check:
- `api` summary
- db summary
- recent `api` logs
- app monitor if useful

Then restate:
- canonical `runtime_state.label`
- blocker bucket
- whether the key error disappeared from logs
- whether the remaining question is delivery acceptance rather than runtime repair

6. Apply handoff rules
- if `runtime_state.label = runtime_healthy`, use `next_handoff = delivery_verifier`
- if `runtime_state.label = code_or_build_handoff_needed`, use `next_handoff = code_build_handoff`
- if `runtime_state.label = topology_building`, `runtime_unhealthy`, `capacity_blocked`, or `topology_missing`, use `next_handoff = none`
- if `topology_missing` is encountered, explain in prose that bootstrap or topology creation must be revisited; do not extend the structured enum beyond the canonical `next_handoff` values

Do not claim recovery without fresh status and log evidence.

## Root Cause Rules

### A. Database not ready
Symptoms:
- db not running
- db not ready
- db logs show startup failure

Action:
- do not start by editing `api` env
- report db readiness as the blocking issue

Expected result:
- `runtime_state.label = runtime_unhealthy`
- `next_handoff = none`

### B. Missing dependency
Symptoms:
- `api` cannot resolve or reach db
- `api` lacks expected db connection info
- dependency list does not include db

Action:
- inspect the provider port alias and connection envs first
- add or repair missing provider connection envs on the provider component
- add `api -> db` dependency with `rainbond_manage_component_dependency`
- if the tool returns `requires_open_inner`, open the provider inner port or retry with `open_inner=true` and the provider `container_port`
- runtime DNS reachability, hard-coded service names, Nginx upstreams, or manually written consumer envs do not count as the Rainbond console-visible dependency edge

Expected result:
- if `api` recovers, `runtime_state.label = runtime_healthy`
- otherwise remain `runtime_unhealthy`

### C. Env naming incompatibility
Symptoms:
- db is healthy
- dependency exists or db connection envs are visible
- logs still show connection failure
- db exports `POSTGRES_*` but app expects `DB_*`
- or the app still expects a hard-coded host like `db` even though Rainbond dependency alias envs are available

Action:
- prefer provider-side repair: normalize the provider port alias and add or update provider connection envs such as `DB_USER`, `DB_PASS`, `DB_NAME`, `REDIS_PASSWORD`, or `KAFKA_BROKERS`
- values must come from current provider connection information, explicit input, or `.rainbond/secrets.<environment>.json`
- if the app expects `DATABASE_HOST` / `DATABASE_PORT`, `DB_HOST` / `DB_PORT`, or similar names, prefer a provider port alias that generates those names for all dependents
- add the smallest consumer compatibility env set only when provider-side repair is unsafe, would break existing consumers, or cannot express the expected names
- explicitly report whether the fix was provider connection contract repair or consumer compatibility fallback

Expected result:
- if the key db error clears and `api` becomes healthy, `runtime_state.label = runtime_healthy`
- otherwise remain `runtime_unhealthy`

### D. Wrong connection values
Symptoms:
- wrong host, password, port, db name
- authentication failure
- connection refused
- name resolution failure
- a manifest or runtime env pins a literal dependency hostname that does not resolve in the current Rainbond topology

Action:
- **before mutating env, run the config-override gate**: enumerate mounted config-file volumes from `rainbond_get_component_summary`; if one targets a known config path (`config.yml` / `application.yml` / `application.properties` / `.env` / `nginx.conf` / `*.conf`), that file is authoritative and outranks env (see Runtime Configuration Source Precedence). Repair the file or remove the stale override; an env-only fix silently reverts when the mounted file re-supplies the value
- when comparing config values against env for the gate, report mismatches structurally (e.g. "mounted config.yml overrides env: db host differs from intended") and never print the raw secret value
- if file content cannot be read with current MCP capability, flag the override risk and escalate or instruct the user; do not edit env and declare success
- fix only the incorrect values
- when dependency wiring already exists, prefer provider connection envs and the currently resolvable Rainbond dependency alias/service coordinates over stale literal hostnames
- if stale consumer envs duplicate provider connection values, remove or replace the consumer-local override only after confirming the dependency-injected provider values are present
- do not invent values without evidence
- known limitation: cross-team service DNS does not resolve — a component in one team
  cannot resolve another team's component by its Rainbond service alias. If the evidence
  shows a cross-team hostname, do not keep retrying DNS-based fixes; recommend exposing
  the provider through a gateway/external address or moving the components into one team,
  and ask the user to choose

Expected result:
- if corrected values restore startup, `runtime_state.label = runtime_healthy`
- otherwise remain `runtime_unhealthy`

### E. API issue unrelated to db
Symptoms:
- logs point to app startup, port binding, or non-db runtime error
- logs show file-not-found or permission errors for file-backed config/secret paths

Action:
- **before mutating env, run the config-override gate**: if a config-file volume is mounted at a known config path (`config.yml` / `application.yml` / `application.properties` / `.env` / `nginx.conf` / `*.conf`), that mounted file outranks runtime env (see Runtime Configuration Source Precedence). A startup value driven by the mounted file will not change from an env edit; repair the file or remove the stale override instead. When file content cannot be verified with current MCP capability, flag the override risk and escalate rather than declaring the env fix successful
- report clearly that the issue is not primarily the db path
- do not force db-oriented repairs
- if the evidence shows a source/build defect rather than a runtime config issue, reclassify to `code_or_build_handoff_needed`
- for file-backed config/secret mounts, treat Rainbond mount path as a directory when a config filename is present; adjust the consuming env to `<mount_dir>/<config_name>` once. Comparing mounted config values against env for the override gate is allowed and expected, but never print raw file contents or secret values verbatim — report only structural mismatches

Expected result:
- `runtime_unhealthy` for unresolved runtime issues
- `code_or_build_handoff_needed` only when the dominant blocker is outside platform-side repair

### F. Frontend access-path issue
Symptoms:
- browser still fails after db and api are healthy
- frontend calls localhost, invalid absolute URL, or missing `/api` proxy
- issue is caused by build-time env injection or reverse proxy config

Action:
- do not continue platform-level env or dependency edits
- report the frontend/runtime access-path issue clearly
- hand off to code/build work

Expected result:
- `runtime_state.label = code_or_build_handoff_needed`
- `next_handoff = code_build_handoff`

### G. Source build still running
Symptoms:
- source-backed components are `undeploy`, `waiting`, or otherwise not yet converged
- recent events show build or compile is still in progress
- dependency creation is blocked because target component runtime metadata is not ready yet

Action:
- do not keep patching envs or dependency wiring blindly
- report this as a build-convergence state, not a completed runtime diagnosis
- identify which dependency edges are still pending
- continue only after fresh state or build completion is available

Expected result:
- `runtime_state.label = topology_building`
- `next_handoff = none`

### H. Source build failed
Symptoms:
- recent events explicitly show compile failure or build failure
- source-backed component remains `undeploy` with failed build events
- build log or event evidence points to source/build issues rather than platform runtime configuration
- build log may show unreachable external artifacts; classify those separately as `external artifact unreachable`

Action:
- do not continue platform-level env or dependency edits as the primary fix
- read component events first and collect the relevant failing component and build `event_id`
- read the build event log before reading runtime container logs
- if the build log shows a missing or incorrect low-risk build parameter, apply the smallest viable `build_env_dict` change through `replace_build_envs`
- do **not** try to fix a source build failure by moving build parameters into `build_info`
- if the low-risk build-env repair is not clearly justified, or one repair attempt does not clear the build failure, classify the issue as code/build handoff
- only return to platform-side repair after the source/build issue is fixed

Expected result:
- `runtime_state.label = code_or_build_handoff_needed`
- `next_handoff = code_build_handoff`

### H2. External artifact unreachable
Symptoms:
- build logs fail while downloading GitHub Release assets, native binary packages, package tarballs, language installer binaries, or registry layers
- image pull events show registry, Docker Hub, or layer download timeouts
- examples include sharp/libvips release downloads and Docker Hub image pull timeouts

Action:
- keep the original component delivery mode
- read component events first and the relevant build or pull evidence second
- do not start local Docker/OrbStack, push a temporary image, or switch to package/image fallback automatically
- do not attempt build-env fixes for registry or network failures: no documented build key affects network reachability, and inventing one (mirror/proxy-style names) burns the retry budget on a no-op
- recommend a reachable registry/artifact mirror, restoring cluster egress, or explicit user-approved delivery-mode change

Expected result:
- `runtime_state.label = code_or_build_handoff_needed`
- `blocker_bucket = external artifact unreachable`
- `next_handoff = code_build_handoff`

### I. Cluster capacity blocked
Symptoms:
- recent events contain `Unschedulable`
- scheduler reports CPU or memory shortage
- the repaired or newly built component cannot start because the cluster cannot place the workload

Action:
- stop application-level env and dependency repair loops
- classify the issue as a platform capacity blocker
- state which component is blocked on scheduling
- recommend reducing requested resources or restoring cluster capacity
- only return to application verification after scheduling can proceed

Expected result:
- `runtime_state.label = capacity_blocked`
- `next_handoff = none`

### J. Config-file ConfigMap missing
Symptoms:
- pod events show `FailedMount` with `configmap ... not found`
- the component has config-file volumes in its storage summary
- upgrade/deploy succeeds at the build stage but the pod never starts

Action:
- read the component storage summary and locate every config-file volume and its mount path
- read `rainbond_get_config_file` for each config-file volume to confirm the platform-side content exists
- read pod detail and extract the missing ConfigMap name from the `FailedMount` event
- apply at most one low-risk repair: re-save the config-file volume content via `rainbond_manage_component_storage(update_volume)`; when the path is unchanged, omit `new_volume_path`, while `new_file_content` is required, then restart once
- if the ConfigMap is still missing after one repair attempt, or the storage update returns a 5xx error, stop. Report a platform-side sync blocker; do not loop on config edits

Expected result:
- if the mount recovers, `runtime_state.label = runtime_healthy`
- otherwise `runtime_state.label = runtime_unhealthy` with `blocker_bucket = config_file_configmap_missing`

## Verification Standard

`runtime_healthy` is a runtime conclusion, not a delivery conclusion.

A repair is only successful enough to hand off when:
- db is running and ready
- api is running and logs no longer show the dominant runtime blocker
- required dependency and ports are correctly configured
- no active source-build failure or capacity blocker still dominates the result
- the remaining question is delivery acceptance or user-facing URL validation, not further runtime repair

Do not declare repair success when:
- source-backed components are still building
- source-backed components have known compile or build failures
- required dependency edges are only pending because target components have not converged yet
- components are blocked by cluster scheduling or capacity constraints
- the dominant blocker has shifted to frontend access-path or build-layer work
- the same blocker bucket has already persisted after one repair-and-verify cycle in the current run

If the system is already `runtime_healthy`, stop and say so. Do not continue making changes.

## Output Format

Structured output contract（仅在用户或自动化明确要求结构化结果时使用）：

- this skill must emit `TroubleshootResult`
- keep the human-readable sections below exactly as the narrative surface contract
- 在明确结构化模式中追加一个最终 `### Structured Output` section，并用 fenced `yaml` 渲染 `TroubleshootResult`
- do not place any prose after the final structured block

Canonical required top-level fields:
- `runtime_state`
- `blocker_bucket`
- `actions_taken`
- `verification_summary`
- `next_handoff`

Canonical required subfields:
- `runtime_state.label`
- `verification_summary.db_status`
- `verification_summary.api_status`
- `verification_summary.frontend_access_status`
- `verification_summary.evidence_chain`
- `verification_summary.dominant_evidence`
- `verification_summary.stop_reason`
- `verification_summary.recommended_next_action`
- `verification_summary.stop_boundary`

Optional extensions allowed inside the canonical object:
- `runtime_state.component_status`
- `runtime_state.dependency_readiness`
- `runtime_state.blocker_summary`
- `verification_summary.key_error_cleared`
- `verification_summary.app_endpoint_operational`

Do not add new top-level fields beyond the canonical contract unless `docs/product-object-model.md` is updated first.

Live schema summary:

```yaml
TroubleshootResult:
  runtime_state:
    label: topology_missing | topology_building | runtime_unhealthy | runtime_healthy | capacity_blocked | code_or_build_handoff_needed
    component_status:
      api: building | waiting | running | abnormal | capacity-blocked | null
      db: building | waiting | running | abnormal | capacity-blocked | null
    dependency_readiness:
      db_dependency: resolved | deferred | deferred_by_upstream_convergence
    blocker_summary: string | null
  blocker_bucket: db not ready | dependency missing | env naming incompatibility | wrong connection values | api startup issue | frontend access-path issue | source build still running | source build failed | mcp backend issue | external artifact unreachable | cluster capacity blocked | null
  actions_taken:
    - string
  verification_summary:
    db_status: running | waiting | abnormal | capacity-blocked | null
    api_status: running | waiting | abnormal | capacity-blocked | null
    frontend_access_status: working | not_working | needs_validation | null
    key_error_cleared: boolean | null
    app_endpoint_operational: boolean | null
    evidence_chain:
      - app_detail | component_summary | component_events | build_logs | pod_list | pod_detail | runtime_logs | dependency_summary | connection_envs | runtime_envs | port_rules | frontend_access_check | scheduler_events | app_monitor
    dominant_evidence: string | null
    stop_reason: topology_missing | source_build_still_running | source_build_failed | external_artifact_unreachable | db_not_ready | dependency_missing | env_naming_incompatibility | wrong_connection_values | api_startup_issue | frontend_access_path_issue | cluster_capacity_blocked | code_or_build_handoff_needed | runtime_healthy_ready_for_delivery_verifier | null
    recommended_next_action: string | null
    stop_boundary:
      stopped: boolean
      delivery_verifier_allowed: boolean
      code_changes_allowed: false
      local_tests_allowed: false
      commit_or_push_allowed: false
      fallback_used: false
  next_handoff: none | delivery_verifier | code_build_handoff
```

Consistency rules:
- every non-null `blocker_bucket` must include a canonical bucket, `dominant_evidence`, `stop_reason`, and `recommended_next_action`
- `source build failed` must use the evidence order `component_events -> build_logs` before any runtime-log reasoning
- `external artifact unreachable` must use event or pod evidence before runtime logs; use build logs for build-time downloads and pod detail/events for image-pull or registry-layer failures
- `cluster capacity blocked` must stop with `next_handoff = none` and `delivery_verifier_allowed = false`
- `code_or_build_handoff_needed` must stop with `next_handoff = code_build_handoff` and must not allow code edits, local tests, commit, or push
- `fallback_used` must be `false`; do not silently switch to package, image, or template paths
- `Verification Result` overall status in prose must match `runtime_state.label`
- if `runtime_state.label = runtime_healthy`, `next_handoff` may be `delivery_verifier` or `none`, but should normally be `delivery_verifier`
- if `runtime_state.label = code_or_build_handoff_needed`, `next_handoff` must be `code_build_handoff`
- if `runtime_state.label = capacity_blocked`, `next_handoff` must be `none`
- if `blocker_bucket = cluster capacity blocked`, `runtime_state.label` must be `capacity_blocked`
- if `blocker_bucket = source build failed`, `external artifact unreachable`, or `frontend access-path issue`, `runtime_state.label` must be `code_or_build_handoff_needed`
- if `runtime_state.label = topology_building`, do not claim key runtime errors are cleared unless fresh evidence proves it
- `actions_taken` must contain only actions actually taken in the current run; if no mutation happened, say so explicitly
- when a layer does not exist in the current topology, prose may say `not applicable` and the structured field should be `null`
- no secret values may appear in prose or structured output

Example object:

```yaml
TroubleshootResult:
  runtime_state:
    label: runtime_healthy
    component_status:
      api: running
      db: running
    dependency_readiness:
      db_dependency: resolved
    blocker_summary: null
  blocker_bucket: env naming incompatibility
  actions_taken:
    - Updated provider connection envs on `db` so dependents receive the expected DB_* contract.
    - Added the missing `api -> db` dependency with dependency management.
    - Redeployed `api` after dependency wiring.
  verification_summary:
    db_status: running
    api_status: running
    frontend_access_status: needs_validation
    key_error_cleared: true
    app_endpoint_operational: null
    evidence_chain:
      - component_summary
      - connection_envs
      - runtime_logs
    dominant_evidence: "api logs expected DB_* names while provider connection envs were missing from the dependency contract."
    stop_reason: runtime_healthy_ready_for_delivery_verifier
    recommended_next_action: "Run delivery-verifier to confirm final access behavior."
    stop_boundary:
      stopped: true
      delivery_verifier_allowed: true
      code_changes_allowed: false
      local_tests_allowed: false
      commit_or_push_allowed: false
      fallback_used: false
  next_handoff: delivery_verifier
```

Example final reply:

````markdown
### Problem Judgment
Root cause is `env naming incompatibility` based on logs and component configuration. Affected layers: `api`, `overall`.

### Actions Taken
- updated provider connection envs on `db` so dependents receive the expected DB_* contract
- added the missing `api -> db` dependency with dependency management
- redeployed `api` after dependency wiring

### Verification Result
- **db status**: `running`
- **api status**: `running`
- **frontend-access status**: `needs validation`
- **overall status**: `runtime_healthy`
- key error disappeared from logs: `yes`
- app can serve user-facing requests: `not yet verified from this run`

### Follow-up Advice
Short-term: hand off to `rainbond-delivery-verifier` to confirm final access outcome. Long-term: keep connection variables on the provider component so every dependent service receives the same contract. handoff needed: yes.

### Structured Output
```yaml
TroubleshootResult:
  runtime_state:
    label: runtime_healthy
    component_status:
      api: running
      db: running
    dependency_readiness:
      db_dependency: resolved
    blocker_summary: null
  blocker_bucket: env naming incompatibility
  actions_taken:
    - Updated provider connection envs on `db` so dependents receive the expected DB_* contract.
    - Added the missing `api -> db` dependency with dependency management.
    - Redeployed `api` after dependency wiring.
  verification_summary:
    db_status: running
    api_status: running
    frontend_access_status: needs_validation
    key_error_cleared: true
    app_endpoint_operational: null
    evidence_chain:
      - component_summary
      - connection_envs
      - runtime_logs
    dominant_evidence: "api logs expected DB_* names while provider connection envs were missing from the dependency contract."
    stop_reason: runtime_healthy_ready_for_delivery_verifier
    recommended_next_action: "Run delivery-verifier to confirm final access behavior."
    stop_boundary:
      stopped: true
      delivery_verifier_allowed: true
      code_changes_allowed: false
      local_tests_allowed: false
      commit_or_push_allowed: false
      fallback_used: false
  next_handoff: delivery_verifier
```
````

Only in explicit structured contract mode, respond using exactly these sections:

### Problem Judgment
- state the root cause clearly
- if inferred, say "based on logs and component configuration"
- specify which layer(s) are affected: db, api, frontend-access, overall
- if the current result is `topology_building`, `capacity_blocked`, or `code_or_build_handoff_needed`, say that explicitly here

### Actions Taken
- list the exact changes
- include env changes, dependency changes, port changes, and restart or deploy actions
- if no config change was applied, say so explicitly, for example: `- no changes applied; classified current blocker from fresh runtime evidence`

### Verification Result
Explicitly report four statuses:
- **db status**: `running` / `waiting` / `abnormal` / `capacity-blocked` / `not applicable`
- **api status**: `running` / `waiting` / `abnormal` / `capacity-blocked` / `not applicable`
- **frontend-access status**: `working` / `not working` / `needs validation` / `not applicable`
- **overall status**: `topology_missing` / `topology_building` / `runtime_unhealthy` / `runtime_healthy` / `capacity_blocked` / `code_or_build_handoff_needed`

Also:
- state whether the key error disappeared from logs
- state whether the app can serve user-facing requests or whether that still belongs to delivery validation

### Follow-up Advice
- separate short-term and long-term suggestions
- if a compatibility fix was used, recommend fixing variable compatibility in code or template later
- state handoff needed: yes or no
- if the blocker is cluster capacity, explicitly say application-level repair is paused until scheduling is restored
- if `topology_missing` is observed, explicitly say topology creation must be revisited before further troubleshooting

### Structured Output
- append a fenced `yaml` block as the final section
- render `TroubleshootResult`
- keep enum values and field names aligned with the schema above
- use canonical blocker buckets and runtime labels only

## On-demand references

After the overview and evidence chain identify the dominant class, load only [root-cause rules](references/root-cause-rules.md), [output contract](references/output-contract.md), or [operational reference](references/operational-reference.md) as needed.

## Common Mistakes

- fixing frontend first when the real issue is `api -> db`
- editing envs before checking dependency
- editing env to fix a connection/startup value without first checking for a mounted config-file volume that overrides the same key
- claiming recovery without re-reading logs
- treating component summary as Pod-level root-cause evidence
- assuming `rainbond_get_pod_detail` returns `data.bean`
- continuing to modify the app after it is already `runtime_healthy`
- using guessed db values instead of values derived from current component configuration
- pretending `runtime_healthy` means delivery is complete
- continuing application repair when the real blocker is cluster scheduling capacity or code/build failure
- repeating the same repair pattern more than once against the same blocker bucket in one run
- reading runtime logs first for a source build failure instead of checking component events and build logs
- skipping Pod detail for `ImagePullBackOff`, `ErrImagePull`, `ContainersNotInitialized`, init-container failures, or similar startup blockers
- stuffing source build parameters into `build_info` instead of `replace_build_envs`
- defaulting to Dockerfile or CNB based on file presence alone without applying the Build Mode Selection priority chain (manifest `source.build.strategy` → heuristic by Dockerfile classification + intent signals → ask only when ambiguous); see `rainbond-fullstack-bootstrap/references/source-build-parameter-guide.md`
- promising `dockerfile_path` support when the current MCP surface only exposes `prefer_dockerfile_when_detected`

## Quick Reference

Source resolution summary:
- target app identity: explicit input > `.rainbond/local.json` > baseline project hints
- selected reference environment: explicit input > local default > `preview`
- expected secret and env intent: explicit input > secret file reference > env file reference > baseline env hints
- runtime truth: Rainbond MCP only
- if files disagree with MCP, trust MCP and report drift

Preferred diagnostic branches:

Runtime-unhealthy branch:
1. app detail
2. component list
3. target component summary
4. `rainbond_get_component_pods` when the component is not `running` or summary/logs do not explain startup failure
5. `rainbond_get_pod_detail` for the selected Pod
6. container logs only if Pod detail still lacks enough context

Source-build branch:
1. target component summary
2. component events
3. build logs for the failing `event_id`
4. runtime logs only if build evidence no longer explains the problem

Verification tail:
1. db summary
2. `api` summary again
3. build logs or runtime logs again, depending on the blocker class

Preferred repair order:
1. dependency
2. inner port
3. compatibility envs
4. wrong-value correction
5. restart or deploy

Primary stop conditions:
- source build still running
- source build failed
- external artifact unreachable
- cluster capacity blocked
- frontend access-path issue
- topology unexpectedly missing

Symptom-to-branch lookup:
- pod `FailedMount` with `configmap ... not found` → Rule J (`config_file_configmap_missing`)
