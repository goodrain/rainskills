### Problem Judgment
Root cause is `source build failed` based on component events followed by build logs. Affected layers: `api`, `overall`. The current result is `code_or_build_handoff_needed`, so Rainbond-side runtime repair must stop.

### Actions Taken
- no changes applied; classified current blocker from fresh component events and build log evidence
- did not read runtime logs first because the build event and build log already identify the failing source-build step

### Verification Result
- **db status**: `running`
- **api status**: `abnormal`
- **frontend-access status**: `not applicable`
- **overall status**: `code_or_build_handoff_needed`
- key error disappeared from logs: `no`
- app can serve user-facing requests: `no; build failure blocks runtime convergence`

### Follow-up Advice
Short-term: hand off to code/build work to inspect failing build event `event-api-42` and fix the source-build step before returning to Rainbond runtime repair. Long-term: keep build parameters in `replace_build_envs` when the fix is a confirmed platform build parameter. handoff needed: yes, `code/build`.

### Structured Output
```yaml
TroubleshootResult:
  runtime_state:
    label: code_or_build_handoff_needed
    component_status:
      api: abnormal
      db: running
    dependency_readiness:
      db_dependency: resolved
    blocker_summary: "api source build failed; component events produced event-api-42 and build logs show npm build exited non-zero."
  blocker_bucket: source build failed
  actions_taken:
    - "No changes applied; classified the blocker from component events and build logs."
    - "Stopped before runtime-log-first diagnosis because build logs are the dominant evidence."
  verification_summary:
    db_status: running
    api_status: abnormal
    frontend_access_status: null
    key_error_cleared: false
    app_endpoint_operational: false
    evidence_chain:
      - component_summary
      - component_events
      - build_logs
    dominant_evidence: "component event event-api-42 plus build logs show the source build exited non-zero before a runnable container existed."
    stop_reason: source_build_failed
    recommended_next_action: "Use a code/build handoff to fix the failing source-build step, then rerun Rainbond convergence."
    stop_boundary:
      stopped: true
      delivery_verifier_allowed: false
      code_changes_allowed: false
      local_tests_allowed: false
      commit_or_push_allowed: false
      fallback_used: false
  next_handoff: code_build_handoff
```
