### Project State
The project is `linked-and-identity-ambiguous` for the `preview` environment. Current local binding and current platform evidence still leave multiple safe team/app targets, so no single app identity can be emitted yet.

### Actions Performed
This run only performed context resolution. No lower-level bootstrap, troubleshooter, delivery-verifier, or version flow was executed because the team/app identity is still ambiguous.

### Current Health
No canonical runtime_state or delivery_state can be emitted yet because the team/app identity is still ambiguous.

### Blocking Issue
Multiple safe team/app targets remain after reading local binding and current platform evidence.

### Next Step
stop and ask the user to choose the team/app identity

### Structured Output
```yaml
AppAssistantResult:
  project:
    identity:
      team_name: null
      region_name: null
      app_name: null
      app_id: null
    linked: null
    selected_environment: null
    deployment_location_url: null
  environment:
    name: preview
    source: default
    env_delta_present: false
    secrets_provided: false
  request_intent: source_app_delivery
  execution_path:
    requested_kind: source
    resolved_kind: unknown
  orchestration_state: linked-and-identity-ambiguous
  runtime_state: null
  delivery_state: null
  promotion_result: null
  actions_performed:
    - skill: inspection-only
      status: completed
      details: Local binding and current platform evidence still leave multiple safe team/app targets.
  next_action: stop and ask the user to choose the team/app identity
```
