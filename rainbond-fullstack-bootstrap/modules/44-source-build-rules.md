# Source build rules

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
  - **Recovery is state-dependent.** `rainbond_get_component_check_result(prefer_dockerfile_when_detected=true)` can apply a Dockerfile preference while `create_status` is not `complete`; use its returned evidence, not a guessed build strategy. A completed CNB component has no general in-place switch and may only be recreated through the confirmed, snapshotted exception in Source-create Retry Discipline.
  - **Check-timeout recovery:** after a checking/timeout create, call `rainbond_get_component_check_result` and pass `prefer_dockerfile_when_detected=true` when Dockerfile was selected. The response fields `prefer_dockerfile_when_detected`, `dockerfile_preference_applied`, and `build_mode_note` are the evidence. If preference is not applied because no Dockerfile was detected, stop for an explicit source-path or delivery-mode decision; do not retry create speculatively.

### Bounded build wait

After a build/deploy trigger, call `rainbond_wait_for_build_completion(timeout=60)` once for the event in the current turn. If it returns `status=running`, end the current turn immediately with completed actions, current state, event ID, and one resume instruction; 不得再次等待、手工轮询或继续轮询. A later explicit user “继续” starts a new bounded check. Never replay the build merely because the wait timed out.
  - **.NET version trap:** dotnet/.NET Core is treated as CNB-capable, but the CNB version policy only allows .NET 8/9/10. A repo on a CNB-rejected version (e.g. .NET 7 → `dotnet version 7.0 is not allowed by cnb version policy`) that ships a usable Dockerfile MUST be created with `prefer_dockerfile_when_detected = true`, or its CNB build dead-ends with no in-place recovery.
- if build logs fail while downloading third-party build artifacts such as GitHub Release assets, native binary packages, image layers, or package-manager tarballs, classify the blocker as `external artifact unreachable` when the dominant evidence is network reachability rather than app source code
- examples include sharp/libvips release downloads, registry layer pulls, Docker Hub timeouts, package tarball download timeouts, or language installer binary downloads
- for `external artifact unreachable`, stop after one evidence-backed retry or mirror attempt; do not convert the component to a different delivery mode automatically

### Monorepo Build Context

For source-backed components in monorepos:
- preserve repository-root build context when the component Dockerfile or build command depends on root-level files such as `pyproject.toml`, `uv.lock`, `pnpm-lock.yaml`, `package-lock.json`, `bun.lock`, `go.work`, `settings.gradle`, or `pom.xml`
- use component subdirectory metadata only when it does not hide required root build files from the builder
- if the current Rainbond source interface cannot express the required build context safely, stop with a source/build handoff or manifest review instead of staging a local package silently

Read [../references/source-build-parameter-guide.md](../references/source-build-parameter-guide.md) for the current Rainbond Tool key list and minimal examples.

### SQL Initialization Assets

If the source repository ships SQL initialization files (`sql/*.sql`, `db/init/*.sql`, similar) and the database component is not a pre-baked image that auto-imports them:
- treat SQL initialization as a first-class delivery concern; do **not** wait for runtime errors like `Table 'X' doesn't exist` to surface it
- pick exactly one delivery path from [../references/sql-init-recipe.md](../references/sql-init-recipe.md) and stick to it
- the default path is Recipe A (Init-Job Component) when the application source is in a git repo reachable by the cluster
- do **not** use public file-sharing services, manual `kubectl exec`, or import containers without `depends_on` as workarounds
- do **not** silently choose local-package upload as the SQL transport; require explicit user opt-in
