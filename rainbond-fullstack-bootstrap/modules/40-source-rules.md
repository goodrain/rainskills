# Source rules

- Read when: any in-scope component resolves to `source` or `package`, or when build-parameter tuning is under discussion.
- Do not read when: all components are image-backed and no source/package routing is needed.
- Depends on: [../SKILL.md](../SKILL.md), [10-context-loading.md](10-context-loading.md), [30-creation-rules.md](30-creation-rules.md), [../references/source-build-parameter-guide.md](../references/source-build-parameter-guide.md).
- Proxy behavior always defers to **Always-on Guardrail 7** in the entrypoint; this module must not define another mirror policy.
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

### GitHub transport proxy

Apply `../SKILL.md` **Always-on Guardrail 7** exactly; it is the only proxy policy.

- A raw `https://github.com/...` source URL uses the canonical `https://ghfast.top/<full-original-url>` mapping automatically.
- Preserve a user-supplied proxy verbatim, preserve already-mirrored URLs, and honor an explicit raw-URL opt-out for the remainder of the run.
- Do not invent or offer alternate GitHub proxy hosts. On a proxied-source failure, report the observed failure and ask whether to retry the original URL.

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
- the existing source-failure handling in [convergence rules](55-convergence-rules.md) (read events, read build log, classify blocker) still applies; this section only governs which tool to call when retry is justified

**CNB/Dockerfile recovery:** use `rainbond_get_component_check_result` with `prefer_dockerfile_when_detected=true` for a `checking`/`checked` component. Console persists and applies that preference while `create_status` is not `complete`; inspect the returned Dockerfile evidence before continuing. A `complete` CNB component has no general in-place build-mode switch. Only after recording its topology/configuration snapshot, showing `create_status=complete`, and receiving explicit user confirmation may the workflow delete and recreate it with `prefer_dockerfile_when_detected=true`, then restore ports, envs, dependencies, and storage. Missing status evidence or confirmation is a read-only stop condition.

### Multi-service Source Ambiguity

If source detection reports `multiple services detected` or equivalent multi-component ambiguity:
- stop the current bootstrap path immediately
- report that the repository requires an explicit component-selection strategy
- do **not** automatically switch the component from source to local package
- do **not** automatically build jars locally, upload artifacts manually, or install middleware templates as a workaround
- only continue on a package-backed or manually selected path after the user explicitly confirms that strategy
