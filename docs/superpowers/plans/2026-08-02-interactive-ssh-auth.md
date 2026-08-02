# Interactive SSH Authentication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:test-driven-development while implementing this plan task-by-task.

**Goal:** Let remote Rainbond installation authenticate through native OpenSSH once and reuse the connection safely.

**Architecture:** Keep password handling entirely inside OpenSSH. A small session helper probes existing key authentication, creates a temporary `ControlMaster` connection only when needed, and supplies its control path to existing remote commands.

**Tech Stack:** Node.js, OpenSSH, Node test runner

---

### Task 1: SSH session behavior

**Files:**
- Modify: `tests/platform-installer.test.js`
- Modify: `rainbond-platform-installer/scripts/platform-installer.js`

- [x] Add failing tests for key-auth reuse, interactive password fallback, no-TTY handoff, changed-host-key refusal, and cleanup.
- [x] Run `node --test tests/platform-installer.test.js` and confirm the new tests fail for missing behavior.
- [x] Implement the minimal SSH session helper and pass its `ControlPath` to `ssh` and `scp`.
- [x] Close the session on success, failure, and signals.
- [x] Run the focused test file until it passes.

### Task 2: Skill and user guidance

**Files:**
- Modify: `rainbond-platform-installer/SKILL.md`
- Modify: `rainbond-platform-installer/references/installation-policy.md`
- Modify: `rainbond-platform-installer/references/troubleshooting.md`
- Modify: `README.md`
- Modify: `tests/platform-installer.test.js`

- [x] Add a failing contract assertion for native SSH authentication guidance.
- [x] Update docs to describe one-time native password entry and prohibit credentials in chat.
- [x] Run the focused tests.

### Task 3: Verification

- [x] Run `npm test`.
- [x] Run `npm pack --dry-run` and inspect the packaged file list.
- [x] Review the diff for secrets, unsafe host-key bypasses, and unrelated changes.
