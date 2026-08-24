### Project State
The project is `linked-and-source-path-locked` for the `preview` environment with team `demo-team`, region `cn`, app `catalog-app`, and app_id `app-302`. The user gave an explicit GitHub URL for the repository, and the project source profile already returned `topologySource=compose` with a full multi-service list — so the complex-suite evidence gate is already satisfied by the profile itself. Session state also shows a same-named template exists in the application market.

### Actions Performed
Because the compose source profile (`topologySource=compose`) was already in hand, the complex-suite evidence gate was met and no template library was searched. This run kept `rainbond-fullstack-bootstrap` on the source path because the user gave an explicit GitHub URL. The same-named market template was only mentioned as an alternative; no market-template install was performed. The market template stays a suggestion until the user explicitly chooses it.

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
      app_id: 302
    linked: true
    selected_environment: preview
    deployment_location_url: https://run.rainbond.com/#/team/demo-team/region/cn/apps/302/overview
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
      details: Confirmed the linked source app identity, that the user supplied an explicit GitHub URL, and that the project source profile already returned topologySource=compose with the service list.
    - skill: rainbond-fullstack-bootstrap
      status: completed
      details: Compose source profile already in hand (topologySource=compose); the complex-suite evidence gate was satisfied by the profile, so no template library was queried and rainbond_install_app_model was not invoked. Locked the execution path to source from the user-provided GitHub URL; the same-named market template was only mentioned as an alternative.
  next_action: build the linked source app on the user-provided GitHub URL
```
