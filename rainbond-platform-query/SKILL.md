---
name: rainbond-platform-query
description: Answer explicit read-only Rainbond questions about the current user, enterprise, team, region, app, or component. Exclude deployment, mutation, publishing, troubleshooting, and installation.
---

# Rainbond Platform Query

## Purpose and ownership

Answer explicit, read-only platform questions with exactly the requested scope. Deployment, creation, repair, delivery acceptance, publishing, and every mutation belong to other Skills.

## Fast path

1. Read the [generated Runtime Gate](references/generated/runtime-gate.md) once per session; if absent, follow [generated Runtime Routing](references/generated/runtime-routing.md).
2. Map the request to one allowlisted query Tool and one stdin object.
3. Execute exactly one `query <tool> --input - --skill-id rainbond-platform-query` command.
4. Return only the requested safe fields and any permission boundary.

## Conditional reading table

| Condition | Read now | Do not preload |
|---|---|---|
| First platform access | [generated Runtime Gate](references/generated/runtime-gate.md), [generated Runtime Routing](references/generated/runtime-routing.md) | mutation contracts |
| Query already mapped | No additional reference | any catalog or adjacent Skill |

## Workflow

1. Current enterprise → `rainbond_query_enterprises({})`.
2. Teams → `rainbond_query_teams({})`; regions/clusters → `rainbond_query_regions({})`; all apps → `rainbond_query_apps({})`.
3. Apps in one workspace → `rainbond_get_team_apps({team_name, region_name})` using explicit or previously observed names.
4. Components → `rainbond_query_components({app_id})`. Normalize a decimal string to a positive integer; reject `app-123`. Missing valid `app_id` stops before any broader query.
5. Enterprise identity is internal CLI context. Do not ask the user for `enterprise_id` or expose the identity-resolution response.

## Hard stops

- Do not expand a narrow question into related team, region, app, component, or cluster queries.
- Stop when required user-known context is missing; never guess identifiers or query a substitute scope.
- Stop when a Tool is outside the allowlist or appears mutation-capable.

## Safety invariants

- The generated Gate exposes only `query`; never use `call`, `call_confirm`, direct HTTP, or client MCP.
- Keep stdout JSON separate from stderr; do not use `2>&1`, `grep`, or `head` to process output.
- Report only fields necessary for the question; omit email, internal IDs, connection addresses, credentials, and unrelated configuration unless explicitly requested.

## Output selection

State the requested scope, observed facts, and any permission boundary in concise language. When unavailable, name the missing required context instead of inferring it. Structured output is used only when explicitly requested.

## Anti-patterns

- Never mutate resources, credentials, access control, or configuration.
- Never enumerate adjacent scopes for convenience.
- Never guess a Tool name or perform catalog discovery when the requested query is unavailable.
- Never turn missing `app_id` into a team/app listing fallback.
