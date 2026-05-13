### Deployment State
The overall delivery outcome is `blocked` for environment `preview`, app `capacity-demo`, team `demo-team`, region `us`, app_id `app-delivery-004`. The current runtime state is `capacity_blocked`.

### Component Runtime
- `db status`: `running`
- `api/service status`: `running`
- `frontend status`: `capacity-blocked`

### Access URL
There is no usable access URL because the frontend workload is not schedulable yet.

### Verification Result
Current delivery evidence is inferred from runtime events. The blocker is `cluster capacity blocked`, so delivery cannot be accepted from this run.

### Next Step
fix cluster capacity first

### Structured Output
```yaml
DeliveryVerificationResult:
  runtime_state: capacity_blocked
  delivery_state: blocked
  preferred_access_url: null
  verification_mode: inferred
  blocker: cluster capacity blocked
  next_action: fix_cluster_capacity_first
  component_status:
    db: running
    api/service: running
    frontend: capacity-blocked
```
