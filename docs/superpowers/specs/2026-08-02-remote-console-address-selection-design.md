# Remote Console Address Selection Design

## Goal

Prevent a successfully installed remote Rainbond from being reported as failed when the remote host's first local interface address is not reachable from the Rainskills control machine.

## Address Model

Keep three concepts separate:

- SSH target: the address used by OpenSSH, such as `root@14.103.55.132` or an SSH alias.
- Rainbond EIP: the address passed to a new Rainbond installation for externally generated links.
- Console URL: an address proven reachable from the machine running Rainskills.

For a new remote installation, resolve the effective SSH hostname with `ssh -G` and prefer it over the remote `hostname -I` result when setting EIP. Existing installations are never recreated merely to change EIP.

## Verification Flow

After remote container, K3s, and component verification succeeds, build an ordered, deduplicated candidate list from:

1. an explicit `--console-host` value;
2. the effective SSH hostname;
3. the literal host portion of the SSH target;
4. Rainbond's reported EIP;
5. the remote machine's primary interface address.

Probe `http://<candidate>:7070` from the control machine and select the first acceptable HTTP response. Record the selected URL in both platform and onboarding state. Re-entry after a failed verification detects the existing Rainbond and repeats only verification, not installation.

If every automatic candidate fails, an interactive terminal asks once for a public IP or domain and validates it before probing. A non-interactive client emits `RAINSKILLS_USER_INPUT_REQUIRED:console_address` and an exact resume command using `--console-host`.

## Security And UX

- Accept only an IP address or DNS hostname, never a scheme, path, credentials, query, shell syntax, or arbitrary port.
- Always construct the probe URL internally with HTTP and port 7070.
- Preserve host-key checking and the existing SSH session behavior.
- Report attempted candidates and their concise failure reasons instead of a context-free timeout.
- Never reinstall, remove, or recreate an existing Rainbond during address recovery.
