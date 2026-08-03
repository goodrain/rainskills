# Rainskills Device Flow Design

## Goal

Replace the loopback callback as the preferred interactive Rainbond authorization path with an OAuth 2.0 Device Authorization Grant style flow. A Rainskills process running on a desktop, an SSH server, or in a container must be able to wait for authorization completed in any browser that can reach the same Rainbond Console.

The existing loopback callback and `--token` paths remain available for backward compatibility and CI.

## Scope

This feature spans three repositories:

- `rainbond-console` (`v6.9.7-dev`): device authorization persistence, protocol endpoints, token issuance, validation, throttling, and one-time consumption.
- `rainbond-ui` (`v6.9.7-dev`): authenticated `/device` page, login/registration return handling, approval and denial actions, and bilingual copy.
- `rainskills` (`main`): device authorization discovery, browser handoff, polling, terminal output, fallback, and tests.

The Rainbond region-side `rainbond` repository is out of scope because the flow only authorizes Console and MCP access.

## Non-Goals

- Do not replace Rainbond's existing login, registration, SSO, or general Console JWT format. Device Flow adds a separately scoped JWT type.
- Do not add unattended username/password login.
- Do not remove the existing `/cli-auth` loopback flow.
- Do not add refresh tokens or change the current MCP credential-loading behavior.
- Do not add new Codex, Claude Code, OpenClaw, or Pi installation targets as part of this change.

## User Experience

### Desktop

After the user chooses a Rainbond environment, Rainskills creates a device authorization request, prints the verification URL and user code, opens `verification_uri_complete` in the local browser, and starts polling. The browser shows the same user code and asks the logged-in user to approve or deny Rainskills MCP access. Approval causes the terminal to continue automatically.

### SSH, Headless Linux, and Containers

Rainskills prints the verification URL and code but does not try to open a local browser:

```text
请在电脑或手机打开：
https://rainbond.example.com/#/device

输入授权码：
K4P7-M9QX

正在等待授权...
```

The user opens the URL on another device, enters or confirms the code, signs in, and approves. The terminal learns the result by polling Rainbond over outbound HTTP(S); there is no inbound callback or copied JWT.

### Private and Internal Environments

The verification URL is built from the Rainbond base URL selected by the user. No Rainbond Cloud broker is involved. Both the Rainskills host and the browser must be able to reach the same Console. VPN or an SSH tunnel remains an operator concern when the browser is outside the private network.

Existing explicit insecure-HTTP consent remains authoritative. Rainskills must not silently permit an HTTP Console URL for Device Flow if the current installation path would reject it.

RFC 8628 requires TLS. Device Flow therefore uses HTTPS by default. When a private trial environment uses HTTP, Rainskills may only continue after the existing explicit `--allow-insecure-http` consent; terminal and browser copy label this as a high-risk, non-RFC compatibility mode because the device code and resulting bearer credential are observable on the network.

## Protocol

The protocol follows RFC 8628 request, response, polling, and error semantics while using Rainbond-specific endpoint paths and the existing Rainbond JWT as the access token.

### Public Client

Rainskills is a public client:

- `client_id`: `rainskills`
- `scope`: `mcp`
- no client secret is shipped in the npm package

Unknown clients and unsupported scopes are rejected.

### Create Device Authorization

```http
POST /console/mcp/device/code
Content-Type: application/x-www-form-urlencoded

client_id=rainskills&scope=mcp
```

Success returns HTTP 200 with `Cache-Control: no-store`:

```json
{
  "device_code": "high-entropy-secret",
  "user_code": "K4P7-M9QX",
  "verification_uri": "https://rainbond.example.com/#/device",
  "verification_uri_complete": "https://rainbond.example.com/#/device?user_code=K4P7-M9QX",
  "expires_in": 600,
  "interval": 5
}
```

The canonical origin comes from a new `RAINBOND_CONSOLE_PUBLIC_URL` setting when configured. Without it, Console uses Django's validated direct request scheme and host and ignores forwarded host/proto headers unless trusted-proxy settings are explicitly enabled. Rainskills independently pins the browser URL to the already validated Rainbond base origin and the fixed `/#/device` path, so it never opens a host supplied only by the response. Tests cover spoofed Host/forwarded headers, TLS termination, private IPs, IPv6, and non-default ports.

Protocol errors are flat OAuth JSON responses with HTTP 400, `Cache-Control: no-store`, and `Pragma: no-cache`:

- `invalid_request`: missing, empty, duplicated, or malformed required parameters
- `invalid_client`: `client_id` is not exactly `rainskills`
- `invalid_scope`: scope is not exactly `mcp`

Unknown parameters are ignored. Abuse throttling returns HTTP 429 with `Retry-After` and the same no-store headers.

### Browser Inspection

Before asking for approval, the authenticated UI validates the code without changing its state:

```http
POST /console/mcp/device/inspect
Authorization: GRJWT <browser-session-token>
Content-Type: application/json

{ "user_code": "K4P7-M9QX" }
```

Success uses the Console envelope and returns only the normalized code, client display name, requested scope, seconds until expiry, and safe status. It never returns the device-code hash, approving user ID, or a JWT.

### Browser Decision

The authenticated UI submits:

```http
POST /console/mcp/device/authorize
Authorization: GRJWT <browser-session-token>
Content-Type: application/json

{
  "user_code": "K4P7-M9QX",
  "decision": "approve"
}
```

`decision` is either `approve` or `deny`. The endpoint normalizes case and separators, validates that the request is pending and unexpired, and atomically records the authenticated user and decision. It never accepts a user ID, enterprise ID, JWT, callback URL, or requested scope from the browser.

The inspection and decision endpoints use these HTTP outcomes inside the existing `general_message` envelope:

- 200: inspected, approved, or denied
- 400: malformed code or decision
- 401: browser is not authenticated
- 404: code is invalid
- 409: request was already approved, denied, or consumed
- 410: code expired
- 429: attempt budget exhausted, with `Retry-After`

### Token Polling

```http
POST /console/mcp/device/token
Content-Type: application/x-www-form-urlencoded

grant_type=urn:ietf:params:oauth:grant-type:device_code&device_code=high-entropy-secret&client_id=rainskills
```

Pending and terminal failures use RFC 8628 error names:

```json
{ "error": "authorization_pending" }
{ "error": "slow_down" }
{ "error": "access_denied" }
{ "error": "expired_token" }
{ "error": "invalid_grant" }
```

OAuth protocol failures return HTTP 400 and include `invalid_request`, `invalid_client`, `invalid_grant`, and `unsupported_grant_type`. `authorization_pending`, `slow_down`, `access_denied`, and `expired_token` also return HTTP 400 as defined by the token endpoint contract. All responses carry no-store/no-cache headers. Expired rows are retained for a bounded cleanup grace period so a known expired device code returns `expired_token`; only then are they removed.

When approved, Console atomically loads the approving user, issues a scoped JWT through a new `console.utils.jwt_issuer.issue_mcp_jwt` entry point, marks the grant consumed, and returns HTTP 200 with `Cache-Control: no-store`:

```json
{
  "access_token": "rainbond-jwt",
  "token_type": "Bearer",
  "expires_in": 2592000,
  "scope": "mcp"
}
```

The exact `expires_in` value is derived from a configurable MCP JWT lifetime, defaulting to 30 days, rather than duplicated as a magic constant.

The issued JWT contains `token_use=mcp`, `scope=mcp`, `aud=rainbond-mcp`, and the approving user's signed `enterprise_id`. General Console authentication rejects `token_use=mcp`; MCP authentication accepts it only when all scoped claims match. Existing unscoped JWTs remain accepted by MCP for backward compatibility. Rainskills reads the signed enterprise claim for installation reporting and only falls back to `/console/users/details` for legacy unscoped tokens.

## Persistence and State Machine

Device authorization state is stored in the Console database so polling and browser requests can land on different Console replicas.

Stored fields:

- SHA-256 hash of `device_code`, unique
- domain-separated HMAC-SHA256 of normalized `user_code`, unique
- `client_id` and `scope`
- status: `pending`, `approved`, `denied`, or `consumed`
- approving `user_id`, nullable until approval
- `created_at`, `expires_at`, `approved_at`, `last_polled_at`, and `consumed_at`
- polling interval
- failed inspection count

Neither the plaintext `device_code`, plaintext `user_code`, nor a JWT is stored. HMAC uses a dedicated key derived from Django's server secret and a fixed domain label, preventing offline enumeration after a database-only leak. Expired records are deleted opportunistically after a bounded grace period. The migration adds indexes required for code lookup and expiration cleanup.

A second database table stores atomic rate-limit buckets as a keyed HMAC, window start, count, and expiry. This avoids the existing process-local cache fallback and keeps limits consistent across Console replicas. Source addresses use `REMOTE_ADDR` by default; forwarded addresses are used only when the immediate peer belongs to explicitly configured trusted-proxy CIDRs. Raw addresses are never persisted.

Allowed transitions:

```text
pending -> approved -> consumed
pending -> denied
pending -> expired (derived from expires_at)
```

Approval, denial, and token exchange use conditional state updates with checked row counts inside transactions so concurrent requests cannot authorize twice or consume a grant twice. This is testable on SQLite and preserves atomicity on MySQL; an additional MySQL integration test uses separate connections for race coverage. If the approving user is deleted or deactivated before exchange, the grant transitions to denied and polling returns `access_denied`.

## Security Controls

- Generate `device_code` with at least 256 bits of entropy.
- Generate eight independently random significant characters from `23456789BCDFGHJKMNPQRTVWXY` and format them as `XXXX-XXXX`; no fixed prefix consumes entropy.
- Hash both codes before persistence; compare using normalized hashes.
- Expire both codes after ten minutes.
- Limit browser code attempts to five per ten minutes per authenticated user and source address, and keep a per-grant failure budget.
- Limit anonymous device creation and invalid token polling per source address with shared database counters.
- Enforce the advertised poll interval and return `slow_down` for early polling.
- Require an authenticated Rainbond user for approval and denial.
- Display the user code, Rainskills client identity, requested MCP scope, and a warning to approve only an installation the user initiated.
- Never place device codes or JWTs in process arguments, browser URLs, logs, database rows, telemetry, shell tracing, or error bodies. Rainskills sends sensitive request values via request bodies/files.
- Add `Cache-Control: no-store` and `Pragma: no-cache` to code and token responses.
- Treat Rainskills as a public client; do not embed a client secret.
- Keep all existing HTTPS enforcement and explicit HTTP opt-in behavior.

## UI Design

Add `/device` under the authenticated `SecurityLayout`.

The page has three compact states:

1. Code entry: one normalized code input and a continue action that calls the inspection endpoint.
2. Confirmation: current account, visible user code, Rainskills identity, MCP permission summary, approve and deny actions.
3. Result: authorization completed, denied, expired, or invalid, with no token displayed.

When `verification_uri_complete` contains `user_code`, the field is prefilled but the code remains visible for confirmation. Login and registration redirects accept only same-origin `/device` and `/cli-auth` destinations; arbitrary redirect URLs remain rejected.

API calls live in the UI service layer and asynchronous state lives in a DVA model. Text is added in both `zh-CN` and `en-US` locale modules. Styling uses the existing Ant Design 3.x components and theme variables.

## Rainskills Client Behavior

Interactive authorization proceeds in this order:

1. Reuse an explicitly supplied or valid cached token exactly as today.
2. Request a Device Flow code.
3. If Device Flow succeeds, print the URL/code, optionally open `verification_uri_complete` on a local desktop, and poll.
4. Honor `authorization_pending`, `slow_down`, `access_denied`, `expired_token`, timeout, and `Ctrl+C`.
5. Pass the returned JWT into the existing validation, persistence, MCP registration, and installation reporting path.
6. If the code endpoint returns a verified same-origin legacy route-not-found response before any device code is issued, use the existing loopback/manual-copy flow for older Rainbond installations.

Only a 404 matching the legacy Console route-not-found signature can trigger fallback. HTTP 405, `invalid_client`, `invalid_scope`, malformed responses, redirects to another origin, 429, network failures, and 5xx responses never downgrade. Once a device code has been issued, no later failure can enter the legacy flow.

The first poll waits the advertised interval. Each `slow_down` adds five seconds to all later intervals. Network timeouts apply bounded exponential backoff, and HTTP 429 honors `Retry-After` without crossing the monotonic deadline derived from the smaller of `expires_in` and an explicit `RAINBOND_LOGIN_TIMEOUT`. Without an override, Device Flow uses the server's `expires_in`; the legacy callback retains its existing timeout behavior.

`--non-interactive` without `--token` continues to fail rather than starting a human authorization wait. `--no-browser` suppresses browser launch but does not disable Device Flow polling.

## Compatibility and Rollout

Deployment order:

1. Release the backward-compatible `rainbond-ui` `/device` page and redirect preservation.
2. Release `rainbond-console` endpoints and database migration after the UI route is available.
3. Publish a new Rainskills npm prerelease that prefers Device Flow.

This order ensures Console never advertises Device Flow before the UI exists. Rolling deployments additionally gate code issuance on a UI capability/version flag. Mixed-version tests cover old UI/new Console replicas and new UI/old Console. Older Consoles continue through `/cli-auth`; older Rainskills clients continue to work against the retained loopback page.

## Testing

### rainbond-console

- Model migration and indexes.
- Code entropy, formatting, normalization, hashing, collision retry, and expiration.
- Only supported client/scope/grant values are accepted.
- Unauthenticated users cannot approve or deny.
- Pending, slow-down, approved, denied, expired, invalid, and consumed token responses.
- Concurrent approval and consumption preserve one-time semantics.
- JWT is returned only from the token endpoint and never persisted.
- MCP-scoped JWTs are accepted by MCP endpoints, rejected by general Console endpoints, and carry the signed enterprise claim.
- Rate-limit behavior and no-store response headers.
- Host and forwarded-header spoofing, trusted TLS termination, private addresses, IPv6, and non-default ports.
- Optional MySQL concurrency coverage for conditional state transitions.

### rainbond-ui

- Production build gate.
- Manual browser verification for prefilled and manually entered codes.
- Login and registration return to `/device` with the code intact.
- Invalid, expired, denied, approved, loading, and retry states.
- Same-origin redirect allowlist regression for both `/device` and `/cli-auth`.
- Automated redirect-helper tests cover hash/history routes, hostile origins, encoded codes, login, registration, SSO return, and localStorage cleanup; production build remains the final UI gate.

### rainskills

- Device Flow success with pending polls.
- `slow_down` increases subsequent polling interval.
- Denied, expired, timeout, malformed response, rate-limit, and server-error output.
- Desktop opens `verification_uri_complete` while SSH/container only prints it.
- A verified legacy 404 capability fallback uses the existing browser callback flow; 405 and all ambiguous failures do not downgrade.
- `--token`, cached-token, legacy private login, non-interactive, installation, MCP validation, and signal-cleanup regressions remain green.
- Packed tarball smoke test exercises the Device Flow client without downloading repository content.
- Fake clock/sleep/HTTP/browser tests make expiry, repeated slowdown, retry-after, timeout, and no-downgrade behavior deterministic and assert secrets never appear in argv or output.

### Cross-Repository Contract

Verify endpoint paths, form fields, JSON fields, error names, expiration, interval behavior, and route names across all three repositories before release.

## References

- RFC 8628, OAuth 2.0 Device Authorization Grant: https://www.rfc-editor.org/rfc/rfc8628.html
