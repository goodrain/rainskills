# Open-source application deployment workflow

## Overview

Turn an upstream application's official deployment material into a working Rainbond application. Derive the topology from evidence, create and connect every component, preserve state, then iterate until runtime health, the real external entry, and the application's UI or core flow all pass.

**Core principle:** importing images is not completion. Completion means the topology is evidence-backed and the deployed application works through its real user-facing entry.

Use the protected local Rainskills CLI as the only transport for Rainbond runtime truth. Never call Rainbond MCP directly, start a local Rainskills MCP service, or invent component state, internal addresses, credentials, or external URLs.

## Progress checklist

Track this checklist throughout the run:

```text
Open-source deployment:
- [ ] 0. Official topology derived
- [ ] 1. Components, dependencies, ports, env, and storage modeled
- [ ] 2. Required upstream documentation obtained
- [ ] 3. Deployment reached terminal build states
- [ ] 4. All component health checked
- [ ] 5. Every blocker converged or stopped within budget
- [ ] 6. Real entry and UI/core smoke verified
```

## 0. Derive the official topology

Before any Rainbond write, obtain the upstream project's official `docker-compose.yml`, Compose fragments, Helm chart values/templates, image documentation, and installation guide. Prefer a pinned release or image tag over an unbounded moving tag.

Build one deployment inventory from those sources:

- every required service and its image, tag, command, and role
- container ports and which single service is the intended user entry
- required environment variables, secrets that must come from the user, and defaults
- every provider/consumer relationship from `depends_on` and from host references embedded in env, URLs, DSNs, callbacks, and proxy configuration
- named volumes, bind mounts, data directories, and volumes shared by multiple services
- health checks, initialization jobs, profiles, anchors, `env_file` inputs, and config files
- reverse-proxy routes and same-origin browser requirements

Do not reconstruct a complex suite from model memory when the official descriptor is unavailable. Ask for the descriptor or permission to use a clearly named official alternative before writing runtime state.

If the application is actually available in the Rainbond market, stop and route to `rainbond-template-installer`.

For Helm input, pin the chart version and merge the user's values before deriving the inventory. Render with the upstream-supported `helm template` path when available. Map the rendered intent as follows:

- Deployment or StatefulSet workloads → long-running Rainbond components backed by their declared images
- Service ports → Rainbond inner/outer ports; Ingress routes → the single external entry and proxy routing
- persistent volume claims → evidence-backed persistent storage requirements
- ConfigMaps and non-secret files → `config-file` mounts; Secrets → user-supplied secret inputs that are never printed
- startup/readiness/liveness probes → `rainbond_manage_component_probe`
- init containers, Jobs, hooks, privileged host integration, operators, and custom resources → explicit compatibility decisions, not silent omission

If a chart relies on Kubernetes behavior that cannot be represented safely by current Rainbond component capabilities, stop with a semantic-compatibility blocker. Do not claim that reading a chart is equivalent to installing it unchanged.

## 1. Import components and model the deployment

Create or reuse the target Rainbond application, then model the inventory in dependency order.

1. Create every image-backed component with `rainbond_create_component_from_image` and keep initial deployment disabled until its ports, env, dependencies, storage, and config files are ready.
2. Configure inner ports first. Enable an outer port only on the intended external entry. Add the port with `rainbond_manage_component_ports`, then call `rainbond_manage_component_ports(operation=update_alias)` for that port to set `port_alias` and `k8s_service_name`; do not assume the add call persisted both values.
3. Create every accepted provider/consumer edge with `rainbond_manage_component_dependency`, including both declared `depends_on` edges and edges implied by URLs, DSNs, callbacks, or proxy upstreams.
4. Configure provider-side connection variables with `rainbond_manage_component_connection_envs`, then let explicit dependencies inject them. Keep consumer-local env only for names or combined URLs the application itself requires. Ask for missing secrets without displaying or persisting them in reports.
5. Attach persistent storage to every stateful data directory before deployment. For image-created stateless components, use `rainbond_manage_component_storage` with an explicit `volume_name`, `volume_type=share-file`, and the official `volume_path`. When multiple components must see the same files, mount the same shared writable volume on each required component. Never invent a storage class, host path, or retention guarantee. If the upstream requires local, block, or single-writer stateful semantics that the available component cannot preserve, stop and report the mismatch instead of silently weakening it.
6. Mount required proxy or application config as `config-file` storage before deploying the component that consumes it.
7. Preserve health probes through `rainbond_manage_component_probe`. Run one-shot initialization only through an evidence-backed supported path; do not create a long-running component that is expected to exit successfully and then misclassify its restart loop as health.

If any required MCP capability above is unavailable, stop with a capability blocker and name the missing operation. Do not silently emulate it with an unsafe delivery-mode or storage-semantic change.

### Component addressing

Prefer **port alias injection**:

- set the provider port alias to the env prefix expected by the consumer
- create the explicit dependency edge
- consume the platform-injected `<PREFIX>_HOST` and `<PREFIX>_PORT`
- do not copy a Compose service name or hard-code a container-local hostname into Rainbond env

When a hostname must be embedded inside a URL, DSN, callback, or connection string, set a semantic internal domain with `k8s_service_name` and render that verified domain into the value. Use DNS-safe hyphenated names. If deploying another copy in the same namespace, choose unique internal domains and rewrite every matching reference consistently.

Before any env write on a component with dependency-injected or port-alias env, run `rainbond_analyze_env_conflicts`. Do not create a local env that collides with an injected `_HOST` or `_PORT` value.

### Deployment best practices

1. **Explicit dependency edges.** Runtime DNS reachability is not a substitute for a Rainbond dependency. Verify the final accepted edge set is complete.
2. **Single reverse-proxy entry.** When browser UI and APIs require same-origin path routing, retain the official proxy, mount its routing config, wire every proxy-to-upstream edge, and expose only the proxy externally. Never deploy a stock proxy without its routing config.
3. **Persistent storage for state.** Databases, uploaded files, generated keys, and other durable state must survive restart. Verify storage is mounted at the official data path and is writable by the running process.

## 2. Acquire documentation on two tracks

Classify each blocker before searching:

- **Configuration-class:** missing required env, wrong provider address, dependency not wired, storage path absent, config file overriding env. Use logs, Rainbond evidence, the deployment inventory, and [failure-mode-playbook.md](failure-mode-playbook.md) first.
- **Protocol/framework-class:** the process is healthy but login, encryption, callbacks, cookies, setup, or a framework-specific operation behaves incorrectly. Search the official upstream source, README, issue tracker, or operations guide before changing runtime state.

When clean logs conflict with broken user behavior, treat that as protocol/framework-class. Do not guess a destructive storage or database repair from a browser symptom.

## 3. Deploy and wait for terminal build states

Deploy only after the step 1 readiness gates pass. Use `rainbond_operate_app` for the deployment and `rainbond_wait_for_build_completion` for each returned build event.

- Keep waiting with the same anchored event while the tool reports `running`.
- Treat the terminal result and its classified reason as evidence.
- Do not replace the bounded wait with repeated unanchored status polling.
- A slow image pull is not a failure by elapsed time alone; distinguish active pulling from a terminal image-pull error.

## 4. Check application health

Use `rainbond_get_app_health_overview` as the default whole-application signal. Inspect each abnormal component's blocker, then obtain the minimum supporting pod, event, log, env, dependency, port, and storage evidence needed to explain it.

Continue to step 6 only when every required component is green. If any required component is building, waiting, abnormal, or capacity-blocked, continue to step 5.

## 5. Diagnose, repair, and converge

Read [failure-mode-playbook.md](failure-mode-playbook.md) when the evidence matches one of its deployment patterns.

Use `rainbond-fullstack-troubleshooter` as the repair engine for existing-component build or runtime blockers. Follow its `RuntimeState` classification, evidence order, config-override gate, connection contract, event anchoring, destructive-action boundary, and attempt budget.

For each blocker:

1. Collect fresh anchored evidence.
2. Classify the blocker and choose the smallest evidence-backed repair.
3. Before env changes, run the env-conflict check and inspect mounted config files that may override env.
4. Announce and apply one known low-risk Rainbond-side repair. Ask before destructive, data-mutating, broad, or low-confidence actions.
5. Redeploy only the affected scope, wait for its terminal event, then return to step 4.

Budget rules:

- Allow at most one repair attempt for the same blocker signature, then re-verify.
- If the same signature remains, stop and report the evidence and required human decision.
- Stop after three distinct repair attempts in one run, or after two consecutive health passes with no material improvement.
- Stop immediately for a confirmed unreachable upstream image, cluster capacity failure, or source-code/build defect that Rainbond configuration cannot repair.
- Repeated identical read-only checks without new anchored evidence do not count as progress.

## 6. Pass the delivery gate

Completion requires all of the following:

1. `rainbond_get_app_health_overview` shows every required component green.
2. Read the real external entry from Rainbond `access_infos`; never fabricate or infer a URL.
3. If official documentation requires a public base URL, callback URL, trusted proxy, or secure-cookie setting, use that real entry to complete the two-phase public-URL configuration, redeploy once, and read `access_infos` again.
4. Verify that real entry is reachable through the intended proxy or application component.
5. Perform an application-specific **UI smoke** or core-flow smoke through the real entry, not only a root-path status check. Examples include loading the setup/login UI, signing in with user-provided test credentials, creating a minimal object, or completing the application's primary read/write flow.
6. Recheck stateful storage and the explicit dependency set after the smoke test.
7. When durable application state is part of the acceptance target, perform one controlled restart and verify the smoke-created object or equivalent state is still readable.

If UI automation is unavailable, stop at `needs manual UI validation`; provide the real entry and exact manual steps, but do not call the deployment complete.

Report concisely:

- topology created and external entry component
- component health and any intentionally omitted optional services
- explicit dependencies and persistent/shared storage verified
- real access URL from `access_infos`
- UI/core smoke performed and result
- unresolved blocker, if any, plus the exhausted attempt budget

## Common mistakes

- Treating image import or all-green containers as final delivery.
- Copying Compose service names directly into consumer env.
- Wiring only `depends_on` while missing env-reference or proxy edges.
- Exposing web and API separately when the official UI assumes one origin.
- Deploying a reverse proxy before mounting its routing config.
- Deploying a database or generated-key directory without persistent storage.
- Editing env while a mounted config file supplies the effective value.
- Declaring a slow image pull failed before its event reaches a terminal state.
- Testing a browser protocol with an incompatible plain HTTP request and misdiagnosing the result.
- Reporting a guessed URL instead of Rainbond `access_infos`.
