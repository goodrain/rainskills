# Remote Console Address Selection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:test-driven-development while implementing this plan task-by-task.

**Goal:** Select a remote Rainbond Console address that is actually reachable from the Rainskills control machine.

**Architecture:** Resolve the effective SSH hostname, keep remote health evidence separate from URL selection, and probe an ordered candidate list. Fall back to one validated user-supplied host only when automatic discovery fails.

**Tech Stack:** Node.js, OpenSSH, Node test runner

---

### Task 1: Address derivation and probing

**Files:**
- Modify: `tests/platform-installer.test.js`
- Modify: `rainbond-platform-installer/scripts/platform-installer.js`

- [x] Add failing tests for SSH hostname resolution, safe host validation, candidate ordering, and first-reachable selection.
- [x] Run the focused tests and confirm failure for missing behavior.
- [x] Implement the minimal address helpers and pass the resolved host as EIP for new remote installs.
- [x] Keep remote runtime verification independent from Console reachability.

### Task 2: Recovery and user fallback

**Files:**
- Modify: `tests/platform-installer.test.js`
- Modify: `rainbond-platform-installer/scripts/platform-installer.js`
- Modify: `rainbond-platform-installer/references/troubleshooting.md`
- Modify: `README.md`

- [x] Add failing tests for interactive fallback and non-interactive `--console-host` handoff.
- [x] Implement candidate probing, concise diagnostics, waiting-user state, and resume arguments.
- [x] Verify an existing Rainbond follows the verification-only path.

### Task 3: Verification

- [x] Run focused platform installer tests.
- [x] Run `npm test` with Node 24 and the isolated Python environment.
- [x] Run `npm pack --dry-run` and inspect the package contents.
- [x] Review the diff for unsafe URL acceptance and unrelated changes.
