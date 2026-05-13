### Deployment State
The overall delivery outcome is `blocked` for environment `preview`, app `runtime-demo`, team `demo-team`, region `us`, app_id `app-delivery-006`. The current runtime state is `runtime_unhealthy`.

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
  next_action: run_troubleshooter
  component_status:
    db: running
    api/service: abnormal
    frontend: running
```
