### Project State
The project is `linked-and-switching-to-source-with-residue` for the `preview` environment with team `demo-team`, region `cn`, app `catalog-app`, and app_id `app-303`. Session state shows a half-installed, abandoned app left behind by an earlier template path, and the user has now confirmed switching to the source path.

### Actions Performed
This run did not silently leave the residue in place. `rainbond-fullstack-bootstrap` will own the source build only after cleanup; the abandoned half-installed template app was surfaced to the user and queued for deletion before any new source component is created.

### Current Health
db status null, api/service status building, frontend-access status null, overall status topology_building.

### Blocking Issue
A half-installed app from the previous template path still exists, so it must be deleted before the confirmed source path proceeds to avoid leaving orphaned resources.

### Next Step
delete the abandoned half-installed template app before building the source path

### Structured Output
```yaml
AppAssistantResult:
  project:
    identity:
      team_name: demo-team
      region_name: cn
      app_name: catalog-app
      app_id: app-303
    linked: true
    selected_environment: preview
    deployment_location_url: https://run.rainbond.com/#/team/demo-team/region/cn/apps/app-303/overview
  environment:
    name: preview
    source: local_preference
    env_delta_present: true
    secrets_provided: true
  request_intent: source_app_delivery
  execution_path:
    requested_kind: source
    resolved_kind: source
  orchestration_state: linked-and-switching-to-source-with-residue
  runtime_state:
    phase: topology_building
    db_status: null
    api_status: building
    frontend_status: null
    blocker: A half-installed app from the previous template path still exists, so it must be deleted before the confirmed source path proceeds to avoid leaving orphaned resources.
  delivery_state: null
  promotion_result: null
  actions_performed:
    - skill: inspection-only
      status: completed
      details: Detected a half-installed abandoned app left by the earlier template path and surfaced it to the user before switching to the confirmed source path.
    - skill: rainbond-fullstack-bootstrap
      status: pending
      details: Will build the source path only after the abandoned half-installed template app is deleted.
  next_action: delete the abandoned half-installed template app before building the source path
```
