### Project State
The project is `linked-and-component-just-created` for the `preview` environment with team `demo-team`, region `cn`, app `catalog-app`, and app_id `app-304`. The component was just created successfully and its `service_alias` is already known from the create return.

### Actions Performed
This run reused the service_alias from the successful create return and went straight to configuration. `rainbond-fullstack-bootstrap` did not re-list components or re-resolve identity, because both the alias and the session user are already known from this run.

### Current Health
db status null, api/service status building, frontend-access status null, overall status topology_building.

### Blocking Issue
The freshly created component still needs ports and envs configured before it can build and converge.

### Next Step
configure ports and envs on the known service_alias from the create return

### Structured Output
```yaml
AppAssistantResult:
  project:
    identity:
      team_name: demo-team
      region_name: cn
      app_name: catalog-app
      app_id: 304
    linked: true
    selected_environment: preview
    deployment_location_url: https://run.rainbond.com/#/team/demo-team/region/cn/apps/304/overview
  environment:
    name: preview
    source: local_preference
    env_delta_present: true
    secrets_provided: true
  request_intent: source_app_delivery
  execution_path:
    requested_kind: source
    resolved_kind: source
  orchestration_state: linked-and-component-just-created
  runtime_state:
    phase: topology_building
    db_status: null
    api_status: building
    frontend_status: null
    blocker: The freshly created component still needs ports and envs configured before it can build and converge.
  delivery_state: null
  promotion_result: null
  actions_performed:
    - skill: inspection-only
      status: completed
      details: Confirmed the linked source app identity from the session context without an extra current-user call.
    - skill: rainbond-fullstack-bootstrap
      status: completed
      details: Reused the service_alias returned by the successful component create and moved straight to configuration without re-querying components or re-fetching the current user.
  next_action: configure ports and envs on the known service_alias from the create return
```
