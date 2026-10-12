# Delivery verifier output contract

## Default customer output

Successful replies contain only the verified result, application, status, and address. Incomplete replies contain only status, one blocker, and one next step. Each field appears once; unavailable values are omitted rather than guessed. Do not append fixed option lists unless the user asks for options.

```text
部署成功
应用：demo
状态：running
地址：https://example.invalid
```

## Output Format

Target structured output（仅在用户或自动化明确要求结构化结果时使用）：

- this skill must emit `DeliveryVerificationResult`
- minimum target fields:
  - `runtime_state`
  - `delivery_state`
  - `preferred_access_url`
  - `verification_mode`
  - `blocker`
  - `next_action`
- the human-readable sections below should be treated as the narrative view over that target object
- 在明确结构化模式中追加最终 `### Structured Output` section，并用 fenced `yaml` 渲染 `DeliveryVerificationResult`
- the schema and validator under `schemas/` and `scripts/` are the current live contract

Current schema shape:

```yaml
DeliveryVerificationResult:
  runtime_state: topology_missing | topology_building | runtime_unhealthy | runtime_healthy | capacity_blocked | code_or_build_handoff_needed
  delivery_state: delivered | delivered-but-needs-manual-validation | partially-delivered | blocked
  preferred_access_url: string | null
  verification_mode: verified | inferred | manual_validation_needed
  blocker: string | null
  probe_evidence: object | null
  next_action: stop | manual_url_validation | run_troubleshooter | fix_cluster_capacity_first | code_build_handoff
```

Example object:

```json
{
  "runtime_state": "runtime_healthy",
  "delivery_state": "delivered-but-needs-manual-validation",
  "preferred_access_url": "https://example-team-cn.rainbond.me/my-app",
  "verification_mode": "inferred",
  "blocker": null,
  "probe_evidence": null,
  "next_action": "manual_url_validation"
}
```

Example final reply:

````markdown
### Deployment State
The overall delivery outcome is `delivered-but-needs-manual-validation` for app `my-app`, environment `preview`.

### Component Runtime
- `db status`: `running`
- `api/service status`: `running`
- `frontend status`: `running`
- `overall runtime status`: `runtime_healthy`

### Access URL
Preferred user-facing URL: `https://example-team-cn.rainbond.me/my-app`

### Verification Result
Verified MCP runtime convergence and resolved the best access URL. User-facing access was inferred rather than directly checked from the current environment, so manual validation is still needed.

### Next Step
manual URL validation

### Structured Output
```yaml
DeliveryVerificationResult:
  runtime_state: runtime_healthy
  delivery_state: delivered-but-needs-manual-validation
  preferred_access_url: https://example-team-cn.rainbond.me/my-app
  verification_mode: inferred
  blocker: null
  probe_evidence: null
  next_action: manual_url_validation
```
````

Only in explicit structured contract mode, respond using exactly these sections:

### Deployment State
- state the overall delivery outcome
- include `app_name` and selected environment
- do not include `team_name`, `region_name`, or `app_id` in prose; those are available in `### Structured Output` only

### Component Runtime
- report:
  - `db status`
  - `api/service status`
  - `frontend status`
  - `overall runtime status`

### Access URL
- provide the best user-facing URL if available
- if there are multiple candidate URLs, say which one is preferred
- if no URL exists, say so explicitly

### Verification Result
- state what was actually verified
- state whether user-facing access was verified, inferred, or still needs manual validation
- for apps with stateful middleware, state whether persistence was verified; if missing, report `stateful middleware persistence not configured`

### Next Step
- one of:
  - `stop, delivery complete`
  - `manual URL validation`
  - `run troubleshooter`
  - `fix cluster capacity first`
  - `handoff to code/build agent`

### Structured Output
- append a fenced `yaml` block
- render `DeliveryVerificationResult`
- keep enum values and field names aligned with the schema above
- prefer `manual_validation_needed` over ad hoc wording in the structured object
- for `blocked`, include a non-null `blocker`
- `delivered + verified` requires non-null bounded `probe_evidence`; adapter-unavailable and policy-rejected cases use manual validation instead

## Common Mistakes

- declaring delivery complete while components are still building
- treating `running` as equivalent to “user can access it”
- failing to report access URL explicitly
- hiding cluster capacity blockers inside generic unhealthy status
- continuing repairs when the right next step is manual URL validation
- treating a reverse-proxy frontend root URL as delivered when the same-host `/api` path is still broken
- counting a cloud-provider intercept page or placeholder page as successful app delivery
- reporting an app with stateful middleware as cleanly delivered without checking storage persistence

## Quick Reference

Delivery checks:
1. app detail
2. component summaries
3. recent events/logs if needed
4. access info
5. final delivery report

Final truth rules:
- MCP gives runtime truth
- access URL must be explicitly reported
- if external validation is not possible, use the final outcome `delivered-but-needs-manual-validation`
