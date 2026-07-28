# Self-hosted Rainbond Installation Hint Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show an unmistakable, non-blocking Rainbond installation prerequisite and official quick-install command before the interactive self-hosted Console URL prompt.

**Architecture:** Keep deployment selection and subsequent authorization unchanged. Add one presentation-only Bash helper, call it exclusively from the interactive self-hosted menu branch, and cover the behavior through the existing PTY installer test plus a SaaS regression assertion.

**Tech Stack:** Bash, Python PTY test harness, npm package tests, Markdown.

---

### Task 1: Add the self-hosted prerequisite banner with TDD

**Files:**
- Modify: `tests/install.sh.test:17-38,491-504`
- Modify: `install.sh:786-829`

- [x] **Step 1: Extend the existing PTY test with failing banner assertions**

Add an ordering helper near the existing assertion helpers:

```bash
assert_appears_before() {
  local path="$1"
  local first="$2"
  local second="$3"
  python3 - "$path" "$first" "$second" <<'PY'
import sys

path, first, second = sys.argv[1:4]
with open(path, encoding="utf-8", errors="replace") as fh:
    content = fh.read()

first_index = content.find(first)
second_index = content.find(second)
if first_index < 0 or second_index < 0 or first_index >= second_index:
    raise SystemExit("expected {!r} before {!r}".format(first, second))
PY
}
```

Extend `test_interactive_prompts_are_visible`:

```bash
  assert_contains "$output_file" "[重要] 私有化部署需要先准备一个可访问的 Rainbond 环境"
  assert_contains "$output_file" "curl -o install.sh https://get.rainbond.com && bash ./install.sh"
  assert_contains "$output_file" "https://www.rainbond.com/docs/quick-start/quick-install/"
  assert_appears_before "$output_file" \
    "[重要] 私有化部署需要先准备一个可访问的 Rainbond 环境" \
    "Rainbond Console 地址: "
```

Add a non-interactive SaaS regression test to prove the helper is not emitted outside interactive self-hosted selection:

```bash
test_saas_mode_does_not_show_self_hosted_install_hint() {
  local tmpdir token output_file
  tmpdir="$(mktemp -d)"
  output_file="$tmpdir/saas.out"
  trap 'rm -rf "$tmpdir"' RETURN
  mkdir -p "$tmpdir/home" "$tmpdir/logs"
  make_fake_commands "$tmpdir/bin"
  token="$(make_test_jwt 1893456000)"

  run_installer "$tmpdir" codex --non-interactive --saas --token "$token" --force \
    >"$output_file" 2>&1

  assert_not_contains "$output_file" "[重要] 私有化部署需要先准备一个可访问的 Rainbond 环境"
}
```

Register the new test beside the existing interactive prompt test at the bottom of `tests/install.sh.test`.

- [x] **Step 2: Run the installer suite and verify RED**

Run:

```bash
python3 tests/install_test_suite_tty_test.py
```

Expected: `FAIL` because the interactive output does not yet contain `[重要] 私有化部署需要先准备一个可访问的 Rainbond 环境`.

- [x] **Step 3: Add the minimal banner implementation**

Add immediately before `resolve_deployment_mode`:

```bash
show_self_hosted_install_hint() {
  log ""
  log "============================================================"
  log "[重要] 私有化部署需要先准备一个可访问的 Rainbond 环境"
  log ""
  log "如果尚未安装 Rainbond，请在目标机器执行快速安装命令："
  log "  curl -o install.sh https://get.rainbond.com && bash ./install.sh"
  log ""
  log "安装完成后，请使用安装脚本输出的 Console 地址继续下面的配置。"
  log "安装文档：https://www.rainbond.com/docs/quick-start/quick-install/"
  log "============================================================"
  log ""
}
```

Invoke it only in the interactive `2)` branch:

```bash
      2)
        DEPLOYMENT_MODE_INPUT="self-hosted"
        show_self_hosted_install_hint
        return 0
        ;;
```

- [x] **Step 4: Run syntax and focused tests and verify GREEN**

Run:

```bash
bash -n install.sh
python3 tests/install_test_suite_tty_test.py
```

Expected: syntax check exits `0`; installer PTY suite prints `PASS: install.sh test suite is TTY-safe`.

### Task 2: Document, verify, and package the behavior

**Files:**
- Modify: `README.md:115-129`
- Generated artifact: `rainskills-0.1.0-rc.0.tgz`

- [x] **Step 1: Update the self-hosted installation documentation**

Change the self-hosted bullet to:

```markdown
  - **私有化部署**：你自己输入 Console 地址；交互选择后会先醒目提示 Rainbond 前置条件、官方快速安装命令和安装文档，但不会中断 RainSkills 流程
```

- [x] **Step 2: Run the complete validation suite**

Run with Node 24 so package and real npx tests use a supported runtime:

```bash
PATH="/Applications/ChatGPT.app/Contents/Resources/cua_node/bin:$PATH" npm test
git diff --check
```

Expected: all launcher, package, installer, signal, and npx PTY tests pass; `git diff --check` exits `0`.

- [x] **Step 3: Rebuild the local npm tarball**

Run:

```bash
PATH="/Applications/ChatGPT.app/Contents/Resources/cua_node/bin:$PATH" npm pack
```

Expected: `rainskills-0.1.0-rc.0.tgz` is regenerated from the updated `install.sh` and README.

- [x] **Step 4: Commit the implementation**

```bash
git add install.sh tests/install.sh.test README.md docs/superpowers/plans/2026-07-28-self-hosted-rainbond-install-hint.md
git commit -m "feat: show self-hosted Rainbond install guidance"
```

- [x] **Step 5: Hand off the manual verification path**

Run:

```bash
npx --yes --package="$PWD/rainskills-0.1.0-rc.0.tgz" rainskills
```

Choose `Codex`, then `私有化部署`. Expected: the banner appears before `Rainbond Console 地址`; the user can press `Ctrl+C` at the address prompt for a no-configuration UX check or enter a working Console URL for a full authorization test.
