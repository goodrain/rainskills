### Creation Result
The app was reused. No component was created or reused in this run because the source-backed `api` stopped at `multiple services detected`, and `web` was skipped together with that stop condition.

### Actions Taken
Used `rainbond.app.json` and `.rainbond/local.json`, attempted the source-backed `api` path, stopped at the ambiguity result, and did not switch to image creation or package upload after the stop.

### Current State
`api` is `waiting` for an explicit component-selection strategy, and `web` is also `waiting` because the upstream API path has not become safe to continue. The current bootstrap run remains blocked at source ambiguity instead of falling back to another delivery mode.

### Handoff Recommendation
Stop here with no downstream handoff. The operator must provide an explicit source component-selection strategy before bootstrap can continue the source path.

### Structured Output
```yaml
BootstrapResult:
  deployment_plan:
    app_identity:
      team_name: demo-team
      region_name: us-west
      app_name: ambiguity-demo
      app_id: 5
    environment:
      name: preview
      source: explicit
    workflow:
      created: []
      reused: []
      skipped:
        - api
        - web
      skipped_reasons:
        api: source-backed component stopped at multiple services detected; explicit source strategy required
        web: not executed because the upstream source path stopped before safe dependency resolution
      deferred_dependencies: []
      frontend_access_mode: reverse-proxy
  runtime_state:
    overall: topology_missing
    component_status:
      api: waiting
      web: waiting
    blocking_bucket: dependency missing
  next_handoff: none
```
