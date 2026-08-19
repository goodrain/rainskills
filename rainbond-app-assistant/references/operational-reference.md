# App Assistant operational reference

Load this reference only when checking a proposed route or reviewing a completed run.

  ## Common Mistakes

  - running bootstrap when the topology already exists
  - running bootstrap for a template-install intent
  - running troubleshooter before confirming the project is linked
  - assuming env sync is mandatory for every run
  - treating env files as runtime truth
  - exposing a large YAML block for an eligible successful source delivery, including browser-confirmation-only delivery, when the user did not ask for structured/debug output
  - reporting team/region/app identity as a substitute for the clickable Rainbond deployment location
  - using the public service URL as the Rainbond deployment location, or constructing the public service URL from naming conventions
  - stripping useful diagnostic evidence from building, blocked, unhealthy, ambiguous, handoff, or incomplete promotion states
  - omitting the required `### Structured Output` section in structured contract mode
  - replacing the required five human-readable sections with freeform narrative in structured contract mode
  - treating a project as unlinked only because `.rainbond/local.json.metadata.status` is stale even though the platform confirms the same app in the current run
  - omitting `Actions Performed` detail when the run only did inspection/classification and intentionally skipped downstream skills
  - echoing raw platform labels such as `closed` instead of normalizing component status to the canonical vocabulary
  - stopping after bootstrap even when bootstrap explicitly recommends troubleshooting
  - skipping template version resolution before installation
  - treating source build convergence as a finished healthy topology
  - continuing application repair when scheduling is blocked by cluster capacity
  - stopping at “running” without verifying delivery state or reporting access URL
  - declaring the app healthy when only db/api are healthy but frontend access is still broken
  - continuing platform-level repairs when the issue is clearly in code or reverse proxy configuration
  - auto-entering version flow when delivery is only `delivered-but-needs-manual-validation`
  - replacing the source-app meaning of `project` with the created testing app instead of recording testing identity under `promotion_result`
  - recursively treating the created testing app as a brand-new source app in the same run
  - silently degrading a source-backed component into an image-backed component after a source creation error
  - silently rewriting the source branch or ref after a source creation error
  - inventing `delivery_state.partially-delivered` before `rainbond-delivery-verifier` has actually run
  - routing a control-plane or platform backend failure into `code_build_handoff`
  - copying a frontend-only component state into `api_status`
  - stopping the top-level app-assistant run at successful init even though the user asked for deploy or dev-to-test continuation
  - silently selecting one team when multiple accessible teams existed and the user had not chosen one
  - searching outside the current project directory for `rainbond.app.json` or `.rainbond/local.json`
  - continuing into local code edits, local tests, commit, push, or automatic retry after reaching `code_build_handoff_needed`
  - automatically switching from source-backed bootstrap to local package because source detection found multiple services
  - starting local Docker/OrbStack, building locally, or pushing temporary images after a source/package/image path fails without explicit user confirmation
  - spending 20-30 minutes repeatedly trying the same path instead of stopping at the attempt budget
  - routing a clear source build failure straight to runtime logs without checking component events and build logs first
  - using `build_info` as the default container for source build parameters
  - promising `dockerfile_path` or defaulting to Dockerfile mode without explicit user intent

  ## Quick Reference

  Decision summary:
  - no link -> link first
  - no link -> `rainbond-project-init`
  - template install intent -> `rainbond-template-installer`
  - no topology -> bootstrap
  - source build still converging -> troubleshooter
  - explicit build failure question -> troubleshooter with `events -> build logs -> runtime logs`
  - external artifact unreachable -> stop and request reachable mirror/egress or explicit strategy change
  - cluster capacity blocked -> stop and fix platform capacity first
  - topology exists but unhealthy -> troubleshoot
  - runtime appears converged -> delivery verifier
  - strict delivered plus explicit dev-to-test intent -> create snapshot and testing app
  - delivered-but-needs-manual-validation -> stop for manual URL validation before promotion; use concise success output for source-only delivery when all concise-mode conditions are met
  - runtime fixed but browser path broken -> code/build handoff
  - healthy -> stop

  Trust model:
  - local files provide context
  - the locked Rainbond transport provides runtime truth

  Default orchestration:
  1. resolve context
  2. determine whether the run is source-only or dev-to-test mainline
  3. classify state
  4. choose lower-level skill
  5. continue until the current strict gate says stop
  6. if strict delivered and promotion was requested, snapshot and create testing app
  7. verify the testing app once
  8. report one next step
