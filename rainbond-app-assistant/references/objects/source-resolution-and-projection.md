# object-model-2

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
- `binding.platform.server_name`
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
