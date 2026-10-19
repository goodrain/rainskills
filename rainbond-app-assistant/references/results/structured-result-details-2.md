# structured-result-details-2

- `orchestration_state` and `runtime_state.phase` may differ in wording but must not conflict semantically
  - if current-run platform evidence confirms the app exists and the dominant blocker is runtime/platform capacity, do not downgrade the project to unlinked solely because local metadata still says `pending_verification`
  - do not classify the project as `capacity_blocked` based only on old `Unschedulable` events when current node capacity and current app/component state indicate another blocker is now dominant
  - if app-level runtime labels say `closed` but current component evidence shows active capacity scheduling failure, canonical component status must still be `capacity-blocked`
  - only use `abnormal` for raw `closed` when no stronger canonical state can be supported from current evidence
  - if the app is still `part_running` due to a critical capacity blocker, `next_action` must not point to delivery verification
  - if `runtime_state.phase = source_build_failed`, `delivery_state` must be `null` and `next_action` must point to a troubleshooter recommendation; never fall back to package/image/template
  - if delivery verifier has not run, do not invent a non-null delivery outcome
  - if the run stopped during `project-init`, `bootstrap`, or `troubleshooter`, `delivery_state` must be `null`
  - if the source app is runtime-healthy enough that the remaining issue is outer access or final URL selection, prefer `linked-and-needs-delivery-verification` over `linked-and-topology-present-but-runtime-unhealthy`
  - for reverse-proxy full-stack apps, do not treat a frontend root URL alone as a trustworthy final outcome if the same-host backend path is still unverified or failing
  - if a component was resolved as source-backed earlier in the same run, do not silently rewrite the reasoning as image-backed after a source-create or source-build failure
  - if a source ref was resolved earlier in the same run, do not silently rewrite it to another branch
  - do not treat missing optional source-create passthrough fields such as `check_uuid` or `event_id` as a blocker unless the backend explicitly requires them
  - if source detection reports multiple services/components, do not automatically pivot into local package, local build, manual upload, or template-install workaround flows without explicit user confirmation
  - if a GitHub source URL is still raw `https://github.com/...`, the assistant may ask once whether to use `https://ghfast.top/https://github.com/...` or `https://gh.rainbond.cc/https://github.com/...`, but must not silently rewrite the Git URL without either explicit user input or a repo-local proxy URL already present
  - transport hints for registry or Git mirrors must not be treated as a delivery-mode override unless the user explicitly asked to switch to image deployment
  - external artifact download failures, image layer pull timeouts, Docker Hub timeouts, and GitHub Release asset download failures should be reported as `external artifact unreachable` when that is the dominant evidence
  - if bootstrap reports `platform backend issue`, do not classify the result as `linked-and-needs-code-handoff`; stop with the source app still incomplete and report the backend capability failure explicitly
  - if `delivery_state.status = delivered-but-needs-manual-validation`, `promotion_result` must stay `null` and `next_action` must not auto-enter version flow
  - if runtime logs show hard-coded dependency coordinates such as `db`, but current dependency wiring provides provider connection envs or alias-based connection envs, prefer provider connection contract repair, then compatibility-env troubleshooting, over accepting the hard-coded value as authoritative
  - if `promotion_result` is non-null, `delivery_state.status` must already be `delivered`
  - if `promotion_result.testing_delivery_state` is non-null, `promotion_result.testing_app.app_id` must also be non-null
  - for frontend-only or docs-style projects, do not mirror the same frontend component status into `api_status`
  - do not upgrade top-level `delivery_state` from `delivered-but-needs-manual-validation` to `delivered` only because the testing app later verified successfully
  - if testing-app verification ends in `blocked` or `partially-delivered`, `next_action` should point to troubleshooting the testing app rather than re-running the whole mainline
  - no secret values may appear in the structured object

  Example object:

  ```yaml
  AppAssistantResult:
    project:
      identity:
        team_name: rainbond-demo
        region_name: singapore
        app_name: storefront
        app_id: 2
      linked: true
      selected_environment: preview
      deployment_location_url: https://run.rainbond.com/#/team/rainbond-demo/region/singapore/apps/2/overview
    environment:
      name: preview
      source: local_preference
      env_delta_present: true
      secrets_provided: true
    request_intent: source_app_delivery
    execution_path:
      requested_kind: source
      resolved_kind: source
    orchestration_state: linked-and-topology-present-but-runtime-unhealthy
    runtime_state:
      phase: runtime_unhealthy
      db_status: running
      api_status: running
      frontend_status: abnormal
      blocker: frontend waiting on nginx host config
    delivery_state:
      status: blocked
      preferred_access_url: null
      verification_mode: null
      blocker: frontend access path still blocked
      verifier_next_action: run_troubleshooter
    promotion_result: null
    actions_performed:
      - skill: rainbond-fullstack-troubleshooter
        status: completed
        details: Detected frontend health check failing and suggested capacity warning.
      - skill: rainbond-delivery-verifier
        status: skipped
        details: Deferred until runtime is healthy.
    next_action: run troubleshooter
  ```

  Example final reply:

  ````markdown
  ### Project State
  The project is `linked-and-topology-present-but-runtime-unhealthy` for the `preview` environment with team `alpha-org`, region `us-south`, app `storefront`, and app_id `92`.

  ### Actions Performed
  `rainbond-fullstack-troubleshooter` completed and identified converged API/DB components while the frontend stayed abnormal, prompting a focus on nginx host configuration; `rainbond-delivery-verifier` was skipped because runtime health remains outstanding.

  ### Current Health
  db status running, api/service status running, frontend-access status abnormal, overall status runtime_unhealthy.

  ### Blocking Issue
  frontend waiting on corrected nginx host config.

  ### Next Step
  run troubleshooter.

  ### Structured Output
  ```yaml
  AppAssistantResult:
    project:
      identity:
        team_name: alpha-org
        region_name: us-south
        app_name: storefront
        app_id: 92
      linked: true
      selected_environment: preview
      deployment_location_url: https://run.rainbond.com/#/team/alpha-org/region/us-south/apps/92/overview
    environment:
      name: preview
      source: default
      env_delta_present: false
      secrets_provided: true
    orchestration_state: linked-and-topology-present-but-runtime-unhealthy
    runtime_state:
      phase: runtime_unhealthy
      db_status: running
      api_status: running
      frontend_status: abnormal
      blocker: nginx host configuration missing
    delivery_state:
      status: blocked
      preferred_access_url: null
    promotion_result: null
    actions_performed:
      - skill: rainbond-fullstack-troubleshooter
        status: completed
        details: Diagnosed frontend health check failure while db/api remained healthy.
      - skill: rainbond-delivery-verifier
        status: skipped
        details: Deferred until runtime is healthy.
    next_action: run troubleshooter
  ```
  ````

  Only in explicit structured contract mode, respond using exactly these sections:

  ### Project State
  - state the current classification
  - explicitly include the exact `orchestration_state` label in prose, preferably in backticks
  - include selected environment
  - include resolved team, region, app, and app_id if available

  ### Actions Performed
  - list the lower-level skill(s) used
  - summarize what each one did
  - if no lower-level skill was executed, say that this run only performed context resolution and state classification
  - if a downstream skill was intentionally not entered because the user asked not to continue yet, say that explicitly
  - if development-to-testing promotion was entered, explicitly name the source delivery gate, snapshot creation, testing-app creation, and testing-app verification stages
  - if source creation failed, say so explicitly instead of describing the resulting component as if it had always been image-backed
  - if source creation failed because of a control-plane exception, say that this is a platform backend issue rather than code/build failure
  - if the source ref or branch was invalid, say that explicitly instead of auto-rewriting it

  ### Current Health
  Explicitly report:
  - **db status** using `building`, `waiting`, `running`, `abnormal`, or `capacity-blocked` when runtime evidence is available
  - **api/service status** using `building`, `waiting`, `running`, `abnormal`, or `capacity-blocked` when runtime evidence is available
  - **frontend-access status**
  - **overall status** using the canonical runtime or delivery term when one is available
  - explicitly include the exact `runtime_state.phase` label in prose, preferably in backticks
  - if the platform reports a raw label such as `closed`, explain it in prose if useful, but normalize the status field itself to the canonical vocabulary

  ### Blocking Issue
  - state the main blocker if the app is not fully healthy
  - when `runtime_state.blocker` or `delivery_state.blocker` is non-null, reuse that blocker sentence verbatim in plain text so prose and structured output stay aligned
  - do not wrap part of the blocker sentence in backticks or paraphrase only part of it
  - if none, say `none`
  - if the source app is healthy but the testing app blocked during promotion, state the testing-app blocker here
  - if the source app only lacks an external access URL, describe that as a delivery/access-path blocker rather than generic runtime failure

  ### Next Step
  - state the single most appropriate next action
  - examples:
    - `run env sync`
    - `run bootstrap`
    - `run troubleshooter`
    - `manual URL validation before promotion`
    - `create snapshot and testing app`
    - `run troubleshooter on testing app`
    - `stop, hand off testing app to human testers`
    - `handoff to code/build agent`
    - `stop, app is healthy`

  ### Structured Output
  - append a fenced `yaml` block as the final section
  - render `AppAssistantResult`
  - keep enum values and field names aligned with the schema above
  - if `runtime_state` or `delivery_state` is unavailable, use `null` rather than guessing
  - if post-delivery promotion was not entered, use `promotion_result: null`
  - do not place any prose after this section
  - the heading itself must be exactly `### Structured Output`
  - the opening fence must be exactly ````yaml` immediately after the heading
  - the closing fence must be the last non-whitespace line of the whole reply
