### Creation Result
Created the 13 default-active `services[]` from the dify-style compose profile, one Rainbond component per compose service. No `optionalServices[]` entry was created.

### Actions Taken
Deployed only the services activated by the default `COMPOSE_PROFILES`. The default-active set already includes the vector store `weaviate`, so the vector-store capability is satisfied and no optional vector store was activated. The profile also offers optional vector stores `qdrant` / `pgvector` / `milvus`（默认未部署）; their existence is disclosed once here, but they were not created and the user was not prompted to pick one because the required capability is already met.

### Current State
All 13 default-active services are `running`. No dependency remains deferred and the topology has converged.

### Handoff Recommendation
Runtime is converged and the remaining question is final access behavior, so hand off to `rainbond-delivery-verifier`.

### Structured Output
```yaml
BootstrapResult:
  deployment_plan:
    app_identity:
      team_name: demo-team
      region_name: rainbond
      app_name: dify-style-demo
      app_id: app-compose-012
    environment:
      name: preview
      source: default
    workflow:
      created:
        - api
        - worker
        - web
        - nginx
        - db_postgres
        - redis
        - sandbox
        - plugin_daemon
        - ssrf_proxy
        - weaviate
        - sandbox_worker
        - web_frontend
        - api_internal
      reused: []
      skipped: []
      skipped_reasons: {}
      deferred_dependencies: []
      frontend_access_mode: reverse-proxy
  runtime_state:
    overall: runtime_healthy
    component_status:
      api: running
      worker: running
      web: running
      nginx: running
      db_postgres: running
      redis: running
      sandbox: running
      plugin_daemon: running
      ssrf_proxy: running
      weaviate: running
      sandbox_worker: running
      web_frontend: running
      api_internal: running
    blocking_bucket: null
  next_handoff: delivery_verifier
```
