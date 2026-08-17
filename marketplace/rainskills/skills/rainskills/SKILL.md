---
name: rainskills
description: Use when a user asks to install, set up, initialize, update, repair, or start using Rainskills or the Rainbond skill suite from goodrain/rainskills.
---

# Rainskills

This is the single marketplace entry for the complete Rainskills product. The installer deploys every bundled `rainbond-*` Skill as an independent Skill with its own trigger and responsibility. Do not ask the user to choose only one of them.

## Initialize

1. Detect the current host client and map it to exactly one supported installer target: Codex=`codex` or Claude Code=`claude`. The macOS, Linux, and WSL installer intentionally does not support OpenClaw or Pi Agent; report that limitation instead of invoking an unsupported target. Do not ask the user which supported client they are currently using. If the host cannot be determined reliably, omit the target and let the installer ask.
2. Resolve the directory containing this `SKILL.md`. On native Windows, if the adjacent `bin/rainskills.js` exists, run it by absolute path with the detected target in an attached interactive terminal: `node <skill-directory>/bin/rainskills.js <target>`. On macOS, Linux, or WSL, if the adjacent `install.sh` exists, run `bash <skill-directory>/install.sh <target>` the same way. Do not replace the installer with manual file copies.
3. Keep stdin, stdout, and stderr attached. When `RAINSKILLS_USER_INPUT_REQUIRED` appears, pause for that installer choice. If the installer emits `rainskills.next-action.v1`, execute only its fixed `argv` through the same launcher; never evaluate output as a shell command. If the adjacent `bin/rainskills.js` exists, use it for fixed next actions; otherwise use the same versioned npm package fallback described below.
4. Stay attached until every independent Skill is installed. Do not select, connect, or configure an application runtime during installation. In the user-facing response, output only the fixed completion message below.

If the adjacent installer is missing, check the local Node.js version before choosing the fallback. With `npx` and Node.js 18 or newer, use `npx --yes rainskills@0.1.0-rc.61 <target>`. With no Node.js or a version below 18, use `bash <(curl -fsSL https://get.rainbond.com/rainskills/install.sh) <target>` instead. Omit `<target>` only when the host cannot be determined reliably. Keep either command attached to the interactive terminal. For an update or repair, refresh this marketplace Skill first, then run the installer again; it compares and updates every independent internal Skill.

Skills-only 安装不需要 Node.js；CDN fallback 只负责安装 Skill 文件，不代表运行环境连接、应用部署或平台安装已经可执行。用户首次提出需要运行环境的动作时，对应业务 Skill 才检查 Node.js；固定 Rainskills launcher 需要 Node.js 18 或更高版本。缺失或版本过低时保留原始 intent 并停止，等待用户或 agent 明确同意安装或升级 Node.js，安装完成消息不得提前提示 Node.js。

## Completion Message

After success, print exactly this capability summary and nothing else:

```text
Rainskills 安装完成。

现在可以帮你：

- 分析项目的技术栈和部署结构
- 将当前项目或 Git 仓库部署上线
- 通过源码、镜像或安装包部署应用
- 分析项目结构
- 识别技术栈
- 从应用模板安装应用
- 给出部署结构建议

直接告诉我你想做什么即可。
```
