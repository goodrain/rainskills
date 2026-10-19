# object-model

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
| link status | local workspace/package: `.rainbond/local.json` exists and `metadata.status == linked`; address-only Git/image: current-run platform identity is unambiguous | local artifact pauses for init/adopt; address-only continues without local files | `rainbond-project-init` only for the local artifact case |
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
