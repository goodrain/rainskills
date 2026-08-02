#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEST_ROOT="$(mktemp -d)"

cleanup() {
  rm -rf "$TEST_ROOT"
}
trap cleanup EXIT

# Before install.sh becomes source-safe this keeps its current main path
# non-interactive; after the guard is added these arguments are ignored.
source "$REPO_ROOT/install.sh" --dest "$TEST_ROOT/source-probe" --force
trap cleanup EXIT
trap - INT TERM

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  exit 1
}

run_mode() (
  local os_name="$1"
  local has_open="$2"
  local has_xdg_open="$3"
  local container_detected="$4"
  shift 4

  unset RAINSKILLS_NO_BROWSER SSH_CONNECTION SSH_CLIENT SSH_TTY container
  unset DISPLAY WAYLAND_DISPLAY
  NO_BROWSER=0
  TEST_OS_NAME="$os_name"
  TEST_HAS_OPEN="$has_open"
  TEST_HAS_XDG_OPEN="$has_xdg_open"
  TEST_CONTAINER_DETECTED="$container_detected"

  uname() {
    printf '%s\n' "$TEST_OS_NAME"
  }

  command() {
    if [[ "${1:-}" == "-v" ]]; then
      case "${2:-}" in
        open)
          [[ "$TEST_HAS_OPEN" == "1" ]]
          return
          ;;
        xdg-open)
          [[ "$TEST_HAS_XDG_OPEN" == "1" ]]
          return
          ;;
      esac
    fi
    builtin command "$@"
  }

  is_container_environment() {
    [[ "$TEST_CONTAINER_DETECTED" == "1" ]]
  }

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --parse-no-browser)
        parse_args --no-browser
        shift
        ;;
      *=*)
        export "$1"
        shift
        ;;
      *)
        fail "unknown run_mode input: $1"
        ;;
    esac
  done

  browser_authorization_mode
)

assert_mode() {
  local name="$1"
  local expected="$2"
  shift 2
  local actual
  actual="$(run_mode "$@")"
  [[ "$actual" == "$expected" ]] \
    || fail "$name: expected $expected, got $actual"
}

assert_container_fixture() {
  local name="$1"
  local fixture_root="$2"
  if ! (
    unset container
    is_container_environment "$fixture_root"
  ); then
    fail "$name: expected container detection"
  fi
}

assert_mode "explicit flag overrides desktop" manual-copy \
  Linux 0 1 0 DISPLAY=:0 --parse-no-browser
assert_mode "environment override wins over desktop" manual-copy \
  Linux 0 1 0 DISPLAY=:0 RAINSKILLS_NO_BROWSER=1
assert_mode "SSH_CONNECTION wins over forwarded display" manual-copy \
  Linux 0 1 0 DISPLAY=:0 SSH_CONNECTION="client server"
assert_mode "SSH_CLIENT selects manual mode" manual-copy \
  Linux 0 1 0 SSH_CLIENT="client 123 22"
assert_mode "SSH_TTY selects manual mode" manual-copy \
  Linux 0 1 0 SSH_TTY=/dev/pts/1
assert_mode "container wins over inherited Wayland display" manual-copy \
  Linux 0 1 1 WAYLAND_DISPLAY=wayland-0
assert_mode "local macOS opens its browser" local-browser \
  Darwin 1 0 0
assert_mode "local Linux X11 opens its browser" local-browser \
  Linux 0 1 0 DISPLAY=:0
assert_mode "local Linux Wayland opens its browser" local-browser \
  Linux 0 1 0 WAYLAND_DISPLAY=wayland-0
assert_mode "headless Linux uses manual copy" manual-copy \
  Linux 0 1 0

mkdir -p "$TEST_ROOT/docker" "$TEST_ROOT/podman/run" "$TEST_ROOT/cgroup/proc/1"
touch "$TEST_ROOT/docker/.dockerenv"
touch "$TEST_ROOT/podman/run/.containerenv"
assert_container_fixture "Docker marker" "$TEST_ROOT/docker"
assert_container_fixture "Podman marker" "$TEST_ROOT/podman"

for marker in docker containerd kubepods libpod lxc; do
  printf '0::/%s/test\n' "$marker" > "$TEST_ROOT/cgroup/proc/1/cgroup"
  assert_container_fixture "cgroup marker $marker" "$TEST_ROOT/cgroup"
done

if (
  export container=podman
  is_container_environment "$TEST_ROOT/empty"
); then
  :
else
  fail "container environment variable was not detected"
fi

printf 'PASS: browser authorization mode tests\n'
