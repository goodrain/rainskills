<!-- rainskills-cli-only:start -->
# Bounded CLI configuration and creation

Use only in CLI profile after scope, source strategy and authorization are established. Load the active Runtime Gate for exact argv; `batch` and `recipe` are real protected commands, not platform Tools. Embedded profile keeps the session's existing Tool workflow.

## Existing components

Use `batch` for an already reviewed, single-app set of configuration steps. Prefer native `ports` and `dep_service_ids` arrays only if the live Tool schema supports them. Connection envs remain individual server operations, combined inside one CLI invocation.

Input has `schema=rainskills.confirmed-batch.v1.request`, verified `scope={team_name,region_name,app_id}`, and `steps=[{key,tool,arguments}]`. Each step names an explicit verified service_id. Allowed operations are custom-env upsert, ports add/enable_inner/enable_outer/disable_outer/update_protocol/update_alias, connection-env create/update and dependency add. No deletion, storage replacement, arbitrary result references or cross-app overrides.

Run one batch preflight, review the action keys against the authorized request, then repeat identical input with the returned confirmation_id. This ID is protocol protection, not new user authorization. Never ask the model to perform each internal preflight/confirm pair separately. Maximum 32 steps and 128 KiB input.

The CLI validates all steps against the live catalog before the first write and audits every actual write. Success results contain only bounded IDs/statuses. On partial failure, inspect the failed step; on unknown, query the exact target first. Do not replay the whole batch or reuse the confirmation ID. Existing successful effects are retained, not rolled back automatically.

## Fixed creation recipes

Use `recipe` for one missing component whose source kind is already selected. Input uses `schema=rainskills.component-recipe.v1.request`, verified `scope`, `enterprise_id`, `kind=image|source|package`, exact `create` arguments and optional `configure` steps without service_id. The CLI binds only the actual create response's service_id.

Preserve the exact Git URL/ref, image and selected deployment mode. `is_deploy` is false: configuration and persistent storage must precede deployment. `stateful=true` requires explicit `storage` create_volume parameters. Process providers before consumers; do not infer dependency edges from role alone. Existing same-name components block creation: adopt their verified IDs through the normal existing-component flow instead.

For package recipes, first complete the protected local upload workflow in [package rules](45-package-rules.md), including immediate local cleanup. The recipe accepts the resulting upload event only after a live uploaded-file check is non-empty. It does not replace upload initialization, the HTTP upload, cleanup or failure-event deletion. If creation fails or is unknown, preserve the source and query the target; never switch kind or create again speculatively.

After the recipe returns, deploy through the existing audited operation and use its real event. `next_action=deploy_and_verify` is not delivery success. Do not append an application URL unless delivery-verifier verified the actual gateway.

## Waiting

`rainbond_wait_for_build_completion` and exact supported summary operations are read-only. Use one bounded wait for the known event; do not wrap it in write confirmation. Same event, same turn: `rainbond_wait_for_build_completion(timeout=60)` once. If `status=running`, end the current turn; do not manually poll or wait again until the user continues. Status-type polling keeps unchanged states inside the protected CLI and cancels an in-flight request at its deadline.
<!-- rainskills-cli-only:end -->
