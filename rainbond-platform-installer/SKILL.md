---
name: rainbond-platform-installer
description: Use when Rainskills private onboarding establishes that no reachable Rainbond exists and the user wants a local, server, multi-node host, or existing Kubernetes installation target.
---

# Rainbond Platform Installer

平台安装只负责准备应用运行环境。它把受保护的原始 intent 当作不透明的恢复信息；在本地单机、服务器单机、主机集群和已有 Kubernetes 安装完成并验收之前，不得询问或收集应用来源，包括本地项目路径、Git 仓库 URL、镜像地址或安装包路径。平台完成后再恢复原始 intent，由对应业务 Skill 进入项目识别。

This is an internal Rainskills onboarding capability. Do not present it as a separately installable marketplace product.

## Fixed User Message Protocol

当 helper 输出 `[RAINSKILLS_USER_MESSAGE_BEGIN:<id>]` 与对应的 `[RAINSKILLS_USER_MESSAGE_END:<id>]` 时，用户可见回复必须原样输出两者之间的正文，不得输出 marker 本身。

- 不得总结、改写、调整项目符号或追加解释、来源、验证结论和下一步。
- 一次只处理当前消息块；用户选择后只执行 helper 给出的固定 argv，不自行设计问题或命令。
- 平台安装和授权必须留在原 AI 任务中执行；不得让用户把完整的 `platform install` 命令复制到外部终端。
- helper 无法免密连接 SSH 时，无论当前任务是否有 TTY，都必须原样展示 `platform.ssh-authentication` 固定消息并停止。不得在 AI 任务中等待或读取 SSH 密码。
- 单台服务器只执行消息中的精确 `ssh prepare` 命令；主机集群只执行一条 `ssh prepare-cluster --cluster-config <受保护文件>` 命令。两种命令都只生成/复用默认 ED25519 公钥并准备免密连接，不安装 Rainbond，也不修改 onboarding、运行环境或授权状态。
- Agent 不得自行运行 `ssh-keyscan`、`ssh-copy-id` 或修改 `known_hosts`；只能让用户执行 helper 给出的版本锁定 `ssh prepare` 或 `ssh prepare-cluster` argv。
- 用户回复“已完成”后，使用同一版本 launcher 和同一 `onboarding-id` 重新执行原来的 `platform install` argv；不要重新询问部署位置、安装模式、节点或应用来源。
- 授权进程必须保持附着并自动检测授权完成，不得要求用户回复“已授权”。

## Trigger Boundary

Use this skill when the user wants to install the Rainbond platform itself, or when Rainskills private onboarding produced a `rainskills.next-action.v1` marker with `action=install-platform`.

Do not use it to deploy an application to an existing Rainbond. Route those requests to `rainbond-app-assistant`.

## Workflow

1. Read [installation-policy.md](references/installation-policy.md).
2. Use the package-version launcher `["npx", "--yes", "rainskills@0.1.5"]`; its version must equal this package's `package.json`. For a Rainskills marker, first validate schema `rainskills.next-action.v1`, action, onboarding id, and the bounded `argv` array, then append that array to the launcher. Never use `latest` or evaluate a shell string from output.
3. 在任何平台安装命令之前，先执行 launcher + `["runtime", "message", "--id", "private-deployment-location"]`，并原样输出固定的三项部署位置消息。选择 1 后执行带 `["--location", "local", "--mode", "single-node"]` 的 `platform install`；选择 2 后执行带 `["--location", "server"]` 的 `platform install`，由 helper 继续显示固定的服务器类型消息；选择 3 后执行 launcher + `["runtime", "message", "--id", "private-console-origin"]` 并进入已有环境连接，不得执行 `platform install`。若是没有原始业务 intent 的直接平台安装请求，已有环境连接使用受限 `{"type":"environment-add"}` intent。
4. Let the helper perform one read-only preflight against the already selected local or remote target, then show resources, blockers, and applicable host changes. Never invoke `platform install` without an explicit `--location`; the helper must not ask for the deployment location again.
5. Obtain explicit confirmation before sending `y` to the waiting process or rerunning the exact command with `--yes`.
6. 如果 helper 输出 `platform.ssh-authentication`，只原样展示该正文并等待用户回复“已完成”。单台服务器消息包含一条 `ssh prepare`；主机集群消息必须一次列出全部未就绪节点及一条 `ssh prepare-cluster`，不得按节点拆成多轮。随后在原任务中重跑同一安装 argv。否则保持操作附着并让 helper 下载、安装和验证，不得只凭官方脚本退出码推断成功。
7. Let the helper probe its ordered Console candidates from the control machine. If it emits `RAINSKILLS_USER_INPUT_REQUIRED:console_address`, ask for one public IP or DNS name and rerun the same fixed argv with `--console-host <host>` appended.
8. On success, allow the helper to resume Rainskills authorization automatically. The user completes login and authorization in the browser.

<!-- rainskills-platform-routing:start -->
## Progressive Target Routing

第一层原样展示：

```text
请选择部署位置：
1、部署到本机
2、部署到独立服务器
3、部署到已有 Rainbond
```

- 本机：直接安装单机版，不展示 ROI 或 Kubernetes 选项。
- 已有 Rainbond：连接用户提供的现有环境，不进入平台安装。
- 独立服务器：原样展示第二层：

```text
请选择服务器类型：
1、单台服务器（Linux）
2、三台及以上服务器（Linux）
3、已有 Kubernetes 集群
```

主机集群驱动仍支持导入或恢复 1、2 或 N 台 Linux 主机的有效配置；etcd 节点数必须是正奇数。

主机集群第一次进入 configuration 阶段时，必须自动生成受保护的三节点 `cluster.yaml` 示例文件并停止等待。必须原样转发安装器固定消息，其中包含可点击的 `cluster.yaml` 文件链接和当前系统的打开命令，以及“一次性修改服务器地址、SSH 端口和节点角色、填写每台服务器的 password，完成后回复‘已完成’”；不得只给文件路径，也不得逐台询问节点字段。每个 `hosts` 节点必须包含空的 `password` 字段和一次填写备注；用户只在权限为 `0600`（Windows 为仅当前用户可读写）的本地文件中填写真实值。密码不得输出到聊天、日志、状态或错误信息。生成模板仍禁止 private key、Token 或其他 secret 字段。

用户继续同一 onboarding 时，读取同一份受保护文件并一次性列出全部可确定的 YAML、节点、角色、bootstrap、etcd 和存储问题。存在问题时不得发起 SSH、下载或安装；配置通过后展示节点数、etcd 数量、bootstrap 和存储模式，直接检查并准备全部节点的 SSH 免密连接。已有 `--cluster-config` 高级导入仍保留原始字节和未知字段。

SSH 免密连接检查必须先检查全部节点。存在未就绪节点时，一次列出全部未就绪节点的序号、名称、IP 和端口，只输出一条版本锁定的 `ssh prepare-cluster --cluster-config <受保护文件>` 命令。该命令在系统终端依次准备所有节点，已经可以免密连接的节点自动跳过；完成后用户只统一回复一次“已完成”。不得发现一台就暂停，也不得逐台要求用户执行命令和回复。

主机集群分支不得在执行 ROI 前自行检查 CPU、内存、磁盘容量、端口、安装源、网络或已有 RKE2/Rainbond，也不得根据这些检查阻断安装。SSH 就绪后直接展示拓扑和系统变更并请求一次明确确认；确认后只允许用固定 `uname -m` 查询 bootstrap 节点架构，以选择 `roi-amd64` 或 `roi-arm64`，其余安装条件交给 ROI 判断。

只有进入对应分支后才询问该分支参数。主机集群使用 ROI；已有 Kubernetes 使用 Helm。不要向选择本地的用户解释这些实现细节。
<!-- rainskills-platform-routing:end -->

## Fixed CLI Handoffs

- 通用：`platform install --onboarding-id <id> --location <local|server> --mode <single-node|host-cluster|existing-kubernetes>`
- 主机集群：可追加 `--cluster-config <path>`。
- 已有 Kubernetes：使用 `--kubeconfig <path> --kube-context <name>`，可追加 `--values <path> --chart-version <version>`。
- 非交互确认只接受在展示预检/变更后追加的 `--yes`；不能把缺少确认当作同意。

始终把参数作为固定 argv 传给同一个 launcher，不拼 shell 字符串。Console 地址先锁定并验证 origin；HTTPS 跨 origin 跳转要重新确认，明文 HTTP 只在用户明确确认可信内网后使用。

取消或失败时保留受保护断点并输出固定重试 argv。恢复时锁定原目标、配置原始字节和已验证制品；检测到主机、集群 identity、版本或摘要漂移就停止。成功必须分别验证平台组件和 Console，再用同一 `onboarding-id` 恢复原始 intent。

## Interaction Rules

- Linux、macOS 和 Windows 都只能使用 Progressive Target Routing 中同一份三项部署位置消息，不得根据操作系统生成另一套选项或默认选中任何位置。
- 选择部署到本机后再按控制端系统进入对应本地实现：macOS 使用 OrbStack；Windows 使用专用 WSL2 发行版和固定 `local-windows` helper。不要把这些实现差异写入第一层选择文案。
- Do not ask the user to understand or enter WSL commands. Show the read-only checks first, then explain UAC, downloads, host networking, and a possible Windows reboot before requesting confirmation.
- Let the fixed helper request UAC. If Windows must reboot, preserve the checkpoint and use only the verified resume task or exact printed resume command.
- Remote Linux single-node accepts an existing `user@host` value or SSH config alias. The installer first performs a non-interactive key probe. If it fails, the only allowed branch is the fixed system-terminal `ssh prepare` flow; TTY availability must not change this behavior.
- 指纹确认和一次 SSH 密码只允许发生在用户主动执行的 `ssh prepare` 或 `ssh prepare-cluster` 进程中，由系统 `ssh` 直接读取。成功后所有安装、传输和验收均使用 `BatchMode=yes`，不得再次请求密码。
- SSH 准备完成后不得在系统终端继续安装或授权。浏览器授权仅在原 AI 任务的平台验收成功后发生一次；授权完成后用同一 `onboarding-id` 自动恢复原始应用操作。
- Never ask the user to provide passwords, private keys, JWTs, Tokens, or other credentials in chat.
- For `--console-host`, accept an IP or DNS name, not a URL, port, path, credentials, or shell text. Pass it as one argv value; never concatenate a shell command.
- Never stop occupied services, remove an existing Rainbond container, delete data, or bypass artifact verification.
- Stop on unsupported Windows builds, disabled virtualization, non-NAT WSL networking, occupied managed ports, unknown managed tasks/distributions, or checksum failures. Report the concrete blocker; never work around it silently.
- If interrupted, preserve the operation and use the exact resume command printed by the helper.
- Keep successful output concise: deployment location, health, Console URL, and authorization handoff.

Read [troubleshooting.md](references/troubleshooting.md) only after a reported blocker or failure.
