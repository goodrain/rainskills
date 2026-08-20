### Creation Result
The prior CNB component had `create_status=complete`. After a topology and configuration snapshot and explicit user confirmation, it was recreated once with Dockerfile preference.

### Actions Taken
Recorded ports, environments, dependencies, and storage before replacement; restored that configuration after the single confirmed recreate.

### Current State
`api` is building with the selected Dockerfile strategy.

### Handoff Recommendation
Wait for the bounded build result and do not repeat the recreate automatically.

### Structured Output
```yaml
BootstrapResult:
  deployment_plan:
    app_identity:
      team_name: demo-team
      region_name: rainbond
      app_name: complete-cnb-api
      app_id: 16
    environment:
      name: preview
      source: explicit
    workflow:
      created:
        - api
      reused: []
      skipped: []
      skipped_reasons: {}
      deferred_dependencies: []
      frontend_access_mode: unspecified
      build_strategy_decisions:
        api:
          picked: dockerfile
          source: user_choice
          reason: "Confirmed replacement is required because completed CNB has no general in-place switch."
  runtime_state:
    overall: topology_building
    component_status:
      api: building
    blocking_bucket: null
  next_handoff: none
```
