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
RESTORE_NETWORK_HELPER="/usr/local/libexec/rainskills-restore-network"
FORWARD_DOCKER_HELPER="/usr/local/libexec/rainskills-forward-docker-ports"
LOCK_FILE="/run/lock/rainskills-platform.lock"
INSTALL_LOG="/var/log/rainskills/rainbond-install.log"
VERIFY_TIMEOUT_SECONDS=1200
VERIFY_INTERVAL_SECONDS=10
mkdir -p "$STATE_DIR" /run/rainskills /run/lock
chmod 700 "$STATE_DIR"
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

  install -d -m 755 /usr/local/libexec
  cat > "$RESTORE_NETWORK_HELPER" <<'SCRIPT'
#!/usr/bin/env bash
set -Eeuo pipefail

STATE_DIR="/var/lib/rainskills"
NETWORK_READY_FILE="/run/rainskills/network-ready"

is_ipv4() {
  local value="$1" part
  local -a parts
  [[ "$value" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || return 1
  IFS=. read -r -a parts <<< "$value"
  for part in "${parts[@]}"; do
    ((10#$part >= 0 && 10#$part <= 255)) || return 1
  done
}

read_address() {
  local path="$1" value
  [[ -f "$path" && ! -L "$path" && "$(stat -c '%u' "$path")" == "0" ]] || {
    printf 'Managed network state is missing or unsafe: %s\n' "$path" >&2
    exit 1
  }
  value="$(tr -d '\r\n' < "$path")"
  is_ipv4 "$value" || {
    printf 'Managed network state contains an invalid address: %s\n' "$path" >&2
    exit 1
  }
  printf '%s' "$value"
}

host_address="$(read_address "$STATE_DIR/host-address")"
guest_address="$(read_address "$STATE_DIR/guest-address")"
[[ "$host_address" != "$guest_address" ]] || {
  printf 'Managed host and guest addresses must differ\n' >&2
  exit 1
}

interface_name=""
for _ in $(seq 1 30); do
  interface_name="$(ip -o route show default | awk 'NR == 1 { print $5 }')"
  [[ -n "$interface_name" ]] && break
  sleep 1
done
[[ -n "$interface_name" ]] || {
  printf 'Unable to identify the WSL network interface during boot\n' >&2
  exit 1
}

if ! ip -o -4 address show dev "$interface_name" | awk '{print $4}' | grep -Fxq "$guest_address/30"; then
  ip address add "$guest_address/30" dev "$interface_name"
fi
ip route replace "$host_address/32" dev "$interface_name" src "$guest_address"
install -d -m 755 /run/rainskills
touch "$NETWORK_READY_FILE"
SCRIPT
  chmod 755 "$RESTORE_NETWORK_HELPER"

  cat > "$FORWARD_DOCKER_HELPER" <<'SCRIPT'
#!/usr/bin/env bash
set -Eeuo pipefail

STATE_DIR="/var/lib/rainskills"

guest_state="$STATE_DIR/guest-address"
[[ -f "$guest_state" && ! -L "$guest_state" && "$(stat -c '%u' "$guest_state")" == "0" ]] || {
  printf 'Managed guest address is missing or unsafe\n' >&2
  exit 1
}
guest_address="$(tr -d '\r\n' < "$guest_state")"
[[ "$guest_address" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || {
  printf 'Managed guest address is invalid\n' >&2
  exit 1
}

command -v iptables >/dev/null 2>&1 || {
  printf 'iptables is unavailable\n' >&2
  exit 1
}
iptables -t nat -S DOCKER >/dev/null 2>&1 || {
  printf 'Docker NAT chain is unavailable\n' >&2
  exit 1
}

for chain in PREROUTING OUTPUT; do
  if ! iptables -t nat -C "$chain" -d "$guest_address/32" -j DOCKER >/dev/null 2>&1; then
    iptables -t nat -I "$chain" 1 -d "$guest_address/32" -j DOCKER
  fi
done
SCRIPT
  chmod 755 "$FORWARD_DOCKER_HELPER"

  cat > /etc/systemd/system/rainskills-network-ready.service <<'UNIT'
[Unit]
Description=Restore the RainSkills managed WSL network
ConditionPathExists=/etc/rainskills-installation-id
Before=docker.service containerd.service

[Service]
Type=oneshot
ExecStart=/usr/local/libexec/rainskills-restore-network
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
  cat > /etc/systemd/system/rainskills-docker-forwarding.service <<'UNIT'
[Unit]
Description=Forward the RainSkills fixed WSL address through Docker
ConditionPathExists=/etc/rainskills-installation-id
Requires=docker.service rainskills-network-ready.service
After=docker.service rainskills-network-ready.service
PartOf=docker.service

[Service]
Type=oneshot
ExecStart=/usr/local/libexec/rainskills-forward-docker-ports
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
UNIT
  systemctl daemon-reload 2>/dev/null || true
  systemctl enable rainskills-network-ready.service >/dev/null 2>&1 || true
  systemctl enable rainskills-docker-forwarding.service >/dev/null 2>&1 || true
}

configure_guest_network() {
  assert_identity
  is_ipv4 "$HOST_ADDRESS" && is_ipv4 "$GUEST_ADDRESS" || {
    printf 'Invalid fixed network address\n' >&2
    exit 2
  }
  [[ "$HOST_ADDRESS" != "$GUEST_ADDRESS" ]] || { printf 'Host and guest addresses must differ\n' >&2; exit 2; }
  local host_state guest_state
  host_state="$(mktemp "$STATE_DIR/.host-address.XXXXXX")"
  guest_state="$(mktemp "$STATE_DIR/.guest-address.XXXXXX")"
  printf '%s\n' "$HOST_ADDRESS" > "$host_state"
  printf '%s\n' "$GUEST_ADDRESS" > "$guest_state"
  chmod 600 "$host_state" "$guest_state"
  mv -f -- "$host_state" "$STATE_DIR/host-address"
  mv -f -- "$guest_state" "$STATE_DIR/guest-address"
  rm -f "$NETWORK_READY_FILE"
  systemctl restart rainskills-network-ready.service
  [[ -f "$NETWORK_READY_FILE" ]] || { printf 'Managed network restore did not complete\n' >&2; exit 1; }
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
  systemctl restart rainskills-docker-forwarding.service
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
  timeout 60 systemctl start docker || {
    printf 'Docker service did not start within 60 seconds\n' >&2
    exit 1
  }
  timeout 30 docker info >/dev/null 2>&1 || {
    printf 'Docker API did not become ready within 30 seconds\n' >&2
    exit 1
  }

  local deadline=$((SECONDS + VERIFY_TIMEOUT_SECONDS))
  local status nodes pods port last_check detail
  local -a missing_ports
  emit_progress verifying-rainbond started
  while ((SECONDS < deadline)); do
    last_check=""
    if ! status="$(timeout 20 docker inspect rainbond --format '{{.State.Status}}' 2>&1)"; then
      detail="${status//$'\r'/ }"
      detail="${detail//$'\n'/ }"
      last_check="Unable to inspect Rainbond container: ${detail:0:240}"
    elif [[ "$status" != "running" ]]; then
      last_check="Rainbond container state is $status"
    elif ! nodes="$(timeout 30 docker exec rainbond /bin/k3s kubectl get nodes --no-headers 2>&1)"; then
      detail="${nodes//$'\r'/ }"
      detail="${detail//$'\n'/ }"
      last_check="K3s node query failed: ${detail:0:240}"
    elif ! printf '%s\n' "$nodes" \
      | awk 'NF { seen=1; if ($2 != "Ready") bad=1 } END { exit (!seen || bad) }'; then
      detail="${nodes//$'\r'/ }"
      detail="${detail//$'\n'/ }"
      last_check="K3s node is not Ready: ${detail:0:240}"
    elif ! pods="$(timeout 30 docker exec rainbond /bin/k3s kubectl get pods -n rbd-system --no-headers 2>&1)"; then
      detail="${pods//$'\r'/ }"
      detail="${detail//$'\n'/ }"
      last_check="rbd-system pod query failed: ${detail:0:240}"
    elif ! printf '%s\n' "$pods" \
      | awk 'NF { seen=1; split($2, ready, "/"); if ($3 != "Completed" && $3 != "Succeeded" && ($3 != "Running" || ready[1] != ready[2])) bad=1 } END { exit (!seen || bad) }'; then
      last_check="rbd-system still has pending components"
    else
      missing_ports=()
      for port in 80 443 7070; do
        if ! ss -lntH | awk '{print $4}' | grep -Eq "(^|:)$port$"; then
          missing_ports+=("$port")
        fi
      done
      if ((${#missing_ports[@]} > 0)); then
        last_check="Required ports are not listening: ${missing_ports[*]}"
      elif ! curl -fsS --max-time 10 "http://127.0.0.1:7070/" >/dev/null; then
        last_check="Rainbond Console is not reachable inside WSL"
      fi
    fi

    if [[ -z "$last_check" ]]; then
      emit_progress verifying-rainbond completed
      printf 'containerRunning=true\nnodeReady=true\ncomponentsReady=true\nwslConsoleReachable=true\n'
      return
    fi
    printf 'Rainbond is still starting: %s\n' "$last_check"
    emit_progress verifying-rainbond heartbeat
    sleep "$VERIFY_INTERVAL_SECONDS"
  done

  printf 'Rainbond readiness timed out after %s seconds. Last check: %s\n' \
    "$VERIFY_TIMEOUT_SECONDS" "$last_check" >&2
  exit 1
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
