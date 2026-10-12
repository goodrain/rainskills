---
name: rainbond-delivery-verifier
description: "Verify final delivery and user access for an existing Rainbond app. Use for ‘确认当前应用是否已经交付成功，并给我访问地址’, ‘verify delivery’, or ‘confirm access URL’. Do not use for generic current-project deployment; route it to rainbond-app-assistant."
---

# Rainbond Delivery Verifier

## Purpose and ownership

Decide whether an existing Rainbond app is converged, usable, and backed by a verified access path. If the user gives a generic current-project deployment request before this stage, route that to `rainbond-app-assistant`. This Skill verifies and reports; it does not create topology, repair runtime configuration, or modify source code.

## Fast path

1. Read the [generated Runtime Gate](references/generated/runtime-gate.md) once per session; if absent, follow [generated Runtime Routing](references/generated/runtime-routing.md).
2. Validate the incoming [HandoffContext](schemas/generated/handoff-context.schema.yaml), then issue one `snapshot delivery` request containing `rainbond_get_app_detail` and `rainbond_get_app_health_overview`; expand only abnormal evidence.
3. Inspect only the component, storage, access, proxy, static-asset, or probe evidence required by the current delivery shape.
4. Use the bounded delivery adapter for URL verification; classify the final state from fresh evidence.
5. Return the real access URL, verified scope, caveats/blockers, and one next step.

## Conditional reading table

| Condition | Read now | Do not preload |
|---|---|---|
| Need convergence, reverse-proxy, persistence, static frontend, or probe rules | [verification rules](references/verification-rules.md), [delivery workflow](references/delivery-workflow.md) | output examples |
| Need final state mapping or structured result | [delivery workflow](references/delivery-workflow.md), [output contract](references/output-contract.md) | unrelated verification branches |
| Need customer wording | [generated user-result policy](references/generated/user-result.md), [output contract](references/output-contract.md) | raw evidence detail |

Load only the active row. A delivery branch may add a second reference only when its evidence shape actually requires it.

## Workflow

1. **Confirm convergence.** Component existence is insufficient; distinguish building, waiting, running, abnormal, and capacity-blocked state.
2. **Confirm delivery shape.** Determine frontend/backend proxy paths, stateful storage expectations, static frontend checks, and candidate access URLs from current platform facts.
3. **Probe safely.** CLI uses only `delivery probe --input - --skill-id rainbond-delivery-verifier`; embedded uses only the fixed server-owned `rainbond_probe_delivery_url` equivalent. Never use curl, model HTTP, or a free-form browser fallback.
4. **Classify.** Return `delivered` only when required checks pass. Adapter unavailability, cross-host redirect, or untestable external access becomes `delivered-but-needs-manual-validation`, not verified success.
5. **Report.** Include only the preferred user URL, verified paths/checks, persistence/static caveats, blocker, and next step.

Canonical schemas: [probe policy](schemas/delivery-probe-policy.schema.yaml) with `rainskills.delivery-probe-policy.v1`, [probe input](schemas/delivery-probe-input.schema.yaml), [probe result](schemas/delivery-probe-result.schema.yaml), and [delivery result](schemas/delivery-verification-result.schema.yaml).

## Hard stops

- Stop when app identity or required component/access evidence is ambiguous.
- Stop when bootstrap or troubleshooting is still active; do not claim final delivery early.
- Stop when the safe probe adapter is unavailable and require manual validation.
- Stop on unsafe URL, DNS, redirect, timeout, or body-limit policy without sending or replaying a request.
- Stop rather than repairing configuration or code from the verifier.

## Safety invariants

- Any `delivered + verified` result comes only from the bounded adapter and current convergence evidence.
- URL validation rejects unsafe schemes, userinfo, non-public addresses, DNS rebinding, HTTPS downgrade, and unauthorized cross-host redirects.
- Probes carry no Cookie, Authorization, Rainbond credential, or ambient browser state.
- Reverse-proxy delivery verifies both the page path and its same-host API path; persistence and static frontend checks cannot be silently omitted.
- Candidate URLs remain visible when manual validation is required, but their status is never promoted to verified.
- Delivery state is mutable and must be fresh within 30 seconds or revision-matched; stale or invalid HandoffContext state is refreshed without repeating unrelated onboarding.

## Output selection

### 用户可见结果协议

Read the [generated user-result policy](references/generated/user-result.md). Default output is concise Chinese with verified app state, the real access URL, checks performed, caveats/blocker, and one next step. Structured mode follows the [output contract](references/output-contract.md).

## Anti-patterns

- Do not use a 200 root page alone as delivery proof.
- Do not call `delivered` when `/api`, deep links, MIME, persistence, or required static checks fail.
- Do not follow cross-host redirects automatically or probe private/reserved addresses.
- Do not turn unavailable evidence into zero, empty, healthy, or verified.
- Do not mutate the app, speculate repairs, or rewrite code.
- Do not preload every verification branch or copy long acceptance checklists back into this entrypoint.
