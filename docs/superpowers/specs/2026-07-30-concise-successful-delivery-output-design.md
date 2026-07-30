# Concise Successful Delivery Output Design

## Goal

Make a successful RainSkills deployment result immediately useful to a normal user. The response must lead with the deployment outcome and provide two distinct clickable links:

- the Rainbond Console location where the deployed app is managed
- the real public address where the deployed service is accessed

Internal orchestration details remain available for automation and debugging, but are hidden from the default successful-delivery response.

## User-Facing Result

For a successful source application deployment, including the case where the runtime is healthy but the current agent cannot independently open the public domain, use this shape:

```markdown
### Deployment Result

Deployed successfully.

- Rainbond app: [Open in Rainbond](<deployment_location_url>)
- Service URL: [Open application](<preferred_access_url>)

### Runtime Status

- `web`: running
- HTTP check: 200 OK

The service is healthy. Open the service URL once to confirm browser interaction.
```

The actual reply should use concise Chinese labels. The English example above only defines the information structure.

## Required Information

The default successful-delivery response must include:

1. A clear success state. If only browser-side validation remains, render `部署成功，待浏览器访问确认` rather than downgrading the deployment to a failure or blocker.
2. A clickable Rainbond app-management URL.
3. A clickable public service URL returned by Rainbond gateway evidence.
4. The minimum useful runtime summary, such as the user-facing component state and the HTTP result already verified.
5. At most one short validation note when the current environment cannot resolve or open the public URL.

Do not include by default:

- `AppAssistantResult` YAML
- orchestration state or internal enum names
- lower-level skill execution logs
- `Blocking Issue: none`
- local file update details
- MIME, cache, proxy, or production-readiness notes unless they affect successful use

## Deployment Location URL

Build the Rainbond management URL only when the Console base URL, team name, region name, and app ID are all known:

```text
<console_base>/#/team/<team_name>/region/<region_name>/apps/<app_id>/overview
```

Rules:

- obtain `console_base` from the configured `RAINBOND_URL` or equivalent trusted session context
- remove a trailing slash from `console_base` before joining the route
- URL-encode each route segment
- never infer a Console host from the public service host
- if any required value is missing, show the known app identity instead of fabricating a URL

Example:

```text
https://run.rainbond.com/#/team/aw9qu6gd/region/rainbond/apps/3283/overview
```

## Public Service URL

The service URL must come verbatim from the Rainbond gateway/access evidence, normally `rainbond_get_component_summary.access_infos` through `preferred_access_url`.

Do not construct the service URL from team, component, port, domain conventions, or the Console URL. If no real public URL was returned, do not claim a fully usable public delivery address.

## Presentation Modes

Use the concise successful-delivery mode when all runtime components required by the application are healthy, no Rainbond-side blocker remains, and a real service URL exists. This includes `delivered-but-needs-manual-validation` when manual validation is required only because the agent environment cannot access the public domain.

Use structured contract mode only when:

- the user explicitly requests YAML, JSON, debug, or machine-readable output
- an eval or automation consumer explicitly requires the internal object
- deployment is incomplete, blocked, or requires code/build handoff
- promotion or another downstream machine workflow consumes the result

Manual browser confirmation alone must not expose structured contract output to a normal user.

## Internal Contract

Keep producing `AppAssistantResult` internally. Add `project.deployment_location_url` as a nullable derived field so validators and downstream automation can distinguish the management location from `delivery_state.preferred_access_url`.

For a runtime-healthy manual-validation result:

- retain `delivery_state.status = delivered-but-needs-manual-validation`
- retain `delivery_state.verification_mode = manual_validation_needed` or `inferred`
- use an orchestration state that reflects manual URL validation rather than the stale `linked-and-needs-delivery-verification`
- keep `next_action = stop and validate URL manually` internally
- render the user-facing result as successful with one validation note

## Validation

Update the existing manual-validation eval so the response is concise and contains both URLs. Add validator coverage requiring:

- a valid `deployment_location_url` when all location inputs are available
- `preferred_access_url` to remain present for successful or manual-validation delivery
- no structured YAML in the default manual-validation response
- no internal state labels in the default successful response

Run the app-assistant evaluations, schema validation, and the repository test suite after implementation.
