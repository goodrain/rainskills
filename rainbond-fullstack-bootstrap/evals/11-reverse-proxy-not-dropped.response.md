### Creation Result
Created `nginx`, `api`, and `web`, one Rainbond component per compose service. The `nginx` reverse proxy was kept, not dropped.

### Actions Taken
The frontend `web` uses same-origin path routing (`CONSOLE_API_URL=/api`) and the `nginx` config fans one host out to several upstreams by path (`/console/api`, `/api`, `/v1` -> `api`). So `nginx` is kept as a component and made the single external entry point: only `nginx` gets an external port (`enable_outer`) and is the unique outward-facing component; `web` and `api` get inner ports only and are not exposed directly. Before deploying `nginx`, its routing config (`nginx.conf`) was mounted as a config-file and every `proxy->upstream` dependency edge was wired — `nginx -> web` and `nginx -> api` plus `web -> api` with `rainbond_manage_component_dependency`. The nginx upstream addresses were not left as compose names or `127.0.0.1`: each `upstream` / `proxy_pass` target was rewritten to the upstream provider's dependency-injected `_HOST` value (its k8s service internal domain) and port, since `127.0.0.1` would only hold under built-in-mesh governance. The proxy was only deployed once both the routing config was mounted and the upstream edges existed; a naked nginx with no routing config mounted would have been reported as a delivery blocker instead.

### Current State
`nginx`, `web`, and `api` are all `running`. The declared frontend `access_mode` is `reverse-proxy`, no dependency remains deferred, and the topology has converged.

### Handoff Recommendation
Runtime is converged and the remaining question is final access behavior through the proxy, so hand off to `rainbond-delivery-verifier`.

### Structured Output
```yaml
BootstrapResult:
  deployment_plan:
    app_identity:
      team_name: demo-team
      region_name: rainbond
      app_name: reverse-proxy-demo
      app_id: app-compose-011
    environment:
      name: preview
      source: default
    workflow:
      created:
        - nginx
        - api
        - web
      reused: []
      skipped: []
      skipped_reasons: {}
      deferred_dependencies: []
      frontend_access_mode: reverse-proxy
      dependency_edges:
        - nginx -> api
        - nginx -> web
        - web -> api
      proxy_routing_config: mounted
  runtime_state:
    overall: runtime_healthy
    component_status:
      nginx: running
      api: running
      web: running
    blocking_bucket: null
  next_handoff: delivery_verifier
```
