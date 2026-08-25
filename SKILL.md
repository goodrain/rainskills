---
name: rainskills
description: Use when a user asks to install, set up, initialize, update, repair, start using Rainskills, or list, add, rename, remove, reconnect, or change the default Rainskills runtime environment.
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

执行优化：同一会话内只检查一次 Node.js（首次使用本地 CLI 前）；仅在 Node.js 或 Rainskills 安装、升级，或 PATH 变更后失效。固定 launcher 和 argv 已在本 Skill 中，禁止读取、搜索或探测 `rainskills.js`，也禁止执行 `npm root -g`。每个新的业务操作仍需要刷新一次环境列表；带已有 `operation_id` 或 `onboarding-id` 的续接复用已绑定的环境 ID，不重复枚举环境。

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

## Manage Runtime Environments

受限沙箱（包括 Codex）执行本地状态命令时，必须申请用户级受保护目录访问权限；在 Codex 中使用 `require_escalated`。不得修改 `~/.rainbond` 权限、复制受保护状态到工作区，或因沙箱权限错误建议重装。

环境是全局列表，不是项目绑定。本地状态命令必须定位已安装的同级 `rainbond-platform-installer/scripts/local-runtime.js`，解析为绝对路径后通过 `node` 以 argv 数组执行；不得为了查询本地环境访问 npm。只有连接或安装环境时才使用与当前技能包一致的固定 launcher `node <home>/.rainbond/lib/rainskills/bin/rainskills.js`（运行包版本 `rainskills@0.1.10`）。

- 列表：用本地 launcher 执行 `environment list --json`，只展示名称、类型、状态、是否默认和最近验证时间。
- 重命名：用本地 launcher 执行 `environment rename --environment-id <uuid> --name <name>`。
- 设为默认：用本地 launcher 执行 `environment set-default --environment-id <uuid>`。只影响之后未指定环境的新操作。
- 删除：用本地 launcher 执行 `environment remove --environment-id <uuid>`；默认环境或活动操作使用中的环境必须先阻断。
- 添加：新增环境时直接生成 operation UUID，以 `{"type":"environment-add"}` 执行 runtime connect。先原样展示 `runtime message --id add-environment-location`。选择云端环境时直接执行 `--saas` route；选择私有环境时立即原样展示 `runtime message --id private-deployment-location`，并与首次部署保持完全相同的路径：选择 1（部署到本机）执行 `--install-private --location local`，选择 2（部署到独立服务器）执行 `--install-private --location server`，选择 3（部署到已有 Rainbond）原样展示 `runtime message --id private-console-origin`，收到地址后执行 `--rainbond-url <已验证 Console origin>`。不得展示任何额外的接入方式中间步骤。授权成功后必须把 launcher 返回的 `user_message` 中完整环境列表原样展示给用户，再按用户要求重命名并执行 `operation complete --operation-id <uuid>`。第二个环境不得自动改成默认环境。不得先执行 `runtime status`，不得检查、迁移、备份、删除或修复旧的 `runtime-connection-v1.json`；旧 runtime 状态不是新增环境的前置条件，连接失败时只执行 launcher 返回的固定恢复 argv，不得自行设计恢复流程。

用户在一次业务请求中明确指定运行环境时，只把该环境 ID 传给本次 `operation begin`；同一项目可以部署到任意多个环境和团队。明确“团队”表示环境内团队；明确“运行环境/平台”表示环境；裸名称同时匹配两者时必须询问，不能靠名称中是否含“环境”二字猜测。
