---
name: rainbond-opensource-app-deploy
description: "Use when a user wants to deploy an open-source application that is absent from the Rainbond app market from docker-compose, Docker Compose, a Helm chart, or container image set, including requests such as 把这个开源应用部署到 Rainbond, 按 docker-compose 部署 XXX, or deploy this compose stack on Rainbond. Not for the user's own source or private-image project; use rainbond-app-assistant. Not for an app already available in the market; use rainbond-template-installer."
---

# Rainbond Open-source App Deploy

<!-- rainskills-runtime-gate:start -->
## 运行环境门禁（最高优先级）

### CLI 调用格式（强制）

所有可变 `call` 都必须使用完整 argv：`call <tool> --input - --operation-id <uuid> --skill-id rainbond-opensource-app-deploy`。CLI 返回确认 ID 后，只能在同一 argv 末尾加入 `--confirm <confirmation-id>`；不得省略 `--skill-id`、猜测参数，或根据泛化错误反复重试。

### 多运行环境操作契约

Node.js 前置检查通过后，每次请求先执行本地 launcher + `["environment", "list", "--json"]`，按用户明确指定的运行环境选择不可变环境 ID；未指定时只用全局默认环境，默认不可用时停止且不回退。生成 UUID 后执行本地 launcher + `["operation", "begin", "--operation-id", "<uuid>", "--environment-id", "<id>", "--intent-json", "<intent-json>"]`。此后每个 Rainbond 能力调用只能通过受保护的本地 Rainskills CLI 执行，并携带同一 operation ID；CLI 会将 `rainskills_operation_id` 写入审计元数据。环境、团队和应用只属于本次操作，禁止保存项目级绑定；同一项目可以部署到多个环境。明确“团队”表示环境内团队；明确“运行环境/平台”表示环境；裸名称同时匹配环境和团队时必须询问确认。

第一步检查 Node.js 是否存在且主版本不低于 18。Node.js 缺失或低于 18 时，只说明“Rainskills 执行组件需要 Node.js 18 或更高版本”并停止：不选择运行环境，不调用 MCP，不猜测替代命令。只有用户或 agent 明确同意后才安装或升级 Node.js，再从同一原始 intent 继续。

固定 launcher 是 `["node", "<home>/.rainbond/lib/rainskills/bin/rainskills.js"]`；运行包版本标记为 `rainskills@0.1.11`，且必须与本技能包 `package.json` 一致。把 launcher 与参数拼成 argv 数组直接执行，禁止 `rainskills@latest`，禁止拼接或执行 shell 字符串。

本地 launcher 必须从当前 Skill 所在目录的同级目录定位 `rainbond-platform-installer/scripts/local-runtime.js`，解析为绝对路径后使用 `["node", "<绝对路径>"]` 执行。`environment list`、`operation begin`、`operation complete` 和 `runtime message` 只能使用本地 launcher；本地 launcher 只读取已安装文件和本机受保护状态，不得访问 npm 或其它网络。只有用户选定连接或安装运行环境后，才使用固定 launcher。

所有 Rainbond 查询和变更都必须执行本地 `~/.rainbond/bin/rainskills-tools.js`，不得让 Agent 直接调用 Rainbond MCP，也不得启动本地 Rainskills MCP 服务。固定业务 argv 为 `["node", "<home>/.rainbond/bin/rainskills-tools.js", "<status|list|describe|read|call>", "...", "--operation-id", "<uuid>", "--skill-id", "rainbond-opensource-app-deploy"]`；写操作必须只消费 CLI 返回的确认 ID，再用同一 argv 加 `--confirm <confirmation-id>` 执行。

只有 CLI 返回并通过校验的 `rainskills.next-action.v1` argv 才能执行续接。普通失败一律禁止自动重试：不得再次执行原命令，不得执行 `--help`、`sleep`、`rg`、`grep`，不得搜索 Rainskills 源码；同一 `operation complete` 最多执行一次。

<!-- rainskills-runtime-contract:start -->
```json
{
  "schema": "rainskills.skill-runtime-contract.v1",
  "package_version": "rainskills@0.1.11",
    "launcher": ["node", "<home>/.rainbond/lib/rainskills/bin/rainskills.js"],
  "local_launcher": ["node", "<installed-skills-root>/rainbond-platform-installer/scripts/local-runtime.js"],
  "local_argv": {
    "environment-list": ["node", "<installed-skills-root>/rainbond-platform-installer/scripts/local-runtime.js", "environment", "list", "--json"],
    "operation-begin": ["node", "<installed-skills-root>/rainbond-platform-installer/scripts/local-runtime.js", "operation", "begin", "--operation-id", "<uuid>", "--intent-json", "<intent-json>"],
    "operation-complete": ["node", "<installed-skills-root>/rainbond-platform-installer/scripts/local-runtime.js", "operation", "complete", "--operation-id", "<uuid>"],
    "runtime-message": ["node", "<installed-skills-root>/rainbond-platform-installer/scripts/local-runtime.js", "runtime", "message", "--id", "<message-id>"]
  },
  "intents": {
    "opensource-deploy": {"required": ["source_kind"], "optional": ["project_root", "source_url"], "enums": {"source_kind": ["compose", "helm", "images"]}}
  },
  "routes": {"new": ["saas", "private-existing", "install-private"]},
  "connect_argv": {
    "saas": ["node", "<home>/.rainbond/lib/rainskills/bin/rainskills.js", "runtime", "connect", "<target>", "--saas", "--intent-json", "<intent-json>"],
    "private-existing": ["node", "<home>/.rainbond/lib/rainskills/bin/rainskills.js", "runtime", "connect", "<target>", "--rainbond-url", "<rainbond-url>", "--intent-json", "<intent-json>"],
    "install-private": ["node", "<home>/.rainbond/lib/rainskills/bin/rainskills.js", "runtime", "connect", "<target>", "--install-private", "--location", "<private-location>", "--intent-json", "<intent-json>"]
  }
}
```
<!-- rainskills-runtime-contract:end -->

target 只允许 `codex`、`claude`、`pi`、`all`。校验 intent 后只执行 new scope 的完整 argv；只消费 schema 为 `rainskills.next-action.v1` 且完成字段校验后的 `argv` 数组。

连接完成后用固定 `onboarding-id` 执行 launcher + `["intent", "resume", "--onboarding-id", "<同一 onboarding-id>"]`，恢复原始 intent 和 `resume_step`。401 先执行 launcher + `["runtime", "record-failure", "--onboarding-id", "<同一 onboarding-id>", "--step", "<当前固定步骤>", "--reason", "credential-expired"]`，再仅一次执行 launcher + `["runtime", "reconnect", "--onboarding-id", "<同一 onboarding-id>"]` 后 resume，只重试该步骤；第二次 401 停止。403 执行 launcher + `["runtime", "record-failure", "--onboarding-id", "<同一 onboarding-id>", "--step", "<当前固定步骤>", "--reason", "permission-denied"]` 后停止，不得 reconnect、重新授权或自动重试。
<!-- rainskills-runtime-gate:end -->

受限沙箱（包括 Codex）执行本地状态命令时，必须申请用户级受保护目录访问权限；在 Codex 中使用 `require_escalated`。不得修改 `~/.rainbond` 权限、复制受保护状态到工作区，或因沙箱权限错误建议重装。

执行优化：同一会话内只检查一次 Node.js（首次使用本地 CLI 前）；仅在 Node.js 或 Rainskills 安装、升级，或 PATH 变更后失效。固定 launcher 和 argv 已在本 Skill 中，禁止读取、搜索或探测 `rainskills.js`，也禁止执行 `npm root -g`。每个新的业务操作仍需要刷新一次环境列表；带已有 `operation_id` 或 `onboarding-id` 的续接复用已绑定的环境 ID，不重复枚举环境。

<!-- rainskills-runtime-routing:start -->
## 缺少运行环境时

先说：“可以，我会帮你部署未收录到应用市场的开源应用。不过目前还没有可用的应用运行环境。你刚安装的 Rainskills 是 AI 部署助手，它负责分析项目并执行部署；应用实际会运行在 Rainbond 上。Rainbond 是一套应用运行和管理平台，负责容器运行、域名访问、日志和存储等工作，你不需要了解 Kubernetes。”

#### 选择运行环境

请提示“请选择应用要运行的环境：”，并只显示：

1) 云端环境（免费体验）
2) 私有环境（去对接）

用户选择私有环境后，执行本地 launcher + `["runtime", "message", "--id", "private-deployment-location"]`，并原样显示：

请选择部署位置：

1、部署到本机
2、部署到独立服务器
3、部署到已有 Rainbond

选择 1 时执行 `install-private` 并使用 `["--location", "local"]`；选择 2 时执行 `install-private` 并使用 `["--location", "server"]`；选择 3 时执行本地 launcher + `["runtime", "message", "--id", "private-console-origin"]` 后执行 `private-existing`。不得在运行环境准备完成前继续读取或修改部署描述文件。
<!-- rainskills-runtime-routing:end -->

## 部署类 skill 怎么选

- 应用市场里有的应用 → `rainbond-template-installer`（一键安装商店模板）
- 市场里没有的开源软件（有 docker-compose、Helm 或镜像）→ `rainbond-opensource-app-deploy`
- 部署你自己写的项目（源码或私有镜像）→ `rainbond-app-assistant`

Do not continue with this skill when either neighboring route applies. This skill owns the missing-from-market, upstream-descriptor-driven deployment path only.

## Overview

Turn an upstream application's official deployment material into a working Rainbond application. Derive the topology from evidence, create and connect every component, preserve state, then iterate until runtime health, the real external entry, and the application's UI or core flow all pass.

**Core principle:** importing images is not completion. Completion means the topology is evidence-backed and the deployed application works through its real user-facing entry.

Use the protected local Rainskills CLI as the only transport for Rainbond runtime truth. Never call Rainbond MCP directly, start a local Rainskills MCP service, or invent component state, internal addresses, credentials, or external URLs.

## Progress checklist

Track this checklist throughout the run:

```text
Open-source deployment:
- [ ] 0. Official topology derived
- [ ] 1. Components, dependencies, ports, env, and storage modeled
- [ ] 2. Required upstream documentation obtained
- [ ] 3. Deployment reached terminal build states
- [ ] 4. All component health checked
- [ ] 5. Every blocker converged or stopped within budget
- [ ] 6. Real entry and UI/core smoke verified
```

## 0. Derive the official topology

Before any Rainbond write, obtain the upstream project's official `docker-compose.yml`, Compose fragments, Helm chart values/templates, image documentation, and installation guide. Prefer a pinned release or image tag over an unbounded moving tag.

Build one deployment inventory from those sources:

- every required service and its image, tag, command, and role
- container ports and which single service is the intended user entry
- required environment variables, secrets that must come from the user, and defaults
- every provider/consumer relationship from `depends_on` and from host references embedded in env, URLs, DSNs, callbacks, and proxy configuration
- named volumes, bind mounts, data directories, and volumes shared by multiple services
- health checks, initialization jobs, profiles, anchors, `env_file` inputs, and config files
- reverse-proxy routes and same-origin browser requirements

Do not reconstruct a complex suite from model memory when the official descriptor is unavailable. Ask for the descriptor or permission to use a clearly named official alternative before writing runtime state.

If the application is actually available in the Rainbond market, stop and route to `rainbond-template-installer`.

For Helm input, pin the chart version and merge the user's values before deriving the inventory. Render with the upstream-supported `helm template` path when available. Map the rendered intent as follows:

- Deployment or StatefulSet workloads → long-running Rainbond components backed by their declared images
- Service ports → Rainbond inner/outer ports; Ingress routes → the single external entry and proxy routing
- persistent volume claims → evidence-backed persistent storage requirements
- ConfigMaps and non-secret files → `config-file` mounts; Secrets → user-supplied secret inputs that are never printed
- startup/readiness/liveness probes → `rainbond_manage_component_probe`
- init containers, Jobs, hooks, privileged host integration, operators, and custom resources → explicit compatibility decisions, not silent omission

If a chart relies on Kubernetes behavior that cannot be represented safely by current Rainbond component capabilities, stop with a semantic-compatibility blocker. Do not claim that reading a chart is equivalent to installing it unchanged.

## 1. Import components and model the deployment

Create or reuse the target Rainbond application, then model the inventory in dependency order.

1. Create every image-backed component with `rainbond_create_component_from_image` and keep initial deployment disabled until its ports, env, dependencies, storage, and config files are ready.
2. Configure inner ports first. Enable an outer port only on the intended external entry. Add the port with `rainbond_manage_component_ports`, then call `rainbond_manage_component_ports(operation=update_alias)` for that port to set `port_alias` and `k8s_service_name`; do not assume the add call persisted both values.
3. Create every accepted provider/consumer edge with `rainbond_manage_component_dependency`, including both declared `depends_on` edges and edges implied by URLs, DSNs, callbacks, or proxy upstreams.
4. Configure provider-side connection variables with `rainbond_manage_component_connection_envs`, then let explicit dependencies inject them. Keep consumer-local env only for names or combined URLs the application itself requires. Ask for missing secrets without displaying or persisting them in reports.
5. Attach persistent storage to every stateful data directory before deployment. For image-created stateless components, use `rainbond_manage_component_storage` with an explicit `volume_name`, `volume_type=share-file`, and the official `volume_path`. When multiple components must see the same files, mount the same shared writable volume on each required component. Never invent a storage class, host path, or retention guarantee. If the upstream requires local, block, or single-writer stateful semantics that the available component cannot preserve, stop and report the mismatch instead of silently weakening it.
6. Mount required proxy or application config as `config-file` storage before deploying the component that consumes it.
7. Preserve health probes through `rainbond_manage_component_probe`. Run one-shot initialization only through an evidence-backed supported path; do not create a long-running component that is expected to exit successfully and then misclassify its restart loop as health.

If any required MCP capability above is unavailable, stop with a capability blocker and name the missing operation. Do not silently emulate it with an unsafe delivery-mode or storage-semantic change.

### Component addressing

Prefer **port alias injection**:

- set the provider port alias to the env prefix expected by the consumer
- create the explicit dependency edge
- consume the platform-injected `<PREFIX>_HOST` and `<PREFIX>_PORT`
- do not copy a Compose service name or hard-code a container-local hostname into Rainbond env

When a hostname must be embedded inside a URL, DSN, callback, or connection string, set a semantic internal domain with `k8s_service_name` and render that verified domain into the value. Use DNS-safe hyphenated names. If deploying another copy in the same namespace, choose unique internal domains and rewrite every matching reference consistently.

Before any env write on a component with dependency-injected or port-alias env, run `rainbond_analyze_env_conflicts`. Do not create a local env that collides with an injected `_HOST` or `_PORT` value.

### Deployment best practices

1. **Explicit dependency edges.** Runtime DNS reachability is not a substitute for a Rainbond dependency. Verify the final accepted edge set is complete.
2. **Single reverse-proxy entry.** When browser UI and APIs require same-origin path routing, retain the official proxy, mount its routing config, wire every proxy-to-upstream edge, and expose only the proxy externally. Never deploy a stock proxy without its routing config.
3. **Persistent storage for state.** Databases, uploaded files, generated keys, and other durable state must survive restart. Verify storage is mounted at the official data path and is writable by the running process.

## 2. Acquire documentation on two tracks

Classify each blocker before searching:

- **Configuration-class:** missing required env, wrong provider address, dependency not wired, storage path absent, config file overriding env. Use logs, Rainbond evidence, the deployment inventory, and [references/failure-mode-playbook.md](references/failure-mode-playbook.md) first.
- **Protocol/framework-class:** the process is healthy but login, encryption, callbacks, cookies, setup, or a framework-specific operation behaves incorrectly. Search the official upstream source, README, issue tracker, or operations guide before changing runtime state.

When clean logs conflict with broken user behavior, treat that as protocol/framework-class. Do not guess a destructive storage or database repair from a browser symptom.

## 3. Deploy and wait for terminal build states

Deploy only after the step 1 readiness gates pass. Use `rainbond_operate_app` for the deployment and `rainbond_wait_for_build_completion` for each returned build event.

- Keep waiting with the same anchored event while the tool reports `running`.
- Treat the terminal result and its classified reason as evidence.
- Do not replace the bounded wait with repeated unanchored status polling.
- A slow image pull is not a failure by elapsed time alone; distinguish active pulling from a terminal image-pull error.

## 4. Check application health

Use `rainbond_get_app_health_overview` as the default whole-application signal. Inspect each abnormal component's blocker, then obtain the minimum supporting pod, event, log, env, dependency, port, and storage evidence needed to explain it.

Continue to step 6 only when every required component is green. If any required component is building, waiting, abnormal, or capacity-blocked, continue to step 5.

## 5. Diagnose, repair, and converge

Read [references/failure-mode-playbook.md](references/failure-mode-playbook.md) when the evidence matches one of its deployment patterns.

Use `rainbond-fullstack-troubleshooter` as the repair engine for existing-component build or runtime blockers. Follow its `RuntimeState` classification, evidence order, config-override gate, connection contract, event anchoring, destructive-action boundary, and attempt budget.

For each blocker:

1. Collect fresh anchored evidence.
2. Classify the blocker and choose the smallest evidence-backed repair.
3. Before env changes, run the env-conflict check and inspect mounted config files that may override env.
4. Announce and apply one known low-risk Rainbond-side repair. Ask before destructive, data-mutating, broad, or low-confidence actions.
5. Redeploy only the affected scope, wait for its terminal event, then return to step 4.

Budget rules:

- Allow at most one repair attempt for the same blocker signature, then re-verify.
- If the same signature remains, stop and report the evidence and required human decision.
- Stop after three distinct repair attempts in one run, or after two consecutive health passes with no material improvement.
- Stop immediately for a confirmed unreachable upstream image, cluster capacity failure, or source-code/build defect that Rainbond configuration cannot repair.
- Repeated identical read-only checks without new anchored evidence do not count as progress.

## 6. Pass the delivery gate

Completion requires all of the following:

1. `rainbond_get_app_health_overview` shows every required component green.
2. Read the real external entry from Rainbond `access_infos`; never fabricate or infer a URL.
3. If official documentation requires a public base URL, callback URL, trusted proxy, or secure-cookie setting, use that real entry to complete the two-phase public-URL configuration, redeploy once, and read `access_infos` again.
4. Verify that real entry is reachable through the intended proxy or application component.
5. Perform an application-specific **UI smoke** or core-flow smoke through the real entry, not only a root-path status check. Examples include loading the setup/login UI, signing in with user-provided test credentials, creating a minimal object, or completing the application's primary read/write flow.
6. Recheck stateful storage and the explicit dependency set after the smoke test.
7. When durable application state is part of the acceptance target, perform one controlled restart and verify the smoke-created object or equivalent state is still readable.

If UI automation is unavailable, stop at `needs manual UI validation`; provide the real entry and exact manual steps, but do not call the deployment complete.

Report concisely:

- topology created and external entry component
- component health and any intentionally omitted optional services
- explicit dependencies and persistent/shared storage verified
- real access URL from `access_infos`
- UI/core smoke performed and result
- unresolved blocker, if any, plus the exhausted attempt budget

## Common mistakes

- Treating image import or all-green containers as final delivery.
- Copying Compose service names directly into consumer env.
- Wiring only `depends_on` while missing env-reference or proxy edges.
- Exposing web and API separately when the official UI assumes one origin.
- Deploying a reverse proxy before mounting its routing config.
- Deploying a database or generated-key directory without persistent storage.
- Editing env while a mounted config file supplies the effective value.
- Declaring a slow image pull failed before its event reaches a terminal state.
- Testing a browser protocol with an incompatible plain HTTP request and misdiagnosing the result.
- Reporting a guessed URL instead of Rainbond `access_infos`.
