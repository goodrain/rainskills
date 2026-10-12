---
name: rainbond-fullstack-bootstrap
description: "Create only the Rainbond app/component topology for a known current project or manifest. Use for ‘只帮我创建应用和组件，不要继续排障’, ‘create topology’, or ‘bootstrap only’. Do not use for generic current-project deployment; route it to rainbond-app-assistant."
---

# Rainbond Fullstack Bootstrap

## Purpose and ownership

Create or reuse the minimum Rainbond app, components, ports, dependencies, storage, config files, and source/package bindings described by a verified manifest. Stop after topology convergence and return a bounded handoff; do not perform open-ended troubleshooting or delivery acceptance.

If the user gives a generic current-project deployment request, route that to `rainbond-app-assistant`; bootstrap owns only an explicit bounded topology phase.

## Fast path

1. Read the [generated Runtime Gate](references/generated/runtime-gate.md) once per session; if absent, follow [generated Runtime Routing](references/generated/runtime-routing.md).
2. Validate the incoming [HandoffContext](schemas/generated/handoff-context.schema.yaml), current project binding, selected environment, manifest, and execution subset; reuse valid runtime/context facts.
3. Create providers before consumers, configure components before first deploy, and record every deferred edge.
4. Deploy only affected components, wait with bounded convergence rules, verify fresh state, then choose one handoff.

## Local artifact precondition

Local source and package artifacts require an existing or just-completed `rainbond-project-init` result with canonical `rainbond.app.json`, `.rainbond/local.json`, and verified `app_id`. An address-only Git or image request does not require local files and stays outside this precondition. Never pass `source.local_path` to a Rainbond Tool.

## Conditional reading table

| Condition | Read now | Do not preload |
|---|---|---|
| Resolve context, selected components, and execution filters | [context loading](modules/10-context-loading.md), [scope and boundaries](modules/20-scope-and-boundaries.md) | creation details |
| Create ordinary image/service components | [creation rules](modules/30-creation-rules.md), [runtime topology rules](modules/35-runtime-topology-rules.md) | source/package branches |
| Source identity or multi-service topology | [source rules](modules/40-source-rules.md), [source topology](modules/42-source-topology.md) | package branch |
| Source build parameters or convergence | [source build rules](modules/44-source-build-rules.md), [convergence rules](modules/55-convergence-rules.md) | package upload |
| Local package create or replace | [package rules](modules/45-package-rules.md), [convergence rules](modules/55-convergence-rules.md) | source topology |
| Execute topology and select a handoff | [workflow](modules/50-workflow.md), [verification and handoffs](modules/60-verification-and-handoffs.md) | unrelated recipes |
| Need SQL initialization | [SQL init recipe](references/sql-init-recipe.md), [runtime topology rules](modules/35-runtime-topology-rules.md) | source build details |
| Need customer or structured output | [output module](modules/70-output-contract.md), [generated user-result policy](references/generated/user-result.md) | creation rules |
| Need compact manifest field lookup | [manifest v1 reference](references/manifest-v1-reference.md), [quick reference](references/quick-reference.md) | full workflow |

Load only the active row. A single execution branch may read at most two conditional documents before returning to this workflow.

## Workflow

1. **Resolve scope.** Confirm app identity, selected environment, requested component subset, and exact manifest revision. Generic current-project deployment belongs to `rainbond-app-assistant`.
2. **Preflight.** Detect existing resources, source/package readiness, provider contracts, capacity blockers, and required confirmations before mutation.
3. **Create in dependency order.** Providers first, then services, then frontends. Template components are never executed here.
4. **Configure before deploy.** Apply env, storage, config files, ports, proxy mode, and explicit dependencies before the first affected deployment.
5. **Converge writes once.** Unknown create/update/deploy results are queried by exact identity before retry; no write is replayed speculatively.
6. **Verify and hand off.** Use one bounded read-only `snapshot app` for the known verification reads, then return `troubleshooter`, `delivery_verifier`, `code_build_handoff`, or `none`.

For a known single dependency edge, do not call `describe`; query `operation=summary` exactly once before the write, do not re-query `operation=summary` after a successful `add`, and use the returned `dependency` object as the completion evidence.

## Hard stops

- Stop before mutation when manifest identity, source strategy, required secrets, provider contract, target component subset, or destructive replacement is ambiguous.
- Stop on proven capacity failure, unsupported privileged/storage semantics, or incomplete package upload evidence.
- Stop at `code_build_handoff` for application-code or unrecoverable build problems; do not modify code.
- Stop after topology creation when the user requested bootstrap only.

## Safety invariants

- Every mutable CLI call requires its confirmation ID and identical confirmed input.
- Database and other stateful providers expose durable storage and own their connection contract; consumers receive dependencies in provider-to-consumer direction.
- Frontend `access_mode` and reverse-proxy behavior are explicit; do not expose a backend publicly merely to make a frontend work.
- Package upload uses the fixed protected helper contract and always cleans local staging according to its stop rules.
- Preserve source kind, ref, monorepo context, Dockerfile choice, and user-selected delivery mode.
- **Always-on Guardrail 7 — proxy policy is closed:** rewrite `github.com` only to `https://ghfast.top`, rewrite `docker.io` only to `docker.1ms.run`, and for Other public registries try the original URL directly unless a canonical policy explicitly allows another mapping.
- Every write invalidates only the affected mutable snapshot; runtime and identity fingerprints remain reusable until an explicit schema invalidation condition occurs.

## Output selection

### 用户可见结果协议

Read the [generated user-result policy](references/generated/user-result.md). Default output is concise Chinese with verified app/component creation or reuse, important actions, dependency/storage changes, current state, key evidence, relevant port/access caveat, and one handoff. Structured mode follows the canonical [BootstrapResult schema](schemas/bootstrap-result.schema.yaml) and [output module](modules/70-output-contract.md).

## Anti-patterns

- Never execute template components in bootstrap; route them to `rainbond-template-installer`.
- Do not deploy before required configuration, storage, and dependencies are present.
- Do not infer a dependency from a Compose service name alone when runtime evidence contradicts it.
- Do not create duplicates when a compatible component already exists.
- Do not hide deferred edges, missing persistence, optional skipped services, or proxy caveats.
- Do not preload every module or copy their detailed procedures back into this entrypoint.
