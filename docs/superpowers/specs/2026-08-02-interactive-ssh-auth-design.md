# Interactive SSH Authentication Design

## Goal

Allow Rainskills remote Linux installation to work with both preconfigured SSH keys and ordinary password authentication without collecting or storing credentials.

## User Journey

Rainskills first tries the existing non-interactive SSH connection. If it succeeds, installation continues without another prompt. If OpenSSH reports an unknown host key or missing public-key authentication in an interactive terminal, Rainskills explains the next prompt and opens one native SSH authentication session:

```text
首次连接可能需要确认服务器指纹，并输入一次 SSH 密码。
密码由系统 ssh 直接读取，Rainskills 不会保存。
```

OpenSSH owns host-key confirmation and password entry. After authentication, Rainskills keeps a temporary multiplexed SSH connection and automatically continues preflight, upload, installation, and verification. Completion, failure, `SIGINT`, and `SIGTERM` close the control connection and remove its private temporary directory.

If authentication is required without a TTY, Rainskills emits `RAINSKILLS_USER_INPUT_REQUIRED:ssh_authentication`, prints the exact resume command, marks the operation as waiting for the user, and exits successfully instead of reporting a misleading generic connection failure.

## Security Boundaries

- Passwords and private keys never enter Node.js strings, command arguments, environment variables, state files, or logs.
- Host-key verification remains enabled and is handled by the installed OpenSSH client.
- A changed host key remains a hard failure; Rainskills never deletes or replaces an existing host key.
- `--yes` confirms Rainbond system changes only and never bypasses SSH trust or authentication.
- The control socket lives in a new mode `0700` temporary directory and is removed when the command finishes.

## Implementation

Add an SSH session helper to `rainbond-platform-installer/scripts/platform-installer.js`. It performs a `BatchMode=yes` probe, classifies authentication and host-key failures, creates an OpenSSH `ControlMaster` only when interactive authentication is needed, and injects its `ControlPath` into every later `ssh` and `scp` invocation.

Update the platform installer Skill and published guidance so agents keep the process attached and never request credentials in chat.
