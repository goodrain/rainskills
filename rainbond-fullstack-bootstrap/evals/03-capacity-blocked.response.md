### Creation Result
The app was reused. All in-scope components were reused: `web`, `api`, and `postgres`.

### Actions Taken
Used `rainbond.app.json` and `.rainbond/local.json`, confirmed the existing topology, and refreshed runtime evidence without changing the current component set.

### Current State
`api` and `postgres` are `running`, but `web` is `capacity-blocked` because the cluster cannot currently schedule the workload. No deferred dependency is hiding this blocker.

### Handoff Recommendation
Ready for troubleshooting with `rainbond-fullstack-troubleshooter`. The dominant blocker is `cluster capacity blocked`, so the next stage should focus on capacity evidence instead of further bootstrap mutations.

### Structured Output
```yaml
BootstrapResult:
  deployment_plan:
    app_identity:
      team_name: demo-team
      region_name: us-west
      app_name: capacity-demo
      app_id: 3
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
    overall: capacity_blocked
    component_status:
      web: capacity-blocked
      api: running
      postgres: running
    blocking_bucket: cluster capacity blocked
  next_handoff: troubleshooter
```
