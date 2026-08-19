### Project State
The project is `linked-and-complex-suite-needs-descriptor` for the `preview` environment with team `demo-team`, region `cn`, app `registry-app`, and app_id `app-301`. The user only said "deploy harbor" with no Git URL, image tag, template, or compose evidence.

### Actions Performed
This run only inspected the request. No `rainbond-fullstack-bootstrap` topology creation was started because Harbor is a multi-component suite (core, jobservice, registry, database, redis, portal) and there is no descriptor to drive a reliable topology. No creation tool was invoked.

### Current Health
No canonical runtime_state can be emitted yet because nothing was created; the request stops at descriptor collection.

### Blocking Issue
Harbor is a multi-component suite and no Rainbond template, rainbond.app.json, compose profile, or official deployment descriptor was provided, so the suite cannot be hand-assembled from general model knowledge.

### Next Step
stop and ask the user to provide a descriptor or template

### Structured Output
```yaml
AppAssistantResult:
  project:
    identity:
      team_name: demo-team
      region_name: cn
      app_name: registry-app
      app_id: 301
    linked: true
    selected_environment: preview
    deployment_location_url: https://run.rainbond.com/#/team/demo-team/region/cn/apps/301/overview
  environment:
    name: preview
    source: default
    env_delta_present: false
    secrets_provided: false
  request_intent: source_app_delivery
  execution_path:
    requested_kind: unknown
    resolved_kind: unknown
  orchestration_state: linked-and-complex-suite-needs-descriptor
  runtime_state: null
  delivery_state: null
  promotion_result: null
  actions_performed:
    - skill: inspection-only
      status: stopped
      details: Harbor is a multi-component suite and no Rainbond template, rainbond.app.json, compose profile, or official deployment descriptor was provided, so no component, dependency, env, storage, or port was created.
  next_action: stop and ask the user to provide a descriptor or template
```
