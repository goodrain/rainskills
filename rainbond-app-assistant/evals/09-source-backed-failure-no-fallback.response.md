### Project State
The project is `linked-and-source-build-failed` for the `preview` environment with team `demo-team`, region `cn`, app `catalog-app`, and app_id `app-209`.

### Actions Performed
This run kept the source-backed path intact. `rainbond-fullstack-bootstrap` stopped after the source build failed, and it did not switch to package upload, image creation, or template install. `rainbond-fullstack-troubleshooter` is the next bounded step on the same source path.

### Current Health
db status null, api/service status building, frontend-access status null, overall status topology_building.

### Blocking Issue
The current source build failed on the linked source app, so the next step is source-build-first troubleshooting on the same source path rather than any package/image/template fallback.

### Next Step
run troubleshooter on the same source path

### Structured Output
```yaml
AppAssistantResult:
  project:
    identity:
      team_name: demo-team
      region_name: cn
      app_name: catalog-app
      app_id: app-209
    linked: true
    selected_environment: preview
  environment:
    name: preview
    source: local_preference
    env_delta_present: true
    secrets_provided: true
  request_intent: source_app_delivery
  execution_path:
    requested_kind: source
    resolved_kind: source
  orchestration_state: linked-and-source-build-failed
  runtime_state:
    phase: topology_building
    db_status: null
    api_status: building
    frontend_status: null
    blocker: The current source build failed on the linked source app, so the next step is source-build-first troubleshooting on the same source path rather than any package/image/template fallback.
  delivery_state: null
  promotion_result: null
  actions_performed:
    - skill: inspection-only
      status: completed
      details: Confirmed the linked source app identity and preserved the source-backed execution path.
    - skill: rainbond-fullstack-bootstrap
      status: stopped
      details: Source-backed bootstrap stopped after the source build failed and did not switch to package upload, image creation, or template install.
    - skill: rainbond-fullstack-troubleshooter
      status: pending
      details: Selected as the next bounded step to inspect source build evidence on the same source path.
  next_action: run troubleshooter on the same source path
```
