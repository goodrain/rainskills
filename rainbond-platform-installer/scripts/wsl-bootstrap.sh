#!/usr/bin/env bash
set -Eeuo pipefail

ACTION=""
INSTALLATION_ID=""
HOST_ADDRESS=""
GUEST_ADDRESS=""
INSTALLER_PATH=""
INSTALLER_SHA256=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --action)
      ACTION="${2:-}"
      shift 2
      ;;
    --installation-id)
      INSTALLATION_ID="${2:-}"
      shift 2
      ;;
    --host-address)
      HOST_ADDRESS="${2:-}"
      shift 2
      ;;
    --guest-address)
      GUEST_ADDRESS="${2:-}"
      shift 2
      ;;
    --installer-path)
      INSTALLER_PATH="${2:-}"
      shift 2
      ;;
    --installer-sha256)
      INSTALLER_SHA256="${2:-}"
      shift 2
      ;;
    *)
      printf 'Unsupported argument: %s\n' "$1" >&2
      exit 2
      ;;
  esac
done

case "$ACTION" in
  PrepareRuntime|ConfigureGuestNetwork|PrepareDocker|InstallRainbond|VerifyRainbond) ;;
  *)
    printf 'Unsupported action\n' >&2
    exit 2
    ;;
esac

if [[ ! "$INSTALLATION_ID" =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$ ]]; then
  printf 'Invalid installation id\n' >&2
  exit 2
fi
if [[ "$(id -u)" -ne 0 ]]; then
  printf 'The managed WSL helper must run as root\n' >&2
  exit 1
fi

STATE_DIR="/var/lib/rainskills"
IDENTITY_FILE="/etc/rainskills-installation-id"
NETWORK_READY_FILE="/run/rainskills/network-ready"
LOCK_FILE="/run/lock/rainskills-platform.lock"
INSTALL_LOG="/var/log/rainskills/rainbond-install.log"
mkdir -p "$STATE_DIR" /run/rainskills /run/lock
exec 9>"$LOCK_FILE"
flock -n 9 || { printf 'Another RainSkills WSL action is running\n' >&2; exit 1; }

assert_identity() {
  if [[ -f "$IDENTITY_FILE" ]]; then
    [[ "$(tr -d '\r\n' < "$IDENTITY_FILE")" == "$INSTALLATION_ID" ]] || {
      printf 'Managed distro identity mismatch\n' >&2
      exit 1
    }
  else
    printf '%s\n' "$INSTALLATION_ID" > "$IDENTITY_FILE"
    chmod 600 "$IDENTITY_FILE"
  fi
}

is_ipv4() {
  local value="$1" part
  [[ "$value" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || return 1
  IFS=. read -r -a parts <<< "$value"
  for part in "${parts[@]}"; do
    ((10#$part >= 0 && 10#$part <= 255)) || return 1
  done
}

prepare_runtime() {
  assert_identity
  printf '[boot]\nsystemd=true\n' > /etc/wsl.conf
  chmod 644 /etc/wsl.conf

  cat > /etc/systemd/system/rainskills-network-ready.service <<'UNIT'
[Unit]
Description=Wait for the RainSkills managed WSL network
ConditionPathExists=/etc/rainskills-installation-id
Before=docker.service containerd.service

[Service]
Type=oneshot
ExecStart=/bin/bash -c 'until test -f /run/rainskills/network-ready; do sleep 1; done'
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
UNIT
  mkdir -p /etc/systemd/system/docker.service.d /etc/systemd/system/containerd.service.d
  cat > /etc/systemd/system/docker.service.d/10-rainskills-network.conf <<'UNIT'
[Unit]
Requires=rainskills-network-ready.service
After=rainskills-network-ready.service
UNIT
  cp /etc/systemd/system/docker.service.d/10-rainskills-network.conf \
    /etc/systemd/system/containerd.service.d/10-rainskills-network.conf
  systemctl daemon-reload 2>/dev/null || true
  systemctl enable rainskills-network-ready.service >/dev/null 2>&1 || true
}

configure_guest_network() {
  assert_identity
  is_ipv4 "$HOST_ADDRESS" && is_ipv4 "$GUEST_ADDRESS" || {
    printf 'Invalid fixed network address\n' >&2
    exit 2
  }
  [[ "$HOST_ADDRESS" != "$GUEST_ADDRESS" ]] || { printf 'Host and guest addresses must differ\n' >&2; exit 2; }
  local interface_name
  interface_name="$(ip -o route show default | awk 'NR == 1 { print $5 }')"
  [[ -n "$interface_name" ]] || { printf 'Unable to identify the WSL network interface\n' >&2; exit 1; }
  if ! ip -o -4 address show dev "$interface_name" | awk '{print $4}' | grep -Fxq "$GUEST_ADDRESS/30"; then
    ip address add "$GUEST_ADDRESS/30" dev "$interface_name"
  fi
  ip route replace "$HOST_ADDRESS/32" dev "$interface_name" src "$GUEST_ADDRESS"
  printf '%s\n' "$GUEST_ADDRESS" > "$STATE_DIR/guest-address"
  touch "$NETWORK_READY_FILE"
  systemctl start rainskills-network-ready.service
}

verify_installer() {
  [[ -f "$INSTALLER_PATH" && ! -L "$INSTALLER_PATH" ]] || { printf 'Installer is missing\n' >&2; exit 1; }
  [[ "$INSTALLER_SHA256" =~ ^[a-f0-9]{64}$ ]] || { printf 'Invalid installer digest\n' >&2; exit 2; }
  local actual
  actual="$(sha256sum "$INSTALLER_PATH" | awk '{print $1}')"
  [[ "$actual" == "$INSTALLER_SHA256" ]] || { printf 'Installer digest mismatch\n' >&2; exit 1; }
  bash -n "$INSTALLER_PATH" || { printf 'Installer Bash syntax check failed\n' >&2; exit 1; }
}

emit_progress() {
  local stage="$1" status="$2"
  printf '{"schema":"rainskills.platform-progress.v1","stage":"%s","status":"%s","timestamp":"%s"}\n' \
    "$stage" "$status" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}

redact_stream() {
  sed -E \
    -e 's/(Authorization:[[:space:]]*Bearer[[:space:]]+)[^[:space:]]+/\1[REDACTED]/Ig' \
    -e 's/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/[REDACTED]/g' \
    -e 's/((password|device[_-]?code|access[_-]?token|refresh[_-]?token)=)[^&[:space:]]+/\1[REDACTED]/Ig'
}

prepare_docker() {
  assert_identity
  [[ -f "$NETWORK_READY_FILE" ]] || { printf 'Managed network is not ready\n' >&2; exit 1; }
  emit_progress preparing-docker started
  if ! command -v docker >/dev/null 2>&1; then
    export DEBIAN_FRONTEND=noninteractive
    apt-get update
    apt-get install -y ca-certificates curl docker.io
  fi
  systemctl enable docker >/dev/null
  systemctl start docker
  docker info >/dev/null
  emit_progress preparing-docker completed
}

install_rainbond() {
  assert_identity
  verify_installer
  is_ipv4 "$GUEST_ADDRESS" || { printf 'Invalid Rainbond EIP\n' >&2; exit 2; }
  [[ -f "$NETWORK_READY_FILE" ]] || { printf 'Managed network is not ready\n' >&2; exit 1; }
  docker info >/dev/null
  local ownership_file="$STATE_DIR/rainbond-installation-id"
  if docker inspect rainbond >/dev/null 2>&1; then
    [[ -f "$ownership_file" && "$(tr -d '\r\n' < "$ownership_file")" == "$INSTALLATION_ID" ]] || {
      printf 'Existing rainbond container is not owned by this installation\n' >&2
      exit 1
    }
    if [[ "$(docker inspect rainbond --format '{{.State.Status}}')" == "running" ]]; then
      emit_progress installing-rainbond completed
      return
    fi
    printf 'Rebuilding the stopped Rainbond container in CPU mode\n'
    docker rm rainbond >/dev/null
  elif [[ -f "$ownership_file" && "$(tr -d '\r\n' < "$ownership_file")" != "$INSTALLATION_ID" ]]; then
    printf 'Rainbond ownership marker mismatch\n' >&2
    exit 1
  fi
  printf '%s\n' "$INSTALLATION_ID" > "$ownership_file"
  chmod 600 "$ownership_file"
  mkdir -p "$(dirname "$INSTALL_LOG")"
  touch "$INSTALL_LOG"
  chmod 600 "$INSTALL_LOG"
  emit_progress installing-rainbond started
  set +e
  setsid env EIP="$GUEST_ADDRESS" ENABLE_GPU=false RAINBOND_INSTALL_LANG=zh bash "$INSTALLER_PATH" 2>&1 \
    | redact_stream | tee -a "$INSTALL_LOG" &
  local install_pid=$!
  while kill -0 "$install_pid" >/dev/null 2>&1; do
    emit_progress installing-rainbond heartbeat
    sleep 10
  done
  wait "$install_pid"
  local install_status=$?
  set -e
  [[ "$install_status" -eq 0 ]] || { printf 'Rainbond installer failed with exit code %s\n' "$install_status" >&2; exit "$install_status"; }
  emit_progress installing-rainbond completed
}

verify_rainbond() {
  assert_identity
  is_ipv4 "$GUEST_ADDRESS" || { printf 'Invalid Rainbond EIP\n' >&2; exit 2; }
  [[ "$(docker inspect rainbond --format '{{.State.Status}}')" == "running" ]] || {
    printf 'Rainbond container is not running\n' >&2
    exit 1
  }
  docker exec rainbond kubectl get nodes --no-headers \
    | awk 'NF && $2 != "Ready" { exit 1 } END { if (NR == 0) exit 1 }'
  docker exec rainbond kubectl get pods -n rbd-system --no-headers \
    | awk 'NF { split($2, ready, "/"); if (ready[1] != ready[2] || ($3 != "Running" && $3 != "Completed")) exit 1 } END { if (NR == 0) exit 1 }'
  local port
  for port in 80 443 6060 7070; do
    ss -lntH | awk '{print $4}' | grep -Eq "(^|:)$port$" || {
      printf 'Required port %s is not listening\n' "$port" >&2
      exit 1
    }
  done
  curl -fsS --max-time 10 "http://$GUEST_ADDRESS:7070/" >/dev/null
  printf 'containerRunning=true\nnodeReady=true\ncomponentsReady=true\nwslConsoleReachable=true\n'
}

case "$ACTION" in
  PrepareRuntime)
    prepare_runtime
    ;;
  ConfigureGuestNetwork)
    configure_guest_network
    ;;
  PrepareDocker)
    prepare_docker
    ;;
  InstallRainbond)
    install_rainbond
    ;;
  VerifyRainbond)
    verify_rainbond
    ;;
esac
