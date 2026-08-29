---
name: rainskills
description: Use when a user asks to install, set up, initialize, update, repair, start using Rainskills, or connect, reconnect, inspect, or replace the single Rainskills runtime.
---

# Rainskills

This is the single marketplace entry for the complete Rainskills product. The installer deploys every bundled `rainbond-*` Skill as an independent Skill with its own trigger and responsibility, including the lightweight read-only `rainbond-platform-query` skill. Do not ask the user to choose only one of them.

## Initialize

1. Detect the current host client and map it to exactly one supported installer target: Codex=`codex`, Claude Code=`claude`, Pi Agent=`pi`, DeepSeek Harness=`dsh`, WorkBuddy=`workbuddy`, or Hermes Agent=`hermes`. All six use the same CLI profile, installed Skills, and protected local Rainskills CLI; none requires a separate client MCP adapter. DeepSeek Harness installs to `$DSH_HOME/skills` (default `~/.dsh/skills`). WorkBuddy installs to `$WORKBUDDY_CONFIG_DIR/skills` (default `~/.workbuddy-ai/skills`). Hermes Agent installs to `$HERMES_HOME/skills` (default `~/.hermes/skills`); `AI_AGENT=hermes-agent` or `HERMES_AGENT=true` is a reliable fallback when the host must be detected from a terminal subprocess. The macOS, Linux, and WSL installer intentionally does not support OpenClaw; report that limitation instead of invoking an unsupported target. Do not ask the user which supported client they are currently using. If the host cannot be determined reliably, omit the target and let the installer ask.
2. Resolve the directory containing this `SKILL.md`. On native Windows, if the adjacent `bin/rainskills.js` exists, run it by absolute path with the detected target in an attached interactive terminal: `node <skill-directory>/bin/rainskills.js <target>`. On macOS, Linux, or WSL, if the adjacent `install.sh` exists, run `bash <skill-directory>/install.sh <target>` the same way. Do not replace the installer with manual file copies.
3. Keep stdin, stdout, and stderr attached. When `RAINSKILLS_USER_INPUT_REQUIRED` appears, pause for that installer choice. If the installer emits `rainskills.next-action.v1`, execute only its fixed `argv` through the same launcher; never evaluate output as a shell command. If the adjacent `bin/rainskills.js` exists, use it for fixed next actions; otherwise use the same versioned npm package fallback described below.
4. Stay attached until every independent Skill is installed. Do not select, connect, or configure an application runtime during installation. In the user-facing response, output only the fixed completion message below.

If the adjacent installer is missing, check the local Node.js version before choosing the fallback. With `npx` and Node.js 18 or newer, use `npx --yes rainskills <target>`. With no Node.js or a version below 18, use `bash <(curl -fsSL https://get.rainbond.com/rainskills/install.sh) <target>` instead. Omit `<target>` only when the host cannot be determined reliably. Keep either command attached to the interactive terminal. For an update or repair, refresh this marketplace Skill first, then run the installer again; it compares and updates every independent internal Skill.

Skills-only 安装不需要 Node.js；CDN fallback 只负责安装 Skill 文件，不代表运行环境连接、应用部署或平台安装已经可执行。用户首次提出需要运行环境的动作时，对应业务 Skill 才检查 Node.js；固定 Rainskills launcher 需要 Node.js 18 或更高版本。缺失或版本过低时保留原始 intent 并停止，等待用户或 agent 明确同意安装或升级 Node.js，安装完成消息不得提前提示 Node.js。

执行优化：同一会话内只检查一次 Node.js 和运行环境状态；仅在 Node.js、Rainskills 或唯一运行环境发生变化后失效。固定 launcher 和 argv 已在本 Skill 中，禁止读取、搜索或探测 `rainskills.js`，也禁止执行 `npm root -g`。

## Completion Message

The installer emits this text inside `RAINSKILLS_USER_MESSAGE_BEGIN:install.completed` and the matching END marker, followed by `RAINSKILLS_AGENT_SUMMARY_REQUIRED:include-next-actions`. Relay only the body exactly and print nothing else; do not expose the markers, summarize, reformat, add a source link, or add verification details. If the host still summarizes instead of relaying, its installation summary must retain at least one example from “下一步可以直接说”.

For `target=hermes`, the emitted body additionally tells an already-open Hermes session to run `/reset` or start a new session so its cached Skill catalog includes every newly installed `rainbond-*` Skill. Relay that emitted Hermes body exactly; do not replace it with the generic example below.

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

`runtime connect` 的 Device Flow 不依赖 stdin TTY；Agent 必须执行固定 argv 并保持进程附着直到授权完成。能打开本机浏览器时由连接器自动跳转，SSH、容器等无浏览器场景原样展示授权地址并继续轮询。只有 Rainbond 不支持 Device Flow 且进入旧版 loopback 手动粘贴时才需要交互终端；不得要求用户在聊天中粘贴 JWT。

授权命令是同步门禁。执行工具返回“进程仍在运行”或会话 ID 时，必须只等待或轮询同一个命令会话；在该会话结束前，禁止读取专项 Skill、解析 context、调用业务 CLI 或执行任何后续业务步骤。浏览器页面显示成功不代表连接完成；只有原命令退出码为 0，并输出 `rainskills.runtime-connect-result.v1` 且 `state=connected`，才可继续。不得另起 `runtime status` 猜测完成，也不得重复提示用户授权。

Codex 中命令工具一旦返回 `session_id`，必须立即对该 `session_id` 反复调用 `write_stdin`（空输入轮询），直到工具返回 `exit_code`。连接器输出 `[RAINSKILLS_AGENT_WAIT_REQUIRED:runtime-connect]` 后进入上述轮询；看到 `[RAINSKILLS_AGENT_WAIT_COMPLETE:runtime-connect]` 后仍须继续轮询，直到取得退出码和最终 JSON。

Hermes Agent 中必须使用 `terminal` 以 `background=true` 启动授权命令；取得 `session_id` 后，只对同一会话按需调用 `process(action="poll")` 获取授权地址，再调用 `process(action="wait")` 等待退出。`wait` 超时时只能继续等待同一 `session_id`；不得把后台启动或浏览器成功页面当作授权完成，也不得另起 `runtime status`。

DeepSeek Harness 和 WorkBuddy 也必须保持原命令附着直到退出；如果宿主把长命令转成持久终端或后台任务，只能轮询该原始命令句柄，不得另起 `runtime status` 推测授权结果。WorkBuddy 安装后若当前任务的 Skill 清单尚未刷新，在下一条业务动作前先刷新 Skill 列表或新建任务，不得退回内置 Sites 代替 Rainbond 部署。

Rainskills 只保存一个全局运行环境，不维护环境列表、名称、默认值或环境 ID。使用固定 launcher `node <home>/.rainbond/lib/rainskills/bin/rainskills.js`（运行包版本 `rainskills@0.1.34`）：

- 状态：执行 `runtime status --json`。
- 首次连接：执行 `runtime connect <target> --saas` 或 `runtime connect <target> --rainbond-url <Console origin>`。
- 安装私有环境：执行 `runtime connect <target> --install-private --location local|server`。
- 重新授权：执行 `runtime reconnect <target>`；必须进入浏览器 Device Flow，不复用 Shell 中缓存的 JWT。
- 更换环境：明确告知用户会替换当前唯一环境；新授权和 live probe 成功后再覆盖凭据。

固定 contract 中的 `<target>` 必须替换为当前宿主：Codex=`codex`、Claude Code=`claude`、Pi Agent=`pi`、DeepSeek Harness=`dsh`、WorkBuddy=`workbuddy`、Hermes Agent=`hermes`。

所有 Rainbond 查询和变更继续通过 `~/.rainbond/bin/rainskills-tools.js`。不得配置客户端 MCP，也不得恢复环境枚举、业务 operation 生命周期、环境 ID 或 intent 恢复协议。

业务 CLI 默认只读取受保护的唯一运行环境文件，忽略 Shell 中遗留的 `RAINBOND_URL` / `RAINBOND_JWT`。CI 若要显式使用环境变量凭据，必须同时设置 `RAINSKILLS_CREDENTIAL_SOURCE=environment`。
