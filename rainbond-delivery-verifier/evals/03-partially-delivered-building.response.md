### Deployment State
The overall delivery outcome is `partially-delivered` for environment `preview`, app `building-demo`, team `demo-team`, region `us`, app_id `app-delivery-003`. The current runtime state is `topology_building`.

### Component Runtime
- `db status`: `running`
- `api/service status`: `building`
- `frontend status`: `waiting`

### Access URL
There is no usable access URL yet because the frontend is still waiting on upstream convergence.

### Verification Result
Current delivery evidence is inferred from Rainbond runtime and build state only. The dominant blocker is `source build still running`, so the rollout is not yet accepted as delivered.

### Next Step
run troubleshooter

### Structured Output
```yaml
DeliveryVerificationResult:
  runtime_state: topology_building
  delivery_state: partially-delivered
  preferred_access_url: null
  verification_mode: inferred
  blocker: source build still running
  next_action: run_troubleshooter
  component_status:
    db: running
    api/service: building
    frontend: waiting
```
