#!/usr/bin/env bash
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

bootstrap_download_if_needed "$@"

DEFAULT_TARGET="all"
TARGET=""
FORCE=0
CUSTOM_DEST=""
SKIP_MCP=0
NON_INTERACTIVE=0
ALLOW_INSECURE_HTTP=0
RAINBOND_URL_INPUT="${RAINBOND_URL:-}"
RAINBOND_USERNAME_INPUT="${RAINBOND_USERNAME:-}"
RAINBOND_PASSWORD_INPUT="${RAINBOND_PASSWORD:-}"
RAINBOND_TOKEN_INPUT="${RAINBOND_JWT:-}"
RAINBOND_TOKEN_FROM_FLAG=0
RAINBOND_URL_FROM_FLAG=0
RAINBOND_CACHED_URL="${RAINBOND_URL:-}"
DEPLOYMENT_MODE_INPUT=""
SAAS_DEFAULT_URL="https://run.rainbond.com"
LOGIN_TIMEOUT="${RAINBOND_LOGIN_TIMEOUT:-300}"
ACTIVE_SHELL_RC=""

usage() {
  cat <<'EOF'
Usage:
  ./install.sh
  ./install.sh claude
  ./install.sh codex
  ./install.sh all
  ./install.sh --dest <path>
  ./install.sh all --saas
  ./install.sh all --self-hosted --rainbond-url <url>
  ./install.sh all --non-interactive --rainbond-url <url> --token <jwt>

Options:
  claude                 Install and configure Claude Code
  codex                  Install and configure Codex
  all                    Install and configure both platforms
  --dest PATH            Install skills to a custom directory only
  --force                Overwrite existing installed skills
  --skip-mcp             Skip Rainbond MCP setup
  --saas                 Use Rainbond Cloud (https://run.rainbond.com)
  --self-hosted          Use a self-hosted Rainbond Console (requires --rainbond-url)
  --non-interactive      Require all installer inputs through flags or env vars
  --rainbond-url URL     Rainbond base URL, for example http://example.com:7070
  --token JWT            Use an existing Rainbond JWT, skip browser login
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
EOF
}

log() {
  printf '%s\n' "$1"
}

warn() {
  printf '警告：%s\n' "$1" >&2
}

die() {
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

  if [[ -e "$dest" ]]; then
    if [[ "$FORCE" -eq 1 ]]; then
      rm -rf "$dest"
      cp -R "$src" "$dest"
      log "[overwrite] 已覆盖 $dest"
    else
      log "[skip] $dest 已存在"
    fi
  else
    cp -R "$src" "$dest"
    log "[install] 已安装到 $dest"
  fi
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
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

  log "请选择 Rainbond 部署形态："
  log "  1) Rainbond Cloud（SaaS：${SAAS_DEFAULT_URL}）"
  log "  2) 私有化部署（自填 Console 地址）"

  while true; do
    printf '请输入选项 [1-2，回车默认 1]: '
    read -r choice
    case "$choice" in
      1|"")
        DEPLOYMENT_MODE_INPUT="saas"
        return 0
        ;;
      2)
        DEPLOYMENT_MODE_INPUT="self-hosted"
        return 0
        ;;
      *)
        log "请输入 1 或 2。"
        ;;
    esac
  done
}

can_open_browser() {
  if [[ "$(uname -s)" == "Darwin" ]] && command -v open >/dev/null 2>&1; then
    return 0
  fi
  if command -v xdg-open >/dev/null 2>&1 && { [[ -n "${DISPLAY:-}" ]] || [[ -n "${WAYLAND_DISPLAY:-}" ]]; }; then
    return 0
  fi
  return 1
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

browser_login_to_rainbond() {
  local base_url="$1"
  local result_file state port auth_url
  result_file="$(mktemp)"

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

  # Server prints chosen port to stdout (file) on first line, then waits
  local waited=0
  while [[ ! -s "${result_file}.port" ]]; do
    sleep 0.1
    waited=$((waited + 1))
    if [[ "$waited" -gt 50 ]]; then
      kill "$server_pid" 2>/dev/null || true
      rm -f "$result_file" "${result_file}.port" "${result_file}.err"
      die "无法启动本地回调服务（端口准备超时）。"
    fi
    if ! kill -0 "$server_pid" 2>/dev/null; then
      cat "${result_file}.err" >&2 || true
      rm -f "$result_file" "${result_file}.port" "${result_file}.err"
      die "本地回调服务启动失败。"
    fi
  done

  port="$(head -n 1 "${result_file}.port")"
  auth_url="${base_url}/#/cli-auth?callback=$(python3 -c 'import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1], safe=""))' "http://127.0.0.1:${port}/cli-callback")&state=${state}"

  # Stderr only — this function's stdout is captured by the caller as the JWT.
  printf '正在浏览器中打开 Rainbond CLI 授权页面，请在浏览器中完成登录并点击「授权」按钮。\n' >&2
  printf '授权地址：%s\n' "$auth_url" >&2

  if ! can_open_browser; then
    warn "未检测到桌面环境，请手动在浏览器中打开上方地址完成授权。"
  else
    open_browser "$auth_url"
  fi

  if ! wait "$server_pid"; then
    local err
    err="$(cat "${result_file}.err" 2>/dev/null || true)"
    rm -f "$result_file" "${result_file}.port" "${result_file}.err"
    if [[ -n "$err" ]]; then
      die "$err"
    fi
    die "Rainbond 浏览器授权失败。"
  fi

  local token
  token="$(cat "$result_file")"
  rm -f "$result_file" "${result_file}.port" "${result_file}.err"
  if [[ -z "$token" ]]; then
    die "Rainbond 浏览器授权未返回 token。"
  fi
  printf '%s\n' "$token"
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
  printf '%s\n' "$token"
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
  codex mcp add rainbond --url "$mcp_url" --bearer-token-env-var RAINBOND_JWT >/dev/null
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
  claude mcp add --scope user --transport http rainbond "$mcp_url" -H "Authorization: GRJWT ${RAINBOND_JWT:-}" >/dev/null
  log "[configure] 已配置 Claude MCP"
}

validate_mcp_connectivity() {
  local base_url="$1"
  local token="$2"
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
      "${base_url}/console/mcp/query" \
      -H 'Accept: application/json' \
      -H 'Content-Type: application/json' \
      -H "Authorization: GRJWT ${token}" \
      -H 'MCP-Protocol-Version: 2025-03-26' \
      --data '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}'
  )"

  if [[ ! "$http_code" =~ ^2 ]]; then
    rm -f "$response_file"
    if [[ "$http_code" == "404" ]]; then
      die "Rainbond MCP 校验失败：${base_url} 未暴露 /console/mcp/query。登录已成功，说明这个环境可达，但当前部署的 Rainbond Console 可能未包含 MCP 接口，或你连接到了错误的 Rainbond 主机。"
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
    rm -f "$response_file"
    die "Rainbond MCP 校验返回了无法识别的响应"
  fi

  rm -f "$response_file"
  log "[verify] Rainbond MCP 可访问"
}

looks_like_jwt() {
  # JWT compact form: header.payload.signature, three base64url segments.
  [[ "$1" =~ ^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$ ]]
}

obtain_rainbond_token() {
  local base_url="$1"
  local mode="$2"

  if [[ -n "$RAINBOND_TOKEN_INPUT" ]]; then
    if ! looks_like_jwt "$RAINBOND_TOKEN_INPUT"; then
      warn "RAINBOND_JWT 不是合法的 JWT（应形如 xxx.yyy.zzz）；忽略并改走浏览器登录。"
      warn "如果你的当前 shell 还在加载旧的 ~/.rainbond/mcp.env，请先执行：unset RAINBOND_JWT"
      RAINBOND_TOKEN_INPUT=""
    elif [[ "$RAINBOND_TOKEN_FROM_FLAG" -eq 1 ]]; then
      printf '使用 --token 提供的 Rainbond JWT，跳过登录。\n' >&2
      printf '%s\n' "$RAINBOND_TOKEN_INPUT"
      return 0
    elif [[ -n "$RAINBOND_CACHED_URL" && "$RAINBOND_CACHED_URL" != "$base_url" ]]; then
      warn "检测到 shell 中已加载的 RAINBOND_JWT 来自 ${RAINBOND_CACHED_URL}，与本次目标 ${base_url} 不一致；忽略旧 token，将重新登录。"
      RAINBOND_TOKEN_INPUT=""
    elif [[ "$NON_INTERACTIVE" -eq 1 || ! -t 0 ]]; then
      printf '复用 shell 中已加载的 RAINBOND_JWT。\n' >&2
      printf '%s\n' "$RAINBOND_TOKEN_INPUT"
      return 0
    else
      local cached_label="${RAINBOND_CACHED_URL:-未知来源}"
      printf '检测到 shell 中已加载的 RAINBOND_JWT（来自 %s）。是否复用？[y/N]: ' "$cached_label" >&2
      local reuse_answer=""
      read -r reuse_answer
      case "$reuse_answer" in
        y|Y|yes|YES)
          printf '%s\n' "$RAINBOND_TOKEN_INPUT"
          return 0
          ;;
        *)
          printf '将忽略旧 token 并重新登录。\n' >&2
          RAINBOND_TOKEN_INPUT=""
          ;;
      esac
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

configure_mcp() {
  [[ "$SKIP_MCP" -eq 0 ]] || return 0
  [[ -z "$CUSTOM_DEST" ]] || return 0

  if { [[ "$NON_INTERACTIVE" -eq 1 ]] || [[ ! -t 0 ]]; } && \
     [[ -z "$RAINBOND_URL_INPUT" && -z "$RAINBOND_TOKEN_INPUT" && -z "$DEPLOYMENT_MODE_INPUT" && -z "$RAINBOND_USERNAME_INPUT" && -z "$RAINBOND_PASSWORD_INPUT" ]]; then
    log "非交互模式下未提供 Rainbond 连接信息，已跳过 MCP 配置。"
    return 0
  fi

  ensure_python3
  resolve_deployment_mode

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
      base_url_input="$(prompt_for_value "Rainbond Console 地址" "$RAINBOND_URL_INPUT")"
      ;;
    *)
      die "未知部署形态：$DEPLOYMENT_MODE_INPUT"
      ;;
  esac
  base_url="$(normalize_rainbond_url "$base_url_input")"
  confirm_insecure_http_if_needed "$base_url"

  local token mcp_url
  token="$(obtain_rainbond_token "$base_url" "$DEPLOYMENT_MODE_INPUT")"
  # Refresh this process's env so downstream `claude mcp add` / `codex mcp add`
  # bake the freshly obtained token instead of whatever the parent shell had.
  export RAINBOND_JWT="$token"
  write_token_file "$token" "$base_url"
  configure_shell_autoload

  mcp_url="${base_url}/console/mcp/query"
  local configured=0
  case "$TARGET" in
    codex)
      configure_codex_mcp "$mcp_url" && configured=1 || true
      ;;
    claude)
      configure_claude_mcp "$mcp_url" && configured=1 || true
      ;;
    all)
      configure_codex_mcp "$mcp_url" && configured=$((configured + 1)) || true
      configure_claude_mcp "$mcp_url" && configured=$((configured + 1)) || true
      ;;
  esac

  (( configured > 0 )) || die "所选平台都未能完成 MCP 配置。"
  validate_mcp_connectivity "$base_url" "$token"

  if [[ -n "$ACTIVE_SHELL_RC" ]]; then
    log "当前 shell 提示：新开的终端会自动从 ${ACTIVE_SHELL_RC} 加载 RAINBOND_JWT。"
    log "如果你想立刻在当前终端使用 Codex 或 Claude，请执行：source ${ACTIVE_SHELL_RC}"
  fi
}

main() {
  parse_args "$@"
  resolve_target

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

  log "安装完成。"
  if [[ -n "$CUSTOM_DEST" || "$SKIP_MCP" -eq 1 ]]; then
    log "请重启 Claude Code 或 Codex 以加载新技能。"
  else
    log "请在重新加载 shell 环境后重启 Claude Code 或 Codex。"
  fi
}

main "$@"
