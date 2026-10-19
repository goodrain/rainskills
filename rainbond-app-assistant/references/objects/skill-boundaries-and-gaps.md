# object-model-4

```yaml
BootstrapResult:
  deployment_plan: DeploymentPlan
  created_components: string[]
  reused_components: string[]
  skipped_components: string[]
  deferred_dependencies: string[]
  runtime_state: RuntimeState
  next_handoff: none | troubleshooter | delivery_verifier | code_build_handoff
```

### 13.3 `rainbond-fullstack-troubleshooter`

Current human-readable sections map as:

- `Problem Judgment` -> blocker bucket + affected layers + runtime classification
- `Actions Taken` -> deployment delta
- `Verification Result` -> updated `RuntimeState`
- `Follow-up Advice` -> next handoff guidance

Canonical output: `rainbond-fullstack-troubleshooter/schemas/troubleshoot-result.schema.yaml`. Do not redefine its fields or enums here; embedded profiles use the transported schema and generated compact contract bundled with the troubleshooter.

### 13.4 `rainbond-delivery-verifier`

Current transition note:

- the executable live contract is frozen by `rainbond-delivery-verifier/schemas/delivery-verification-result.schema.yaml`
- `docs/product-object-model.md` remains the repository-level semantic explanation for how that contract should be interpreted across skills and wrappers

Current human-readable sections map as:

- `Deployment State` -> `DeliveryState` + `RuntimeState` + context
- `Component Runtime` -> per-component convergence evidence via `component_status`
- `Access URL` -> preferred access endpoint
- `Verification Result` -> verification mode + dominant blocker when delivery is not accepted
- `Next Step` -> next action

Target output object:

```yaml
DeliveryVerificationResult:
  runtime_state: RuntimeState
  delivery_state: DeliveryState
  preferred_access_url: string | null
  verification_mode: verified | inferred | manual_validation_needed
  blocker: string | null
  next_action: stop | manual_url_validation | run_troubleshooter | fix_cluster_capacity_first | code_build_handoff
  component_status:
    <component_name>: building | waiting | running | abnormal | capacity-blocked
```

Field notes:

- `runtime_state` is still required even when final acceptance is `blocked`; it explains the runtime layer while `delivery_state` explains acceptance
- `preferred_access_url` may be `null` when no usable external access path exists
- `verification_mode` states whether user-facing access was directly verified, inferred, or still needs manual validation
- `blocker` records the dominant delivery blocker and may reuse shared blocker buckets such as `cluster capacity blocked`, or use delivery-specific acceptance blockers such as `no usable access URL` or `runtime unhealthy`
- `component_status` is the per-component convergence map that keeps delivery acceptance grounded in observable runtime evidence
- `next_action = fix_cluster_capacity_first` is the canonical next action when the dominant blocker is `cluster capacity blocked`
- `runtime_healthy` must not be treated as equivalent to `delivered`; delivery may still be `blocked` when there is no usable external access URL

### 13.5 `rainbond-app-assistant`

Current human-readable sections map as:

- `Project State` -> `Project` + `Environment` + orchestration classification
- `Actions Performed` -> execution log
- `Current Health` -> `RuntimeState` and, when available, `DeliveryState`
- `Blocking Issue` -> dominant blocker
- `Next Step` -> canonical next action

Target output object:

```yaml
AppAssistantResult:
  project:
    identity: Project.identity
    linked: boolean | null
    selected_environment: preview | production | null
    deployment_location_url: string | null
  environment: Environment
  orchestration_state: string
  runtime_state: RuntimeState | null
  delivery_state: DeliveryState | null
  promotion_result:
    status: not_started | blocked | snapshot_created | testing_app_created | testing_app_verified | null
    snapshot:
      version_id: string | null
      version: string | null
      alias: string | null
    testing_app:
      team_name: string | null
      region_name: string | null
      app_name: string | null
      app_id: positive integer | null
    testing_delivery_state: DeliveryState | null
  # optional; remains null unless the user explicitly asked for dev-to-test promotion
  actions_performed: string[]
  next_action: string
```

### 13.6 `rainbond-template-installer`

Target output object:

```yaml
TemplateInstallResult:
  template_install_intent:
    source: local | cloud
    market_name: string | null
    app_model_id: string
    app_model_version: string
    resolved_app_id: positive integer
    app_reused: boolean
  install_status: pending | success | failed
  services_summary: string[]
  next_action: stop | review_installed_services | run_troubleshooter | resolve_missing_template_metadata
```

### 13.7 `rainbond-app-version-assistant`

Target output object:

```yaml
VersionCenterSession:
  flow_type: snapshot | publish | rollback
  release: Release | null
  snapshot: Snapshot | null
  rollback: Rollback | null
  state_snapshot:
    baseline_version: string | null
    unsaved_runtime_changes: boolean
    unfinished_records: string[]
  action_plan: string[]
  next_step: stop | create_snapshot | submit_publish_draft | run_publish_events | complete_publish | track_rollback_record | give_up_draft
```

These target outputs do not require every skill to become API-like immediately. They define the structure that future orchestration or machine-readable wrappers should converge toward.

### 13.8 Structured Output Alignment Backlog

High-priority backlog by skill:

- `rainbond-project-init`
  - emit explicit `project` and `environment` objects instead of only narrative resolved-project text
  - turn execution summary lines into a machine-usable `component_sources` array
  - normalize `init_status` and `next_action`
- `rainbond-fullstack-bootstrap`
  - surface a machine-usable `deployment_plan`
  - emit `created_components`, `reused_components`, `skipped_components`, and `deferred_dependencies` as structured arrays
  - expose `runtime_state` and `next_handoff` directly
- `rainbond-fullstack-troubleshooter`
  - normalize `Problem Judgment` into a canonical `blocker_bucket`
  - emit `runtime_state` and `verification_summary` as explicit fields
  - constrain `next_handoff` to the canonical set
- `rainbond-delivery-verifier`
  - emit explicit `delivery_state`, `runtime_state`, `preferred_access_url`, and `verification_mode`
  - normalize `next_action` to the canonical follow-up values
- `rainbond-app-assistant`
  - emit `project`, `environment`, `orchestration_state`, optional `runtime_state`, optional `delivery_state`, optional `promotion_result`, and normalized `next_action`
  - keep human-readable narration as a view over those objects rather than the only source
- `rainbond-template-installer`
  - emit a `template_install_intent` object instead of only prose about chosen template and target app
  - include `Project`, `Environment`, `ComponentSource.kind = template`, and `DeploymentPlan` handoff context
- `rainbond-app-version-assistant`
  - emit explicit `Release`, `Snapshot`, or `Rollback` objects plus gating context from `RuntimeState` and `DeliveryState`
  - expose why version flow was entered, not only what action was taken
- `rainbond-env-sync`
  - emit a full `Environment` object with structured skip reasons
  - state whether the resulting environment intent appears sufficient for downstream execution gates

### 13.9 Dual Output Convention

Recommended repo-wide convention for future skill outputs:

1. keep detailed human-readable sections for building, unhealthy, blocked, ambiguous, handoff, and incomplete promotion states
2. append one final `Structured Output` section when the user or a machine consumer requests it, or when a non-success workflow needs the detailed contract
3. for an eligible successful source delivery, default to a concise user report with application, environment, Rainbond deployment location, public access URL, essential runtime status, and verification evidence; keep the canonical object internal
4. browser confirmation alone does not force visible YAML when runtime is healthy, no blocker remains, and both URLs are known
5. render visible canonical objects in a fenced `yaml` block with exact field names and enum values
6. mask or omit secrets in the structured object just as they are masked in prose
7. if a field is applicable but currently unknown, prefer `null` over inventing a value
8. if a field is not applicable for the skill, omit it rather than forcing placeholder noise
9. the structured object must never contradict the human-readable sections above it

Recommended shape:

````text
<existing human-readable sections>

### Structured Output
```yaml
<CanonicalObjectName>:
  ...
```
````

Adoption rule:

- a skill may remain prose-only until its structured output is implemented
- once implemented, the structured block becomes the machine-usable source and the prose becomes the human-readable view over the same result

## 14. Skill-to-Object Mapping

- `rainbond-project-init`
  - `Project`
  - initial `ComponentSource`
  - `.rainbond/local.json` binding
- `rainbond-env-sync`
  - `Environment`
- `rainbond-fullstack-bootstrap`
  - consumes `ResolvedComponentSource`
  - executes `DeploymentPlan`
- `rainbond-template-installer`
  - executes `template`-routed source/install operations
- `rainbond-fullstack-troubleshooter`
  - diagnoses and updates `RuntimeState`
- `rainbond-delivery-verifier`
  - evaluates `DeliveryState`
- `rainbond-app-assistant`
  - orchestrates lifecycle transitions across all major objects
- `rainbond-app-version-assistant`
  - manages `Snapshot`, `Release`, and `Rollback`

## 15. Current Product Gaps

The most visible remaining product gaps are:

- `package` is not yet a fully productized first-class path for local build-then-upload workflows
- top-level orchestration does not yet natively continue from delivery into version-center actions
- current skills still embed some model semantics that should eventually reference this document instead of redefining them locally

## 16. Recommended Next Steps

Next design and implementation work should proceed in this order:

1. materialize the target internal contracts such as `ResolvedComponentSource` and `DeploymentPlan` in orchestration code or skill-level structured outputs
2. finish deeper wording alignment in the remaining skills so runtime, delivery, and handoff language no longer drifts
3. productize the incomplete `package` path, especially local build-then-upload behavior
4. decide whether `rainbond.app.v2.json` should become a stable external protocol or remain a design-layer draft for now
5. wire `rainbond-app-assistant` into an explicit post-delivery handoff path for version-center operations
