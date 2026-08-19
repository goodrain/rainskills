### Creation Result
The source-backed `web` component was created, but bootstrap stopped during source build convergence because an external artifact download was unreachable.

### Actions Taken
Created the `web` source component from the declared Git source, read component events, then read the failing build log for `event-web-88`. No local package upload, image fallback, Docker build, or temporary image push was attempted.

### Current State
`web` is `abnormal`. The build log shows a timeout while downloading a GitHub Release asset for a native dependency, so the normalized blocker is `external artifact unreachable`.

### Handoff Recommendation
Use code/build handoff. Provide a Rainbond-reachable artifact mirror or restore outbound artifact access, then retry the same source-backed component; do not switch delivery mode without explicit user confirmation.

### Structured Output
```yaml
BootstrapResult:
  deployment_plan:
    app_identity:
      team_name: demo-team
      region_name: rainbond
      app_name: docs-site
      app_id: 6
    environment:
      name: preview
      source: explicit
    workflow:
      created:
        - web
      reused: []
      skipped: []
      skipped_reasons: {}
      deferred_dependencies: []
      frontend_access_mode: unspecified
  runtime_state:
    overall: code_or_build_handoff_needed
    component_status:
      web: abnormal
    blocking_bucket: external artifact unreachable
  next_handoff: code_build_handoff
```
