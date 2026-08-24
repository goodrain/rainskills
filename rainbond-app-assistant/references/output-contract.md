# App Assistant output contract

## Contents

- Output-mode selection
- Concise delivery report
- Structured AppAssistantResult contract
- Cross-field consistency rules
- Human-readable section requirements

  ## Output Format

  Result model and presentation modes:

  - this skill must emit `AppAssistantResult`
  - minimum target fields:
    - `project`
    - `environment`
    - `request_intent`
    - `execution_path`
    - `orchestration_state`
    - `runtime_state`
    - `delivery_state`
    - `actions_performed`
    - `next_action`
  - optional extension field:
    - `promotion_result`
  - `AppAssistantResult` is always the internal result model for routing, validation, and downstream automation
  - the user-facing reply has two presentation modes:
    - concise delivery report mode
    - structured contract mode

  ### Concise delivery report mode

  Use this mode by default when all of the following are true:
  - `request_intent = source_app_delivery`
  - `runtime_state.phase = runtime_healthy`
  - `delivery_state.status` is `delivered` or `delivered-but-needs-manual-validation`
  - `delivery_state.verification_mode` is `verified`, `inferred`, or `manual_validation_needed` consistently with that status
  - `next_action` is `stop` or `stop and validate URL manually`
  - `promotion_result = null`
  - there is no unresolved `runtime_state.blocker` or `delivery_state.blocker`
  - `project.deployment_location_url` is non-null
  - `delivery_state.preferred_access_url` is non-null
  - the user did not explicitly request structured output, YAML, JSON, debug output, or machine-readable output
  - no eval/automation consumer explicitly requires structured contract mode

  In concise delivery report mode:
  - do not append `### Structured Output`
  - do not expose the fenced YAML block
  - keep the report short and directly useful to the user
  - state `部署成功`; when only browser confirmation remains, state `部署成功，待浏览器访问确认`
  - include application name and selected environment
  - include `部署位置` as a clickable `project.deployment_location_url`
  - include `访问地址` as a clickable `delivery_state.preferred_access_url`
  - include only the essential user-facing component status and HTTP verification evidence
  - when browser confirmation remains, add at most one short validation note
  - include proxy/mirror usage when it affected the deployment
  - include warnings that matter after delivery, such as development-only database auth or missing production persistence
  - do not expose orchestration enums, lower-level skill names, `Blocking Issue: none`, or the internal action ledger

  Default concise section order:
  - `### 部署结果`
  - `### 运行状态`
  - `### 处理记录` only when non-trivial fixes or proxy changes materially affect later operation
  - `### 注意事项` when there are production-readiness caveats

  Example concise delivery reply (the public URL is an example only; a real reply must use the exact gateway value from Iron Law 40):

  ```markdown
  ### 部署结果
  部署成功，待浏览器访问确认。

  应用：`demo-2048`
  环境：`preview`

  - 部署位置：[打开 Rainbond 应用](https://run.rainbond.com/#/team/aw9qu6gd/region/rainbond/apps/3283/overview)
  - 访问地址：[打开 2048](http://example.invalid/2048)

  ### 运行状态

  - `web`：运行中
  - HTTP 检查：200 OK

  服务运行正常。当前环境无法访问公网域名，请打开访问地址确认页面交互。

  ### 处理记录
  - 使用镜像代理完成依赖拉取
  ```

  ### Structured contract mode

  Use this mode when any of the following is true:
  - the user asks for structured output, YAML, JSON, debug details, or machine-readable output
  - an eval, wrapper, or automation flow explicitly needs deterministic structured schema validation
  - any concise delivery report condition above is not met
  - the app is building, unhealthy, blocked, identity-ambiguous, or requires handoff
  - `promotion_result` is non-null or the user requested dev-to-test promotion
  - there is any unresolved blocker or handoff
  - another skill or wrapper will consume the result as input

  Building, unhealthy, blocked, ambiguous, handoff, and incomplete promotion states should keep the detailed human-readable sections and evidence below. Do not make non-success output terse merely because successful output is concise.

  In structured contract mode:
  - the human-readable sections below are the narrative view over `AppAssistantResult`
  - the reply must end with a final `### Structured Output` section
  - the `### Structured Output` section must render `AppAssistantResult` in fenced `yaml`
  - the literal section order must be:
    - `### Project State`
    - `### Actions Performed`
    - `### Current Health`
    - `### Blocking Issue`
    - `### Next Step`
    - `### Structured Output`
  - each heading above must be rendered literally, including the leading `###`
  - headings such as `Project State` without `###`, translated heading labels, or `Structured Output` without the exact heading marker are contract failures
  - the fenced `yaml` block must appear immediately under `### Structured Output`
  - omitting the final structured block, changing its object name, or placing later prose after it is a contract failure

  Proposed schema:

  ```yaml
  AppAssistantResult:
    project:
      identity:
        team_name: string
        region_name: string
        app_name: string
        app_id: positive integer | null
      linked: boolean
      selected_environment: preview | production
      deployment_location_url: string | null
    environment:
      name: preview | production
      source: explicit | local_preference | default
      env_delta_present: boolean
      secrets_provided: boolean
    request_intent: source_app_delivery | dev_to_test_promotion
    execution_path:
      requested_kind: source | image | package | template | unknown
      resolved_kind: source | image | package | template | unknown
    orchestration_state: string
    runtime_state:
      phase: topology_missing | topology_building | runtime_unhealthy | runtime_healthy | capacity_blocked | code_or_build_handoff_needed | source_build_failed | null
      db_status: building | waiting | running | abnormal | capacity-blocked | null
      api_status: building | waiting | running | abnormal | capacity-blocked | null
      frontend_status: building | waiting | running | abnormal | capacity-blocked | null
      blocker: string | null
    delivery_state:
      status: delivered | delivered-but-needs-manual-validation | partially-delivered | blocked
      preferred_access_url: string | null
      verification_mode: verified | inferred | manual_validation_needed | null
      blocker: string | null
      verifier_next_action: stop | manual_url_validation | run_troubleshooter | fix_cluster_capacity_first | code_build_handoff | null
    promotion_result:
      status: blocked | snapshot_created | testing_app_created | testing_app_verified
      snapshot:
        version_id: string | null
        version: string | null
        alias: string | null
      testing_app:
        team_name: string | null
        region_name: string | null
        app_name: string | null
        app_id: positive integer | null
      testing_delivery_state:
        status: delivered | delivered-but-needs-manual-validation | partially-delivered | blocked
        preferred_access_url: string | null
        verification_mode: verified | inferred | manual_validation_needed | null
        blocker: string | null
        verifier_next_action: stop | manual_url_validation | run_troubleshooter | fix_cluster_capacity_first | code_build_handoff | null
    actions_performed:
      - skill: string
        status: string
        details: string
    next_action: string
  ```

  Construction rules:

  - `project.identity`
    - comes from the resolved current-run identity after applying explicit input, local binding, and manifest context
  - `project.linked`
    - must reflect whether current-run context confirms a linked project state
    - do not force `false` only because local metadata is stale when the platform confirms the same bound app in the current run
  - `project.selected_environment`
    - must match the resolved environment for the current run
  - `project.deployment_location_url`
    - must always be present and may be `null` when trusted Console base or resolved identity is unavailable
    - when non-null, must be built from trusted Console base plus the URL-encoded team, region, and app ID overview route from Iron Law 41
    - must never be copied from or inferred from `delivery_state.preferred_access_url`
  - `environment`
    - must describe the selected environment and whether env/secrets layers are present enough to matter to orchestration
  - `request_intent`
    - must normalize whether the run is only for the source app or explicitly asks for the dev-to-test promotion flow
  - `execution_path`
    - must preserve the requested and resolved delivery path
    - if the run is source-backed, `resolved_kind` must stay `source` unless the user explicitly changed delivery mode
  - `orchestration_state`
    - remains the workflow label used by the assistant
  - `runtime_state.phase`
    - must use canonical runtime labels
    - use `source_build_failed` when a source-backed build or source detection has failed and the run is handing off to the troubleshooter on the same source path; this is the canonical phase for the source-build-first routing of Iron Law 6 (source-backed failure routes to troubleshooter, never to package/image/template fallback)
    - in `source_build_failed`, `delivery_state` must stay `null` and `next_action` must point to a troubleshooter recommendation (the `run troubleshooter on the same source path` vocabulary entry)
  - `runtime_state.db_status`, `api_status`, `frontend_status`
    - must be based on current runtime evidence when available
    - must use the canonical vocabulary `building`, `waiting`, `running`, `abnormal`, or `capacity-blocked`
    - map statuses by actual role presence rather than filling every lane mechanically
    - for frontend-only or docs-style projects, keep `api_status = null` unless a real service/API component exists
    - for service-only projects with no user-facing frontend component, keep `frontend_status = null` unless a real frontend/access component exists
    - do not emit raw platform labels such as `closed` as component status; translate them to the closest canonical status from the same evidence
    - if raw status is `closed`, `closed` is never allowed in the canonical field
    - raw `closed` or `undeploy` plus active unschedulable CPU/memory evidence maps to `capacity-blocked`
    - raw `closed` plus crash, probe, dependency, image-pull, or other runtime failure evidence maps to `abnormal`
    - raw app-level labels must not override stronger current component-level evidence
  - `runtime_state.blocker`
    - must capture the dominant unresolved blocker when one exists
    - prefer the blocker supported by current-run platform truth over stale historical events when they disagree
  - `delivery_state`
    - may be `null` if delivery verifier has not run yet
    - must remain `null` when this run stopped before entering `rainbond-delivery-verifier`
    - must always describe the source app only, even when testing-app promotion later succeeds
    - should relay the lower-level delivery-verifier result instead of inventing a separate top-level delivery taxonomy
  - `promotion_result`
    - must remain `null` unless the user explicitly asked for development-to-testing promotion
    - must describe snapshot and testing-app outcomes without replacing the source-app meaning of the top-level `project`
    - must only be populated automatically after strict `delivery_state.status = delivered`
    - should advance monotonically through `snapshot_created` -> `testing_app_created` -> `testing_app_verified`, or stop at `blocked`
  - `actions_performed`
    - should list the lower-level skills actually invoked or explicitly skipped when relevant to the next step
    - if no lower-level skill was run, still record the inspection/classification pass and any intentionally skipped downstream skills that matter to the recommendation
  - `next_action`
    - must be the normalized form of the prose next-step recommendation
    - **must be selected from the canonical `next_action` vocabulary below.** Fixed phrases are used verbatim; template phrases keep the literal words and only fill the `<...>` slots. Do not invent free-form wording — the vocabulary exists to keep the orchestration contract phrase-stable across runs.

  #### Canonical `next_action` vocabulary

  Fixed phrases — emit exactly as written, no slots, no rewording:

  | Phrase | When |
  |--------|------|
  | `stop` | terminal state with nothing further to recommend (already delivered, or a clean stop) |
  | `run bootstrap` | topology is missing and the source app must be created/bootstrapped next |
  | `run troubleshooter` | topology is building/unhealthy and the next bounded step is the troubleshooter |
  | `run troubleshooter on the same source path` | a source-backed build/detection failed; route to the troubleshooter on the same source path, never to a package/image/template fallback (pairs with `runtime_state.phase = source_build_failed`) |
  | `run delivery verifier` | runtime looks healthy and the next step is delivery verification |
  | `fix cluster capacity first` | the dominant blocker is cluster capacity and it must be resolved before anything else |
  | `handoff to code/build agent` | the run reached `code_or_build_handoff_needed`; hand off to the code/build agent |
  | `stop and validate URL manually` | delivery ended `delivered-but-needs-manual-validation`; user must validate the URL manually |
  | `stop and ask the user to choose the team/app identity` | identity is ambiguous; stop and ask the user to pick the team/app |
  | `stop and ask the user to provide a descriptor or template` | a complex multi-service suite needs a descriptor/template before continuing |
  | `build the linked source app on the user-provided GitHub URL` | an explicit Git URL locks the source path; build the linked source app on that URL |
  | `configure ports and envs on the known service_alias from the create return` | the service alias is already known from the create return; configure ports/envs on it next |

  Template phrases — keep the literal words, fill only the `<...>` slot(s):

  | Template | Slot(s) | When |
  |----------|---------|------|
  | `stop after reporting testing app verification for <app>` | `<app>` = testing app name | dev-to-test promotion finished; stop after reporting the testing app verification |
  | `delete the abandoned half-installed template app <app> before building the source path` | `<app>` = abandoned app name (omit the slot, leaving `... template app before ...`, if no concrete name applies) | a strategy switch left a half-installed template app that must be cleaned up before building the source path |

  > **修改需同步**：这张词表是 `next_action` 的唯一权威来源。`scripts/validate_app_assistant_output.py` 里的 `CANONICAL_NEXT_ACTIONS` / `CANONICAL_NEXT_ACTION_TEMPLATES` 必须与本表保持一致；改一处必须改另一处。

  Consistency rules:

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

  In structured contract mode, always respond using exactly these sections:

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
