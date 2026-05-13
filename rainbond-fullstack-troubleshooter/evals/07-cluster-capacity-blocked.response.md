### Problem Judgment
Root cause is `cluster capacity blocked` based on pod detail and scheduler events. Affected layers: `frontend-access`, `overall`. The current result is `capacity_blocked`, so application-level repair and delivery verification must stop.

### Actions Taken
- no changes applied; scheduler evidence shows the `web` workload cannot be placed
- stopped application-level env, dependency, and restart loops until cluster capacity is restored

### Verification Result
- **db status**: `running`
- **api status**: `running`
- **frontend-access status**: `not working`
- **overall status**: `capacity_blocked`
- key error disappeared from logs: `not applicable`
- app can serve user-facing requests: `no; the frontend workload is not schedulable`

### Follow-up Advice
Short-term: restore cluster capacity or reduce requested resources for the blocked `web` component before resuming Rainbond repair. Long-term: add capacity checks before rollout when resource requests are close to cluster limits. handoff needed: no. Application-level repair is paused until scheduling is restored.

### Structured Output
```yaml
TroubleshootResult:
  runtime_state:
    label: capacity_blocked
    component_status:
      web: capacity-blocked
      api: running
      db: running
    dependency_readiness:
      db_dependency: resolved
    blocker_summary: "web pod is unschedulable because the cluster lacks enough allocatable resources."
  blocker_bucket: cluster capacity blocked
  actions_taken:
    - "No changes applied; scheduler evidence shows web cannot be placed."
    - "Stopped application-level repair until cluster capacity is restored."
  verification_summary:
    db_status: running
    api_status: running
    frontend_access_status: not_working
    key_error_cleared: null
    app_endpoint_operational: false
    evidence_chain:
      - component_summary
      - pod_list
      - pod_detail
      - scheduler_events
    dominant_evidence: "pod detail and scheduler events report Unschedulable due to insufficient CPU for web."
    stop_reason: cluster_capacity_blocked
    recommended_next_action: "Restore cluster capacity or reduce web resource requests before resuming application repair."
    stop_boundary:
      stopped: true
      delivery_verifier_allowed: false
      code_changes_allowed: false
      local_tests_allowed: false
      commit_or_push_allowed: false
      fallback_used: false
  next_handoff: none
```
