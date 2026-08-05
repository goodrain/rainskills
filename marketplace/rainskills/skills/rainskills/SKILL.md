---
name: rainskills
description: Use when a user asks to install, set up, initialize, update, repair, or start using Rainskills or the Rainbond skill suite from goodrain/rainskills.
---

# Rainskills

This is the single marketplace entry for the complete Rainskills product. The installer deploys every bundled `rainbond-*` Skill as an independent Skill with its own trigger and responsibility. Do not ask the user to choose only one of them.

## Initialize

1. Detect the current host client and map it to exactly one installer target: Codex=`codex`, Claude Code=`claude`, OpenClaw=`openclaw`, Pi Agent=`pi`. Do not ask the user which client they are currently using. If the host cannot be determined reliably, omit the target and let the installer ask.
2. Resolve the directory containing this `SKILL.md`. On native Windows, if the adjacent `bin/rainskills.js` exists, run it by absolute path with the detected target in an attached interactive terminal: `node <skill-directory>/bin/rainskills.js <target>`. On macOS, Linux, or WSL, if the adjacent `install.sh` exists, run `bash <skill-directory>/install.sh <target>` the same way. Do not replace the installer with manual file copies or hand-written MCP configuration.
3. Keep stdin, stdout, and stderr attached. When `RAINSKILLS_USER_INPUT_REQUIRED` appears, pause and ask the user for that choice; never accept a default or choose Rainbond Cloud/private deployment for them.
4. Let the installer open the browser. The user logs in and approves authorization there. Never request passwords, JWTs, tokens, or private keys in chat.
5. If the installer emits `rainskills.next-action.v1`, parse its `argv` array. If the adjacent `bin/rainskills.js` exists, pass those arguments to it with Node; otherwise pass them to the same versioned npm package fallback described below. Never evaluate output as a shell command.
6. Stay attached until all independent Skills, MCP configuration, and verification finish. Report the configured client, Rainbond environment, and the client-specific reload action printed by the installer.

If the adjacent installer is missing, check the local Node.js version before choosing the fallback. With `npx` and Node.js 18 or newer, use `npx --yes rainskills@0.1.0-rc.44 <target>`. With no Node.js or a version below 18, use `bash <(curl -fsSL https://get.rainbond.com/rainskills/install.sh) <target>` instead. Omit `<target>` only when the host cannot be determined reliably. Keep either command attached to the interactive terminal. For an update or repair, refresh this marketplace Skill first, then run the installer again; it compares and updates every independent internal Skill.
