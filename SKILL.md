---
name: rainskills
description: Use when a user asks to install, set up, initialize, update, repair, start using Rainskills, or connect, reconnect, inspect, or replace the single Rainskills runtime.
---

# Rainskills

This is the single marketplace entry for the complete Rainskills product. The installer deploys every bundled `rainbond-*` Skill as an independent Skill with its own trigger and responsibility, including the lightweight read-only `rainbond-platform-query` skill. Do not ask the user to choose only one of them.

## Initialize

1. Detect the current host client and map it to exactly one supported installer target: Codex=`codex`, Claude Code=`claude`, or Pi Agent=`pi`. All three use the same installed Skills and protected local Rainskills CLI; Pi has no separate MCP adapter or generated extension. The macOS, Linux, and WSL installer intentionally does not support OpenClaw; report that limitation instead of invoking an unsupported target. Do not ask the user which supported client they are currently using. If the host cannot be determined reliably, omit the target and let the installer ask.
2. Resolve the directory containing this `SKILL.md`. On native Windows, if the adjacent `bin/rainskills.js` exists, run it by absolute path with the detected target in an attached interactive terminal: `node <skill-directory>/bin/rainskills.js <target>`. On macOS, Linux, or WSL, if the adjacent `install.sh` exists, run `bash <skill-directory>/install.sh <target>` the same way. Do not replace the installer with manual file copies.
3. Keep stdin, stdout, and stderr attached. When `RAINSKILLS_USER_INPUT_REQUIRED` appears, pause for that installer choice. If the installer emits `rainskills.next-action.v1`, execute only its fixed `argv` through the same launcher; never evaluate output as a shell command. If the adjacent `bin/rainskills.js` exists, use it for fixed next actions; otherwise use the same versioned npm package fallback described below.
4. Stay attached until every independent Skill is installed. Do not select, connect, or configure an application runtime during installation. In the user-facing response, output only the fixed completion message below.

If the adjacent installer is missing, check the local Node.js version before choosing the fallback. With `npx` and Node.js 18 or newer, use `npx --yes rainskills <target>`. With no Node.js or a version below 18, use `bash <(curl -fsSL https://get.rainbond.com/rainskills/install.sh) <target>` instead. Omit `<target>` only when the host cannot be determined reliably. Keep either command attached to the interactive terminal. For an update or repair, refresh this marketplace Skill first, then run the installer again; it compares and updates every independent internal Skill.

Skills-only 安装不需要 Node.js；CDN fallback 只负责安装 Skill 文件，不代表运行环境连接、应用部署或平台安装已经可执行。用户首次提出需要运行环境的动作时，对应业务 Skill 才检查 Node.js；固定 Rainskills launcher 需要 Node.js 18 或更高版本。缺失或版本过低时保留原始 intent 并停止，等待用户或 agent 明确同意安装或升级 Node.js，安装完成消息不得提前提示 Node.js。

执行优化：同一会话内只检查一次 Node.js 和运行环境状态；仅在 Node.js、Rainskills 或唯一运行环境发生变化后失效。固定 launcher 和 argv 已在本 Skill 中，禁止读取、搜索或探测 `rainskills.js`，也禁止执行 `npm root -g`。

## Completion Message

The installer emits this text inside `RAINSKILLS_USER_MESSAGE_BEGIN:install.completed` and the matching END marker, followed by `RAINSKILLS_AGENT_SUMMARY_REQUIRED:include-next-actions`. Relay only the body exactly and print nothing else; do not expose the markers, summarize, reformat, add a source link, or add verification details. If the host still summarizes instead of relaying, its installation summary must retain at least one example from “下一步可以直接说”.

```text
Rainskills 安装完成，下一条消息即可直接使用。

下一步可以直接说：

- 帮我部署当前项目
- 帮我部署一个 Git 仓库
- 帮我通过镜像或安装包部署应用
- 帮我安装一个应用模板
- 帮我分析当前项目应该如何部署

也可以直接告诉我你想部署什么应用。
```

## Manage the Single Runtime

受限沙箱（包括 Codex）执行本地状态命令时，必须申请用户级受保护目录访问权限；在 Codex 中使用 `require_escalated`。不得修改 `~/.rainbond` 权限、复制受保护状态到工作区，或因沙箱权限错误建议重装。

涉及浏览器或设备授权的 `runtime connect`，以及恢复/安装场景中的 `rainskills <target> --self-hosted`，必须在附加交互终端（TTY）中运行；在 Codex 中设置 `tty: true` 并保持进程附着直到授权完成。禁止通过非交互命令要求用户粘贴 JWT；非交互模式只可复用已存在的受保护凭据。

Rainskills 只保存一个全局运行环境，不维护环境列表、名称、默认值或环境 ID。使用固定 launcher `node <home>/.rainbond/lib/rainskills/bin/rainskills.js`（运行包版本 `rainskills@0.1.18`）：

- 状态：执行 `runtime status --json`。
- 首次连接：执行 `runtime connect <target> --saas` 或 `runtime connect <target> --rainbond-url <Console origin>`。
- 安装私有环境：执行 `runtime connect <target> --install-private --location local|server`。
- 重新授权：执行 `runtime reconnect <target>`；必须进入浏览器 Device Flow，不复用 Shell 中缓存的 JWT。
- 更换环境：明确告知用户会替换当前唯一环境；新授权和 live probe 成功后再覆盖凭据。

所有 Rainbond 查询和变更继续通过 `~/.rainbond/bin/rainskills-tools.js`。不得配置客户端 MCP，也不得恢复环境枚举、业务 operation 生命周期、环境 ID 或 intent 恢复协议。

业务 CLI 默认只读取受保护的唯一运行环境文件，忽略 Shell 中遗留的 `RAINBOND_URL` / `RAINBOND_JWT`。CI 若要显式使用环境变量凭据，必须同时设置 `RAINSKILLS_CREDENTIAL_SOURCE=environment`。
