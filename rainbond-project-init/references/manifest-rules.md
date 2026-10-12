# Project initialization and manifest rules

## Contents

- Use and scope
- Manifest output modes
- Delivery source handling
- Execution summaries and initialization modes
- Configuration priority
- Repository and source inference
- Generated manifest rules
- Local binding rules

## When to Use

Use when:
- a local project should be connected to Rainbond for the first time
- `.rainbond/local.json` does not exist
- `rainbond.app.json` may not exist yet
- the user wants to bring a brand-new local project into Rainbond
- the next step is unclear because the project has not been onboarded yet

Do not use when:
- the project is already linked and the user wants routine deploy or repair operations
- the topology already exists and only runtime troubleshooting is needed
- the task is to repair code or build artifacts
- the user explicitly wants only environment sync, bootstrap, or troubleshooting

## Scope

This skill may:
- inspect the local repository structure
- read project files such as:
  - `package.json`
  - `Dockerfile`
  - `docker-compose.yml`
  - `README.md`
  - `frontend/`
  - `backend/`
- infer likely component roles
- infer likely component delivery sources
- generate a first-draft `rainbond.app.json`
- query Rainbond for existing app matches
- create a new Rainbond app if needed
- write `.rainbond/local.json`
- optionally hand off immediately to `rainbond-fullstack-bootstrap`

This skill must not:
- scan outside the current project directory for `rainbond.app.json`, `.rainbond/local.json`, or other binding files
- search the user's home directory to locate other Rainbond projects or bindings
- deeply troubleshoot runtime failures
- modify application source code
- repair frontend build or reverse-proxy issues
- store secrets in project config
- guess destructive actions

## Manifest Output Modes

### Default mode: executable v1 manifest
By default, when generating `rainbond.app.json`, produce a manifest that the current validated execution chain can consume immediately.

This means:
- `schema_version: 1`
- top-level `image` for image-backed components
- top-level source execution inputs for source-backed components when they can already be mapped safely
- `env` as an object map
- roles and fields compatible with `rainbond-fullstack-bootstrap`

Use this mode unless the user explicitly asks for a v2 draft.

### Optional mode: v2 draft manifest
If the user explicitly asks for a v2 draft, architecture draft, or multi-source manifest:
- generate `schema_version: 2`
- allow per-component `source.kind`
- prefer `image` and `source`
- allow `template` when the manifest carries executable install metadata or a curated mapping resolves it

When generating a v2 draft:
- clearly state it is a design-layer manifest
- do not imply the current bootstrap skill will execute every source kind directly
- if needed, recommend converting the v2 draft into a current executable plan

## Delivery Source Handling

This skill may internally infer whether a component is best understood as:
- image-based
- source-oriented
- template-like infrastructure

However, for the current validated workflow, the generated `rainbond.app.json` must default to a **bootstrap-compatible schema v1**:
- `schema_version: 1`
- component image stored at top-level `image` for image-backed components
- source-backed components may instead use top-level executable source fields when they are safely inferable:
  - `code_from`
  - `git_url`
  - `code_version`
  - `subdirectories`
- component env stored as an object map
- no `source.kind` block by default

If the repository strongly suggests a template workflow, preserve it as a template handoff. Never convert it into a bootstrap component merely to keep one execution path.

Current execution support:
- `image`: supported
- `source`: supported at the design layer and intended to map to Rainbond source-creation flow
- `template`: supported when template install metadata is complete enough to drive the current platform install flow

## Execution Summary Rules

After resolving or generating a manifest, produce an execution summary for each component.

The execution summary should classify each component into:
- `execution_mode`
- `status`
- `blocking_reason` if needed

### Execution modes
- `image`
- `source`
- `template`
- `blocked`

### Status values
- `ready`
- `needs_confirmation`
- `blocked`

### Current mapping rules

#### `image`
Use when the component has a stable top-level `image` value.

Result:
- `execution_mode = image`
- `status = ready` only when the image reference is concrete and there is no known missing prerequisite for execution
- otherwise `needs_confirmation`

Typical reasons for `needs_confirmation` even with `execution_mode = image`:
- image existence in the target registry is not yet verified
- a required startup secret is known to be missing
- a required bootstrap env source is still unresolved

#### `source`
Use when the component is clearly business code and there is enough Git information to map it into a source creation flow.

Result:
- `execution_mode = source`
- `status = ready` if repo source is complete and `code_from` can be determined safely
- otherwise `needs_confirmation`

#### `template`
Use when the resolved execution path is template-backed, including default mode when explicit template metadata or a curated middleware mapping makes template the preferred execution strategy.

Current rule:
- `template` is a valid schema concept
- template execution is supported only when install metadata is complete
- required fields depend on template source:
  - `install.source` must be `local` or `cloud`
  - `install.app_model_id` is required
  - `install.app_model_version` is required
  - `install.market_name` is required when `install.source = cloud`

Result:
- `execution_mode = template`
- `status = ready` if template install metadata is complete
- otherwise `needs_confirmation`
- if a template source is chosen but mandatory install metadata is missing, include a `blocking_reason`

#### `blocked`
Use when execution cannot safely continue with the current information.

Examples:
- required Git source metadata is missing
- team or region is still unknown
- template execution was chosen but required install metadata could not be resolved safely

## Initialization Modes

### Mode A: Manifest exists
If `rainbond.app.json` exists:
- use it as the project topology baseline
- do not regenerate it
- proceed directly to link / create app / write local binding

### Mode B: Manifest missing
If `rainbond.app.json` does not exist:
- inspect the repository
- infer a draft topology
- generate a first-draft manifest in the requested output mode
- ask for minimal confirmation only if critical fields remain ambiguous
- then proceed to linking

## Configuration Priority

During initialization, resolve values in this order:

1. **Highest priority**: user explicit input
2. existing `.rainbond/local.json` if present
3. existing `rainbond.app.json` if present
4. repository inference from source tree and config files

Rules:
- if `rainbond.app.json` exists, prefer it over repository inference
- if `.rainbond/local.json` exists and is linked, do not recreate linking blindly
- if platform runtime facts later conflict with inferred topology, the inferred draft should be corrected
- selected environment may only be `preview` or `production`
- resolve selected environment in this order:
  - user explicit input
  - `.rainbond/local.json.preferences.default_environment`
  - default `preview`
- if the resolved value is anything other than `preview` or `production`, fall back to `preview`
- if `team_name` is not explicitly provided and no manifest value exists, query available teams first
- team selection follows hard rule 7 (smart default):
  - single accessible team → use silently
  - multiple accessible teams + manifest `team_name` matches one of them → use silently, mention `已选 team = X（来自 manifest）` in the report
  - multiple accessible teams, no manifest hint → ask the user directly; do not fall through to `default` / first / any existing team
- never silently invent `team_name`; if it cannot be resolved from explicit input, manifest, or a single unambiguous platform result, ask the user directly
- `team_name = default` is allowed only when it came from explicit user input or explicit user confirmation
