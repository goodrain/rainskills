### Project State
The project is `linked-and-topology-missing` for the `preview` environment with team `demo-team`, region `cn`, app `orders-app`, and app_id `app-201`.

### Actions Performed
This run resolved local binding and current project intent. `rainbond-fullstack-bootstrap` was selected as the next safe step because the linked source app still has no established topology.

### Current Health
db status null, api/service status waiting, frontend-access status null, overall status topology_missing.

### Blocking Issue
The linked source app has no established topology yet, so bootstrap is required before runtime or delivery evidence can exist.

### Next Step
run bootstrap

### Structured Output
```yaml
AppAssistantResult:
  project:
    identity:
      team_name: demo-team
      region_name: cn
      app_name: orders-app
      app_id: app-201
    linked: true
    selected_environment: preview
    deployment_location_url: https://run.rainbond.com/#/team/demo-team/region/cn/apps/app-201/overview
  environment:
    name: preview
    source: local_preference
    env_delta_present: true
    secrets_provided: true
  request_intent: source_app_delivery
  execution_path:
    requested_kind: source
    resolved_kind: source
  orchestration_state: linked-and-topology-missing
  runtime_state:
    phase: topology_missing
    db_status: null
    api_status: waiting
    frontend_status: null
    blocker: The linked source app has no established topology yet, so bootstrap is required before runtime or delivery evidence can exist.
  delivery_state: null
  promotion_result: null
  actions_performed:
    - skill: inspection-only
      status: completed
      details: Resolved the linked source app identity and current project intent from local binding plus current MCP truth.
    - skill: rainbond-fullstack-bootstrap
      status: pending
      details: Selected as the next safe step because the linked source app still has no established topology.
  next_action: run bootstrap
```
