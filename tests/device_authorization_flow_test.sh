#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEST_ROOT="$(mktemp -d)"

cleanup() {
  rm -rf "$TEST_ROOT"
}
trap cleanup EXIT

source "$REPO_ROOT/install.sh" --dest "$TEST_ROOT/source-probe" --force
trap cleanup EXIT
trap - INT TERM

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  exit 1
}

(
  RAINSKILLS_RUNTIME_CONNECT_COMPLETION=1
  RAINSKILLS_RUNTIME_OPERATION_ID="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
  node() { return 0; }
  assert_internal_connect_entry \
    connect codex \
    --self-hosted \
    --rainbond-url http://10.0.0.8:7070 \
    --allow-insecure-http \
    --no-cached-token
) || fail "internal runtime connect gate rejected the launcher's fixed --no-cached-token argument"

set +e
unknown_gate_output="$(
  (
    RAINSKILLS_RUNTIME_CONNECT_COMPLETION=1
    RAINSKILLS_RUNTIME_OPERATION_ID="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
    node() { return 0; }
    assert_internal_connect_entry connect codex --saas --unsupported-sensitive-value
  ) 2>&1
)"
unknown_gate_status=$?
set -e
[[ "$unknown_gate_status" -ne 0 ]] || fail "internal runtime connect gate accepted an unknown argument"
grep -F "内部门禁包含不支持的参数" <<<"$unknown_gate_output" >/dev/null \
  || fail "internal runtime connect gate did not explain an unknown argument"
if grep -F -- "--unsupported-sensitive-value" <<<"$unknown_gate_output" >/dev/null; then
  fail "internal runtime connect gate reflected an unknown argument"
fi

assert_equal() {
  local name="$1" expected="$2" actual="$3"
  [[ "$actual" == "$expected" ]] || fail "$name: expected '$expected', got '$actual'"
}

assert_contains() {
  local name="$1" path="$2" expected="$3"
  grep -F -- "$expected" "$path" >/dev/null || fail "$name: missing '$expected'"
}

HTTP_CALL=0
device_flow_http_post() {
  local endpoint="$1" body_file="$2" response_file="$3" header_file="$4" status_file="$5"
  printf '%s %s\n' "$endpoint" "$body_file" >> "$TEST_ROOT/http-args.log"
  if [[ "$endpoint" == */console/mcp/device/code ]]; then
    cat > "$response_file" <<'JSON'
{"device_code":"super-secret-device-code","user_code":"BCDF-GHJK","verification_uri":"https://attacker.example/device","verification_uri_complete":"https://attacker.example/device?user_code=BCDF-GHJK","expires_in":600,"interval":5}
JSON
    printf 'HTTP/1.1 200 OK\r\n\r\n' > "$header_file"
    printf '200' > "$status_file"
    return 0
  fi

  HTTP_CALL=$((HTTP_CALL + 1))
  grep -F 'device_code=super-secret-device-code' "$body_file" >/dev/null \
    || fail "poll request body did not contain device code"
  case "$HTTP_CALL" in
    1)
      printf '{"error":"authorization_pending"}' > "$response_file"
      printf '400' > "$status_file"
      ;;
    2)
      printf '{"error":"slow_down"}' > "$response_file"
      printf '400' > "$status_file"
      ;;
    3)
      printf '{"access_token":"header.payload.signature","token_type":"Bearer","expires_in":31536000,"scope":"mcp"}' > "$response_file"
      printf '200' > "$status_file"
      ;;
    *)
      fail "unexpected token poll $HTTP_CALL"
      ;;
  esac
  printf 'HTTP/1.1 %s\r\n\r\n' "$(cat "$status_file")" > "$header_file"
}

device_flow_sleep() {
  printf '%s\n' "$1" >> "$TEST_ROOT/sleep.log"
}

device_flow_now() {
  printf '0\n'
}

can_open_browser() {
  return 0
}

open_browser() {
  printf '%s\n' "$1" > "$TEST_ROOT/browser.log"
}

LOGIN_TIMEOUT=600
OBTAINED_RAINBOND_TOKEN=""
device_flow_login_to_rainbond "https://console.example.com" 2>"$TEST_ROOT/output.log" \
  || fail "device flow login failed"

assert_equal "returned token" "header.payload.signature" "$OBTAINED_RAINBOND_TOKEN"
assert_equal "poll sleeps" $'5\n5\n10' "$(cat "$TEST_ROOT/sleep.log")"
assert_equal \
  "browser URL is pinned to selected Console" \
  "https://console.example.com/#/device?user_code=BCDF-GHJK" \
  "$(cat "$TEST_ROOT/browser.log")"
if grep -F 'super-secret-device-code' "$TEST_ROOT/http-args.log" >/dev/null; then
  fail "device code leaked into HTTP hook arguments"
fi
if sed -n '/validate_mcp_connectivity()/,/^}/p' "$REPO_ROOT/install.sh" \
    | grep -F -- '-H "Authorization: GRJWT' >/dev/null; then
  fail "MCP JWT leaked into curl arguments"
fi
assert_contains "terminal code" "$TEST_ROOT/output.log" "BCDF-GHJK"
assert_contains \
  "fixed authorization message begin" \
  "$TEST_ROOT/output.log" \
  "[RAINSKILLS_USER_MESSAGE_BEGIN:runtime.device-authorization]"
assert_contains \
  "fixed authorization message end" \
  "$TEST_ROOT/output.log" \
  "[RAINSKILLS_USER_MESSAGE_END:runtime.device-authorization]"

prepare_device_flow_temp_dir
DEVICE_FLOW_DEVICE_CODE="superseded-device-code"
DEVICE_FLOW_INTERVAL=5
DEVICE_FLOW_EXPIRES_IN=600
RAINSKILLS_RUNTIME_CONNECT_COMPLETION=1
RAINSKILLS_RUNTIME_OPERATION_ID="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
TARGET=codex
DEPLOYMENT_MODE_INPUT=saas
node() {
  printf '%s\n' "$*" > "$TEST_ROOT/superseded-assert.log"
  return 1
}
device_flow_sleep() { :; }
device_flow_http_post() {
  fail "superseded authorization polled the token endpoint"
}

if poll_device_authorization "https://console.example.com"; then
  fail "superseded authorization continued polling"
fi
assert_equal \
  "superseded authorization error" \
  "本次设备授权已被新的授权尝试替换。" \
  "$DEVICE_FLOW_ERROR"
assert_contains \
  "superseded operation assertion" \
  "$TEST_ROOT/superseded-assert.log" \
  "runtime assert-connect --onboarding-id aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa --target codex --environment-kind saas --console-origin https://console.example.com"
cleanup_device_flow
unset RAINSKILLS_RUNTIME_CONNECT_COMPLETION RAINSKILLS_RUNTIME_OPERATION_ID
unset -f node

non_tty_result="$TEST_ROOT/non-tty-token"
non_tty_error="$TEST_ROOT/non-tty-error"
set +e
(
  NON_INTERACTIVE=0
  RAINBOND_TOKEN_INPUT=""
  RAINBOND_USERNAME_INPUT=""
  RAINBOND_PASSWORD_INPUT=""
  device_flow_login_to_rainbond() {
    [[ ! -t 0 ]] || exit 91
    OBTAINED_RAINBOND_TOKEN="non.tty.token"
    return 0
  }
  obtain_rainbond_token "https://console.example.com" "saas"
  printf '%s' "$OBTAINED_RAINBOND_TOKEN" > "$non_tty_result"
) </dev/null 2>"$non_tty_error"
non_tty_status=$?
set -e
[[ "$non_tty_status" -eq 0 ]] || fail "Device Flow was blocked without a terminal TTY"
assert_equal "non-TTY Device Flow token" "non.tty.token" "$(cat "$non_tty_result")"

scoped_token="$(python3 - <<'PY'
import base64
import json

def segment(value):
    raw = json.dumps(value, separators=(",", ":")).encode("utf-8")
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")

print("{}.{}.signature".format(
    segment({"alg": "HS256", "typ": "JWT"}),
    segment({"enterprise_id": "enterprise-device", "token_use": "mcp"}),
))
PY
)"
assert_equal \
  "enterprise id from scoped JWT" \
  "enterprise-device" \
  "$(printf '%s' "$scoped_token" | enterprise_id_from_jwt)"

legacy_body="$TEST_ROOT/legacy.body"
legacy_headers="$TEST_ROOT/legacy.headers"
printf 'Not Found' > "$legacy_body"
printf 'HTTP/1.1 404 Not Found\r\nContent-Type: text/plain\r\n\r\n' > "$legacy_headers"
is_verified_legacy_device_route "404" "$legacy_body" "$legacy_headers" \
  || fail "verified legacy 404 was not recognized"

printf '{"error":"invalid_client"}' > "$legacy_body"
if is_verified_legacy_device_route "404" "$legacy_body" "$legacy_headers"; then
  fail "ambiguous JSON 404 must not trigger legacy fallback"
fi
if is_verified_legacy_device_route "405" "$legacy_body" "$legacy_headers"; then
  fail "405 must not trigger legacy fallback"
fi

html404_body="$TEST_ROOT/legacy-html404.body"
html404_headers="$TEST_ROOT/legacy-html404.headers"
printf '<!doctype html>\n<html><head><title>Not Found</title></head><body><h1>Not Found</h1></body></html>' > "$html404_body"
printf 'HTTP/1.1 404 Not Found\r\nContent-Type: text/html; charset=utf8\r\n\r\n' > "$html404_headers"
is_verified_legacy_device_route "404" "$html404_body" "$html404_headers" \
  || fail "verified HTML 404 (v6.9.x console) was not recognized"

printf 'PASS: device authorization flow tests\n'
