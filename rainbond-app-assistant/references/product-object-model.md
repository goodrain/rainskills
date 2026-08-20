# Rainbond Product Object Model

## Contents

1. Purpose
2. Validated capability baseline
3. Product goal
4. Canonical object catalog
5. ComponentSource design
6. ComponentSource resolution
7. ComponentSource-to-DeploymentPlan interface
8. External projection boundaries
9. RuntimeState and DeliveryState
10. Release, snapshot, and rollback
11. Object relationships and lifecycle
12. Canonical lifecycle examples
13. Target structured outputs
14. Skill-to-object mapping
15. Current product gaps

## 1. Purpose

This document defines the canonical product object model for the Rainbond local-to-delivery workflow managed by the `rainbond-*` skills.

The goal is not to extend the current demo prompt chain. The goal is to turn the validated workflow into a stable product model that can:

- describe a local project using consistent objects
- minimize user input to intent plus a small amount of clarification
- map directly onto current Rainbond Tool and skill capabilities
- support onboarding, deployment, delivery verification, and version operations as one continuous flow

This document is the source of truth for product-level object boundaries. Individual `SKILL.md` files should describe execution behavior and handoff rules, but they should not redefine the object model independently.

## 2. Validated Capability Baseline

The current validated workflow already covers these capability areas:

- `rainbond-project-init`
  - generate or reuse `rainbond.app.json`
  - create or locate Rainbond app
  - write `.rainbond/local.json`
- local configuration layering
  - `rainbond.app.json`
  - `.rainbond/local.json`
  - `.rainbond/env.preview.json` / `.rainbond/env.prod.json`
  - `.rainbond/secrets.preview.json` / `.rainbond/secrets.prod.json`
- `rainbond-fullstack-bootstrap`
  - image-backed creation
  - source-backed creation
  - package-backed upload-and-create
  - template-aware skip and handoff
- `rainbond-template-installer`
  - local template install
  - cloud market install
  - app model and version resolution
- `rainbond-fullstack-troubleshooter`
  - runtime diagnosis across db, env, source build, capacity, and frontend access issues
- `rainbond-delivery-verifier`
  - delivery convergence classification
  - access URL reporting
  - final delivery outcome reporting
- `rainbond-app-assistant`
  - high-level orchestration across init, env sync, bootstrap, template install, troubleshooting, and delivery verification
- `rainbond-app-version-assistant`
  - snapshot creation
  - publish draft and event flow
  - snapshot rollback and rollback record tracking

The best validated end-to-end chain is already:

`project-init -> template install -> source create -> troubleshoot -> delivery verify`

What remains is not basic capability existence. What remains is product model convergence.

## 3. Product Goal

The target effect is:

> Let a local project be described through a unified object model for source, environment, deployment, and version state, so it can be linked, deployed, verified, and versioned in Rainbond with minimal user input.

This implies:

- the system must resolve intent from layered local state plus platform runtime truth
- the system must separate declarative project baseline from local binding state
- the system must distinguish execution readiness from runtime health
- the system must expose only stable fields in user-facing files

## 4. Canonical Object Catalog

The first-pass canonical object catalog is:

- `Project`
- `Environment`
- `ComponentSource`
- `DeploymentPlan`
- `RuntimeState`
- `DeliveryState`
- `Release`
- `Snapshot`
- `Rollback`

### 4.1 Project

`Project` represents the local project as a deployable Rainbond unit.

Responsibilities:

- identify the target Rainbond app context
- carry the component topology baseline
- associate per-environment config layers
- act as the root object for planning and delivery state

It should not store raw runtime truth. Runtime truth belongs to platform-derived runtime state.

Canonical shape:

```yaml
Project:
  identity:
    team_name: string
    region_name: string
    app_name: string
    app_id: positive integer | null
  topology:
    components: Component[]
  selected_environment: preview | production
  deployment_location_url: string | null
  binding:
    source: local_binding | manifest | explicit | discovered
```

Design rules:

- `identity` is the project-to-app identity surface
- `topology` is the committed project baseline, normally projected through `rainbond.app.json`
- `app_id` may be unknown before linking, but it becomes part of the resolved project identity once binding is confirmed
- selected environment is part of project context, but environment-specific data belongs to the `Environment` object
- `deployment_location_url` is the Rainbond Console app overview URL derived from trusted Console context plus team, region, and app ID; it is distinct from the gateway-provided public service URL

Ownership split:

- `rainbond.app.json` owns the topology baseline
- `.rainbond/local.json` owns the local binding record
- the locked Rainbond transport owns runtime truth

The project object should therefore be understood as the composition of:

- committed project identity and topology intent
- resolved binding to a concrete Rainbond app

but not:

- runtime health
- runtime secrets
- ephemeral runtime-generated coordinates

Identity resolution table:

| Source | Priority | Auto-continue when | Must stop and ask when |
| --- | --- | --- | --- |
| explicit user input | 1 | team/region/app identity is complete | explicit input is still incomplete or conflicts with current linked state |
| `.rainbond/local.json` | 2 | binding is already linked and identity is complete | project is not linked or binding is incomplete |
| `rainbond.app.json` | 3 | committed baseline already provides enough identity context | critical identity remains ambiguous |
| repository inference | 4 | inference plus platform lookup resolves a single unambiguous identity | inference remains ambiguous or would require guessing |
| platform discovery | 5 | exactly one safe resolution path exists | multiple teams/regions/apps remain possible or the platform cannot verify the result |

### 4.2 Environment

`Environment` represents environment-specific intent and local execution input.

Responsibilities:

- select `preview` or `production`
- resolve non-sensitive env deltas
- resolve local secret inputs
- provide environment-aware inputs to bootstrap and troubleshooting

It should not be used as a runtime snapshot.

Canonical shape:

```yaml
Environment:
  name: preview | production
  source: explicit | local_preference | default
  env_delta:
    component_env_overrides: map
  secret_inputs:
    component_secret_overrides: map
```

Resolution rules:

- selected environment resolves in this order:
  - explicit run input
  - `.rainbond/local.json.preferences.default_environment`
  - default `preview`
- env delta is non-sensitive intent layered on top of the project baseline
- secret inputs are local-only sensitive execution inputs

Ownership split:

- `.rainbond/env.<env>.json` owns non-sensitive environment delta
- `.rainbond/secrets.<env>.json` owns local-only secret input
- manifest owns project baseline values
- platform runtime owns live generated connection coordinates and runtime state

The `Environment` object should never absorb runtime-derived host/port data, generated credentials, or other transient values that only exist because a deployment is currently running.

Environment resolution table:

| Aspect | Deterministic rule | Notes |
| --- | --- | --- |
| environment selection | explicit run input -> `.rainbond/local.json.preferences.default_environment` -> `preview` | applies consistently across app-assistant, env-sync, and bootstrap |
| env/secrets precedence | explicit input -> `.rainbond/secrets.<env>.json` -> `.rainbond/env.<env>.json` -> `.rainbond/local.json` -> `rainbond.app.json` | secrets override env delta; env delta overrides baseline intent |
| omit rules | store only non-sensitive overrides that differ from baseline | skip secrets, runtime metadata, generated values, and unchanged baseline values |
| runtime-derived values | never persist values such as `DB_HOST`, `DB_PORT`, `API_HOST`, `API_PORT`, and other dependency-derived coordinates | these belong to runtime metadata, not stored environment intent |

### 4.3 ComponentSource

`ComponentSource` is the first-priority object because it answers the most important planning question:

> Where does this component come from, and through which Rainbond execution path should it be created or installed?

Without a stable `ComponentSource`, the rest of the model drifts:

- `DeploymentPlan` cannot decide which actions to generate
- init cannot decide which execution mode to infer
- bootstrap cannot decide whether to create, upload, or skip
- delivery reporting cannot explain why a topology is still incomplete
- version flows cannot know what is stable enough to snapshot

### 4.4 DeploymentPlan

`DeploymentPlan` turns normalized source decisions into executable actions.

Responsibilities:

- choose create, reuse, skip, handoff, or wait
- order actions by dependency and runtime evidence
- defer wiring when upstream convergence is incomplete
- decide when to hand off into troubleshooting, delivery verification, or version operations

It must not re-resolve source kind on its own. It consumes `ResolvedComponentSource`.

Canonical shape:

```yaml
DeploymentPlan:
  identity:
    team_name: string
    region_name: string
    app_name: string
    app_id: positive integer | null
  environment:
    name: preview | production
  workflow_state:
    linked: boolean
    topology_state: missing | building | present
    template_intent_present: boolean
    code_handoff_needed: boolean
  config_priority:
    - explicit_input
    - secrets_file
    - env_delta_file
    - local_binding
    - manifest
  gates:
    secrets_ready: boolean
    template_metadata_ready: boolean
    source_converged: boolean
    dependency_wiring_ready: boolean
    access_mode_declared: boolean
  steps:
    - PlanStep[]
  final_handoff:
    target: none | template_installer | troubleshooter | delivery_verifier | version_assistant | code_build_handoff
    reason: string | null
```

The plan object is internal orchestration structure. It is not projected directly into committed project files.

Deployment gate table:

| Gate | Evidence satisfies gate | Action when false | Next skill or handoff |
| --- | --- | --- | --- |
| link status | `.rainbond/local.json` exists and `metadata.status == linked` | pause and request linking | `rainbond-project-init` |
| template intent | user explicitly requests template install or resolved topology marks next step as `template` | continue non-template path only for non-template components | `rainbond-template-installer` |
| topology missing | app is missing, required components are absent, or topology is not created | do not treat the app as runtime-repair-only | `rainbond-fullstack-bootstrap` |
| bootstrap completion | `access_mode` declared, source-backed components sufficiently converged, and no deeper runtime blocker surfaced | stop bootstrap and surface a blocker rather than claiming setup complete | `rainbond-fullstack-troubleshooter` |
| runtime health | platform evidence no longer indicates unresolved blockers | continue diagnosis instead of claiming success | `rainbond-delivery-verifier` when healthy enough; otherwise `rainbond-fullstack-troubleshooter` |
| code/build blocker | root cause is in browser host usage, build-time env, reverse-proxy config, or source/build failure | stop Rainbond-side repair | `code_build_handoff` |

### 4.5 RuntimeState

`RuntimeState` represents observed deployment/runtime reality from Rainbond Tools, component summaries, Pod runtime diagnostics, recent events, logs, and access-path inspection.

Responsibilities:

- distinguish topology absence vs topology creation in progress
- distinguish build convergence vs runtime health
- distinguish platform blockers vs application blockers

It is runtime-observed, not repo-inferred.

### 4.6 DeliveryState

`DeliveryState` is the final acceptance outcome of the current rollout.

Responsibilities:

- report whether the app is delivered
- report whether the app still needs manual URL validation
- report whether delivery is partial or blocked

It is downstream of `RuntimeState`, not a replacement for it.

### 4.7 Release, Snapshot, Rollback

These objects represent version-center operations after delivery is good enough to preserve or promote.

Responsibilities:

- create snapshots of a converged app state
- manage publish drafts and publish completion
- execute and track rollback to prior snapshots

They should only be entered after delivery success or delivery success plus manual validation.

## 5. ComponentSource Design

### 5.1 Why ComponentSource Comes First

`ComponentSource` is the routing object for the entire workflow.

It is not a minor component attribute. It determines:

- which creation path is valid
- whether the current source data is executable
- whether bootstrap can act now
- whether execution must be handed off to template install
- whether downstream dependency wiring can happen yet

### 5.2 Canonical Schema

The canonical internal shape is:

```yaml
ComponentSource:
  kind: image | source | package | template
  origin: explicit | manifest | local_state | inferred | runtime_aligned
  status: ready | needs_confirmation | blocked
  execution_path: bootstrap_image | bootstrap_source | bootstrap_package | template_install
  blocking_reason: string | null
  missing_fields: string[]
  spec: {}
```

Key design rules:

- `kind` says what the source is
- `execution_path` says which execution chain should consume it
- `origin` tracks where the current normalized answer came from
- `status` expresses executability only, not runtime health

### 5.3 Responsibilities

`ComponentSource` is responsible for:

- describing source kind
- describing whether source data is sufficient for execution
- routing the component to the correct execution chain

`ComponentSource` is not responsible for:

- overall deployment ordering
- environment resolution
- runtime health classification
- version publication state

### 5.4 Source Kinds

#### `image`

Canonical spec:

```yaml
spec:
  image: string
```

Meaning:

- a concrete image reference exists
- bootstrap can create the component directly from the image

Status rules:

- `ready`: image reference and required execution prerequisites are concrete
- `needs_confirmation`: image exists conceptually but registry access or required startup input is still uncertain
- `blocked`: critical execution prerequisites are missing

Execution mapping:

- `execution_path = bootstrap_image`

#### `source`

Canonical spec:

```yaml
spec:
  provider: git | github | gitee | oauth_xxx
  remote_url: string
  ref: string
  subdirectories: string[]
```

Meaning:

- the component should be created from source code
- the normalized source representation is repository plus version plus optional subdirectories

Status rules:

- `ready`: provider, repo URL, ref, and required source metadata are concrete
- `needs_confirmation`: source intent is clear but key Git/provider metadata is incomplete
- `blocked`: essential source metadata is missing and cannot be safely inferred

Execution mapping:

- `execution_path = bootstrap_source`

#### `package`

Canonical spec:

```yaml
spec:
  local_path: string
  archive_name: string | null
```

Meaning:

- the component should be created from a local file or local directory upload
- directories may be packaged before upload

Status rules:

- `ready`: local path resolves clearly and upload shape is known
- `needs_confirmation`: local path intent exists but the concrete upload input is not yet safe
- `blocked`: local path is missing or cannot be trusted

Execution mapping:

- `execution_path = bootstrap_package`

Design boundary:

- `package` describes what to upload
- it does not describe a future local build pipeline that produces the artifact
- if local build-before-upload becomes productized later, that should be modeled separately, not overloaded into `ComponentSource`

#### `template`

Canonical spec:

```yaml
spec:
  install_source: local | cloud
  app_model_id: string
  app_model_version: string
  market_name: string | null
```

Meaning:

- the intended next delivery step is app model installation, not raw component creation

Status rules:

- `ready`: install metadata and target app context are complete
- `needs_confirmation`: template intent is clear but install metadata is incomplete
- `blocked`: required install metadata is absent

Execution mapping:

- `execution_path = template_install`

Special rule:

- `template` is a valid source kind in the canonical model
- but it must not be executed by bootstrap
- bootstrap should skip it and hand off to `rainbond-template-installer`

Standard middleware note:

- for standard middleware such as postgres, mysql, redis, or rabbitmq, template should be preferred over image when explicit template intent, complete install metadata, or a curated middleware-to-template mapping exists
- image remains the safe fallback only when template resolution is unavailable or intentionally not selected

## 6. ComponentSource Resolution

### 6.1 Input Priority

`ComponentSource` is resolved from layered inputs in this order:

1. explicit user input
2. `.rainbond/secrets.<env>.json`
3. `.rainbond/env.<env>.json`
4. `.rainbond/local.json`
5. `rainbond.app.json`
6. repository inference
7. platform runtime correction

Notes:

- env and secret files usually affect executability, not source kind directly
- platform runtime is not just another candidate layer; it is the final correction layer

### 6.2 Resolution Principle

The system should:

- collect candidate source facts from all eligible layers
- normalize them into one canonical source object
- evaluate whether the source is executable
- align or correct it using platform runtime truth

The system may infer. It may not invent.

That means:

- do not fabricate Git URLs
- do not fabricate template install identifiers
- do not fabricate secrets
- do not claim executable support for unresolved metadata

### 6.3 Resolution Algorithm

Pseudo-flow:

```text
resolve_component_source(component, context):
  collect explicit declarations
  collect env/secret effects
  collect local binding hints
  collect manifest declarations
  collect conservative repo inference
  normalize into one canonical source
  evaluate executability
  align with platform runtime truth if available
  if ambiguity remains, mark needs_confirmation or blocked
```

### 6.4 Runtime Correction

Platform runtime is the final source of truth.

Rules:

- `.rainbond/local.json.runtime_components` is only a hint
- `rainbond.app.json` is a declarative baseline
- repository inference is only a candidate
- when platform runtime facts disagree, the system must follow platform runtime and surface drift explicitly

This does not mean every local declaration is discarded. It means local declarations must yield when they conflict with observable runtime reality.

## 7. ComponentSource to DeploymentPlan Interface

### 7.1 Resolved Source Contract

`DeploymentPlan` should not consume raw manifest fields. It should consume a resolved source contract.

This section describes the **target internal contract** for the product model.

Current-state note:

- today, `rainbond-fullstack-bootstrap` still consumes `rainbond.app.json`, env layers, and explicit overrides directly
- the structured `ResolvedComponentSource` contract described here is not yet materialized as a first-class payload in the current skills
- this document defines the intended internal interface that future orchestration should converge toward

Recommended shape:

```yaml
ResolvedComponentSource:
  kind: image | source | package | template
  status: ready | needs_confirmation | blocked
  execution_path: bootstrap_image | bootstrap_source | bootstrap_package | template_install
  plan_action: create | reuse | skip | handoff | wait
  can_create_now: boolean
  requires_runtime_convergence: boolean
  allows_dependency_wiring_now: boolean
  blocking_reason: string | null
  pending_reason: string | null
```

### 7.2 Plan Actions

- `create`
  - create a new component or install target now
- `reuse`
  - runtime component already exists and should be reused
- `skip`
  - this plan should not execute the item directly
- `handoff`
  - another stage must now take over
- `wait`
  - direction is correct but execution must wait for a prior condition

### 7.3 Kind-to-Action Guidance

#### `image`

- create if no runtime component exists and prerequisites are satisfied
- reuse if the platform confirms a matching existing component
- block if critical prerequisites are unresolved

#### `source`

- create if source metadata is ready and runtime component is absent
- wait if the source-backed component exists but is still converging
- reuse if runtime component already exists and is healthy enough
- hand off if build failure or code/build blocker is already evident

#### `package`

- create if upload input is ready and target runtime component is absent
- reuse if an acceptable existing component already exists
- wait or block if local package input is not yet safe

#### `template`

- from the orchestrator view: `handoff`
- from the bootstrap subplan view: `skip`

### 7.4 Dependency Deferral Rule

If an upstream source-backed component has not converged yet, dependency wiring must be deferred.

This is not equivalent to failure. It is a valid deployment-planning state.

Recommended dependency status values:

- `ready_to_wire`
- `deferred_by_upstream_convergence`

This distinction is necessary to separate:

- topology still building
- topology created but runtime unhealthy

### 7.5 DeploymentPlan Step Model

Recommended internal step shape:

```yaml
PlanStep:
  id: string
  kind: resolve_context | ensure_app | ensure_component | wire_dependency | deploy | inspect_runtime | evaluate_delivery | handoff
  target_component: string | null
  action: create | reuse | skip | wait | handoff
  status: pending | in_progress | completed | deferred | blocked
  evidence_required: string[]
  evidence_observed: string[]
  blocker_reason: string | null
  handoff_target: none | template_installer | troubleshooter | delivery_verifier | version_assistant | code_build_handoff
```

Recommended step progression:

1. resolve context from files and explicit overrides
2. ensure app exists or is reused
3. ensure each executable component exists or is reused
4. wire minimum dependencies that are ready to wire
5. deploy or restart affected components when required
6. inspect runtime evidence from Rainbond Tool summaries, events, and logs
7. evaluate delivery readiness
8. hand off to the next skill or stop with a blocker

### 7.6 Evidence Gates

Each step should carry explicit gates instead of relying on implicit control flow.

Core gates:

- `secrets_ready`
  - required secret source is available from explicit input or `.rainbond/secrets.<env>.json`
- `template_metadata_ready`
  - template install metadata is complete enough for installer execution
- `source_converged`
  - required source-backed upstream component is no longer still building or compile-failed
- `dependency_wiring_ready`
  - runtime metadata is sufficient to safely wire downstream dependencies
- `access_mode_declared`
  - frontend/user-facing access intent is known well enough to proceed

These gates should be reflected in plan decisions rather than hidden in execution code.

### 7.7 Deferred States and Evidence Buckets

Recommended shared component convergence labels:

- `building`
- `waiting`
- `running`
- `abnormal`
- `capacity-blocked`

Recommended dependency readiness labels:

- `resolved`
- `deferred`

Recommended normalized blocker buckets:

- `db not ready`
- `dependency missing`
- `env naming incompatibility`
- `wrong connection values`
- `api startup issue`
- `frontend access-path issue`
- `source build still running`
- `source build failed`
- `external artifact unreachable`
- `cluster capacity blocked`

These evidence buckets should be used consistently across bootstrap, troubleshooter, and delivery verification so handoff recommendations stay readable and machine-normalizable.

### 7.8 Handoff Boundaries

The `DeploymentPlan` should surface explicit next-stage boundaries, not only step failure.

Recommended handoff rules:

- `template_installer`
  - template intent exists and bootstrap should not execute it directly
- `troubleshooter`
  - runtime blockers, source convergence issues, env mismatch, or dependency problems remain after creation stage
- `delivery_verifier`
  - setup work is complete enough that the remaining question is delivery acceptance
- `version_assistant`
  - delivery is sufficiently successful and the user or orchestrator is moving into snapshot/publish/rollback flow
- `code_build_handoff`
  - the blocker is now clearly in source/build/reverse-proxy/frontend code rather than deployment orchestration

## 8. External Projection Boundaries

The canonical model exists for system reasoning. External files should carry only stable and necessary projections of that model.

### 8.1 `rainbond.app.json`

Role:

- committed project baseline
- shared declaration of desired topology

May contain:

- component topology
- stable source declarations
- non-sensitive default env
- roles, dependencies, and access intent

Must not contain:

- secrets
- binding state
- runtime truth
- execution-state diagnostics
- internal inference metadata

Example: executable v1 manifest

```json
{
  "schema_version": 1,
  "project": {
    "team_name": "team-a",
    "region_name": "region-1",
    "app_name": "my-app"
  },
  "components": [
    {
      "name": "api",
      "role": "service",
      "code_from": "git",
      "git_url": "https://gitee.com/example/repo",
      "code_version": "main",
      "subdirectories": "backend",
      "port": 8080,
      "depends_on": ["postgres"]
    },
    {
      "name": "frontend",
      "role": "frontend",
      "image": "goodrain.me/demo-web:latest",
      "access_mode": "reverse-proxy"
    }
  ]
}
```

Example: v2 design draft

```json
{
  "schema_version": 2,
  "project": {
    "team_name": "team-a",
    "region_name": "region-1",
    "app_name": "future-app"
  },
  "repo": {
    "git_url": "https://gitee.com/example/repo",
    "default_branch": "main"
  },
  "components": [
    {
      "name": "api",
      "role": "service",
      "source": {
        "kind": "source",
        "git": {
          "remote_url": "https://gitee.com/example/repo",
          "ref": "main"
        },
        "subdirectories": "backend"
      }
    },
    {
      "name": "worker",
      "role": "service",
      "source": {
        "kind": "image",
        "image": "goodrain.me/demo-worker:latest"
      }
    }
  ]
}
```

Rule:

- use the v1 shape for current executable flows
- use the v2 shape only when the user explicitly wants a design-layer draft

### 8.2 `.rainbond/local.json`

Role:

- local binding state and local preferences

May contain:

- `team_name`
- `region_name`
- `app_name`
- `app_id`
- `platform.server_name`
- `metadata.status`
- link metadata
- preferences such as `default_environment`
- runtime component hints

Must not contain:

- secrets
- canonical project topology
- final runtime truth
- internal source resolution diagnostics

Example:

```json
{
  "schema_version": 1,
  "binding": {
    "team_name": "example-team",
    "region_name": "cn-north-1",
    "app_name": "example-app",
    "app_id": "123",
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
    "synced_by": "local-sync"
  }
}
```

Rule:

- keep only durable non-sensitive values that differ from the project baseline
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

1. `rainbond-project-init` resolves `Project.identity`, writes or reuses `rainbond.app.json`, and records local binding in `.rainbond/local.json`.
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

1. `ComponentSource.kind = package` is selected only when `local_path` resolves deterministically enough for upload.
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

Target output object:

```yaml
ProjectInitResult:
  project: Project
  environment: Environment
  component_sources: ComponentSource[]
  init_status: linked | pending_verification | blocked
  next_action: stop | bootstrap
```

### 13.2 `rainbond-fullstack-bootstrap`

Current human-readable sections map as:

- `Creation Result` -> project/environment context + component outcomes
- `Actions Taken` -> `DeploymentPlan` detail
- `Current State` -> partial `RuntimeState`
- `Handoff Recommendation` -> `next_handoff`

Target output object:

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

Target output object:

```yaml
TroubleshootResult:
  runtime_state: RuntimeState
  blocker_bucket: string | null
  actions_taken: string[]
  verification_summary:
    db_status: string
    api_status: string
    frontend_access_status: string
  next_handoff: none | delivery_verifier | code_build_handoff
```

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
