### Project State
The project is `linked-and-cluster-capacity-blocked` for the `preview` environment with team `demo-team`, region `cn`, app `ops-dashboard`, and app_id `app-207`.

### Actions Performed
This run resolved the linked source app state and current platform evidence. `rainbond-fullstack-troubleshooter` was not entered because the dominant blocker is active cluster capacity shortage.

### Current Health
db status running, api/service status running, frontend-access status capacity-blocked, overall status capacity_blocked.

### Blocking Issue
The web component is unschedulable because cluster CPU is exhausted, so delivery verification is not a safe next action.

### Next Step
fix cluster capacity first

### Structured Output
```yaml
AppAssistantResult:
  project:
    identity:
      team_name: demo-team
      region_name: cn
      app_name: ops-dashboard
      app_id: app-207
    linked: true
    selected_environment: preview
    deployment_location_url: https://run.rainbond.com/#/team/demo-team/region/cn/apps/app-207/overview
  environment:
    name: preview
    source: local_preference
    env_delta_present: true
    secrets_provided: true
  request_intent: source_app_delivery
  execution_path:
    requested_kind: source
    resolved_kind: source
  orchestration_state: linked-and-cluster-capacity-blocked
  runtime_state:
    phase: capacity_blocked
    db_status: running
    api_status: running
    frontend_status: capacity-blocked
    blocker: The web component is unschedulable because cluster CPU is exhausted, so delivery verification is not a safe next action.
  delivery_state: null
  promotion_result: null
  actions_performed:
    - skill: inspection-only
      status: completed
      details: Confirmed the linked source app identity and active capacity blocker from current platform truth.
    - skill: rainbond-fullstack-troubleshooter
      status: skipped
      details: Deferred because active cluster capacity shortage must be fixed before bounded runtime repair can continue.
  next_action: fix cluster capacity first
```
