# Verification and Handoffs

- Read when: you need to classify the current blocker, decide whether bootstrap is successful enough to stop, or choose `next_handoff`.
- Do not read when: you are only resolving config or deciding source/package routing before execution starts.
- Depends on: [../SKILL.md](../SKILL.md), [50-workflow-and-convergence.md](50-workflow-and-convergence.md), [../schemas/bootstrap-result.schema.yaml](../schemas/bootstrap-result.schema.yaml).
- Produces: canonical runtime-state wording, bootstrap success criteria, stop conditions, and normalized handoff decisions.

## Shared State Vocabulary

When describing runtime or handoff state, use the canonical terms from the product object model.

Runtime-state labels:
- `topology_missing`
- `topology_building`
- `runtime_unhealthy`
- `runtime_healthy`
- `capacity_blocked`
- `code_or_build_handoff_needed`

Component convergence labels:
- `building`
- `waiting`
- `running`
- `abnormal`
- `capacity-blocked`

Dependency readiness labels:
- `resolved`
- `deferred`

When a dependency is delayed specifically because an upstream source-backed component has not converged yet, describe it as `deferred_by_upstream_convergence`.

Normalized blocker buckets:
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

## Hard Stop Conditions

The current bootstrap path must stop when:
- source ref is invalid
- multi-component source ambiguity has not been resolved by the user
- Rainbond Tool / control-plane / Rainbond Console returns a backend exception during source creation
- source build clearly fails and the dominant evidence is no longer a bootstrap-setup issue
- frontend `access_mode` is still unspecified at the point of acceptance
- a required startup secret or runtime secret is missing and no safe secret source is available
- the retry budget has been exhausted for the same error signature or creation path

Stop means:
- do not invent fallback execution modes
- do not silently rewrite source metadata
- return the current blocker and the correct next stage, or `none` if the next action is outside bootstrap orchestration

## Verification Standard

A bootstrap run is successful when:
- the target app exists
- all executable non-template components in scope exist
- minimum topology is in place
- dependency completeness gate has been run for multi-component topologies
- inner ports are available if needed
- dependencies exist as declared or strongly inferred, or are explicitly deferred for a valid convergence reason
- components have been deployed at least once
- current runtime blockers, if any, are clearly identified

Bootstrap success does **not** require the entire app to be fully healthy.

Bootstrap may still stop in a valid way with:
- DB abnormal but created
- service waiting on dependencies
- source-backed components still building
- source-backed components failed to compile
- frontend access path still unresolved because `access_mode` is unspecified
- required startup secret source missing

In these cases, the result must clearly state that handoff is needed or that the run must stop without fallback.

## Handoff Rules

### `next_handoff = troubleshooter`

Use `troubleshooter` when:
- frontend `access_mode` is unspecified and frontend validation is still required
- DB startup still fails after the minimum bootstrap env is applied
- source-backed components are still building and downstream topology cannot yet be completed
- source-backed components have compile/build failures but the immediate next stage is still Rainbond-side inspection or bounded diagnosis rather than direct code/build remediation
- service cannot connect after minimum topology is in place
- dependency wiring is present but env compatibility still blocks startup
- any runtime issue requires targeted diagnosis rather than setup

### `next_handoff = delivery_verifier`

Use `delivery_verifier` when:
- runtime components are already converged enough that the remaining question is delivery acceptance rather than runtime repair
- a frontend component is running but the operator still needs the preferred user-facing access URL or final delivery judgment
- a frontend component is running and the unresolved issue is whether the app is externally reachable, not whether the container itself can start

### `next_handoff = code_build_handoff`

Use `code_build_handoff` when:
- source build evidence points to source code, build output, or source metadata rather than deployment orchestration
- source build or image pull evidence points to an unreachable external artifact, registry layer, package tarball, or GitHub Release asset
- the blocker has clearly moved out of Rainbond bootstrap and into code/build remediation

When you use this handoff:
- keep the component classified as source-backed
- keep `blocking_bucket` aligned with `source build failed` or `external artifact unreachable`
- do not reinterpret the failure as an image/package bootstrap issue

### `next_handoff = none`

Use `none` when bootstrap must stop but no downstream Rainbond runtime stage should take over yet, for example:
- Rainbond Tool or Rainbond Console returns a control-plane exception while creating a source-backed component
- the source component has not been created yet and the dominant blocker is a backend-side API failure
- a required secret source is missing
- the repository requires an explicit multi-service/component-selection decision from the user

## What Bootstrap Must Not Fix

Bootstrap must not attempt to fix:
- frontend `localhost` or invalid browser-side API paths
- Vite build-time env mistakes
- nginx or reverse-proxy issues
- source-code defects

Those are outside bootstrap scope.

## Cross-check Before Finalizing

Before finalizing the reply:
- normalize raw platform states such as `undeploy` into canonical vocabulary
- ensure `runtime_state.overall`, `runtime_state.blocking_bucket`, and `next_handoff` come from the same dominant evidence
- make sure `next_handoff` means the **next recommended stage**, not a claim about what already ran in the current turn
- if the blocker is `platform backend issue`, set `next_handoff = none`
- if the remaining question is only access URL or delivery acceptance, prefer `delivery_verifier` over `troubleshooter`
