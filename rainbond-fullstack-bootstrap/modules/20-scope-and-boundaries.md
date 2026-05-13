# Scope and Boundaries

- Read when: you need to decide whether bootstrap is the right stage, what kinds of components are executable here, or what actions are allowed.
- Do not read when: you already know the task is in-scope and only need source/package specifics or final output formatting.
- Depends on: [../SKILL.md](../SKILL.md), [10-context-loading.md](10-context-loading.md), [../references/manifest-v1-reference.md](../references/manifest-v1-reference.md).
- Produces: in-scope component set, allowed/disallowed action boundary, expected input checklist.

## Manifest-driven Components

Bootstrap consumes components defined in the manifest baseline with fields such as:
- `name`
- `role`
- `image`
- `port`
- `port_alias`
- `env`
- `connection_envs`
- `depends_on`
- `access_mode`
- `source`

For the full baseline example and enum reference, read [../references/manifest-v1-reference.md](../references/manifest-v1-reference.md) on demand.

## Supported Delivery Modes

This skill currently supports executable components from:
- `image`
- `source`
- `package`

This skill does **not** install `template` components directly.

If a component is template-backed:
- skip it in bootstrap
- record it in structured output as skipped
- report that it must be handled by `rainbond-template-installer`

## Expected Inputs

When no config file is available, expect:
- `team_name`
- `region_name`
- `app_name`
- component list with the relevant image, source, or package definitions

The old shorthand example still applies for simple image-backed bootstraps:
- `web_image`
- `api_image`
- `db_image`

## Optional Inputs

Optional but commonly useful inputs:
- `db_name`
- `db_user`
- `db_password`
- local secret file for the selected environment
- image registry credentials at runtime only
- `included_components`
- `excluded_components`

Do not persist registry credentials or secret values in this skill’s output.

## Allowed Actions

Bootstrap may:
- create or locate the app
- create or locate components from manifest
- create components from image definitions
- create components from source definitions
- create components from local package files or directories
- configure minimum ports
- configure provider component connection envs
- create or reuse durable storage for stateful middleware components when the data directory is known
- add minimum dependency wiring
- add only the minimum startup env needed for database bootstrap
- deploy or restart affected components
- inspect app detail, component summary, logs, and monitor data

## Disallowed Actions

Bootstrap must not:
- delete the app
- delete components
- clear database state
- modify source code
- perform speculative deep fixes
- continue repeated repair attempts after setup is complete
- execute template installation directly
- silently switch delivery mode when the current path is blocked

## Boundary Summary

Use bootstrap to get the topology into a minimally valid, inspectable state.

Do not use bootstrap to:
- debug frontend access-path issues end to end
- repair reverse-proxy or build-time frontend configuration
- repair application code or build scripts
- keep patching env incompatibilities after the first deeper runtime issue is clear

Those follow-up stages belong to:
- `rainbond-fullstack-troubleshooter`
- `rainbond-delivery-verifier`
- or `code_build_handoff`, depending on the dominant blocker
