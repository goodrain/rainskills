# Windows Installer Progress Output Design

## Goal

Make the elevated Windows installation window readable while preserving live progress and complete diagnostic evidence. The change applies only to the managed Windows/WSL installation path; macOS and Linux behavior remains unchanged.

## User Experience

The installer keeps the existing numbered stages and renders each stage with a stable status:

```text
RainSkills Windows local installation

[OK] 1/7 Updating the protected RainSkills helper       2s
[OK] 2/7 Importing the Rainbond WSL environment        38s
[..] 4/7 Preparing Docker                            01:12
     Downloading and installing Docker (47.2 MB fetched)
```

Long-running WSL actions emit structured progress events. PowerShell converts those events into concise status lines with elapsed time. It does not show a fabricated overall percentage because image downloads and platform readiness are not predictable.

## Output Architecture

- The seven outer provisioning steps use one fixed stage wrapper. Each step prints `[..] N/7 <label> 00:00` before its action, owns a monotonic per-stage `Stopwatch`, and prints `[OK] N/7 <label> <elapsed>` only after that action returns successfully. Steps execute and complete strictly in numeric order; a failed step never prints `[OK]`, and later steps do not start.
- `wsl-bootstrap.sh` continues to emit `rainskills.platform-progress.v1` events. PowerShell accepts only the exact `schema`, a fixed stage (`preparing-docker`, `installing-rainbond`, or `verifying-rainbond`), a fixed status (`started`, `heartbeat`, or `completed`), and an ISO timestamp. Unknown, malformed, or additional display text is never trusted as console content.
- `windows-platform.ps1` maps fixed stages to fixed English labels. A per-action `Stopwatch` supplies monotonic elapsed time. `started` opens a fixed state, each heartbeat prints a new stable `[..]` detail line, and `completed` closes it. Events are valid only in `started -> heartbeat* -> completed` order. Duplicate starts/completions and out-of-order events are sanitized and logged but ignored for display.
- Every operation expected to exceed 10 seconds has a fixed heartbeat source. WSL bootstrap actions emit a heartbeat every 10 seconds while their child process or readiness loop is alive; `PrepareDocker` is changed to run package preparation under the same heartbeat loop already used by Rainbond installation. Native `wsl --import` runs through a PowerShell process wrapper that prints the current outer stage elapsed time every 10 seconds. Short helper, networking, and loopback checks still show start and completion without fabricated intermediate work.
- No cursor control is required; consoles that cannot rewrite lines get the same readable output as a sequence of stable lines.
- Human-readable progress is written to the elevated console.
- Raw WSL, package-manager, Docker, and Rainbond installer output passes through one PowerShell sanitizer that redacts bearer tokens, JWTs, passwords, device codes, and access/refresh tokens before either persistence or failure-summary selection. ANSI/control sequences and carriage-return animation artifacts are removed.
- Sanitized output is appended to `%ProgramData%\RainSkills\<installation-id>\logs\<operation-id>.log`. Before writing, PowerShell verifies the machine root and log directory are regular non-reparse directories, creates the current operation's log as a regular non-reparse file, and reapplies the existing machine-root ACL contract. Existing files or directories that violate those checks cause the operation to stop.
- Progress JSON, blank/noise-only lines, and dynamic terminal output are not echoed to the console. Malformed progress-like lines are logged as sanitized diagnostics but never rendered as progress.

## Failure Handling

On failure after log creation, the exception keeps the existing contract and appends the current operation's log path:

```text
Managed WSL bootstrap action failed: <action>: <bounded sanitized detail>. Diagnostic log: <path>
```

The detail is the last non-progress sanitized line, stripped of control characters and bounded to 240 characters. The path is conveyed through the existing error result and Node error handling; the `rainskills.windows-result.v1` schema is not extended. Failures before a safe log exists keep the existing error without a diagnostic path. Successful runs do not dump raw logs.

## Testing

- Source contract tests verify that raw WSL lines are no longer unconditionally written to the console.
- PowerShell contract tests verify every allowed progress transition, duplicate/out-of-order/malformed/unknown event handling, fixed labels, monotonic elapsed timing, 10-second heartbeats for every long-running stage, and the no-cursor fallback.
- Numbered-stage contracts verify strict 1-through-7 ordering, start-before-action, completion-after-success, elapsed display, and no premature `[OK]` after a failure.
- Security contracts verify centralized redaction before logging and summary selection, bounded/control-free summaries, operation-bound filenames, ACL application, and rejection of file or directory reparse points.
- Failure contracts verify the unchanged error prefix, current-operation log path, and the no-log fallback.
- Existing Windows provisioning, PowerShell parsing, package, and cross-platform tests must remain green.
