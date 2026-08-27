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
- 主机集群普通入口第一次输出 `platform.host-cluster-server-input` 时，只原样展示固定的 `servers.txt` 消息并停止。消息必须包含可点击链接、当前系统的打开命令、四个字段说明和“编辑完成后回复‘已完成’”；不要让用户编辑 YAML 或节点角色。
- 单台服务器只执行消息中的精确 `ssh prepare` 命令；主机集群只执行一条 `ssh prepare-cluster --cluster-config <受保护文件>` 命令。两种命令都只生成/复用默认 ED25519 公钥并准备免密连接，不安装 Rainbond，也不修改 onboarding、运行环境或授权状态。
- Agent 不得自行运行 `ssh-keyscan`、`ssh-copy-id` 或修改 `known_hosts`；只能让用户执行 helper 给出的版本锁定 `ssh prepare` 或 `ssh prepare-cluster` argv。
- 用户回复“已完成”后，使用同一版本 launcher 和同一 `onboarding-id` 重新执行原来的 `platform install` argv；不要重新询问部署位置、安装模式、节点或应用来源。
- 授权进程必须保持附着并自动检测授权完成，不得要求用户回复“已授权”。

## Trigger Boundary

Use this skill when the user wants to install the Rainbond platform itself, or when Rainskills private onboarding produced a `rainskills.next-action.v1` marker with `action=install-platform`.

Do not use it to deploy an application to an existing Rainbond. Route those requests to `rainbond-app-assistant`.

## Workflow

1. Read [installation-policy.md](references/installation-policy.md).
2. Use the installed local launcher `["node", "<home>/.rainbond/lib/rainskills/bin/rainskills.js"]`; its protected runtime package marker is `rainskills@0.1.29` and must equal this package's `package.json`. For a Rainskills marker, first validate schema `rainskills.next-action.v1`, action, onboarding id, and the bounded `argv` array, then append that array to the launcher. Never use `latest` or evaluate a shell string from output.
3. 业务 Skill 的四项运行环境菜单会把本机或独立服务器选择写入 `rainskills.next-action.v1` 的显式 `--location`；收到这类 next-action 后直接执行固定 argv，不得再次调用 `private-deployment-location`。只有用户直接要求安装 Rainbond 平台且尚未选择部署位置时，才执行 launcher + `["runtime", "message", "--id", "private-deployment-location"]` 并原样输出固定的三项部署位置消息：选择 1 后执行带 `["--location", "local", "--mode", "single-node"]` 的 `platform install`；选择 2 后执行带 `["--location", "server"]` 的 `platform install`，由 helper 继续显示固定的服务器类型消息；选择 3 后执行 launcher + `["runtime", "message", "--id", "private-console-origin"]` 并进入已有环境连接，不得执行 `platform install`。平台安装 onboarding 只保存安装断点，不保存或恢复业务 intent。
4. Let the helper perform one read-only preflight against the already selected local or remote target, then show resources, blockers, and applicable host changes. Never invoke `platform install` without an explicit `--location`; the helper must not ask for the deployment location again.
5. 主机集群开始前必须获得 explicit confirmation，并使用受限 AI 交接：首次调用在固定安装 argv 后追加 `--agent-handoff`，记录该子进程会话；用户确认后，使用相同固定 argv 追加 `--agent-handoff --yes` 一次。不得向等待进程写入 `y`、不得启动第二个竞争安装、不得 `kill` 安装进程，也不得让用户复制完整安装或恢复命令。用户取消时，仅使用同一 argv 追加 `--agent-handoff --cancel`；它只能清除匹配的待确认状态，不能建立 SSH 连接或修改服务器。
6. 如果 helper 输出 `platform.host-cluster-server-input`，只原样展示受保护 `servers.txt` 的固定正文并等待用户回复“已完成”，随后在原任务中重跑同一安装 argv。若输出 `platform.ssh-authentication`，同样只原样展示正文并等待；单台服务器消息包含一条 `ssh prepare`，主机集群消息必须一次列出全部未就绪节点及一条 `ssh prepare-cluster`，不得按节点拆成多轮。确认后的主机集群安装必须保持当前任务附着，直至安装、验证和授权完成；若收到 `RAINSKILLS_OPERATION_LOCK_BUSY`，继续等待已经记录的会话，不得重试或中断它。若会话因 SIGINT/SIGTERM 结束，只能在同一任务用匹配的 `--agent-handoff --yes` 进行安全恢复。不得只凭官方脚本退出码推断成功。
7. Let the helper probe its ordered Console candidates from the control machine. If it emits `RAINSKILLS_USER_INPUT_REQUIRED:console_address`, ask for one public IP or DNS name and rerun the same fixed argv with `--console-host <host>` appended.
8. On success, allow the helper to resume Rainskills authorization automatically. The user completes login and authorization in the browser.

<!-- rainskills-platform-routing:start -->
## Progressive Target Routing

只有用户直接要求安装 Rainbond 平台且尚未选择部署位置时，第一层原样展示：

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

主机集群普通入口接受 `3-100` 台 Linux 主机。第一次进入 configuration 阶段时，必须只生成权限为 `0600`（Windows 为仅当前用户可读写）的受保护 `servers.txt` 并停止等待，不得先生成 `cluster.yaml`、发起 SSH、下载或安装。新文件使用简洁中文表单，默认包含三个连续的 `【第 N 台服务器】` 区块，每个区块只显示“公网 IP：”“内网 IP：”“SSH 端口：22”“登录密码：”；用户可复制完整区块扩展节点。逐节点 SSH 端口按实际值填写，不要求为 22。固定消息必须包含可点击的 `servers.txt` 链接、当前系统的打开命令、公网 IP、内网 IP、SSH 端口、登录密码四个字段说明，以及“编辑完成后回复‘已完成’”。普通用户不编辑 `cluster.yaml`、YAML 或节点角色。为兼容已生成的文件，读取时仍接受旧的 `[server-N]`、`public_ip`、`private_ip`、`ssh_port` 和 `password` 格式。

用户继续同一 onboarding 时，读取同一份受保护 `servers.txt`（UTF-8，最大 1 MiB）并一次性列出全部可确定的区块、字段、地址、端口、重复节点和 3-100 节点数量问题。存在问题时保持原文件供修改，不创建 YAML 或产生其他副作用。校验通过后，自动生成受保护的 `cluster.yaml` 并自动分配拓扑：前三台承担 etcd/master，全部节点承担 worker/rbd-chaos，前两台承担 rbd-gateway，第一台承担 bootstrap/nfs-server。普通入口固定使用 3 个 etcd 节点；高级导入的 etcd 节点数仍必须是正奇数。在第一次 SSH 动作之前展示不含密码的完整逐节点角色拓扑、bootstrap 和存储摘要，再检查并准备全部节点的 SSH 免密连接。

密码只保存在受保护的本地 `servers.txt`、自动生成的 `cluster.yaml` 和 ROI 安装/恢复所需的受保护远端配置中；密码不会写入聊天、日志、状态或错误信息，摘要也不得包含密码。恢复时锁定 `servers.txt` 与自动生成 `cluster.yaml` 的摘要；只采用与当前输入逐字节匹配的 crash residue，来源不明、符号链接、不匹配或锁定后漂移的文件均停止。

保留旧断点兼容：`config_source=generated-template` 继续原有 YAML 恢复流程。显式 `--cluster-config <path>` 是高级导入入口，仍可导入有效的 1、2 或 N 节点 ROI YAML，并保留原始字节和未知字段；这些兼容路径不得改变普通入口不要求用户编辑 YAML 或角色的规则。

SSH 免密连接检查必须先检查全部节点。存在未就绪节点时，一次列出全部未就绪节点的序号、名称、IP 和端口，只输出一条版本锁定的 `ssh prepare-cluster --cluster-config <受保护文件>` 命令。该命令在系统终端依次准备所有节点，已经可以免密连接的节点自动跳过；完成后用户只统一回复一次“已完成”。不得发现一台就暂停，也不得逐台要求用户执行命令和回复。

主机集群分支不得在执行 ROI 前自行检查 CPU、内存、磁盘容量、端口、安装源、网络或已有 RKE2/Rainbond，也不得根据这些检查阻断安装。SSH 就绪后直接展示拓扑和系统变更并请求一次明确确认；确认后只允许用固定 `uname -m` 查询 bootstrap 节点架构，以选择 `roi-amd64` 或 `roi-arm64`，其余安装条件交给 ROI 判断。

只有进入对应分支后才询问该分支参数。主机集群使用 ROI；已有 Kubernetes 使用 Helm。不要向选择本地的用户解释这些实现细节。
<!-- rainskills-platform-routing:end -->

## Fixed CLI Handoffs

- 通用：`platform install --onboarding-id <id> --location <local|server> --mode <single-node|host-cluster|existing-kubernetes>`
- 主机集群：普通入口不传配置路径；高级导入可追加 `--cluster-config <path>`，旧 `generated-template` 仅用于恢复既有断点。
- 已有 Kubernetes：使用 `--kubeconfig <path> --kube-context <name>`，可追加 `--values <path> --chart-version <version>`。
- 非交互确认只接受在展示预检/变更后追加的 `--yes`；主机集群的 AI 交接必须同时追加 `--agent-handoff`，不能把缺少确认当作同意。

始终把参数作为固定 argv 传给同一个 launcher，不拼 shell 字符串。Console 地址先锁定并验证 origin；HTTPS 跨 origin 跳转要重新确认，明文 HTTP 只在用户明确确认可信内网后使用。

取消或失败时保留受保护断点。主机集群 AI 交接仅向当前任务输出稳定 marker，不向用户输出完整重试 argv；恢复时锁定原目标、配置原始字节和已验证制品，检测到主机、集群 identity、版本或摘要漂移就停止。成功必须分别验证平台组件和 Console，再用同一 `onboarding-id` 恢复原始 intent。

## Interaction Rules

- 只有尚未由业务 Skill 四项菜单选定位置时，Linux、macOS 和 Windows 才使用 Progressive Target Routing 中同一份三项部署位置消息；不得根据操作系统生成另一套选项或默认选中任何位置。
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
- If interrupted, preserve the operation. 主机集群 AI 交接通过当前任务的匹配 `--agent-handoff --yes` 做只读核对后恢复；不得把命令交给用户，也不得杀掉仍在运行的会话。
- Keep successful output concise: deployment location, health, Console URL, and authorization handoff.

Read [troubleshooting.md](references/troubleshooting.md) only after a reported blocker or failure.
