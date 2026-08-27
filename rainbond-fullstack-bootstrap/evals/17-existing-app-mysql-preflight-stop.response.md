### Creation Result
The app and its existing `nginx` component were reused for read-only planning. `mysql` was not created because the request did not identify a supported consumer edge or provide a required secret source.

### Actions Taken
Queried the existing component topology and completed the deployment-plan readiness check. The fact that `nginx` is the only existing component was not treated as evidence that it consumes MySQL. No confirmation ID was generated, no mutating Rainbond call was made, and no database credential was generated.

### Current State
`nginx` remains `running`; the requested `mysql` component is `waiting` at the write-before-preflight gate. The app topology is unchanged.

### Handoff Recommendation
Stop here with no downstream handoff. Ask once which component should consume MySQL and for an explicit secret source; continue bootstrap only after both inputs are resolved.

### Structured Output
```yaml
BootstrapResult:
  deployment_plan:
    app_identity:
      team_name: zqh
      region_name: rainbond
      app_name: x-pi
      app_id: 824
    environment:
      name: preview
      source: default
    workflow:
      created: []
      reused:
        - nginx
      skipped:
        - mysql
      skipped_reasons:
        mysql: consumer edge and required secret source unresolved; stopped before mutation
      deferred_dependencies: []
      frontend_access_mode: unspecified
  runtime_state:
    overall: topology_missing
    component_status:
      nginx: running
      mysql: waiting
    blocking_bucket: dependency missing
  next_handoff: none
```
