# Project Init operational reference

Load this reference only when reviewing routing mistakes or a completed initialization result.

## Common Mistakes

- treating first-time init as the same as day-2 app operations
- skipping manifest generation when no baseline exists
- writing secrets into local project files
- generating a manifest schema that the current bootstrap skill cannot consume
- dropping docker-compose database volume intent during manifest generation
- narrowing a monorepo component to a child directory when its build depends on root-level lockfiles or project metadata
- starting local Docker/OrbStack or pushing temporary images as an implicit fallback
- silently generating v2-only source structures when the user asked for an immediately executable manifest
- omitting the execution summary, leaving users unable to tell which components can actually run now
- omitting the required `### Structured Output` section
- emitting bare YAML instead of fenced `yaml` under `### Structured Output`
- omitting either the opening ````yaml` fence or the final closing fence
- generating `binding_source: manifest` when the manifest itself was newly generated from repo inference in the current run
- reporting a file as reused simply because it exists at reply time, even though it was created during the current run
- writing `.rainbond/init.result.json` or a similar sidecar result file instead of emitting the required final `ProjectInitResult`
- replacing the required section headings with freeform narrative when the result is `pending_verification` or `blocked`
- writing `Next Step` as multiple alternatives while `next_action` chooses only one of them
- creating duplicate Rainbond apps without checking first
- over-inferring topology from weak hints
- trying to troubleshoot runtime issues inside init
- continuing without resolving critical identity fields
- handing off to `rainbond-fullstack-troubleshooter` before the app exists and `.rainbond/local.json` is valid
- emitting `local` or another invalid selected environment value
- auto-continuing into bootstrap when the user asked to stop after initialization
- declaring initialization complete when the locked Rainbond transport is unavailable and app existence was not verified online

## Quick Reference

If missing:
- `rainbond.app.json` -> generate draft manifest
- `.rainbond/local.json` -> create local binding
- Rainbond app -> create app

If already present:
- reuse manifest
- reuse binding if valid
- reuse app if found

Component source kinds:
- `image`
- `source`
- `template`

Current conservative default:
- for standard middleware, prefer `template` when template metadata or curated mapping exists; otherwise use `image` as the safe fallback
- use `source` when a business-code component has enough Git metadata to drive the current source creation flow safely
- use `template` when install metadata is sufficient or can be resolved from a curated mapping; otherwise fall back to `image` in executable v1 mode or keep it as a confirmation-needed draft in v2 mode

Hand off after init:
- `rainbond-fullstack-bootstrap` for topology creation
- later `rainbond-fullstack-troubleshooter` for runtime repair

Execution summary reminder:
- `image` is the most reliable current executable path
- `source` should only be marked ready when the source metadata is truly sufficient
- `template` remains a reserved schema path until template-install support is implemented

Environment rule:
- selected environment must always resolve to `preview` or `production`
- if invalid or missing, use `preview`

Stop-after-init rule:
- if the user asks only for initialization, stop after writing `.rainbond/local.json`
- do not continue into bootstrap automatically

Verification rule:
- if `.rainbond/local.json` was written without platform verification, mark it `pending_verification`
- in that case, the correct next step is to reconnect the locked Rainbond transport and verify app existence before claiming full initialization

