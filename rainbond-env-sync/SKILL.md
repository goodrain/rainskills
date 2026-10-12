---
name: rainbond-env-sync
description: "Sync non-sensitive preview or production overrides from a linked Rainbond project into local env files. Use for ‘同步生产环境配置到本地’, ‘同步预览环境配置到本地’, or ‘sync environment overrides’."
---

# Rainbond Env Sync

## Purpose and ownership

Synchronize only durable, non-sensitive environment differences from one linked Rainbond app into local environment files. Preserve source ownership and generated coordinates; do not deploy, repair runtime, or create project bindings.

## Fast path

1. Read the [generated Runtime Gate](references/generated/runtime-gate.md) once per session; if absent, follow [generated Runtime Routing](references/generated/runtime-routing.md).
2. Require the canonical local binding and resolve exactly one `preview|production` target.
3. Read component env and ownership facts, then call `rainbond_analyze_env_conflicts` before any local write.
4. If any conflict exists, stop with zero file writes. Otherwise classify values, reconcile drift, write atomically, and verify.

## Conditional reading table

| Condition | Read now | Do not preload |
|---|---|---|
| Need keep/skip, sensitivity, ownership, DB_NAME, or file rules | [sync policy](references/sync-policy.md), [sync workflow](references/sync-workflow.md) | output examples |
| Conflict-free run needs drift reconciliation and verification | [sync workflow](references/sync-workflow.md), [sync policy](references/sync-policy.md) | structured examples |
| Need customer or structured result | [output contract](references/output-contract.md), [generated user-result policy](references/generated/user-result.md) | raw env values |

Load only the active row. Never load output examples while classifying secret or ownership boundaries.

## Workflow

1. **Validate binding and target.** The project must already be linked; environment is only `preview` or `production`.
2. **Collect bounded facts.** Read baseline/local metadata, component env, provider connection env ownership, and runtime-generated coordinates without exposing values.
3. **Run conflict gate.** The conflict gate has higher priority than drift reconciliation. Any conflict means this run must not write any file.
4. **Classify.** Keep only durable, non-sensitive, user-maintained differences; skip secrets, provider injection, platform coordinates, and ambiguous ownership.
5. **Reconcile and write.** Drift reconciliation runs only when there are no conflicts. Preserve unrelated user content, write atomically, and update stable metadata.
6. **Verify.** Re-read files, confirm permissions/content classes, and report captured, skipped, ambiguous, and unchanged categories.

## Hard stops

- Stop before any write when binding, app identity, target environment, source ownership, or baseline is ambiguous.
- Stop with zero writes on any conflict returned by `rainbond_analyze_env_conflicts`.
- Stop rather than persisting a sensitive value, runtime-generated coordinate, provider-injected value, or unknown-source value.
- Stop when an existing env file cannot be updated atomically without overwriting unrelated user content.

## Safety invariants

- `metadata.synced_by` is always `rainbond-env-sync`; schema version carries versioning, not host/client names.
- `DB_HOST`, `DB_PORT`, `API_HOST`, `API_PORT`, and equivalent generated coordinates are unconditionally excluded.
- `DB_NAME` from `connection_envs` or dependency injection is `runtime_metadata`; a durable non-sensitive component-owned `DB_NAME` differing from baseline may be kept; unknown source is `ambiguous` and must not write.
- Secret values never appear in output, metadata, diff logs, or generated files.
- Writes are local, bounded to declared env files, atomic, and verified after completion.

## Output selection

### 用户可见结果协议

Read the [generated user-result policy](references/generated/user-result.md). Default output is concise Chinese with the selected environment, files updated, categories kept/skipped/ambiguous, conflict status, and one next step. Structured mode follows the [output contract](references/output-contract.md).

## Anti-patterns

- Do not treat a conflict as drift or write a partial subset after conflict detection.
- Do not use a blanket `DB_NAME` denylist; classify it by source and ownership.
- Do not copy platform host/port coordinates into developer-maintained files.
- Do not replace entire files, reorder unrelated user content, or expose raw env values in reports.
- Do not use this Skill for unlinked projects, application deployment, or runtime repair.
- Do not preload output examples or copy the detailed classification tables back into this entrypoint.
