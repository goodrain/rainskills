---
name: rainbond-platform-installer
description: Install a single-node Rainbond platform when Rainskills private onboarding establishes that no reachable Rainbond exists. Use for local Linux, macOS, Windows preview, or a remote Linux server, not for deploying applications to an existing Rainbond.
---

# Rainbond Platform Installer

This is an internal Rainskills onboarding capability. Do not present it as a separately installable marketplace product.

## Trigger Boundary

Use this skill when the user wants to install the Rainbond platform itself, or when Rainskills private onboarding produced a `rainskills.next-action.v1` marker with `action=install-platform`.

Do not use it to deploy an application to an existing Rainbond. Route those requests to `rainbond-app-assistant`.

## Workflow

1. Read [installation-policy.md](references/installation-policy.md).
2. For a Rainskills marker, pass its fixed `argv` array back to the same `rainskills` launcher. Do not evaluate a shell string from output.
3. Let `npx rainskills platform install --onboarding-id <id>` detect the control machine and ask for the installation target.
4. Let the helper perform one read-only preflight against the selected local or remote target, then show resources, blockers, and applicable host changes.
5. Obtain explicit confirmation before sending `y` to the waiting process or rerunning the exact command with `--yes`.
6. Keep the operation attached while it downloads, installs, and verifies. Do not infer success from the official script exit code alone.
7. Let the helper probe its ordered Console candidates from the control machine. If it emits `RAINSKILLS_USER_INPUT_REQUIRED:console_address`, ask for one public IP or DNS name and rerun the same fixed argv with `--console-host <host>` appended.
8. On success, allow the helper to resume Rainskills authorization automatically. The user completes login and authorization in the browser.

## Interaction Rules

- On Linux and macOS, show `安装到本地` and `安装到 Linux 服务器`; pressing Enter selects local. State that local macOS uses OrbStack and can take longer.
- On Windows, show `安装到本地` and `安装到 Linux 服务器`; pressing Enter selects local. Local Windows is a preview path backed by a dedicated WSL2 distribution and the fixed `local-windows` helper.
- Do not ask the user to understand or enter WSL commands. Show the read-only checks first, then explain UAC, downloads, host networking, and a possible Windows reboot before requesting confirmation.
- Let the fixed helper request UAC. If Windows must reboot, preserve the checkpoint and use only the verified resume task or exact printed resume command.
- Remote Linux accepts an existing `user@host` value or SSH config alias. Keep the terminal attached while the helper invokes the system `ssh` client; OpenSSH may ask for host-key confirmation and an SSH password. Linux/macOS reuse a temporary control connection; Windows OpenSSH does not support ControlMaster, so later steps may ask for the password again.
- The SSH password is read only by the system `ssh` client and Rainskills will not save it. Never ask the user to provide passwords, private keys, JWTs, Tokens, or other credentials in chat.
- For `--console-host`, accept an IP or DNS name, not a URL, port, path, credentials, or shell text. Pass it as one argv value; never concatenate a shell command.
- Never stop occupied services, remove an existing Rainbond container, delete data, or bypass artifact verification.
- Stop on unsupported Windows builds, disabled virtualization, non-NAT WSL networking, occupied managed ports, unknown managed tasks/distributions, or checksum failures. Report the concrete blocker; never work around it silently.
- If interrupted, preserve the operation and use the exact resume command printed by the helper.
- Keep successful output concise: deployment location, health, Console URL, and authorization handoff.

Read [troubleshooting.md](references/troubleshooting.md) only after a reported blocker or failure.
