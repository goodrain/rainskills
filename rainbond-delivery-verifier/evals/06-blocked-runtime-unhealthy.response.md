### Deployment State
The overall delivery outcome is `blocked` for app `runtime-demo`, environment `preview`. The current runtime state is `runtime_unhealthy`.

### Component Runtime
- `db status`: `running`
- `api/service status`: `abnormal`
- `frontend status`: `running`

### Access URL
Preferred candidate URL: `https://demo-team-us.rainbond.me/runtime-demo`

### Verification Result
Verified the preferred host enough to confirm the rollout is still runtime unhealthy: the root page responds, but the same-host backend path is not healthy, so delivery cannot be accepted.

### Next Step
run troubleshooter

### Structured Output
```yaml
DeliveryVerificationResult:
  runtime_state: runtime_unhealthy
  delivery_state: blocked
  preferred_access_url: https://demo-team-us.rainbond.me/runtime-demo
  verification_mode: verified
  blocker: runtime unhealthy
  probe_evidence:
    policy_version: rainskills.delivery-probe-policy.v1
    status: failed
    checks:
      - name: critical_components
        status: verified
      - name: root
        status: verified
      - name: same_host_api
        status: failed
      - name: static_asset
        status: not_applicable
      - name: deep_link
        status: not_applicable
      - name: mime
        status: not_applicable
    persistence:
      status: verified
      caveat: null
  next_action: run_troubleshooter
  component_status:
    db: running
    api/service: abnormal
    frontend: running
```
