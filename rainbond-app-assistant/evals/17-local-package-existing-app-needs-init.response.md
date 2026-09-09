### Project State
The current local package project is `unlinked` in the `preview` environment for team `default`, app `gateway-traffic-lab`, app_id `36`: Rainbond already contains a matching application, but the project has no complete `rainbond.app.json` plus linked `.rainbond/local.json` pair. Platform application existence does not complete local initialization.

### Actions Performed
This run selected `rainbond-project-init` in adopt/link mode as the next step. The existing Rainbond application will be reused while the missing local manifest or binding is created; package upload and component creation have not started.

### Current Health
Runtime health was not used to bypass the local initialization gate. No package, source, or image component mutation was executed.

### Blocking Issue
The current local project must record a verified binding before bootstrap can select the package execution path.

### Next Step
run project init in adopt/link mode, then continue to bootstrap

### Structured Output
```yaml
AppAssistantResult:
  project:
    identity:
      team_name: default
      region_name: rainbond
      app_name: gateway-traffic-lab
      app_id: 36
    linked: false
    selected_environment: preview
    deployment_location_url: null
  environment:
    name: preview
    source: default
    env_delta_present: false
    secrets_provided: false
  request_intent: source_app_delivery
  execution_path:
    requested_kind: package
    resolved_kind: package
  orchestration_state: unlinked
  runtime_state: null
  delivery_state: null
  promotion_result: null
  actions_performed:
    - skill: rainbond-project-init
      status: pending
      details: Reuse the existing Rainbond application and create or repair the missing local manifest and binding before package bootstrap.
  next_action: run project init in adopt/link mode, then continue to bootstrap
```
