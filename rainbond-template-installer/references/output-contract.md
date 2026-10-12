# Template installer output contract

## Output Format

Target structured output（仅在用户或自动化/评测明确要求结构化结果时使用）：

- this skill should eventually be able to emit `TemplateInstallResult`
- minimum target fields:
  - `template_install_intent`
  - `install_status`
  - `services_summary`
  - `next_action`
- the human-readable sections below should be treated as the narrative view over that target object
- in explicit structured contract mode, append a final `### Structured Output` section after the human-readable report and render `TemplateInstallResult` in fenced `yaml`

Proposed schema:

```yaml
TemplateInstallResult:
  template_install_intent:
    source: local | cloud
    market_name: string | null
    app_model_id: string
    app_model_version: string
    version_selection_reason: user_choice | single_version | latest_stable
    target_app:
      team_name: string
      region_name: string
      app_id: positive integer
      app_reused: boolean
  install_status: pending | success | failed
  services_summary: string[]
  next_action: stop | review_installed_services | run_troubleshooter | resolve_missing_template_metadata
```

Example object:

```yaml
TemplateInstallResult:
  template_install_intent:
    source: cloud
    market_name: official-market
    app_model_id: model-123
    app_model_version: 1.0.3
    version_selection_reason: latest_stable
    target_app:
      team_name: rainbond-demo
      region_name: singapore
      app_id: 88
      app_reused: true
  install_status: success
  services_summary:
    - postgres
    - api
    - web
  next_action: run_troubleshooter
```

Example final reply:

````markdown
### Template Source
Installation source is `cloud`, `market_name` is `official-market`.

### Resolved Template
`app_model_id` model-123, `app_model_version` 1.0.3, version selection reason `latest_stable`.

### Target App
`team_name` rainbond-demo, `region_name` singapore, `app_id` 88, target app was reused.

### Install Result
Install succeeded. Installed services: `postgres`, `api`, `web`.

### Next Step
run troubleshooter

### Structured Output
```yaml
TemplateInstallResult:
  template_install_intent:
    source: cloud
    market_name: official-market
    app_model_id: model-123
    app_model_version: 1.0.3
    version_selection_reason: latest_stable
    target_app:
      team_name: rainbond-demo
      region_name: singapore
      app_id: 88
      app_reused: true
  install_status: success
  services_summary:
    - postgres
    - api
    - web
  next_action: run_troubleshooter
```
````

Only in explicit structured contract mode, respond using exactly these sections:

### Template Source
- state whether installation is from `local` or `cloud`
- include `market_name` when relevant

### Resolved Template
- state `app_model_id`
- state `app_model_version`
- state how the version was chosen

### Target App
- state `team_name`
- state `region_name`
- state `app_id`
- state whether the app was reused or created

### Install Result
- state whether install succeeded
- include `installed` or equivalent result
- summarize installed services if available

### Next Step
- one of:
  - `stop, install complete`
  - `review installed services`
  - `run troubleshooter`
  - `resolve missing template metadata`

### Structured Output
- append a fenced `yaml` block
- render `TemplateInstallResult`
- keep enum values and field names aligned with the schema above
- include `app_reused` and template version resolution details when known

## Common Mistakes

- using `rainbond_install_app_by_market` when the newer template-install chain is available
- installing without checking versions first
- forgetting `market_name` for cloud templates
- creating a target app but then not reusing its `app_id`
- passing `k8s_app` by default
- treating template installation as the same thing as component bootstrap
- on app-name collision, silently picking an unrelated existing app from the
  team list (e.g. requested `pinpoint-apm` exists → assistant installs into
  `big-screen-vue-datav` instead). This violates user intent and must never
  happen — auto-retry with suffix instead. See the collision handling rules above.
- on app-name collision, immediately pausing to ask the user which of 4 options
  they want. This is also wrong — silent retry with `-2/-3/-4` and a clear
  rename notice in the report is the default; only pause after 3 suffix
  attempts all collide.

## Quick Reference

Cloud flow:
1. query cloud markets
2. query cloud app models
3. query versions
4. create app if needed
5. install

Local flow:
1. query local app models
2. query versions
3. create app if needed
4. install

Current install MCP:
- `rainbond_install_app_model`
