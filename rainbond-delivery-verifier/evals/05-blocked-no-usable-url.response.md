### Deployment State
The overall delivery outcome is `blocked` for environment `preview`, app `no-url-demo`, team `demo-team`, region `us`, app_id `app-delivery-005`. The runtime state is `runtime_healthy`, but that does not by itself mean the rollout is delivered.

### Component Runtime
- `db status`: `running`
- `api/service status`: `running`
- `frontend status`: `running`

### Access URL
There is no usable access URL. No external access URL is exposed for the current frontend path.

### Verification Result
Current delivery evidence is inferred from runtime and access metadata. Even though the critical components are `running`, the blocker is `no usable access URL`, so the result remains blocked.

### Next Step
run troubleshooter

### Structured Output
```yaml
DeliveryVerificationResult:
  runtime_state: runtime_healthy
  delivery_state: blocked
  preferred_access_url: null
  verification_mode: inferred
  blocker: no usable access URL
  next_action: run_troubleshooter
  component_status:
    db: running
    api/service: running
    frontend: running
```
