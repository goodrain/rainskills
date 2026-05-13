### Creation Result
The app was reused. All in-scope components were reused: `web`, `api`, and `postgres`.

### Actions Taken
Used `rainbond.app.json` and `.rainbond/local.json` to resolve the target app, confirmed the existing runtime components, and made no create or delete mutations in this run.

### Current State
`web`, `api`, and `postgres` are all `running`. The declared frontend `access_mode` is `reverse-proxy`, and there are no deferred dependencies.

### Handoff Recommendation
Setup complete for bootstrap. No downstream handoff is recommended from this run.

### Structured Output
```yaml
BootstrapResult:
  deployment_plan:
    app_identity:
      team_name: demo-team
      region_name: us-west
      app_name: demo-shop
      app_id: app-demo-001
    environment:
      name: preview
      source: local_preference
    workflow:
      created: []
      reused:
        - web
        - api
        - postgres
      skipped: []
      skipped_reasons: {}
      deferred_dependencies: []
      frontend_access_mode: reverse-proxy
  runtime_state:
    overall: runtime_healthy
    component_status:
      web: running
      api: running
      postgres: running
    blocking_bucket: null
  next_handoff: none
```
