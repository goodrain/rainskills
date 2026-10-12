---
name: rainbond-fullstack-troubleshooter
description: "Troubleshoot a bounded build, runtime, or access problem for an existing Rainbond app. Use for ‘backend 为什么构建失败’, ‘why build failed’, or ‘troubleshoot runtime’. Do not use for generic current-project deployment; route it to rainbond-app-assistant."
---

# Rainbond Fullstack Troubleshooter

## Purpose and ownership

Diagnose an existing linked Rainbond app, apply at most the smallest evidence-backed platform repair, and verify it with fresh evidence. If the user gives a generic current-project deployment request, route that to `rainbond-app-assistant`. This Skill does not create initial topology, rewrite application code, or perform final delivery acceptance.

## Fast path

1. Read the [generated Runtime Gate](references/generated/runtime-gate.md) once per session; when unavailable, follow [generated Runtime Routing](references/generated/runtime-routing.md).
2. Validate the incoming [HandoffContext](schemas/generated/handoff-context.schema.yaml), then issue one `snapshot app` request containing the known app reads, including `rainbond_get_app_health_overview`; expand only abnormal evidence.
3. Classify build, runtime, dependency, config, access, or capacity failure; read only the matching decision branch.
4. Anchor every mutation to fresh state, execute once after confirmation, and re-read the affected resource.
5. Return a verified handoff or one blocker.

## Conditional reading table

| Condition | Read now | Do not preload |
|---|---|---|
| Need app/component identity, evidence precedence, or operation anchoring | [diagnosis context](references/diagnosis-context.md), [diagnosis workflow](references/diagnosis-workflow.md) | root-cause catalog |
| Evidence matches database, dependency, env, access, build, capacity, or ConfigMap failure | [root-cause rules](references/root-cause-rules.md), [diagnosis workflow](references/diagnosis-workflow.md) | unrelated causes |
| Need fresh verification or structured result | [verification and output](references/output-contract.md), [generated user-result policy](references/generated/user-result.md) | root-cause catalog |
| Need common mistakes or quick lookup | [operational reference](references/operational-reference.md) | all other references |

Load only the active row. If evidence changes the classification, discard the old branch and load the newly matching row; do not accumulate every playbook.

## Workflow

1. **Freeze scope.** Use verified app/component identity and the selected environment; do not broaden the user request.
2. **Collect a bounded snapshot.** Start with app health, then only the component summary, dependency/config evidence, event, log, or build state needed for the current hypothesis.
3. **Classify before writing.** Distinguish platform-configurable blockers from code/build handoff, external artifact failure, capacity stop, and manual validation.
4. **Select one repair.** Prefer dependency wiring, provider connection contract, env correction, ConfigMap recovery, port/proxy correction, restart, or redeploy only when the evidence and active root-cause rule allow it.
5. **Confirm and execute once.** Unknown or asynchronous results require exact read-back, not mutation replay.
6. **Verify.** Fresh evidence must show the expected state transition. Otherwise return the remaining blocker and stop.

The canonical structured result is [troubleshoot-result.schema.yaml](schemas/troubleshoot-result.schema.yaml); do not copy its complete schema into this entrypoint.

## Hard stops

- Stop when app/component identity, source ref, requested repair scope, or destructive impact is ambiguous.
- Stop on cluster capacity blockers, unavailable platform evidence, unsupported external artifacts, or exhausted retry budget.
- Stop at `code_or_build_handoff_needed`; do not edit, test, commit, or push application code.
- Stop when a write result is unknown until fresh read-back resolves it.
- Stop after the bounded repair requested by the user; do not continue into unrelated delivery work.

## Safety invariants

- Configuration priority and runtime source precedence come from [diagnosis context](references/diagnosis-context.md); never guess values from stale logs.
- A missing dependency is repaired by an explicit Rainbond dependency edge and provider-owned connection contract, not a hard-coded service hostname.
- ConfigMap recovery performs one save, one restart, and one fresh verification; repeated blind saves are forbidden.
- 401/403, confirmation, credential, and replay behavior comes from the generated Gate and cannot be weakened.
- Logs and events are bounded evidence; unavailable evidence is not empty or successful evidence.
- Mutations refresh only affected runtime state in the HandoffContext. Fingerprint mismatch, reconnect, 401/403, source change, not-found, revision conflict, or stale mutable state forces targeted refresh.

## Output selection

### 用户可见结果协议

Read the [generated user-result policy](references/generated/user-result.md). Default output is concise Chinese with the direct judgment, actions performed, current state, key evidence, fresh verification, remaining blocker, and one next step. Structured mode uses `TroubleshootResult` via [verification and output](references/output-contract.md) and the schema-derived [generated contract](references/generated/troubleshoot-contract.md).

## Anti-patterns

- Do not use troubleshooting for generic deployment, initial bootstrap, or final delivery verification.
- Do not repair multiple hypotheses in one pass.
- Do not convert `unavailable`, old events, or stale logs into a confirmed root cause.
- Do not restart or redeploy before the configuration mutation is confirmed.
- Do not expose internal state enums, raw logs, tool traces, YAML, or JSON by default.
- Do not preload every root-cause rule or copy detailed procedures back into this entrypoint.
