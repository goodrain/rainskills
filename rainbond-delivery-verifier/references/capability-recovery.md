# Probe capability diagnosis and business verification

In embedded sessions, use only the fixed server-owned `rainbond_probe_delivery_url` contract and current server tool evidence. Do not infer or borrow client-local executables.

<!-- rainskills-cli-only:start -->
## Use the actual adapter contract

The protected URL probe is local to the tools CLI, not a remotely listed Console Tool. Its absence from `tools/list`, the installer help, or a host browser-tool roster does not prove it is missing.

Use `node <home>/.rainbond/bin/rainskills-tools.js delivery probe --input - --skill-id rainbond-delivery-verifier` with JSON on stdin:

```json
{"policy_version":"rainskills.delivery-probe-policy.v1","url":"https://example.com/","method":"HEAD"}
```

Replace the example with the candidate URL obtained from current platform facts. The adapter itself needs no Rainbond token or connected Runtime; fresh app identity and convergence evidence still come from the proper Runtime Gate. Do not pass credentials, cookies, or arbitrary request bodies to this probe.

A response of `E_INPUT_INVALID` means the input/arguments must be corrected. Older tools CLIs do not implement `delivery probe --help`; that help error is not an adapter execution failure. Current help shows the fixed command and input example. Actual `verified`, `rejected`, and transport/body-limit results are distinct from a missing adapter.

If the installed package genuinely lacks a required module, use the Rainskills maintenance Skill and supported installer to repair the authorized installation. Verify the actual runtime module rather than comparing the public shim to the source implementation. Record package version and source commit, especially for an unpublished branch build. Never edit credentials or bypass probe URL/DNS/redirect/response limits to make a result pass.

<!-- rainskills-cli-only:end -->

## Keep entry probing and business checks separate

A free-form browser, curl, or application test cannot replace the bounded entry probe. That restriction does not prohibit independent, explicitly authorized application UI or API acceptance work such as initialization, login, document upload, article creation, or persistence verification. Parent orchestration owns those actions and their app credentials; the delivery verifier remains read-only.

<!-- rainskills-cli-only:start -->
Before declaring UI automation unavailable, inspect the execution user's known browser automation installation and test a local blank/data page. A missing host browser connector does not mean that a sandboxed Playwright script is unavailable. Reuse existing authorized tools; if absent, the orchestrator can install a pinned official-registry tool into a dedicated tool directory within task scope. Keep Chromium sandboxing enabled, use app-scoped test data, protect credentials, and never reuse unrelated browser sessions.

<!-- rainskills-cli-only:end -->

When capabilities exist but a configuration is wrong, correct the invocation or supported configuration and continue. If a capability truly cannot be restored, report the exact failed invocation, error category, and independent checks already performed. Do not write a generic request for the user to provide a browser session without checking the installed execution path.
