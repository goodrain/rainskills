### Problem Judgment
Root cause is `external artifact unreachable` based on component events followed by build logs. Affected layers: `web`, `overall`. The current result is `code_or_build_handoff_needed`, so Rainbond-side runtime repair must stop.

### Actions Taken
- no changes applied; classified the current blocker from fresh component events and build log evidence
- did not switch to package upload, image fallback, local Docker build, or temporary image push

### Verification Result
- **db status**: `not applicable`
- **api status**: `not applicable`
- **frontend-access status**: `not working`
- **overall status**: `code_or_build_handoff_needed`
- key error disappeared from logs: `no`
- app can serve user-facing requests: `no; build-time artifact download failure blocks runtime convergence`

### Follow-up Advice
Short-term: provide a Rainbond-reachable mirror for the failing external artifact or restore cluster egress, then retry the same source-backed build. handoff needed: yes, `code/build`.

### Structured Output
```yaml
TroubleshootResult:
  runtime_state:
    label: code_or_build_handoff_needed
    component_status:
      web: abnormal
    dependency_readiness: {}
    blocker_summary: "web build cannot download a required GitHub Release asset; component events produced event-web-88 and build logs show repeated artifact download timeouts."
  blocker_bucket: external artifact unreachable
  actions_taken:
    - "No changes applied; classified the blocker from component events and build logs."
    - "Stopped without switching to package upload, image fallback, local Docker build, or temporary image push."
  verification_summary:
    db_status: null
    api_status: null
    frontend_access_status: not_working
    key_error_cleared: false
    app_endpoint_operational: false
    evidence_chain:
      - component_summary
      - component_events
      - build_logs
    dominant_evidence: "component event event-web-88 plus build logs show timeout while downloading a required GitHub Release asset before a runnable container existed."
    stop_reason: external_artifact_unreachable
    recommended_next_action: "Provide a reachable artifact mirror or restore cluster egress, then rerun the same source-backed build."
    stop_boundary:
      stopped: true
      delivery_verifier_allowed: false
      code_changes_allowed: false
      local_tests_allowed: false
      commit_or_push_allowed: false
      fallback_used: false
  next_handoff: code_build_handoff
```
