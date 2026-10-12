# Delivery verification workflow

## Workflow

Follow this order.

### Fixed Tool fast path

Call `rainbond_get_app_detail`, then `rainbond_get_app_health_overview` before per-component inspection. Use `rainbond_query_components` and component/storage summaries only for abnormal or unknown components. Do not run `list` or `describe` to discover these known Tool names.

1. Resolve app context
- determine `team_name`, `region_name`, `app_name`, and `app_id`
- prefer user input, then `.rainbond/local.json`

2. Read deployment state
- get app detail
- get component list
- get component summaries

3. Classify component convergence
For each important component, classify:
- `building`
- `waiting`
- `running`
- `abnormal`
- `capacity-blocked`

If recent events show:
- `Unschedulable`
- CPU or memory shortage

then classify that component as `capacity-blocked`.

4. Inspect stateful storage
- identify database and stateful middleware components from role, name, image, port, and dependency position
- read storage summaries for those components
- record whether durable storage is mounted at the component's data directory
- carry any missing-persistence finding into the final delivery report

5. Determine access target
Access URL selection priority:
1. frontend component access info
2. explicitly exposed service access info
3. component detail access info
4. if none exist, report “no external access URL available”

When reverse-proxy full-stack behavior is expected:
- keep the preferred root URL as the candidate user-facing URL
- also derive an API verification path on the same host, usually `/api`
- do not switch to the backend component's direct URL as the preferred user-facing URL unless the app is actually backend-only

6. Verify user-facing path as far as safely possible
- if an access URL is available, run the bounded adapter; never inspect it with a free-form HTTP or browser fallback
- if reverse-proxy full-stack behavior is expected, run separate bounded probes for both the root path and the same-host API path
- if the root path returns HTML but the API path fails, returns a provider intercept page, or routes to the wrong upstream, treat delivery as not complete
- for static frontends, use bounded GET probes for the entry document, one representative static asset, and one deep-link path; evaluate returned MIME and bounded metadata without retaining the response body
- if the adapter is unavailable, rejects the URL, times out, reaches the body limit, or requires cross-host validation, do not fake success
- report the final delivery outcome as `delivered-but-needs-manual-validation`
- when the app serves a built frontend, run the static frontend checklist from
  Verification Principle 6 as far as the current environment allows, and record
  unverifiable items as manual-confirmation leftovers

7. Produce final delivery report

## Final Status Model

Use one of these final outcomes:

- `delivered`
  - all critical components converged
  - user-facing access path is verified

- `delivered-but-needs-manual-validation`
  - app appears converged
  - access URL is known
  - but external user path was not directly verified

- `partially-delivered`
  - topology exists
  - some components running
  - but one or more critical components are still building, waiting, or abnormal

- `blocked`
  - cluster capacity blocked
  - build failed
  - external artifact or registry download remains unreachable
  - runtime remains unhealthy
  - no usable access path exists
  - root path and same-host API path do not both work for a reverse-proxy full-stack app
