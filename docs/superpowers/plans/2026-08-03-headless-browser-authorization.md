# Headless Browser Authorization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route Rainbond authorization to manual callback copying only for SSH, headless Linux, containers, or an explicit override while preserving automatic browser callbacks on local desktop systems.

**Architecture:** Keep authorization in `install.sh`, but separate environment classification into small source-testable shell functions. Both browser modes continue through the existing callback server and shared token/MCP path; only the presentation and callback handoff differ.

**Tech Stack:** Bash, Python 3 PTY tests, npm test scripts, Markdown documentation

---

## File Structure

- Modify `install.sh`: add environment classification, `--no-browser`, source-safe execution, strict pasted callback-state validation, and silent secret input.
- Create `tests/browser_authorization_mode_test.sh`: table-driven unit coverage for desktop, SSH, container, headless, override, and pasted callback parsing behavior.
- Modify `tests/installer_signal_cleanup_test.py`: keep real PTY coverage explicitly in manual mode and verify the input path does not echo a pasted JWT.
- Modify `package.json`: run the focused browser-mode test as part of `test:installer`.
- Modify `README.md`: document automatic headless behavior and the explicit override.

### Task 1: Authorization Mode Classification

**Files:**
- Create: `tests/browser_authorization_mode_test.sh`
- Modify: `install.sh:138-205`
- Modify: `install.sh:1007-1028`
- Modify: `install.sh:2087-2091`
- Modify: `package.json`

- [ ] **Step 1: Write failing table-driven tests**

Source `install.sh` and assert the following results from a single
`browser_authorization_mode` function:

```bash
assert_mode manual-copy parsed_flag --no-browser
assert_mode manual-copy env RAINSKILLS_NO_BROWSER=1 DISPLAY=:0 with_xdg_open
assert_mode manual-copy env SSH_CONNECTION='client server' DISPLAY=:0 with_xdg_open
assert_mode manual-copy env SSH_CLIENT='client 123 22'
assert_mode manual-copy env SSH_TTY='/dev/pts/1'
assert_mode manual-copy env container='podman' WAYLAND_DISPLAY=wayland-0 with_xdg_open
assert_mode local-browser macos_with_open
assert_mode local-browser linux_with_xdg_open_and_DISPLAY
assert_mode local-browser linux_with_xdg_open_and_WAYLAND_DISPLAY
assert_mode manual-copy linux_without_display
```

Test `is_container_environment <root>` independently with temporary
`/.dockerenv`, `/run/.containerenv`, and `/proc/1/cgroup` fixtures covering
Docker, containerd, kubepods, libpod, and LXC markers.

Every classification case must run in a subshell that first unsets
`RAINSKILLS_NO_BROWSER`, `SSH_CONNECTION`, `SSH_CLIENT`, `SSH_TTY`, `container`,
`DISPLAY`, and `WAYLAND_DISPLAY`; uses a temporary command directory for
`uname`, `open`, and `xdg-open`; and stubs container detection unless the case
is specifically testing it. This prevents the developer machine or CI runner
from changing the result.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
bash tests/browser_authorization_mode_test.sh
```

Expected: FAIL because `install.sh` cannot yet be sourced without running
`main`, and the classification helpers do not exist.

- [ ] **Step 3: Make `install.sh` source-safe**

Wrap process traps, reporting initialization, and `main "$@"` so they run only
when the installer is executed directly:

```bash
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  trap 'handle_installer_signal 130' INT
  trap 'handle_installer_signal 143' TERM
  trap 'handle_installer_exit "$?"' EXIT
  initialize_rainskills_installation_reporting "$@"
  main "$@"
fi
```

- [ ] **Step 4: Implement minimal classification helpers**

Add focused functions with these contracts:

```bash
is_ssh_session               # SSH_CONNECTION, SSH_CLIENT, or SSH_TTY
is_container_environment     # optional root prefix for fixture tests
browser_authorization_mode   # prints local-browser or manual-copy
can_open_browser             # true only for local-browser
```

Classification order must match the approved design: explicit override, SSH,
container, local macOS, graphical Linux, fallback manual.

- [ ] **Step 5: Parse the explicit override**

Initialize `NO_BROWSER` from `RAINSKILLS_NO_BROWSER`, recognize
`--no-browser` in `parse_args`, and list both forms in `usage`. The override
must not change non-browser flags or imply `--non-interactive`.

- [ ] **Step 6: Run focused tests and verify GREEN**

Run:

```bash
bash tests/browser_authorization_mode_test.sh
bash -n install.sh
```

Expected: all browser-mode assertions pass and Bash syntax exits 0.

- [ ] **Step 7: Register focused tests in npm scripts**

Prepend the focused shell test to `test:installer` so it cannot regress:

```json
"test:installer": "bash tests/browser_authorization_mode_test.sh && python3 tests/install_test_suite_tty_test.py"
```

- [ ] **Step 8: Commit**

```bash
git add install.sh tests/browser_authorization_mode_test.sh package.json
git commit -m "feat: route headless authorization safely"
```

### Task 2: Manual Callback Input Security

**Files:**
- Modify: `tests/browser_authorization_mode_test.sh`
- Modify: `tests/installer_signal_cleanup_test.py`
- Modify: `install.sh:1030-1080`

- [ ] **Step 1: Write failing callback parser tests**

Assert that:

- a callback URL containing the expected `state` returns its JWT;
- a mismatched `state` is rejected;
- a callback URL without `state` is rejected;
- a raw compact JWT remains accepted for compatibility.

- [ ] **Step 2: Run parser tests and verify RED**

Run:

```bash
bash tests/browser_authorization_mode_test.sh
```

Expected: FAIL because a callback URL without `state` is currently accepted.

- [ ] **Step 3: Require callback state without removing raw-JWT fallback**

Update `extract_token_from_paste` so URL input requires a non-empty state equal
to the active authorization state. Leave compact JWT parsing unchanged.

- [ ] **Step 4: Add a failing PTY no-echo assertion**

Extend the real manual authorization PTY test to paste a recognizable test JWT
and assert that the installer output collected after the prompt does not contain
that JWT.

- [ ] **Step 5: Disable terminal echo while reading the callback**

Use silent TTY input and restore normal formatting after the read:

```bash
if ! IFS= read -r -s pasted </dev/tty; then
  printf '\n' >&2
  return 0
fi
printf '\n' >&2
```

Do not print the parsed token or callback URL.

- [ ] **Step 6: Run focused and PTY tests**

Run:

```bash
bash tests/browser_authorization_mode_test.sh
python3 tests/installer_signal_cleanup_test.py
```

Expected: parser, manual-mode, no-echo, Ctrl+C, SIGTERM, port cleanup, process
cleanup, and temporary-file cleanup assertions all pass.

- [ ] **Step 7: Commit**

```bash
git add install.sh tests/browser_authorization_mode_test.sh tests/installer_signal_cleanup_test.py
git commit -m "fix: secure remote callback handoff"
```

### Task 3: Documentation and Regression Verification

**Files:**
- Modify: `README.md:203-275`

- [ ] **Step 1: Update user documentation**

Document the two automatic modes:

- local macOS/Linux desktop opens the browser and receives the callback;
- SSH, containers, and headless Linux print a link and accept the copied full
  callback URL;
- `--no-browser` and `RAINSKILLS_NO_BROWSER=1` force manual mode;
- `--token` remains the CI/non-interactive route.

Keep the warning that the failed browser `127.0.0.1` page is expected remotely
and that callback URLs/JWTs must only be pasted into the waiting terminal.

- [ ] **Step 2: Run static and targeted verification**

Run:

```bash
bash -n install.sh
bash tests/browser_authorization_mode_test.sh
python3 tests/installer_signal_cleanup_test.py
python3 tests/npx_pty_test.py
```

Expected: all commands exit 0.

- [ ] **Step 3: Run the complete suite**

Use a Python environment with `requirements-test.txt` installed, then run:

```bash
npm test
```

Expected: launcher, marketplace, platform installer, package upload, package,
installer, signal, and npx PTY suites all pass.

- [ ] **Step 4: Inspect the package artifact**

Run:

```bash
npm pack --dry-run
```

Expected: `install.sh`, launcher, entry skill, and all Rainbond skills are
included; development tests and design documents remain excluded.

- [ ] **Step 5: Commit**

```bash
git add README.md
git commit -m "docs: explain headless authorization"
```
