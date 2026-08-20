# Project Init output contract

## Contents

- InitResult fields
- Human-readable response sections
- Structured output consistency
- Examples

## Output Format

Structured output contract:

- this skill must emit `ProjectInitResult`
- minimum target fields:
  - `project`
  - `environment`
  - `component_sources`
  - `init_status`
  - `next_action`
- the human-readable sections below are the narrative view over that object
- the reply must end with a final `### Structured Output` section
- the `### Structured Output` section must render `ProjectInitResult` in fenced `yaml`
- the literal shape of the final section must be:
  - line 1: `### Structured Output`
  - line 2: ````yaml`
  - middle: `ProjectInitResult: ...`
  - final line: ````
- omitting the final structured block, changing its object name, or placing later prose after it is a contract failure
- this contract still applies when the result is `pending_verification` or `blocked`
- do not create sidecar result artifacts such as `.rainbond/init.result.json` as a substitute for the final reply contract; current-run status must be expressed in the prose sections and `ProjectInitResult`

Proposed schema:

```yaml
ProjectInitResult:
  project:
    identity:
      team_name: string
      region_name: string
      app_name: string
      app_id: positive integer | null
    binding_source: manifest | local_binding | inferred
  environment:
    name: preview | production
    selection_source: explicit | local_preference | default
  component_sources:
    - name: string
      role: frontend | service | database | cache | other
      execution_mode: image | source | template | blocked
      status: ready | needs_confirmation | blocked
      blocking_reason: string | null
  init_status: linked | pending_verification | blocked
  next_action: stop | bootstrap | reconnect_transport | ask_identity | ask_manifest_review
```

Construction rules:

- `project.identity`
  - comes from the resolved current-run identity
  - prefer explicit input, then valid local binding, then manifest, then conservative inference
- `project.binding_source`
  - use `local_binding` when reused `.rainbond/local.json` is the dominant resolved source
  - use `manifest` when existing manifest data is the dominant resolved source and local binding was not the primary driver
  - use `inferred` when repo inspection or manifest generation supplied the dominant baseline
  - if `rainbond.app.json` was generated in the current run, prefer `inferred` rather than `manifest`, even when the generated manifest is then written to disk
- file action reporting
  - determine `reused`, `created`, and `updated` from the pre-run baseline versus the end-of-run result, not from the final filesystem snapshot alone
  - if `rainbond.app.json` was absent at run start and exists at run end, report it as generated/created in both `Init Result` and `Files Created Or Updated`
  - if `.rainbond/local.json` existed at run start and only status/timestamps changed, report it as updated rather than reused
- `environment.name`
  - must be `preview` or `production`
- `environment.selection_source`
  - use `explicit` when the user provided the environment
  - use `local_preference` when `.rainbond/local.json.preferences.default_environment` supplied it
  - otherwise use `default`
- `component_sources`
  - must contain one entry per component listed in the execution summary
  - must reuse the same `execution_mode`, `status`, and `blocking_reason` semantics as the prose summary
  - use canonical status spelling: `ready`, `needs_confirmation`, `blocked`
- `init_status`
  - use `linked` only when current-run platform verification confirmed the app/binding
  - use `pending_verification` when local binding or generated state exists but current-run platform verification did not complete
  - use `blocked` when identity or other critical preconditions remain unresolved
- `next_action`
  - must be the normalized form of the prose `Next Step`
  - must represent exactly one decision for the current run, not multiple possible downstream branches
  - use `stop` when the current run intentionally ends at the init boundary, including user-requested stop-after-init
  - when the user asked only for initialization, reuse, or status/result reporting, treat that as stop-at-init unless they explicitly asked to continue
  - use `bootstrap` only when the current run is expected to continue directly into `rainbond-fullstack-bootstrap`
  - use `reconnect_transport`, `ask_identity`, or `ask_manifest_review` only when that specific external action is the true gating step
- `runtime_components`
  - may be written into `.rainbond/local.json` as a reuse hint, but it does not belong inside `ProjectInitResult`

Consistency rules:

- prose and `ProjectInitResult` must agree on app identity, selected environment, component count, and next step
- if prose says online verification was not performed in the current run, `init_status` must not be `linked`
- a newly generated manifest may still pair with an already-existing Rainbond app; do not force `binding_source = local_binding` only because the app already existed
- `.rainbond/local.json.runtime_components` is a reuse hint, not topology truth
- logical role names and runtime component names may differ; record the drift as reusable context instead of treating it as an automatic failure
- if multiple accessible teams existed in the current run and no explicit team choice was obtained, `init_status` must not be `linked`
- if a field is unknown but applicable, prefer `null` over invention
- never place secret values in the structured object

Example object:

```json
{
  "project": {
    "identity": {
      "team_name": "demo-team",
      "region_name": "cn-north-1",
      "app_name": "shopping-cart",
      "app_id": 7321
    },
    "binding_source": "local_binding"
  },
  "environment": {
    "name": "preview",
    "selection_source": "default"
  },
  "component_sources": [
    {
      "name": "api",
      "role": "service",
      "execution_mode": "image",
      "status": "ready",
      "blocking_reason": null
    },
    {
      "name": "frontend",
      "role": "frontend",
      "execution_mode": "source",
      "status": "needs_confirmation",
      "blocking_reason": "missing git_url in manifest"
    }
  ],
  "init_status": "linked",
  "next_action": "bootstrap"
}
```

Example final reply:

````markdown
### Init Result
Initialization succeeded with a freshly inferred manifest; the missing `rainbond.app.json` was generated and the Rainbond app was created through the locked Rainbond transport, so the project is now linked and ready for bootstrap.

### Resolved Project
App `storefront`, environment `preview`.

### Files Created Or Updated
`rainbond.app.json` (created from repository inference), `.rainbond/local.json` (created with verified binding metadata, status `linked`).

### Execution Summary
- Component `api`: `execution_mode` image, `status` ready, blocking reason none.
- Component `frontend`: `execution_mode` source, `status` needs_confirmation, blocking reason “git_url inferred from remote needs user confirmation”.
- Component `postgres`: `execution_mode` image, `status` needs_confirmation, blocking reason “startup password TBD; no secure source yet”.

### Open Questions
Need explicit confirmation that the inferred git_url is the correct code source for `frontend`; postgresql password source remains unspecified.

### Next Step
run rainbond-fullstack-bootstrap

### Structured Output
```yaml
ProjectInitResult:
  project:
    identity:
      team_name: demo-team
      region_name: us-west-2
      app_name: storefront
      app_id: 9123
    binding_source: inferred
  environment:
    name: preview
    selection_source: default
  component_sources:
    - name: api
      role: service
      execution_mode: image
      status: ready
      blocking_reason: null
    - name: frontend
      role: frontend
      execution_mode: source
      status: needs_confirmation
      blocking_reason: git_url inference needs confirmation
    - name: postgres
      role: database
      execution_mode: image
      status: needs_confirmation
      blocking_reason: database password source missing
  init_status: linked
  next_action: bootstrap
```
````

Always respond using exactly these sections:

### Init Result
- state whether the project was initialized successfully
- state whether the manifest was reused or generated
- state whether the Rainbond app was reused or created
- if the locked Rainbond transport was unavailable, explicitly say initialization is pending online verification
- describe manifest/app/file actions from what happened in the current run, not merely from what exists by the time the reply is written

### Resolved Project
- state `app_name`
- state `selected environment`
- do not include `team_name`, `region_name`, or `app_id` in this section; those are available in `### Structured Output` only

### Files Created Or Updated
- list:
  - `rainbond.app.json`
  - `.rainbond/local.json`
- these two files must always be reported in this section, even when additional local helper files were created
- optional `.rainbond/env.<env>.json` or `.rainbond/secrets.<env>.json` files may be mentioned only when they were actually created or updated, but they do not replace the required pair above
- state whether each file was reused, created, or updated
- decide reused/created/updated from file state before the run versus after the run; do not call a newly generated file "reused" just because it now exists
- if `.rainbond/local.json` was written without platform verification, state that its status is `pending_verification`
- do not introduce additional result-carrier files just to store current-run init status

### Execution Summary
- list each component
- state:
  - `execution_mode`
  - `status`
  - `blocking_reason` if any
- make it clear which components are immediately executable by the current validated workflow
- use `ready` only for components that can be executed immediately with currently available inputs
- use `needs_confirmation` when execution probably works but still depends on a missing confirmation such as image availability or secret source

### Open Questions
- list any remaining ambiguity
- if none, say `none`
- if a database component was generated without a safe bootstrap secret source, explicitly record that as an open question
- if a v2 draft uses `template` but required install metadata is incomplete, explicitly list the missing fields as open questions

### Next Step
- one of:
  - `run rainbond-fullstack-bootstrap`
  - `stop, initialization complete`
  - `reconnect Rainbond transport and verify app existence`
  - `stop, initialization pending online verification`
  - `ask user to confirm missing identity`
  - `ask user to review generated manifest`
  - never `run rainbond-fullstack-troubleshooter` while app creation or local binding is incomplete
- choose exactly one line for the current run; do not present alternative downstream branches in this section
- if the user explicitly requested initialization only and init reached a stable boundary, use `stop, initialization complete`
- if the user asked to reuse existing config and report the result, that is still initialization-only and should end with `stop, initialization complete`
- if the user requested initialize-and-continue, use `run rainbond-fullstack-bootstrap`

### Structured Output
- append a fenced `yaml` block as the final section
- render `ProjectInitResult`
- keep enum values and field names aligned with the schema above
- do not place any prose after this section
- do not duplicate secrets or invent missing values
- when the locked Rainbond transport is unavailable or identity is blocked, still use the same required section headings and final `ProjectInitResult`; only field values change
- bare YAML under `### Structured Output` is a contract failure; the object must appear inside fenced markdown code block with `yaml`
- the opening fence must be exactly ````yaml` immediately after the heading
- the closing fence must be the last non-whitespace line of the whole reply
- emit the backticks literally; do not paraphrase, omit, or replace the fenced block with plain indented YAML
- use this exact final tail shape:
  - `### Structured Output`
  - ````yaml`
  - `ProjectInitResult:`
  - `...`
  - ````

