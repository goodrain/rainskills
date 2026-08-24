---
name: rainbond-platform-query
description: Use for a user-requested, read-only Rainbond platform query about the current user, enterprise, team, region, app, or component. Do not use for deployment, changes, publishing, troubleshooting, or installation.
---

# Rainbond Platform Query

## Rainbond 传输

如果上游已初始化 RainSkills CLI，直接复用；否则读取 [../rainbond-app-assistant/references/transport-resolution.md](../rainbond-app-assistant/references/transport-resolution.md) 并按其固定 stdin 调用格式初始化一次。CLI 锁定后不得触发替代调用通道。已知查询不得先执行 `list` 或 `describe`，也不得混用写入 `call`。

## Scope and routing

This lightweight skill handles only explicit, read-only platform questions. Route deployment or project delivery to `rainbond-app-assistant`; creation to `rainbond-project-init` or `rainbond-fullstack-bootstrap`; repair to `rainbond-fullstack-troubleshooter`; final acceptance to `rainbond-delivery-verifier`; publishing to `rainbond-app-version-assistant`.

Do not expand a narrow question into related resource queries. Never change resources, credentials, access control, or configuration.

## Fixed query contract

1. Reuse current session identity when available. If it is absent, call `rainbond_get_current_user` once.
2. For “current enterprise”, an administrator calls `rainbond_query_enterprises` with `{}` and selects the enterprise matching session `enterprise_id`. Do not then query teams or regions.
3. If enterprise or cluster-management Tools are not visible, state that the user can only view their current permission scope. Do not guess a Tool name or attempt discovery.
4. Resolve required context before the resource query and pass the exact Console-backed arguments below. A session may supply these values, but it does not make required arguments optional at the Tool boundary:
   - enterprises: `rainbond_query_enterprises({})`
   - teams: `rainbond_query_teams({enterprise_id})`
   - regions/clusters: `rainbond_query_regions({enterprise_id})`
   - all accessible apps: `rainbond_query_apps({enterprise_id})`
   - apps in one team/region: `rainbond_get_team_apps({team_name, region_name})`
   - components: `rainbond_query_components({enterprise_id, app_id})`
5. `enterprise_id`, `team_name`, and `region_name` must come from current session identity, an earlier query result, or explicit user context. `app_id` must be a positive integer; normalize a decimal string before the Tool call and reject values such as `app-123`.
6. Use the read contract `read <tool> --input -` when using the CLI. Keep stdout JSON separate from stderr; do not use `2>&1`, `grep`, or `head` to process its output.
7. Report only fields needed for the question. Avoid email addresses, internal IDs, connection addresses, and configuration unless explicitly requested.

## Examples

- “帮我查询当前企业的信息” → current identity if needed, then one `rainbond_query_enterprises {}` call for an administrator; no team or region query.
- “我有哪些团队？” → resolve `enterprise_id`, then `rainbond_query_teams({enterprise_id})` only.
- “这个应用有哪些组件？” → resolve `enterprise_id` and positive-integer `app_id`, then `rainbond_query_components({enterprise_id, app_id})` only.

## Result

State the requested scope, the observed facts, and any permission boundary. When facts are unavailable, say which required context is missing instead of inferring it.
