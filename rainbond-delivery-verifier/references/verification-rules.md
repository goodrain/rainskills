# Delivery verification rules

## Scope

This skill may:
- read app detail
- read component list
- read component summaries and details
- read component storage summaries for database and other stateful middleware components
- inspect recent logs and events if needed
- inspect access information
- report deployment convergence
- report the most appropriate user-facing access URL

This skill must not:
- perform destructive actions
- modify source code
- continue speculative repairs
- pretend delivery is complete when evidence is incomplete

## Verification Principles

### 1. Deployment convergence is not the same as component existence
Do not declare success only because components exist.

At minimum, distinguish:
- `building`
- `waiting`
- `running`
- `abnormal`
- `capacity-blocked`

### 2. Delivery completion is not the same as “all backend components running”
If the app is user-facing, final delivery requires a usable access path.

### 3. If evidence is incomplete, report partial completion
If an access URL exists but cannot be externally validated from the current environment, report:
- the access URL
- what was verified
- what still needs manual confirmation

### 4. Reverse-proxy full-stack delivery needs both the page path and the API path
If the app is a frontend + backend project and the frontend is expected to call the backend through the same host, do not treat a root-page URL alone as sufficient delivery proof.

Use current-run evidence such as:
- frontend access mode `reverse-proxy`
- frontend runtime env like `VITE_API_URL=/api`
- local project code or manifest hints that the frontend calls `/api`

In those cases:
- verify the preferred root URL for the frontend document path
- also verify the same host's backend path, typically `/api`
- if the frontend is served under a base prefix (e.g. `/system`), also verify the API path
  under that prefix (e.g. `/system/api`); `/api` succeeding alone does not prove the page's
  actual requests succeed
- if `/` works but `/api` returns 4xx/5xx, empty reply, placeholder page, or cloud-provider intercept page, do not classify the app as delivered
- classify the result as `blocked` unless a narrower partial state is better supported by evidence

### 5. Stateful delivery must not hide missing persistence
If the app includes a database or stateful middleware component:
- inspect its storage summary before final classification
- for common middleware images, expect a durable mount at the standard data directory such as Postgres `/var/lib/postgresql/data`, MySQL `/var/lib/mysql`, MongoDB `/data/db`, Redis `/data`, RabbitMQ `/var/lib/rabbitmq`, Kafka `/var/lib/kafka/data`, Elasticsearch/OpenSearch `/usr/share/elasticsearch/data`, or MinIO `/data`
- if no durable storage is mounted, do not silently report a clean `delivered` result
- if the user explicitly required durable data, classify delivery as `blocked` with blocker `stateful middleware persistence not configured`
- if the run is clearly only an ephemeral demo, report the missing persistence caveat in `Verification Result` and avoid wording that implies production-safe stateful middleware storage

### 6. Static frontend delivery has its own acceptance checklist
When the delivered app serves a built frontend (SPA or static site), verify beyond the
root page returning 200:
- the entry HTML actually contains the app shell, not a placeholder or directory listing
- JS/CSS assets return correct MIME types (not `text/html` from an SPA fallback)
- a deep link (any non-root route) returns the SPA fallback page instead of 404
- responses for large JS/CSS assets include `content-encoding: gzip` or `br`; if a single
  asset exceeds ~2 MB uncompressed and is served without compression, report it as a
  delivery caveat
- static assets carry a cache-control header

Report failed items as caveats or blockers depending on user impact; do not silently
pass a frontend that only returned a 200 on `/`.

### 7. Performance findings get layered recommendations, not a rewrite verdict
When verification surfaces a performance problem (oversized bundle, missing compression,
no caching), recommend in two layers:
1. deployment-layer mitigation first — enable gzip/br, add cache headers, adjust proxy
   config; low risk, no code change
2. code-layer fix second — code splitting, lazy loading, dependency dieting; hand off as
   code/build work
Never present a source-code refactor as the only path when a deployment-layer mitigation
exists.

## Bounded URL probe contract

Any `delivered + verified` result must come from the shared bounded [policy](../schemas/delivery-probe-policy.schema.yaml), [input](../schemas/delivery-probe-input.schema.yaml), and [result](../schemas/delivery-probe-result.schema.yaml) schemas using `policy_version = rainskills.delivery-probe-policy.v1`. In the CLI profile execute only `delivery probe --input - --skill-id rainbond-delivery-verifier`. In the embedded profile call the fixed server-owned `rainbond_probe_delivery_url` adapter with the same schemas and policy. The model, curl, direct HTTP, and a free-form browser are never fallback probe implementations; if the adapter is unavailable, keep the candidate URL and downgrade to `delivered-but-needs-manual-validation`.

Safety policy:
- allow only HTTP/HTTPS and HEAD/GET; reject URL userinfo
- resolve DNS before every request and every followed redirect; reject any loopback, private, link-local, unspecified, multicast, reserved, documentation, or other non-public IPv4/IPv6 address before sending a request
- pin the validated address into the request lookup so DNS rebinding cannot switch the connection after validation
- follow at most three same-host redirects; allow same-host HTTP-to-HTTPS upgrades, reject HTTPS downgrade
- for a cross-host redirect, record the target and stop with manual validation; never follow it automatically
- send no Cookie, Authorization, Rainbond credential, or other ambient credential
- enforce a 5-second connection timeout, 15-second total timeout, and 256 KiB response-body limit
- if policy rejects the URL, do not send a request; retain the candidate URL and downgrade to `delivered-but-needs-manual-validation`
