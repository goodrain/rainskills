### Project State
The project is `linked-and-source-path-locked` for the `preview` environment with team `demo-team`, region `cn`, app `catalog-app`, and app_id `app-302`. The user provided an explicit GitHub URL for the repository, and session state shows a same-named template exists in the application market.

### Actions Performed
This run kept `rainbond-fullstack-bootstrap` on the source path because the user gave an explicit GitHub URL. The same-named market template was only mentioned as an alternative; no market-template install was invoked. The market template stays a suggestion until the user explicitly chooses it.

### Current Health
db status null, api/service status building, frontend-access status null, overall status topology_building.

### Blocking Issue
The source build on the user-provided GitHub URL is still in progress, so the topology has not yet converged.

### Next Step
build the linked source app on the user-provided GitHub URL

### Structured Output
```yaml
AppAssistantResult:
  project:
    identity:
      team_name: demo-team
      region_name: cn
      app_name: catalog-app
      app_id: app-302
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
  orchestration_state: linked-and-source-path-locked
  runtime_state:
    phase: topology_building
    db_status: null
    api_status: building
    frontend_status: null
    blocker: The source build on the user-provided GitHub URL is still in progress, so the topology has not yet converged.
  delivery_state: null
  promotion_result: null
  actions_performed:
    - skill: inspection-only
      status: completed
      details: Confirmed the linked source app identity and that the user supplied an explicit GitHub URL.
    - skill: rainbond-fullstack-bootstrap
      status: completed
      details: Locked the execution path to source from the user-provided GitHub URL; the same-named market template was only mentioned as an alternative and rainbond_install_app_model was not invoked.
  next_action: build the linked source app on the user-provided GitHub URL
```
