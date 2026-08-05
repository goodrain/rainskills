# Rainbond Platform Installer Skill Design

> Implementation scope for `0.1.0-rc.3`: the first shipped slice covers current-host Linux and current-host macOS single-node installation, checkpoint/resume, verified Console discovery, and handoff back to existing Codex/Claude authorization. Remote SSH installation and OpenClaw registration remain follow-up work and must not be advertised as available in this release.

## Goal

Add a dedicated `rainbond-platform-installer` skill that handles the missing-platform branch of the RainSkills self-hosted onboarding flow. When a user selects private deployment but does not yet have Rainbond, the agent should inspect a target machine, install the supported single-node Rainbond edition, verify the Console, return its address, and resume the existing RainSkills authorization flow without making the user repeat earlier choices.

The normal path should require no more than two user reply turns after the user says that no Rainbond platform exists: one reply may select or identify the target, and one reply confirms the detected installation plan. Environment discovery, resource checks, installation monitoring, and health verification should otherwise proceed automatically.

## Scope

The first release supports:

- Linux single-node quick installation on the current machine.
- Linux single-node quick installation over an already configured, non-interactive SSH connection.
- macOS single-node quick installation on the current Mac through OrbStack.
- `amd64` and `arm64` where the official Rainbond quick installer supports them.
- resuming the interrupted RainSkills setup after the new Console URL is known.
- end-to-end browser authorization when `npx rainskills` runs on a browser-capable control machine.
- skill and Rainbond MCP registration for Codex, Claude Code, and OpenClaw.

Linux is the recommended path. macOS is fully represented in the flow but is presented as slower because OrbStack and the Rainbond runtime artifacts may need to be downloaded first.

The first release does not support:

- provisioning or purchasing a cloud server;
- multi-node, high-availability, offline, air-gapped, or existing-Kubernetes installation;
- remote macOS installation;
- accepting passwords, private keys, API tokens, or other credentials in chat or storing them in Rainskills; password authentication remains available only through the attached system OpenSSH client;
- a server-side Device Authorization Flow for a control machine with no usable browser;
- silently stopping conflicting services, deleting existing containers or data, changing firewall rules, or resizing infrastructure.

## Skill Ownership And Triggering

Create a top-level skill named `rainbond-platform-installer`.

It should trigger when the user asks to install or set up the Rainbond platform itself, or when the RainSkills self-hosted onboarding flow establishes that the user has no Rainbond platform. Representative prompts include:

- `帮我安装 Rainbond`
- `在这台 Linux 服务器上部署 Rainbond 平台`
- `我选择私有化，但是还没有 Rainbond`
- `通过 SSH 帮我安装一个 Rainbond 单机版`

It must not own requests to deploy an application onto an existing Rainbond platform. Those remain owned by `rainbond-app-assistant` and its lower-level skills.

Unlike the existing application skills, this skill must not require Rainbond MCP during preflight or installation because the platform does not exist yet. Rainbond MCP becomes relevant only after the Console is healthy and RainSkills resumes account authorization.

## User Journey

### Entry From RainSkills

Extend the interactive self-hosted branch with one compact question:

```text
你现在是否已经有可以访问的 Rainbond 平台？

1. 已经有，填写平台地址
2. 还没有，帮我安装
```

Option 1 continues to the existing Console URL prompt. Option 2 saves a resumable RainSkills checkpoint and emits a stable machine-readable marker telling the agent to start the platform bootstrap command.

The npm launcher must expose these commands in addition to the current default installer:

```text
npx rainskills platform install --onboarding-id <id>
npx rainskills resume --onboarding-id <id>
```

The platform command is the first-install bootstrap path. It is bundled in the npm package and is executable immediately, even though Codex or Claude Code may not discover a newly copied skill until their next session. OpenClaw normally watches managed skill directories, but the bootstrap must not depend on that behavior either. The `rainbond-platform-installer` skill provides the same dialogue policy for later direct requests, while the bootstrap command guarantees that the first installation does not depend on dynamic skill loading.

After writing the checkpoint, `install.sh` exits normally instead of waiting in a hidden terminal. It prints a human resume command and exactly one JSON marker on its own line:

```json
{"schema":"rainskills.next-action.v1","action":"install-platform","onboarding_id":"<uuid>","argv":["platform","install","--onboarding-id","<uuid>"]}
```

The marker contains no shell string to evaluate. Agents must pass the fixed `argv` array back to the same launcher, not execute arbitrary text from the marker. A terminal user may run the displayed command manually. The installed skill files, selected client targets, and deployment choice remain in the checkpoint. After platform installation, the bootstrap command invokes the resume command, which continues at Rainbond authorization rather than repeating skill installation or platform selection.

### Compact Normal Path

The agent detects the current operating system before asking how to proceed.

For Linux, ask whether to use the current device or another Linux server. Pressing Enter defaults to the current device. After selection, combine preflight result, installation effects, and confirmation into one response:

```text
检测到当前设备为 Linux，环境检查已通过：

8 核 CPU / 16GB 内存 / 96GB 可用磁盘
网络和所需端口正常

是否直接在当前设备安装 Rainbond？
```

For macOS, present remote Linux first and the current Mac second before doing lengthy work:

```text
检测到当前设备为 macOS。

可以安装 Rainbond，但需要准备 OrbStack，下载时间通常比 Linux 更长。
建议使用 Linux 服务器，也可以继续在当前 Mac 安装。

1. 使用 Linux 服务器（推荐；提供 SSH 目标，例如 root@192.168.1.20）
2. 继续在当前 Mac 安装
```

For Windows, explain that Rainbond cannot be installed on the current device and ask only for a remote Linux SSH target. Never show a macOS option.

When a different Linux host is selected, accept only an SSH target such as `root@192.168.1.20` or a host alias from `~/.ssh/config`. If the user selected option 2 without the target, ask the one missing-field question, but classify that as a corrected incomplete reply rather than a normal extra decision. First validate connectivity with a non-interactive, read-only probe. When authentication or first-use host trust is required, keep the terminal attached and let the system OpenSSH client prompt once; never ask for SSH passwords or key contents in chat and never store them in Rainskills.

After the user approves the summarized plan, do not ask separately about Docker, directories, individual ports, or each installation phase. Additional questions are allowed only for blockers, genuine ambiguity, operating-system permission prompts, or destructive/conflicting remediation.

### Preflight

Run preflight checks as one read-only batch and report a compact pass summary. Check at least:

- supported operating system and architecture;
- CPU and memory against the quick-install baseline;
- usable disk space on the installation data path;
- outbound access required for official installers and images;
- required command availability and privilege strategy;
- availability of ports `80`, `443`, and `7070`;
- existing Docker-compatible runtime, OrbStack, Rainbond container, and `/opt/rainbond` state where applicable.

Keep resource thresholds in one versioned reference or helper definition so the skill text, tests, and installer do not diverge. Version 1 freezes the RainSkills product baseline at 4 CPU cores, 8 GB memory, and 50 GB usable disk. The policy also records the tested official quick-installer URL, detected Rainbond release, allowed redirect origins, and expected script digest. Updating that policy is a reviewed package release, not a runtime guess.

When all checks pass, show only the summary and the final installation confirmation. When checks fail, show only failed or risky checks and a concrete next action. Do not bury the blocker in a full successful-check table.

### Installation

After explicit confirmation, download the official installer to the operation workspace before execution. Do not use an opaque `curl | bash` pipeline. Require HTTPS, allow only origins recorded in the package policy, and fail closed on an unexpected redirect, digest mismatch, empty response, or non-script payload. Record the final URL, digest, and detected Rainbond version in the non-secret operation metadata.

The tested official Linux quick installer changes more than Rainbond files: depending on detected state, it can stop and disable `firewalld` or `ufw`, disable swap and edit `/etc/fstab`, load and persist a kernel module, install or start a container runtime, and launch a privileged container. Preflight must detect which of these effects apply. The single final confirmation must list the applicable effects explicitly; a generic “install Rainbond” confirmation is insufficient. Declining that confirmation stops before the official script runs. No script rewriting or partial bypass of these prerequisites is part of version 1.

The local Linux path executes the helper, installer, logs, and verification on the current Linux host. It requires either UID 0 or previously working non-interactive `sudo -n`; it never opens a password prompt.

The remote Linux path keeps the authoritative onboarding and operation checkpoints on the local control machine. It creates a non-secret remote workspace at `~/.rainbond/platform-installer/<operation-id>/` for the downloaded script and remote log. It first probes with `ssh -o BatchMode=yes`; if native interaction is required, OpenSSH establishes a temporary multiplexed connection and all later `ssh` / `scp` calls reuse it in batch mode. The password remains inside OpenSSH. The target requires remote UID 0 or `sudo -n`. The official installer remains a foreground child of a remote wrapper. `INT` or `TERM` reaches that wrapper, which terminates its installer process group before the local SSH process exits and closes the control connection. Re-entry reconnects and inspects real remote container, filesystem, and service state rather than trusting the local stage alone. Local verification checks Console reachability from the control machine; remote verification checks containers, K3s, and listening ports on the target.

The macOS path executes the official script on Darwin while Docker commands target the verified OrbStack context. Preflight checks both Mac resources and the OrbStack Linux VM allocation. OrbStack must already be installed or be downloaded from its official signed distribution after user confirmation; do not install a new package manager solely to acquire it. Starting OrbStack or accepting a macOS system permission dialog is a legitimate user-action pause and must be explained in one short prompt. Rainbond and K3s run inside the privileged `rainbond` container, so K3s and component verification runs through `docker exec rainbond ...`, not against the Darwin host.

Never automatically stop an occupied service, remove an existing Rainbond installation, delete `/opt/rainbond`, or overwrite an unknown Docker context. Detect these conditions and ask for a decision or stop with remediation guidance.

### Progress Experience

Use real measurements where available and phases where percentages would be fabricated.

For downloads with a known total, display bytes, speed, and percentage:

```text
下载 Rainbond 镜像
[███████████████░░░░░] 76%  8/11 层
```

When the total size is unknown, display downloaded bytes, current speed, and elapsed time without a percentage:

```text
下载 Rainbond 镜像
已下载 312MB  当前速度 7.8MB/s  用时 00:42
```

For runtime startup, display observable milestones and readiness rather than a synthetic percentage:

```text
[1/4] 运行环境已就绪
[2/4] Rainbond 镜像已准备
[3/4] Rainbond 组件 7/9 Ready
[4/4] Console 健康检查中
```

The deterministic helper has three output channels: human progress on stdout, actionable diagnostics on stderr, and append-only JSONL events in the operation's `events.jsonl`. When file descriptor 3 is supplied by the launcher, each JSON event is also written to FD 3 for live machine consumption. Raw installer output goes only to the protected operation log and never shares the JSONL stream.

A minimum event shape is:

```json
{"schema":"rainskills.platform-progress.v1","operation_id":"<uuid>","sequence":18,"timestamp":"<RFC3339>","stage":"download_images","status":"running","current":8,"total":11,"unit":"layers","elapsed_seconds":42}
```

Valid statuses are `started`, `running`, `waiting_user`, `completed`, `failed`, and `interrupted`. Each operation begins with `started`, ends with one terminal status, and uses a monotonically increasing sequence. A parser translates only recognized download-layer, container, K3s, and HTTP probe evidence; unknown raw lines do not advance progress. If no new recognized evidence appears for 10 seconds, emit a `running` heartbeat with the current stage and elapsed time but no invented `current`, `total`, or percentage.

Clients with a streaming terminal can render a progress bar. Clients that batch tool output can render stage changes from the persisted events. In-place terminal repaint is allowed only when stdout is a TTY; otherwise output one line per stage change or heartbeat.

Default output hides raw installation logs. Preserve them in a local log file and expose the path on failure or when the user asks for details. Never include credentials or authorization tokens in progress events or logs.

### Verification And Completion

Do not treat installer exit code zero as sufficient. Verify:

- the Rainbond container is running;
- K3s reports a ready node;
- required `rbd-system` components converge to their expected ready state;
- port 7070 is listening;
- the Console HTTP endpoint returns an acceptable response;
- an evidence-backed Console URL can be derived from installer output and reachable host information.

When multiple candidate host addresses exist, prefer an address already proven reachable from the user's context. If reachability cannot be established, return the candidates and ask one focused question rather than guessing a public address.

The successful user-facing result is concise:

```text
Rainbond 部署成功

部署位置：root@192.168.1.20
运行状态：正常
Console 地址：http://192.168.1.20:7070

接下来将连接该平台并完成授权。
```

The local control machine then invokes `npx rainskills resume --onboarding-id <id>`. The resume command owns the loopback callback server on `127.0.0.1`, opens the verified remote or local Console URL in the control machine's browser, and waits for authorization. If the Console has no account yet, the browser flow tells the user to create the first administrator, then automatically reopens the original `/#/cli-auth` URL after initialization or asks for one explicit “已完成初始化” acknowledgement when automatic detection is unavailable. Credentials stay in the browser and are never returned to the agent.

Version 1 supports this complete handoff only when the `npx` control machine can open a browser that can reach the new Console and its own loopback callback. On a truly headless control machine, platform installation still completes and the checkpoint is preserved, but the installer reports that account authorization requires the existing manual fallback or a later Device Authorization Flow. It must not claim full RainSkills readiness or ask the user to paste a JWT into chat.

After the callback returns a valid token, RainSkills registers and verifies the selected MCP clients. Codex and Claude Code continue to use their existing protected environment-variable approach.

OpenClaw is a first-class target with the following versioned CLI contract:

- `openclaw` installs only OpenClaw;
- existing `codex`, `claude`, and `all` values retain their current meanings, with `all` remaining Codex plus Claude Code for compatibility;
- new `all-supported` installs Codex, Claude Code, and OpenClaw;
- the interactive menu retains existing choices 1 through 3, adds 4 for OpenClaw, and adds 5 for all supported clients;
- explicit OpenClaw selection requires the minimum CLI version recorded in `installation-policy.md`; version 1 tests against OpenClaw `2026.7.1` or newer;
- a missing or older OpenClaw binary fails that selected target with its official installation or upgrade guidance and is never silently omitted;
- `--refresh` updates the protected OpenClaw token source, rewrites the MCP definition if its URL changed, safely activates the new state, and probes it just like initial setup.

The OpenClaw adapter installs each skill through `openclaw skills install <local-path> --global` so OpenClaw's install policy is honored. It atomically merges `RAINBOND_JWT=<value>` into `~/.openclaw/.env`: preserve unrelated lines and comments, remove every prior `RAINBOND_JWT` assignment, append exactly one current assignment, use directory mode `0700` and file mode `0600`, reject symlinks or unexpected ownership, and never pass the value in argv. It configures the Rainbond MCP header as the literal template `GRJWT ${RAINBOND_JWT}` rather than embedding the token in `openclaw.json`. A blocked OpenClaw install policy is reported, not bypassed.

`mcp.*` configuration is hot-reloadable, but an already-running Gateway does not inherit a newly written process environment. Therefore, when the Gateway is running, the adapter records its process identity, performs `openclaw gateway restart --safe`, waits for a different ready process, and requires `openclaw gateway status --require-rpc` to pass. A healthy post-restart Gateway proves that `${RAINBOND_JWT}` resolved during startup; `openclaw mcp doctor rainbond --probe` then proves the saved Rainbond server can initialize and list tools. When no Gateway is running, the adapter validates configuration and runs the same MCP probe without starting a service the user did not request. If a managed, foreground, or externally supervised Gateway cannot complete the safe restart, OpenClaw remains unverified and the onboarding checkpoint must not become `configured`.

When verification succeeds, RainSkills atomically marks the onboarding checkpoint `configured`, removes transient callback files, and retains only the non-secret completion record and protected credential files. OpenClaw uses watched skills plus the verified safe Gateway restart when it was already running; existing Codex and Claude Code sessions still receive their platform-specific reload or restart instruction. The user must not re-enter the URL or repeat earlier installer choices.

## State And Resume

Persist non-secret checkpoints under `~/.rainbond` with directory mode `0700` and file mode `0600`. RainSkills owns exactly one onboarding file, `~/.rainbond/rainskills-onboarding-v1.json`. The platform helper owns one operation directory, `~/.rainbond/platform-installer/<operation-id>/`, containing `state.json`, `events.jsonl`, `install.log`, and downloaded artifact metadata. The onboarding file references the platform state path; helper code never writes RainSkills fields directly.

Both JSON state files contain `schema`, integer `version`, UUID `operation_id`, package version, `updated_at`, and `stage`. The onboarding file additionally stores selected client targets, deployment mode, platform state path, and verified Console URL. Platform state additionally stores `status`, target kind, non-secret host identifier, remote workspace path if applicable, artifact URL/digest/version, applicable approved system effects, and last verified evidence. It never stores shell command strings.

Every state update writes a `0600` temporary file in the same directory, flushes it, and atomically renames it over the prior state. Unknown schema versions, mismatched operation IDs, invalid stage transitions, symlinks, or state files not owned by the current user fail closed. The only cross-component protocol is the versioned onboarding file plus the fixed marker and CLI arguments described above.

The onboarding `stage` enum is:

```text
skills-installed
awaiting-platform
platform-ready
authorizing
configured
```

The platform `stage` enum is:

```text
target-selection
preflight
awaiting-confirmation
runtime-preparation
downloading
starting
verifying
platform-ready
rainskills-resume
```

Platform state has a separate `status` enum: `pending`, `running`, `waiting_user`, `completed`, `failed`, or `interrupted`. `configured` is only an onboarding stage, and `interrupted` is only a platform status. Allowed stage and status transitions live in one helper definition shared by validation and tests.

Re-entry must inspect real machine state before trusting a checkpoint. Reuse completed downloads and existing image layers when safe, and resume from the earliest unverified stage. `Ctrl+C` must stop foreground work locally and remotely, clean up temporary callback or helper processes, preserve useful downloaded artifacts, atomically set platform `status` to `interrupted` without inventing a new stage, and leave the exact fixed-argument resume instruction.

## Skill And Helper Structure

The new skill should remain concise and delegate deterministic behavior to bundled resources:

```text
rainbond-platform-installer/
├── SKILL.md
├── agents/
│   └── openai.yaml
├── scripts/
│   ├── preflight helper
│   ├── install/progress helper
│   └── verification helper
└── references/
    ├── installation-policy.md
    └── troubleshooting.md
```

`SKILL.md` owns triggering, dialogue policy, confirmation gates, resource routing, stop conditions, and handoff back to RainSkills. Scripts own machine inspection, command execution, progress events, checkpoints, and health probes. References hold versioned resource thresholds, supported platform details, official endpoints, and bounded troubleshooting decisions.

The skill must use a narrow degree of freedom for installation and cleanup commands. The agent may summarize evidence and choose the appropriate supported path, but it must not invent alternative installation commands or destructive recovery actions.

## Integration Changes

The implementation is expected to touch:

- `install.sh`: add the existing-platform/no-platform choice, checkpoint/resume behavior, stable agent markers, and handoff of the verified Console URL;
- `README.md`: describe the compact private-install path and supported environments;
- npm package metadata/tests: include the ninth skill and all bundled resources;
- `rainbond-platform-installer/`: add the skill and deterministic helpers;
- client target handling: add OpenClaw detection and selection, native global skill installation, protected environment setup, MCP registration, reload, and probe verification;
- installer and PTY tests: cover pause/resume, progress rendering, interruption, and terminal behavior.

Do not rewrite existing user-modified installer code unrelated to this flow. The new branch must preserve Rainbond Cloud behavior, explicit `--rainbond-url`, non-interactive token flows, refresh behavior, and existing Codex/Claude installation targets while adding OpenClaw as a first-class target.

## Security And Safety

- Require explicit confirmation before the first mutating installation command.
- Treat preflight and verification as read-only.
- Never request or echo passwords, private keys, JWTs, access tokens, or API keys in chat.
- Use non-interactive SSH only; guide the user to configure SSH separately when unavailable.
- Pin or otherwise verify downloaded artifacts as far as the official distribution surface permits.
- Keep tokens out of URLs, progress events, logs, command arguments, and checkpoints.
- Do not change firewalls, security groups, occupied services, Docker contexts, or existing Rainbond data without a separate explicit decision.
- Redact sensitive values from captured subprocess output before presenting it to the user.

## Error Handling

Classify failures into user-actionable buckets:

- unsupported environment;
- insufficient resources;
- port or existing-runtime conflict;
- privilege or SSH failure;
- network or artifact download failure;
- OrbStack installation or startup failure;
- Rainbond/K3s startup failure;
- Console verification or reachability failure.

Retry only transient, idempotent checks or downloads. Do not automatically repeat installation after a mutating failure without first inspecting actual state. Never delete a partial installation as an implicit retry strategy.

## Validation

Add isolated tests with fake system commands and temporary homes. No CI test may install Docker, OrbStack, K3s, or Rainbond, contact a live private host, open a real browser, or mutate the developer machine.

Required coverage includes:

- skill metadata triggers platform installation and excludes application deployment;
- first-install bootstrap works before the host reloads newly copied skills;
- onboarding and platform state schemas, ownership, atomic writes, stage transitions, and fixed JSON marker contract;
- Linux current-host happy path;
- preflight failures for CPU, memory, disk, network, privilege, and occupied ports;
- existing Rainbond/runtime conflict behavior;
- non-interactive SSH validation and rejection of password prompts;
- macOS routing with OrbStack already present and OrbStack missing;
- no mutating command before explicit confirmation;
- detected firewall, swap, module, runtime, and privileged-container effects appear in that confirmation;
- remote workspace, `sudo -n`, foreground process-group cleanup, and reconnect verification behavior;
- macOS execution against the OrbStack context and K3s probes through the Rainbond container;
- real download progress with known and unknown totals;
- stage/readiness output for non-download work without fake percentages;
- JSONL sequencing, separate output channels, terminal statuses, and 10-second heartbeat output during quiet operations;
- interrupt cleanup and checkpoint preservation;
- resume from each durable stage using real-state revalidation;
- concise successful output with a verified Console URL;
- RainSkills checkpoint to platform skill to RainSkills authorization handoff;
- first-administrator browser flow and browser-capable loopback callback ownership;
- headless control-machine stop state does not claim full readiness or expose JWTs;
- OpenClaw native skill install policy, protected token environment, MCP reload, and live probe behavior;
- backward-compatible `all`, new `openclaw` and `all-supported` target parsing, interactive choices, missing/old binary failures, and refresh behavior;
- atomic `~/.openclaw/.env` merge without duplicate token assignments or unrelated-line loss;
- running Gateway safe restart with changed process identity, RPC readiness, and post-restart Rainbond MCP probe;
- unchanged SaaS, explicit URL, refresh, and non-interactive installer flows;
- npm tarball contains the ninth skill and its resources.

Run focused helper tests, the installer test suite, PTY/signal tests, package tests, and the full `npm test` command before completion.

## Success Criteria

The first version is successful when a novice user on a browser-capable control machine can choose private deployment, state that no Rainbond exists, finish target selection and confirmation in at most two normal-path reply turns, observe meaningful progress, receive a verified Console address, and continue RainSkills authorization without restarting the onboarding flow or handling a JWT manually. A headless control machine is successful only through verified platform deployment plus a preserved, truthful authorization checkpoint until Device Authorization Flow support is added.
