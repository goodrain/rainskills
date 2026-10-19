# structured-result-details

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

  ### Structured contract mode

  Use this mode when any of the following is true:
  - the user asks for structured output, YAML, JSON, debug details, or machine-readable output
  - an eval, wrapper, or automation flow explicitly needs deterministic structured schema validation
  - another skill or wrapper will consume the result as input

  Building, unhealthy, blocked, ambiguous, handoff, and incomplete promotion states do not enable structured mode by themselves. In customer mode, explain the direct result and one actionable next step in concise Chinese without exposing internal enums or action ledgers.

  In structured contract mode:
  - the human-readable sections below are the narrative view over `AppAssistantResult`
  - the explicitly structured reply ends with a final `### Structured Output` section
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
  | `run project init in adopt/link mode, then continue to bootstrap` | a local workspace/package has a verified existing platform app but lacks a complete local manifest/binding pair |
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
