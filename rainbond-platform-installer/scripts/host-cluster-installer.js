"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline/promises");
const { spawn, spawnSync } = require("node:child_process");
const YAML = require("yaml");

const POLICY = require("../references/installation-policy.json");
const { createSecureStateStore } = require("./secure-state.js");
const { createWindowsSecureStateStore } = require("./windows-platform.js");

const REQUIRED_ROLES = ["etcd", "master", "worker", "rbd-gateway", "rbd-chaos"];
const ALL_ROLES = [...REQUIRED_ROLES, "nfs-server"];
const SENSITIVE_KEY = /(?:password|passwd|token|secret|private.?key|credential)/i;
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;
const SAFE_ADDRESS = /^(?:[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?|(?:[0-9a-fA-F]*:){2,}[0-9a-fA-F:.]+)$/;
const SAFE_REMOTE_PATH = /^\/[A-Za-z0-9._/-]+$/;
const MIN_CPU = 2;
const MIN_MEMORY = 4 * 1024 ** 3;
const MIN_DISK = 40 * 1024 ** 3;
const REQUIRED_PORTS = [80, 443, 6060, 7070];
const CRITICAL_WORKLOADS = ["rbd-api", "rbd-gateway", "rbd-app-ui"];
const HOST_PREFLIGHT_SCRIPT = String.raw`set -eu
root=false
[ "$(id -u)" = 0 ] && root=true
platform="$(uname -s | tr '[:upper:]' '[:lower:]')"
arch="$(uname -m)"
cpu="$(getconf _NPROCESSORS_ONLN 2>/dev/null || nproc 2>/dev/null || echo 0)"
memory_kb="$(awk '/^MemTotal:/ {print $2; exit}' /proc/meminfo 2>/dev/null || echo 0)"
opt_kb="$(df -Pk /opt/rainbond 2>/dev/null | awk 'END {print $4}')"
[ -n "$opt_kb" ] || opt_kb="$(df -Pk /opt 2>/dev/null | awk 'END {print $4}')"
rancher_kb="$(df -Pk /var/lib/rancher 2>/dev/null | awk 'END {print $4}')"
[ -n "$rancher_kb" ] || rancher_kb="$(df -Pk /var/lib 2>/dev/null | awk 'END {print $4}')"
ports=""
for port in 80 443 6060 7070; do
  if command -v ss >/dev/null 2>&1 && ss -lntH 2>/dev/null | awk '{print $4}' | grep -Eq "(^|:)$port$"; then
    if [ -n "$ports" ]; then ports="$ports,$port"; else ports="$port"; fi
  fi
done
source_reachable=false
image_reachable=false
software_reachable=false
if command -v curl >/dev/null 2>&1; then
  curl -fsSI --max-time 10 https://get.rainbond.com/ >/dev/null && source_reachable=true || true
  curl -fsSI --max-time 10 https://registry.cn-hangzhou.aliyuncs.com/ >/dev/null && image_reachable=true || true
  curl -fsSI --max-time 10 https://rpm.rancher.io/ >/dev/null && software_reachable=true || true
fi
existing_rke2=false
existing_rainbond=false
[ -e /etc/rancher/rke2/config.yaml ] || systemctl is-active --quiet rke2-server 2>/dev/null && existing_rke2=true || true
[ -d /opt/rainbond ] && find /opt/rainbond -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null | grep -q . && existing_rainbond=true || true
bootstrap_reachable=true
[ "$#" -gt 0 ] && shift
for peer in "$@"; do
  if command -v ping >/dev/null 2>&1; then
    ping -c 1 -W 2 "$peer" >/dev/null 2>&1 || bootstrap_reachable=false
  elif command -v nc >/dev/null 2>&1; then
    nc -z -w 2 "$peer" 22 >/dev/null 2>&1 || bootstrap_reachable=false
  else
    bootstrap_reachable=false
  fi
done
printf 'ROOT=%s\nPLATFORM=%s\nARCH=%s\nCPU=%s\nMEMORY_BYTES=%s\nOPT_BYTES=%s\nRANCHER_BYTES=%s\nOCCUPIED_PORTS=%s\nSOURCE_REACHABLE=%s\nIMAGE_REACHABLE=%s\nSOFTWARE_REACHABLE=%s\nBOOTSTRAP_REACHABLE=%s\nEXISTING_RKE2=%s\nEXISTING_RAINBOND=%s\n' \
  "$root" "$platform" "$arch" "$cpu" "$((memory_kb * 1024))" "$((opt_kb * 1024))" "$((rancher_kb * 1024))" "$ports" "$source_reachable" "$image_reachable" "$software_reachable" "$bootstrap_reachable" "$existing_rke2" "$existing_rainbond"
`;
const REMOTE_STAGE_SCRIPT = String.raw`set -eu
directory="$1"
temporary="$2"
[ ! -L "$directory" ] && [ -d "$directory" ] && [ "$(stat -c %u -- "$directory")" = 0 ] || exit 71
[ ! -e "$temporary" ] && [ ! -L "$temporary" ] || exit 72
umask 077
( set -C; : > "$temporary" ) 2>/dev/null || exit 72
[ ! -L "$temporary" ] && [ -f "$temporary" ] && [ "$(stat -c %u -- "$temporary")" = 0 ] || exit 72
`;
const REMOTE_PUBLISH_SCRIPT = String.raw`set -eu
temporary="$1"
final="$2"
expected="$3"
mode="$4"
trap 'rm -f -- "$temporary"' EXIT
[ ! -L "$temporary" ] && [ -f "$temporary" ] && [ "$(stat -c %u -- "$temporary")" = 0 ] || exit 72
actual="$(sha256sum -- "$temporary" | awk '{print $1}')"
[ "$actual" = "$expected" ] || exit 74
chmod "$mode" -- "$temporary"
if [ -e "$final" ] || [ -L "$final" ]; then
  [ ! -L "$final" ] && [ -f "$final" ] && [ "$(stat -c %u -- "$final")" = 0 ] || { printf 'FINAL_NOT_REGULAR\n' >&2; exit 73; }
  final_digest="$(sha256sum -- "$final" | awk '{print $1}')"
  [ "$final_digest" = "$expected" ] || exit 75
  chmod "$mode" -- "$final"
  printf '%s\n' "$final_digest"
  exit 0
fi
mv -T -n -- "$temporary" "$final"
[ ! -L "$final" ] && [ -f "$final" ] && [ "$(stat -c %u -- "$final")" = 0 ] || { printf 'FINAL_NOT_REGULAR\n' >&2; exit 73; }
final_digest="$(sha256sum -- "$final" | awk '{print $1}')"
[ "$final_digest" = "$expected" ] || exit 75
chmod "$mode" -- "$final"
printf '%s\n' "$final_digest"
`;

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function assertOperationNotAborted(abortState) {
  if (!abortState?.aborted) return;
  const error = new Error("主机集群安装已被信号中断");
  error.code = "RAINSKILLS_HOST_CLUSTER_INTERRUPTED";
  error.signal = abortState.signal || "SIGINT";
  throw error;
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function parseClusterDocument(input) {
  const text = Buffer.isBuffer(input) ? input.toString("utf8") : String(input || "");
  if (text.includes("\0")) throw new Error("cluster.yaml 不能包含 NUL 字节");
  const document = YAML.parseDocument(text, { uniqueKeys: true, prettyErrors: false });
  if (document.errors.length > 0) {
    throw new Error("cluster.yaml 解析失败，请检查 YAML 语法");
  }
  const value = document.toJS({ maxAliasCount: 50 });
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("cluster.yaml 顶层必须是映射对象");
  }
  return { document, value };
}

function hasSensitiveFields(value) {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(hasSensitiveFields);
  return Object.entries(value).some(([key, child]) => SENSITIVE_KEY.test(key) || hasSensitiveFields(child));
}

function normalizeHost(raw, index) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`hosts[${index}] 必须是对象`);
  }
  const name = String(raw.name || "");
  const address = String(raw.address || "");
  const internalAddress = String(raw.internalAddress || raw.address || "");
  const user = String(raw.user || "root");
  const port = raw.port === undefined ? 22 : Number(raw.port);
  if (!SAFE_NAME.test(name)) throw new Error(`节点名称无效：${name || `(index ${index})`}`);
  if (!SAFE_ADDRESS.test(address) || address.startsWith("-") || /\.\./.test(address)) {
    throw new Error(`节点 address 无效：${name}`);
  }
  if (!SAFE_ADDRESS.test(internalAddress) || internalAddress.startsWith("-") || /\.\./.test(internalAddress)) {
    throw new Error(`节点 internalAddress 无效：${name}`);
  }
  if (user !== "root") throw new Error(`ROI 主机安装只支持 root SSH 用户：${name}`);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`节点 SSH 端口无效：${name}`);
  if (raw.bootstrap !== undefined && typeof raw.bootstrap !== "boolean") {
    throw new Error(`节点 bootstrap 必须是布尔值：${name}`);
  }
  return { ...raw, name, address, internalAddress, user, port, bootstrap: raw.bootstrap === true };
}

function storageModeFor(config) {
  const nfs = config.storage?.nfs || {};
  const existing = config.storage?.existingStorageClass || {};
  if (existing.enabled === true) {
    if (nfs.enabled === true) throw new Error("内置/外部 NFS 与 existingStorageClass 不能同时启用");
    if (!String(existing.name || "").trim()) throw new Error("existingStorageClass 启用时必须提供 name");
    return "existing-storage-class";
  }
  if (nfs.enabled === true && String(nfs.server || "").trim()) return "external-nfs";
  if (nfs.enabled === true) return "builtin-nfs";
  return "external-or-unmanaged-storage";
}

function validateClusterTopology(config) {
  if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("集群配置必须是对象");
  if (!Array.isArray(config.hosts) || config.hosts.length === 0) throw new Error("集群至少需要一个节点");
  const hosts = config.hosts.map(normalizeHost);
  const names = new Set();
  const addresses = new Set();
  for (const item of hosts) {
    if (names.has(item.name)) throw new Error(`节点名称必须唯一：${item.name}`);
    names.add(item.name);
    for (const address of new Set([item.address, item.internalAddress])) {
      if (addresses.has(address)) throw new Error(`节点地址存在冲突：${address}`);
      addresses.add(address);
    }
  }
  const roleGroups = config.roleGroups;
  if (!roleGroups || typeof roleGroups !== "object" || Array.isArray(roleGroups)) {
    throw new Error("cluster.yaml 缺少 roleGroups");
  }
  const storageMode = storageModeFor(config);
  const roles = {};
  for (const role of ALL_ROLES) {
    const members = roleGroups[role] === undefined && role === "nfs-server" ? [] : roleGroups[role];
    if (!Array.isArray(members)) throw new Error(`roleGroups.${role} 必须是数组`);
    if (role === "etcd" && (members.length === 0 || members.length % 2 === 0)) {
      throw new Error("etcd 节点数必须是正奇数（1、3、5……）");
    }
    if (role !== "nfs-server" && members.length === 0) throw new Error(`roleGroups.${role} 至少需要一个节点`);
    if (role === "nfs-server" && storageMode === "builtin-nfs" && members.length !== 1) {
      throw new Error("使用内置 NFS 时 nfs-server 必须恰好包含一个节点");
    }
    if (role === "nfs-server" && storageMode !== "builtin-nfs" && members.length !== 0) {
      throw new Error("使用外部 NFS、existing StorageClass 或外部存储时 nfs-server 必须为空");
    }
    if (new Set(members).size !== members.length) throw new Error(`roleGroups.${role} 不能重复引用节点`);
    for (const member of members) {
      if (!names.has(member)) throw new Error(`roleGroups.${role} 引用了不存在的节点：${member}`);
    }
    roles[role] = [...members];
  }
  if (roles.etcd.length === 0 || roles.etcd.length % 2 === 0) {
    throw new Error("etcd 节点数必须是正奇数（1、3、5……）");
  }
  const bootstraps = hosts.filter(({ bootstrap }) => bootstrap);
  if (bootstraps.length !== 1) throw new Error("bootstrap 节点必须恰好配置一个");
  if (!roles.master.includes(bootstraps[0].name)) throw new Error("bootstrap 节点必须属于 master 角色组");
  return {
    hosts,
    roleGroups: roles,
    bootstrap: bootstraps[0],
    storageMode,
    warnings: hosts.length < 3 || roles.etcd.length < 3
      ? ["当前拓扑不具备控制面/etcd 高可用；可以继续，但正式环境建议至少 3 个控制面节点"]
      : [],
  };
}

function summarizeTopology(config) {
  const validated = validateClusterTopology(config);
  return {
    hosts: validated.hosts.length,
    bootstrap: validated.bootstrap.name,
    storageMode: validated.storageMode,
    warnings: [...validated.warnings],
    nodes: validated.hosts.map((item) => ({
      name: item.name,
      address: item.address,
      internalAddress: item.internalAddress,
      port: item.port,
      bootstrap: item.bootstrap,
      roles: ALL_ROLES.filter((role) => validated.roleGroups[role].includes(item.name)),
    })),
  };
}

function minimalClusterObject(config) {
  const validated = validateClusterTopology(config);
  return {
    hosts: validated.hosts.map((item) => ({
      name: item.name,
      address: item.address,
      internalAddress: item.internalAddress,
      user: "root",
      port: item.port,
      ...(item.bootstrap ? { bootstrap: true } : {}),
    })),
    roleGroups: Object.fromEntries(ALL_ROLES.map((role) => [role, [...validated.roleGroups[role]]])),
    storage: {
      nfs: { enabled: true, sharePath: "/nfs-data/k8s", storageClass: { enabled: true } },
      existingStorageClass: { enabled: false },
    },
    registry: { external: { enabled: false } },
    database: { mysql: { enabled: false }, custom: { enabled: false } },
  };
}

function serializeMinimalClusterConfig(config) {
  const value = minimalClusterObject(config);
  const serialized = YAML.stringify(value, { lineWidth: 0 });
  if (SENSITIVE_KEY.test(serialized)) {
    const sensitiveKeys = [];
    const visit = (child) => {
      if (!child || typeof child !== "object") return;
      for (const [key, nested] of Object.entries(child)) {
        if (SENSITIVE_KEY.test(key)) sensitiveKeys.push(key);
        visit(nested);
      }
    };
    visit(value);
    if (sensitiveKeys.length > 0) throw new Error("基础向导不能生成 password、token 或 secret 字段");
  }
  return Buffer.from(serialized, "utf8");
}

function sourceIdentity(info) {
  return ["dev", "ino", "size", "mtimeMs", "ctimeMs"].map((key) => String(info[key] ?? "")).join(":");
}

function contentIdentity(bytes) {
  return `sha256:${sha256(bytes)}:${bytes.length}`;
}

function readDescriptorBytes(fsImpl, filePath, flags) {
  let fd;
  try {
    fd = fsImpl.openSync(filePath, flags);
  } catch (error) {
    if (["ELOOP", "EMLINK"].includes(error.code)) throw new Error(`拒绝导入符号链接 cluster.yaml：${filePath}`);
    throw error;
  }
  try {
    const info = fsImpl.fstatSync(fd);
    if (!info.isFile() || info.isSymbolicLink?.()) throw new Error(`cluster.yaml 不是普通文件：${filePath}`);
    return { bytes: fsImpl.readFileSync(fd), info };
  } finally {
    fsImpl.closeSync(fd);
  }
}

function readSafeClusterSource(filePath, {
  requireOwnerOnlyWhenSensitive = true,
  platform = process.platform,
  sourceStateStore,
  fsImpl = fs,
  currentUid = typeof process.getuid === "function" ? process.getuid() : null,
} = {}) {
  let bytes;
  let info;
  if (platform === "win32") {
    if (!sourceStateStore || typeof sourceStateStore.assertSafeExternalRegularFile !== "function") {
      throw new Error("Windows cluster.yaml 必须通过当前用户 ACL 检查");
    }
    const beforeAcl = sourceStateStore.assertSafeExternalRegularFile(filePath);
    const first = readDescriptorBytes(fsImpl, filePath, fsImpl.constants.O_RDONLY);
    if (beforeAcl?.fileIdentity !== contentIdentity(first.bytes)) {
      throw new Error("Windows cluster.yaml ACL identity 与读取 fd 不匹配，拒绝导入");
    }
    const afterAcl = sourceStateStore.assertSafeExternalRegularFile(filePath);
    const second = readDescriptorBytes(fsImpl, filePath, fsImpl.constants.O_RDONLY);
    if (afterAcl?.fileIdentity !== contentIdentity(second.bytes)) {
      throw new Error("Windows cluster.yaml ACL identity 与读取 fd 不匹配，拒绝导入");
    }
    if (sourceIdentity(first.info) !== sourceIdentity(second.info) || sha256(first.bytes) !== sha256(second.bytes)) {
      throw new Error("cluster.yaml 在安全检查和读取期间发生变化，拒绝导入");
    }
    ({ bytes, info } = first);
  } else {
    const noFollow = fsImpl.constants.O_NOFOLLOW || 0;
    ({ bytes, info } = readDescriptorBytes(fsImpl, filePath, fsImpl.constants.O_RDONLY | noFollow));
  }
  if (currentUid !== null && info.uid !== currentUid) throw new Error(`cluster.yaml 不属于当前用户：${filePath}`);
  const parsed = parseClusterDocument(bytes).value;
  if (requireOwnerOnlyWhenSensitive && hasSensitiveFields(parsed)) {
    if (platform !== "win32" && (info.mode & 0o777) !== 0o600) {
      throw new Error("包含敏感字段的 cluster.yaml 权限必须精确为 0600");
    }
  }
  return { bytes, value: parsed };
}

function atomicWriteProtectedBytes(destinationPath, bytes, { stateStore, mode = 0o600 } = {}) {
  const target = path.resolve(destinationPath);
  const directory = path.dirname(target);
  if (stateStore) stateStore.ensurePrivateDirectory(directory);
  else {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") fs.chmodSync(directory, 0o700);
  }
  if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) throw new Error(`拒绝覆盖符号链接：${target}`);
  const temporary = path.join(directory, `.${path.basename(target)}.${process.pid}.${crypto.randomBytes(6).toString("hex")}`);
  const fd = fs.openSync(temporary, "wx", mode);
  try {
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    if (process.platform !== "win32") fs.chmodSync(temporary, mode);
    if (stateStore) stateStore.protectRegularFile(temporary);
    fs.renameSync(temporary, target);
    if (process.platform !== "win32") fs.chmodSync(target, mode);
    if (stateStore) stateStore.protectRegularFile(target);
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch (cleanupError) { if (cleanupError.code !== "ENOENT") throw cleanupError; }
    throw error;
  }
  return target;
}

function importClusterConfig({
  sourcePath,
  destinationPath,
  stateStore,
  sourceStateStore = stateStore,
  platform = process.platform,
}) {
  const source = path.resolve(String(sourcePath || ""));
  const destination = path.resolve(String(destinationPath || ""));
  if (source === destination) throw new Error("不能把用户 cluster.yaml 直接作为受保护副本使用");
  const { bytes, value } = readSafeClusterSource(source, { platform, sourceStateStore });
  validateClusterTopology(value);
  atomicWriteProtectedBytes(destination, bytes, { stateStore });
  return { path: destination, sha256: sha256(bytes), topology: summarizeTopology(value) };
}

function replaceHostRoles(roleGroups, oldName, newName, selectedRoles) {
  return Object.fromEntries(ALL_ROLES.map((role) => {
    const withoutOld = (roleGroups[role] || []).filter((name) => name !== oldName && name !== newName);
    return [role, selectedRoles.includes(role) ? [...withoutOld, newName] : withoutOld];
  }));
}

async function runClusterWizard({ initialConfig, prompt, persist, write = () => {} }) {
  if (typeof prompt !== "function") throw new Error("交互式向导需要 prompt 函数");
  if (typeof persist !== "function") throw new Error("交互式向导需要受保护的 persist 函数");
  let draft = deepClone(initialConfig || {
    hosts: [],
    roleGroups: Object.fromEntries(ALL_ROLES.map((role) => [role, []])),
    storage: { nfs: { enabled: true, sharePath: "/nfs-data/k8s", storageClass: { enabled: true } }, existingStorageClass: { enabled: false } },
    registry: { external: { enabled: false } },
    database: { mysql: { enabled: false }, custom: { enabled: false } },
  });
  for (;;) {
    const answer = await prompt({ config: deepClone(draft), summary: draft.hosts.map(({ name }) => name) });
    if (!answer || answer.action === "cancel") return { cancelled: true };
    if (answer.action === "list") {
      for (const item of draft.hosts) {
        const roles = ALL_ROLES.filter((role) => (draft.roleGroups[role] || []).includes(item.name));
        write(`- ${item.name}: ${item.address}:${item.port || 22} [${roles.join(", ")}]${item.bootstrap ? " bootstrap" : ""}\n`);
      }
      continue;
    }
    if (answer.action === "add") {
      const normalized = normalizeHost(answer.host, draft.hosts.length);
      if (draft.hosts.some(({ name }) => name === normalized.name)) throw new Error(`节点名称必须唯一：${normalized.name}`);
      draft.hosts = [...draft.hosts, normalized];
      draft.roleGroups = replaceHostRoles(draft.roleGroups, "", normalized.name, answer.roles || []);
      continue;
    }
    if (answer.action === "edit") {
      const index = draft.hosts.findIndex(({ name }) => name === answer.name);
      if (index < 0) throw new Error(`找不到要修改的节点：${answer.name}`);
      const normalized = normalizeHost(answer.host, index);
      if (draft.hosts.some((item, itemIndex) => itemIndex !== index && item.name === normalized.name)) {
        throw new Error(`节点名称必须唯一：${normalized.name}`);
      }
      draft.hosts = draft.hosts.map((item, itemIndex) => itemIndex === index ? normalized : item);
      draft.roleGroups = replaceHostRoles(draft.roleGroups, answer.name, normalized.name, answer.roles || []);
      continue;
    }
    if (answer.action === "delete") {
      if (!draft.hosts.some(({ name }) => name === answer.name)) throw new Error(`找不到要删除的节点：${answer.name}`);
      draft.hosts = draft.hosts.filter(({ name }) => name !== answer.name);
      draft.roleGroups = Object.fromEntries(ALL_ROLES.map((role) => [role, (draft.roleGroups[role] || []).filter((name) => name !== answer.name)]));
      continue;
    }
    if (answer.action === "save") {
      const bytes = serializeMinimalClusterConfig(draft);
      await persist(bytes);
      return { cancelled: false, config: minimalClusterObject(draft), bytes, topology: summarizeTopology(draft) };
    }
    throw new Error(`未知向导动作：${String(answer.action)}`);
  }
}

function parseBoolean(value) {
  return value === true || String(value).toLowerCase() === "true";
}

function parsePreflightOutput(output) {
  const text = String(output || "").trim();
  if (!text) throw new Error("远程预检没有返回结果");
  if (text.startsWith("{")) return JSON.parse(text);
  const values = {};
  for (const line of text.split("\n")) {
    const separator = line.indexOf("=");
    if (separator > 0) values[line.slice(0, separator)] = line.slice(separator + 1);
  }
  return {
    root: parseBoolean(values.ROOT),
    platform: values.PLATFORM,
    arch: values.ARCH,
    cpu: Number(values.CPU),
    memoryBytes: Number(values.MEMORY_BYTES),
    optBytes: Number(values.OPT_BYTES),
    rancherBytes: Number(values.RANCHER_BYTES),
    occupiedPorts: String(values.OCCUPIED_PORTS || "").split(",").filter(Boolean).map(Number),
    sourceReachable: parseBoolean(values.SOURCE_REACHABLE),
    imageReachable: parseBoolean(values.IMAGE_REACHABLE),
    softwareReachable: parseBoolean(values.SOFTWARE_REACHABLE),
    bootstrapReachable: parseBoolean(values.BOOTSTRAP_REACHABLE),
    existingRke2: parseBoolean(values.EXISTING_RKE2),
    existingRainbond: parseBoolean(values.EXISTING_RAINBOND),
  };
}

function evaluateHostFacts(facts, { bootstrap = false } = {}) {
  const blockers = [];
  const add = (condition, code, message) => { if (condition) blockers.push({ code, message }); };
  add(facts.root !== true, "root_required", "ROI 集群安装要求通过 root SSH 连接");
  add(String(facts.platform).toLowerCase() !== "linux", "linux_required", "节点必须运行 Linux");
  add(!["amd64", "x64", "x86_64", "arm64", "aarch64"].includes(String(facts.arch).toLowerCase()), "architecture_unsupported", "节点架构只支持 amd64 或 arm64");
  add(!Number.isFinite(Number(facts.cpu)) || Number(facts.cpu) < MIN_CPU, "cpu_insufficient", `节点至少需要 ${MIN_CPU} 核 CPU`);
  add(!Number.isFinite(Number(facts.memoryBytes)) || Number(facts.memoryBytes) < MIN_MEMORY, "memory_insufficient", "节点至少需要 4 GB 内存");
  add(!Number.isFinite(Number(facts.optBytes)) || Number(facts.optBytes) < MIN_DISK, "opt_disk_insufficient", "/opt/rainbond 至少需要 40 GB 可用空间");
  add(!Number.isFinite(Number(facts.rancherBytes)) || Number(facts.rancherBytes) < MIN_DISK, "rancher_disk_insufficient", "/var/lib/rancher 至少需要 40 GB 可用空间");
  const occupied = Array.isArray(facts.occupiedPorts) ? facts.occupiedPorts.filter((port) => REQUIRED_PORTS.includes(Number(port))) : [];
  add(occupied.length > 0, "ports_occupied", `端口已被占用：${occupied.join(", ")}`);
  add(facts.sourceReachable !== true, "source_unreachable", "Rainbond 安装源不可访问");
  add(facts.imageReachable !== true, "image_unreachable", "Rainbond 镜像源不可访问");
  add(facts.softwareReachable !== true, "software_unreachable", "RKE2/软件源不可访问");
  add(bootstrap && facts.bootstrapReachable !== true, "bootstrap_network_unreachable", "bootstrap 无法访问其他节点");
  add(facts.existingRke2 === true, "existing_rke2", "节点已存在 RKE2，安装器不会自动删除或覆盖");
  add(facts.existingRainbond === true, "existing_rainbond", "节点已存在 Rainbond 数据，安装器不会自动删除或覆盖");
  return blockers;
}

function defaultSshRunner(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const spawnFn = options.spawnFn || spawn;
    const registerChild = options.registerChild || (() => {});
    const child = spawnFn(command, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    const unregister = registerChild(child, false);
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    const clear = () => typeof unregister === "function" ? unregister() : registerChild(null, false);
    child.on("error", (error) => { clear(); reject(error); });
    child.on("close", (code, signal) => {
      clear();
      resolve({ code, signal, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") });
    });
    child.stdin.end(options.input || "");
  });
}

function sshOptionsForSession(session) {
  return [
    "-o", `BatchMode=${session?.interactive ? "no" : "yes"}`,
    ...(session?.controlPath ? ["-o", `ControlPath=${session.controlPath}`] : []),
  ];
}

async function prepareHostSshSessions(topology, {
  sessionFactory,
  interactive = process.stdin.isTTY && process.stdout.isTTY,
  write = (value) => process.stdout.write(value),
} = {}) {
  const sessions = new Map();
  if (typeof sessionFactory !== "function") return { waiting: false, sessions };
  for (const item of topology.hosts) {
    const session = await sessionFactory(item, { interactive, write });
    if (!session) {
      write("\n[RAINSKILLS_USER_INPUT_REQUIRED:host_cluster_ssh_authentication]\n");
      write(`节点 ${item.name} 需要系统 SSH 认证，请在交互终端继续。\n`);
      return { waiting: true, sessions };
    }
    sessions.set(item.name, session);
  }
  return { waiting: false, sessions };
}

async function runHostPreflight(config, { sshRunner = defaultSshRunner, sessions = new Map(), registerChild, sshSpawn } = {}) {
  const topology = validateClusterTopology(config);
  const tasks = topology.hosts.map(async (item) => {
    const peers = item.bootstrap
      ? topology.hosts.filter(({ name }) => name !== item.name).map(({ internalAddress }) => internalAddress)
      : [];
    const args = [...sshOptionsForSession(sessions.get(item.name)), "-p", String(item.port), `root@${item.address}`, "bash", "-s", "--", "rainskills-host-preflight-v1", ...peers];
    let execution;
    try {
      execution = await sshRunner("ssh", args, { input: HOST_PREFLIGHT_SCRIPT, registerChild, spawnFn: sshSpawn });
    } catch {
      return { name: item.name, address: item.address, arch: null, blockers: [{ code: "ssh_unreachable", message: "系统 SSH 无法连接该节点" }] };
    }
    if (execution.signal) {
      return { name: item.name, address: item.address, arch: null, interrupted: true, signal: execution.signal, blockers: [] };
    }
    if (execution.code !== 0) {
      return { name: item.name, address: item.address, arch: null, blockers: [{ code: "ssh_unreachable", message: "系统 SSH 无法连接该节点" }] };
    }
    let facts;
    try { facts = parsePreflightOutput(execution.stdout); } catch {
      return { name: item.name, address: item.address, arch: null, blockers: [{ code: "preflight_invalid", message: "节点返回了无效的预检结果" }] };
    }
    const blockers = evaluateHostFacts(facts, { bootstrap: item.bootstrap });
    return {
      name: item.name,
      address: item.address,
      arch: ["x86_64", "x64"].includes(String(facts.arch).toLowerCase()) ? "amd64" : String(facts.arch).toLowerCase() === "aarch64" ? "arm64" : String(facts.arch).toLowerCase(),
      cpu: Number(facts.cpu),
      memoryBytes: Number(facts.memoryBytes),
      optBytes: Number(facts.optBytes),
      rancherBytes: Number(facts.rancherBytes),
      blockers,
    };
  });
  const nodes = await Promise.all(tasks);
  const interrupted = nodes.find((node) => node.interrupted);
  return {
    ok: !interrupted && nodes.every(({ blockers }) => blockers.length === 0),
    nodes,
    blockers: nodes.flatMap((node) => node.blockers.map((blocker) => ({ node: node.name, ...blocker }))),
    ...(interrupted ? { interrupted: true, signal: interrupted.signal } : {}),
  };
}

function renderConfirmationSummary(summary) {
  const lines = ["\nROI 主机集群安装确认", "", `节点拓扑：${summary.hosts} 个节点`];
  for (const node of summary.nodes || []) lines.push(`- ${node.name}: ${node.roles.join(", ")}${node.bootstrap ? " (bootstrap)" : ""}`);
  lines.push("", "阻断项：", ...(summary.blockers?.length ? summary.blockers.map((item) => `- ${item.message || item}`) : ["- 无"]));
  lines.push("风险提示：", ...(summary.warnings?.length ? summary.warnings.map((item) => `- ${item.message || item}`) : ["- 无"]));
  lines.push("将发生的系统变更：安装 RKE2、Containerd、Rainbond 及所选存储组件；写入 /opt/rainbond 和 /var/lib/rancher。", `受保护配置：${summary.configPath}`, "");
  return `${lines.join("\n")}\n`;
}

async function confirmRoiInstall({
  summary,
  interactive = process.stdin.isTTY && process.stdout.isTTY,
  yes = false,
  ask,
  createPrompt = () => readline.createInterface({ input: process.stdin, output: process.stdout }),
  write = (value) => process.stdout.write(value),
  onAccepted,
}) {
  write(renderConfirmationSummary(summary));
  if (summary.blockers?.length) throw new Error("主机集群预检存在阻断项，不能继续执行 ROI");
  if (!yes) {
    if (!interactive) {
      write("[RAINSKILLS_USER_CONFIRMATION_REQUIRED:roi_install]\n确认以上拓扑和系统变更后，请使用原命令并添加 --yes。\n");
      return { accepted: false, waiting: true };
    }
    let prompt = null;
    if (typeof ask !== "function") {
      prompt = createPrompt();
      ask = (question) => prompt.question(question);
    }
    let decision;
    try {
      decision = String(await ask("确认执行 ROI 主机集群安装？请输入 yes 继续: ")).trim().toLowerCase();
    } finally {
      prompt?.close();
    }
    if (!new Set(["yes", "y", "accept", "确认"]).has(decision)) return { accepted: false, cancelled: decision === "cancel" };
  }
  const value = await onAccepted();
  return { accepted: true, value };
}

function roiPolicyForArch(arch, policy = POLICY) {
  const normalized = ["x64", "x86_64"].includes(String(arch).toLowerCase()) ? "amd64"
    : String(arch).toLowerCase() === "aarch64" ? "arm64" : String(arch).toLowerCase();
  const entry = policy.roi?.artifacts?.[normalized];
  if (!entry || !["amd64", "arm64"].includes(normalized)) throw new Error(`ROI 不支持该 CPU 架构：${arch}`);
  const parsed = new URL(entry.url);
  if (parsed.protocol !== "https:" || parsed.origin !== "https://get.rainbond.com" || parsed.pathname !== `/roi/roi-${normalized}`) {
    throw new Error("ROI 策略包含非固定官方来源");
  }
  return { ...entry, arch: normalized };
}

function defaultHttpsRequest(url, maxBytes) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, { timeout: 30_000 }, (response) => {
      const chunks = [];
      let total = 0;
      response.on("data", (chunk) => {
        total += chunk.length;
        if (total > maxBytes) request.destroy(new Error(`ROI 下载超过大小上限 ${maxBytes} bytes`));
        else chunks.push(chunk);
      });
      response.on("end", () => resolve({ statusCode: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
    });
    request.on("timeout", () => request.destroy(new Error("ROI 下载超时")));
    request.on("error", reject);
  });
}

async function responseBytes(response, maxBytes) {
  if (Buffer.isBuffer(response.body)) {
    if (response.body.length > maxBytes) throw new Error(`ROI 下载大小超过 ${maxBytes} bytes`);
    return response.body;
  }
  if (typeof response.body === "string") {
    const bytes = Buffer.from(response.body);
    if (bytes.length > maxBytes) throw new Error(`ROI 下载大小超过 ${maxBytes} bytes`);
    return bytes;
  }
  if (response.body && typeof response.body[Symbol.asyncIterator] === "function") {
    const chunks = [];
    let total = 0;
    for await (const chunk of response.body) {
      const bytes = Buffer.from(chunk);
      total += bytes.length;
      if (total > maxBytes) throw new Error(`ROI 下载大小超过 ${maxBytes} bytes`);
      chunks.push(bytes);
    }
    return Buffer.concat(chunks);
  }
  return Buffer.alloc(0);
}

function validateRoiElf(bytes, arch) {
  if (bytes.length < 20 || !bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) {
    throw new Error("ROI 文件不是有效的 ELF 可执行文件");
  }
  if (bytes[4] !== 2 || bytes[5] !== 1) throw new Error("ROI ELF 格式必须是 64 位 little-endian");
  const machine = bytes.readUInt16LE(18);
  const expected = arch === "amd64" ? 62 : 183;
  if (machine !== expected) throw new Error(`ROI ELF 架构不匹配，期望 ${arch}`);
}

async function defaultChecksumDiscovery(entry, request, maxBytes) {
  for (const checksumUrl of entry.checksum_urls || []) {
    const response = await request(checksumUrl, maxBytes);
    if (response.statusCode === 404) continue;
    if (response.statusCode !== 200) throw new Error(`ROI 官方 checksum 端点返回 HTTP ${response.statusCode}`);
    const bytes = await responseBytes(response, maxBytes);
    const match = bytes.toString("utf8").match(/\b([a-fA-F0-9]{64})\b/);
    if (!match) throw new Error("ROI 官方 checksum 响应格式无效");
    return { published: true, sha256: match[1].toLowerCase(), sourceUrl: checksumUrl };
  }
  return { published: false, sourceUrl: null };
}

function defaultVersionProbe(filePath) {
  const result = spawnSync(filePath, ["version"], { encoding: "utf8", timeout: 15_000, env: { PATH: process.env.PATH || "" } });
  if (result.error || result.status !== 0) throw new Error("roi version 执行失败");
  return String(result.stdout || result.stderr || "").trim();
}

function normalizeRoiVersionOutput(output) {
  const lines = String(output || "").replace(/\r/g, "").split("\n").map((line) => line.trim()).filter(Boolean);
  const version = lines.find((line) => /^roi\s+version\b/i.test(line));
  if (!version || version.length > 120 || /[\u0000-\u001f\u007f-\u009f]/u.test(version) || !/^roi\s+version\s+[A-Za-z0-9][A-Za-z0-9._+/-]{0,99}$/i.test(version)) {
    throw new Error("roi version 未返回安全、有效的 ROI 版本");
  }
  return version;
}

async function acquireRoiArtifact({
  arch,
  operationDir,
  policy = POLICY,
  maxBytes,
  maxRedirects,
  request,
  discoverChecksum,
  probeVersion = defaultVersionProbe,
  persistLock,
  stateStore,
  abortState,
}) {
  assertOperationNotAborted(abortState);
  const entry = roiPolicyForArch(arch, policy);
  const maximumBytes = maxBytes || policy.roi.max_bytes;
  const redirectLimit = maxRedirects ?? policy.roi.max_redirects;
  const rawRequest = request || ((url) => defaultHttpsRequest(url, maximumBytes));
  const fetchResponse = async (url, limit = maximumBytes) => {
    assertOperationNotAborted(abortState);
    const result = await rawRequest(url, limit);
    assertOperationNotAborted(abortState);
    return result;
  };
  const directory = path.resolve(operationDir);
  if (stateStore) stateStore.ensurePrivateDirectory(directory);
  else {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") fs.chmodSync(directory, 0o700);
  }
  const destination = path.join(directory, "roi");
  const partial = `${destination}.partial`;
  for (const candidate of [destination, partial]) {
    if (fs.existsSync(candidate) && fs.lstatSync(candidate).isSymbolicLink()) throw new Error(`拒绝使用符号链接 ROI 路径：${candidate}`);
  }
  if (fs.existsSync(destination)) throw new Error("发现未锁定或未完成恢复验证的 ROI artifact，拒绝覆盖");
  let currentUrl = entry.url;
  let response;
  for (let hop = 0; hop <= redirectLimit; hop += 1) {
    response = await fetchResponse(currentUrl, maximumBytes);
    assertOperationNotAborted(abortState);
    if (response.statusCode >= 300 && response.statusCode < 400 && response.headers?.location) {
      if (hop === redirectLimit) throw new Error("ROI 下载跳转次数过多");
      const next = new URL(response.headers.location, currentUrl);
      if (
        next.protocol !== "https:"
        || next.origin !== "https://get.rainbond.com"
        || !next.pathname.startsWith("/roi/")
        || next.username
        || next.password
        || next.search
        || next.hash
      ) {
        throw new Error("ROI 下载只允许 get.rainbond.com/roi/ 下的同源重定向");
      }
      currentUrl = next.toString();
      continue;
    }
    break;
  }
  if (!response || response.statusCode !== 200) throw new Error(`ROI 下载失败，HTTP ${response?.statusCode || "unknown"}`);
  const advertised = Number(response.headers?.["content-length"] || 0);
  if (advertised > maximumBytes) throw new Error(`ROI 下载大小超过 ${maximumBytes} bytes`);
  const bytes = await responseBytes(response, maximumBytes);
  assertOperationNotAborted(abortState);
  if (bytes.length === 0) throw new Error("ROI 下载结果为空");
  validateRoiElf(bytes, entry.arch);
  const digest = sha256(bytes);
  const checksum = discoverChecksum
    ? await discoverChecksum({ entry, request: fetchResponse })
    : await defaultChecksumDiscovery(entry, fetchResponse, Math.min(maximumBytes, 1024 * 1024));
  assertOperationNotAborted(abortState);
  if (checksum.published === true) {
    if (!/^[a-f0-9]{64}$/i.test(checksum.sha256 || "") || checksum.sha256.toLowerCase() !== digest) {
      throw new Error("ROI 官方 checksum 与下载文件摘要不匹配");
    }
  } else if (checksum.published !== false) {
    throw new Error("ROI checksum 探测结果无效");
  }
  atomicWriteProtectedBytes(partial, bytes, { stateStore });
  if (!stateStore && process.platform !== "win32") fs.chmodSync(partial, 0o700);
  let version;
  try {
    assertOperationNotAborted(abortState);
    version = normalizeRoiVersionOutput(await probeVersion(partial));
    assertOperationNotAborted(abortState);
  } catch (error) {
    try { fs.unlinkSync(partial); } catch {}
    throw error;
  }
  const lock = {
    finalUrl: currentUrl,
    version,
    sha256: digest,
    checksum: { published: checksum.published, sourceUrl: checksum.sourceUrl || null },
  };
  if (typeof persistLock !== "function") {
    try { fs.unlinkSync(partial); } catch {}
    throw new Error("ROI artifact 发布前必须持久化完整恢复锁");
  }
  try {
    await persistLock(lock);
  } catch (error) {
    try { fs.unlinkSync(partial); } catch {}
    throw error;
  }
  fs.renameSync(partial, destination);
  if (!stateStore && process.platform !== "win32") fs.chmodSync(destination, 0o700);
  if (stateStore) stateStore.protectRegularFile(destination);
  return { path: destination, ...lock };
}

function validateRoiResumeLock(lock, { configPath, artifactPath }) {
  if (!lock || typeof lock !== "object") throw new Error("缺少 ROI 恢复锁");
  const configDigest = sha256(fs.readFileSync(configPath));
  const artifactDigest = sha256(fs.readFileSync(artifactPath));
  if (configDigest !== lock.configSha256) throw new Error("受保护的 cluster 配置字节已变化，拒绝恢复");
  const expectedArtifact = lock.artifactSha256 || lock.sha256;
  if (artifactDigest !== expectedArtifact) throw new Error("受保护的 ROI artifact 字节已变化，拒绝恢复");
  if (!/^https:\/\/get\.rainbond\.com\/roi\//.test(lock.finalUrl || "")) throw new Error("ROI 恢复锁的 final URL 无效");
  if (!/^roi\s+version\b/i.test(lock.version || "")) throw new Error("ROI 恢复锁的 version 无效");
  return { configSha256: configDigest, artifactSha256: artifactDigest };
}

function readOpenDescriptorBytes(fd, expectedSize) {
  if (!Number.isSafeInteger(expectedSize) || expectedSize < 0) throw new Error("ROI partial 大小无效");
  const bytes = Buffer.alloc(expectedSize);
  let offset = 0;
  while (offset < bytes.length) {
    const count = fs.readSync(fd, bytes, offset, bytes.length - offset, offset);
    if (count === 0) throw new Error("ROI partial 读取期间发生变化");
    offset += count;
  }
  return bytes;
}

function reuseLockedRoiArtifact({
  state,
  configPath,
  artifactPath,
  stateStore,
  platform = process.platform,
  publishLink = fs.linkSync,
}) {
  if (!state?.artifact_sha256) {
    if (fs.existsSync(artifactPath)) throw new Error("发现未锁定的 ROI artifact，拒绝重新下载、覆盖或切换字节");
    return null;
  }
  if (!fs.existsSync(configPath)) throw new Error("已锁定的 cluster 配置缺失，拒绝恢复");
  if (!fs.existsSync(artifactPath)) {
    const partialPath = `${artifactPath}.partial`;
    let partialPathInfo;
    try { partialPathInfo = fs.lstatSync(partialPath); } catch (error) {
      if (error.code === "ENOENT") throw new Error("已锁定的 ROI 恢复文件缺失，拒绝重新下载或更换字节");
      throw error;
    }
    if (partialPathInfo.isSymbolicLink()) throw new Error("拒绝恢复符号链接 ROI partial");
    if (!partialPathInfo.isFile()) throw new Error("ROI partial 必须是普通文件");
    let protectedAcl = null;
    if (platform === "win32") {
      if (!stateStore) throw new Error("Windows ROI partial 恢复需要受保护状态检查器");
      protectedAcl = stateStore.assertProtectedRegularFile(partialPath);
    }
    const flags = fs.constants.O_RDONLY | (platform === "win32" ? 0 : (fs.constants.O_NOFOLLOW || 0));
    let fd;
    try {
      fd = fs.openSync(partialPath, flags);
      const openedInfo = fs.fstatSync(fd);
      if (!openedInfo.isFile()) throw new Error("ROI partial 必须是普通文件");
      if (platform !== "win32") {
        if (typeof process.getuid === "function" && openedInfo.uid !== process.getuid()) throw new Error("ROI partial 不属于当前用户");
        if ((openedInfo.mode & 0o777) !== 0o600) throw new Error("ROI partial 权限必须精确为 0600");
      }
      const partialBytes = readOpenDescriptorBytes(fd, openedInfo.size);
      if (protectedAcl?.fileIdentity && protectedAcl.fileIdentity !== contentIdentity(partialBytes)) {
        throw new Error("Windows ROI partial ACL identity 与读取字节不匹配");
      }
      const configDigest = sha256(fs.readFileSync(configPath));
      if (configDigest !== state.config_sha256) throw new Error("受保护的 cluster 配置字节已变化，拒绝恢复");
      if (sha256(partialBytes) !== state.artifact_sha256) throw new Error("ROI partial 摘要与完整恢复锁不匹配");
      if (!/^https:\/\/get\.rainbond\.com\/roi\//.test(state.artifact_final_url || "") || !/^roi\s+version\b/i.test(state.artifact_version || "")) {
        throw new Error("ROI partial 的完整恢复锁无效");
      }

      publishLink(partialPath, artifactPath);
      const publishedInfo = fs.lstatSync(artifactPath);
      if (publishedInfo.isSymbolicLink() || !publishedInfo.isFile()
        || publishedInfo.dev !== openedInfo.dev || publishedInfo.ino !== openedInfo.ino) {
        throw new Error("ROI partial 发布竞争导致 final identity 不匹配");
      }
      if (sha256(readOpenDescriptorBytes(fd, openedInfo.size)) !== state.artifact_sha256) {
        throw new Error("ROI partial 发布后摘要发生变化");
      }
      const currentPartial = fs.lstatSync(partialPath);
      if (currentPartial.isSymbolicLink() || !currentPartial.isFile()
        || currentPartial.dev !== openedInfo.dev || currentPartial.ino !== openedInfo.ino) {
        throw new Error("ROI partial 路径在发布期间发生竞争变化");
      }
      fs.unlinkSync(partialPath);
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
    if (stateStore) stateStore.protectRegularFile(artifactPath);
    return {
      path: artifactPath,
      sha256: state.artifact_sha256,
      finalUrl: state.artifact_final_url,
      version: state.artifact_version,
      checksum: { published: state.artifact_checksum_published === true, sourceUrl: state.artifact_checksum_url || null },
      reused: true,
      recoveredPartial: true,
    };
  }
  validateRoiResumeLock({
    configSha256: state.config_sha256,
    artifactSha256: state.artifact_sha256,
    finalUrl: state.artifact_final_url,
    version: state.artifact_version,
  }, { configPath, artifactPath });
  return {
    path: artifactPath,
    sha256: state.artifact_sha256,
    finalUrl: state.artifact_final_url,
    version: state.artifact_version,
    checksum: {
      published: state.artifact_checksum_published === true,
      sourceUrl: state.artifact_checksum_url || null,
    },
    reused: true,
  };
}

function createLineRedactor() {
  let sensitiveBlockIndent = null;
  let pemBlock = false;
  let structuredBlockIndent = null;
  return (value) => {
    const line = String(value || "").replace(/\r$/, "");
    const indent = line.match(/^\s*/)?.[0].length || 0;
    if (pemBlock) {
      if (/-----END [A-Z0-9 ]+-----/.test(line)) pemBlock = false;
      return `${line.slice(0, indent)}[REDACTED]`;
    }
    if (structuredBlockIndent !== null) {
      if (!line.trim() || indent > structuredBlockIndent) return `${line.slice(0, indent)}[REDACTED]`;
      structuredBlockIndent = null;
      if (/^[}\]],?$/.test(line.trim())) return `${line.slice(0, indent)}[REDACTED]`;
    }
    if (sensitiveBlockIndent !== null) {
      if (!line.trim() || indent > sensitiveBlockIndent) return `${line.slice(0, indent)}[REDACTED]`;
      sensitiveBlockIndent = null;
    }
    const keyMatches = [...line.matchAll(/(?:password|passwd|token|secret|private.?key|credential|database|registry)/ig)];
    if (keyMatches.length === 0) return line;
    const candidates = keyMatches.map((keyMatch) => {
      const keyEnd = (keyMatch.index || 0) + keyMatch[0].length;
      const relativeSeparator = line.slice(keyEnd).search(/[:=]/);
      const separator = relativeSeparator < 0 ? -1 : keyEnd + relativeSeparator;
      return { separator, remainder: separator < 0 ? "" : line.slice(separator + 1).trim() };
    }).filter(({ separator }) => separator >= 0);
    const blockCandidate = candidates.find(({ remainder }) => (
      /^[\[{]/.test(remainder)
      || /-----BEGIN [A-Z0-9 ]+-----/.test(remainder)
      || !remainder
      || /^[|>][+-]?$/.test(remainder)
    ));
    const selected = blockCandidate || candidates[0];
    const separator = selected?.separator ?? -1;
    if (separator < 0) return "[REDACTED]";
    const remainder = selected.remainder;
    if (/-----BEGIN [A-Z0-9 ]+-----/.test(remainder) && !/-----END [A-Z0-9 ]+-----/.test(remainder)) pemBlock = true;
    else if (/^[\[{]/.test(remainder) || /[\[{]\s*$/.test(line)) structuredBlockIndent = indent;
    else if (!remainder || /^[|>][+-]?$/.test(remainder)) sensitiveBlockIndent = indent;
    return `${line.slice(0, separator + 1)} [REDACTED]`;
  };
}

function redactInstallLog(value) {
  const redactLine = createLineRedactor();
  return String(value || "").split(/\n/).map(redactLine).join("\n");
}

function assertSafeRemotePath(value) {
  const normalized = String(value || "");
  if (!SAFE_REMOTE_PATH.test(normalized) || normalized.includes("..") || normalized.includes("//")) throw new Error("远端操作路径无效");
  return normalized;
}

function spawnRedactedAttached(command, args, {
  spawnFn = spawn,
  registerChild = () => {},
  stdoutWriter = process.stdout,
  stderrWriter = process.stderr,
} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnFn(command, args, { stdio: ["inherit", "pipe", "pipe"] });
    let settled = false;
    const collected = { stdout: "", stderr: "" };
    const buffers = { stdout: "", stderr: "" };
    const redactors = { stdout: createLineRedactor(), stderr: createLineRedactor() };
    const stream = (name, writer) => (chunk) => {
      buffers[name] += String(chunk);
      let newline;
      while ((newline = buffers[name].indexOf("\n")) >= 0) {
        const safe = `${redactors[name](buffers[name].slice(0, newline))}\n`;
        buffers[name] = buffers[name].slice(newline + 1);
        collected[name] += safe;
        writer.write(safe);
      }
    };
    const flush = (name, writer) => {
      if (!buffers[name]) return;
      const safe = redactors[name](buffers[name]);
      buffers[name] = "";
      collected[name] += safe;
      writer.write(safe);
    };
    const unregister = registerChild(child, false);
    const clear = () => typeof unregister === "function" ? unregister() : registerChild(null, false);
    child.stdout.on("data", stream("stdout", stdoutWriter));
    child.stderr.on("data", stream("stderr", stderrWriter));
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clear();
      reject(error);
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      flush("stdout", stdoutWriter);
      flush("stderr", stderrWriter);
      clear();
      resolve({ code, signal, stdout: collected.stdout, stderr: collected.stderr });
    });
  });
}

async function defaultTransfer({
  host, port, localPath, remotePath, sha256: expectedDigest, mode = 0o600, session,
  runner = spawnSync,
}) {
  const runOptions = { encoding: "utf8", timeout: 30_000, stdio: ["inherit", "pipe", "pipe"] };
  const sshOptions = sshOptionsForSession(session);
  const remoteDirectory = path.posix.dirname(remotePath);
  const remoteTemporary = path.posix.join(remoteDirectory, `.rainskills-upload-${crypto.randomBytes(16).toString("hex")}`);
  const mkdir = runner("ssh", [...sshOptions, "-p", String(port), host, "install", "-d", "-m", "700", "--", remoteDirectory], runOptions);
  if (mkdir.error || mkdir.status !== 0) throw new Error("无法准备 bootstrap 受保护操作目录");
  const stage = runner("ssh", [...sshOptions, "-p", String(port), host, "bash", "-s", "--", remoteDirectory, remoteTemporary], { ...runOptions, input: REMOTE_STAGE_SCRIPT });
  if (stage.error || stage.status !== 0) throw new Error("无法创建 bootstrap 安全上传暂存文件");
  const upload = runner("scp", [...sshOptions, "-P", String(port), localPath, `${host}:${remoteTemporary}`], { ...runOptions, timeout: 5 * 60_000 });
  if (upload.error || upload.status !== 0) throw new Error("无法把受保护安装文件传输到 bootstrap");
  const remoteMode = mode === 0o700 ? "700" : "600";
  const publish = runner("ssh", [
    ...sshOptions, "-p", String(port), host, "bash", "-s", "--",
    remoteTemporary, remotePath, expectedDigest, remoteMode,
  ], { ...runOptions, input: REMOTE_PUBLISH_SCRIPT });
  if (publish.error || publish.status !== 0) {
    if (publish.status === 73 || /FINAL_NOT_REGULAR/.test(String(publish.stderr || ""))) {
      throw new Error("bootstrap 目标路径不是受信任的普通文件，拒绝覆盖 symlink 或非 regular 文件");
    }
    throw new Error("无法原子发布并验证 bootstrap 安装文件");
  }
  const remoteSha256 = String(publish.stdout || "").match(/^[a-f0-9]{64}/i)?.[0]?.toLowerCase();
  if (remoteSha256 !== expectedDigest) throw new Error("bootstrap 上的安装文件摘要不匹配");
  return { remoteSha256 };
}

async function probeRemoteRoiVersion({
  bootstrap,
  artifactPath,
  remoteDir,
  transfer = defaultTransfer,
  sshRunner = defaultSshRunner,
  session,
  registerChild,
  sshSpawn,
  abortState,
}) {
  assertOperationNotAborted(abortState);
  const item = normalizeHost(bootstrap, 0);
  const protectedRemoteDir = assertSafeRemotePath(remoteDir);
  const remoteArtifact = path.posix.join(protectedRemoteDir, "roi.probe");
  const digest = sha256(fs.readFileSync(artifactPath));
  const target = `root@${item.address}`;
  const transferred = await transfer({
    host: target,
    port: item.port,
    localPath: artifactPath,
    remotePath: remoteArtifact,
    sha256: digest,
    mode: 0o700,
    session,
  });
  assertOperationNotAborted(abortState);
  if (transferred.remoteSha256 !== digest) throw new Error("bootstrap 上的 ROI version 探针摘要不匹配");
  const execution = await sshRunner("ssh", [
    ...sshOptionsForSession(session), "-p", String(item.port), target, remoteArtifact, "version",
  ], { registerChild, spawnFn: sshSpawn });
  assertOperationNotAborted(abortState);
  if (execution.signal) {
    const error = new Error("bootstrap 上 roi version 被中断");
    error.code = "RAINSKILLS_HOST_CLUSTER_INTERRUPTED";
    error.signal = execution.signal;
    throw error;
  }
  if (execution.code !== 0) throw new Error("bootstrap 上 roi version 执行失败");
  return normalizeRoiVersionOutput(execution.stdout || execution.stderr);
}

async function executeRoiInstall({
  bootstrap,
  configPath,
  artifactPath,
  logPath,
  remoteDir,
  transfer = defaultTransfer,
  attachedRunner = spawnRedactedAttached,
  persistState = () => {},
  stateStore,
  session,
  resumeArgv,
  registerChild,
  write = (value) => process.stderr.write(value),
  abortState,
}) {
  assertOperationNotAborted(abortState);
  const item = normalizeHost(bootstrap, 0);
  const protectedRemoteDir = assertSafeRemotePath(remoteDir);
  const remoteConfig = path.posix.join(protectedRemoteDir, "cluster.yaml");
  const remoteArtifact = path.posix.join(protectedRemoteDir, "roi");
  const target = `root@${item.address}`;
  const configDigest = sha256(fs.readFileSync(configPath));
  const artifactDigest = sha256(fs.readFileSync(artifactPath));
  for (const input of [
    { host: target, port: item.port, localPath: configPath, remotePath: remoteConfig, sha256: configDigest, mode: 0o600, session },
    { host: target, port: item.port, localPath: artifactPath, remotePath: remoteArtifact, sha256: artifactDigest, mode: 0o700, session },
  ]) {
    const result = await transfer(input);
    assertOperationNotAborted(abortState);
    if (result.remoteSha256 !== input.sha256) throw new Error("bootstrap 远端摘要与受保护源文件不匹配");
  }
  if (!Array.isArray(resumeArgv) || resumeArgv.length !== 6 || resumeArgv[0] !== "npx"
      || !/^rainskills@[A-Za-z0-9._+-]+$/.test(resumeArgv[1])
      || resumeArgv[2] !== "platform" || resumeArgv[3] !== "install"
      || resumeArgv[4] !== "--onboarding-id" || !/^[0-9a-f-]{36}$/i.test(resumeArgv[5])) {
    throw new Error("ROI 恢复命令无效");
  }
  persistState({ stage: "executing", status: "running", configSha256: configDigest, artifactSha256: artifactDigest, resumeArgv });
  const args = ["-tt", ...sshOptionsForSession(session), "-p", String(item.port), target, remoteArtifact, "up", "-f", remoteConfig];
  const execution = await attachedRunner("ssh", args, { registerChild });
  const redacted = redactInstallLog(`${execution.stdout || ""}\n${execution.stderr || ""}`);
  atomicWriteProtectedBytes(logPath, Buffer.from(redacted, "utf8"), { stateStore });
  if (execution.signal || execution.code === 130) {
    persistState({ stage: "executing", status: "interrupted", configSha256: configDigest, artifactSha256: artifactDigest, resumeArgv });
    write(`\n安装已中断，状态已保留。继续时执行：\n  ${resumeArgv.join(" ")}\n`);
    return { interrupted: true, signal: execution.signal || "SIGINT", resumeArgv };
  }
  if (execution.code !== 0) {
    persistState({ stage: "executing", status: "failed", configSha256: configDigest, artifactSha256: artifactDigest, resumeArgv });
    throw new Error(`ROI 主机集群安装失败，退出码 ${execution.code}`);
  }
  persistState({ stage: "verifying", status: "running", configSha256: configDigest, artifactSha256: artifactDigest, resumeArgv });
  return { interrupted: false, resumeArgv };
}

async function inspectRemoteCluster({
  bootstrap, sshRunner = defaultSshRunner, session, registerChild, sshSpawn, abortState,
}) {
  const item = normalizeHost(bootstrap, 0);
  const prefix = [...sshOptionsForSession(session), "-p", String(item.port), `root@${item.address}`];
  const invocations = [
    ["kubectl", "get", "nodes", "-o", "json", "--request-timeout=30s"],
    ["kubectl", "get", "deployments,statefulsets,daemonsets", "-n", "rbd-system", "-o", "json", "--request-timeout=30s"],
  ];
  const responses = [];
  for (const argv of invocations) {
    assertOperationNotAborted(abortState);
    const execution = await sshRunner("ssh", [...prefix, ...argv], { registerChild, spawnFn: sshSpawn });
    if (execution.signal) {
      const error = new Error("bootstrap Kubernetes 验收读取被中断");
      error.code = "RAINSKILLS_HOST_CLUSTER_INTERRUPTED";
      error.signal = execution.signal;
      throw error;
    }
    assertOperationNotAborted(abortState);
    if (execution.code !== 0) throw new Error("无法从 bootstrap 读取 Kubernetes 验收状态");
    try { responses.push(JSON.parse(String(execution.stdout || ""))); } catch { throw new Error("bootstrap 返回了无效的 Kubernetes JSON"); }
  }
  const [nodeList, workloadList] = responses;
  const nodes = (nodeList.items || []).map((node) => ({
    name: String(node.metadata?.name || ""),
    ready: (node.status?.conditions || []).some((condition) => condition.type === "Ready" && condition.status === "True"),
  }));
  const workloads = {};
  for (const workload of workloadList.items || []) {
    const name = String(workload.metadata?.name || "");
    if (!CRITICAL_WORKLOADS.includes(name)) continue;
    const ready = Number(workload.status?.availableReplicas ?? workload.status?.readyReplicas ?? workload.status?.numberReady ?? 0);
    workloads[name] = ready > 0;
  }
  return { nodes, workloads, consoleUrl: `http://${item.address}:7070` };
}

function probeConsole(url) {
  const parsed = new URL(url);
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
    return Promise.reject(new Error("Console URL 无效"));
  }
  return new Promise((resolve, reject) => {
    const client = parsed.protocol === "https:" ? https : http;
    const request = client.get(parsed, { timeout: 10_000 }, (response) => {
      response.resume();
      if (response.statusCode >= 200 && response.statusCode < 500) resolve(response.statusCode);
      else reject(new Error(`Console 健康检查返回 HTTP ${response.statusCode}`));
    });
    request.on("timeout", () => request.destroy(new Error("Console 健康检查超时")));
    request.on("error", reject);
  });
}

async function verifyHostCluster({ expectedNodes, inspectCluster, probeConsole }) {
  if (typeof inspectCluster !== "function" || typeof probeConsole !== "function") throw new Error("集群验收需要检查器和 Console 探针");
  const result = await inspectCluster();
  const actual = new Map((result.nodes || []).map((node) => [node.name, node]));
  for (const name of expectedNodes) {
    if (!actual.has(name) || actual.get(name).ready !== true) throw new Error(`预期节点 ${name} 尚未 Ready`);
  }
  for (const workload of CRITICAL_WORKLOADS) {
    if (result.workloads?.[workload] !== true) throw new Error(`rbd-system 关键组件 ${workload} 尚未就绪`);
  }
  try { await probeConsole(result.consoleUrl); } catch { throw new Error("Console 从当前控制端不可访问"); }
  return {
    consoleUrl: result.consoleUrl,
    location: `host-cluster (${expectedNodes.length} nodes)`,
    nodeReady: true,
    componentsReady: true,
  };
}

function createStateStore() {
  return process.platform === "win32" ? createWindowsSecureStateStore() : createSecureStateStore();
}

function loadDriverState(filePath, stateStore) {
  if (!fs.existsSync(filePath)) return null;
  const value = stateStore.readProtectedJson(filePath);
  if (value.schema !== "rainskills.host-cluster-state.v1" || value.version !== 1) throw new Error("不支持的主机集群安装状态版本");
  return value;
}

async function promptWizardAnswer(rl, { config }) {
  const action = String(await rl.question("请选择操作 add/list/edit/delete/save/cancel: ")).trim().toLowerCase();
  if (["list", "save", "cancel"].includes(action)) return { action };
  if (action === "delete") return { action, name: String(await rl.question("节点名称: ")).trim() };
  if (!["add", "edit"].includes(action)) return { action };
  const existingName = action === "edit" ? String(await rl.question("要修改的节点名称: ")).trim() : "";
  const name = String(await rl.question("节点名称: ")).trim();
  const address = String(await rl.question("SSH/address 地址: ")).trim();
  const internalAddress = String(await rl.question("internalAddress: ")).trim();
  const port = Number(String(await rl.question("SSH 端口 (22): ")).trim() || "22");
  const roles = String(await rl.question("角色（逗号分隔 etcd,master,worker,rbd-gateway,rbd-chaos,nfs-server）: "))
    .split(",").map((item) => item.trim()).filter((item) => ALL_ROLES.includes(item));
  const bootstrap = /^y(?:es)?$/i.test(String(await rl.question("设为 bootstrap? (yes/no): ")).trim());
  return { action, ...(existingName ? { name: existingName } : {}), host: { name, address, internalAddress, user: "root", port, bootstrap }, roles };
}

async function installHostCluster({ onboarding, state, paths, options }, dependencies = {}) {
  const stateStore = dependencies.stateStore || createStateStore();
  const hostRoot = path.join(paths.root, "host-cluster");
  stateStore.ensurePrivateDirectory(hostRoot);
  const configPath = path.join(hostRoot, "cluster.yaml");
  const driverStatePath = path.join(hostRoot, "state.json");
  const logPath = path.join(hostRoot, "roi.log");
  let driverState = loadDriverState(driverStatePath, stateStore) || {
    schema: "rainskills.host-cluster-state.v1", version: 1, operation_id: state.operation_id,
    stage: "configuration", status: "running", config_path: configPath,
  };
  const persistDriverState = (values) => {
    driverState = { ...driverState, ...values, updated_at: new Date().toISOString() };
    stateStore.atomicWriteJson(driverStatePath, driverState);
  };

  let config;
  if (fs.existsSync(configPath)) {
    stateStore.assertProtectedRegularFile(configPath);
    config = parseClusterDocument(fs.readFileSync(configPath)).value;
  } else if (options.clusterConfig) {
    importClusterConfig({ sourcePath: options.clusterConfig, destinationPath: configPath, stateStore });
    config = parseClusterDocument(fs.readFileSync(configPath)).value;
  } else if (!(dependencies.interactive ?? (process.stdin.isTTY && process.stdout.isTTY))) {
    (dependencies.write || ((value) => process.stdout.write(value)))("\n[RAINSKILLS_USER_INPUT_REQUIRED:host_cluster_config]\n请提供 --cluster-config <cluster.yaml>，或在交互终端运行基础向导。\n");
    persistDriverState({ status: "waiting_user" });
    return { waiting: true };
  } else {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      const wizard = await runClusterWizard({
        prompt: dependencies.prompt || ((context) => promptWizardAnswer(rl, context)),
        persist: (bytes) => atomicWriteProtectedBytes(configPath, bytes, { stateStore }),
        write: dependencies.write || ((value) => process.stdout.write(value)),
      });
      if (wizard.cancelled) {
        persistDriverState({ status: "cancelled" });
        return { waiting: true, cancelled: true };
      }
      config = wizard.config;
    } finally { rl.close(); }
  }

  const topology = validateClusterTopology(config);
  const configSha256 = sha256(fs.readFileSync(configPath));
  const resumeArgv = ["npx", `rainskills@${dependencies.packageVersion || require("../../package.json").version}`, "platform", "install", "--onboarding-id", state.operation_id];
  const interruptedAt = (stage) => {
    if (!dependencies.abortState?.aborted) return null;
    const signal = dependencies.abortState.signal || "SIGINT";
    persistDriverState({ stage, status: "interrupted", signal, resumeArgv });
    return { waiting: true, interrupted: true, signal, resumeArgv };
  };
  if (driverState.config_sha256 && driverState.config_sha256 !== configSha256) throw new Error("恢复时 cluster.yaml 字节发生变化，拒绝继续");
  const prepared = await prepareHostSshSessions(topology, dependencies);
  const closeSessions = () => {
    if (typeof dependencies.closeSession !== "function") return;
    for (const session of prepared.sessions.values()) dependencies.closeSession(session);
  };
  if (prepared.waiting) {
    persistDriverState({ stage: "preflight", status: "waiting_user", config_sha256: configSha256 });
    closeSessions();
    return { waiting: true };
  }
  const bootstrapSession = prepared.sessions.get(topology.bootstrap.name);
  try {
    const beforePreflight = interruptedAt("preflight");
    if (beforePreflight) return beforePreflight;
    persistDriverState({ stage: "preflight", status: "running", config_sha256: configSha256 });
    const preflight = await (dependencies.runPreflight || runHostPreflight)(config, { ...dependencies, sessions: prepared.sessions });
    if (preflight.interrupted) {
      persistDriverState({ stage: "preflight", status: "interrupted", signal: preflight.signal || "SIGINT", resumeArgv });
      return { waiting: true, interrupted: true, signal: preflight.signal || "SIGINT", resumeArgv };
    }
    const summary = { ...summarizeTopology(config), blockers: preflight.blockers, configPath };
    const confirmation = await (dependencies.confirm || confirmRoiInstall)({
      summary,
      interactive: dependencies.interactive,
      yes: options.yes,
      ask: dependencies.ask,
      createPrompt: dependencies.createPrompt,
      write: dependencies.write,
      onAccepted: async () => {
        const bootstrapFacts = preflight.nodes.find(({ name }) => name === topology.bootstrap.name);
        persistDriverState({ stage: "artifact", status: "running" });
        const artifactPath = path.join(hostRoot, "roi");
        let artifact;
        try {
          artifact = reuseLockedRoiArtifact({
            state: driverState,
            configPath,
            artifactPath,
            stateStore,
          }) || await (dependencies.acquireArtifact || acquireRoiArtifact)({
            arch: bootstrapFacts.arch,
            operationDir: hostRoot,
            stateStore,
            abortState: dependencies.abortState,
            probeVersion: dependencies.probeVersion || ((artifactPath) => probeRemoteRoiVersion({
              bootstrap: topology.bootstrap,
              artifactPath,
              remoteDir: `/root/.rainbond/rainskills/${state.operation_id}`,
              session: bootstrapSession,
              registerChild: dependencies.registerChild,
              abortState: dependencies.abortState,
            })),
            persistLock: (lock) => persistDriverState({
              artifact_final_url: lock.finalUrl,
              artifact_version: lock.version,
              artifact_sha256: lock.sha256,
              artifact_checksum_published: lock.checksum.published,
              artifact_checksum_url: lock.checksum.sourceUrl,
            }),
          });
        } catch (error) {
          if (error.code !== "RAINSKILLS_HOST_CLUSTER_INTERRUPTED") throw error;
          persistDriverState({ stage: "artifact", status: "interrupted", signal: error.signal || "SIGINT", resumeArgv });
          return { waiting: true, interrupted: true, signal: error.signal || "SIGINT", resumeArgv };
        }
        const afterArtifact = interruptedAt("artifact");
        if (afterArtifact) return afterArtifact;
        const lock = {
          configSha256,
          artifactSha256: artifact.sha256,
          finalUrl: artifact.finalUrl,
          version: artifact.version,
        };
        validateRoiResumeLock(lock, { configPath, artifactPath: artifact.path });
        let execution;
        try {
          execution = await (dependencies.execute || executeRoiInstall)({
            bootstrap: topology.bootstrap,
            configPath,
            artifactPath: artifact.path,
            logPath,
            remoteDir: `/root/.rainbond/rainskills/${state.operation_id}`,
            persistState: persistDriverState,
            stateStore,
            session: bootstrapSession,
            registerChild: dependencies.registerChild,
            resumeArgv,
            write: dependencies.write,
            abortState: dependencies.abortState,
          });
        } catch (error) {
          if (error.code !== "RAINSKILLS_HOST_CLUSTER_INTERRUPTED") throw error;
          persistDriverState({ stage: "executing", status: "interrupted", signal: error.signal || "SIGINT", resumeArgv });
          return { waiting: true, interrupted: true, signal: error.signal || "SIGINT", resumeArgv };
        }
        if (execution.interrupted) return { waiting: true, interrupted: true };
        const afterExecution = interruptedAt("executing");
        if (afterExecution) return afterExecution;
        const verification = await (dependencies.verify || verifyHostCluster)({
          expectedNodes: topology.hosts.map(({ name }) => name),
          inspectCluster: dependencies.inspectCluster || (() => inspectRemoteCluster({
            bootstrap: topology.bootstrap,
            session: bootstrapSession,
            registerChild: dependencies.registerChild,
            abortState: dependencies.abortState,
          })),
          probeConsole: dependencies.probeConsole || probeConsole,
        });
        const afterVerification = interruptedAt("verifying");
        if (afterVerification) return afterVerification;
        persistDriverState({ stage: "completed", status: "completed", console_url: verification.consoleUrl });
        return { verification };
      },
    });
    if (!confirmation.accepted) {
      persistDriverState({ stage: "confirmation", status: confirmation.waiting ? "waiting_user" : "cancelled" });
      return { waiting: true, cancelled: confirmation.cancelled === true };
    }
    return confirmation.value;
  } finally {
    closeSessions();
  }
}

module.exports = {
  ALL_ROLES,
  CRITICAL_WORKLOADS,
  HOST_PREFLIGHT_SCRIPT,
  acquireRoiArtifact,
  atomicWriteProtectedBytes,
  confirmRoiInstall,
  defaultSshRunner,
  defaultTransfer,
  evaluateHostFacts,
  executeRoiInstall,
  hasSensitiveFields,
  importClusterConfig,
  inspectRemoteCluster,
  installHostCluster,
  parseClusterDocument,
  probeRemoteRoiVersion,
  prepareHostSshSessions,
  probeConsole,
  readSafeClusterSource,
  redactInstallLog,
  renderConfirmationSummary,
  runClusterWizard,
  runHostPreflight,
  spawnRedactedAttached,
  reuseLockedRoiArtifact,
  serializeMinimalClusterConfig,
  summarizeTopology,
  validateClusterTopology,
  validateRoiResumeLock,
  verifyHostCluster,
};
