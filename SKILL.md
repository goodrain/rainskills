---
name: rainskills
description: Use when a user asks to install, set up, initialize, update, repair, or start using Rainskills or the Rainbond skill suite from goodrain/rainskills.
---

# Rainskills

This is the single marketplace entry for the complete Rainskills product. Do not install or present the bundled `rainbond-*` directories as separate marketplace products.

## Initialize

1. Resolve the directory containing this `SKILL.md` and verify that its adjacent `install.sh` exists.
2. Run that installer by absolute path in an attached interactive terminal: `bash <skill-directory>/install.sh`. Do not replace it with manual file copies or hand-written MCP configuration.
3. Keep stdin, stdout, and stderr attached. When `RAINSKILLS_USER_INPUT_REQUIRED` appears, pause and ask the user for that choice; never accept a default or choose Rainbond Cloud/private deployment for them.
4. Let the installer open the browser. The user logs in and approves authorization there. Never request passwords, JWTs, tokens, or private keys in chat.
5. If the installer emits `rainskills.next-action.v1`, parse its `argv` array and pass those arguments to the adjacent `bin/rainskills.js` with Node. Never evaluate output as a shell command.
6. Stay attached until installation, MCP configuration, and verification finish. Report the configured client, Rainbond environment, and any required client restart.

If the adjacent installer is missing, use `npx --yes rainskills` as the fallback. For an update or repair, refresh this marketplace Skill first, then run the bundled installer again; it compares and updates the internal skills.
