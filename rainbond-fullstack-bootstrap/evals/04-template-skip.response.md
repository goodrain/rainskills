### Creation Result
The app was reused. `api` and `web` were created in this run, while the template-backed `redis` component was skipped.

### Actions Taken
Used `rainbond.app.json` and `.rainbond/local.json`, created `api` and `web`, preserved the template-backed `redis` definition, and recorded that it must be handled upstream by `rainbond-template-installer` instead of bootstrap.

### Current State
`api` is `running` and `web` is `waiting`. The topology is still incomplete because the `redis` dependency remains intentionally skipped until template installation happens outside bootstrap.

### Handoff Recommendation
No downstream handoff is recommended from this bootstrap run. The skipped template-backed component still requires upstream handling through `rainbond-template-installer` before a later bootstrap or runtime stage continues.

### Structured Output
```yaml
BootstrapResult:
  deployment_plan:
    app_identity:
      team_name: demo-team
      region_name: us-west
      app_name: template-demo
      app_id: app-demo-004
    environment:
      name: preview
      source: default
    workflow:
      created:
        - api
        - web
      reused: []
      skipped:
        - redis
      skipped_reasons:
        redis: template-backed component; handle via rainbond-template-installer
      deferred_dependencies: []
      frontend_access_mode: reverse-proxy
  runtime_state:
    overall: topology_building
    component_status:
      api: running
      web: waiting
    blocking_bucket: dependency missing
  next_handoff: none
```
