---
name: rainbond-app-version-assistant
description: "Perform explicit version operations for an existing Rainbond app: create or inspect snapshots, publish to a local library or cloud market, or preview/apply rollback. Use for ‘创建快照’, ‘发布到本地组件库’, ‘回滚到快照’, or ‘create snapshot’."
---

# Rainbond App Version Assistant

## Purpose and ownership

Operate the version center of one existing Rainbond app: inspect state, create snapshots, create/continue publish drafts and events, publish, or preview/apply rollback. This Skill does not deploy a new app, perform market-app upgrades, or repair runtime after the version operation.

## Fast path

1. Read the [generated Runtime Gate](references/generated/runtime-gate.md) once per session; if absent, follow [generated Runtime Routing](references/generated/runtime-routing.md).
2. Resolve one existing app and inspect its current version-center state before any write.
3. Select exactly one snapshot, publish, continue/abandon, direct-reuse, or rollback branch.
4. Confirm the exact version/snapshot/scope and execute each mutation once.
5. Read back the version center or operation record and report the verified result.

## Conditional reading table

| Condition | Read now | Do not preload |
|---|---|---|
| Need tool ownership, identifiers, input resolution, or current state | [version operations](references/version-operations.md), [version workflow](references/version-workflow.md) | output examples |
| Create snapshot, direct reuse, publish, continue, abandon, or rollback | [version workflow](references/version-workflow.md), [version operations](references/version-operations.md) | unrelated operation branches |
| Need customer or structured result | [output contract](references/output-contract.md), [generated user-result policy](references/generated/user-result.md) | version-center history |

Load only the active row. Do not preload publish and rollback rules for a snapshot-inspection request.

## Workflow

1. **Inspect first.** Confirm app ID, current snapshot/runtime state, unfinished draft/event, and relevant rollback record.
2. **Resolve intent.** Snapshot creation, local/cloud publish, draft continuation/abandonment, direct snapshot reuse, and rollback are mutually distinct branches.
3. **Validate inputs.** Preserve exact snapshot/version/alias/scope; ambiguous or stale identity stops before mutation.
4. **Confirm and execute once.** Each snapshot, publish, event, direct-create, or rollback mutation has its own confirmation. Timeout or unknown result triggers exact read-back, never replay.
5. **Verify terminal state.** Accepted, queued, publishing, rollback-started, and completed are different states. Report only the observed terminal or pending result.

Route reality: `/publish` redirects to `/version`; snapshot and publish begin in the version center. `/upgrade` is a different market-app upgrade flow and remains outside this Skill.

## Hard stops

- Stop when app, snapshot, version, publish scope, draft/event, or rollback target is ambiguous or stale.
- Stop before cloud/local publish when required metadata or scope-specific fields are incomplete.
- Stop on unknown write result until the exact version-center record resolves it.
- Stop after the explicit version operation; do not continue into runtime troubleshooting unless separately requested.

## Safety invariants

- Version operations require a verified existing app and current version-center facts.
- Snapshot creation, publish, event execution, direct reuse, and rollback are separately confirmed writes.
- Never change publish scope, snapshot, alias, version, or target app silently.
- Rollback requires previewed impact and fresh state; completion requires a verified rollback record.
- Credentials, internal namespaces, raw events, and unrelated app details remain hidden.

## Output selection

### 用户可见结果协议

Read the [generated user-result policy](references/generated/user-result.md). Default output is concise Chinese with app, operation, selected version/snapshot, actual state, important risk, blocker, and one next step. Structured mode follows the [output contract](references/output-contract.md).

## Anti-patterns

- Do not create a snapshot without inspecting current state and pending changes.
- Do not treat a publish draft or accepted event as completed publication.
- Do not silently switch local-library and cloud-market scope.
- Do not apply rollback without previewing the exact snapshot and impact.
- Do not replay an unknown version mutation.
- Do not preload every version branch or copy long UI route/output examples back into this entrypoint.
