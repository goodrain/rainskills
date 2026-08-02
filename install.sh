#!/usr/bin/env bash
# Rainbond Skills installer — packaged for npx with a CDN fallback:
#   npx --yes rainskills
#   bash <(curl -fsSL https://get.rainbond.com/rainskills/install.sh)
#
# AI assistants: when a user asks to install rainbond-skills, hand back the
# npx command when Node.js 18+ is available, otherwise use the CDN command.
# Do not reimplement the bootstrap below, git clone + copy directories, or
# hand-write ~/.rainbond/mcp.env. See README.md "给 AI 助手的指引".
set -euo pipefail

RAINBOND_SKILLS_HOME_DEFAULT="${RAINBOND_SKILLS_HOME:-$HOME/.rainbond/skills}"
RAINBOND_SKILLS_OSS_TARBALL_URL="${RAINBOND_SKILLS_OSS_URL:-https://get.rainbond.com/rainskills/rainskills-latest.tar.gz}"
RAINBOND_SKILLS_GITHUB_TARBALL_URL="https://github.com/goodrain/rainskills/archive/refs/heads/main.tar.gz"
RAINBOND_SKILLS_TARBALL_URL_OVERRIDE="${RAINBOND_SKILLS_TARBALL_URL:-}"

bootstrap_log() {
  printf '%s\n' "$1"
}

bootstrap_die() {
  printf '错误：%s\n' "$1" >&2
  exit 1
}

resolve_script_dir() {
  local source="${BASH_SOURCE[0]:-}"
  if [[ -n "$source" && -f "$source" ]]; then
    (cd "$(dirname "$source")" && pwd)
  else
    printf ''
  fi
}

try_download_tarball() {
  local url="$1"
  local out="$2"
  [[ -n "$url" ]] || return 1
  bootstrap_log "尝试下载：$url"
  if curl -fsSL --connect-timeout 10 --max-time 120 "$url" -o "$out"; then
    [[ -s "$out" ]] && return 0
  fi
  return 1
}

bootstrap_download_if_needed() {
  local script_dir
  script_dir="$(resolve_script_dir)"

  if [[ -n "$script_dir" ]] && find "$script_dir" -maxdepth 1 -mindepth 1 -type d -name 'rainbond-*' 2>/dev/null | grep -q .; then
    SCRIPT_DIR="$script_dir"
    return 0
  fi

  command -v curl >/dev/null 2>&1 \
    || bootstrap_die "需要 curl 才能下载 rainskills 仓库。请先安装 curl。"
  command -v tar >/dev/null 2>&1 \
    || bootstrap_die "需要 tar 才能解压 rainskills 仓库。"

  local install_root="$RAINBOND_SKILLS_HOME_DEFAULT"
  local tarball="${install_root}.download.tar.gz"

  mkdir -p "$(dirname "$install_root")"
  mkdir -p "$install_root"
  rm -f "$tarball"

  # 下载源优先级：用户显式覆盖 > OSS（国内快） > GitHub（海外/兜底）
  local downloaded_from=""
  for candidate in \
      "$RAINBOND_SKILLS_TARBALL_URL_OVERRIDE" \
      "$RAINBOND_SKILLS_OSS_TARBALL_URL" \
      "$RAINBOND_SKILLS_GITHUB_TARBALL_URL"; do
    if try_download_tarball "$candidate" "$tarball"; then
      downloaded_from="$candidate"
      break
    fi
  done

  if [[ -z "$downloaded_from" ]]; then
    bootstrap_die "所有 tarball 源都拉不下来。可手工执行：
  curl -fsSL $RAINBOND_SKILLS_GITHUB_TARBALL_URL | tar -xz --strip-components=1 -C $install_root"
  fi

  bootstrap_log "解压到：${install_root}（来源：${downloaded_from}）"
  tar -xzf "$tarball" --strip-components=1 -C "$install_root" \
    || bootstrap_die "解压 tarball 失败：$tarball"
  rm -f "$tarball"

  local target_script="$install_root/install.sh"
  [[ -f "$target_script" ]] \
    || bootstrap_die "下载后未找到 $target_script"
  chmod +x "$target_script" 2>/dev/null || true

  bootstrap_log "切换到 $target_script 继续执行……"
  if [[ -r /dev/tty ]]; then
    exec bash "$target_script" "$@" </dev/tty
  else
    exec bash "$target_script" "$@"
  fi
}

should_skip_bootstrap_for_refresh() {
  local arg
  for arg in "$@"; do
    case "$arg" in
      refresh)
        return 0
        ;;
      --)
        return 1
        ;;
    esac
  done
  return 1
}

if should_skip_bootstrap_for_refresh "$@"; then
  SCRIPT_DIR=""
else
  bootstrap_download_if_needed "$@"
fi

DEFAULT_TARGET="all"
ACTION=""
TARGET=""
FORCE=0
CUSTOM_DEST=""
INSTALL_COUNT_NEW=0
INSTALL_COUNT_UPDATED=0
INSTALL_COUNT_UNCHANGED=0
INSTALL_COUNT_FORCED=0
SKIP_MCP=0
NON_INTERACTIVE=0
ALLOW_INSECURE_HTTP=0
NO_BROWSER=0
if [[ "${RAINSKILLS_NO_BROWSER:-}" == "1" ]]; then
  NO_BROWSER=1
fi
RAINBOND_URL_INPUT="${RAINBOND_URL:-}"
RAINBOND_USERNAME_INPUT="${RAINBOND_USERNAME:-}"
RAINBOND_PASSWORD_INPUT="${RAINBOND_PASSWORD:-}"
RAINBOND_TOKEN_INPUT="${RAINBOND_JWT:-}"
RAINBOND_TOKEN_FROM_FLAG=0
RAINBOND_URL_FROM_FLAG=0
RAINBOND_CACHED_URL="${RAINBOND_URL:-}"
DEPLOYMENT_MODE_INPUT=""
SELF_HOSTED_PATH_RESOLVED=0
RAINSKILLS_INSTALL_DEFERRED=0
SAAS_DEFAULT_URL="https://run.rainbond.com"
LOGIN_TIMEOUT="${RAINBOND_LOGIN_TIMEOUT:-300}"
JWT_MIN_TTL_SECONDS="${RAINBOND_JWT_MIN_TTL_SECONDS:-600}"
ACTIVE_SHELL_RC=""
VALIDATED_TOKEN=""
OBTAINED_RAINBOND_TOKEN=""
RAINSKILLS_INSTALL_REPORT_URL="https://log.rainbond.com/api/rainskills/installations"
RAINSKILLS_INSTALL_ATTEMPT_ID=""
RAINSKILLS_INSTALL_EID=""
RAINSKILLS_INSTALL_CLIENT="unknown"
RAINSKILLS_INSTALL_ACTION="install"
RAINSKILLS_INSTALL_FAILURE_STAGE="bootstrap"
RAINSKILLS_INSTALL_FAILURE_CATEGORY="invalid_arguments"
RAINSKILLS_INSTALL_TERMINAL_REPORTED=0
RAINSKILLS_BROWSER_LOGIN_SERVER_PID=""
RAINSKILLS_BROWSER_LOGIN_READER_PID=""
RAINSKILLS_BROWSER_LOGIN_RESULT_FILE=""

usage() {
  cat <<'EOF'
Usage:
  npx --yes rainskills [target] [options]
  ./install.sh
  ./install.sh claude
  ./install.sh codex
  ./install.sh all
  ./install.sh --dest <path>
  ./install.sh all --saas
  ./install.sh all --self-hosted --rainbond-url <url>
  ./install.sh all --non-interactive --rainbond-url <url> --token <jwt>
  ./install.sh refresh

Options:
  claude                 Install and configure Claude Code
  codex                  Install and configure Codex
  all                    Install and configure both platforms
  refresh                Re-run browser login and rewrite ~/.rainbond/mcp.env only
                         (skips skill copy and Codex/Claude MCP re-registration;
                          use when MCP returns 401/403 because the JWT expired —
                          remember to restart Claude Code / Codex afterwards)
  --dest PATH            Install skills to a custom directory only
  --force                Overwrite existing installed skills
  --skip-mcp             Skip Rainbond MCP setup
  --saas                 Use Rainbond Cloud (https://run.rainbond.com)
  --self-hosted          Use a self-hosted Rainbond Console (requires --rainbond-url)
  --non-interactive      Require all installer inputs through flags or env vars
  --rainbond-url URL     Rainbond base URL, for example http://example.com:7070
  --token JWT            Use an existing Rainbond JWT, skip browser login
  --no-browser           Do not open a local browser; paste the callback URL
  --no-cached-token      Ignore RAINBOND_JWT inherited from the shell and re-login
  --username NAME        Legacy: Rainbond login username (self-hosted only)
  --allow-insecure-http  Allow plain HTTP for internal trial environments
  -h, --help             Show this help message

Environment:
  RAINBOND_URL           Same as --rainbond-url
  RAINBOND_JWT           Same as --token (preferred for CI)
  RAINBOND_USERNAME      Legacy: same as --username
  RAINBOND_PASSWORD      Legacy: Rainbond login password for non-interactive runs
  RAINBOND_LOGIN_TIMEOUT Browser login timeout in seconds (default 300)
  RAINSKILLS_NO_BROWSER  Set to 1 to force callback URL copy mode
EOF
}

log() {
  printf '%s\n' "$1"
}

warn() {
  printf '警告：%s\n' "$1" >&2
}

new_rainskills_install_attempt_id() {
  if command -v python3 >/dev/null 2>&1; then
    python3 - <<'PY'
import uuid

print(uuid.uuid4().hex)
PY
    return 0
  fi
  printf '%s-%s-%s\n' "$(date +%s)" "$$" "${RANDOM:-0}"
}

rainskills_install_client_for_target() {
  case "$1" in
    codex)
      printf 'codex\n'
      ;;
    claude)
      printf 'claude_code\n'
      ;;
    all)
      printf 'both\n'
      ;;
    *)
      printf 'unknown\n'
      ;;
  esac
}

report_rainskills_installation() {
  local phase="$1"
  local status="$2"
  local failure_stage="${3:-}"
  local failure_category="${4:-}"

  [[ -n "$RAINSKILLS_INSTALL_ATTEMPT_ID" ]] || return 0
  if [[ "$phase" == "authorized" || "$phase" == "configured" ]]; then
    [[ -n "$RAINSKILLS_INSTALL_EID" ]] || return 0
  fi
  command -v curl >/dev/null 2>&1 || return 0
  command -v python3 >/dev/null 2>&1 || return 0

  local payload
  payload="$(
    python3 - \
      "$RAINSKILLS_INSTALL_ATTEMPT_ID" \
      "$RAINSKILLS_INSTALL_EID" \
      "$RAINSKILLS_INSTALL_CLIENT" \
      "$RAINSKILLS_INSTALL_ACTION" \
      "$phase" \
      "$status" \
      "$failure_stage" \
      "$failure_category" <<'PY'
import json
import sys

keys = (
    "install_attempt_id",
    "eid",
    "install_client",
    "action",
    "phase",
    "status",
    "failure_stage",
    "failure_category",
)
print(json.dumps(dict(zip(keys, sys.argv[1:])), separators=(",", ":")))
PY
  )" || return 0

  (
    curl \
      --silent \
      --show-error \
      --connect-timeout 2 \
      --max-time 3 \
      -X POST \
      "$RAINSKILLS_INSTALL_REPORT_URL" \
      -H 'Content-Type: application/json' \
      --data-binary "$payload" \
      >/dev/null 2>&1 || true
  ) &
}

initialize_rainskills_installation_reporting() {
  local arg target=""
  RAINSKILLS_INSTALL_ATTEMPT_ID="$(new_rainskills_install_attempt_id)"
  for arg in "$@"; do
    case "$arg" in
      refresh)
        RAINSKILLS_INSTALL_ACTION="refresh"
        ;;
      codex|claude|all)
        target="$arg"
        ;;
    esac
  done
  RAINSKILLS_INSTALL_CLIENT="$(rainskills_install_client_for_target "$target")"
  report_rainskills_installation "started" "started"
}

resolve_rainskills_enterprise_id() {
  local base_url="$1"
  local token="$2"
  local response_file http_code eid
  response_file="$(mktemp)"
  http_code="$({
    curl \
      --silent \
      --show-error \
      --connect-timeout 2 \
      --max-time 5 \
      --output "$response_file" \
      --write-out '%{http_code}' \
      "${base_url}/console/users/details" \
      -H "Authorization: GRJWT ${token}"
  } 2>/dev/null || true)"

  if [[ ! "$http_code" =~ ^2 ]]; then
    rm -f "$response_file"
    return 1
  fi

  eid="$({
    python3 - "$response_file" <<'PY'
import json
import sys

try:
    with open(sys.argv[1], "r", encoding="utf-8") as fh:
        payload = json.load(fh)
except Exception:
    raise SystemExit(1)

eid = (((payload.get("data") or {}).get("bean") or {}).get("enterprise_id"))
if not isinstance(eid, str) or not eid.strip():
    raise SystemExit(1)
print(eid.strip())
PY
  } 2>/dev/null || true)"
  rm -f "$response_file"
  [[ -n "$eid" ]] || return 1
  printf '%s\n' "$eid"
}

record_rainskills_authorization() {
  local base_url="$1"
  local token="$2"
  local eid
  eid="$(resolve_rainskills_enterprise_id "$base_url" "$token" || true)"
  [[ -n "$eid" ]] || return 0
  RAINSKILLS_INSTALL_EID="$eid"
  report_rainskills_installation "authorized" "success"
}

set_rainskills_failure_context() {
  RAINSKILLS_INSTALL_FAILURE_STAGE="$1"
  RAINSKILLS_INSTALL_FAILURE_CATEGORY="$2"
}

report_unhandled_rainskills_installation_failure() {
  local exit_status="$1"
  if [[ "$exit_status" -ne 0 && \
        "${BASH_SUBSHELL:-0}" -eq 0 && \
        "$RAINSKILLS_INSTALL_TERMINAL_REPORTED" -eq 0 ]]; then
    RAINSKILLS_INSTALL_TERMINAL_REPORTED=1
    report_rainskills_installation \
      "failed" \
      "failure" \
      "$RAINSKILLS_INSTALL_FAILURE_STAGE" \
      "$RAINSKILLS_INSTALL_FAILURE_CATEGORY"
  fi
}

cleanup_browser_login() {
  local process_id

  for process_id in \
      "$RAINSKILLS_BROWSER_LOGIN_READER_PID" \
      "$RAINSKILLS_BROWSER_LOGIN_SERVER_PID"; do
    if [[ -n "$process_id" ]] && kill -0 "$process_id" 2>/dev/null; then
      kill "$process_id" 2>/dev/null || true
    fi
  done

  for process_id in \
      "$RAINSKILLS_BROWSER_LOGIN_READER_PID" \
      "$RAINSKILLS_BROWSER_LOGIN_SERVER_PID"; do
    if [[ -n "$process_id" ]]; then
      wait "$process_id" 2>/dev/null || true
    fi
  done

  if [[ -n "$RAINSKILLS_BROWSER_LOGIN_RESULT_FILE" ]]; then
    rm -f \
      "$RAINSKILLS_BROWSER_LOGIN_RESULT_FILE" \
      "${RAINSKILLS_BROWSER_LOGIN_RESULT_FILE}.port" \
      "${RAINSKILLS_BROWSER_LOGIN_RESULT_FILE}.err"
  fi

  RAINSKILLS_BROWSER_LOGIN_READER_PID=""
  RAINSKILLS_BROWSER_LOGIN_SERVER_PID=""
  RAINSKILLS_BROWSER_LOGIN_RESULT_FILE=""
}

handle_installer_signal() {
  local exit_code="$1"
  trap - INT TERM
  cleanup_browser_login
  exit "$exit_code"
}

handle_installer_exit() {
  local exit_code="$1"
  cleanup_browser_login
  report_unhandled_rainskills_installation_failure "$exit_code"
}

die() {
  if [[ "${BASH_SUBSHELL:-0}" -eq 0 && "$RAINSKILLS_INSTALL_TERMINAL_REPORTED" -eq 0 ]]; then
    RAINSKILLS_INSTALL_TERMINAL_REPORTED=1
    report_rainskills_installation \
      "failed" \
      "failure" \
      "$RAINSKILLS_INSTALL_FAILURE_STAGE" \
      "$RAINSKILLS_INSTALL_FAILURE_CATEGORY"
  fi
  printf '错误：%s\n' "$1" >&2
  exit 1
}

trim() {
  printf '%s' "$1" | awk '{$1=$1; print}'
}

validate_skill_dir() {
  local skill_dir="$1"
  local skill_file="$skill_dir/SKILL.md"

  if [[ ! -f "$skill_file" ]]; then
    log "[invalid] $skill_dir 缺少 SKILL.md"
    return 1
  fi

  if ! awk '
    NR == 1 {
      if ($0 != "---") {
        exit 1
      }
      next
    }
    NR <= 20 {
      if ($0 ~ /^name:[[:space:]]*[^[:space:]].*$/) {
        has_name = 1
      }
      if ($0 ~ /^description:[[:space:]]*[^[:space:]].*$/) {
        has_description = 1
      }
      if ($0 == "---") {
        has_closing = 1
      }
    }
    END {
      if (!(has_name && has_description && has_closing)) {
        exit 1
      }
    }
  ' "$skill_file"; then
    log "[invalid] $skill_file 必须包含带 name 和 description 的标准 YAML frontmatter"
    return 1
  fi
}

copy_skill() {
  local src="$1"
  local dest_root="$2"
  local skill_name
  skill_name="$(basename "$src")"
  local dest="$dest_root/$skill_name"

  mkdir -p "$dest_root"

  if [[ ! -e "$dest" ]]; then
    cp -R "$src" "$dest"
    log "[install] 已安装到 $dest"
    INSTALL_COUNT_NEW=$((INSTALL_COUNT_NEW + 1))
    return 0
  fi

  if [[ "$FORCE" -eq 1 ]]; then
    rm -rf "$dest"
    cp -R "$src" "$dest"
    log "[overwrite] 已强制覆盖 $dest"
    INSTALL_COUNT_FORCED=$((INSTALL_COUNT_FORCED + 1))
    return 0
  fi

  if diff -rq "$src" "$dest" >/dev/null 2>&1; then
    log "[skip] $dest 已是最新"
    INSTALL_COUNT_UNCHANGED=$((INSTALL_COUNT_UNCHANGED + 1))
    return 0
  fi

  # diff -rq 在有差异时退出码非零；与 `set -e + pipefail` 共存需要 || true 兜底
  local changed_files
  changed_files="$( { diff -rq "$src" "$dest" 2>/dev/null || true; } | wc -l | tr -d ' ')"
  rm -rf "$dest"
  cp -R "$src" "$dest"
  log "[update] 已更新 ${dest}（${changed_files} 项变化，本地修改已被覆盖）"
  INSTALL_COUNT_UPDATED=$((INSTALL_COUNT_UPDATED + 1))
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      refresh)
        ACTION="refresh"
        shift
        ;;
      claude|codex|all)
        TARGET="$1"
        shift
        ;;
      --dest)
        [[ $# -ge 2 ]] || die "--dest 需要一个路径值"
        CUSTOM_DEST="$2"
        shift 2
        ;;
      --force)
        FORCE=1
        shift
        ;;
      --skip-mcp)
        SKIP_MCP=1
        shift
        ;;
      --non-interactive)
        NON_INTERACTIVE=1
        shift
        ;;
      --rainbond-url)
        [[ $# -ge 2 ]] || die "--rainbond-url 需要一个值"
        RAINBOND_URL_INPUT="$2"
        RAINBOND_URL_FROM_FLAG=1
        shift 2
        ;;
      --no-cached-token)
        RAINBOND_TOKEN_INPUT=""
        RAINBOND_CACHED_URL=""
        shift
        ;;
      --no-browser)
        NO_BROWSER=1
        shift
        ;;
      --saas)
        DEPLOYMENT_MODE_INPUT="saas"
        shift
        ;;
      --self-hosted)
        DEPLOYMENT_MODE_INPUT="self-hosted"
        shift
        ;;
      --token)
        [[ $# -ge 2 ]] || die "--token 需要一个值"
        RAINBOND_TOKEN_INPUT="$2"
        RAINBOND_TOKEN_FROM_FLAG=1
        shift 2
        ;;
      --username)
        [[ $# -ge 2 ]] || die "--username 需要一个值"
        RAINBOND_USERNAME_INPUT="$2"
        shift 2
        ;;
      --allow-insecure-http)
        ALLOW_INSECURE_HTTP=1
        shift
        ;;
      -h|--help)
        usage
        exit 0
        ;;
      *)
        die "未知参数：$1"
        ;;
    esac
  done
}

resolve_target() {
  if [[ -n "$CUSTOM_DEST" ]]; then
    return 0
  fi

  if [[ -n "$TARGET" ]]; then
    return 0
  fi

  if [[ "$NON_INTERACTIVE" -eq 1 || ! -t 0 ]]; then
    TARGET="$DEFAULT_TARGET"
    return 0
  fi

  log "请选择要安装和配置的平台："
  log "  1) Codex"
  log "  2) Claude Code"
  log "  3) 两者都要"

  while true; do
    printf '请输入选项 [1-3]: '
    read -r choice
    case "$choice" in
      1)
        TARGET="codex"
        return 0
        ;;
      2)
        TARGET="claude"
        return 0
        ;;
      3|"")
        TARGET="all"
        return 0
        ;;
      *)
        log "请输入 1、2 或 3。"
        ;;
    esac
  done
}

collect_destinations() {
  local destinations=()

  if [[ -n "$CUSTOM_DEST" ]]; then
    destinations+=("$CUSTOM_DEST")
  else
    case "$TARGET" in
      claude)
        destinations+=("$HOME/.claude/skills")
        ;;
      codex)
        destinations+=("$HOME/.codex/skills")
        ;;
      all)
        destinations+=("$HOME/.claude/skills")
        destinations+=("$HOME/.codex/skills")
        ;;
      *)
        die "未知安装目标：$TARGET"
        ;;
    esac
  fi

  printf '%s\n' "${destinations[@]}"
}

normalize_rainbond_url() {
  local raw
  raw="$(trim "$1")"
  [[ -n "$raw" ]] || die "Rainbond 地址不能为空"

  if [[ "$raw" != http://* && "$raw" != https://* ]]; then
    raw="http://$raw"
  fi

  raw="${raw%/}"
  raw="${raw%/console/mcp/rainskills/codex/query}"
  raw="${raw%/console/mcp/rainskills/claude-code/query}"
  raw="${raw%/console/mcp/query}"
  raw="${raw%/console/users/login}"
  raw="${raw%/console/}"
  raw="${raw%/console}"
  raw="${raw%/}"
  printf '%s\n' "$raw"
}

prompt_for_value() {
  local prompt_text="$1"
  local current_value="$2"

  if [[ -n "$current_value" ]]; then
    printf '%s\n' "$current_value"
    return 0
  fi

  if [[ "$NON_INTERACTIVE" -eq 1 || ! -t 0 ]]; then
    die "非交互模式下必须提供${prompt_text}。"
  fi

  local value=""
  while [[ -z "$value" ]]; do
    printf '%s: ' "$prompt_text" >&2
    read -r value
    value="$(trim "$value")"
  done
  printf '%s\n' "$value"
}

# 始终向用户提问，但提供一个可回车沿用的默认值。
# 与 prompt_for_value 的区别：default_value 非空时不会静默返回，用户仍可改写。
prompt_with_default() {
  local prompt_text="$1"
  local default_value="$2"

  if [[ "$NON_INTERACTIVE" -eq 1 || ! -t 0 ]]; then
    if [[ -n "$default_value" ]]; then
      printf '%s\n' "$default_value"
      return 0
    fi
    die "非交互模式下必须提供${prompt_text}。"
  fi

  local value=""
  while [[ -z "$value" ]]; do
    if [[ -n "$default_value" ]]; then
      printf '%s [回车沿用 %s]: ' "$prompt_text" "$default_value" >&2
    else
      printf '%s: ' "$prompt_text" >&2
    fi
    read -r value
    value="$(trim "$value")"
    if [[ -z "$value" && -n "$default_value" ]]; then
      value="$default_value"
    fi
  done
  printf '%s\n' "$value"
}

prompt_for_password() {
  if [[ -n "$RAINBOND_PASSWORD_INPUT" ]]; then
    printf '%s\n' "$RAINBOND_PASSWORD_INPUT"
    return 0
  fi

  if [[ "$NON_INTERACTIVE" -eq 1 || ! -t 0 ]]; then
    die "非交互模式下必须提供 Rainbond 密码，请设置 RAINBOND_PASSWORD。"
  fi

  local password=""
  while [[ -z "$password" ]]; do
    printf 'Rainbond 密码: ' >&2
    read -r -s password
    printf '\n' >&2
  done
  printf '%s\n' "$password"
}

confirm_insecure_http_if_needed() {
  local base_url="$1"

  if [[ "$base_url" != http://* ]]; then
    return 0
  fi

  if [[ "$ALLOW_INSECURE_HTTP" -eq 1 ]]; then
    warn "当前使用明文 HTTP 连接，凭证以明文传输。"
    return 0
  fi

  if [[ "$NON_INTERACTIVE" -eq 1 || ! -t 0 ]]; then
    die "默认禁用明文 HTTP。如需继续请加 --allow-insecure-http 重新执行。"
  fi

  warn "当前 Rainbond 地址使用明文 HTTP，账号密码和 JWT 传输不会加密。"
  printf '是否继续使用明文 HTTP 连接？[y/N]: '
  read -r answer
  case "$answer" in
    y|Y|yes|YES)
      ALLOW_INSECURE_HTTP=1
      ;;
    *)
      die "已取消安装。"
      ;;
  esac
}

ensure_python3() {
  command -v python3 >/dev/null 2>&1 || die "需要 python3 来解析 JSON。"
}

show_self_hosted_install_hint() {
  log ""
  log "[RAINSKILLS_USER_INPUT_REQUIRED:rainbond_console_url]"
  log "请发送浏览器中访问 Rainbond 控制台的完整地址，例如："
  log "https://rainbond.example.com"
}

create_rainskills_onboarding_checkpoint() {
  ensure_python3
  python3 - "$HOME" "$SCRIPT_DIR" "$TARGET" <<'PY'
import json
import os
import stat
import sys
import tempfile
import uuid
from datetime import datetime, timezone

home, script_dir, target = sys.argv[1:]
state_dir = os.path.join(home, ".rainbond")
state_path = os.path.join(state_dir, "rainskills-onboarding-v1.json")

if os.path.lexists(state_dir) and os.path.islink(state_dir):
    raise SystemExit("拒绝使用符号链接状态目录：{}".format(state_dir))
if os.path.exists(state_dir):
    directory_stat = os.stat(state_dir)
else:
    os.makedirs(state_dir, mode=0o700)
    directory_stat = os.stat(state_dir)
if directory_stat.st_uid != os.getuid() or not stat.S_ISDIR(directory_stat.st_mode):
    raise SystemExit("状态目录不属于当前用户：{}".format(state_dir))
os.chmod(state_dir, 0o700)
if os.path.lexists(state_path) and os.path.islink(state_path):
    raise SystemExit("拒绝覆盖符号链接状态文件：{}".format(state_path))

package_version = "unknown"
manifest_path = os.path.join(script_dir, "package.json")
try:
    with open(manifest_path, encoding="utf-8") as manifest_file:
        package_version = json.load(manifest_file).get("version", "unknown")
except (OSError, ValueError):
    pass

operation_id = str(uuid.uuid4())
platform_state_path = os.path.join(
    state_dir, "platform-installer", operation_id, "state.json"
)
state = {
    "schema": "rainskills.onboarding.v1",
    "version": 1,
    "operation_id": operation_id,
    "package_version": package_version,
    "updated_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    "stage": "awaiting-platform",
    "target": target,
    "deployment_mode": "self-hosted",
    "platform_state_path": platform_state_path,
    "console_url": None,
}

fd, temporary_path = tempfile.mkstemp(
    prefix=".rainskills-onboarding-", dir=state_dir
)
try:
    os.fchmod(fd, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as state_file:
        json.dump(state, state_file, ensure_ascii=False, indent=2)
        state_file.write("\n")
        state_file.flush()
        os.fsync(state_file.fileno())
    os.replace(temporary_path, state_path)
    os.chmod(state_path, 0o600)
    directory_fd = os.open(state_dir, os.O_RDONLY)
    try:
        os.fsync(directory_fd)
    finally:
        os.close(directory_fd)
except BaseException:
    try:
        os.unlink(temporary_path)
    except OSError:
        pass
    raise

print(operation_id)
PY
}

defer_to_platform_installer() {
  local onboarding_id package_spec
  onboarding_id="$(create_rainskills_onboarding_checkpoint)"
  package_spec="$({
    python3 - "$SCRIPT_DIR/package.json" <<'PY'
import json
import sys

try:
    with open(sys.argv[1], encoding="utf-8") as manifest_file:
        version = json.load(manifest_file).get("version")
except (OSError, ValueError):
    version = None
print("rainskills@{}".format(version) if version else "rainskills")
PY
  } 2>/dev/null || printf 'rainskills')"
  RAINSKILLS_INSTALL_DEFERRED=1
  log ""
  log "Rainbond 平台安装将在独立步骤中继续，前面的选择已经保存。"
  log "支持 Linux 本机单机安装；macOS 将使用 OrbStack，准备时间通常更长。"
  log ""
  log "如果由 AI 代为安装，请按下面的固定参数继续；终端用户也可以直接执行："
  log "npx ${package_spec} platform install --onboarding-id ${onboarding_id}"
  python3 - "$onboarding_id" <<'PY'
import json
import sys

operation_id = sys.argv[1]
print(json.dumps({
    "schema": "rainskills.next-action.v1",
    "action": "install-platform",
    "onboarding_id": operation_id,
    "argv": ["platform", "install", "--onboarding-id", operation_id],
}, ensure_ascii=False, separators=(",", ":")))
PY
}

resolve_self_hosted_path() {
  [[ "$SELF_HOSTED_PATH_RESOLVED" -eq 0 ]] || return 0
  SELF_HOSTED_PATH_RESOLVED=1

  if [[ "$NON_INTERACTIVE" -eq 1 || ! -t 0 ]]; then
    die "非交互私有化部署必须提供 --rainbond-url；平台安装向导需要交互确认。"
  fi

  log ""
  log "你现在是否已经有可以访问的 Rainbond 平台？"
  log ""
  log "  1) 已经有，填写平台地址"
  log "  2) 还没有，帮我安装"

  while true; do
    printf '请输入选项 [1-2]: '
    read -r choice
    case "$choice" in
      1)
        show_self_hosted_install_hint
        return 0
        ;;
      2)
        defer_to_platform_installer
        return 0
        ;;
      *)
        log "请输入 1 或 2。"
        ;;
    esac
  done
}

resolve_deployment_mode() {
  if [[ -n "$DEPLOYMENT_MODE_INPUT" ]]; then
    return 0
  fi

  if [[ "$RAINBOND_URL_FROM_FLAG" -eq 1 ]]; then
    DEPLOYMENT_MODE_INPUT="self-hosted"
    return 0
  fi

  if [[ "$NON_INTERACTIVE" -eq 1 || ! -t 0 ]]; then
    if [[ -n "$RAINBOND_URL_INPUT" ]]; then
      DEPLOYMENT_MODE_INPUT="self-hosted"
      return 0
    fi
    die "非交互模式下必须指定 --saas 或 --self-hosted（搭配 --rainbond-url）。"
  fi

  log ""
  log "RainSkills 文件已安装完成。"
  log ""
  log "为了让 AI 能够创建、部署和管理应用，还需要连接你的 Rainbond 账号。"
  log "接下来会打开浏览器完成登录和授权，无需在终端输入账号或密码。"
  log ""
  log "[RAINSKILLS_USER_INPUT_REQUIRED:rainbond_connection]"
  log "如果由 AI 代为安装，请暂停执行并让用户选择，不得自动代选。"
  log ""
  log "请选择要连接的 Rainbond："
  log ""
  log "  1) Rainbond Cloud"
  log "     无需自行安装 Rainbond，登录后即可使用"
  log "     地址：${SAAS_DEFAULT_URL}"
  log ""
  log "  2) 私有化部署"
  log "     已有平台可填写地址；没有平台可进入单机安装向导"
  log ""

  while true; do
    printf '请输入选项 [1-2]: '
    read -r choice
    case "$choice" in
      1)
        DEPLOYMENT_MODE_INPUT="saas"
        return 0
        ;;
      2)
        DEPLOYMENT_MODE_INPUT="self-hosted"
        resolve_self_hosted_path
        return 0
        ;;
      *)
        log "请输入 1 或 2。"
        ;;
    esac
  done
}

is_ssh_session() {
  [[ -n "${SSH_CONNECTION:-}" || -n "${SSH_CLIENT:-}" || -n "${SSH_TTY:-}" ]]
}

is_container_environment() {
  local root_prefix="${1:-}"
  local cgroup_file="${root_prefix}/proc/1/cgroup"

  if [[ -f "${root_prefix}/.dockerenv" || -f "${root_prefix}/run/.containerenv" ]]; then
    return 0
  fi
  if [[ -n "${container:-}" ]]; then
    return 0
  fi
  if [[ -r "$cgroup_file" ]] \
    && grep -Eiq '(^|[/_.-])(docker|containerd|kubepods|libpod|lxc)([/_.-]|$)' "$cgroup_file"; then
    return 0
  fi
  return 1
}

browser_authorization_mode() {
  if [[ "$NO_BROWSER" -eq 1 || "${RAINSKILLS_NO_BROWSER:-}" == "1" ]]; then
    printf 'manual-copy\n'
    return 0
  fi
  if is_ssh_session || is_container_environment; then
    printf 'manual-copy\n'
    return 0
  fi

  case "$(uname -s)" in
    Darwin)
      if command -v open >/dev/null 2>&1; then
        printf 'local-browser\n'
        return 0
      fi
      ;;
    Linux)
      if command -v xdg-open >/dev/null 2>&1 \
        && { [[ -n "${DISPLAY:-}" ]] || [[ -n "${WAYLAND_DISPLAY:-}" ]]; }; then
        printf 'local-browser\n'
        return 0
      fi
      ;;
  esac

  printf 'manual-copy\n'
}

can_open_browser() {
  [[ "$(browser_authorization_mode)" == "local-browser" ]]
}

open_browser() {
  local url="$1"
  if [[ "$(uname -s)" == "Darwin" ]] && command -v open >/dev/null 2>&1; then
    open "$url" >/dev/null 2>&1 || true
    return 0
  fi
  if command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$url" >/dev/null 2>&1 || true
    return 0
  fi
  return 1
}

extract_token_from_paste() {
  python3 - "$1" "$2" <<'PY'
import re
import sys
from urllib.parse import urlparse, parse_qs

raw = sys.argv[1].strip()
expected_state = sys.argv[2]

if raw.startswith("http://") or raw.startswith("https://"):
    qs = parse_qs(urlparse(raw).query)
    token = (qs.get("token") or [None])[0]
    state = (qs.get("state") or [None])[0]
    if not token:
        print("回调 URL 中未找到 token 参数。", file=sys.stderr)
        sys.exit(1)
    if not state:
        print("回调 URL 中未找到 state 参数，请重新点击「授权」并复制完整地址。", file=sys.stderr)
        sys.exit(1)
    if state != expected_state:
        print("回调 URL 中的 state 与当前授权会话不一致；可能是过期或错混的链接，请重新点击「授权」。", file=sys.stderr)
        sys.exit(1)
    print(token)
    sys.exit(0)

if not re.fullmatch(r"[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+", raw):
    print("输入既不是合法 JWT，也不是回调 URL，请重试。", file=sys.stderr)
    sys.exit(1)

print(raw)
PY
}

manual_paste_reader() {
  local port="$1"
  local state="$2"
  local server_pid="$3"
  local pasted token_out
  while kill -0 "$server_pid" 2>/dev/null; do
    printf '\n请粘贴回调 URL 或 JWT（按回车确认，Ctrl+C 取消）: ' >&2
    if ! IFS= read -r -s pasted </dev/tty; then
      printf '\n' >&2
      return 0
    fi
    printf '\n' >&2
    pasted="$(trim "$pasted")"
    [[ -n "$pasted" ]] || continue
    if token_out="$(extract_token_from_paste "$pasted" "$state")"; then
      curl -fsS --max-time 5 \
        "http://127.0.0.1:${port}/cli-callback?token=${token_out}&state=${state}" \
        >/dev/null 2>&1 || true
      return 0
    fi
  done
}

browser_login_to_rainbond() {
  local base_url="$1"
  local result_file state port auth_url
  result_file="$(mktemp "${TMPDIR:-/tmp}/rainskills-auth.XXXXXX")"
  RAINSKILLS_BROWSER_LOGIN_RESULT_FILE="$result_file"

  state="$(python3 -c 'import secrets; print(secrets.token_urlsafe(24))')"

  python3 - "$result_file" "$state" "$LOGIN_TIMEOUT" >"${result_file}.port" 2>"${result_file}.err" <<'PY' &
import json
import sys
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlparse, parse_qs

result_path = sys.argv[1]
expected_state = sys.argv[2]
timeout = int(sys.argv[3])

received = {"token": None, "error": None}

SUCCESS_HTML = (
    "<!doctype html><meta charset=\"utf-8\">"
    "<title>Rainbond CLI 授权完成</title>"
    "<body style=\"font-family:-apple-system,Segoe UI,Roboto,sans-serif;"
    "max-width:480px;margin:120px auto;text-align:center;color:#1f2933;\">"
    "<h2 style=\"color:#0a7d3a;\">授权完成</h2>"
    "<p>Rainbond CLI 已收到凭证，请回到终端继续。可以关闭此页面。</p>"
    "</body>"
)
ERROR_HTML = (
    "<!doctype html><meta charset=\"utf-8\">"
    "<title>Rainbond CLI 授权失败</title>"
    "<body style=\"font-family:-apple-system,Segoe UI,Roboto,sans-serif;"
    "max-width:480px;margin:120px auto;text-align:center;color:#1f2933;\">"
    "<h2 style=\"color:#b8312f;\">授权失败</h2>"
    "<p>{detail}</p><p>请回到终端重新执行 install.sh。</p></body>"
)

class Handler(BaseHTTPRequestHandler):
    def _cors(self):
        origin = self.headers.get("Origin") or "*"
        self.send_header("Access-Control-Allow-Origin", origin)
        self.send_header("Vary", "Origin")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS, GET")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        # Chrome Private Network Access (CORS-RFC1918): public-page → loopback
        # requires this preflight ack header.
        if self.headers.get("Access-Control-Request-Private-Network", "").lower() == "true":
            self.send_header("Access-Control-Allow-Private-Network", "true")

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def log_message(self, fmt, *args):
        return

    def _finish(self, status, msg):
        self.send_response(status)
        self._cors()
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.end_headers()
        self.wfile.write(msg.encode("utf-8"))

    def _handle_callback(self, params):
        state = (params.get("state") or [None])[0]
        token = (params.get("token") or [None])[0]
        if state != expected_state:
            received["error"] = "Rainbond 浏览器授权回调 state 不匹配，疑似 CSRF。"
            self._finish(400, ERROR_HTML.format(detail="state 校验失败"))
            return
        if not token:
            received["error"] = "Rainbond 浏览器授权回调缺少 token。"
            self._finish(400, ERROR_HTML.format(detail="缺少 token"))
            return
        received["token"] = token
        self._finish(200, SUCCESS_HTML)

    def do_GET(self):
        parsed = urlparse(self.path)
        if not parsed.path.startswith("/cli-callback"):
            self._finish(404, "not found")
            return
        self._handle_callback(parse_qs(parsed.query))

    def do_POST(self):
        parsed = urlparse(self.path)
        if not parsed.path.startswith("/cli-callback"):
            self._finish(404, "not found")
            return
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length > 0 else b"{}"
        try:
            payload = json.loads(raw.decode("utf-8"))
        except Exception as exc:
            received["error"] = "回调载荷不是合法 JSON：{}".format(exc)
            self._finish(400, ERROR_HTML.format(detail="无效请求"))
            return
        params = {k: [v] for k, v in payload.items() if v is not None}
        self._handle_callback(params)

server = HTTPServer(("127.0.0.1", 0), Handler)
port = server.server_address[1]
print(port, flush=True)

deadline = time.time() + timeout
server.timeout = 1.0
while time.time() < deadline and received["token"] is None and received["error"] is None:
    server.handle_request()

if received["error"]:
    print(received["error"], file=sys.stderr)
    sys.exit(2)
if received["token"] is None:
    print("Rainbond 浏览器授权超时（{} 秒）。".format(timeout), file=sys.stderr)
    sys.exit(3)

with open(result_path, "w", encoding="utf-8") as fh:
    fh.write(received["token"])
PY
  local server_pid=$!
  RAINSKILLS_BROWSER_LOGIN_SERVER_PID="$server_pid"

  # Server prints chosen port to stdout (file) on first line, then waits
  local waited=0
  while [[ ! -s "${result_file}.port" ]]; do
    sleep 0.1
    waited=$((waited + 1))
    if [[ "$waited" -gt 50 ]]; then
      cleanup_browser_login
      die "无法启动本地回调服务（端口准备超时）。"
    fi
    if ! kill -0 "$server_pid" 2>/dev/null; then
      cat "${result_file}.err" >&2 || true
      cleanup_browser_login
      die "本地回调服务启动失败。"
    fi
  done

  port="$(head -n 1 "${result_file}.port")"
  auth_url="${base_url}/#/cli-auth?callback=$(python3 -c 'import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1], safe=""))' "http://127.0.0.1:${port}/cli-callback")&state=${state}"

  printf '终端会自动等待授权结果（最长 %s 秒），无需在终端按回车；授权完成后会自动继续，Ctrl+C 可取消。\n' "$LOGIN_TIMEOUT" >&2
  if can_open_browser; then
    printf '正在浏览器中打开 Rainbond CLI 授权页面，请在浏览器中完成登录并点击「授权」按钮。\n' >&2
    printf '授权地址：%s\n' "$auth_url" >&2
    open_browser "$auth_url"
  else
    printf '\n' >&2
    printf '未检测到本机浏览器（典型场景：远程 SSH 到 Linux 服务器），进入手动授权模式：\n' >&2
    printf '  1. 在你能打开浏览器的电脑上，访问下面这条授权链接：\n' >&2
    printf '       %s\n' "$auth_url" >&2
    printf '  2. 登录后点击页面上的「授权」按钮。\n' >&2
    printf '  3. 浏览器会跳到 http://127.0.0.1:%s/cli-callback?token=...&state=... 的地址。\n' "$port" >&2
    printf '     远程 SSH 场景下页面会显示「无法访问」，属正常现象，只看地址栏即可。\n' >&2
    printf '  4. 从浏览器地址栏复制整条 URL（或仅 token= 后那串 JWT），按下方提示粘贴回车。\n' >&2
    printf '\n' >&2
    printf '若浏览器与此终端在同一台机器，直接点击「授权」即可，无需手动粘贴。\n' >&2

    if [[ -r /dev/tty ]]; then
      manual_paste_reader "$port" "$state" "$server_pid" &
      RAINSKILLS_BROWSER_LOGIN_READER_PID=$!
    else
      warn "/dev/tty 不可读，无法接收手动粘贴。请改用 --token <jwt> 重新执行 install.sh。"
    fi
  fi

  if ! wait "$server_pid"; then
    local err
    err="$(cat "${result_file}.err" 2>/dev/null || true)"
    RAINSKILLS_BROWSER_LOGIN_SERVER_PID=""
    cleanup_browser_login
    if [[ -n "$err" ]]; then
      die "$err"
    fi
    die "Rainbond 浏览器授权失败。"
  fi
  RAINSKILLS_BROWSER_LOGIN_SERVER_PID=""

  local token
  token="$(cat "$result_file")"
  cleanup_browser_login
  if [[ -z "$token" ]]; then
    die "Rainbond 浏览器授权未返回 token。"
  fi
  OBTAINED_RAINBOND_TOKEN="$token"
}

login_to_rainbond() {
  local base_url="$1"
  local username="$2"
  local password="$3"
  local login_url="${base_url}/console/users/login"
  local response_file
  response_file="$(mktemp)"

  local http_code
  http_code="$(
    curl \
      --silent \
      --show-error \
      --output "$response_file" \
      --write-out '%{http_code}' \
      -X POST \
      "$login_url" \
      -H 'Content-Type: application/x-www-form-urlencoded' \
      --data-urlencode "nick_name=$username" \
      --data-urlencode "password=$password"
  )"

  if [[ ! "$http_code" =~ ^2 ]]; then
    rm -f "$response_file"
    die "Rainbond 登录失败，HTTP 状态码 ${http_code}"
  fi

  local token
  if ! token="$(
    python3 - "$response_file" <<'PY'
import json
import sys

path = sys.argv[1]
try:
    with open(path, "r", encoding="utf-8") as fh:
        payload = json.load(fh)
except Exception:
    body = open(path, "r", encoding="utf-8", errors="replace").read()
    print("登录响应不是合法 JSON：{}".format(body[:200]), file=sys.stderr)
    sys.exit(1)

code = payload.get("code")
if code != 200:
    print(payload.get("msg_show") or payload.get("msg") or "Rainbond 登录失败", file=sys.stderr)
    sys.exit(1)

token = (((payload.get("data") or {}).get("bean") or {}).get("token"))
if not token:
    print("登录成功但没有返回 token", file=sys.stderr)
    sys.exit(1)

print(token)
PY
  )"; then
    rm -f "$response_file"
    die "Rainbond 登录失败"
  fi

  rm -f "$response_file"
  OBTAINED_RAINBOND_TOKEN="$token"
}

shell_quote_single() {
  printf "%s" "$1" | sed "s/'/'\"'\"'/g"
}

write_token_file() {
  local token="$1"
  local base_url="$2"
  local token_dir="$HOME/.rainbond"
  local token_file="$token_dir/mcp.env"
  mkdir -p "$token_dir"
  chmod 700 "$token_dir"

  local escaped_token escaped_url
  escaped_token="$(shell_quote_single "$token")"
  escaped_url="$(shell_quote_single "$base_url")"
  umask 077
  cat > "$token_file" <<EOF
export RAINBOND_JWT='$escaped_token'
export RAINBOND_URL='$escaped_url'
EOF
  chmod 600 "$token_file"
  log "[write] 已写入 $token_file"
}

backup_file() {
  local file="$1"
  [[ -f "$file" ]] || return 0
  local backup="${file}.rainbond-skills.bak.$(date +%Y%m%d%H%M%S)"
  cp "$file" "$backup"
  log "[backup] 已备份 $backup"
}

update_managed_block() {
  local file="$1"
  local begin_marker="$2"
  local end_marker="$3"
  local block_body="$4"
  local tmp
  tmp="$(mktemp)"

  mkdir -p "$(dirname "$file")"
  touch "$file"

  awk -v begin="$begin_marker" -v end="$end_marker" '
    $0 == begin {skip = 1; next}
    $0 == end {skip = 0; next}
    !skip {print}
  ' "$file" > "$tmp"

  if [[ -s "$tmp" ]]; then
    printf '\n' >> "$tmp"
  fi
  printf '%s\n%s\n%s\n' "$begin_marker" "$block_body" "$end_marker" >> "$tmp"
  mv "$tmp" "$file"
}

detect_shell_rc_file() {
  local shell_name
  shell_name="$(basename "${SHELL:-zsh}")"

  case "$shell_name" in
    zsh)
      printf '%s\n' "$HOME/.zshrc"
      ;;
    bash)
      printf '%s\n' "$HOME/.bashrc"
      ;;
    *)
      printf '%s\n' "$HOME/.profile"
      ;;
  esac
}

configure_shell_autoload() {
  local token_file="$HOME/.rainbond/mcp.env"
  local rc_file
  rc_file="$(detect_shell_rc_file)"
  local begin_marker="# >>> rainbond skills mcp >>>"
  local end_marker="# <<< rainbond skills mcp <<<"
  local block='[ -f "$HOME/.rainbond/mcp.env" ] && source "$HOME/.rainbond/mcp.env"'

  backup_file "$rc_file"
  update_managed_block "$rc_file" "$begin_marker" "$end_marker" "$block"
  ACTIVE_SHELL_RC="$rc_file"
  log "[update] 已更新 $rc_file"
}

codex_config_matches() {
  local mcp_url="$1"
  local config_file="$HOME/.codex/config.toml"
  [[ -f "$config_file" ]] || return 1

  local current_url current_env
  current_url="$(
    awk '
      $0 == "[mcp_servers.rainbond]" {in_section = 1; next}
      in_section && /^\[/ {in_section = 0}
      in_section && $1 == "url" {
        sub(/^[^=]+=[[:space:]]*"/, "", $0)
        sub(/"$/, "", $0)
        print
        exit
      }
    ' "$config_file"
  )"
  current_env="$(
    awk '
      $0 == "[mcp_servers.rainbond]" {in_section = 1; next}
      in_section && /^\[/ {in_section = 0}
      in_section && $1 == "bearer_token_env_var" {
        sub(/^[^=]+=[[:space:]]*"/, "", $0)
        sub(/"$/, "", $0)
        print
        exit
      }
    ' "$config_file"
  )"

  [[ "$current_url" == "$mcp_url" && "$current_env" == "RAINBOND_JWT" ]]
}

claude_config_matches() {
  local mcp_url="$1"
  local config_file="$HOME/.claude.json"
  [[ -f "$config_file" ]] || return 1

  python3 - "$config_file" "$mcp_url" <<'PY' >/dev/null
import json
import sys

path, expected_url = sys.argv[1], sys.argv[2]

with open(path, "r", encoding="utf-8") as fh:
    payload = json.load(fh)

server = ((payload.get("mcpServers") or {}).get("rainbond") or {})
header = ((server.get("headers") or {}).get("Authorization"))

if server.get("url") == expected_url and header == "GRJWT ${RAINBOND_JWT}":
    sys.exit(0)

sys.exit(1)
PY
}

configure_codex_mcp() {
  local mcp_url="$1"

  if ! command -v codex >/dev/null 2>&1; then
    warn "未找到 Codex CLI，跳过 Codex MCP 配置。"
    return 1
  fi

  backup_file "$HOME/.codex/config.toml"
  codex mcp remove rainbond >/dev/null 2>&1 || true
  if ! codex mcp add rainbond --url "$mcp_url" --bearer-token-env-var RAINBOND_JWT >/dev/null; then
    return 1
  fi
  log "[configure] 已配置 Codex MCP"
}

configure_claude_mcp() {
  local mcp_url="$1"

  if ! command -v claude >/dev/null 2>&1; then
    warn "未找到 Claude CLI，跳过 Claude MCP 配置。"
    return 1
  fi

  backup_file "$HOME/.claude.json"
  claude mcp remove --scope user rainbond >/dev/null 2>&1 || true
  if ! claude mcp add --scope user --transport http rainbond "$mcp_url" -H 'Authorization: GRJWT ${RAINBOND_JWT}' >/dev/null; then
    return 1
  fi
  log "[configure] 已配置 Claude MCP"
}

validate_mcp_connectivity() {
  local mcp_url="$1"
  local token="$2"
  local response_file header_file
  response_file="$(mktemp)"
  header_file="$(mktemp)"
  VALIDATED_TOKEN="$token"

  local http_code
  http_code="$(
    curl \
      --silent \
      --show-error \
      --output "$response_file" \
      --dump-header "$header_file" \
      --write-out '%{http_code}' \
      -X POST \
      "$mcp_url" \
      -H 'Accept: application/json' \
      -H 'Content-Type: application/json' \
      -H "Authorization: GRJWT ${token}" \
      -H 'MCP-Protocol-Version: 2025-03-26' \
      --data '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}'
  )"

  if [[ ! "$http_code" =~ ^2 ]]; then
    rm -f "$response_file" "$header_file"
    if [[ "$http_code" == "404" ]]; then
      local mcp_path
      mcp_path="${mcp_url#*://}"
      mcp_path="/${mcp_path#*/}"
      die "Rainbond MCP 校验失败：${mcp_url} 未暴露 ${mcp_path}。登录已成功，说明这个环境可达，但当前部署的 Rainbond Console 可能未包含 RainSkills MCP 接口，或你连接到了错误的 Rainbond 主机。"
    fi
    die "Rainbond MCP 校验失败，HTTP 状态码 ${http_code}"
  fi

  if ! python3 - "$response_file" <<'PY' >/dev/null; then
import json
import sys

path = sys.argv[1]
with open(path, "r", encoding="utf-8") as fh:
    payload = json.load(fh)

name = ((((payload.get("result") or {}).get("serverInfo") or {}).get("name")))
if name != "rainbond-console-mcp":
    raise SystemExit(1)
PY
    rm -f "$response_file" "$header_file"
    die "Rainbond MCP 校验返回了无法识别的响应"
  fi

  local renewed_token
  renewed_token="$(
    python3 - "$header_file" <<'PY'
import sys

path = sys.argv[1]
renewed = ""
authorization = ""

try:
    with open(path, "r", encoding="utf-8", errors="replace") as fh:
        for line in fh:
            if ":" not in line:
                continue
            name, value = line.split(":", 1)
            name = name.strip().lower()
            value = value.strip()
            if name == "x-renewed-token" and value:
                renewed = value
            elif name == "authorization" and value.lower().startswith("grjwt "):
                authorization = value.split(None, 1)[1].strip()
except FileNotFoundError:
    pass

print(renewed or authorization)
PY
  )"

  if [[ -n "$renewed_token" ]]; then
    if looks_like_jwt "$renewed_token"; then
      local renewed_status_line renewed_status
      renewed_status_line="$(jwt_time_status "$renewed_token" "$JWT_MIN_TTL_SECONDS")"
      renewed_status="${renewed_status_line%% *}"
      if [[ "$renewed_status" == "ok" ]]; then
        VALIDATED_TOKEN="$renewed_token"
        log "[renew] 已保存后端滑动续期返回的新 JWT"
      else
        warn "MCP 响应返回了续期 token，但其有效期状态为 ${renewed_status}，已忽略。"
      fi
    else
      warn "MCP 响应返回了续期 token，但不是合法 JWT，已忽略。"
    fi
  fi

  rm -f "$response_file" "$header_file"
  log "[verify] Rainbond MCP 可访问"
}

migrate_codex_mcp_if_generic() {
  local generic_url="$1"
  local dedicated_url="$2"
  local config_file="$HOME/.codex/config.toml"
  codex_config_matches "$generic_url" || return 0

  local backup="${config_file}.rainskills-backup"
  cp "$config_file" "$backup"
  log "[backup] 已备份 $backup"
  if ! configure_codex_mcp "$dedicated_url"; then
    cp "$backup" "$config_file"
    warn "Codex MCP 迁移失败，已恢复原配置。"
    return 1
  fi
  log "[migrate] Codex MCP 已切换到 RainSkills 专用地址"
}

migrate_claude_mcp_if_generic() {
  local generic_url="$1"
  local dedicated_url="$2"
  local config_file="$HOME/.claude.json"
  claude_config_matches "$generic_url" || return 0

  local backup="${config_file}.rainskills-backup"
  cp "$config_file" "$backup"
  log "[backup] 已备份 $backup"
  if ! configure_claude_mcp "$dedicated_url"; then
    cp "$backup" "$config_file"
    warn "Claude MCP 迁移失败，已恢复原配置。"
    return 1
  fi
  log "[migrate] Claude MCP 已切换到 RainSkills 专用地址"
}

looks_like_jwt() {
  # JWT compact form: header.payload.signature, three base64url segments.
  [[ "$1" =~ ^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$ ]]
}

jwt_time_status() {
  local token="$1"
  local min_ttl_seconds="$2"
  python3 - "$token" "$min_ttl_seconds" <<'PY'
import base64
import json
import sys
import time

token = sys.argv[1]
min_ttl = int(sys.argv[2])

try:
    payload_segment = token.split(".")[1]
    payload_segment += "=" * (-len(payload_segment) % 4)
    payload = json.loads(base64.urlsafe_b64decode(payload_segment.encode("ascii")).decode("utf-8"))
except Exception:
    print("invalid 0")
    sys.exit(0)

exp = payload.get("exp")
try:
    exp = int(exp)
except Exception:
    print("no-exp 0")
    sys.exit(0)

remaining = exp - int(time.time())
if remaining <= 0:
    print("expired {}".format(remaining))
elif remaining <= min_ttl:
    print("expiring {}".format(remaining))
else:
    print("ok {}".format(remaining))
PY
}

reject_flag_token() {
  local status="$1"
  case "$status" in
    expired)
      die "--token 提供的 Rainbond JWT 已过期，请重新获取 token 或改用浏览器登录。"
      ;;
    expiring)
      die "--token 提供的 Rainbond JWT 即将过期，请重新获取 token 或改用浏览器登录。"
      ;;
    no-exp)
      die "--token 提供的 Rainbond JWT 不包含 exp，无法判断有效期，请重新获取 token。"
      ;;
    invalid)
      die "--token 提供的 Rainbond JWT 无法解析 exp，请确认 token 是否完整。"
      ;;
  esac
}

check_reusable_token_or_clear() {
  local token_label="$1"
  local status_line status
  status_line="$(jwt_time_status "$RAINBOND_TOKEN_INPUT" "$JWT_MIN_TTL_SECONDS")"
  status="${status_line%% *}"

  case "$status" in
    ok)
      return 0
      ;;
    expired)
      if [[ "$RAINBOND_TOKEN_FROM_FLAG" -eq 1 ]]; then
        reject_flag_token "$status"
      fi
      warn "${token_label} 已过期，将重新登录获取新 JWT。"
      ;;
    expiring)
      if [[ "$RAINBOND_TOKEN_FROM_FLAG" -eq 1 ]]; then
        reject_flag_token "$status"
      fi
      warn "${token_label} 即将过期，将重新登录获取新 JWT。"
      ;;
    no-exp|invalid)
      if [[ "$RAINBOND_TOKEN_FROM_FLAG" -eq 1 ]]; then
        reject_flag_token "$status"
      fi
      warn "${token_label} 无法解析有效期，将忽略旧 token 并重新登录。"
      ;;
    *)
      if [[ "$RAINBOND_TOKEN_FROM_FLAG" -eq 1 ]]; then
        die "--token 提供的 Rainbond JWT 状态未知，请重新获取 token。"
      fi
      warn "${token_label} 状态未知，将忽略旧 token 并重新登录。"
      ;;
  esac

  RAINBOND_TOKEN_INPUT=""
  return 1
}

obtain_rainbond_token() {
  local base_url="$1"
  local mode="$2"
  OBTAINED_RAINBOND_TOKEN=""

  if [[ -n "$RAINBOND_TOKEN_INPUT" ]]; then
    if ! looks_like_jwt "$RAINBOND_TOKEN_INPUT"; then
      if [[ "$RAINBOND_TOKEN_FROM_FLAG" -eq 1 ]]; then
        die "--token 提供的值不是合法的 JWT（应形如 xxx.yyy.zzz）。"
      fi
      warn "RAINBOND_JWT 不是合法的 JWT（应形如 xxx.yyy.zzz）；忽略并改走浏览器登录。"
      warn "如果你的当前 shell 还在加载旧的 ~/.rainbond/mcp.env，请先执行：unset RAINBOND_JWT"
      RAINBOND_TOKEN_INPUT=""
    elif [[ "$RAINBOND_TOKEN_FROM_FLAG" -eq 1 ]]; then
      check_reusable_token_or_clear "--token 提供的 Rainbond JWT" || true
      printf '使用 --token 提供的 Rainbond JWT，跳过登录。\n' >&2
      OBTAINED_RAINBOND_TOKEN="$RAINBOND_TOKEN_INPUT"
      return 0
    elif [[ -n "$RAINBOND_CACHED_URL" && "$RAINBOND_CACHED_URL" != "$base_url" ]]; then
      warn "检测到 shell 中已加载的 RAINBOND_JWT 来自 ${RAINBOND_CACHED_URL}，与本次目标 ${base_url} 不一致；忽略旧 token，将重新登录。"
      RAINBOND_TOKEN_INPUT=""
    elif [[ "$NON_INTERACTIVE" -eq 1 || ! -t 0 ]]; then
      check_reusable_token_or_clear "shell 中已加载的 RAINBOND_JWT" || true
      if [[ -n "$RAINBOND_TOKEN_INPUT" ]]; then
        printf '复用 shell 中已加载的 RAINBOND_JWT。\n' >&2
        OBTAINED_RAINBOND_TOKEN="$RAINBOND_TOKEN_INPUT"
        return 0
      fi
    else
      check_reusable_token_or_clear "shell 中已加载的 RAINBOND_JWT" || true
      if [[ -n "$RAINBOND_TOKEN_INPUT" ]]; then
        local cached_label="${RAINBOND_CACHED_URL:-未知来源}"
        printf '检测到 shell 中已加载的 RAINBOND_JWT（来自 %s）。是否复用？[y/N]: ' "$cached_label" >&2
        local reuse_answer=""
        read -r reuse_answer
        case "$reuse_answer" in
          y|Y|yes|YES)
            OBTAINED_RAINBOND_TOKEN="$RAINBOND_TOKEN_INPUT"
            return 0
            ;;
          *)
            printf '将忽略旧 token 并重新登录。\n' >&2
            RAINBOND_TOKEN_INPUT=""
            ;;
        esac
      fi
    fi
  fi

  # Legacy username/password path (self-hosted only) — kept for CI / non-USE_SAAS deployments.
  if [[ "$mode" == "self-hosted" ]] && [[ -n "$RAINBOND_USERNAME_INPUT" || -n "$RAINBOND_PASSWORD_INPUT" ]]; then
    local username password
    username="$(prompt_for_value "Rainbond 用户名" "$RAINBOND_USERNAME_INPUT")"
    password="$(prompt_for_password)"
    login_to_rainbond "$base_url" "$username" "$password"
    return 0
  fi

  if [[ "$NON_INTERACTIVE" -eq 1 || ! -t 0 ]]; then
    die "非交互模式下浏览器登录不可用，请改用 --token <jwt> 或设置 RAINBOND_JWT。"
  fi

  browser_login_to_rainbond "$base_url"
}

read_cached_rainbond_url() {
  local mcp_env="$HOME/.rainbond/mcp.env"
  [[ -f "$mcp_env" ]] || return 1
  (
    set +u
    # shellcheck disable=SC1090
    . "$mcp_env"
    printf '%s\n' "${RAINBOND_URL:-}"
  )
}

do_refresh() {
  set_rainskills_failure_context "authorization" "authorization_failed"
  ensure_python3

  # Refresh exists because the cached JWT is broken; ignore inherited tokens
  # unless the operator explicitly supplied one via --token.
  if [[ "$RAINBOND_TOKEN_FROM_FLAG" -ne 1 ]]; then
    RAINBOND_TOKEN_INPUT=""
    RAINBOND_CACHED_URL=""
  fi

  if [[ -z "$RAINBOND_URL_INPUT" ]]; then
    local cached_url
    cached_url="$(read_cached_rainbond_url 2>/dev/null || true)"
    if [[ -n "$cached_url" ]]; then
      RAINBOND_URL_INPUT="$cached_url"
      log "[refresh] 使用 ~/.rainbond/mcp.env 中已记录的地址：$cached_url"
    fi
  fi

  if [[ -z "$DEPLOYMENT_MODE_INPUT" ]]; then
    if [[ -z "$RAINBOND_URL_INPUT" || "$RAINBOND_URL_INPUT" == "$SAAS_DEFAULT_URL" ]]; then
      DEPLOYMENT_MODE_INPUT="saas"
    else
      DEPLOYMENT_MODE_INPUT="self-hosted"
    fi
  fi

  local base_url_input base_url
  case "$DEPLOYMENT_MODE_INPUT" in
    saas)
      base_url_input="${RAINBOND_URL_INPUT:-$SAAS_DEFAULT_URL}"
      ;;
    self-hosted)
      base_url_input="$(prompt_for_value "Rainbond Console 地址" "$RAINBOND_URL_INPUT")"
      ;;
    *)
      die "未知部署形态：$DEPLOYMENT_MODE_INPUT"
      ;;
  esac
  base_url="$(normalize_rainbond_url "$base_url_input")"
  confirm_insecure_http_if_needed "$base_url"

  local token generic_mcp_url codex_mcp_url claude_mcp_url
  local migrate_codex=0 migrate_claude=0 validate_codex=0 validate_claude=0
  obtain_rainbond_token "$base_url" "$DEPLOYMENT_MODE_INPUT"
  token="$OBTAINED_RAINBOND_TOKEN"
  generic_mcp_url="${base_url}/console/mcp/query"
  codex_mcp_url="${base_url}/console/mcp/rainskills/codex/query"
  claude_mcp_url="${base_url}/console/mcp/rainskills/claude-code/query"

  if codex_config_matches "$generic_mcp_url"; then
    migrate_codex=1
    validate_codex=1
  elif codex_config_matches "$codex_mcp_url"; then
    validate_codex=1
  fi
  if claude_config_matches "$generic_mcp_url"; then
    migrate_claude=1
    validate_claude=1
  elif claude_config_matches "$claude_mcp_url"; then
    validate_claude=1
  fi
  if (( validate_codex == 0 && validate_claude == 0 )); then
    validate_codex=1
  fi

  if (( validate_codex == 1 && validate_claude == 1 )); then
    RAINSKILLS_INSTALL_CLIENT="both"
  elif (( validate_claude == 1 )); then
    RAINSKILLS_INSTALL_CLIENT="claude_code"
  else
    RAINSKILLS_INSTALL_CLIENT="codex"
  fi
  record_rainskills_authorization "$base_url" "$token"

  set_rainskills_failure_context "verification" "mcp_verification_failed"
  if (( validate_codex == 1 )); then
    validate_mcp_connectivity "$codex_mcp_url" "$token"
    token="$VALIDATED_TOKEN"
  fi
  if (( validate_claude == 1 )); then
    validate_mcp_connectivity "$claude_mcp_url" "$token"
    token="$VALIDATED_TOKEN"
  fi

  export RAINBOND_JWT="$token"
  write_token_file "$token" "$base_url"
  configure_shell_autoload

  set_rainskills_failure_context "configuration" "mcp_configuration_failed"
  if (( migrate_codex == 1 )); then
    migrate_codex_mcp_if_generic "$generic_mcp_url" "$codex_mcp_url" \
      || die "Codex MCP 专用地址迁移失败"
  fi
  if (( migrate_claude == 1 )); then
    migrate_claude_mcp_if_generic "$generic_mcp_url" "$claude_mcp_url" \
      || die "Claude MCP 专用地址迁移失败"
  fi

  log ""
  log "JWT 刷新完成。脚本管理的旧通用 MCP 地址已按需迁移到 RainSkills 专用地址。"
  log "请重启 Claude Code 或 Codex 让新 JWT 生效（它们在启动时一次性读取 RAINBOND_JWT）。"
  if [[ -n "$ACTIVE_SHELL_RC" ]]; then
    log "如果想立刻在当前终端使用，请执行：source ${ACTIVE_SHELL_RC}"
  fi
  RAINSKILLS_INSTALL_TERMINAL_REPORTED=1
  report_rainskills_installation "configured" "success"
}

configure_mcp() {
  [[ "$SKIP_MCP" -eq 0 ]] || return 0
  [[ -z "$CUSTOM_DEST" ]] || return 0

  if { [[ "$NON_INTERACTIVE" -eq 1 ]] || [[ ! -t 0 ]]; } && \
     [[ -z "$RAINBOND_URL_INPUT" && -z "$RAINBOND_TOKEN_INPUT" && -z "$DEPLOYMENT_MODE_INPUT" && -z "$RAINBOND_USERNAME_INPUT" && -z "$RAINBOND_PASSWORD_INPUT" ]]; then
    log "非交互模式下未提供 Rainbond 连接信息，已跳过 MCP 配置。"
    return 0
  fi

  set_rainskills_failure_context "authorization" "authorization_failed"
  ensure_python3
  resolve_deployment_mode

  if [[ "$DEPLOYMENT_MODE_INPUT" == "self-hosted" && "$RAINBOND_URL_FROM_FLAG" -eq 0 ]]; then
    resolve_self_hosted_path
  fi
  if [[ "$RAINSKILLS_INSTALL_DEFERRED" -eq 1 ]]; then
    return 0
  fi

  local base_url_input base_url
  case "$DEPLOYMENT_MODE_INPUT" in
    saas)
      if [[ "$RAINBOND_URL_FROM_FLAG" -eq 1 && -n "$RAINBOND_URL_INPUT" ]]; then
        base_url_input="$RAINBOND_URL_INPUT"
      else
        base_url_input="$SAAS_DEFAULT_URL"
      fi
      ;;
    self-hosted)
      if [[ "$RAINBOND_URL_FROM_FLAG" -eq 1 && -n "$RAINBOND_URL_INPUT" ]]; then
        # 显式 --rainbond-url 传入，视为明确意图，直接采用。
        base_url_input="$RAINBOND_URL_INPUT"
      else
        # 用户在交互菜单中显式选了"私有化部署"，意图就是自填 Console 地址。
        # 继承自 shell env 的 RAINBOND_URL（无论是 SaaS 默认值还是某个旧的私有化
        # 地址）只能作为可回车沿用的提示，绝不静默采用——否则会把用户想切换的
        # 新私有化部署导回旧地址。
        base_url_input="$(prompt_with_default "Rainbond Console 地址" "$RAINBOND_URL_INPUT")"
      fi
      ;;
    *)
      die "未知部署形态：$DEPLOYMENT_MODE_INPUT"
      ;;
  esac
  base_url="$(normalize_rainbond_url "$base_url_input")"
  confirm_insecure_http_if_needed "$base_url"

  local token codex_mcp_url claude_mcp_url
  obtain_rainbond_token "$base_url" "$DEPLOYMENT_MODE_INPUT"
  token="$OBTAINED_RAINBOND_TOKEN"
  RAINSKILLS_INSTALL_CLIENT="$(rainskills_install_client_for_target "$TARGET")"
  record_rainskills_authorization "$base_url" "$token"
  codex_mcp_url="${base_url}/console/mcp/rainskills/codex/query"
  claude_mcp_url="${base_url}/console/mcp/rainskills/claude-code/query"

  set_rainskills_failure_context "verification" "mcp_verification_failed"
  case "$TARGET" in
    codex)
      validate_mcp_connectivity "$codex_mcp_url" "$token"
      token="$VALIDATED_TOKEN"
      ;;
    claude)
      validate_mcp_connectivity "$claude_mcp_url" "$token"
      token="$VALIDATED_TOKEN"
      ;;
    all)
      validate_mcp_connectivity "$codex_mcp_url" "$token"
      token="$VALIDATED_TOKEN"
      validate_mcp_connectivity "$claude_mcp_url" "$token"
      token="$VALIDATED_TOKEN"
      ;;
  esac

  # Refresh this process's env for any downstream CLI behavior that resolves it.
  export RAINBOND_JWT="$token"
  write_token_file "$token" "$base_url"
  configure_shell_autoload

  set_rainskills_failure_context "configuration" "mcp_configuration_failed"
  local configured=0
  case "$TARGET" in
    codex)
      configure_codex_mcp "$codex_mcp_url" && configured=1 || true
      ;;
    claude)
      configure_claude_mcp "$claude_mcp_url" && configured=1 || true
      ;;
    all)
      configure_codex_mcp "$codex_mcp_url" && configured=$((configured + 1)) || true
      configure_claude_mcp "$claude_mcp_url" && configured=$((configured + 1)) || true
      ;;
  esac

  (( configured > 0 )) || die "所选平台都未能完成 MCP 配置。"
  RAINSKILLS_INSTALL_TERMINAL_REPORTED=1
  report_rainskills_installation "configured" "success"

  if [[ -n "$ACTIVE_SHELL_RC" ]]; then
    log "当前 shell 提示：新开的终端会自动从 ${ACTIVE_SHELL_RC} 加载 RAINBOND_JWT。"
    log "如果你想立刻在当前终端使用 Codex 或 Claude，请执行：source ${ACTIVE_SHELL_RC}"
  fi
}

main() {
  parse_args "$@"

  if [[ "$ACTION" == "refresh" ]]; then
    do_refresh
    return 0
  fi

  resolve_target
  RAINSKILLS_INSTALL_CLIENT="$(rainskills_install_client_for_target "$TARGET")"
  set_rainskills_failure_context "skill_installation" "skill_installation_failed"

  local skills=()
  local skill_dir
  while IFS= read -r skill_dir; do
    skills+=("$skill_dir")
  done < <(find "$SCRIPT_DIR" -maxdepth 1 -mindepth 1 -type d -name 'rainbond-*' | sort)
  [[ "${#skills[@]}" -gt 0 ]] || die "在 $SCRIPT_DIR 下没有找到 rainbond-* skill 目录。"

  for skill_dir in "${skills[@]}"; do
    validate_skill_dir "$skill_dir"
  done

  local destinations=()
  local dest
  while IFS= read -r dest; do
    destinations+=("$dest")
  done < <(collect_destinations)

  for dest in "${destinations[@]}"; do
    log "安装到：$dest"
    for skill_dir in "${skills[@]}"; do
      copy_skill "$skill_dir" "$dest"
    done
  done

  configure_mcp

  if [[ "$RAINSKILLS_INSTALL_DEFERRED" -eq 1 ]]; then
    return 0
  fi

  log ""
  log "安装完成。本次：${INSTALL_COUNT_NEW} 项新装 / ${INSTALL_COUNT_UPDATED} 项已更新 / ${INSTALL_COUNT_UNCHANGED} 项已是最新 / ${INSTALL_COUNT_FORCED} 项强制覆盖"
  if [[ -n "$CUSTOM_DEST" || "$SKIP_MCP" -eq 1 ]]; then
    log "请重启 Claude Code 或 Codex 以加载新技能。"
  else
    log "请在重新加载 shell 环境后重启 Claude Code 或 Codex。"
  fi
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  trap 'handle_installer_signal 130' INT
  trap 'handle_installer_signal 143' TERM
  trap 'handle_installer_exit "$?"' EXIT
  initialize_rainskills_installation_reporting "$@"
  main "$@"
fi
