# Rainbond Platform Installer Skill Design

## Goal

Add a dedicated `rainbond-platform-installer` skill that handles the missing-platform branch of the RainSkills self-hosted onboarding flow. When a user selects private deployment but does not yet have Rainbond, the agent should inspect a target machine, install the supported single-node Rainbond edition, verify the Console, return its address, and resume the existing RainSkills authorization flow without making the user repeat earlier choices.

The normal path should require no more than two user decisions after the user says that no Rainbond platform exists. Environment discovery, resource checks, installation monitoring, and health verification should otherwise proceed automatically.

## Scope

The first release supports:

- Linux single-node quick installation on the current machine.
- Linux single-node quick installation over an already configured, non-interactive SSH connection.
- macOS single-node quick installation on the current Mac through OrbStack.
- `amd64` and `arm64` where the official Rainbond quick installer supports them.
- resuming the interrupted RainSkills setup after the new Console URL is known.

Linux is the recommended path. macOS is fully represented in the flow but is presented as slower because OrbStack and the Rainbond runtime artifacts may need to be downloaded first.

The first release does not support:

- provisioning or purchasing a cloud server;
- multi-node, high-availability, offline, air-gapped, or existing-Kubernetes installation;
- remote macOS installation;
- password-based SSH setup or accepting passwords, private keys, API tokens, or other credentials in chat;
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

Option 1 continues to the existing Console URL prompt. Option 2 saves a resumable RainSkills checkpoint and emits a stable machine-readable marker telling the agent to activate `rainbond-platform-installer`.

The original installer must not remain dependent on a long-lived hidden terminal process. It may stop at this checkpoint, but the installed skill files, selected client targets, and deployment choice must be retained. After platform installation, the agent resumes the same setup at Rainbond authorization rather than repeating skill installation or platform selection.

### Compact Normal Path

The agent detects the current operating system before asking how to proceed.

For a suitable current Linux machine, combine target selection, preflight result, installation effects, and confirmation into one response:

```text
检测到当前设备为 Linux，环境检查已通过：

8 核 CPU / 16GB 内存 / 96GB 可用磁盘
网络和所需端口正常

是否直接在当前设备安装 Rainbond？
```

For macOS, present one choice before doing lengthy work:

```text
检测到当前设备为 macOS。

可以安装 Rainbond，但需要准备 OrbStack，下载时间通常比 Linux 更长。
建议使用 Linux 服务器，也可以继续在当前 Mac 安装。

1. 继续在当前 Mac 安装
2. 改用 Linux 服务器
```

When a different Linux host is selected, ask only for an existing SSH target such as `root@192.168.1.20` or a host alias from `~/.ssh/config`. Do not ask for SSH passwords or key contents. Validate connectivity with a non-interactive, read-only probe before continuing.

After the user approves the summarized plan, do not ask separately about Docker, directories, individual ports, or each installation phase. Additional questions are allowed only for blockers, genuine ambiguity, operating-system permission prompts, or destructive/conflicting remediation.

### Preflight

Run preflight checks as one read-only batch and report a compact pass summary. Check at least:

- supported operating system and architecture;
- CPU and memory against the quick-install baseline;
- usable disk space on the installation data path;
- outbound access required for official installers and images;
- required command availability and privilege strategy;
- availability of ports `80`, `443`, `6060`, and `7070`;
- existing Docker-compatible runtime, OrbStack, Rainbond container, and `/opt/rainbond` state where applicable.

Keep resource thresholds in one versioned reference or helper definition so the skill text, tests, and installer do not diverge. The initial baseline is 4 CPU cores, 8 GB memory, and 50 GB usable disk, subject to alignment with the current official quick-install requirements.

When all checks pass, show only the summary and the final installation confirmation. When checks fail, show only failed or risky checks and a concrete next action. Do not bury the blocker in a full successful-check table.

### Installation

After explicit confirmation, download the official installer to a temporary file before execution. Do not use an opaque `curl | bash` pipeline. Validate the download source and fail closed on an unexpected redirect, empty response, or non-script payload.

The Linux path prepares a supported Docker-compatible runtime when missing and then runs the official Rainbond quick installer. The macOS path first prepares and starts OrbStack, verifies the Docker API, and then runs the same official Rainbond quick-install entry. Do not install a new package manager solely to acquire OrbStack. A macOS system permission dialog is a legitimate user-action pause and must be explained in one short prompt.

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

The deterministic helper should emit both terminal-friendly output and line-delimited structured progress events. A minimum event shape is:

```json
{"schema":"rainskills.platform-progress.v1","stage":"download_images","status":"running","current":8,"total":11,"unit":"layers"}
```

Clients with a streaming terminal can render a progress bar. Clients that batch tool output can render stage changes from the same events. If no new low-level output is available for a bounded interval, emit a heartbeat containing the current stage and elapsed time so the user does not mistake normal work for a hang.

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

The agent then passes the verified Console URL to the RainSkills resume command. RainSkills continues with administrator initialization when needed, browser or device authorization, MCP registration, and verification. The user must not re-enter the URL or repeat earlier installer choices.

## State And Resume

Persist non-secret checkpoints under `~/.rainbond` with mode `0600`. The state model should cover at least:

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

Store target type, non-secret host identifier, current stage, artifact metadata, log path, and verified Console URL. Do not store SSH passwords, private keys, Rainbond credentials, or tokens.

Re-entry must inspect real machine state before trusting a checkpoint. Reuse completed downloads and existing image layers when safe, and resume from the earliest unverified stage. `Ctrl+C` must stop foreground work, clean up temporary callback or helper processes, preserve useful downloaded artifacts, and leave a clear resume instruction.

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
- installer and PTY tests: cover pause/resume, progress rendering, interruption, and terminal behavior.

Do not rewrite existing user-modified installer code unrelated to this flow. The new branch must preserve Rainbond Cloud behavior, explicit `--rainbond-url`, non-interactive token flows, refresh behavior, and existing Codex/Claude installation targets.

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
- Linux current-host happy path;
- preflight failures for CPU, memory, disk, network, privilege, and occupied ports;
- existing Rainbond/runtime conflict behavior;
- non-interactive SSH validation and rejection of password prompts;
- macOS routing with OrbStack already present and OrbStack missing;
- no mutating command before explicit confirmation;
- real download progress with known and unknown totals;
- stage/readiness output for non-download work without fake percentages;
- heartbeat output during quiet operations;
- interrupt cleanup and checkpoint preservation;
- resume from each durable stage using real-state revalidation;
- concise successful output with a verified Console URL;
- RainSkills checkpoint to platform skill to RainSkills authorization handoff;
- unchanged SaaS, explicit URL, refresh, and non-interactive installer flows;
- npm tarball contains the ninth skill and its resources.

Run focused helper tests, the installer test suite, PTY/signal tests, package tests, and the full `npm test` command before completion.

## Success Criteria

The first version is successful when a novice user can choose private deployment, state that no Rainbond exists, approve at most two normal-path decisions, observe meaningful progress, receive a verified Console address, and continue RainSkills authorization without restarting the onboarding flow or handling a JWT manually.
