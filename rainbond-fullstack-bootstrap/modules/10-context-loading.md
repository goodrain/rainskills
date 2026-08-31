# Context Loading

- Read when: you are starting any bootstrap run or need to resolve app identity, environment, component filters, or env layering.
- Do not read when: you only need to format the final answer after all execution decisions are already made.
- Depends on: [../SKILL.md](../SKILL.md), [../references/manifest-v1-reference.md](../references/manifest-v1-reference.md) for the full baseline example and enums.
- Produces: resolved environment, resolved app identity, merged env intent, filtered in-scope component set.

## Layer Priority

Resolve configuration by layer and by concern, not by whichever file is easiest to read first.

Shared file layers:
1. **Highest priority**: user explicit input for the current run
2. **Secret layer**: `.rainbond/secrets.preview.json` or `.rainbond/secrets.prod.json`
3. **Environment layer**: `.rainbond/env.preview.json` or `.rainbond/env.prod.json`
4. **Project binding context**: `.rainbond/local.json`
5. **Lowest priority**: `rainbond.app.json` as the project topology baseline

Backward compatibility:
- if `rainbond.app.json` is absent, legacy `rainbond.json` may be used as the same lowest-priority baseline tier
- legacy `rainbond.json` never overrides user input, environment overrides, or local binding context

## Interpret Each Source

- `rainbond.app.json`
  - repo-committed topology baseline for `project`, component list, image, port, `depends_on`, `access_mode`, and baseline non-sensitive env
- `.rainbond/secrets.<environment>.json`
  - local-only secret source for component env values that must not live in repo files
- `.rainbond/local.json`
  - bound project context for `team_name`, `region_name`, `app_name`, `app_id`, platform server, and `preferences.default_environment`
- `.rainbond/local.json.runtime_components`
  - optional local mapping cache from logical roles such as `web`, `api`, and `postgres` to existing runtime components; use it only as a reuse hint
- `.rainbond/env.<environment>.json`
  - environment-specific component env override intent from `component_env_overrides.<component_name>.env`
- user explicit input
  - may override any resolved value for the current run

## Field Resolution

Resolve fields using the highest applicable layer:

- Selected environment
  - user explicit input
  - `.rainbond/local.json.preferences.default_environment`
  - `preview`
- App identity and binding context
  - user explicit input
  - `.rainbond/local.json`
  - `rainbond.app.json.project`
- Component env values
  - user explicit input
  - `.rainbond/secrets.<environment>.json.component_secrets.<component_name>.env`
  - `.rainbond/env.<environment>.json.component_env_overrides.<component_name>.env`
  - `rainbond.app.json.components[*].env`
- Component topology, roles, ports, dependencies, and `access_mode`
  - user explicit input
  - `rainbond.app.json` or legacy `rainbond.json`

## Runtime Component Mapping

If `.rainbond/local.json.runtime_components` exists:
- use it to help match logical roles such as `web`, `api`, and `postgres` to already-existing runtime components
- use it to decide whether an existing runtime component should be reused instead of creating a duplicate
- do not trust it over current platform runtime facts

If `runtime_components` and current platform evidence disagree:
- trust current platform runtime facts
- report the drift
- continue using runtime components discovered through Rainbond Tools

## Execution Filter

When the run provides:
- `included_components`
- or `excluded_components`

apply bootstrap only to the resulting filtered component set.

Rules:
- `included_components` wins over `excluded_components`
- template-backed components may still appear in the manifest, but should be skipped from bootstrap execution
- skipped components must still be accounted for in output

## Resolution Workflow

Follow this order before asking the user for anything:

1. Collect any user-explicit identifiers, environment choice, component overrides, or env overrides.
2. Read `.rainbond/local.json` if present for bound `team_name`, `region_name`, `app_name`, `app_id`, platform server, and `preferences.default_environment`.
3. If `.rainbond/local.json.runtime_components` exists, load it as a reuse hint for later role-to-runtime matching.
4. Select the environment file with this order: user explicit input > `.rainbond/local.json.preferences.default_environment` > `preview`.
5. Read `.rainbond/secrets.<environment>.json` if present and extract component-level secret env values.
6. Read the selected `.rainbond/env.<environment>.json` if present and extract environment-layer component env overrides.
7. Read `rainbond.app.json`; if absent, read legacy `rainbond.json` as the same lowest-priority baseline tier.
8. Parse and validate `schema_version` for whichever baseline file is used.
9. Merge app identity, topology, and env intent using the rules above.
10. Apply `included_components` / `excluded_components` if present.

Ask the user only for values that are still missing after all configured layers are resolved.

If required secrets or required app identity are still missing after this process, stop according to [60-verification-and-handoffs.md](60-verification-and-handoffs.md).

## Reference Boundary

Read [../references/manifest-v1-reference.md](../references/manifest-v1-reference.md) only when you need:
- the baseline manifest example
- role-type reminders
- frontend `access_mode` enum details
- the v1-to-v2 source mapping summary

Do not duplicate that reference material into the final reply.

## Context Budget

The file list above (manifest, local binding, env, secrets) is the **canonical configuration set** for bootstrap. When the run also needs to understand the project repository itself (build topology, runtime constraints, init assets), keep first-pass exploration narrow and expand only with cause.

### Intent

Goal of the first pass: build a minimal project picture sufficient to decide build kind, runtime ports, log/data volume requirements, and external dependencies — without listing every file in the repo and without scanning user-level state.

### Allowed first-pass reads

Read project entrypoint manifests when present, regardless of language:
- package manifest (e.g., `package.json`, `pom.xml`, `pyproject.toml`, `go.mod`, `Cargo.toml`, `composer.json`, `Gemfile`, `pubspec.yaml`, `*.csproj`)
- build/container definition (`Dockerfile`, `docker-compose.y*ml`, `Makefile`, `build.gradle*`, `.cnb.yml`)
- runtime config that exposes ports / log paths / data paths (`application*.yml`, `application*.properties`, `logback*.xml`, `nginx*.conf`, `vite.config.*`, `vue.config.js`, `next.config.*`)
- data initialization assets (`sql/`, `db/init/`, `migrations/`, `docker-entrypoint-initdb.d/`)
- top-level `README*`

The list above is not exhaustive; the principle is "files that declare project shape," not "every file in the repo."

### Forbidden reads

Regardless of how curious the model is about the environment:

- user-level home directories as a whole (`~/.codex`, `~/.claude`, `~/.rainbond`, `~/.cache`, etc.). Only the protected `~/.rainbond/rainskills/single-runtime-v1.json` may be read by the configured CLI runtime.
- repository-root file enumeration: `rg --files`, `find . -type f`, `ls -R`, `tree`, or any equivalent that returns "every path in the repo." If the goal is to find a specific kind of file, search by content or name pattern, not by listing everything.
- following arbitrary public web pages on transport failure. If a `curl` / package-download / upload-helper request returns a redirect or HTML error page, capture the status code and the first short prefix of the body for diagnosis; do not follow into a full third-party site render.
- re-reading the same Rainbond Tool schema, the same skill file, or the same reference document a second time within the run. If the information is needed again, recall the prior read.

### Expansion conditions

Only expand beyond first-pass reads when one of the following holds:

- after first-pass reads, the project shape is still ambiguous on a specific dimension (build kind, port, init step) and the next decision depends on resolving it
- a downstream step explicitly points at a particular file or directory
- the user's question references a specific file, error, or path
- a build/runtime log surfaces a concrete symbol/path that needs source-level grounding

Expansion form:
- prefer content search with a concrete query (`rg "<keyword>" --type <lang>`) over file enumeration
- prefer named reads (`Read <known path>`) over directory listing
- record in `actions_performed[].details` why the expansion was needed when it materially affected the decision

### When uncertain

If you find yourself about to "scan everything just to be safe," stop and ask: which decision does the next read enable? If you cannot name the decision, the read is not yet justified — wait for the decision to surface, then read for it specifically.
