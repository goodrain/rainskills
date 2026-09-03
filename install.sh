#!/usr/bin/env bash
# Rainbond Skills installer — packaged for npx with a CDN fallback:
#   npx --yes rainskills
#   bash <(curl -fsSL https://get.rainbond.com/rainskills/install.sh)
#
# AI assistants: when a user asks to install rainbond-skills, hand back the
# npx command when Node.js 18+ is available, otherwise use the CDN command.
# Do not reimplement the bootstrap below, git clone + copy directories, or
# Credentials are written only through the protected single-runtime store.
set -euo pipefail

RAINSKILLS_VERBOSE="${RAINSKILLS_VERBOSE:-0}"
for rainskills_bootstrap_arg in "$@"; do
  if [[ "$rainskills_bootstrap_arg" == "--verbose" ]]; then
    RAINSKILLS_VERBOSE=1
    break
  fi
done

RAINBOND_SKILLS_HOME_DEFAULT="${RAINBOND_SKILLS_HOME:-$HOME/.rainbond/skills}"
RAINBOND_SKILLS_OSS_TARBALL_URL="${RAINBOND_SKILLS_OSS_URL:-https://get.rainbond.com/rainskills/rainskills-latest.tar.gz}"
RAINBOND_SKILLS_GITHUB_TARBALL_URL="https://github.com/goodrain/rainskills/archive/refs/heads/main.tar.gz"
RAINBOND_SKILLS_TARBALL_URL_OVERRIDE="${RAINBOND_SKILLS_TARBALL_URL:-}"

bootstrap_log() {
  [[ "$RAINSKILLS_VERBOSE" == "1" ]] || return 0
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
  local controlling_tty=""
  controlling_tty="$(tty 2>/dev/null || true)"
  if [[ "$controlling_tty" == /dev/* && -r "$controlling_tty" ]]; then
    exec bash "$target_script" "$@" <"$controlling_tty"
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

is_runtime_connect_invocation() {
  [[ "${1:-}" == "connect" ]]
}

if is_runtime_connect_invocation "$@"; then
  [[ "${RAINSKILLS_RUNTIME_CONNECT_COMPLETION:-0}" == "1" ]] \
    && [[ "${RAINSKILLS_RUNTIME_OPERATION_ID:-}" =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$ ]] \
    || bootstrap_die "runtime connect 必须通过 Rainskills Node 入口执行。"
  SCRIPT_DIR="$(resolve_script_dir)"
  [[ -n "$SCRIPT_DIR" && -f "$SCRIPT_DIR/bin/rainskills.js" ]] \
    || bootstrap_die "runtime connect 缺少受信任的 Rainskills Node 入口。"
elif should_skip_bootstrap_for_refresh "$@"; then
  SCRIPT_DIR="$(resolve_script_dir)"
else
  bootstrap_download_if_needed "$@"
fi

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
LOGIN_TIMEOUT="${RAINBOND_LOGIN_TIMEOUT:-600}"
JWT_MIN_TTL_SECONDS="${RAINBOND_JWT_MIN_TTL_SECONDS:-600}"
ACTIVE_SHELL_RC=""
VALIDATED_TOKEN=""
OBTAINED_RAINBOND_TOKEN=""
RAINSKILLS_INSTALL_REPORT_URL="https://log.rainbond.com/api/rainskills/installations"
RAINSKILLS_LIFECYCLE_REPORT_URL="https://log.rainbond.com/api/rainskills/lifecycle-events"
RAINSKILLS_TELEMETRY_REPORT_URL="${RAINSKILLS_TELEMETRY_REPORT_URL:-https://log.rainbond.com/api/rainskills/events}"
RAINSKILLS_INSTALL_ATTEMPT_ID="${RAINSKILLS_INSTALL_ATTEMPT_ID:-}"
RAINSKILLS_INSTALL_EID=""
RAINSKILLS_INSTALL_CLIENT="unknown"
RAINSKILLS_INSTALL_ACTION="install"
RAINSKILLS_INSTALL_FAILURE_STAGE="bootstrap"
RAINSKILLS_INSTALL_FAILURE_CATEGORY="invalid_arguments"
RAINSKILLS_INSTALL_TERMINAL_REPORTED=0
RAINSKILLS_V2_TERMINAL_REPORTED=0
RAINSKILLS_V2_CURRENT_AGENT=""
RAINSKILLS_TELEMETRY_SEQUENCE=0
RAINSKILLS_BROWSER_LOGIN_SERVER_PID=""
RAINSKILLS_BROWSER_LOGIN_READER_PID=""
RAINSKILLS_BROWSER_LOGIN_RESULT_FILE=""
RAINSKILLS_DEVICE_FLOW_TEMP_DIR=""
RAINSKILLS_MCP_VALIDATION_TEMP_DIR=""
DEVICE_FLOW_ERROR=""
DEVICE_FLOW_DEVICE_CODE=""
DEVICE_FLOW_USER_CODE=""
DEVICE_FLOW_VERIFICATION_URI=""
DEVICE_FLOW_VERIFICATION_URI_COMPLETE=""
DEVICE_FLOW_EXPIRES_IN=""
DEVICE_FLOW_INTERVAL=""

usage() {
  cat <<'EOF'
Usage:
  npx --yes rainskills [target] [options]
  ./install.sh
  ./install.sh claude
  ./install.sh codex
  ./install.sh pi
  ./install.sh dsh
  ./install.sh workbuddy
  ./install.sh hermes
  ./install.sh all
  ./install.sh --dest <path>
  ./install.sh all --saas
  ./install.sh all --self-hosted --rainbond-url <url>
  ./install.sh all --non-interactive --rainbond-url <url> --token <jwt>
  ./install.sh refresh

Options:
  claude                 Install and configure Claude Code
  codex                  Install and configure Codex
  pi                     Install and configure Pi Agent
  dsh                    Install and configure DeepSeek Harness
  workbuddy              Install and configure WorkBuddy
  hermes                 Install and configure Hermes Agent
  all                    Install and configure all supported agents
  refresh                Re-run browser login and refresh the protected CLI credential
  --dest PATH            Install skills to a custom directory only
  --force                Overwrite existing installed skills
  --verbose              Show installation paths and copy diagnostics
  --skip-mcp             Compatibility alias: skip Rainbond runtime connection
  --saas                 Use Rainbond Cloud (https://run.rainbond.com)
  --self-hosted          Use a self-hosted Rainbond Console (requires --rainbond-url)
  --non-interactive      Require all installer inputs through flags or env vars
  --rainbond-url URL     Rainbond base URL, for example http://example.com:7070
  --token JWT            Use an existing Rainbond JWT, skip browser login
  --no-browser           Do not open a local browser; print the authorization URL
  --no-cached-token      Ignore RAINBOND_JWT inherited from the shell and re-login
  --no-telemetry         Disable anonymous installation telemetry for this run
  --username NAME        Legacy: Rainbond login username (self-hosted only)
  --allow-insecure-http  Allow plain HTTP for internal trial environments
  -h, --help             Show this help message

Environment:
  RAINBOND_URL           Same as --rainbond-url
  RAINBOND_JWT           Same as --token (preferred for CI)
  RAINBOND_USERNAME      Legacy: same as --username
  RAINBOND_PASSWORD      Legacy: Rainbond login password for non-interactive runs
  RAINBOND_LOGIN_TIMEOUT Browser login timeout in seconds (default 600)
  RAINSKILLS_NO_BROWSER  Set to 1 to print the authorization URL without opening it
  DSH_HOME               DeepSeek Harness home (default: ~/.dsh)
  WORKBUDDY_CONFIG_DIR   WorkBuddy config home (default: ~/.workbuddy-ai)
  HERMES_HOME            Hermes Agent home (default: ~/.hermes)
EOF
}

log() {
  printf '%s\n' "$1"
}

install_detail_log() {
  [[ "$RAINSKILLS_VERBOSE" == "1" ]] || return 0
  log "$1"
}

warn() {
  printf '警告：%s\n' "$1" >&2
}

print_capability_summary() {
  printf '[RAINSKILLS_USER_MESSAGE_BEGIN:install.completed]\n'
  if [[ "$TARGET" == "hermes" ]]; then
    cat <<'EOF'
Rainskills 安装完成。

如果安装发生在已经打开的 Hermes 会话中，请执行 /reset，或新建会话后再使用。

下一步可以直接说：

- 帮我部署当前项目
- 帮我部署一个 Git 仓库
- 帮我通过镜像或安装包部署应用
- 帮我安装一个应用模板
- 帮我分析当前项目应该如何部署

也可以直接告诉我你想部署什么应用。
EOF
  else
  cat <<'EOF'
Rainskills 安装完成，下一条消息即可直接使用。

下一步可以直接说：

- 帮我部署当前项目
- 帮我部署一个 Git 仓库
- 帮我通过镜像或安装包部署应用
- 帮我安装一个应用模板
- 帮我分析当前项目应该如何部署

也可以直接告诉我你想部署什么应用。
EOF
  fi
  printf '[RAINSKILLS_USER_MESSAGE_END:install.completed]\n'
  printf '[RAINSKILLS_AGENT_SUMMARY_REQUIRED:include-next-actions]\n'
}

new_rainskills_install_attempt_id() {
  if command -v python3 >/dev/null 2>&1; then
    python3 - <<'PY'
import uuid

print(str(uuid.uuid4()))
PY
    return 0
  fi
  printf '%s-%s-%s\n' "$(date +%s)" "$$" "${RANDOM:-0}"
}

rainskills_v2_enabled() {
  [[ "${RAINSKILLS_TELEMETRY_DISABLED:-0}" != "1" ]]
}

initialize_rainskills_v2_identity() {
  rainskills_v2_enabled || return 0
  command -v python3 >/dev/null 2>&1 || return 0
  local telemetry_dir package_file
  telemetry_dir="${RAINSKILLS_TELEMETRY_DIR:-${HOME:-/tmp}/.rainbond/rainskills/telemetry}"
  package_file="$SCRIPT_DIR/package.json"
  RAINSKILLS_TELEMETRY_INSTALLATION_ID="$({
    python3 - "$telemetry_dir" "${RAINSKILLS_TELEMETRY_INSTALLATION_ID:-}" <<'PY'
import os
import re
import sys
import uuid

directory, provided = sys.argv[1:]
pattern = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", re.I)
os.makedirs(directory, mode=0o700, exist_ok=True)
os.chmod(directory, 0o700)
path = os.path.join(directory, "installation-id")
value = provided.strip()
if not pattern.match(value):
    try:
        value = open(path, encoding="utf-8").read().strip()
    except Exception:
        value = ""
if not pattern.match(value):
    value = str(uuid.uuid4())
    temporary = "{}.{}.tmp".format(path, os.getpid())
    with open(temporary, "x", encoding="utf-8") as stream:
        stream.write(value + "\n")
    os.chmod(temporary, 0o600)
    os.replace(temporary, path)
os.chmod(path, 0o600)
print(value)
PY
  } 2>/dev/null || true)"
  if [[ -z "${RAINSKILLS_PACKAGE_VERSION:-}" && -f "$package_file" ]]; then
    RAINSKILLS_PACKAGE_VERSION="$({
      python3 - "$package_file" <<'PY'
import json
import sys

try:
    value = json.load(open(sys.argv[1], encoding="utf-8")).get("version")
except Exception:
    value = None
print(value if isinstance(value, str) and value else "unknown")
PY
    } 2>/dev/null || printf 'unknown')"
  fi
  export RAINSKILLS_TELEMETRY_INSTALLATION_ID RAINSKILLS_PACKAGE_VERSION
}

rainskills_v2_action() {
  case "$RAINSKILLS_INSTALL_ACTION" in
    install|refresh|upgrade|repair) printf '%s\n' "$RAINSKILLS_INSTALL_ACTION" ;;
    connect) printf 'repair\n' ;;
    *) printf 'install\n' ;;
  esac
}

rainskills_v2_agent() {
  case "$1" in
    codex) printf 'codex\n' ;;
    claude|claude_code) printf 'claude_code\n' ;;
    pi) printf 'pi\n' ;;
    dsh|deepseek_harness|deepseek) printf 'deepseek\n' ;;
    workbuddy) printf 'workbuddy\n' ;;
    hermes|hermes_agent|hermes-agent) printf 'hermes_agent\n' ;;
    other) printf 'other\n' ;;
    *) printf 'unknown\n' ;;
  esac
}

rainskills_v2_os_type() {
  case "$(uname -s 2>/dev/null || true)" in
    Darwin) printf 'darwin\n' ;;
    MINGW*|MSYS*|CYGWIN*) printf 'windows\n' ;;
    *) printf 'linux\n' ;;
  esac
}

rainskills_v2_os_arch() {
  case "$(uname -m 2>/dev/null || true)" in
    x86_64|amd64) printf 'amd64\n' ;;
    arm64|aarch64) printf 'arm64\n' ;;
    "") printf 'unknown\n' ;;
    *) printf 'other\n' ;;
  esac
}

rainskills_v2_execution_environment() {
  if [[ -n "${WSL_DISTRO_NAME:-}" || -n "${WSL_INTEROP:-}" ]]; then
    printf 'wsl\n'
  elif [[ -n "${SSH_CONNECTION:-}" || -n "${SSH_CLIENT:-}" ]]; then
    printf 'ssh\n'
  elif [[ -n "${container:-}" ]]; then
    printf 'container\n'
  else
    printf 'native\n'
  fi
}

rainskills_v2_environment_kind() {
  case "$DEPLOYMENT_MODE_INPUT" in
    saas) printf 'saas\n' ;;
    self-hosted) printf 'private\n' ;;
    *) return 1 ;;
  esac
}

rainskills_v2_error_stage() {
  case "${RAINSKILLS_INSTALL_FAILURE_STAGE:-install}" in
    bootstrap) printf 'preflight\n' ;;
    download) printf 'download\n' ;;
    skill_installation) printf 'agent_configuration\n' ;;
    authorization) printf 'authorization\n' ;;
    verification) printf 'verification\n' ;;
    configuration) printf 'agent_configuration\n' ;;
    *) printf 'install\n' ;;
  esac
}

rainskills_v2_error_code() {
  case "${RAINSKILLS_INSTALL_FAILURE_CATEGORY:-unknown}" in
    invalid_arguments) printf 'invalid_arguments\n' ;;
    tarball_unavailable|download_failed) printf 'download_failed\n' ;;
    authorization_failed) printf 'authorization_failed\n' ;;
    mcp_verification_failed) printf 'verification_failed\n' ;;
    mcp_configuration_failed|cli_configuration_failed|skill_installation_failed) printf 'agent_config_failed\n' ;;
    network_unreachable) printf 'network_unreachable\n' ;;
    *) printf 'unknown\n' ;;
  esac
}

report_rainskills_v2_event() {
  local event_type="$1"
  local status="${2:-}"
  local agent="${3:-}"
  local error_stage="${4:-}"
  local error_code="${5:-}"
  local environment_kind="${6:-}"
  rainskills_v2_enabled || return 0
  [[ -n "${RAINSKILLS_TELEMETRY_INSTALLATION_ID:-}" ]] || return 0
  command -v curl >/dev/null 2>&1 || return 0
  command -v python3 >/dev/null 2>&1 || return 0

  local payload telemetry_dir
  telemetry_dir="${RAINSKILLS_TELEMETRY_DIR:-${HOME:-/tmp}/.rainbond/rainskills/telemetry}"
  payload="$({
    python3 - \
      "$event_type" \
      "$RAINSKILLS_TELEMETRY_INSTALLATION_ID" \
      "$RAINSKILLS_INSTALL_ATTEMPT_ID" \
      "${RAINSKILLS_PACKAGE_VERSION:-unknown}" \
      "$(rainskills_v2_action)" \
      "$(rainskills_v2_agent "$agent")" \
      "$(rainskills_v2_os_type)" \
      "$(rainskills_v2_os_arch)" \
      "$(rainskills_v2_execution_environment)" \
      "$status" \
      "$error_stage" \
      "$error_code" \
      "$environment_kind" \
      "$telemetry_dir" <<'PY'
import datetime
import json
import os
import sys
import time
import uuid

(event_type, installation_id, attempt_id, package_version, action, agent,
 os_type, os_arch, execution_environment, status, error_stage, error_code, environment_kind,
 telemetry_dir) = sys.argv[1:]
event = {
    "schema": "rainskills.telemetry-event.v3" if event_type == "runtime_connect_result" else "rainskills.telemetry-event.v2",
    "event_id": str(uuid.uuid4()),
    "event_type": event_type,
    "installation_id": installation_id,
    "package_version": package_version,
    "occurred_at": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
}
if event_type in {"install_result", "agent_config_result"}:
    event["install_attempt_id"] = attempt_id
    event["action"] = action
if event_type == "install_result":
    event.update({
        "os_type": os_type,
        "os_arch": os_arch,
        "execution_environment": execution_environment,
        "status": status,
    })
elif event_type == "agent_config_result":
    event.update({"agent_type": agent, "status": status})
elif event_type == "runtime_connect_result":
    event.update({"agent_type": agent, "environment_kind": environment_kind, "status": status})
if status == "failed":
    event["error_stage"] = error_stage
    event["error_code"] = error_code
pending_dir = os.path.join(telemetry_dir, "pending-v2")
try:
    os.makedirs(pending_dir, mode=0o700, exist_ok=True)
    os.chmod(telemetry_dir, 0o700)
    os.chmod(pending_dir, 0o700)
    now = time.time()
    entries = []
    for name in os.listdir(pending_dir):
        if not name.endswith(".json"):
            continue
        file_path = os.path.join(pending_dir, name)
        try:
            entries.append((os.stat(file_path).st_mtime, file_path))
        except OSError:
            pass
    entries.sort()
    expired = [entry for entry in entries if now - entry[0] > 7 * 24 * 60 * 60]
    remaining = [entry for entry in entries if now - entry[0] <= 7 * 24 * 60 * 60]
    overflow = remaining[:max(0, len(remaining) - 99)]
    for _, file_path in expired + overflow:
        try:
            os.remove(file_path)
        except OSError:
            pass
    event_path = os.path.join(pending_dir, event["event_id"] + ".json")
    with open(event_path, "x", encoding="utf-8") as stream:
        stream.write(json.dumps(event, separators=(",", ":")) + "\n")
    os.chmod(event_path, 0o600)
except Exception:
    pass
print(json.dumps(event, separators=(",", ":")))
PY
  } 2>/dev/null || true)"
  [[ -n "$payload" ]] || return 0
  local event_id pending_file
  event_id="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["event_id"])' <<<"$payload" 2>/dev/null || true)"
  pending_file="$telemetry_dir/pending-v2/${event_id}.json"
  (
    if curl --silent --show-error --fail --connect-timeout 2 --max-time 3 \
      -X POST "$RAINSKILLS_TELEMETRY_REPORT_URL" \
      -H 'Content-Type: application/json' \
      --data-binary "$payload" >/dev/null 2>&1; then
      [[ -n "$event_id" ]] && rm -f "$pending_file"
    fi
  ) &
}

report_rainskills_runtime_connect_result() {
  local status="$1"
  local environment_kind
  environment_kind="$(rainskills_v2_environment_kind 2>/dev/null || true)"
  [[ -n "$environment_kind" ]] || return 0
  report_rainskills_v2_event \
    "runtime_connect_result" \
    "$status" \
    "$RAINSKILLS_INSTALL_CLIENT" \
    "$([[ "$status" == "failed" ]] && rainskills_v2_error_stage || true)" \
    "$([[ "$status" == "failed" ]] && rainskills_v2_error_code || true)" \
    "$environment_kind"
}

report_rainskills_runtime_connect_failure_if_applicable() {
  [[ "$ACTION" != "connect" ]] || return 0
  case "$RAINSKILLS_INSTALL_FAILURE_STAGE" in
    authorization|verification) report_rainskills_runtime_connect_result "failed" ;;
  esac
}

record_rainskills_v2_configured_agent() {
  local agent
  agent="$(rainskills_v2_agent "$1")"
  [[ "$agent" != "unknown" ]] || return 0
  rainskills_v2_enabled || return 0
  command -v python3 >/dev/null 2>&1 || return 0
  local telemetry_dir
  telemetry_dir="${RAINSKILLS_TELEMETRY_DIR:-${HOME:-/tmp}/.rainbond/rainskills/telemetry}"
  python3 - "$telemetry_dir" "$agent" <<'PY' >/dev/null 2>&1 || true
import json
import os
import sys

directory, agent = sys.argv[1:]
os.makedirs(directory, mode=0o700, exist_ok=True)
os.chmod(directory, 0o700)
path = os.path.join(directory, "configured-agents.json")
try:
    current = json.load(open(path, encoding="utf-8"))
except Exception:
    current = []
agents = sorted(set(value for value in current + [agent] if isinstance(value, str)))
temporary = "{}.{}.tmp".format(path, os.getpid())
with open(temporary, "x", encoding="utf-8") as stream:
    json.dump(agents, stream, separators=(",", ":"))
    stream.write("\n")
os.chmod(temporary, 0o600)
os.replace(temporary, path)
os.chmod(path, 0o600)
PY
}

rainskills_install_client_for_target() {
  case "$1" in
    codex)
      printf 'codex\n'
      ;;
    claude)
      printf 'claude_code\n'
      ;;
    pi)
      printf 'pi\n'
      ;;
    dsh)
      printf 'deepseek_harness\n'
      ;;
    workbuddy)
      printf 'workbuddy\n'
      ;;
    hermes)
      printf 'hermes_agent\n'
      ;;
    all)
      printf 'all\n'
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

  [[ "${RAINSKILLS_LEGACY_TELEMETRY_ENABLED:-0}" == "1" ]] || return 0
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

rainskills_telemetry_target() {
  if [[ -n "${RAINSKILLS_TELEMETRY_TARGET:-}" ]]; then
    printf '%s\n' "$RAINSKILLS_TELEMETRY_TARGET"
  elif [[ "$(uname -s 2>/dev/null || true)" == "Darwin" ]]; then
    printf 'local-macos\n'
  else
    printf 'local-linux\n'
  fi
}

rainskills_telemetry_platform() {
  case "$(uname -s 2>/dev/null || true)" in
    Darwin) printf 'darwin\n' ;;
    *) printf 'linux\n' ;;
  esac
}

rainskills_telemetry_failure_phase() {
  case "${RAINSKILLS_TELEMETRY_ERROR_STAGE:-bootstrap}" in
    skill_installation|bootstrap) printf 'bootstrap\n' ;;
    download) printf 'rootfs_download\n' ;;
    authorization) printf 'authorize_legacy\n' ;;
    verification) printf 'verify_console\n' ;;
    configuration) printf 'configure_mcp\n' ;;
    *) printf 'bootstrap\n' ;;
  esac
}

rainskills_telemetry_error_code() {
  case "${RAINSKILLS_INSTALL_FAILURE_CATEGORY:-unknown}" in
    invalid_arguments) printf 'invalid_arguments\n' ;;
    tarball_unavailable|download_failed) printf 'download_failed\n' ;;
    authorization_failed) printf 'authorization_failed\n' ;;
    mcp_verification_failed) printf 'mcp_verification_failed\n' ;;
    mcp_configuration_failed|skill_installation_failed) printf 'configuration_failed\n' ;;
    network_unreachable) printf 'network_unreachable\n' ;;
    *) printf 'unknown\n' ;;
  esac
}

report_rainskills_lifecycle_event() {
  local lifecycle_phase="$1"
  local step="$2"
  local lifecycle_action="$3"
  local lifecycle_status="$4"
  local error_code="${5:-}"
  local blocked_reason="${6:-}"
  local auth_method="${7:-}"

  rainskills_v2_enabled || return 0
  [[ -n "$RAINSKILLS_INSTALL_ATTEMPT_ID" ]] || return 0
  command -v python3 >/dev/null 2>&1 || return 0
  RAINSKILLS_TELEMETRY_SEQUENCE=$((RAINSKILLS_TELEMETRY_SEQUENCE + 1))

  local payload telemetry_dir
  telemetry_dir="${RAINSKILLS_TELEMETRY_DIR:-${HOME:-/tmp}/.rainbond/rainskills/telemetry}"
  payload="$({
    python3 - \
      "$RAINSKILLS_INSTALL_ATTEMPT_ID" \
      "${RAINSKILLS_TELEMETRY_OPERATION_ID:-}" \
      "${RAINSKILLS_TELEMETRY_INSTALLATION_ID:-}" \
      "${RAINSKILLS_TELEMETRY_CLIENT:-$RAINSKILLS_INSTALL_CLIENT}" \
      "${RAINSKILLS_TELEMETRY_CONTROL_MODE:-posix}" \
      "$(rainskills_telemetry_target)" \
      "$(rainskills_telemetry_platform)" \
      "$RAINSKILLS_INSTALL_ACTION" \
      "$RAINSKILLS_TELEMETRY_SEQUENCE" \
      "$lifecycle_phase" \
      "$step" \
      "$lifecycle_action" \
      "$lifecycle_status" \
      "$error_code" \
      "$blocked_reason" \
      "$auth_method" \
      "$RAINSKILLS_INSTALL_EID" \
      "$RAINSKILLS_LIFECYCLE_REPORT_URL" \
      "$telemetry_dir" <<'PY'
import datetime
import json
import os
import sys
import uuid

(attempt, operation, installation, client, control_mode, target, platform, action,
 sequence, phase, step, lifecycle_action, status, error_code, blocked_reason,
 auth_method, eid, report_url, telemetry_dir) = sys.argv[1:]
event = {
    "schema": "rainskills.lifecycle-event.v1",
    "event_id": str(uuid.uuid4()),
    "install_attempt_id": attempt,
    "operation_id": operation or None,
    "installation_id": installation or None,
    "parent_event_id": None,
    "sequence": int(sequence),
    "attempt": 1,
    "resumed_from": None,
    "package_version": os.environ.get("RAINSKILLS_PACKAGE_VERSION") or None,
    "platform": platform,
    "control_mode": control_mode,
    "target": target,
    "client": client if client in {"codex", "claude_code", "pi", "deepseek_harness", "workbuddy", "hermes_agent", "all", "both", "unknown"} else "unknown",
    "eid": eid or None,
    "phase": None,
    "lifecycle_phase": phase,
    "step": step,
    "action": action if action in {"install", "refresh"} else "install",
    "lifecycle_action": lifecycle_action or None,
    "status": None,
    "lifecycle_status": status,
    "duration_ms": None,
    "error_code": error_code or None,
    "error_stage": phase if error_code else None,
    "reason_code": error_code or None,
    "blocked_reason": blocked_reason or None,
    "interrupt_signal": None,
    "transport": "ssh" if target == "remote-linux" else ("wsl" if control_mode == "wsl" else ("powershell" if control_mode == "windows-native" else "direct")),
    "auth_method": auth_method or None,
    "retryable": status in {"blocked", "started"},
    "exit_code": None,
    "http_status": None,
    "created_at": datetime.datetime.utcnow().isoformat(timespec="milliseconds") + "Z",
}
try:
    os.makedirs(telemetry_dir, mode=0o700, exist_ok=True)
    os.chmod(telemetry_dir, 0o700)
    event_path = os.path.join(telemetry_dir, "events.jsonl")
    with open(event_path, "a", encoding="utf-8") as stream:
        stream.write(json.dumps(event, separators=(",", ":")) + "\n")
    os.chmod(event_path, 0o600)
except Exception:
    pass
print(json.dumps(event, separators=(",", ":")))
PY
  } 2>/dev/null || true)"
  [[ -n "$payload" ]] || return 0
  (
    curl --silent --show-error --connect-timeout 2 --max-time 3 \
      -X POST "$RAINSKILLS_LIFECYCLE_REPORT_URL" \
      -H 'Content-Type: application/json' \
      -H "Idempotency-Key: $(python3 -c 'import json,sys; print(json.load(sys.stdin)["event_id"])' <<<"$payload")" \
      --data-binary "$payload" >/dev/null 2>&1 || true
  ) &
}

initialize_rainskills_installation_reporting() {
  local arg target=""
  if [[ -z "$RAINSKILLS_INSTALL_ATTEMPT_ID" ]]; then
    RAINSKILLS_INSTALL_ATTEMPT_ID="$(new_rainskills_install_attempt_id)"
  fi
  for arg in "$@"; do
    case "$arg" in
      refresh)
        RAINSKILLS_INSTALL_ACTION="refresh"
        ;;
      connect)
        RAINSKILLS_INSTALL_ACTION="connect"
        ;;
      codex|claude|pi|dsh|workbuddy|hermes|all)
        target="$arg"
        ;;
    esac
  done
  RAINSKILLS_INSTALL_CLIENT="$(rainskills_install_client_for_target "$target")"
  initialize_rainskills_v2_identity
  report_rainskills_lifecycle_event "bootstrap" "resume" "resume" "started"
  report_rainskills_installation "started" "started"
}

rainskills_should_report_invocation() {
  local arg
  for arg in "$@"; do
    case "$arg" in
      -h|--help|--no-telemetry)
        return 1
        ;;
    esac
  done
  return 0
}

enterprise_id_from_jwt() {
  python3 -c '
import base64
import json
import sys

raw = sys.stdin.read().strip()
try:
    payload_segment = raw.split(".")[1]
    payload_segment += "=" * (-len(payload_segment) % 4)
    payload = json.loads(base64.urlsafe_b64decode(payload_segment.encode("ascii")))
except Exception:
    raise SystemExit(1)

enterprise_id = payload.get("enterprise_id")
if not isinstance(enterprise_id, str) or not enterprise_id.strip():
    raise SystemExit(1)
print(enterprise_id.strip())
'
}

resolve_rainskills_enterprise_id() {
  local base_url="$1"
  local token="$2"
  local response_file config_file http_code eid
  eid="$(printf '%s' "$token" | enterprise_id_from_jwt 2>/dev/null || true)"
  if [[ -n "$eid" ]]; then
    printf '%s\n' "$eid"
    return 0
  fi

  response_file="$(mktemp)"
  config_file="$(mktemp)"
  chmod 600 "$config_file"
  printf 'header = "Authorization: GRJWT %s"\n' "$token" >"$config_file"
  http_code="$({
    curl \
      --silent \
      --show-error \
      --connect-timeout 2 \
      --max-time 5 \
      --output "$response_file" \
      --write-out '%{http_code}' \
      --config "$config_file" \
      "${base_url}/console/users/details"
  } 2>/dev/null || true)"
  rm -f "$config_file"

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
  report_rainskills_lifecycle_event "authorize_legacy" "legacy_callback" "authorize" "completed" "" "" "browser_loopback"
  report_rainskills_installation "authorized" "success"
}

set_rainskills_failure_context() {
  RAINSKILLS_INSTALL_FAILURE_STAGE="$1"
  RAINSKILLS_INSTALL_FAILURE_CATEGORY="$2"
  RAINSKILLS_TELEMETRY_ERROR_STAGE="$1"
}

report_unhandled_rainskills_installation_failure() {
  local exit_status="$1"
  if [[ "$exit_status" -ne 0 && \
        "${BASH_SUBSHELL:-0}" -eq 0 && \
        "$RAINSKILLS_V2_TERMINAL_REPORTED" -eq 0 ]]; then
    RAINSKILLS_V2_TERMINAL_REPORTED=1
    report_rainskills_runtime_connect_failure_if_applicable
    if [[ -n "$RAINSKILLS_V2_CURRENT_AGENT" ]]; then
      report_rainskills_v2_event \
        "agent_config_result" \
        "failed" \
        "$RAINSKILLS_V2_CURRENT_AGENT" \
        "agent_configuration" \
        "agent_config_failed"
    fi
    report_rainskills_v2_event \
      "install_result" \
      "failed" \
      "" \
      "$(rainskills_v2_error_stage)" \
      "$(rainskills_v2_error_code)"
  fi
  if [[ "$exit_status" -ne 0 && \
        "${BASH_SUBSHELL:-0}" -eq 0 && \
        "$RAINSKILLS_INSTALL_TERMINAL_REPORTED" -eq 0 ]]; then
    RAINSKILLS_INSTALL_TERMINAL_REPORTED=1
    report_rainskills_lifecycle_event \
      "$(rainskills_telemetry_failure_phase)" \
      "resume" \
      "resume" \
      "failed" \
      "$(rainskills_telemetry_error_code)"
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

cleanup_device_flow() {
  if [[ -n "$RAINSKILLS_DEVICE_FLOW_TEMP_DIR" && -d "$RAINSKILLS_DEVICE_FLOW_TEMP_DIR" ]]; then
    rm -rf "$RAINSKILLS_DEVICE_FLOW_TEMP_DIR"
  fi
  RAINSKILLS_DEVICE_FLOW_TEMP_DIR=""
  DEVICE_FLOW_DEVICE_CODE=""
}

cleanup_mcp_validation() {
  if [[ -n "$RAINSKILLS_MCP_VALIDATION_TEMP_DIR" && -d "$RAINSKILLS_MCP_VALIDATION_TEMP_DIR" ]]; then
    rm -rf "$RAINSKILLS_MCP_VALIDATION_TEMP_DIR"
  fi
  RAINSKILLS_MCP_VALIDATION_TEMP_DIR=""
}

handle_installer_signal() {
  local exit_code="$1"
  trap - INT TERM
  cleanup_browser_login
  cleanup_device_flow
  cleanup_mcp_validation
  exit "$exit_code"
}

handle_installer_exit() {
  local exit_code="$1"
  cleanup_browser_login
  cleanup_device_flow
  cleanup_mcp_validation
  report_unhandled_rainskills_installation_failure "$exit_code"
  wait || true
}

die() {
  if [[ "${BASH_SUBSHELL:-0}" -eq 0 && "$RAINSKILLS_V2_TERMINAL_REPORTED" -eq 0 ]]; then
    RAINSKILLS_V2_TERMINAL_REPORTED=1
    report_rainskills_runtime_connect_failure_if_applicable
    if [[ -n "$RAINSKILLS_V2_CURRENT_AGENT" ]]; then
      report_rainskills_v2_event \
        "agent_config_result" \
        "failed" \
        "$RAINSKILLS_V2_CURRENT_AGENT" \
        "agent_configuration" \
        "agent_config_failed"
    fi
    report_rainskills_v2_event \
      "install_result" \
      "failed" \
      "" \
      "$(rainskills_v2_error_stage)" \
      "$(rainskills_v2_error_code)"
  fi
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

install_local_cli() {
  command -v node >/dev/null 2>&1 || return 0
  local node_version node_major
  node_version="$(node --version 2>/dev/null)" || return 0
  node_major="${node_version#v}"
  node_major="${node_major%%.*}"
  [[ "$node_major" =~ ^[0-9]+$ && "$node_major" -ge 18 ]] || return 0
  local installer="$SCRIPT_DIR/scripts/install-local-cli.mjs"
  [[ -f "$installer" ]] || die "Rainskills 本地 CLI 安装器缺失。"
  node "$installer" --source-root "$SCRIPT_DIR" --home "$HOME" >/dev/null \
    || die "Rainskills 本地 CLI 安装失败。"
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
    install_detail_log "[install] 已安装到 $dest"
    INSTALL_COUNT_NEW=$((INSTALL_COUNT_NEW + 1))
    return 0
  fi

  if [[ "$FORCE" -eq 1 ]]; then
    rm -rf "$dest"
    cp -R "$src" "$dest"
    install_detail_log "[overwrite] 已强制覆盖 $dest"
    INSTALL_COUNT_FORCED=$((INSTALL_COUNT_FORCED + 1))
    return 0
  fi

  if diff -rq "$src" "$dest" >/dev/null 2>&1; then
    install_detail_log "[skip] $dest 已是最新"
    INSTALL_COUNT_UNCHANGED=$((INSTALL_COUNT_UNCHANGED + 1))
    return 0
  fi

  # diff -rq 在有差异时退出码非零；与 `set -e + pipefail` 共存需要 || true 兜底
  local changed_files
  changed_files="$( { diff -rq "$src" "$dest" 2>/dev/null || true; } | wc -l | tr -d ' ')"
  rm -rf "$dest"
  cp -R "$src" "$dest"
  install_detail_log "[update] 已更新 ${dest}（${changed_files} 项变化，本地修改已被覆盖）"
  INSTALL_COUNT_UPDATED=$((INSTALL_COUNT_UPDATED + 1))
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      refresh)
        ACTION="refresh"
        shift
        ;;
      connect)
        ACTION="connect"
        shift
        ;;
      claude|codex|pi|dsh|workbuddy|hermes|all)
        TARGET="$1"
        shift
        ;;
      openclaw)
        die "macOS/Linux 安装器不再支持 OpenClaw，请使用 Codex、Claude Code、Pi Agent、DeepSeek Harness、WorkBuddy 或 Hermes Agent。"
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
      --verbose)
        RAINSKILLS_VERBOSE=1
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
      --no-telemetry)
        export RAINSKILLS_TELEMETRY_DISABLED=1
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

valid_runtime_operation_id() {
  [[ "${1:-}" =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$ ]]
}

assert_internal_connect_entry() {
  [[ "${1:-}" == "connect" ]] || return 0
  if [[ "${RAINSKILLS_RUNTIME_CONNECT_COMPLETION:-0}" != "1" ]] \
    || ! valid_runtime_operation_id "${RAINSKILLS_RUNTIME_OPERATION_ID:-}"; then
    printf '错误：runtime connect 必须通过 Rainskills Node 入口执行。\n' >&2
    return 1
  fi

  shift
  local target="" environment_kind="" console_origin="" mode=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      codex|claude|pi|dsh|workbuddy|hermes|all)
        [[ -z "$target" ]] || return 1
        target="$1"
        shift
        ;;
      --saas)
        [[ -z "$mode" ]] || return 1
        mode="saas"
        environment_kind="saas"
        console_origin="$SAAS_DEFAULT_URL"
        shift
        ;;
      --self-hosted)
        [[ -z "$mode" ]] || return 1
        mode="self-hosted"
        environment_kind="private"
        shift
        ;;
      --rainbond-url)
        [[ $# -ge 2 && -z "$console_origin" ]] || return 1
        console_origin="$2"
        shift 2
        ;;
      --allow-insecure-http|--no-cached-token)
        shift
        ;;
      --non-interactive)
        shift
        ;;
      *)
        printf '错误：runtime connect 内部门禁包含不支持的参数。\n' >&2
        return 1
        ;;
    esac
  done
  [[ -n "$target" && -n "$environment_kind" && -n "$console_origin" ]] || return 1
  if [[ "$mode" == "saas" ]]; then
    [[ "$console_origin" == "$SAAS_DEFAULT_URL" ]] || return 1
  else
    assert_canonical_runtime_console_origin "$console_origin" || return 1
  fi
  node "$SCRIPT_DIR/bin/rainskills.js" runtime assert-connect \
    --onboarding-id "$RAINSKILLS_RUNTIME_OPERATION_ID" \
    --target "$target" \
    --environment-kind "$environment_kind" \
    --console-origin "$console_origin" >/dev/null 2>&1 \
    || {
      printf '错误：runtime connect 内部门禁验证失败。\n' >&2
      return 1
    }
}

assert_canonical_runtime_console_origin() {
  local value="$1"
  python3 - "$value" <<'PY' >/dev/null 2>&1
import sys
from urllib.parse import urlsplit

value = sys.argv[1]
if not value or value.strip() != value or len(value) > 2048:
    raise SystemExit(1)
try:
    parsed = urlsplit(value)
    port = parsed.port
except Exception:
    raise SystemExit(1)
if (
    parsed.scheme not in ("http", "https")
    or not parsed.hostname
    or parsed.username is not None
    or parsed.password is not None
    or parsed.path not in ("", "/")
    or parsed.query
    or parsed.fragment
):
    raise SystemExit(1)
host = parsed.hostname.lower()
if ":" in host:
    host = "[{}]".format(host)
default_port = 80 if parsed.scheme == "http" else 443
origin = "{}://{}".format(parsed.scheme, host)
if port is not None and port != default_port:
    origin += ":{}".format(port)
if value.rstrip("/") != origin:
    raise SystemExit(1)
PY
}

resolve_target() {
  if [[ -n "$CUSTOM_DEST" ]]; then
    return 0
  fi

  if [[ -n "$TARGET" ]]; then
    return 0
  fi

  if [[ "${AI_AGENT:-}" == "hermes-agent" || "${HERMES_AGENT:-}" == "true" ]]; then
    TARGET="hermes"
    return 0
  fi

  if [[ "$NON_INTERACTIVE" -eq 1 || ! -t 0 ]]; then
    die "非交互安装必须明确指定 codex、claude、pi、dsh、workbuddy、hermes 或 all"
  fi

  log "请选择要安装和配置的平台："
  log "  1) Codex"
  log "  2) Claude Code"
  log "  3) Pi Agent"
  log "  4) DeepSeek Harness"
  log "  5) WorkBuddy"
  log "  6) Hermes Agent"
  log "  7) 全部"

  while true; do
    printf '请输入选项 [1-7]: '
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
      3)
        TARGET="pi"
        return 0
        ;;
      4)
        TARGET="dsh"
        return 0
        ;;
      5)
        TARGET="workbuddy"
        return 0
        ;;
      6)
        TARGET="hermes"
        return 0
        ;;
      7)
        TARGET="all"
        return 0
        ;;
      *)
        log "请输入 1、2、3、4、5、6 或 7。"
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
      pi)
        destinations+=("$HOME/.pi/agent/skills")
        ;;
      dsh)
        destinations+=("${DSH_HOME:-$HOME/.dsh}/skills")
        ;;
      workbuddy)
        destinations+=("${WORKBUDDY_CONFIG_DIR:-$HOME/.workbuddy-ai}/skills")
        ;;
      hermes)
        destinations+=("${HERMES_HOME:-$HOME/.hermes}/skills")
        ;;
      all)
        destinations+=("$HOME/.claude/skills")
        destinations+=("$HOME/.codex/skills")
        destinations+=("$HOME/.pi/agent/skills")
        destinations+=("${DSH_HOME:-$HOME/.dsh}/skills")
        destinations+=("${WORKBUDDY_CONFIG_DIR:-$HOME/.workbuddy-ai}/skills")
        destinations+=("${HERMES_HOME:-$HOME/.hermes}/skills")
        ;;
      *)
        die "未知安装目标：$TARGET"
        ;;
    esac
  fi

  printf '%s\n' "${destinations[@]}"
}

collect_target_agents() {
  if [[ -n "$CUSTOM_DEST" ]]; then
    printf 'unknown\n'
    return 0
  fi
  case "$TARGET" in
    claude) printf 'claude\n' ;;
    codex) printf 'codex\n' ;;
    pi) printf 'pi\n' ;;
    dsh) printf 'dsh\n' ;;
    workbuddy) printf 'workbuddy\n' ;;
    hermes) printf 'hermes\n' ;;
    all)
      printf '%s\n' claude codex pi dsh workbuddy hermes
      ;;
    *) printf 'unknown\n' ;;
  esac
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
    warn "高风险：当前使用明文 HTTP，设备码和一年期 MCP 凭证可能被同网段设备截获。仅限可信内网临时使用。"
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
  local control_mode control_distro
  control_mode="$(rainskills_control_mode)"
  control_distro="$(rainskills_control_distro)"
  python3 - "$HOME" "$SCRIPT_DIR" "$TARGET" "$control_mode" "$control_distro" <<'PY'
import json
import os
import stat
import sys
import tempfile
import uuid
from datetime import datetime, timezone

home, script_dir, target, control_mode, control_distro = sys.argv[1:]
if control_mode not in {"posix", "wsl"}:
    raise SystemExit("不支持的控制端模式：{}".format(control_mode))
if control_mode == "wsl":
    if not control_distro or any(ord(character) < 32 or ord(character) == 127 for character in control_distro):
        raise SystemExit("WSL 发行版名称无效")
else:
    control_distro = None
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
    "control_mode": control_mode,
    "control_distro": control_distro,
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

is_wsl_environment() {
  local kernel_release
  [[ "$(uname -s 2>/dev/null)" == "Linux" ]] || return 1
  kernel_release="$(uname -r 2>/dev/null || true)"
  case "$kernel_release" in
    *[Mm][Ii][Cc][Rr][Oo][Ss][Oo][Ff][Tt]*|*[Ww][Ss][Ll]*) ;;
    *) return 1 ;;
  esac
  [[ -n "${WSL_INTEROP:-}" || -n "${WSL_DISTRO_NAME:-}" ]]
}

validated_wsl_distro_name() {
  local distro="${WSL_DISTRO_NAME:-}"
  [[ -n "$distro" && "$distro" != *'"'* ]] || return 1
  if printf '%s' "$distro" | LC_ALL=C grep -q '[[:cntrl:]]'; then
    return 1
  fi
  printf '%s\n' "$distro"
}

rainskills_control_mode() {
  if is_wsl_environment; then
    validated_wsl_distro_name >/dev/null \
      || die "无法识别当前 WSL 发行版，请从原始 Windows 终端重新执行 npx rainskills。"
    printf 'wsl\n'
    return 0
  fi
  printf 'posix\n'
}

rainskills_control_distro() {
  if is_wsl_environment; then
    validated_wsl_distro_name
  fi
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

  if is_wsl_environment \
    && command -v powershell.exe >/dev/null 2>&1 \
    && command -v wslpath >/dev/null 2>&1 \
    && [[ -f "$SCRIPT_DIR/rainbond-platform-installer/scripts/windows-browser.ps1" ]]; then
    printf 'windows-browser\n'
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
  [[ "$(browser_authorization_mode)" != "manual-copy" ]]
}

open_browser() {
  local url="$1"
  local mode windows_helper
  mode="$(browser_authorization_mode)"
  if [[ "$mode" == "windows-browser" ]]; then
    windows_helper="$(wslpath -w "$SCRIPT_DIR/rainbond-platform-installer/scripts/windows-browser.ps1" | tr -d '\r')"
    powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass \
      -File "$windows_helper" -Url "$url" >/dev/null 2>&1
    return $?
  fi
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

device_flow_now() {
  python3 - <<'PY'
import time
print(int(time.monotonic()))
PY
}

device_flow_sleep() {
  sleep "$1"
}

device_flow_http_post() {
  local endpoint="$1"
  local body_file="$2"
  local response_file="$3"
  local header_file="$4"
  local status_file="$5"

  curl \
    --silent \
    --show-error \
    --connect-timeout 10 \
    --max-time 30 \
    --output "$response_file" \
    --dump-header "$header_file" \
    --write-out '%{http_code}' \
    -X POST \
    "$endpoint" \
    -H 'Accept: application/json' \
    -H 'Content-Type: application/x-www-form-urlencoded' \
    --data-binary "@${body_file}" \
    >"$status_file"
}

device_flow_json_field() {
  local response_file="$1"
  local field="$2"
  python3 - "$response_file" "$field" <<'PY'
import json
import sys

try:
    with open(sys.argv[1], "r", encoding="utf-8") as fh:
        payload = json.load(fh)
except Exception:
    raise SystemExit(1)

value = payload.get(sys.argv[2])
if isinstance(value, bool) or value is None or not isinstance(value, (str, int)):
    raise SystemExit(1)
print(value)
PY
}

device_flow_retry_after() {
  local header_file="$1"
  awk 'BEGIN {IGNORECASE=1} /^Retry-After:[[:space:]]*[0-9]+/ {gsub("\\r", "", $2); print $2; exit}' "$header_file"
}

is_verified_legacy_device_route() {
  local http_code="$1"
  local response_file="$2"
  local header_file="$3"
  [[ "$http_code" == "404" ]] || return 1

  python3 - "$response_file" "$header_file" <<'PY'
import sys

body_path, header_path = sys.argv[1:]
with open(body_path, "r", encoding="utf-8", errors="replace") as fh:
    body = fh.read().strip()
with open(header_path, "r", encoding="utf-8", errors="replace") as fh:
    headers = fh.read().lower()

plain_not_found = body == "Not Found" and "content-type: text/plain" in headers
django_not_found = (
    "content-type: text/html" in headers
    and "<title>page not found" in body.lower()
    and "device" in body.lower()
)
html_not_found = (
    "content-type: text/html" in headers
    and "<title>" in body.lower()
    and "not found" in body.lower()
)
raise SystemExit(0 if plain_not_found or django_not_found or html_not_found else 1)
PY
}

prepare_device_flow_temp_dir() {
  cleanup_device_flow
  RAINSKILLS_DEVICE_FLOW_TEMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/rainskills-device.XXXXXX")"
  chmod 700 "$RAINSKILLS_DEVICE_FLOW_TEMP_DIR"
}

request_device_authorization() {
  local base_url="$1"
  local body_file response_file header_file status_file http_code parsed_file
  DEVICE_FLOW_ERROR=""
  prepare_device_flow_temp_dir
  body_file="$RAINSKILLS_DEVICE_FLOW_TEMP_DIR/request.body"
  response_file="$RAINSKILLS_DEVICE_FLOW_TEMP_DIR/response.json"
  header_file="$RAINSKILLS_DEVICE_FLOW_TEMP_DIR/response.headers"
  status_file="$RAINSKILLS_DEVICE_FLOW_TEMP_DIR/response.status"
  parsed_file="$RAINSKILLS_DEVICE_FLOW_TEMP_DIR/response.fields"
  umask 077
  printf 'client_id=rainskills&scope=mcp' >"$body_file"

  if ! device_flow_http_post \
      "${base_url}/console/mcp/device/code" \
      "$body_file" "$response_file" "$header_file" "$status_file"; then
    DEVICE_FLOW_ERROR="无法连接 Rainbond Device Flow 接口，请检查网络后重试。"
    cleanup_device_flow
    return 1
  fi
  http_code="$(cat "$status_file" 2>/dev/null || true)"
  if is_verified_legacy_device_route "$http_code" "$response_file" "$header_file"; then
    cleanup_device_flow
    return 2
  fi
  if [[ ! "$http_code" =~ ^2 ]]; then
    local protocol_error=""
    protocol_error="$(device_flow_json_field "$response_file" error 2>/dev/null || true)"
    DEVICE_FLOW_ERROR="Rainbond Device Flow 初始化失败（HTTP ${http_code:-unknown}${protocol_error:+，${protocol_error}}）。"
    cleanup_device_flow
    return 1
  fi

  if ! python3 - "$response_file" >"$parsed_file" <<'PY'
import json
import sys

with open(sys.argv[1], "r", encoding="utf-8") as fh:
    payload = json.load(fh)

fields = (
    ("device_code", str),
    ("user_code", str),
    ("verification_uri", str),
    ("verification_uri_complete", str),
    ("expires_in", int),
    ("interval", int),
)
for name, expected_type in fields:
    value = payload.get(name)
    if isinstance(value, bool) or not isinstance(value, expected_type) or not value:
        raise SystemExit(1)
    print(value)
PY
  then
    DEVICE_FLOW_ERROR="Rainbond Device Flow 返回了无效响应。"
    cleanup_device_flow
    return 1
  fi

  DEVICE_FLOW_DEVICE_CODE="$(sed -n '1p' "$parsed_file")"
  DEVICE_FLOW_USER_CODE="$(sed -n '2p' "$parsed_file")"
  DEVICE_FLOW_EXPIRES_IN="$(sed -n '5p' "$parsed_file")"
  DEVICE_FLOW_INTERVAL="$(sed -n '6p' "$parsed_file")"
  if [[ ! "$DEVICE_FLOW_USER_CODE" =~ ^[23456789BCDFGHJKMNPQRTVWXY]{4}-[23456789BCDFGHJKMNPQRTVWXY]{4}$ \
        || ! "$DEVICE_FLOW_EXPIRES_IN" =~ ^[0-9]+$ \
        || ! "$DEVICE_FLOW_INTERVAL" =~ ^[0-9]+$ ]]; then
    DEVICE_FLOW_ERROR="Rainbond Device Flow 返回的授权码或时间参数无效。"
    cleanup_device_flow
    return 1
  fi

  # Never trust the response host. The selected and validated Console origin is
  # the only origin allowed to receive the browser authorization request.
  DEVICE_FLOW_VERIFICATION_URI="${base_url}/#/device"
  DEVICE_FLOW_VERIFICATION_URI_COMPLETE="${DEVICE_FLOW_VERIFICATION_URI}?user_code=${DEVICE_FLOW_USER_CODE}"
  return 0
}

write_device_token_request_body() {
  local body_file="$1"
  # Device codes use the URL-safe base64 alphabet. printf is a shell builtin,
  # so the secret never enters a child process argument list.
  printf '%s' \
    "grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code&client_id=rainskills&device_code=${DEVICE_FLOW_DEVICE_CODE}" \
    >"$body_file"
  chmod 600 "$body_file"
}

assert_device_authorization_operation_current() {
  local base_url="$1"
  [[ "${RAINSKILLS_RUNTIME_CONNECT_COMPLETION:-0}" == "1" ]] || return 0
  valid_runtime_operation_id "${RAINSKILLS_RUNTIME_OPERATION_ID:-}" || return 1

  local environment_kind="private"
  [[ "$DEPLOYMENT_MODE_INPUT" == "saas" ]] && environment_kind="saas"
  node "$SCRIPT_DIR/bin/rainskills.js" runtime assert-connect \
    --onboarding-id "$RAINSKILLS_RUNTIME_OPERATION_ID" \
    --target "$TARGET" \
    --environment-kind "$environment_kind" \
    --console-origin "$base_url" >/dev/null 2>&1
}

poll_device_authorization() {
  local base_url="$1"
  local interval="$DEVICE_FLOW_INTERVAL"
  local started_at deadline now
  local body_file response_file header_file status_file http_code protocol_error retry_after token token_type
  started_at="$(device_flow_now)"
  deadline=$((started_at + DEVICE_FLOW_EXPIRES_IN))
  if [[ "$LOGIN_TIMEOUT" =~ ^[0-9]+$ && "$LOGIN_TIMEOUT" -lt "$DEVICE_FLOW_EXPIRES_IN" ]]; then
    deadline=$((started_at + LOGIN_TIMEOUT))
  fi
  body_file="$RAINSKILLS_DEVICE_FLOW_TEMP_DIR/token.body"
  response_file="$RAINSKILLS_DEVICE_FLOW_TEMP_DIR/token.json"
  header_file="$RAINSKILLS_DEVICE_FLOW_TEMP_DIR/token.headers"
  status_file="$RAINSKILLS_DEVICE_FLOW_TEMP_DIR/token.status"
  write_device_token_request_body "$body_file"

  while true; do
    device_flow_sleep "$interval"
    if ! assert_device_authorization_operation_current "$base_url"; then
      DEVICE_FLOW_ERROR="本次设备授权已被新的授权尝试替换。"
      return 1
    fi
    now="$(device_flow_now)"
    if [[ "$now" -ge "$deadline" ]]; then
      DEVICE_FLOW_ERROR="Rainbond 设备授权超时，请重新运行安装。"
      return 1
    fi

    : >"$response_file"
    : >"$header_file"
    : >"$status_file"
    if ! device_flow_http_post \
        "${base_url}/console/mcp/device/token" \
        "$body_file" "$response_file" "$header_file" "$status_file"; then
      interval=$((interval < 15 ? interval * 2 : 30))
      continue
    fi
    http_code="$(cat "$status_file" 2>/dev/null || true)"
    if [[ "$http_code" =~ ^2 ]]; then
      token="$(device_flow_json_field "$response_file" access_token 2>/dev/null || true)"
      token_type="$(device_flow_json_field "$response_file" token_type 2>/dev/null || true)"
      if [[ "$token_type" != "Bearer" ]] || ! looks_like_jwt "$token"; then
        DEVICE_FLOW_ERROR="Rainbond Device Flow 返回的访问凭证无效。"
        return 1
      fi
      OBTAINED_RAINBOND_TOKEN="$token"
      return 0
    fi

    protocol_error="$(device_flow_json_field "$response_file" error 2>/dev/null || true)"
    if [[ "$http_code" == "429" ]]; then
      retry_after="$(device_flow_retry_after "$header_file" 2>/dev/null || true)"
      if [[ "$retry_after" =~ ^[0-9]+$ && "$retry_after" -gt "$interval" ]]; then
        interval="$retry_after"
      else
        interval=$((interval + 5))
      fi
      continue
    fi
    case "$protocol_error" in
      authorization_pending)
        ;;
      slow_down)
        interval=$((interval + 5))
        ;;
      access_denied)
        DEVICE_FLOW_ERROR="你已在浏览器中拒绝 Rainbond MCP 授权。"
        return 1
        ;;
      expired_token)
        DEVICE_FLOW_ERROR="Rainbond 设备授权码已过期，请重新运行安装。"
        return 1
        ;;
      *)
        DEVICE_FLOW_ERROR="Rainbond Device Flow 轮询失败（HTTP ${http_code:-unknown}${protocol_error:+，${protocol_error}}）。"
        return 1
        ;;
    esac
  done
}

device_flow_login_to_rainbond() {
  local base_url="$1"
  local request_status
  if request_device_authorization "$base_url"; then
    request_status=0
  else
    request_status=$?
  fi
  [[ "$request_status" -eq 0 ]] || return "$request_status"

  printf '\n[RAINSKILLS_USER_MESSAGE_BEGIN:runtime.device-authorization]\n' >&2
  printf 'Rainbond 设备授权\n' >&2
  printf '授权码：%s\n' "$DEVICE_FLOW_USER_CODE" >&2
  printf '授权地址：%s\n' "$DEVICE_FLOW_VERIFICATION_URI_COMPLETE" >&2
  printf '终端正在等待授权结果，完成后会自动继续，Ctrl+C 可取消。\n' >&2
  if can_open_browser; then
    printf '正在浏览器中打开授权页面…\n' >&2
    open_browser "$DEVICE_FLOW_VERIFICATION_URI_COMPLETE"
  else
    printf '请在任意能够访问该 Rainbond 平台的电脑上打开上面的地址并完成登录授权。\n' >&2
  fi
  printf '[RAINSKILLS_USER_MESSAGE_END:runtime.device-authorization]\n' >&2
  printf '[RAINSKILLS_AGENT_WAIT_REQUIRED:runtime-connect]\n' >&2

  if ! poll_device_authorization "$base_url"; then
    cleanup_device_flow
    return 1
  fi
  cleanup_device_flow
  return 0
}

browser_login_to_rainbond() {
  local base_url="$1"
  local result_file state port auth_url
  result_file="$(mktemp "${TMPDIR:-/tmp}/rainskills-auth.XXXXXX")"
  RAINSKILLS_BROWSER_LOGIN_RESULT_FILE="$result_file"

  state="$(python3 -c 'import secrets; print(secrets.token_urlsafe(24))')"

  printf '正在准备浏览器授权…\n' >&2
  python3 "$SCRIPT_DIR/rainbond-platform-installer/scripts/browser-callback.py" \
    "$result_file" "$state" "$LOGIN_TIMEOUT" \
    >"${result_file}.port" 2>"${result_file}.err" &
  local server_pid=$!
  RAINSKILLS_BROWSER_LOGIN_SERVER_PID="$server_pid"

  # Server prints chosen port to stdout (file) on first line, then waits
  local waited=0
  local max_waits=150
  while [[ ! -s "${result_file}.port" ]]; do
    sleep 0.1
    waited=$((waited + 1))
    if [[ "$waited" -gt "$max_waits" ]]; then
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

write_token_file() {
  local token="$1"
  local base_url="$2"
  local kind="private"
  if [[ "$base_url" == "$SAAS_DEFAULT_URL" ]]; then
    kind="saas"
  fi
  local allow_insecure_http="false"
  [[ "$base_url" == http://* ]] && allow_insecure_http="true"
  RAINBOND_JWT="$token" RAINBOND_URL="$base_url" RAINSKILLS_RUNTIME_KIND="$kind" \
    RAINSKILLS_ALLOW_INSECURE_HTTP="$allow_insecure_http" python3 - "$HOME" <<'PY' \
    || die "Rainbond 单运行环境凭据写入失败。"
import datetime
import json
import os
import pathlib
import secrets
import sys

home = pathlib.Path(sys.argv[1]).resolve()
directory = home / ".rainbond" / "rainskills"
target = directory / "single-runtime-v1.json"
directory.mkdir(parents=True, exist_ok=True, mode=0o700)
os.chmod(directory, 0o700)
now = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
created_at = now
if target.exists():
    with target.open("r", encoding="utf-8") as stream:
        current = json.load(stream)
    if isinstance(current.get("created_at"), str):
        created_at = current["created_at"]
payload = {
    "schema": "rainskills.single-runtime.v1",
    "version": 1,
    "console_origin": os.environ["RAINBOND_URL"],
    "kind": os.environ["RAINSKILLS_RUNTIME_KIND"],
    "token": os.environ["RAINBOND_JWT"],
    "allow_insecure_http": os.environ["RAINSKILLS_ALLOW_INSECURE_HTTP"] == "true",
    "created_at": created_at,
    "updated_at": now,
}
temporary = directory / (".single-runtime-v1.json." + secrets.token_hex(8))
descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
try:
    with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
        json.dump(payload, stream, ensure_ascii=False, indent=2)
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, target)
    os.chmod(target, 0o600)
finally:
    if temporary.exists():
        temporary.unlink()
PY
  log "[write] 已写入受保护的单运行环境凭据"
}

validate_mcp_connectivity() {
  local mcp_url="$1"
  local token="$2"
  local response_file header_file auth_config
  cleanup_mcp_validation
  RAINSKILLS_MCP_VALIDATION_TEMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/rainskills-mcp-validation.XXXXXX")"
  chmod 700 "$RAINSKILLS_MCP_VALIDATION_TEMP_DIR"
  response_file="$RAINSKILLS_MCP_VALIDATION_TEMP_DIR/response.json"
  header_file="$RAINSKILLS_MCP_VALIDATION_TEMP_DIR/response.headers"
  auth_config="$RAINSKILLS_MCP_VALIDATION_TEMP_DIR/curl.conf"
  printf 'header = "Authorization: GRJWT %s"\n' "$token" > "$auth_config"
  chmod 600 "$auth_config"
  VALIDATED_TOKEN="$token"

  local http_code
  if ! http_code="$(
    curl \
      --silent \
      --show-error \
      --connect-timeout 10 \
      --max-time 30 \
      --output "$response_file" \
      --dump-header "$header_file" \
      --write-out '%{http_code}' \
      --config "$auth_config" \
      -X POST \
      "$mcp_url" \
      -H 'Accept: application/json' \
      -H 'Content-Type: application/json' \
      -H 'MCP-Protocol-Version: 2025-03-26' \
      --data '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}'
  )"; then
    cleanup_mcp_validation
    die "Rainbond MCP 校验请求失败"
  fi

  if [[ ! "$http_code" =~ ^2 ]]; then
    if [[ "$http_code" == "404" ]]; then
      if python3 - "$response_file" "$header_file" <<'PY' >/dev/null; then
import json
import sys

body_path, header_path = sys.argv[1:]
with open(body_path, "r", encoding="utf-8", errors="replace") as fh:
    body = fh.read(65537)
if len(body.encode("utf-8")) > 65536:
    raise SystemExit(1)
with open(header_path, "r", encoding="utf-8", errors="replace") as fh:
    headers = fh.read().lower()

content_type = ""
for line in headers.splitlines():
    if line.startswith("content-type:"):
        content_type = line.split(":", 1)[1].strip()
trimmed = body.strip()
verified = False
if "text/plain" in content_type:
    verified = trimmed == "Not Found"
elif "text/html" in content_type:
    lower = trimmed.lower()
    verified = "<title" in lower and "not found" in lower
elif "json" in content_type:
    try:
        payload = json.loads(trimmed)
    except Exception:
        payload = None
    if isinstance(payload, dict):
        verified = any(payload.get(key) in (404, "404") for key in (
            "code", "status", "status_code", "error_code"
        ))
raise SystemExit(0 if verified else 1)
PY
        cleanup_mcp_validation
        return 2
      fi
    fi
    cleanup_mcp_validation
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
    cleanup_mcp_validation
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

  cleanup_mcp_validation
  log "[verify] Rainbond MCP 可访问"
}

validate_runtime_mcp_connectivity() {
  local base_url="$1"
  local token="$2"
  local status
  if validate_mcp_connectivity "${base_url}/console/mcp/rainskills/api/query" "$token"; then
    return 0
  else
    status=$?
  fi
  if [[ "$status" -eq 2 ]]; then
    die "当前 Rainbond 版本不支持 Rainskills CLI。请先将 Rainbond 升级到 v6.9.9 或更高版本，然后从当前任务继续。"
  fi
  return "$status"
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
      warn "检测到无效的 RAINBOND_JWT；将忽略并重新登录。"
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

  local device_flow_status
  if device_flow_login_to_rainbond "$base_url"; then
    printf '浏览器授权已完成，正在验证 Rainbond 连接…\n' >&2
    return 0
  else
    device_flow_status=$?
  fi
  if [[ "$device_flow_status" -eq 2 ]]; then
    printf '当前 Rainbond Console 暂不支持设备授权，改用兼容授权流程。\n' >&2
    if ! can_open_browser && [[ ! -t 0 ]]; then
      die "当前 Rainbond Console 仅支持旧版浏览器回调；此模式需要本机浏览器或交互终端。请升级 Rainbond Console 后重试。"
    fi
    browser_login_to_rainbond "$base_url"
    printf '浏览器授权已完成，正在验证 Rainbond 连接…\n' >&2
    return 0
  fi
  die "${DEVICE_FLOW_ERROR:-Rainbond 设备授权失败。}"
}

read_cached_rainbond_url() {
  local runtime_file="$HOME/.rainbond/rainskills/single-runtime-v1.json"
  [[ -f "$runtime_file" ]] || return 1
  python3 - "$runtime_file" <<'PY'
import json
import sys

with open(sys.argv[1], "r", encoding="utf-8") as stream:
    payload = json.load(stream)
origin = payload.get("console_origin")
if not isinstance(origin, str) or not origin:
    raise SystemExit(1)
print(origin)
PY
}

do_refresh() {
  set_rainskills_failure_context "authorization" "authorization_failed"
  report_rainskills_lifecycle_event "authorize_legacy" "legacy_callback" "authorize" "started" "" "" "browser_loopback"
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
      log "[refresh] 使用单运行环境中已记录的地址：$cached_url"
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

  local token
  obtain_rainbond_token "$base_url" "$DEPLOYMENT_MODE_INPUT"
  token="$OBTAINED_RAINBOND_TOKEN"
  record_rainskills_authorization "$base_url" "$token"

  set_rainskills_failure_context "verification" "mcp_verification_failed"
  if ! validate_runtime_mcp_connectivity "$base_url" "$token"; then
    die "Rainbond CLI 接口校验失败。"
  fi
  token="$VALIDATED_TOKEN"

  export RAINBOND_JWT="$token"
  write_token_file "$token" "$base_url"
  report_rainskills_runtime_connect_result "success"
  set_rainskills_failure_context "configuration" "cli_configuration_failed"
  report_rainskills_lifecycle_event "configure_cli" "install_cli" "configure_cli" "started"
  install_local_cli
  log ""
  log "Rainskills 本地 CLI 凭据刷新完成。"
  if [[ -n "$ACTIVE_SHELL_RC" ]]; then
    log "如果想立刻在当前终端使用，请执行：source ${ACTIVE_SHELL_RC}"
  fi
  RAINSKILLS_INSTALL_TERMINAL_REPORTED=1
  RAINSKILLS_V2_TERMINAL_REPORTED=1
  report_rainskills_v2_event "install_result" "success"
  report_rainskills_lifecycle_event "configure_cli" "install_cli" "configure_cli" "completed"
  report_rainskills_installation "configured" "success"
}

configure_runtime_connection() {
  [[ "$SKIP_MCP" -eq 0 ]] || return 0
  [[ -z "$CUSTOM_DEST" ]] || return 0

  if { [[ "$NON_INTERACTIVE" -eq 1 ]] || [[ ! -t 0 ]]; } && \
     [[ -z "$RAINBOND_URL_INPUT" && -z "$RAINBOND_TOKEN_INPUT" && -z "$DEPLOYMENT_MODE_INPUT" && -z "$RAINBOND_USERNAME_INPUT" && -z "$RAINBOND_PASSWORD_INPUT" ]]; then
    log "非交互模式下未提供 Rainbond 连接信息，已跳过运行环境连接。"
    return 0
  fi

  set_rainskills_failure_context "authorization" "authorization_failed"
  report_rainskills_lifecycle_event "authorize_legacy" "legacy_callback" "authorize" "started" "" "" "browser_loopback"
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

  local token
  obtain_rainbond_token "$base_url" "$DEPLOYMENT_MODE_INPUT"
  token="$OBTAINED_RAINBOND_TOKEN"
  RAINSKILLS_INSTALL_CLIENT="$(rainskills_install_client_for_target "$TARGET")"
  record_rainskills_authorization "$base_url" "$token"

  set_rainskills_failure_context "verification" "mcp_verification_failed"
  if ! validate_runtime_mcp_connectivity "$base_url" "$token"; then
    die "Rainbond CLI 接口校验失败。"
  fi
  token="$VALIDATED_TOKEN"

  # Refresh this process's env for any downstream CLI behavior that resolves it.
  export RAINBOND_JWT="$token"
  if [[ "$ACTION" == "connect" ]]; then
    node "$SCRIPT_DIR/bin/rainskills.js" runtime persist-connect-credential \
      --onboarding-id "$RAINSKILLS_RUNTIME_OPERATION_ID" >/dev/null \
      || die "runtime connect 凭据安全写入失败。"
  else
    write_token_file "$token" "$base_url"
    report_rainskills_runtime_connect_result "success"
  fi

  set_rainskills_failure_context "configuration" "cli_configuration_failed"
  report_rainskills_lifecycle_event "configure_cli" "install_cli" "configure_cli" "started"
  install_local_cli
  RAINSKILLS_INSTALL_TERMINAL_REPORTED=1
  RAINSKILLS_V2_TERMINAL_REPORTED=1
  report_rainskills_v2_event "agent_config_result" "success" "$TARGET"
  record_rainskills_v2_configured_agent "$TARGET"
  report_rainskills_v2_event "install_result" "success"
  report_rainskills_lifecycle_event "configure_cli" "install_cli" "configure_cli" "completed"
  report_rainskills_installation "configured" "success"

  if [[ -n "$ACTIVE_SHELL_RC" ]]; then
    log "当前 shell 提示：新开的终端会自动从 ${ACTIVE_SHELL_RC} 加载 Rainbond 凭据。"
  fi
}

# Backward-compatible internal function name for older bootstrap callers.
configure_mcp() {
  configure_runtime_connection "$@"
}

main() {
  parse_args "$@"

  if [[ "$ACTION" == "refresh" ]]; then
    do_refresh
    return 0
  fi

  if [[ "$ACTION" == "connect" ]]; then
    [[ "${RAINSKILLS_RUNTIME_CONNECT_COMPLETION:-0}" == "1" ]] \
      && valid_runtime_operation_id "${RAINSKILLS_RUNTIME_OPERATION_ID:-}" \
      || die "runtime connect 必须通过 Rainskills Node 入口执行。"
    if [[ "$DEPLOYMENT_MODE_INPUT" == "self-hosted" ]]; then
      assert_canonical_runtime_console_origin "$RAINBOND_URL_INPUT" \
        || die "Rainbond Console 地址必须是已经安全校验的规范 origin。"
    fi
    ALLOW_INSECURE_HTTP=1
    resolve_target
    RAINSKILLS_INSTALL_CLIENT="$(rainskills_install_client_for_target "$TARGET")"
    configure_runtime_connection
    if [[ "${RAINSKILLS_RUNTIME_CONNECT_COMPLETION:-0}" == "1" ]]; then
      node "$SCRIPT_DIR/bin/rainskills.js" runtime complete-connect \
        --onboarding-id "$RAINSKILLS_RUNTIME_OPERATION_ID"
      printf '[RAINSKILLS_AGENT_WAIT_COMPLETE:runtime-connect]\n' >&2
    fi
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

  local root_skill_dir="$SCRIPT_DIR/marketplace/rainskills/skills/rainskills"
  if [[ -d "$root_skill_dir" ]]; then
    skills+=("$root_skill_dir")
  fi

  for skill_dir in "${skills[@]}"; do
    validate_skill_dir "$skill_dir"
  done

  local destinations=()
  local target_agents=()
  local dest
  while IFS= read -r dest; do
    destinations+=("$dest")
  done < <(collect_destinations)

  local target_agent
  while IFS= read -r target_agent; do
    target_agents+=("$target_agent")
  done < <(collect_target_agents)

  local destination_index
  for destination_index in "${!destinations[@]}"; do
    dest="${destinations[$destination_index]}"
    RAINSKILLS_V2_CURRENT_AGENT="${target_agents[$destination_index]:-unknown}"
    install_detail_log "安装到：$dest"
    for skill_dir in "${skills[@]}"; do
      copy_skill "$skill_dir" "$dest"
    done
    report_rainskills_v2_event "agent_config_result" "success" "$RAINSKILLS_V2_CURRENT_AGENT"
    record_rainskills_v2_configured_agent "$RAINSKILLS_V2_CURRENT_AGENT"
    RAINSKILLS_V2_CURRENT_AGENT=""
  done

  install_local_cli

  install_detail_log ""
  install_detail_log "安装完成。本次：${INSTALL_COUNT_NEW} 项新装 / ${INSTALL_COUNT_UPDATED} 项已更新 / ${INSTALL_COUNT_UNCHANGED} 项已是最新 / ${INSTALL_COUNT_FORCED} 项强制覆盖"
  install_detail_log ""
  print_capability_summary
  report_rainskills_lifecycle_event "bootstrap" "resume" "resume" "completed"
  RAINSKILLS_INSTALL_TERMINAL_REPORTED=1
  RAINSKILLS_V2_TERMINAL_REPORTED=1
  report_rainskills_v2_event "install_result" "success"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  assert_internal_connect_entry "$@"
  trap 'handle_installer_signal 130' INT
  trap 'handle_installer_signal 143' TERM
  trap 'handle_installer_exit "$?"' EXIT
  if rainskills_should_report_invocation "$@"; then
    initialize_rainskills_installation_reporting "$@"
  fi
  main "$@"
fi
