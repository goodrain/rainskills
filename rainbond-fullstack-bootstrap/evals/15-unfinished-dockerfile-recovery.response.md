### Creation Result
Reused the unfinished `api` component. Its `create_status=checked` permits the Console check-result path to apply `prefer_dockerfile_when_detected=true`; no deletion was performed.

### Actions Taken
Read the check result with the Dockerfile preference, then verified the returned Dockerfile evidence before continuing. The component remains in its existing topology while detection converges.

### Current State
`api` is still building and has no runtime blocker yet.

### Handoff Recommendation
Wait for the bounded build result; do not recreate the component.

### Structured Output
```yaml
BootstrapResult:
  deployment_plan:
    app_identity:
      team_name: demo-team
      region_name: rainbond
      app_name: checked-api
      app_id: 15
    environment:
      name: preview
      source: explicit
    workflow:
      created: []
      reused:
        - api
      skipped: []
      skipped_reasons: {}
      deferred_dependencies: []
      frontend_access_mode: unspecified
      build_strategy_decisions:
        api:
          picked: dockerfile
          source: heuristic
          reason: "Console check result returned Dockerfile evidence for the unfinished component."
  runtime_state:
    overall: topology_building
    component_status:
      api: building
    blocking_bucket: null
  next_handoff: none
```
