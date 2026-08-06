# RainSkills Installation Telemetry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record RainSkills platform and authorization lifecycle events locally and best-effort in `rainbond-request-server` without changing installation, authorization, or application-deployment behavior.

**Architecture:** Keep the existing `/api/rainskills/installations` summary endpoint and `/api/rainskills/deployments` application-deployment endpoint unchanged. Add a separate `/api/rainskills/lifecycle-events` endpoint backed by an idempotent event table; deploy this server route before publishing the client. During rollout, only an explicit lifecycle-route `404` or schema rejection `400/415/422` may trigger a projection to the old summary endpoint; timeouts and 5xx responses retry the same event and never fallback. RainSkills emits fixed-schema events from the POSIX installer, the Node platform installer, and Windows authorization; local persistence happens before a short, fail-open network send.

**Tech Stack:** Bash/Python JSON construction, Node.js CommonJS, Go 1.17 + GORM v1, SQLite tests, MySQL AutoMigrate.

---

### Task 1: Lock the lifecycle event contract

**Files:**
- Modify: `docs/superpowers/specs/2026-08-06-rainskills-installation-telemetry-design.md`
- Test: `tests/telemetry.test.js`

- [x] **Step 1: Write failing contract assertions** for the endpoint, required identifiers, lifecycle status enums, legacy summary compatibility fields, and rejection of free-form/secret fields.
- [x] **Step 2: Run the focused test** with `node --test tests/telemetry.test.js` and verify it fails because the contract helper is not present.
- [x] **Step 3: Update the design** to specify the separate lifecycle endpoint and server table, while explicitly preserving the two existing endpoints.
- [x] **Step 4: Run the focused contract test** again after the client/server contract fixtures are added.

### Task 2: Add the RainSkills fail-open client

**Files:**
- Create: `rainbond-platform-installer/scripts/telemetry.js`
- Modify: `rainbond-platform-installer/scripts/platform-installer.js`
- Modify: `rainbond-platform-installer/scripts/windows-onboarding.js`
- Modify: `install.sh`
- Test: `tests/telemetry.test.js`
- Test: `tests/install.sh.test`
- Test: `tests/platform-installer.test.js`

- [x] **Step 1: Write failing Node tests** for fixed-schema event construction, safe local JSONL persistence, non-blocking send failure, stable event IDs on retry, and the strict `404/400/415/422`-only projection to the old summary endpoint.
- [x] **Step 2: Run `node --test tests/telemetry.test.js`** and verify the expected missing-module failures.
- [x] **Step 3: Implement the telemetry module** with allowlists, no raw error text, local `0600` JSONL append, short timeout, and background best-effort POST to `/api/rainskills/lifecycle-events`.
- [x] **Step 4: Add failing integration assertions** that platform progress events and authorization events carry the same `install_attempt_id` and that shell reporting remains non-blocking.
- [x] **Step 5: Wire the reporter** to `appendEvent`, platform resume/install context, Windows authorization, and existing shell summary call sites without changing business decisions or output. Pass the same `install_attempt_id` through platform install/resume/reboot and shell authorization.
- [x] **Step 6: Add Windows-specific assertions** in `tests/windows-onboarding.test.js` and `tests/windows-platform.test.js` for action/WSL/auth events, association IDs, lower-case action mapping, and secret-free local/HTTP payloads.
- [x] **Step 7: Run focused Node and shell tests** and confirm existing behavior remains unchanged.

### Task 3: Add the idempotent log-server endpoint

**Files:**
- Create: `/Users/goodrain/Desktop/code/rainbond-request-server/rainskills_lifecycle.go`
- Create: `/Users/goodrain/Desktop/code/rainbond-request-server/rainskills_lifecycle_test.go`
- Modify: `/Users/goodrain/Desktop/code/rainbond-request-server/router.go`
- Modify: `/Users/goodrain/Desktop/code/rainbond-request-server/resource.go`

- [x] **Step 1: Write failing Go tests** for accepted lifecycle events, strict enum/unknown-field validation, rate limiting, and duplicate `event_id` idempotency.
- [x] **Step 2: Run the focused Go test** in `rainbond-request-server` and verify the new tests fail before implementation.
- [x] **Step 3: Implement the new model/request validator/handler** with a unique `event_id`, bounded body size, server timestamps, and fail-safe duplicate success.
- [x] **Step 4: Register the route and AutoMigrate the new table** without changing existing RainSkills installation/deployment models; add regression tests proving the two old routes and their tables remain available.
- [x] **Step 5: Run focused Go tests, `go vet ./...`, and `go build ./...`** in `rainbond-request-server`.

### Task 4: Cross-platform verification and delivery

**Files:**
- Modify: `README.md`
- Modify: `rainbond-platform-installer/references/troubleshooting.md`

- [x] **Step 1: Document only local diagnostic location and fail-open behavior**, not credentials or raw logs.
- [x] **Step 2: Run the complete Rainskills test suite and marketplace/package checks.**
- [x] **Step 3: Run `git diff --check` in both repositories and inspect that the forbidden plan files and unrelated `.DS_Store`/marketing files are not staged.**
- [ ] **Step 4: Commit Rainskills and request-server changes separately with Conventional Commit messages.**

No Windows reinstall is required for this change; Windows CI and focused contract tests cover the new code, followed by one lightweight lifecycle POST smoke check when the server is deployed.
