### Creation Result
The app was reused. `api` and `web` were created in this run, while `postgres` was reused.

### Actions Taken
Used `rainbond.app.json`, `.rainbond/local.json`, and `.rainbond/env.preview.json`, created the source-backed `api`, created `web`, preserved the `web -> api` dependency intent, and deferred that edge until upstream convergence is complete.

### Current State
`api` is `building`, `web` is `waiting`, and `postgres` is `running`. The dependency `web -> api` remains deferred_by_upstream_convergence while the source-backed `api` build is still running.

### Handoff Recommendation
Ready for troubleshooting with `rainbond-fullstack-troubleshooter` once the current bootstrap run stops. The dominant blocker is `source build still running`, so bootstrap should not force dependency wiring yet.

### Structured Output
```yaml
BootstrapResult:
  deployment_plan:
    app_identity:
      team_name: demo-team
      region_name: us-west
      app_name: deferred-demo
      app_id: app-demo-002
    environment:
      name: preview
      source: explicit
    workflow:
      created:
        - api
        - web
      reused:
        - postgres
      skipped: []
      skipped_reasons: {}
      deferred_dependencies:
        - web -> api
      frontend_access_mode: reverse-proxy
  runtime_state:
    overall: topology_building
    component_status:
      api: building
      web: waiting
      postgres: running
    blocking_bucket: source build still running
  next_handoff: troubleshooter
```
