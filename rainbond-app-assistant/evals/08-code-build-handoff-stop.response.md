### Project State
The project is `linked-and-needs-code-build-handoff` for the `preview` environment with team `demo-team`, region `cn`, app `frontend-console`, and app_id `app-208`.

### Actions Performed
This run completed `rainbond-fullstack-troubleshooter` and confirmed the remaining issue belongs to source/build remediation. `rainbond-delivery-verifier` was skipped because the current blocker is a frontend build/access-path problem.

### Current Health
db status running, api/service status running, frontend-access status abnormal, overall status code_or_build_handoff_needed.

### Blocking Issue
The frontend build output still points to localhost, so the current source app requires source/build configuration changes before delivery verification can succeed.

### Next Step
handoff to code/build agent

### Structured Output
```yaml
AppAssistantResult:
  project:
    identity:
      team_name: demo-team
      region_name: cn
      app_name: frontend-console
      app_id: 208
    linked: true
    selected_environment: preview
    deployment_location_url: https://run.rainbond.com/#/team/demo-team/region/cn/apps/208/overview
  environment:
    name: preview
    source: local_preference
    env_delta_present: true
    secrets_provided: true
  request_intent: source_app_delivery
  execution_path:
    requested_kind: source
    resolved_kind: source
  orchestration_state: linked-and-needs-code-build-handoff
  runtime_state:
    phase: code_or_build_handoff_needed
    db_status: running
    api_status: running
    frontend_status: abnormal
    blocker: The frontend build output still points to localhost, so the current source app requires source/build configuration changes before delivery verification can succeed.
  delivery_state: null
  promotion_result: null
  actions_performed:
    - skill: inspection-only
      status: completed
      details: Confirmed the linked source app identity and bounded repair scope.
    - skill: rainbond-fullstack-troubleshooter
      status: completed
      details: Confirmed the frontend access-path issue belongs to source/build remediation rather than Rainbond-side repair.
    - skill: rainbond-delivery-verifier
      status: skipped
      details: Deferred because delivery verification is not valid before code/build remediation.
  next_action: handoff to code/build agent
```
