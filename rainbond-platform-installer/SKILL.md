---
name: rainbond-platform-installer
description: Install a single-node Rainbond platform when Rainskills private onboarding establishes that no reachable Rainbond exists. Use for installing Rainbond itself on the current Linux or macOS machine or on a remote Linux server, not for deploying applications to an existing Rainbond.
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
7. On success, allow the helper to resume Rainskills authorization automatically. The user completes login and authorization in the browser.

## Interaction Rules

- On Linux, offer the current device and another Linux server; pressing Enter selects the current device.
- On macOS, offer remote Linux first and the current Mac second. State that OrbStack preparation can take longer.
- On Windows, do not offer local Windows or macOS. Explain that Rainbond is not installed on Windows and ask only for a remote Linux SSH target.
- Remote Linux accepts an existing `user@host` value or SSH config alias and uses `ssh -o BatchMode=yes`; never collect SSH passwords or private-key contents.
- Never ask for passwords, private keys, JWTs, Tokens, or other credentials in chat.
- Never stop occupied services, remove an existing Rainbond container, delete data, or bypass artifact verification.
- If interrupted, preserve the operation and use the exact resume command printed by the helper.
- Keep successful output concise: deployment location, health, Console URL, and authorization handoff.

Read [troubleshooting.md](references/troubleshooting.md) only after a reported blocker or failure.
