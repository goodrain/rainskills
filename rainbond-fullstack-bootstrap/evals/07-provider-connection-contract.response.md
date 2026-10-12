### Creation Result
Created the in-scope components `mysql`, `api`, and `web` from the manifest.

### Actions Taken
Inspected `mysql` storage and mounted durable storage at /var/lib/mysql with an explicit volume name before deployment. Configured the MySQL provider inner port and stable port alias, then created provider connection envs on mysql. Used `rainbond_manage_component_dependency` to wire `api -> mysql` with `service_id=api, dep_service_id=mysql`. No duplicate consumer DB envs were added to `api`; it receives the provider contract through the dependency. The `web -> api` dependency was also wired after `api` converged, then deployed the configured components.

### Current State
`mysql`, `api`, and `web` are all `running`. The declared frontend `access_mode` is `reverse-proxy`, no dependency remains deferred, and the topology is ready for delivery acceptance.

### Handoff Recommendation
Runtime is converged enough that the remaining question is final access behavior, so hand off to `rainbond-delivery-verifier`.

### Structured Output
```yaml
BootstrapResult:
  deployment_plan:
    app_identity:
      team_name: demo-team
      region_name: rainbond
      app_name: mysql-provider-demo
      app_id: 7
    environment:
      name: preview
      source: default
    workflow:
      created:
        - mysql
        - api
        - web
      reused: []
      skipped: []
      skipped_reasons: {}
      deferred_dependencies: []
      frontend_access_mode: reverse-proxy
  runtime_state:
    overall: runtime_healthy
    component_status:
      mysql: running
      api: running
      web: running
    blocking_bucket: null
  next_handoff: delivery_verifier
```
