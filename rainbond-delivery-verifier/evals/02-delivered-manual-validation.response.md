### Deployment State
The overall delivery outcome is `delivered-but-needs-manual-validation` for environment `preview`, app `manual-demo`, team `demo-team`, region `us`, app_id `app-delivery-002`. The final runtime state is `runtime_healthy`.

### Component Runtime
- `db status`: `running`
- `api/service status`: `running`
- `frontend status`: `running`

### Access URL
Preferred user-facing URL: `https://demo-team-us.rainbond.me/manual-demo`

### Verification Result
Verified Rainbond-side runtime convergence and resolved the preferred user-facing URL. External browser reachability was inferred from current evidence instead of directly checked from this run, so manual validation is still required.

### Next Step
manual URL validation

### Structured Output
```yaml
DeliveryVerificationResult:
  runtime_state: runtime_healthy
  delivery_state: delivered-but-needs-manual-validation
  preferred_access_url: https://demo-team-us.rainbond.me/manual-demo
  verification_mode: inferred
  blocker: null
  next_action: manual_url_validation
  component_status:
    db: running
    api/service: running
    frontend: running
```
