---
name: rainbond-template-installer
description: "Install a confirmed local or cloud Rainbond application template into a new or existing app. Use for ‘从模板安装 WordPress 应用’, ‘安装应用模板’, or ‘install app template’. Public images and upstream container stacks use rainbond-opensource-app-deploy."
---

# Rainbond Template Installer

## Purpose and ownership

Resolve one confirmed Rainbond marketplace template and version, install it into the permitted target app, optionally deploy it, and verify the resulting services. This Skill does not infer arbitrary image stacks, execute bootstrap components, or upgrade an already installed market application.

## Fast path

1. Read the [generated Runtime Gate](references/generated/runtime-gate.md) once per session; if absent, follow [generated Runtime Routing](references/generated/runtime-routing.md).
2. Validate or create the [HandoffContext](schemas/generated/handoff-context.schema.yaml), then resolve `local|cloud` source, exact template identity, version, and target-app policy from verified catalog facts.
3. Confirm any ambiguous version, app reuse, name collision, or destructive install choice before mutation.
4. Install once, deploy only when requested, wait for bounded convergence, and verify real service state.

## Conditional reading table

| Condition | Read now | Do not preload |
|---|---|---|
| Need source, template, version, or target-app resolution | [template resolution](references/template-resolution.md), [template workflow](references/template-workflow.md) | output examples |
| Need install, collision, deployment, or error handling | [template workflow](references/template-workflow.md), [template resolution](references/template-resolution.md) | structured examples |
| Need customer or structured result | [output contract](references/output-contract.md), [generated user-result policy](references/generated/user-result.md) | catalog internals |

Load only the active row. Do not load output examples while the template or target app remains unresolved.

## Workflow

1. **Resolve source.** Local templates require local-library facts; cloud templates require `market_name` and cloud catalog facts.
2. **Resolve version.** One available version may be selected automatically; multiple versions require an exact user choice or an existing explicit constraint.
3. **Resolve target app.** Reuse is allowed only when policy and user intent permit it. A forbidden or ambiguous collision stops before installation.
4. **Install once.** Submit the exact template/version/target after confirmation. Unknown results are queried by returned install identity before any retry.
5. **Deploy and verify.** Distinguish installation accepted, services created, deployment started, runtime converged, and delivered; do not collapse them into one success state.
6. **Report.** Return source, template/version, target app, installed services, real state, blocker, and one next step.

## Hard stops

- Stop when source, `market_name`, template ID, version, target app, or collision policy is unresolved.
- Stop when the selected app cannot legally receive the template or installation would overwrite unrelated resources.
- Stop on an unknown write result until exact read-back resolves it.
- Stop rather than routing confirmed template services into `rainbond-fullstack-bootstrap`.

## Safety invariants

- Template and version IDs come only from platform catalog facts or explicit user input; never invent them.
- Cloud and local source parameters are mutually scoped and never silently converted.
- Each install/deploy mutation executes once after confirmation; timeout or 5xx requires read-back.
- Installed, deployed, running, and delivered remain distinct states.
- Credentials, internal namespaces, raw tool payloads, and unrelated app details never enter user output.
- Template installation writes invalidate the mutable snapshot and refresh only affected app/runtime state before downstream handoff.

## Output selection

### 用户可见结果协议

Read the [generated user-result policy](references/generated/user-result.md). Default output is concise Chinese with template source/name/version, target app, installed services, actions performed, actual install/deploy state, blocker, key evidence, and one next step. Structured mode follows the [output contract](references/output-contract.md).

## Anti-patterns

- Do not treat a public image, Compose/Helm descriptor, or named upstream suite as a market template.
- Do not guess the only version when the catalog returns multiple candidates.
- Do not reuse the first app or bypass an app-name collision.
- Do not report accepted installation as deployed or delivered.
- Do not retry an unknown install result by creating another installation.
- Do not preload the full catalog or copy detailed error/output examples back into this entrypoint.
