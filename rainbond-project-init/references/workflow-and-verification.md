# Project initialization workflow and verification

Load this reference after identity and mode are resolved.

## Workflow

Follow this order.

1. Inspect local project state
- check whether `rainbond.app.json` exists
- check whether `.rainbond/local.json` exists
- check whether the project is already linked
- scope this inspection to the current project directory only
- do not run broad filesystem searches such as `find $HOME ...` to locate bindings from other repositories

2. Resolve or generate project baseline
- if `rainbond.app.json` exists, read it
- if missing, inspect the repo and generate a draft `rainbond.app.json`
- choose default executable v1 mode unless the user explicitly requests v2 draft mode
- if the repo clearly resolves to source-backed business code, keep that source-oriented baseline even when the user also supplied transport hints for image registries or Git mirrors

3. Resolve target project identity
- determine `team_name`, `region_name`, and `app_name`
- prefer explicit input, then manifest, then repository inference
- team / region selection follows hard rule 7 (smart default): use silently when single candidate or manifest match; ask only when genuinely ambiguous
- do not silently choose `default` as `team_name`

4. Resolve selected environment
- resolve selected environment using the Configuration Priority rules above
- never emit `local`, `default`, `binding`, or any other non-environment label as the selected environment
- if in doubt, use `preview`

5. Query Rainbond
- check whether an app with the resolved identity already exists
- if it exists, capture `app_id`
- if it does not exist, create it
- do not stop at "app missing"; missing app means initialization must continue into app creation

6. Write local binding
- create or update `.rainbond/local.json`
- if app existence and `app_id` were confirmed through the locked Rainbond transport, set `metadata.status = linked`
- if the locked Rainbond transport is unavailable and online verification cannot be completed, set `metadata.status = pending_verification`
- do not present the project as fully initialized until online verification succeeds

7. Build execution summary
- for each component, classify the immediate execution path using the Execution Summary Rules above
- report whether the current initialized project is immediately executable with the current bootstrap chain or still partially blocked
- if a component was inferred as source-backed, say so explicitly rather than silently presenting a fallback image path

8. Decide next action
- if the user asked only for initialization, stop after binding
- if the user asked to initialize and continue, hand off to `rainbond-fullstack-bootstrap`
- if this skill was entered by `rainbond-app-assistant` during a single-entry deployment or dev-to-test mainline run, treat that as initialize-and-continue rather than stop-after-init
- if the user intent is ambiguous, prefer stopping after initialization and state the next step explicitly

Hard rule:
- if `app_id` is still unknown, initialization is not complete
- if the locked Rainbond transport is unavailable and app existence cannot be verified online, initialization is only partially complete
- if initialization is not complete, do not hand off to `rainbond-fullstack-troubleshooter`
- `rainbond-fullstack-troubleshooter` is only valid after app creation and binding are complete
- if the user requested stop-after-init, do not hand off to `rainbond-fullstack-bootstrap`

## Verification Standard

Initialization is successful when:
- `rainbond.app.json` exists or has been generated
- the target Rainbond app exists
- `.rainbond/local.json` exists
- `app_id` is known
- selected environment is resolved to `preview` or `production`
- the project is now in a linked state
- an execution summary is available

If the locked Rainbond transport is unavailable:
- manifest generation or reuse may still complete
- a provisional `.rainbond/local.json` may still be written
- but initialization must be reported as pending online verification rather than fully complete

Initialization is not required to:
- create components
- deploy topology
- fix runtime problems
- verify frontend access

Those belong to downstream skills.

