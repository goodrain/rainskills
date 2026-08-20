# Open-source application deployment failure-mode playbook

Use this playbook only after matching fresh Rainbond and application evidence. It captures reusable deployment lessons; it is not a substitute for the upstream application's official documentation.

## Contents

- Missing required configuration
- Reverse-proxy and same-origin failures
- Browser protocol mismatches
- Lost state or generated keys
- Self-provisioning dependencies
- Slow or failed image pulls
- Secure-cookie last mile
- Duplicate internal domains

## Missing required configuration

**Evidence:** a component exits immediately and its log names a missing required setting.

**Action:** confirm the setting in the official descriptor or docs, check env conflicts and mounted config overrides, add only that setting, redeploy the affected component, then recheck whole-app health.

Do not bulk-copy every upstream env value. Preserve the smallest evidence-backed configuration and keep secret values user-supplied.

## Reverse-proxy and same-origin failures

**Evidence:** UI and API containers are individually healthy, but browser routes or API calls fail; the browser expects relative paths or the official proxy fans one origin out to several upstreams.

**Action:** retain one reverse-proxy component, mount the official routing configuration, wire an explicit dependency from the proxy to every upstream, render verified internal addresses, and expose only the proxy.

Verify the UI, API paths, static assets, redirects, and primary route through the proxy. A stock proxy default page is not application success.

## Browser protocol mismatches

**Evidence:** the process and proxy are healthy, but a login or setup API rejects a handcrafted request identically for correct and incorrect input.

**Action:** inspect the official frontend and backend source for client-side encryption, CSRF, nonce, signature, or setup-handshake requirements. Verify through the real UI or reproduce the complete protocol.

Do not infer data corruption from a plain request that does not implement the browser protocol. Dify-like applications can encrypt login fields in the frontend, so a plain request is not an equivalent smoke test.

## Lost state or generated keys

**Evidence:** setup initially works, but credentials, uploads, or generated-key operations fail after a restart; logs report missing key or file state.

**Action:** identify the official durable data path, attach persistent writable storage, and share the same volume with every component that must read the files. A command that regenerates keys, rewrites accounts, or mutates application data requires explicit user confirmation and must come from official operations documentation.

Verify by repeating the affected UI/core flow after another controlled restart. Do not claim persistence from mount presence alone.

## Self-provisioning dependencies

**Evidence:** an early log says a database, schema, index, or queue is missing, then later logs show initialization or migration progressing.

**Action:** observe the anchored build/runtime event and later logs before classifying a blocker. Some suites create their own database or schema on first start.

Do not repair a dependency that is already self-provisioning successfully.

## Slow or failed image pulls

**Evidence:** deployment remains in image download or component creation longer than normal.

**Action:** keep waiting on the anchored event while progress remains non-terminal. Large or overseas images may pull slowly. Only diagnose after a terminal error or concrete pod event identifies authentication, registry reachability, missing tag, rate limit, or pull failure.

After a confirmed terminal pull failure, try at most one approved registry/proxy correction. If the same image remains unreachable, stop instead of looping.

## Secure-cookie last mile

**Evidence:** the UI loads, but login loops, session cookies disappear, or callbacks redirect to the wrong scheme or host after passing through the external gateway.

**Action:** compare the real external entry with the application's official public-URL, trusted-proxy, forwarded-header, and secure-cookie settings. Preserve HTTPS at the user-facing entry and ensure the proxy forwards the original scheme and host. When the public URL could not exist before the first deployment, use a two-phase flow: obtain the real entry from `access_infos`, set only the evidence-backed public URL or cookie mode, redeploy once, then repeat the authenticated smoke.

Verify in a browser by completing login and one authenticated navigation or write. A root-path response cannot validate cookies.

## Duplicate internal domains

**Evidence:** a second deployment in the same namespace cannot claim an internal domain already used by another component.

**Action:** choose a unique DNS-safe `k8s_service_name` for every colliding provider and rewrite all URLs, DSNs, callbacks, and proxy upstreams that embed those hostnames. Prefer port alias injection wherever the application consumes separate `_HOST` and `_PORT` variables.

Verify that no old hostname remains in runtime env or mounted routing config before redeploying.
