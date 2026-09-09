### Creation Result
Reused the existing package-backed `api` component with the same `service_id` (`svc-api-1`); no replacement component or version-suffixed name was created.

### Actions Taken
Queried the target app first and matched `api` to `svc-api-1`. Initialized the new upload with `component_id=svc-api-1`, used the exact client upload contract, ran local cleanup immediately after the HTTP attempt, and required a non-empty uploaded-file status. Then called `rainbond_replace_component_package` with `service_id=svc-api-1`, the new upload event, and `expected_current_event_id=evt-old`. The returned build event `evt-build-2` completed successfully and the existing component passed the health check.

### Current State
`api` is `running` on the updated package. No blue/green component was created and `rainbond_create_component_from_package` was not called for the existing component.

### Handoff Recommendation
Runtime is healthy; hand off to `rainbond-delivery-verifier` for final access verification.

### Structured Output
```yaml
BootstrapResult:
  deployment_plan:
    app_identity:
      team_name: demo-team
      region_name: rainbond
      app_name: client-package-demo
      app_id: 14
    environment:
      name: preview
      source: default
    workflow:
      created: []
      reused:
        - api
      skipped: []
      skipped_reasons: {}
      deferred_dependencies: []
      frontend_access_mode: unspecified
  runtime_state:
    overall: runtime_healthy
    component_status:
      api: running
    blocking_bucket: null
  next_handoff: delivery_verifier
```
