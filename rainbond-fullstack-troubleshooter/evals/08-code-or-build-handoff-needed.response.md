### Problem Judgment
Root cause is `api startup issue` based on pod detail and runtime logs. Affected layers: `api`, `overall`. The current result is `code_or_build_handoff_needed`, so the troubleshooting run must stop at the code/build boundary.

### Actions Taken
- no changes applied; pod detail and runtime logs show the container starts but exits from an application startup error
- stopped before source edits, local command execution, commit, or push because this is outside Rainbond-side repair

### Verification Result
- **db status**: `running`
- **api status**: `abnormal`
- **frontend-access status**: `not applicable`
- **overall status**: `code_or_build_handoff_needed`
- key error disappeared from logs: `no`
- app can serve user-facing requests: `no; api startup must be fixed outside Rainbond-side repair`

### Follow-up Advice
Short-term: use a code/build handoff to fix the api startup error, then return to Rainbond troubleshooting after a new build is available. Long-term: add startup validation in the source pipeline so this class of failure is caught before deployment. handoff needed: yes, `code/build`.

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
    blocker_summary: "api pod starts but exits from an application startup error; Rainbond dependency and env evidence are not the dominant blocker."
  blocker_bucket: api startup issue
  actions_taken:
    - "No changes applied; pod detail and runtime logs identify an application startup error."
    - "Stopped at the code/build boundary without source edits, local command execution, commit, or push."
  verification_summary:
    db_status: running
    api_status: abnormal
    frontend_access_status: null
    key_error_cleared: false
    app_endpoint_operational: false
    evidence_chain:
      - component_summary
      - pod_detail
      - runtime_logs
    dominant_evidence: "pod detail and runtime logs show api exits from an application startup error after the container starts."
    stop_reason: code_or_build_handoff_needed
    recommended_next_action: "Use a code/build handoff to fix the api startup error before further Rainbond repair."
    stop_boundary:
      stopped: true
      delivery_verifier_allowed: false
      code_changes_allowed: false
      local_tests_allowed: false
      commit_or_push_allowed: false
      fallback_used: false
  next_handoff: code_build_handoff
```
