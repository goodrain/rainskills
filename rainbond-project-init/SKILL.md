---
name: rainbond-project-init
description: "Initialize, adopt, or link a local project to Rainbond; generate or repair rainbond.app.json and .rainbond/local.json. Use when explicitly requested or when rainbond-app-assistant finds an unlinked workspace or local package. Do not use for a bare Git URL or image without local project context."
---

# Rainbond Project Init

## Purpose and ownership

Initialize only the current local project: create or repair `rainbond.app.json`, bind `.rainbond/local.json` to one verified Rainbond app, and return one canonical `next_action`. This Skill does not create components, troubleshoot runtime failures, or verify delivery.

## Fast path

1. Inspect only the current project for the manifest and binding.
2. Read the [generated Runtime Gate](references/generated/runtime-gate.md) once per session before platform access; when no runtime exists, follow [generated Runtime Routing](references/generated/runtime-routing.md).
3. Resolve identity from explicit input, existing binding, manifest, then bounded repository inference.
4. Reuse one verified existing app or create the missing app; normalize `app_id` to a positive integer.
5. Write canonical files, verify them, create or refresh the protected [HandoffContext](schemas/generated/handoff-context.schema.yaml), and select exactly one downstream action.

## Conditional reading table

| Condition | Read now | Do not preload |
|---|---|---|
| Existing valid manifest; identity known | [manifest modes](references/manifest-rules.md), [workflow and verification](references/workflow-and-verification.md) | inference details |
| Manifest missing, incomplete, or needs repair | [manifest modes](references/manifest-rules.md), [manifest inference](references/manifest-inference.md) | output examples |
| Existing app adoption or binding repair | [manifest inference](references/manifest-inference.md), [workflow and verification](references/workflow-and-verification.md) | unrelated component workflows |
| Need customer or structured result | [output contract](references/output-contract.md), [generated user-result policy](references/generated/user-result.md) | manifest inference |
| Need operator mistakes or quick lookup | [operational reference](references/operational-reference.md) | all other references |

Each row is a decision branch, not a reading checklist. Load at most the two references named by the active row.

## Workflow

1. **Classify mode.** Existing manifest means reuse; missing manifest means generate; one exact existing target app means adoption. Ambiguity stops for the smallest missing identity or manifest decision.
2. **Resolve project facts.** Preserve explicit source/image/package/template intent. Never infer template installation from a name alone, and never turn a source-backed component into another delivery mode silently.
3. **Resolve workspace and app.** Use exact user hints or one unambiguous candidate. Multiple candidates without a reliable match require user selection; never choose the first or a synthetic `default`.
4. **Converge files.** `rainbond.app.json` describes the project. `.rainbond/local.json` uses `binding.platform.server_name` and a positive integer or null `app_id`; historical aliases are migration input only.
5. **Verify.** Successful initialization requires a valid manifest, verified target app, known integer `app_id`, canonical binding, `preview|production`, and an execution summary.
6. **Handoff.** Template components with complete install metadata use `template_install`; incomplete template metadata uses `ask_manifest_review`; executable non-template components may use `bootstrap`; explicit stop-after-init uses `stop`.

The exact field rules and v1/v2 generation decisions live in the active manifest references. The canonical result schema is [project-init-result.schema.yaml](schemas/project-init-result.schema.yaml).

## Hard stops

- Stop when team, region, app identity, component source, or template metadata remains ambiguous.
- Stop before downstream handoff when `app_id` is unknown or online app verification did not complete.
- Stop after initialization when the user requested initialization only.
- Template execution never enters `rainbond-fullstack-bootstrap`.
- The address-only guard keeps a bare Git URL, image reference, or address-only deployment with no local project context outside this Skill.

## Safety invariants

- Never scan the user home directory or unrelated repositories for bindings.
- Never overwrite a valid manifest merely because inference would produce a different draft.
- Never persist credentials, confirmation IDs, runtime IDs, operation IDs, or raw platform output.
- Platform mutations follow the generated Gate and execute once after confirmation; unknown results are queried before retry.
- Existing-app adoption must make local files agree with verified platform identity before bootstrap.
- A valid incoming HandoffContext reuses runtime and workspace identity; writes refresh affected mutable state only. Invalid fingerprints, reconnect, 401/403, source changes, not-found, revision conflict, or stale state force targeted refresh.

## Output selection

### 用户可见结果协议

Read the [generated user-result policy](references/generated/user-result.md) before replying. Default replies are concise Chinese and name verified files, actions performed, application/environment facts, completion state, key evidence or open question, and one next step. Structured mode uses the canonical schema and [output contract](references/output-contract.md).

## Anti-patterns

- Do not regenerate an existing valid `rainbond.app.json`.
- Do not write legacy `platform.server_name` or `mcp.server_name` as the canonical binding.
- Historical `mcp.server_name` is only a migration alias; rewrite it to `binding.platform.server_name` before saving.
- Reject prefixed or non-numeric `app_id` values such as `app-123`.
- Do not claim `linked` when platform verification is unavailable; use pending verification.
- Do not offer multiple next steps when `next_action` selects exactly one.
- Do not copy complete schemas, generated Runtime contracts, or long output examples back into this entrypoint.
