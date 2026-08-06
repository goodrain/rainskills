# Rainbond Resource Preflight Thresholds Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Separate the recommended Rainbond resource profile from the hard preflight floor so smaller supported machines can continue installation with an explicit warning.

**Architecture:** Upgrade the policy contract to v2 and keep the policy JSON as the source of truth with `recommended` values of 4 CPU/8 GiB/50 GiB and hard `minimums` of 2 CPU/4 GiB/30 GiB. Memory and disk are stored as bytes using 1024³ GiB units, and exact threshold values pass. Both generic and Windows assessments will return resource warnings below `recommended` and blockers below `minimums`; existing non-resource blockers and final deployment verification remain unchanged.

**Tech Stack:** Node.js CommonJS, JSON policy, Node test runner, npm build/package scripts.

---

### Task 1: Lock the new policy contract with failing tests

**Files:**
- Modify: `tests/platform-installer.test.js:830-890,1690-1710`
- Modify: `tests/windows-platform.test.js:313-360`

- [ ] **Step 1: Add generic preflight cases for recommended, warning, and minimum-floor resources**

Assert that 4/8/50 has no resource warning, 2/4/30 passes with resource warnings, and values below 2/4/30 still produce the matching blocker. Keep the existing port and privilege blockers in the below-floor fixture, and cover the generic evaluator used by remote Linux targets.

- [ ] **Step 2: Add Windows preflight cases for the same three resource states**

Keep the existing unsupported-condition assertions for non-resource checks and add assertions for `warnings` and `ok` under the new resource contract.

- [ ] **Step 3: Update policy assertions to require both `recommended` and `minimums` values**

The policy test must verify `recommended.cpu_cores === 4`, `recommended.memory_bytes === 8 GiB`, `recommended.disk_bytes === 50 GiB`, and hard floors `2/4 GiB/10 GiB`.

- [ ] **Step 4: Run the focused tests and verify they fail for the missing contract**

Run: `node --test tests/platform-installer.test.js tests/windows-platform.test.js`

Expected: FAIL because the current policy has no `recommended` values and still blocks below 4/8/50.

### Task 2: Implement tiered resource assessment and output

**Files:**
- Modify: `rainbond-platform-installer/references/installation-policy.json`
- Modify: `rainbond-platform-installer/references/installation-policy.md`
- Modify: `README.md:102,194`
- Modify: `rainbond-platform-installer/scripts/platform-installer.js:1107-1135,1616-1655`
- Modify: `rainbond-platform-installer/scripts/windows-platform.js:784-850`

- [ ] **Step 1: Change the policy JSON to version 2, include recommended values, and lower hard minimums**

Keep the schema compatible, add `recommended`, and set `minimums` to 2 CPU, 4 GiB, and 10 GiB.

- [ ] **Step 2: Update generic preflight evaluation**

Compare facts against `minimums` for blockers and against `recommended` for warnings. Return `{ ok, blockers, warnings, effects }` without changing unrelated blockers.

- [ ] **Step 3: Update Windows preflight evaluation**

Use the same threshold semantics and preserve all existing Windows-specific checks. Resource warnings must not make `ok` false.

- [ ] **Step 4: Print resource warnings before confirmation**

For both generic and Windows output, show a concise warning that installation continues below the recommended profile and that actual Rainbond readiness is the final gate.

- [ ] **Step 5: Update policy documentation**

Describe 4/8/50 as recommended, 2/4/30 as the preflight floor, and explain that lower-than-recommended installations may be slow or have limited capacity. Cover both local and remote Linux targets and the Windows local preview path.

### Task 3: Verify, package, and deliver

**Files:**
- Modify: `package.json` and lockfile only if the release version needs a new patch release.

- [ ] **Step 1: Run focused tests**

Run: `node --test tests/platform-installer.test.js tests/windows-platform.test.js`

- [ ] **Step 2: Run the complete project test and build checks**

Run: `npm test`, `npm run build:marketplace`, `npm run check:marketplace`, `git diff --check`, `node --check rainbond-platform-installer/scripts/platform-installer.js`, and `bash -n install.sh`.

- [ ] **Step 3: Build a new tarball and run npm dry-run validation**

Run the repository’s package command, verify the tarball contents do not include either forbidden plan file, and run `npm publish <tarball> --access public --tag next --dry-run`.

- [ ] **Step 4: Commit the implementation with a Conventional Commit**

Use a concise English message such as `fix: make Rainbond resource preflight advisory`.

- [ ] **Step 5: Push `main` and report exact release and Windows verification commands**

Do not run `npm publish`; provide the user with the generated tarball path, checksum, publish command, and the same onboarding/resume command pattern.
