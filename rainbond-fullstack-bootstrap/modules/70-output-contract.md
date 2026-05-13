# Output Contract

- Read when: you are composing the final reply or validating whether bootstrap output still matches the frozen contract.
- Do not read when: you are only deciding scope or routing execution before any output is written.
- Depends on: [../SKILL.md](../SKILL.md), [60-verification-and-handoffs.md](60-verification-and-handoffs.md), [../schemas/bootstrap-result.schema.yaml](../schemas/bootstrap-result.schema.yaml).
- Produces: the required human-readable section order, `BootstrapResult` assembly rules, and cross-field consistency requirements.

## Required Reply Shape

Every final reply must contain these sections, in exactly this order:

1. `### Creation Result`
2. `### Actions Taken`
3. `### Current State`
4. `### Handoff Recommendation`
5. `### Structured Output`

Rules:
- `### Structured Output` must be the final section
- the fenced block under `### Structured Output` must be valid `yaml`
- the top-level object name must be `BootstrapResult`
- do not place prose after the structured block

## Structured Output Source of Truth

Use [../schemas/bootstrap-result.schema.yaml](../schemas/bootstrap-result.schema.yaml) as the minimal source of truth for:
- top-level object name
- field names
- enum values
- nested shape

Current frozen shape:
- `BootstrapResult.deployment_plan.app_identity`
- `BootstrapResult.deployment_plan.environment`
- `BootstrapResult.deployment_plan.workflow.created`
- `BootstrapResult.deployment_plan.workflow.reused`
- `BootstrapResult.deployment_plan.workflow.skipped`
- `BootstrapResult.deployment_plan.workflow.skipped_reasons`
- `BootstrapResult.deployment_plan.workflow.deferred_dependencies`
- `BootstrapResult.deployment_plan.workflow.frontend_access_mode`
- `BootstrapResult.runtime_state`
- `BootstrapResult.next_handoff`

Do **not** invent old-style top-level fields such as:
- `created_components`
- `reused_components`
- `skipped_components`
- top-level `deferred_dependencies`

## Narrative to Structured Mapping

### `Creation Result`

Must say:
- whether the app was created or reused
- whether each in-scope component was created, reused, or skipped
- which components were skipped
- when template-backed components were skipped because they belong to `rainbond-template-installer`

### `Actions Taken`

Must include:
- the exact actions taken
- created components, ports, dependencies, env changes, deploy/restart actions
- stateful middleware storage inspection and any volume or mount created for a known data directory
- whether config files were used
- masked secret output such as `POSTGRES_PASSWORD=***`
- any explicitly deferred dependency

### `Current State`

Must summarize:
- current app state
- each component state using canonical labels `building`, `waiting`, `running`, `abnormal`, or `capacity-blocked`
- whether each stateful middleware component has durable storage mounted, or the explicit caveat if this could not be verified
- declared frontend `access_mode`, if any
- deferred dependencies caused by source convergence, if any

If MCP reports a raw platform state such as `undeploy`, translate it into the canonical vocabulary instead of echoing the raw label as the primary state.

### `Handoff Recommendation`

Must:
- state `ready for troubleshooting` or `setup complete`, or otherwise clearly describe the bounded stop
- name the next skill when the next stage is `rainbond-fullstack-troubleshooter` or `rainbond-delivery-verifier`
- explain the blocking issue in one or two lines using normalized blocker buckets when possible
- note when frontend validation is still needed

## Field Assembly Rules

- `deployment_plan.app_identity`
  - comes from the resolved current-run app identity after configuration layering
- `deployment_plan.environment`
  - reflects the resolved selected environment and its source
- `deployment_plan.workflow.created`
  - contains only components actually created in the current run
- `deployment_plan.workflow.reused`
  - contains only components explicitly confirmed as reused in the current run
- `deployment_plan.workflow.skipped`
  - contains only components intentionally not executed by bootstrap
- `deployment_plan.workflow.skipped_reasons`
  - explains every skipped component
- `deployment_plan.workflow.deferred_dependencies`
  - contains every dependency edge intentionally left incomplete
- `runtime_state.component_status`
  - reflects the current MCP/runtime evidence observed after bootstrap actions
  - normalizes raw platform-native states into canonical vocabulary
- `runtime_state.blocking_bucket`
  - uses the canonical blocker vocabulary
- `runtime_state.overall`
  - is derived from the same dominant evidence as the blocking bucket and component states
- `next_handoff`
  - is the normalized form of the prose handoff recommendation
  - means the canonical next recommended stage, not a statement about what already executed

## Consistency Rules

- a component may appear in only one of `created`, `reused`, or `skipped`
- every in-scope component must be accounted for in exactly one of `created`, `reused`, or `skipped`
- `created` may legitimately be empty
- template-backed components belong in `skipped`, not in failure lists
- if prose says a dependency is deferred, it must appear in `deferred_dependencies`
- if prose says a multi-component topology is ready for delivery verification, it must also say the dependency completeness gate checked accepted provider/consumer edges or otherwise explain why dependency verification was deferred
- if prose says the current blocker is capacity-related, `runtime_state.overall` must not be `runtime_healthy`
- if `runtime_state.blocking_bucket = mcp backend issue`, `next_handoff` must be `none`
- if `runtime_state.blocking_bucket = external artifact unreachable`, `runtime_state.overall` should be `code_or_build_handoff_needed` and `next_handoff` should be `code_build_handoff`
- `next_handoff` must agree with the prose handoff recommendation
- no secret values may appear in the structured object

## Minimal Section Skeleton

Use this shape, then fill it with the current run’s facts:

````markdown
### Creation Result
...

### Actions Taken
...

### Current State
...

### Handoff Recommendation
...

### Structured Output
```yaml
BootstrapResult:
  ...
```
````
