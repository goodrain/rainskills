---
name: rainbond-platform-installer
description: Use when Rainskills private onboarding establishes that no reachable Rainbond exists and the user wants a local, server, multi-node host, or existing Kubernetes installation target.
---

# Rainbond Platform Installer

This is an internal Rainskills onboarding capability. Do not present it as a separately installable marketplace product.

## Trigger Boundary

Use this skill when the user wants to install the Rainbond platform itself, or when Rainskills private onboarding produced a `rainskills.next-action.v1` marker with `action=install-platform`.

Do not use it to deploy an application to an existing Rainbond. Route those requests to `rainbond-app-assistant`.

## Workflow

1. Read [installation-policy.md](references/installation-policy.md).
2. Use the package-version launcher `["npx", "--yes", "rainskills@0.1.0-rc.60"]`; its version must equal this package's `package.json`. For a Rainskills marker, first validate schema `rainskills.next-action.v1`, action, onboarding id, and the bounded `argv` array, then append that array to the launcher. Never use `latest` or evaluate a shell string from output.
3. Let launcher + `["platform", "install", "--onboarding-id", "<id>"]` detect the control machine and ask for the installation target.
4. Let the helper perform one read-only preflight against the selected local or remote target, then show resources, blockers, and applicable host changes.
5. Obtain explicit confirmation before sending `y` to the waiting process or rerunning the exact command with `--yes`.
6. Keep the operation attached while it downloads, installs, and verifies. Do not infer success from the official script exit code alone.
7. Let the helper probe its ordered Console candidates from the control machine. If it emits `RAINSKILLS_USER_INPUT_REQUIRED:console_address`, ask for one public IP or DNS name and rerun the same fixed argv with `--console-host <host>` appended.
8. On success, allow the helper to resume Rainskills authorization automatically. The user completes login and authorization in the browser.

<!-- rainskills-platform-routing:start -->
## Progressive Target Routing

先只让用户选择`安装到本地`或`安装到服务器`。

- 本地：直接安装单机版，不展示 ROI 或 Kubernetes 选项。
- 服务器：再选择`单机版`、`主机集群`或`已有 Kubernetes`。
- 主机集群支持 1、2 或 N 台 Linux 主机；etcd 节点数必须是正奇数。不要把三台服务器写成固定要求。

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

- On Linux and macOS, show `安装到本地` and `安装到 Linux 服务器`; pressing Enter selects local. State that local macOS uses OrbStack and can take longer.
- On Windows, show `安装到本地` and `安装到 Linux 服务器`; pressing Enter selects local. Local Windows is a preview path backed by a dedicated WSL2 distribution and the fixed `local-windows` helper.
- Do not ask the user to understand or enter WSL commands. Show the read-only checks first, then explain UAC, downloads, host networking, and a possible Windows reboot before requesting confirmation.
- Let the fixed helper request UAC. If Windows must reboot, preserve the checkpoint and use only the verified resume task or exact printed resume command.
- Remote Linux single-node accepts an existing `user@host` value or SSH config alias. Keep the terminal attached while the helper invokes the system `ssh` client; OpenSSH may ask for host-key confirmation and an SSH password. Linux/macOS reuse a temporary control connection; Windows OpenSSH does not support ControlMaster, so later steps may ask for the password again.
- The SSH password is read only by the system `ssh` client and Rainskills will not save it. Never ask the user to provide passwords, private keys, JWTs, Tokens, or other credentials in chat.
- For `--console-host`, accept an IP or DNS name, not a URL, port, path, credentials, or shell text. Pass it as one argv value; never concatenate a shell command.
- Never stop occupied services, remove an existing Rainbond container, delete data, or bypass artifact verification.
- Stop on unsupported Windows builds, disabled virtualization, non-NAT WSL networking, occupied managed ports, unknown managed tasks/distributions, or checksum failures. Report the concrete blocker; never work around it silently.
- If interrupted, preserve the operation and use the exact resume command printed by the helper.
- Keep successful output concise: deployment location, health, Console URL, and authorization handoff.

Read [troubleshooting.md](references/troubleshooting.md) only after a reported blocker or failure.
