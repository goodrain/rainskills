# Windows Installer Progress Output Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace noisy Windows/WSL installation output with ordered stage progress, live elapsed heartbeats, and protected diagnostic logs.

**Architecture:** Keep the existing seven provisioning actions and the `rc.48` WSL runtime lease intact. Add small PowerShell helpers for stage rendering, event parsing, sanitization, and protected per-operation logging; extend the Bash bootstrap only to emit Docker preparation heartbeats while its package child is alive.

**Tech Stack:** Windows PowerShell 5.1, WSL2, Bash, Node.js built-in test runner

---

### Task 1: Lock the Windows output contract with failing tests

**Files:**
- Modify: `tests/windows-platform.test.js`
- Modify: `tests/windows-contract.ps1`

- [ ] **Step 1: Add source contract tests**

Add tests that extract the new standalone PowerShell helpers and assert:

```js
assert.match(stageRunner, /\[\.\.\].*\$StageNumber\/\$StageCount/);
assert.match(stageRunner, /\& \$Action/);
assert(stageRunner.indexOf("& $Action") < stageRunner.indexOf("[OK]"));
assert.match(progressParser, /ConvertFrom-Json/);
assert.match(progressParser, /preparing-docker|installing-rainbond|verifying-rainbond/);
assert.match(progressParser, /started|heartbeat|completed/);
assert.doesNotMatch(invokeBootstrap, /Write-Host \$_/);
assert.match(invokeBootstrap, /Diagnostic log:/);
assert.match(sanitizer, /Bearer|password|device[_-]?code|access[_-]?token|refresh[_-]?token/);
assert.match(logInitializer, /ReparsePoint/);
```

Also assert `Invoke-ProvisionRainbond` calls stage 1 through 7 in order, starts the existing WSL runtime lease after import, and releases it in `finally`.

- [ ] **Step 2: Add failing PowerShell behavioral contracts**

Use the existing AST function-loading pattern in `tests/windows-contract.ps1` to execute the production progress parser, sanitizer, stage wrapper, log initializer, and bootstrap runner. Cover:

- valid `started -> heartbeat* -> completed` transitions;
- duplicate, out-of-order, malformed, unknown-stage/status, invalid-timestamp, and extra-field events;
- no `[OK]` when a stage action throws;
- bounded control-free error summaries;
- bearer/JWT/password/device/access/refresh-token redaction before both file append and summary selection;
- diagnostic-path inclusion only after a safe log exists;
- operation-bound log containment and ACL application;
- rejection of malicious operation IDs and machine-root, log-directory, or existing-log-file reparse points.

- [ ] **Step 3: Add native import and Docker heartbeat contracts**

Assert `prepare_docker` starts package work as a child, emits `preparing-docker heartbeat` while that PID is alive, waits for it, and propagates its exit status. Assert `Invoke-ImportDistro` invokes a native process wrapper that polls `wsl --import` every 10 seconds, logs its output, displays monotonic stage elapsed time, and propagates the native exit code.

- [ ] **Step 4: Run the portable focused tests and verify RED**

Run: `node --test tests/windows-platform.test.js`

Expected: the new progress/logging contracts fail while all pre-existing assertions remain green.

### Task 2: Implement safe progress and diagnostic output in PowerShell

**Files:**
- Modify: `rainbond-platform-installer/scripts/windows-platform.ps1`
- Test: `tests/windows-platform.test.js`

- [ ] **Step 1: Add fixed stage rendering helpers**

Implement `Format-StageElapsed` and `Invoke-ProvisionStage`. The wrapper prints a stable ASCII start line, invokes the supplied script block, and prints `[OK]` only after success:

```powershell
function Invoke-ProvisionStage([int]$StageNumber, [int]$StageCount, [string]$Label, [ScriptBlock]$Action) {
  $watch = [Diagnostics.Stopwatch]::StartNew()
  Write-Host ("[..] {0}/{1} {2} {3}" -f $StageNumber, $StageCount, $Label, (Format-StageElapsed $watch.Elapsed))
  $result = & $Action
  $watch.Stop()
  Write-Host ("[OK] {0}/{1} {2} {3}" -f $StageNumber, $StageCount, $Label, (Format-StageElapsed $watch.Elapsed))
  return $result
}
```

- [ ] **Step 2: Add centralized sanitization and protected logging**

Implement helpers that strip ANSI/control characters, redact bearer/JWT/password/device/access/refresh-token forms, bound summary lines to 240 characters, and create `%ProgramData%\RainSkills\<installation-id>\logs\<operation-id>.log`. Require the already schema-validated UUID operation ID, construct the filename from that ID only, resolve the final path, and verify it remains immediately beneath the resolved installation log directory. Validate machine root, log directory, and existing/new log file as regular non-reparse items, then apply `Set-MachineRootAcl` before appending UTF-8 text.

- [ ] **Step 3: Parse only fixed progress events**

Update `Invoke-DistroBootstrap` so every WSL line is sanitized and appended to the current operation log. Accept only an object with exactly `schema`, `stage`, `status`, and `timestamp`; require schema `rainskills.platform-progress.v1`, one of the three fixed stages, one of the three fixed statuses, and a parseable UTC ISO timestamp. Reject additional display fields. Enforce `started -> heartbeat* -> completed`, render heartbeat lines with fixed local labels and stopwatch elapsed time, and log/ignore malformed, duplicate, or out-of-order events. Remove unconditional `Write-Host $_`.

- [ ] **Step 4: Preserve concrete failure errors**

Keep `Managed WSL bootstrap action failed: <action>: <detail>`, using the last sanitized non-progress line and adding `. Diagnostic log: <path>` only when a safe current-operation log exists.

- [ ] **Step 5: Wrap the seven existing provisioning stages**

Replace direct stage `Write-Host` calls in `Invoke-ProvisionRainbond` with `Invoke-ProvisionStage`. Preserve the exact action order, `Start-WslRuntimeLease` after import, `Invoke-VerifyDeployment` before return, and lease cleanup in `finally`.

- [ ] **Step 6: Add a heartbeat-aware native WSL import runner**

Run `wsl --import` through `Diagnostics.Process` with redirected stdout/stderr. Immediately start concurrent `ReadToEndAsync()` drains for both streams, poll `WaitForExit(10000)` and print a fixed elapsed heartbeat while it is active, then consume the completed drain tasks, sanitize/log their lines, and propagate the native exit code. Do not display native WSL output directly and never wait for process completion before both drains have started.

- [ ] **Step 7: Run focused tests and verify GREEN**

Run: `node --test tests/windows-platform.test.js`

Expected: all tests pass except the existing Windows-only PowerShell parser skip on macOS.

The new behavioral PowerShell contracts execute in `tests/windows-contract.ps1` during Windows CI.

### Task 3: Add Docker preparation heartbeats

**Files:**
- Modify: `rainbond-platform-installer/scripts/wsl-bootstrap.sh`
- Test: `tests/windows-platform.test.js`

- [ ] **Step 1: Run package preparation as one child process**

When Docker is absent, run `apt-get update` and `apt-get install` in a subshell, emit `preparing-docker heartbeat` every 10 seconds while its PID exists, `wait` for it, and return the real child exit code. Keep `started` before work and `completed` only after Docker is verified.

- [ ] **Step 2: Verify Bash and focused contracts**

Run: `bash -n rainbond-platform-installer/scripts/wsl-bootstrap.sh`

Run: `node --test tests/windows-platform.test.js`

Expected: Bash syntax succeeds and all focused contracts pass.

### Task 4: Verify, version, package, commit, and push

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Regenerate: `marketplace/rainskills/.claude-plugin/plugin.json`
- Regenerate: `marketplace/rainskills/.codex-plugin/plugin.json`
- Regenerate: `marketplace/rainskills/skills/rainskills/SKILL.md`

- [ ] **Step 1: Run Windows and full repository checks**

Run: `npm run test:windows`

Run: `PATH="/tmp/rainskills-rc44-test-venv/bin:$PATH" npm test`

Run: `npm run check:marketplace && npm run check:pi && npm audit --audit-level=high && git diff --check`

Expected: zero failures; only the documented local PowerShell parser skip is allowed before Windows CI.

- [ ] **Step 2: Bump the unpublished candidate version**

Bump from `0.1.0-rc.48` to the next unused RC with `npm version <version> --no-git-tag-version`, then run `npm run build:marketplace`.

- [ ] **Step 3: Build and inspect the tarball**

Run: `npm pack --json`

Run: `shasum -a 256 rainskills-<version>.tgz`

Run: `npm publish ./rainskills-<version>.tgz --access public --tag next --dry-run`

Expected: tarball contains the updated PowerShell/Bash helpers and dry-run succeeds. Do not publish.

- [ ] **Step 4: Commit only scoped files**

Commit message: `fix: improve Windows installation progress output`

Do not stage either pre-existing `docs/superpowers/plans/2026-08-03-*` file.

- [ ] **Step 5: Push and verify CI**

Push `main`, then confirm the full GitHub Test workflow and `Windows non-mutating contract` job pass before giving the user publish and Windows verification commands.
