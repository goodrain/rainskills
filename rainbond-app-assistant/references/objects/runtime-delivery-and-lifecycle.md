# object-model-3

```json
{
  "schema_version": 1,
  "binding": {
    "team_name": "example-team",
    "region_name": "cn-north-1",
    "app_name": "example-app",
    "app_id": 123,
    "platform": {
      "server_name": "rio.cn-north-1.rainbond.me"
    }
  },
  "preferences": {
    "default_environment": "preview",
    "auto_use_manifest": true
  },
  "metadata": {
    "linked_at": "2026-04-14T10:00:00Z",
    "linked_by": "dev@example.com",
    "status": "linked"
  },
  "runtime_components": [
    {
      "logical_role": "api",
      "runtime_name": "example-api"
    }
  ]
}
```

Rule:

- `runtime_components` is only a lightweight reuse hint
- it must not become a shadow runtime-state store

### 8.3 `.rainbond/env.<env>.json`

Role:

- non-sensitive environment delta

May contain:

- environment-specific non-sensitive overrides that differ from the project baseline

Must not contain:

- secrets
- runtime metadata
- dependency-derived runtime coordinates
- unchanged baseline values

Example:

```json
{
  "schema_version": 1,
  "environment": "preview",
  "project": {
    "team_name": "team-a",
    "region_name": "region-1",
    "app_name": "my-app",
    "app_id": 20
  },
  "component_env_overrides": {
    "api": {
      "env": {
        "DB_NAME": "demo",
        "NODE_ENV": "preview"
      }
    }
  },
  "synced_at": "2026-04-01T14:30:00Z",
  "metadata": {
    "status": "synced",
    "synced_by": "rainbond-env-sync"
  }
}
```

Rule:

- keep only durable non-sensitive values that differ from the project baseline
- the example `DB_NAME` is an ordinary component-owned durable override; provider `connection_envs` or dependency-injected `DB_NAME` remains runtime metadata and is not persisted
- do not persist runtime-derived coordinates such as `DB_HOST`, `DB_PORT`, `API_HOST`, or `API_PORT`

### 8.4 `.rainbond/secrets.<env>.json`

Role:

- local-only secret input layer

May contain:

- passwords
- tokens
- registry credentials
- other sensitive runtime inputs

Must not contain:

- shared project baseline data
- binding state
- non-secret topology declarations

Example:

```json
{
  "schema_version": 1,
  "environment": "preview",
  "component_secrets": {
    "api": {
      "env": {
        "DB_PASSWORD": "REDACTED-LOCAL-VALUE",
        "JWT_SECRET": "REDACTED-LOCAL-VALUE"
      }
    },
    "frontend": {
      "env": {
        "REGISTRY_TOKEN": "REDACTED-LOCAL-VALUE"
      }
    }
  }
}
```

Rule:

- this file stays local-only
- secret values should be masked in outputs and never copied into manifest or local binding files

### 8.5 Internal-Only Fields

These fields should remain internal to the canonical model and should not be projected into committed files by default:

- `origin`
- `status`
- `execution_path`
- `blocking_reason`
- `missing_fields`
- drift details
- runtime alignment diagnostics

## 9. RuntimeState and DeliveryState

### 9.1 RuntimeState Boundary

`RuntimeState` is derived from platform runtime evidence, not from repo inference.

It should classify at least:

- `topology_missing`
- `topology_building`
- `runtime_unhealthy`
- `runtime_healthy`
- `capacity_blocked`
- `code_or_build_handoff_needed`

Definitions:

- `topology_missing`
  - app exists or is linked, but required topology is not yet created
- `topology_building`
  - components exist, but source-backed components are still converging or dependent wiring remains legitimately deferred
- `runtime_unhealthy`
  - topology exists, but runtime evidence shows abnormal, waiting, failing probes, env mismatch, or broken connectivity
- `runtime_healthy`
  - topology exists and runtime evidence no longer indicates operational blockers
- `capacity_blocked`
  - scheduling or platform capacity prevents progress
- `code_or_build_handoff_needed`
  - the blocker has moved out of deployment orchestration and into source/build remediation

Observed evidence comes from:

- Rainbond Tool component summaries
- Rainbond Tool component Pod lists and Pod detail
- recent events
- logs
- access-path inspection

### 9.2 DeliveryState Boundary

`DeliveryState` is the acceptance outcome for the current rollout.

Recommended values:

- `delivered`
- `delivered-but-needs-manual-validation`
- `partially-delivered`
- `blocked`

Definitions:

- `delivered`
  - critical components have converged and a usable access path is verified
- `delivered-but-needs-manual-validation`
  - runtime appears converged and the access path is known, but external verification was not possible in the current run
- `partially-delivered`
  - some critical components are still building, waiting, or abnormal, so delivery is incomplete
- `blocked`
  - delivery cannot complete due to capacity blockers, build failures, persistent runtime issues, or because no usable external access path exists

### 9.3 Relationship Between RuntimeState and DeliveryState

`RuntimeState` answers:

> What is happening right now in the deployment/runtime layer?

`DeliveryState` answers:

> Is this rollout accepted as delivered?

The second must not replace the first.

Examples:

- `topology_building` is not equal to `blocked`
- `runtime_healthy` is not automatically `delivered`
- `runtime_healthy` plus unverified external access may become `delivered-but-needs-manual-validation`
- `runtime_healthy` plus no usable external access URL may still be `blocked`
- all critical components `running` is still not enough if there is no usable user-facing access path

### 9.4 Shared State Vocabulary

The following vocabulary should be treated as canonical across bootstrap, troubleshooting, delivery verification, and orchestration.

#### RuntimeState labels

- `topology_missing`
- `topology_building`
- `runtime_unhealthy`
- `runtime_healthy`
- `capacity_blocked`
- `code_or_build_handoff_needed`

#### Component convergence labels

- `building`
- `waiting`
- `running`
- `abnormal`
- `capacity-blocked`

`DeliveryVerificationResult.component_status` should report per-component evidence using exactly these labels, keyed by component name.

#### Dependency readiness labels

- `resolved`
- `deferred`

When a dependency is deferred specifically because an upstream source-backed component has not converged yet, the plan should record that as `deferred_by_upstream_convergence`.

#### Normalized blocker buckets

- `db not ready`
- `dependency missing`
- `env naming incompatibility`
- `wrong connection values`
- `api startup issue`
- `frontend access-path issue`
- `source build still running`
- `source build failed`
- `platform backend issue`
- `external artifact unreachable`
- `cluster capacity blocked`
- `config_file_configmap_missing`

Delivery verification may reuse these buckets directly in `DeliveryVerificationResult.blocker` when they are the dominant acceptance blocker. It may also emit narrower delivery-acceptance blockers such as `no usable access URL` or `runtime unhealthy` when runtime observation alone is not enough to accept delivery.

#### DeliveryState labels

- `delivered`
- `delivered-but-needs-manual-validation`
- `partially-delivered`
- `blocked`

This vocabulary should be reused directly in skill outputs and internal handoff reasoning instead of inventing near-synonyms such as “partially healthy,” “compile-failed state,” or “needs-manual-validation” as a standalone final outcome.

## 10. Release, Snapshot, and Rollback

### 10.1 Scope Boundary

Release operations belong to the app version center flow under:

- snapshot creation
- publish draft and publish completion
- rollback to snapshot and rollback record tracking

This domain should be modeled separately from deployment creation.

### 10.2 Objects

#### `Snapshot`

Represents a preserved app version state suitable for future inspection or rollback.

#### `Release`

Represents publish-oriented promotion state, including draft creation, metadata submission, event execution, and completion.

#### `Rollback`

Represents restoration toward a prior snapshot plus rollback operation tracking.

### 10.3 Entry Conditions

Version operations require:

- linked app identity
- resolved `team_name`, `region_name`, and `app_id`
- enough healthy delivery evidence to justify preservation or promotion

Recommended minimum acceptable delivery outcomes before entering version flow:

- `delivered`
- `delivered-but-needs-manual-validation`

Version flow should not begin from:

- `partially-delivered`
- `blocked`

### 10.4 Handoff Rule

The high-level orchestrator should move into version operations only after delivery verification has completed successfully enough to justify snapshot or release actions.

That means:

- do not enter version flow while bootstrap is still creating topology
- do not enter version flow while troubleshooting is still active
- do not enter version flow when code/build remediation is still required

Current-state note:

- `rainbond-app-version-assistant` already exposes version-center operations as a standalone capability whenever the user is explicitly working in the `/version` context
- the delivery-success gate above is therefore an **orchestration recommendation**, not a claim that the version assistant itself currently blocks all earlier entry points
- future app-assistant integration should apply this gate before automatically handing off into version operations

## 11. Object Relationships and Lifecycle

Recommended high-level lifecycle:

```text
Project
  -> Environment resolution
  -> ComponentSource resolution
  -> DeploymentPlan generation
  -> RuntimeState observation
  -> DeliveryState acceptance
  -> Snapshot / Release / Rollback operations
```

Object responsibility split:

- `Project` owns desired topology context
- `Environment` owns environment-specific input resolution
- `ComponentSource` owns source-kind and execution readiness
- `DeploymentPlan` owns action generation and deferral
- `RuntimeState` owns observed operational classification
- `DeliveryState` owns acceptance classification
- `Snapshot/Release/Rollback` own post-delivery version operations

## 12. Canonical Lifecycle Examples

### 12.1 Source-Backed App

1. For a current local workspace, `rainbond-project-init` resolves `Project.identity`, writes or reuses `rainbond.app.json`, and records local binding in `.rainbond/local.json`. For an address-only Git URL, App Assistant resolves an unambiguous platform context without creating local files.
2. `Environment` resolution selects `preview` or `production`, then layers `.rainbond/env.<env>.json` and `.rainbond/secrets.<env>.json` without treating runtime metadata as configuration intent.
3. `ComponentSource` resolves the business-code component as `kind = source` using Git remote/ref/subdirectory data from the manifest or other higher-priority inputs.
4. `DeploymentPlan` sends that component through `bootstrap_source`, creates what can be created now, and records any downstream dependency as `deferred_by_upstream_convergence` until the source-backed target converges.
5. `rainbond-fullstack-troubleshooter` takes over if the plan reaches `topology_building`, `runtime_unhealthy`, or `code_or_build_handoff_needed`.
6. `rainbond-delivery-verifier` evaluates final `DeliveryState` as `delivered`, `delivered-but-needs-manual-validation`, `partially-delivered`, or `blocked`.

### 12.2 Template-Backed App

1. User intent or project design resolves a component or app path to `ComponentSource.kind = template`.
2. `Project` and `Environment` are resolved first so installer execution has team, region, app, and environment context.
3. `DeploymentPlan` records `template_intent_present = true` and sets `final_handoff.target = template_installer` instead of routing the item into bootstrap.
4. `rainbond-template-installer` executes the install only after `template_metadata_ready` is true.
5. Resulting runtime enters normal `RuntimeState` observation and then `DeliveryState` verification through `rainbond-delivery-verifier`.
6. Once delivery is acceptable, version-center work may continue through `rainbond-app-version-assistant`.

### 12.3 Package-Backed Component

1. `ComponentSource.kind = package` is selected only when `local_path` resolves deterministically enough for upload; because this is a local artifact, project init/adopt must complete before upload.
2. If `local_path` is missing or ambiguous, the flow stops before bootstrap with `status = needs_confirmation` or `blocked`.
3. `rainbond-fullstack-bootstrap` uses the package upload/create path for the component instead of image or source creation.
4. Runtime observation then follows the same `RuntimeState` and `DeliveryState` model as other executable components.
5. Package-specific local artifact ambiguity remains a pre-bootstrap blocker; it should not be hidden inside runtime diagnosis.

## 13. Target Structured Outputs

Current-state note:

- today, the skills primarily emit human-readable sectioned reports
- the target model is to preserve those readable reports while also making the same result available as canonical object-shaped data

Recommended target outputs:

### 13.1 `rainbond-project-init`

Current human-readable sections map as:

- `Init Result` -> `Project` + initial status
- `Resolved Project` / local binding details -> `Environment` + binding context
- `Execution Summary` -> `ComponentSource[]`
- `Next Step` -> `next_action`

Canonical output: `rainbond-project-init/schemas/project-init-result.schema.yaml`. Do not redefine its fields or enums here; embedded profiles that omit local project initialization also omit this schema.

### 13.2 `rainbond-fullstack-bootstrap`

Current human-readable sections map as:

- `Creation Result` -> project/environment context + component outcomes
- `Actions Taken` -> `DeploymentPlan` detail
- `Current State` -> partial `RuntimeState`
- `Handoff Recommendation` -> `next_handoff`

Target output object:
