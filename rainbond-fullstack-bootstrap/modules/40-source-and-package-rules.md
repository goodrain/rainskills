# Source and Package Rules

- Read when: any in-scope component resolves to `source` or `package`, or when build-parameter tuning is under discussion.
- Do not read when: all components are image-backed and no source/package routing is needed.
- Depends on: [../SKILL.md](../SKILL.md), [10-context-loading.md](10-context-loading.md), [30-creation-rules.md](30-creation-rules.md), [../references/source-build-parameter-guide.md](../references/source-build-parameter-guide.md).
- Produces: the correct execution path, build-parameter routing, and stop conditions for source-backed and package-backed components.

## Source-backed Components

For v2-style source components:
- `source.kind = source` means the component should be created through the Rainbond source-creation flow
- map:
  - `source.git.remote_url` -> `git_url`
  - `source.git.ref` -> `code_version`
  - `source.subdirectories` -> `subdirectories`

### Source-kind Preservation

Once a component resolves to `source.kind = source`:
- preserve that execution path for the current run
- if source creation or source build later fails, classify that as `source build failed` or `code_build_handoff`
- do **not** silently downgrade the component to `image`
- do **not** guess a fallback image unless an explicit higher-priority image override was provided for the current run
- do **not** switch to local Docker build, temporary registry push, or package upload as an implicit workaround

### Source-ref Preservation

Once `code_version` or source ref has been resolved:
- preserve it for the current run
- if the remote branch or ref does not exist, stop and report the source-ref problem explicitly
- do **not** silently rewrite `newmain` to `master`, `main`, or any other branch
- do **not** probe alternative refs unless the user explicitly changes the source definition for the run

### `code_from` Mapping

- generic Git or Gitee repositories -> `git`
- GitHub repositories -> `github` or `git`; prefer `github` when clearly supported, otherwise use `git`
- OAuth-backed repositories -> preserve the provided `oauth_xxx` value

If `code_from` cannot be determined safely:
- mark the source component as `needs-confirmation`
- do not guess

If the user provides a proxied Git URL:
- preserve `source.kind = source`
- use the provided proxied URL as `git_url`
- do not reinterpret a Git proxy URL as an image hint or fallback signal

### GitHub Proxy Prompt

If all of the following are true:
- `git_url` is a raw `https://github.com/...` URL
- the user did not explicitly provide a proxy URL
- the URL is not already under `https://ghfast.top/` or `https://gh.rainbond.cc/`

Then:
- ask once whether to keep the raw GitHub URL or switch to a proxy URL before calling source creation
- recommend `https://ghfast.top/https://github.com/...` first
- `https://gh.rainbond.cc/https://github.com/...` may be offered as an explicit alternate

### Source-create Precheck

For standard source-backed creation:
- required inputs are `git_url`, `code_version`, `code_from`, and optional `subdirectories`
- **always pass `code_version` as the repository's real default branch** — from the project source profile's `repo.defaultBranch` when available (e.g. `rainbond_get_project_source_profile`), otherwise the ref the user gave or the detected default. Omitting `code_version` makes the backend default to `master`, so any `main`-default repo fails creation and forces a recovery path that loses the build-mode preference (see Retry Discipline). Do not blind-guess `master`/`main`.
- `check_uuid` and `event_id` are optional passthrough fields only when a prior detection flow already produced them
- do **not** invent a blocker just because `check_uuid` or `event_id` is absent
- only stop on this point if the backend explicitly returns that those fields are required for the current request

### Source-create Retry Discipline

`rainbond_create_component_from_source` is a create-and-build tool, not an idempotent retry tool. Every call mints a new `service_id`. A failed source-creation flow does **not** mean the component is absent — the component row, ports, envs, and dependency edges may already exist with the build merely failing downstream.

Before calling `rainbond_create_component_from_source` after any earlier source failure in the same run:
- query the target app with `rainbond_query_components` and look for a matching `service_cname` or `k8s_component_name`
- if a matching component already exists, do **not** call `rainbond_create_component_from_source` again — switch to the retry path below

Pick the retry path by intent:
- same `git_url` + same `code_version`, want to retrigger the build → `rainbond_build_component(service_id, build_info=...)`
- source definition changed (`git_url`, `code_version`, `server_type`, credentials) → `rainbond_update_component_build_source` then `rainbond_build_component`
- build env tuning only → `rainbond_manage_component_envs(operation=replace_build_envs, build_env_dict=...)` then `rainbond_build_component`

Rules:
- never call `rainbond_create_component_from_source` twice for the same logical component in one run; that produces duplicate `service_id` rows the user has to clean up
- a build failure surfaced by events or build logs is **not** evidence the component was not created; verify with `rainbond_query_components` before any retry
- the existing source-failure handling in [50-workflow-and-convergence.md](50-workflow-and-convergence.md) (read events, read build log, classify blocker) still applies; this section only governs which tool to call when retry is justified

**Exception — stuck on CNB but needs Dockerfile (the one sanctioned recreate):** the retry paths above CANNOT change build mode, because `prefer_dockerfile_when_detected` is create-only (see Build Mode). So if a source component already exists with `build_strategy = cnb` and its CNB build dead-ends on a not-CNB-allowed language/version (e.g. `dotnet version 7.0 is not allowed by cnb version policy`) while the repo ships a usable Dockerfile, neither `rainbond_update_component_build_source` nor `rainbond_check_component` can rescue it. In that case `rainbond_delete_component` the stuck component and recreate it once with `rainbond_create_component_from_source(..., code_version=<default branch>, prefer_dockerfile_when_detected=true)`, then reconfigure ports/envs/deps on the new `service_id`. Do this early, before attaching extensive config. **Prevention beats this:** get `code_version` and `prefer_dockerfile_when_detected` right on the first create so no recovery is ever needed.

### Multi-service Source Ambiguity

If source detection reports `multiple services detected` or equivalent multi-component ambiguity:
- stop the current bootstrap path immediately
- report that the repository requires an explicit component-selection strategy
- do **not** automatically switch the component from source to local package
- do **not** automatically build jars locally, upload artifacts manually, or install middleware templates as a workaround
- only continue on a package-backed or manually selected path after the user explicitly confirms that strategy

### Compose / Multi-service Topology

When the project is a docker-compose application — a `docker-compose.yml` / `compose.yaml`, or a project source profile with `topologySource == "compose"` — deploy the whole topology as one Rainbond app with **one component per compose service**. Create each service **individually with its own `subdirectories`** (its compose `build.context`), so every create call is single-service and does not trip the "multiple services detected" stop above.

Per service, by kind (from the profile's `deployKind`):
- `image` (compose `image:`) → `rainbond_create_component_from_image` (image proxied per guardrail 7).
- `source` (compose `build:`) → `rainbond_create_component_from_source` with its `subdirectories`, `code_version = repo.defaultBranch`, and `prefer_dockerfile_when_detected = true` when the service ships a Dockerfile (compose `build:` almost always does). Get these right **at create** (see Source-create Precheck + Build Mode) so no recovery path is needed.

Completeness:
- create one component per service, then confirm the created-component count matches the profile's service count.
- one-shot / init-only services (seed, migrate, fixtures — run once and exit, not long-running) MAY be skipped, but the skip and its reason MUST be stated explicitly in the report. Never silently drop a service.

Configure and bring up (reuse existing rules, do not invent tools):
- per-service config: ports (provider/infra such as db, redis → `enable_inner` only; web/public-facing → `enable_inner` + `enable_outer`); runtime envs; persistence for stateful services (storage before deploy, guardrail 17); provider connection envs.
- dependencies: wire every compose `depends_on` edge with `rainbond_manage_component_dependency`, then run the dependency completeness gate (guardrail 12).
- bring-up differs by kind: image components deploy directly (`rainbond_operate_app`); **source components must be built** (`rainbond_build_component`) — a source component that was only created/detected has no runnable image and stays `undeploy` if you merely `operate_app deploy` it. Deploy the infra (db/redis) first, then build the source services that depend on them.

## Source Build Parameter Rules

Use source build parameter tools only when there is:
- explicit build-tuning intent
- or build evidence that points to a missing or incorrect build setting

Tool boundaries:
- build parameters -> `rainbond_manage_component_envs(operation=replace_build_envs, build_env_dict=...)`
- runtime envs -> `rainbond_manage_component_envs` with normal env operations such as `upsert`
- provider connection envs -> `rainbond_manage_component_connection_envs`
- dependencies -> `rainbond_manage_component_dependency`
- source repository / ref / credentials -> `rainbond_create_component_from_source` inputs and `rainbond_build_component.build_info`

Minimal-parameter strategy:
- determine the component language from explicit user input first, then source detection or current component build metadata
- if the language is still ambiguous, stop and read the detection result before modifying `build_env_dict`
- add only the smallest set of build keys needed for the current evidence or explicit request
- do **not** dump a full language template into `build_env_dict` "just in case"

Guardrails:
- do **not** put runtime-oriented variables such as `NODE_OPTIONS`, `JAVA_TOOL_OPTIONS`, `BPL_*`, `PORT`, or db connection envs into `build_env_dict` by default
- do **not** use consumer runtime envs as a substitute for provider connection envs plus explicit dependencies
- do **not** echo secret example values
- Python build tuning does **not** get a made-up Node-style `CNB_BUILD_SCRIPT`
- when a Dockerfile is detected alongside a language build, resolve the build mode by priority: manifest `source.build.strategy` first; then heuristic on Dockerfile classification + intent signals (see `../references/source-build-parameter-guide.md § Build Mode Selection`); only ask the user when signals are genuinely ambiguous. Map a `dockerfile` decision to `prefer_dockerfile_when_detected = true` on `rainbond_create_component_from_source`. Record the per-component decision in BOTH the prose ("Build mode for `<name>`: …") and the structured output (`deployment_plan.workflow.build_strategy_decisions[<name>]`) so the user can audit and override.
  - **`prefer_dockerfile_when_detected` is honored only at create time.** `rainbond_update_component_build_source` and `rainbond_check_component` (re-detect) do NOT re-apply it, and the MCP surface has no field to flip `build_strategy` after creation. So the Dockerfile-vs-CNB decision must be correct on the create call; a component that already built as CNB cannot be switched to Dockerfile in place (see the build-mode exception in Source-create Retry Discipline).
  - **.NET version trap:** dotnet/.NET Core is treated as CNB-capable, but the CNB version policy only allows .NET 8/9/10. A repo on a CNB-rejected version (e.g. .NET 7 → `dotnet version 7.0 is not allowed by cnb version policy`) that ships a usable Dockerfile MUST be created with `prefer_dockerfile_when_detected = true`, or its CNB build dead-ends with no in-place recovery.
- if build logs fail while downloading third-party build artifacts such as GitHub Release assets, native binary packages, image layers, or package-manager tarballs, classify the blocker as `external artifact unreachable` when the dominant evidence is network reachability rather than app source code
- examples include sharp/libvips release downloads, registry layer pulls, Docker Hub timeouts, package tarball download timeouts, or language installer binary downloads
- for `external artifact unreachable`, stop after one evidence-backed retry or mirror attempt; do not convert the component to a different delivery mode automatically

### Monorepo Build Context

For source-backed components in monorepos:
- preserve repository-root build context when the component Dockerfile or build command depends on root-level files such as `pyproject.toml`, `uv.lock`, `pnpm-lock.yaml`, `package-lock.json`, `bun.lock`, `go.work`, `settings.gradle`, or `pom.xml`
- use component subdirectory metadata only when it does not hide required root build files from the builder
- if the current Rainbond source interface cannot express the required build context safely, stop with a source/build handoff or manifest review instead of staging a local package silently

Read [../references/source-build-parameter-guide.md](../references/source-build-parameter-guide.md) for the current MCP-facing key list and minimal examples.

### SQL Initialization Assets

If the source repository ships SQL initialization files (`sql/*.sql`, `db/init/*.sql`, similar) and the database component is not a pre-baked image that auto-imports them:
- treat SQL initialization as a first-class delivery concern; do **not** wait for runtime errors like `Table 'X' doesn't exist` to surface it
- pick exactly one delivery path from [../references/sql-init-recipe.md](../references/sql-init-recipe.md) and stick to it
- the default path is Recipe A (Init-Job Component) when the application source is in a git repo reachable by the cluster
- do **not** use public file-sharing services, manual `kubectl exec`, or import containers without `depends_on` as workarounds
- do **not** silently choose MCP local-package upload as the SQL transport; require explicit user opt-in

## Package-backed Components

For v2-style package components:
- `source.kind = package` means the component should be created through the Rainbond package-upload flow
- map:
  - `source.local_path` -> local package path
  - `source.archive_name` -> optional zip filename when `local_path` is a directory

Rules:
- resolve `source.local_path` relative to the current project directory unless it is absolute and the MCP upload tool is known to be able to read that absolute path
- if staging is needed, place generated package content under the current workspace, preferably `.rainbond/staging/<component>/`, not `/tmp`
- if `source.local_path` points to a directory, compress it to zip before upload
- if `source.local_path` points to a file, upload it directly
- prefer the high-level MCP tool `rainbond_create_component_from_local_package`
- if finer control is needed, use:
  - `rainbond_init_package_upload`
  - `rainbond_upload_package_file`
  - `rainbond_get_package_upload_status`
  - `rainbond_create_component_from_package`

If `source.local_path` cannot be resolved safely:
- mark the package component as `needs-confirmation`
- do not guess a different path

If the package upload tool reports "local path does not exist" for an absolute path outside the workspace:
- first verify the path from the current process
- if the path exists, restage under `.rainbond/staging/` and retry once
- if it still fails, classify the issue as a package-upload/tooling blocker and stop; do not pivot to local Docker or image push without explicit user confirmation
