### Project State
The project is `linked-and-needs-delivery-verification` for the `preview` environment with team `demo-team`, region `cn`, app `billing-app`, and app_id `app-203`.

### Actions Performed
This run resolved the linked source app state and confirmed runtime convergence. `rainbond-delivery-verifier` was selected because delivery acceptance is still unknown.

### Current Health
db status running, api/service status running, frontend-access status running, overall status runtime_healthy.

### Blocking Issue
No Rainbond-side blocker is currently dominant inside runtime; delivery acceptance is still unknown until delivery-verifier runs.

### Next Step
run delivery verifier

### Structured Output
```yaml
AppAssistantResult:
  project:
    identity:
      team_name: demo-team
      region_name: cn
      app_name: billing-app
      app_id: app-203
    linked: true
    selected_environment: preview
  environment:
    name: preview
    source: explicit
    env_delta_present: true
    secrets_provided: true
  request_intent: source_app_delivery
  execution_path:
    requested_kind: source
    resolved_kind: source
  orchestration_state: linked-and-needs-delivery-verification
  runtime_state:
    phase: runtime_healthy
    db_status: running
    api_status: running
    frontend_status: running
    blocker: null
  delivery_state: null
  promotion_result: null
  actions_performed:
    - skill: inspection-only
      status: completed
      details: Confirmed runtime convergence for the linked source app from current MCP truth.
    - skill: rainbond-delivery-verifier
      status: pending
      details: Selected because runtime is healthy but delivery acceptance is still unknown.
  next_action: run delivery verifier
```
