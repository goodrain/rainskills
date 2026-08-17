### Project State
The project is `linked-and-topology-building` for the `preview` environment with team `demo-team`, region `cn`, app `inventory-app`, and app_id `app-202`.

### Actions Performed
This run resolved the linked source app state and kept the source path intact. `rainbond-fullstack-troubleshooter` was selected because topology exists but source-backed components are still converging.

### Current Health
db status running, api/service status building, frontend-access status waiting, overall status topology_building.

### Blocking Issue
Source-backed components are still building and need bounded convergence inspection before delivery verification is safe.

### Next Step
run troubleshooter

### Structured Output
```yaml
AppAssistantResult:
  project:
    identity:
      team_name: demo-team
      region_name: cn
      app_name: inventory-app
      app_id: app-202
    linked: true
    selected_environment: preview
    deployment_location_url: https://run.rainbond.com/#/team/demo-team/region/cn/apps/app-202/overview
  environment:
    name: preview
    source: local_preference
    env_delta_present: true
    secrets_provided: true
  request_intent: source_app_delivery
  execution_path:
    requested_kind: source
    resolved_kind: source
  orchestration_state: linked-and-topology-building
  runtime_state:
    phase: topology_building
    db_status: running
    api_status: building
    frontend_status: waiting
    blocker: Source-backed components are still building and need bounded convergence inspection before delivery verification is safe.
  delivery_state: null
  promotion_result: null
  actions_performed:
    - skill: inspection-only
      status: completed
      details: Resolved the linked source app state from current platform truth without changing the source-backed path.
    - skill: rainbond-fullstack-troubleshooter
      status: pending
      details: Selected because topology exists but source-backed components are still converging.
  next_action: run troubleshooter
```
