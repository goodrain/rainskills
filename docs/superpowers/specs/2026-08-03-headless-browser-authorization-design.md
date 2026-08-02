# Headless Browser Authorization Design

## Goal

Keep the current automatic browser callback on local desktop systems while
using the existing copy-and-paste callback flow only in SSH, headless Linux,
and container environments.

This change must not alter platform selection, Rainbond platform installation,
skill copying, token validation and storage, or MCP registration.

## Authorization Mode Selection

The installer selects one of two modes immediately before Rainbond browser
authorization:

- `local-browser`: Open the authorization URL and wait for the loopback
  callback. This remains the default for a local macOS terminal and for Linux
  with an available graphical session and `xdg-open`.
- `manual-copy`: Print the authorization URL and wait for the user to paste the
  full callback URL or JWT. Select this mode for SSH sessions, containers, and
  Linux systems without a usable graphical browser.

Selection priority:

1. `--no-browser` or `RAINSKILLS_NO_BROWSER=1` selects `manual-copy`.
2. An SSH session selects `manual-copy`, even if X11 forwarding sets
   `DISPLAY`. An SSH session is present when any of `SSH_CONNECTION`,
   `SSH_CLIENT`, or `SSH_TTY` is non-empty.
3. A detected container selects `manual-copy`, even if a display variable is
   inherited or mounted. A container is present when `/.dockerenv` or
   `/run/.containerenv` exists, the `container` environment variable is
   non-empty, or `/proc/1/cgroup` contains a Docker, containerd, Kubernetes,
   Podman/libpod, or LXC marker.
4. Local macOS with `open` selects `local-browser`.
5. Local Linux with `xdg-open` and `DISPLAY` or `WAYLAND_DISPLAY` selects
   `local-browser`.
6. All other environments select `manual-copy`.

`--no-browser` is an installer option, not a separate installation path. The
environment variable exists for AI-driven and wrapped executions where adding
arguments is inconvenient.

## Data Flow

Both modes create the same random `state`, loopback callback server, and
Rainbond authorization URL.

In `local-browser` mode, the browser navigates directly to the loopback
callback. In `manual-copy` mode, authorization may finish in a browser on a
different device. The browser's loopback page can fail to load; the user copies
the full address-bar URL back to the waiting terminal. A pasted callback URL
must contain the expected `state`; the installer rejects a missing or
mismatched state, extracts the JWT, and forwards it to its own loopback server.
Directly pasting a raw JWT remains an explicit compatibility exception because
it cannot carry callback state; normal JWT validation still runs before the
credential is used or stored.

After either mode obtains a token, both continue through the existing shared
token validation, credential storage, MCP registration, and connectivity
checks.

## Error Handling

- Manual mode clearly states that a failed `127.0.0.1` browser page is expected
  in a remote-session flow.
- Invalid URLs, missing tokens, and mismatched states remain rejected.
- `Ctrl+C`, timeout, and process cleanup keep using the existing cleanup path.
- The JWT must not be printed after it is pasted.

## Compatibility

- Existing invocation arguments remain valid. SSH and container invocations
  intentionally change only their browser authorization presentation from a
  local-browser attempt to `manual-copy`.
- Platform selection, Rainbond installation, skill copying, token persistence,
  MCP registration, and post-authorization validation remain unchanged.
- Desktop macOS and Linux retain automatic browser opening.
- Existing `--token` and `RAINBOND_JWT` non-interactive flows continue to skip
  browser authorization entirely.
- Existing username/password compatibility behavior is unchanged.

## Verification

Add focused tests for authorization-mode selection in these environments:

- local macOS desktop
- local Linux graphical desktop
- SSH with and without forwarded display variables
- Docker/Podman-style container markers
- headless Linux
- explicit `--no-browser`
- `RAINSKILLS_NO_BROWSER=1`

Retain the current PTY and signal-cleanup tests to prove the manual callback
reader, loopback server, and temporary files are cleaned up. Assert that pasted
JWT input is not printed by the installer. Update installer help and README
documentation for `--no-browser` and `RAINSKILLS_NO_BROWSER`. Run the complete
test suite after the focused tests pass.
