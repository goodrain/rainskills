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
  PrepareRuntime|ConfigureGuestNetwork|InstallRainbond|VerifyRainbond) ;;
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
}

case "$ACTION" in
  PrepareRuntime)
    prepare_runtime
    ;;
  ConfigureGuestNetwork)
    configure_guest_network
    ;;
  InstallRainbond)
    assert_identity
    verify_installer
    [[ -f "$NETWORK_READY_FILE" ]] || { printf 'Managed network is not ready\n' >&2; exit 1; }
    EIP="$GUEST_ADDRESS" RAINBOND_INSTALL_LANG=zh bash "$INSTALLER_PATH"
    ;;
  VerifyRainbond)
    assert_identity
    docker inspect rainbond --format '{{.State.Status}}'
    ;;
esac
