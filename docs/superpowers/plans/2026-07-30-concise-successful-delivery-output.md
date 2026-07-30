# Concise Successful Delivery Output Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make successful source-delivery responses show the application, environment, Rainbond management URL, public service URL, and essential health evidence without exposing internal structured output.

**Architecture:** Keep `AppAssistantResult` as the internal contract and add a required nullable `project.deployment_location_url`. Extend the deterministic validator with a separate concise presentation path selected by fixture metadata; all non-success and promotion flows continue through the existing structured path. Update the app-assistant instructions and canonical object documentation to describe the same split.

**Tech Stack:** Markdown skill contracts, YAML fixtures/schema, Python 3 validator, PyYAML, npm test orchestration.

---

### Task 1: Define failing concise-success fixtures

**Files:**
- Modify: `rainbond-app-assistant/evals/04-delivered-stop-without-promotion.response.md`
- Modify: `rainbond-app-assistant/evals/04-delivered-stop-without-promotion.expected.yaml`
- Create: `rainbond-app-assistant/evals/16-source-delivered-manual-validation.response.md`
- Create: `rainbond-app-assistant/evals/16-source-delivered-manual-validation.expected.yaml`

- [ ] **Step 1: Replace the delivered source-app response with the approved concise Chinese shape**

Use only `### 部署结果` and `### 运行状态`. Include application name, environment, a Markdown link labeled `部署位置`, a Markdown link labeled `访问地址`, component state, and HTTP evidence. Do not include `### Structured Output` or any internal enum.

- [ ] **Step 2: Mark the fixture as concise and assert useful and forbidden content**

Add this top-level metadata and prose contract:

```yaml
case: delivered-stop-without-promotion
presentation_mode: concise
assert:
  prose_contains:
    - 部署成功
    - payments-app
    - preview
    - 部署位置
    - 访问地址
    - https://run.rainbond.com/#/team/demo-team/region/cn/apps/app-204/overview
    - https://demo-team-cn.rainbond.me/payments-app
    - 200 OK
  prose_not_contains:
    - AppAssistantResult
    - Structured Output
    - linked-and-delivered
    - Blocking Issue
```

- [ ] **Step 3: Add a source-delivery manual-validation fixture**

Use the same two-link shape with `部署成功，待浏览器访问确认`, `request_intent = source_app_delivery` represented by fixture intent, a running frontend, and one short browser validation note. Keep the existing promotion-oriented manual-validation fixture unchanged and structured.

- [ ] **Step 4: Run the app-assistant evals and verify RED**

Run:

```bash
python3 rainbond-app-assistant/scripts/run_app_assistant_evals.py
```

Expected: FAIL for the concise fixtures because the current validator requires the six structured headings and fenced YAML.

### Task 2: Add concise presentation validation

**Files:**
- Modify: `rainbond-app-assistant/scripts/validate_app_assistant_output.py`
- Test: `rainbond-app-assistant/evals/04-delivered-stop-without-promotion.*`
- Test: `rainbond-app-assistant/evals/16-source-delivered-manual-validation.*`

- [ ] **Step 1: Select validation mode before structured parsing**

Load the expected fixture before parsing headings. Use `presentation_mode: concise` only for concise fixtures; default to `structured` so all existing fixtures retain current behavior.

```python
presentation_mode = (expected or {}).get("presentation_mode", "structured")
if presentation_mode == "concise":
    return validate_concise_response(response_text, expected or {})
if presentation_mode != "structured":
    return [f"unsupported presentation_mode: {presentation_mode!r}"]
```

- [ ] **Step 2: Implement strict concise-response validation**

Require exactly the headings `### 部署结果` and `### 运行状态`. Reject fenced YAML, `### Structured Output`, `AppAssistantResult`, internal orchestration/runtime/delivery enum names, and the structured-only headings. Require Markdown links for both `部署位置` and `访问地址`, plus non-empty application and environment lines.

```python
CONCISE_SUCCESS_HEADINGS = ["### 部署结果", "### 运行状态"]

def validate_concise_response(response_text: str, expected: dict[str, Any]) -> list[str]:
    errors = validate_concise_shape(response_text)
    errors.extend(validate_expected_prose(response_text, expected))
    return errors
```

Extract the existing `prose_contains` and `prose_not_contains` loops into a helper that works for both presentation modes.

- [ ] **Step 3: Run the focused evals and verify GREEN**

Run:

```bash
python3 rainbond-app-assistant/scripts/validate_app_assistant_output.py \
  rainbond-app-assistant/evals/04-delivered-stop-without-promotion.response.md \
  --expected rainbond-app-assistant/evals/04-delivered-stop-without-promotion.expected.yaml
python3 rainbond-app-assistant/scripts/validate_app_assistant_output.py \
  rainbond-app-assistant/evals/16-source-delivered-manual-validation.response.md \
  --expected rainbond-app-assistant/evals/16-source-delivered-manual-validation.expected.yaml
```

Expected: both PASS.

- [ ] **Step 4: Verify structured non-success output is unchanged**

Run fixtures `07-cluster-capacity-blocked`, `08-code-build-handoff-stop`, and `06-manual-validation-stop`. Expected: all PASS through structured mode.

### Task 3: Add the deployment location to the internal contract

**Files:**
- Modify: `rainbond-app-assistant/schemas/app-assistant-result.schema.yaml`
- Modify: `rainbond-app-assistant/evals/*.response.md` structured YAML fixtures
- Modify: `rainbond-app-assistant/evals/*.expected.yaml` where location behavior is asserted

- [ ] **Step 1: Add the required nullable project field**

Add `deployment_location_url` to `project.required` and define it with `nullable_non_empty_string`.

```yaml
project:
  required:
    - identity
    - linked
    - selected_environment
    - deployment_location_url
  properties:
    deployment_location_url:
      $ref: "#/$defs/nullable_non_empty_string"
```

- [ ] **Step 2: Update structured fixtures mechanically**

Set a trusted Console route for fixtures with a fully resolved identity and `null` for identity-ambiguous fixtures. Use this route shape:

```text
https://run.rainbond.com/#/team/<team>/region/<region>/apps/<app_id>/overview
```

Do not derive this field from `preferred_access_url`.

- [ ] **Step 3: Add cross-field validation for concise eligibility**

For internal successful/manual-validation source results, allow a null deployment location only in structured mode. Concise fixtures must contain the management link and public service link in prose.

- [ ] **Step 4: Run all app-assistant evals**

Run:

```bash
python3 rainbond-app-assistant/scripts/run_app_assistant_evals.py
```

Expected: all fixtures PASS.

- [ ] **Step 5: Commit the executable contract change**

```bash
git add rainbond-app-assistant/evals rainbond-app-assistant/schemas rainbond-app-assistant/scripts
git commit -m "feat: add concise successful delivery output"
```

### Task 4: Update the skill and canonical documentation

**Files:**
- Modify: `rainbond-app-assistant/SKILL.md`
- Modify: `docs/product-object-model.md`

- [ ] **Step 1: Expand concise-mode eligibility**

Require `request_intent = source_app_delivery`, healthy runtime, no blocker, a real `deployment_location_url`, and a real `preferred_access_url`. Permit both `delivered/verified` and `delivered-but-needs-manual-validation` when only browser confirmation remains.

- [ ] **Step 2: Define the successful response fields**

Require application name, environment, deployment result, Rainbond management link, public service link, essential component status, HTTP evidence, and at most one manual validation note. Explicitly forbid default YAML and internal state/action narration for eligible success output.

- [ ] **Step 3: Preserve detailed output for every other state**

State explicitly that building, unhealthy, blocked, ambiguous, handoff, and incomplete promotion results continue using the existing detailed structured contract mode.

- [ ] **Step 4: Document URL provenance**

Build `deployment_location_url` only from trusted Console base context plus URL-encoded team, region, and app ID. Continue requiring `preferred_access_url` to come verbatim from gateway `access_infos` evidence.

- [ ] **Step 5: Align the product object model**

Document `project.deployment_location_url` and revise the dual-output convention so structured YAML is default for non-success and machine consumers, while eligible successful source delivery is concise by default.

- [ ] **Step 6: Run the complete app-assistant eval suite**

Run:

```bash
python3 rainbond-app-assistant/scripts/run_app_assistant_evals.py
```

Expected: all fixtures PASS.

- [ ] **Step 7: Commit the skill behavior**

```bash
git add rainbond-app-assistant/SKILL.md docs/product-object-model.md
git commit -m "docs: simplify successful deployment reports"
```

### Task 5: Verify the packaged project

**Files:**
- Verify only; no planned production changes

- [ ] **Step 1: Run formatting and syntax checks**

```bash
git diff --check
python3 -m py_compile rainbond-app-assistant/scripts/validate_app_assistant_output.py
```

Expected: both exit 0.

- [ ] **Step 2: Run the repository test suite**

```bash
npm test
```

Expected: all npm test stages PASS. Use a Python environment containing PyYAML; do not treat a missing local `yaml` module as a product-code failure.

- [ ] **Step 3: Inspect the final diff**

Confirm no `package.json` or release-version change is included in the implementation branch, no secrets are present, and non-success fixtures retain detailed output.

- [ ] **Step 4: Commit any verification-only fixture corrections**

Only if verification exposed contract fixture omissions:

```bash
git add rainbond-app-assistant docs/product-object-model.md
git commit -m "test: align delivery output fixtures"
```
