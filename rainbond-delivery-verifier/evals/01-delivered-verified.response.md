### Deployment State
The overall delivery outcome is `delivered` for app `delivered-demo`, environment `preview`. The final runtime state is `runtime_healthy`.

### Component Runtime
- `db status`: `running`
- `api/service status`: `running`
- `frontend status`: `running`
- all critical components converged

### Access URL
Preferred user-facing URL: `https://demo-team-us.rainbond.me/delivered-demo`

### Verification Result
Verified the preferred root URL and the same-host /api path with the bounded probe. Stateful middleware persistence verified at the database data directory. A representative static asset returned the expected JavaScript MIME type, the deep-link returned the application shell, and the MIME checks did not resolve to an HTML fallback. The delivery result is `verified`, not inferred.

### Next Step
stop, delivery complete

### Structured Output
```yaml
DeliveryVerificationResult:
  runtime_state: runtime_healthy
  delivery_state: delivered
  preferred_access_url: https://demo-team-us.rainbond.me/delivered-demo
  verification_mode: verified
  blocker: null
  probe_evidence:
    policy_version: rainskills.delivery-probe-policy.v1
    status: verified
    checks:
      - name: critical_components
        status: verified
      - name: root
        status: verified
      - name: same_host_api
        status: verified
      - name: static_asset
        status: verified
      - name: deep_link
        status: verified
      - name: mime
        status: verified
    persistence:
      status: verified
      caveat: null
  next_action: stop
  component_status:
    db: running
    api/service: running
    frontend: running
```
