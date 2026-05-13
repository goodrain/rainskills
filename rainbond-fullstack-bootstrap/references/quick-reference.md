# Quick Reference

Use this file for low-frequency reminders. Do not treat it as the source of truth for execution logic.

## Common Mistakes

- creating duplicate components instead of checking existing ones first
- trying to fully troubleshoot runtime issues inside bootstrap
- forgetting inner port before adding a dependency
- duplicating provider connection values on every consumer instead of using provider connection envs plus explicit dependencies
- claiming MCP cannot create explicit component dependencies even though `rainbond_manage_component_dependency` is available
- treating Kubernetes/Rainbond DNS reachability, Nginx upstream config, or hard-coded service hostnames as a substitute for Rainbond console-visible dependency edges
- adding speculative compatibility envs during creation
- declaring success just because the app and components were created
- omitting the required `### Structured Output` section
- inventing top-level `created_components`, `reused_components`, `skipped_components`, or `deferred_dependencies` instead of using `deployment_plan.workflow.*`
- echoing raw platform states such as `undeploy` instead of normalizing them into the canonical runtime vocabulary
- treating frontend runtime path issues as bootstrap problems
- forgetting to require explicit frontend `access_mode` declaration
- exceeding the stage retry budget instead of stopping with the current blocker
- confusing source build parameters with runtime envs, connection envs, or `build_info`
- defaulting to `prefer_dockerfile_when_detected = true` just because a repository contains a `Dockerfile`
- promising `dockerfile_path` support when the current MCP surface only exposes `prefer_dockerfile_when_detected`
- jumping straight to runtime logs for a source build failure without checking component events and build logs first
- treating external artifact download failures as application source-code failures without naming the unreachable artifact
- staging local packages in `/tmp` when the MCP upload tool can only read the current workspace
- starting local Docker/OrbStack or pushing temporary images as an implicit fallback

## Source Resolution Summary

- Selected environment: explicit input > local default > `preview`
- App identity: explicit input > `.rainbond/local.json` > baseline `project`
- Component envs: explicit input > secret file > env-file overrides > baseline component envs
- Component topology: explicit input > baseline manifest
- Runtime component reuse hints: `.rainbond/local.json.runtime_components`, but trust MCP if they disagree
- Source mapping:
  - v1 top-level `image` -> image execution
  - v2 `source.kind = image` -> image execution
  - v2 `source.kind = source` -> source execution
  - v2 `source.kind = package` -> local package upload execution
  - v2 `source.kind = template` -> skip in bootstrap and handle via `rainbond-template-installer`

## Local Package Reminder

- use `source.local_path` for the file or directory to upload
- `source.local_path: "."` means package the current project directory
- `source.archive_name` is optional and only matters when `local_path` is a directory
- stage generated local packages under `.rainbond/staging/<component>/` inside the current workspace
- avoid `/tmp` for staging unless the upload tool has already proven it can read that path

## Preferred Creation Order

1. app
2. template-backed components are skipped and expected to be installed upstream
3. database components
4. service components
5. frontend component
6. inner ports
7. provider port aliases and connection envs
8. minimum consumer-local env
9. deploy
10. wait for source-backed build convergence
11. complete remaining dependencies
12. verify
13. hand off if needed

## Build Parameter Routing

- build parameters -> `replace_build_envs` with `build_env_dict`
- runtime envs -> normal component env operations
- connection envs -> connection env tool
- dependencies -> `rainbond_manage_component_dependency`
- build source/ref/auth -> source-create inputs or `build_info`

## Source Build Debug Order

1. component summary
2. component events
3. build logs for the failing `event_id`
4. runtime logs only if build evidence no longer explains the problem

## Deployment Pattern Reminder

- browser only accesses the `web` component
- frontend requests `/api` as a relative path
- nginx in the `web` container forwards `/api` to `api:8080`
- the `api` component does **not** need public exposure by default

## Preferred Stopping Rule

- stop at the first deeper runtime problem once minimum topology is established
- always require explicit frontend `access_mode` before declaring `setup complete`

## Output Reminder

- never print passwords, tokens, certificates, private keys, or other secrets in plaintext
- always end with `### Structured Output`
- keep `next_handoff` aligned with the prose recommendation
