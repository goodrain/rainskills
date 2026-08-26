"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline/promises");
const { spawn, spawnSync } = require("node:child_process");
const { TextDecoder } = require("node:util");
const YAML = require("yaml");

const POLICY = require("../references/installation-policy.json");
const { createSecureStateStore } = require("./secure-state.js");
const { writeUserMessage } = require("./user-message.js");
const { createWindowsSecureStateStore } = require("./windows-platform.js");

const REQUIRED_ROLES = ["etcd", "master", "worker", "rbd-gateway", "rbd-chaos"];
const ALL_ROLES = [...REQUIRED_ROLES, "nfs-server"];
const SENSITIVE_KEY = /(?:password|passwd|token|secret|private.?key|credential)/i;
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;
const SAFE_REMOTE_PATH = /^\/[A-Za-z0-9._/-]+$/;
const CRITICAL_WORKLOADS = ["rbd-api", "rbd-gateway", "rbd-app-ui"];
const MAX_CHILD_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_SERVER_INPUT_BYTES = 1024 * 1024;
const MAX_SERVER_INPUT_HOSTS = 100;
const MAX_SERVER_INPUT_ISSUES = 200;
const SERVER_INPUT_FIELDS = ["public_ip", "private_ip", "ssh_port", "password"];
const SERVER_INPUT_FIELD_LABELS = Object.freeze({
  public_ip: "公网 IP",
  private_ip: "内网 IP",
  ssh_port: "SSH 端口",
  password: "登录密码",
});
const SERVER_INPUT_CHINESE_FIELDS = new Map([
  ["公网IP", "public_ip"],
  ["内网IP", "private_ip"],
  ["SSH端口", "ssh_port"],
  ["登录密码", "password"],
]);
const SERVER_INPUT_VALIDATION_ERROR = "servers.txt 解析结果无效";
const CHILD_OUTPUT_LIMIT_ERROR = "子进程输出超过安全上限";
const TEMPLATE_ADDRESSES = new Map([
  ["192.0.2.101", "node1"],
  ["192.0.2.102", "node2"],
  ["192.0.2.103", "node3"],
]);

function quotePosixArgument(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function hostClusterConfigOpenCommand(configPath, platform = process.platform) {
  const filePath = String(configPath);
  if (!filePath || /[\0\r\n]/.test(filePath)) throw new Error("cluster.yaml 路径无效");
  if (platform === "darwin") return `open ${quotePosixArgument(filePath)}`;
  if (platform === "linux") return `xdg-open ${quotePosixArgument(filePath)}`;
  if (platform === "win32") return `explorer.exe "${filePath.replace(/"/g, '""')}"`;
  throw new Error("不支持的控制端平台");
}

function renderHostClusterConfigPrompt({ configPath, platform = process.platform, issues = [] }) {
  const normalizedPath = String(configPath).replace(/\\/g, "/");
  const linkTarget = encodeURI(normalizedPath).replace(/#/g, "%23");
  const openCommand = hostClusterConfigOpenCommand(configPath, platform);
  const heading = issues.length > 0
    ? ["集群配置还需要调整：", ...issues.map((issue, index) => `${index + 1}. ${issue}`)]
    : ["集群配置文件已生成。"];
  return [
    ...heading,
    "",
    `[点击打开 cluster.yaml](<${linkTarget}>)`,
    "",
    "如果链接无法打开，请在系统终端执行：",
    "",
    "```sh",
    openCommand,
    "```",
    "",
    issues.length > 0
      ? "请修改同一个配置文件，完成后回复“已完成”。"
      : "请一次性修改服务器地址、SSH 端口和节点角色，并填写每台服务器的 password。",
    ...(issues.length > 0 ? [] : ["password 只在这个受保护的本地文件中填写；不要填写私钥或 Token。", "", "编辑完成后回复“已完成”，我会检查全部节点和集群拓扑。"]),
  ].join("\n");
}

function createHostServerInputTemplate() {
  const heading = [
    "# 没有公网 IP 时，公网 IP 和内网 IP 填写相同地址",
    "# 增加服务器时，复制完整的一组并连续编号",
  ];
  const sections = Array.from({ length: 3 }, (_, index) => [
    `【第 ${index + 1} 台服务器】`,
    "公网 IP：",
    "内网 IP：",
    "SSH 端口：22",
    "登录密码：",
  ].join("\n"));
  return Buffer.from(`${heading.join("\n")}\n\n${sections.join("\n\n")}\n`, "utf8");
}

function hostServerInputOpenCommand(inputPath, platform = process.platform) {
  const filePath = String(inputPath);
  if (!filePath || /[\0\r\n]/.test(filePath)) throw new Error("servers.txt 路径无效");
  if (platform === "darwin") return `open ${quotePosixArgument(filePath)}`;
  if (platform === "linux") return `xdg-open ${quotePosixArgument(filePath)}`;
  if (platform === "win32") return `explorer.exe "${filePath.replace(/"/g, '""')}"`;
  throw new Error("不支持的控制端平台");
}

function renderHostServerInputPrompt({ inputPath, platform = process.platform, issues = [] }) {
  const normalizedPath = String(inputPath).replace(/\\/g, "/");
  const linkTarget = encodeURI(normalizedPath).replace(/#/g, "%23");
  const heading = issues.length > 0
    ? ["服务器信息还需要调整：", ...issues.map((issue, index) => `${index + 1}. ${issue}`)]
    : ["服务器信息文件已生成。"];
  return [
    ...heading,
    "",
    `[点击打开 servers.txt](<${linkTarget}>)`,
    "",
    "如果链接无法打开，请在系统终端执行：",
    "",
    "```sh",
    hostServerInputOpenCommand(inputPath, platform),
    "```",
    "",
    "请在文件中填写每台服务器的公网 IP、内网 IP、SSH 端口和登录密码。",
    "密码只写入受保护的本地和远端安装文件，不会写入聊天、日志或状态；不要填写私钥或 Token。",
    "",
    "编辑完成后回复“已完成”，我会检查全部服务器信息。",
  ].join("\n");
}

function clusterConfigCommandArgument(configPath, platform = process.platform) {
  const value = String(configPath || "");
  if (!value || /[\0\r\n]/.test(value)) throw new Error("cluster.yaml 路径无效");
  if (platform === "win32") return `"${value.replace(/"/g, '""')}"`;
  return quotePosixArgument(value);
}

function renderHostClusterSshAuthenticationPrompt({
  nodes,
  configPath,
  packageVersion,
  platform = process.platform,
}) {
  if (!Array.isArray(nodes) || nodes.length === 0) throw new Error("待准备 SSH 的集群节点不能为空");
  const lines = [`以下 ${nodes.length} 台服务器需要准备 SSH 连接：`, ""];
  for (let index = 0; index < nodes.length; index += 1) {
    const item = nodes[index];
    lines.push(`${index + 1}. ${item.name}：${item.user || "root"}@${item.address}:${item.port}`);
  }
  lines.push(
    "",
    "请打开你电脑上的系统终端，执行下面这一条命令：",
    "",
    `npx --yes rainskills@${packageVersion} ssh prepare-cluster --cluster-config ${clusterConfigCommandArgument(configPath, platform)}`,
    "",
    "命令会依次处理以上服务器；每台服务器的指纹确认和 SSH 密码只会由系统 ssh 读取，不会发送到聊天中。",
    "全部完成后回到这里回复“已完成”，我会在当前任务中继续安装。",
  );
  return lines.join("\n");
}
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
const REMOTE_ROI_LAUNCH_SCRIPT = String.raw`set -eu
directory="$1"
receipt="$2"
operation_id="$3"
config_sha256="$4"
artifact_sha256="$5"
artifact="$6"
config="$7"
[ ! -L "$directory" ] && [ -d "$directory" ] && [ "$(stat -c %u -- "$directory")" = 0 ] && [ "$(stat -c %a -- "$directory")" = 700 ] \
  && [ ! -L "$config" ] && [ -f "$config" ] && [ "$(stat -c %u -- "$config")" = 0 ] && [ "$(stat -c %a -- "$config")" = 600 ] \
  && [ ! -L "$artifact" ] && [ -f "$artifact" ] && [ "$(stat -c %u -- "$artifact")" = 0 ] && [ "$(stat -c %a -- "$artifact")" = 700 ] || exit 81
[ "$(sha256sum -- "$config" | awk '{print $1}')" = "$config_sha256" ] || exit 84
[ "$(sha256sum -- "$artifact" | awk '{print $1}')" = "$artifact_sha256" ] || exit 84
receipt_text() {
  printf 'phase=%s\noperation_id=%s\nconfig_sha256=%s\nartifact_sha256=%s' "$1" "$operation_id" "$config_sha256" "$artifact_sha256"
}
verify_receipt() {
  phase="$1"
  [ ! -L "$receipt" ] && [ -f "$receipt" ] && [ "$(stat -c %u -- "$receipt")" = 0 ] && [ "$(stat -c %a -- "$receipt")" = 600 ] || return 1
  [ "$(cat -- "$receipt")" = "$(receipt_text "$phase")" ] || return 1
}
[ ! -e "$receipt" ] && [ ! -L "$receipt" ] || exit 82
launching="$receipt.launching.partial"
[ ! -e "$launching" ] && [ ! -L "$launching" ] || exit 83
umask 077
( set -C; receipt_text launching > "$launching" ) 2>/dev/null || exit 83
chmod 600 -- "$launching"
mv -T -n -- "$launching" "$receipt" || true
rm -f -- "$launching"
verify_receipt launching || exit 82
set +e
printf '%s\n' y | "$artifact" up -f "$config"
roi_status="$?"
set -e
[ "$roi_status" = 0 ] || exit "$roi_status"
verify_receipt launching || exit 82
completed="$receipt.completed.partial"
[ ! -e "$completed" ] && [ ! -L "$completed" ] || exit 83
( set -C; receipt_text completed > "$completed" ) 2>/dev/null || exit 83
chmod 600 -- "$completed"
mv -T -- "$completed" "$receipt"
verify_receipt completed || exit 82
printf 'RECEIPT_PHASE=completed\n'
`;
const REMOTE_RECONCILE_SCRIPT = String.raw`set -eu
directory="$1"
config="$2"
artifact="$3"
receipt="$4"
operation_id="$5"
expected_config="$6"
expected_artifact="$7"
ownership_verified=false
bytes_verified=false
receipt_present=false
receipt_phase=absent
started=false
if [ ! -L "$directory" ] && [ -d "$directory" ] && [ "$(stat -c %u -- "$directory")" = 0 ] && [ "$(stat -c %a -- "$directory")" = 700 ] \
  && [ ! -L "$config" ] && [ -f "$config" ] && [ "$(stat -c %u -- "$config")" = 0 ] && [ "$(stat -c %a -- "$config")" = 600 ] \
  && [ ! -L "$artifact" ] && [ -f "$artifact" ] && [ "$(stat -c %u -- "$artifact")" = 0 ] && [ "$(stat -c %a -- "$artifact")" = 700 ]; then
  ownership_verified=true
  config_digest="$(sha256sum -- "$config" | awk '{print $1}')"
  artifact_digest="$(sha256sum -- "$artifact" | awk '{print $1}')"
  if [ "$config_digest" = "$expected_config" ] && [ "$artifact_digest" = "$expected_artifact" ]; then
    bytes_verified=true
  fi
fi
if [ -e "$receipt" ] || [ -L "$receipt" ]; then
  receipt_present=true
  launching="$(printf 'phase=launching\noperation_id=%s\nconfig_sha256=%s\nartifact_sha256=%s' "$operation_id" "$expected_config" "$expected_artifact")"
  completed="$(printf 'phase=completed\noperation_id=%s\nconfig_sha256=%s\nartifact_sha256=%s' "$operation_id" "$expected_config" "$expected_artifact")"
  if [ ! -L "$receipt" ] && [ -f "$receipt" ] && [ "$(stat -c %u -- "$receipt")" = 0 ] && [ "$(stat -c %a -- "$receipt")" = 600 ] \
    && [ "$(cat -- "$receipt")" = "$launching" ]; then
    receipt_phase=launching
  elif [ ! -L "$receipt" ] && [ -f "$receipt" ] && [ "$(stat -c %u -- "$receipt")" = 0 ] && [ "$(stat -c %a -- "$receipt")" = 600 ] \
    && [ "$(cat -- "$receipt")" = "$completed" ]; then
    receipt_phase=completed
  else
    receipt_phase=invalid
  fi
fi
if [ -e /etc/rancher/rke2/config.yaml ] || systemctl is-active --quiet rke2-server 2>/dev/null \
  || { [ -d /opt/rainbond ] && find /opt/rainbond -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null | grep -q .; }; then
  started=true
fi
printf 'OWNERSHIP_VERIFIED=%s\nBYTES_VERIFIED=%s\nRECEIPT_PRESENT=%s\nRECEIPT_PHASE=%s\nSTARTED=%s\n' \
  "$ownership_verified" "$bytes_verified" "$receipt_present" "$receipt_phase" "$started"
`;

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function agentHandoffBinding({ state, options, driverState }) {
  const sourcePath = options.clusterConfig || driverState.import_source_path || "";
  const argv = [
    "platform", "install", "--onboarding-id", state.operation_id,
    "--location", "server", "--mode", "host-cluster",
    ...(sourcePath ? ["--cluster-config", path.resolve(sourcePath)] : []),
  ];
  return {
    version: 1,
    argv,
    invocation_sha256: sha256(Buffer.from(JSON.stringify(argv))),
  };
}

function assertMatchingAgentHandoff(binding, expected) {
  if (!binding || binding.version !== 1 || !Array.isArray(binding.argv)
    || binding.invocation_sha256 !== expected.invocation_sha256
    || JSON.stringify(binding.argv) !== JSON.stringify(expected.argv)) {
    throw new Error("AI 确认交接状态不存在或与原安装调用不匹配，已拒绝继续");
  }
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

function normalizeServerInputAddress(value) {
  if (typeof value !== "string" || value.includes("%")) return null;
  const ipVersion = net.isIP(value);
  if (ipVersion === 4) return value;
  if (ipVersion === 6) {
    try {
      return new URL(`http://[${value}]/`).hostname.slice(1, -1);
    } catch {
      return null;
    }
  }
  if (value.length > 253) return null;
  const labels = value.split(".");
  if (labels.some((label) => (
    label.length < 1
    || label.length > 63
    || !/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label)
  ))) return null;
  return value.toLowerCase();
}

function parseServerInputSection(line) {
  const value = line.trim();
  const legacy = /^\[server-(\d+)\]$/.exec(value);
  if (legacy) return { number: Number(legacy[1]), numberText: legacy[1] };
  const chinese = /^【第\s*(\d+)\s*台服务器】$/.exec(value);
  if (chinese) return { number: Number(chinese[1]), numberText: chinese[1] };
  return null;
}

function parseServerInputField(line) {
  const legacy = /^\s*(public_ip|private_ip|ssh_port|password)\s*=(.*)$/.exec(line);
  if (legacy) return { field: legacy[1], rawValue: legacy[2] };

  const chinese = /^\s*(公网\s*IP|内网\s*IP|SSH\s*端口|登录密码)\s*[：:](.*)$/.exec(line);
  if (!chinese) return null;
  return {
    field: SERVER_INPUT_CHINESE_FIELDS.get(chinese[1].replace(/\s/g, "")),
    rawValue: chinese[2],
  };
}

function parseHostServerInput(input) {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(String(input || ""), "utf8");
  const issues = [];
  const issueSet = new Set();
  let diagnosticsTruncated = false;
  const add = (message) => {
    if (!message || issueSet.has(message)) return;
    if (issues.length >= MAX_SERVER_INPUT_ISSUES) {
      diagnosticsTruncated = true;
      return;
    }
    issueSet.add(message);
    issues.push(message);
  };
  const result = (hosts) => {
    if (diagnosticsTruncated) issues.push("servers.txt 问题过多，诊断已截断");
    return { hosts, issues };
  };
  if (bytes.length > MAX_SERVER_INPUT_BYTES) {
    return { hosts: [], issues: ["servers.txt 大小不能超过 1 MiB"] };
  }

  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { hosts: [], issues: ["servers.txt 必须使用有效的 UTF-8 编码"] };
  }
  if (/[\u0000-\u0009\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(text)
    || /(?:^|[^\r])\r(?!\n)/.test(text)) {
    add("servers.txt 不能包含 NUL 或其他控制字符");
    text = text
      .replace(/[\u0000-\u0009\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "")
      .replace(/\r(?!\n)/g, "");
  }

  const sections = [];
  let current = null;
  let ignoreRemainingInput = false;
  const lines = text.split("\n");
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    if (ignoreRemainingInput) continue;
    const lineNumber = lineIndex + 1;
    const line = lines[lineIndex].endsWith("\r") ? lines[lineIndex].slice(0, -1) : lines[lineIndex];
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;

    const sectionMatch = parseServerInputSection(line);
    if (sectionMatch) {
      if (sections.length >= MAX_SERVER_INPUT_HOSTS) {
        add("servers.txt 最多允许 100 个节点区块");
        current = null;
        ignoreRemainingInput = true;
        continue;
      }
      current = {
        number: sectionMatch.number,
        numberText: sectionMatch.numberText,
        line: lineNumber,
        fields: new Map(),
      };
      sections.push(current);
      continue;
    }
    const trimmedLine = line.trim();
    if ((trimmedLine.startsWith("[") && trimmedLine.endsWith("]"))
      || (trimmedLine.startsWith("【") && trimmedLine.endsWith("】"))) {
      add(`第 ${lineNumber} 行是未知区块`);
      current = null;
      continue;
    }

    const parsedField = parseServerInputField(line);
    if (!parsedField) {
      add(`第 ${lineNumber} 行字段格式无效`);
      continue;
    }
    if (!current) {
      add(`第 ${lineNumber} 行字段不属于任何服务器区块`);
      continue;
    }
    const { field, rawValue } = parsedField;
    if (current.fields.has(field)) {
      add(`第 ${lineNumber} 行的${SERVER_INPUT_FIELD_LABELS[field]}字段重复`);
      continue;
    }
    current.fields.set(field, field === "password" ? rawValue : rawValue.trim());
  }

  if (sections.length < 3) add("servers.txt 至少需要 3 个服务器区块");
  const sectionNumbers = new Set();
  for (let index = 0; index < sections.length; index += 1) {
    const section = sections[index];
    const label = `第 ${section.number} 台服务器`;
    if (sectionNumbers.has(section.number)) add(`第 ${section.line} 行的${label}区块重复`);
    sectionNumbers.add(section.number);
    if (section.numberText !== String(index + 1)) add(`第 ${section.line} 行的区块编号必须从第 1 台服务器开始连续`);
    for (const field of SERVER_INPUT_FIELDS) {
      if (!section.fields.has(field)) {
        add(`${label}的${SERVER_INPUT_FIELD_LABELS[field]}字段缺失`);
      } else if (field === "password" && section.fields.get(field).trim() === "") {
        add(`${label}的登录密码未填写或只有空白`);
      } else if (field !== "password" && section.fields.get(field) === "") {
        add(`${label}的${SERVER_INPUT_FIELD_LABELS[field]}未填写`);
      }
    }
  }

  const hosts = sections.map((section) => ({
    publicIp: section.fields.get("public_ip") || "",
    privateIp: section.fields.get("private_ip") || "",
    sshPort: Number(section.fields.get("ssh_port")),
    password: section.fields.get("password") || "",
  }));
  const sshEndpoints = new Set();
  const privateAddresses = new Set();
  for (let index = 0; index < sections.length; index += 1) {
    const section = sections[index];
    const host = hosts[index];
    const label = `第 ${section.number} 台服务器`;
    const publicIp = section.fields.get("public_ip");
    const privateIp = section.fields.get("private_ip");
    const portText = section.fields.get("ssh_port");
    const publicNormalized = typeof publicIp === "string" && publicIp !== ""
      ? normalizeServerInputAddress(publicIp)
      : null;
    const privateNormalized = typeof privateIp === "string" && privateIp !== ""
      ? normalizeServerInputAddress(privateIp)
      : null;
    const publicValid = publicNormalized !== null;
    const privateValid = privateNormalized !== null;
    const portValid = typeof portText === "string" && /^\d+$/.test(portText)
      && Number.isInteger(host.sshPort) && host.sshPort >= 1 && host.sshPort <= 65535;
    if (typeof publicIp === "string" && publicIp !== "" && !publicValid) add(`${label}的公网 IP 地址无效`);
    if (typeof privateIp === "string" && privateIp !== "" && !privateValid) add(`${label}的内网 IP 地址无效`);
    if (typeof portText === "string" && portText !== "" && !portValid) add(`${label}的 SSH 端口必须是 1 到 65535 的整数`);
    if (publicValid && portValid) {
      const endpoint = `${publicNormalized}\0${host.sshPort}`;
      if (sshEndpoints.has(endpoint)) add(`${label}的 SSH 地址和端口与前面的区块重复`);
      sshEndpoints.add(endpoint);
    }
    if (privateValid) {
      if (privateAddresses.has(privateNormalized)) add(`${label}的内网 IP 与前面的区块重复`);
      privateAddresses.add(privateNormalized);
    }
  }
  return result(hosts);
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

function createHostClusterTemplate() {
  const document = new YAML.Document({
    hosts: [
      { name: "node1", address: "192.0.2.101", internalAddress: "192.0.2.101", user: "root", password: "", port: 22, bootstrap: true },
      { name: "node2", address: "192.0.2.102", internalAddress: "192.0.2.102", user: "root", password: "", port: 22 },
      { name: "node3", address: "192.0.2.103", internalAddress: "192.0.2.103", user: "root", password: "", port: 22 },
    ],
    roleGroups: {
      etcd: ["node1", "node2", "node3"],
      master: ["node1", "node2", "node3"],
      worker: ["node1", "node2", "node3"],
      "rbd-gateway": ["node1", "node2"],
      "rbd-chaos": ["node1", "node2", "node3"],
      "nfs-server": ["node1"],
    },
    storage: {
      nfs: { enabled: true, sharePath: "/nfs-data/k8s", storageClass: { enabled: true } },
      existingStorageClass: { enabled: false },
    },
    registry: { external: { enabled: false } },
    database: { mysql: { enabled: false }, custom: { enabled: false } },
  });
  document.options.lineWidth = 0;

  document.getIn(["hosts"], true).commentBefore = " 以下 IP 均为示例地址，必须替换成真实服务器地址\n 一次性填写全部服务器；下面相同字段的填写方式一致，不再重复备注";
  document.getIn(["hosts", 0, "name"], true).comment = " 节点名称，集群内必须唯一";
  document.getIn(["hosts", 0, "address"], true).comment = " SSH 地址，请改成服务器 IP 或域名";
  document.getIn(["hosts", 0, "internalAddress"], true).comment = " 节点内网通信地址；没有独立内网时与 address 相同";
  document.getIn(["hosts", 0, "user"], true).comment = " SSH 用户，当前使用 root";
  document.getIn(["hosts", 0, "password"], true).comment = " 必填：对应服务器的 root 密码，只在本地文件中填写";
  document.getIn(["hosts", 0, "port"], true).comment = " SSH 端口";
  document.getIn(["hosts", 0, "bootstrap"], true).comment = " 引导节点，只能配置一个且必须属于 master";

  document.getIn(["roleGroups", "etcd"], true).commentBefore = " etcd 节点数必须是正奇数";
  document.getIn(["roleGroups", "master"], true).commentBefore = " 集群控制面节点";
  document.getIn(["roleGroups", "worker"], true).commentBefore = " 运行应用工作负载的节点";
  document.getIn(["roleGroups", "rbd-gateway"], true).commentBefore = " 提供应用访问入口的节点";
  document.getIn(["roleGroups", "rbd-chaos"], true).commentBefore = " 执行应用构建任务的节点";
  document.getIn(["roleGroups", "nfs-server"], true).commentBefore = " 内置 NFS 只能指定一个节点";

  document.getIn(["storage", "nfs", "enabled"], true).comment = " 使用内置 NFS 时保持 true";
  document.getIn(["storage", "nfs", "sharePath"], true).comment = " NFS 数据目录";
  document.getIn(["storage", "existingStorageClass", "enabled"], true).comment = " 使用已有 StorageClass 时改为 true，并关闭内置 NFS";
  document.getIn(["registry", "external", "enabled"], true).comment = " 没有外部镜像仓库时保持 false";
  document.getIn(["database", "mysql", "enabled"], true).comment = " 没有外部数据库时保持 false";
  document.getIn(["database", "custom", "enabled"], true).comment = " 使用自定义数据库时再开启";

  return Buffer.from(String(document), "utf8");
}

function createClusterConfigFromServerInput(hosts) {
  if (!Array.isArray(hosts) || hosts.length < 3 || hosts.length > MAX_SERVER_INPUT_HOSTS) {
    throw new Error(SERVER_INPUT_VALIDATION_ERROR);
  }
  const nodeNames = Array.from({ length: hosts.length }, (_, index) => `node${index + 1}`);
  const generatedHosts = [];
  for (let index = 0; index < hosts.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(hosts, index)) {
      throw new Error(SERVER_INPUT_VALIDATION_ERROR);
    }
    const item = hosts[index];
    if (!item || typeof item !== "object" || Array.isArray(item)
      || typeof item.publicIp !== "string" || normalizeServerInputAddress(item.publicIp) === null
      || typeof item.privateIp !== "string" || normalizeServerInputAddress(item.privateIp) === null
      || !Number.isInteger(item.sshPort) || item.sshPort < 1 || item.sshPort > 65535
      || typeof item.password !== "string" || item.password.trim() === "") {
      throw new Error(SERVER_INPUT_VALIDATION_ERROR);
    }
    generatedHosts.push({
      name: nodeNames[index],
      address: item.publicIp,
      internalAddress: item.privateIp,
      user: "root",
      password: item.password,
      port: item.sshPort,
      ...(index === 0 ? { bootstrap: true } : {}),
    });
  }
  const config = {
    hosts: generatedHosts,
    roleGroups: {
      etcd: nodeNames.slice(0, 3),
      master: nodeNames.slice(0, 3),
      worker: nodeNames,
      "rbd-gateway": nodeNames.slice(0, 2),
      "rbd-chaos": nodeNames,
      "nfs-server": ["node1"],
    },
    storage: {
      nfs: { enabled: true, sharePath: "/nfs-data/k8s", storageClass: { enabled: true } },
      existingStorageClass: { enabled: false },
    },
    registry: { external: { enabled: false } },
    database: { mysql: { enabled: false }, custom: { enabled: false } },
  };
  try {
    validateClusterTopology(config);
  } catch {
    throw new Error(SERVER_INPUT_VALIDATION_ERROR);
  }
  const document = new YAML.Document(config);
  document.options.lineWidth = 0;
  return Buffer.from(String(document), "utf8");
}

function diagnoseClusterConfig(input, { source = "generated-template" } = {}) {
  let value;
  try {
    value = parseClusterDocument(input).value;
  } catch {
    return { value: null, issues: ["cluster.yaml 解析失败，请检查 YAML 语法"] };
  }
  if (source === "generated-template" && hasDisallowedGeneratedSensitiveFields(value)) {
    return { value: null, issues: ["集群配置文件不能包含私钥、Token 或其他未允许的敏感字段"] };
  }

  const issues = [];
  const add = (message) => { if (message && !issues.includes(message)) issues.push(message); };
  const hosts = Array.isArray(value.hosts) ? value.hosts : [];
  if (!Array.isArray(value.hosts) || hosts.length === 0) add("hosts 至少需要配置一个节点");
  const names = new Set();
  const sshEndpoints = new Set();
  const internalAddresses = new Set();
  const normalized = [];
  for (let index = 0; index < hosts.length; index += 1) {
    const raw = hosts[index];
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      add(`hosts[${index}] 必须是对象`);
      continue;
    }
    const name = String(raw.name || "");
    const address = String(raw.address || "");
    const internalAddress = String(raw.internalAddress || raw.address || "");
    const port = raw.port === undefined ? 22 : Number(raw.port);
    const normalizedAddress = normalizeServerInputAddress(address);
    const normalizedInternalAddress = normalizeServerInputAddress(internalAddress);
    if (!SAFE_NAME.test(name)) add(`hosts[${index}].name 无效`);
    if (names.has(name) && name) add(`节点名称重复：${name}`);
    if (name) names.add(name);
    if (normalizedAddress === null) add(`节点 ${name || index} 的 address 无效`);
    if (normalizedInternalAddress === null) add(`节点 ${name || index} 的 internalAddress 无效`);
    if (normalizedAddress !== null && Number.isInteger(port) && port >= 1 && port <= 65535) {
      const endpoint = `${normalizedAddress}\0${port}`;
      if (sshEndpoints.has(endpoint)) add(`节点地址（SSH endpoint）重复：${address}:${port}`);
      sshEndpoints.add(endpoint);
    }
    if (normalizedInternalAddress !== null) {
      if (internalAddresses.has(normalizedInternalAddress)) add(`节点 internalAddress 重复：${internalAddress}`);
      internalAddresses.add(normalizedInternalAddress);
    }
    if (String(raw.user || "root") !== "root") add(`节点 ${name || index} 只支持 root SSH 用户`);
    if (typeof raw.password !== "string" || raw.password.trim() === "") add(`节点 ${name || index} 的 password 未填写`);
    if (!Number.isInteger(port) || port < 1 || port > 65535) add(`节点 ${name || index} 的 SSH 端口无效`);
    if (raw.bootstrap !== undefined && typeof raw.bootstrap !== "boolean") add(`节点 ${name || index} 的 bootstrap 必须是布尔值`);
    if (TEMPLATE_ADDRESSES.get(address) === name || TEMPLATE_ADDRESSES.get(internalAddress) === name) {
      add(`请把 hosts.${name}.address 和 internalAddress 改为真实服务器地址`);
    }
    normalized.push({ name, bootstrap: raw.bootstrap === true });
  }

  const roleGroups = value.roleGroups;
  if (!roleGroups || typeof roleGroups !== "object" || Array.isArray(roleGroups)) {
    add("cluster.yaml 缺少 roleGroups");
  } else {
    for (const role of ALL_ROLES) {
      const members = roleGroups[role] === undefined && role === "nfs-server" ? [] : roleGroups[role];
      if (!Array.isArray(members)) {
        add(`roleGroups.${role} 必须是数组`);
        continue;
      }
      if (role === "etcd" && (members.length === 0 || members.length % 2 === 0)) add("etcd 节点数必须是正奇数（1、3、5……）");
      if (role !== "nfs-server" && members.length === 0) add(`roleGroups.${role} 至少需要一个节点`);
      if (new Set(members).size !== members.length) add(`roleGroups.${role} 不能重复引用节点`);
      for (const member of members) if (!names.has(member)) add(`roleGroups.${role} 引用了不存在的节点：${member}`);
    }
  }

  const bootstraps = normalized.filter(({ bootstrap }) => bootstrap);
  if (bootstraps.length !== 1) add("bootstrap 节点必须恰好配置一个");
  if (bootstraps.length === 1 && Array.isArray(roleGroups?.master) && !roleGroups.master.includes(bootstraps[0].name)) {
    add("bootstrap 节点必须属于 master 角色组");
  }
  try {
    const storageMode = storageModeFor(value);
    const nfsMembers = Array.isArray(roleGroups?.["nfs-server"]) ? roleGroups["nfs-server"] : [];
    if (storageMode === "builtin-nfs" && nfsMembers.length !== 1) add("使用内置 NFS 时 nfs-server 必须恰好包含一个节点");
    if (storageMode !== "builtin-nfs" && nfsMembers.length !== 0) add("使用外部 NFS、existing StorageClass 或外部存储时 nfs-server 必须为空");
  } catch (error) {
    add(error.message);
  }
  if (issues.length === 0) {
    try { validateClusterTopology(value); } catch (error) { add(error.message); }
  }
  return { value, issues };
}

function hasSensitiveFields(value) {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(hasSensitiveFields);
  return Object.entries(value).some(([key, child]) => SENSITIVE_KEY.test(key) || hasSensitiveFields(child));
}

function hasDisallowedGeneratedSensitiveFields(value, pathSegments = []) {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) {
    return value.some((child, index) => hasDisallowedGeneratedSensitiveFields(child, [...pathSegments, index]));
  }
  return Object.entries(value).some(([key, child]) => {
    const allowedHostPassword = key === "password"
      && pathSegments.length === 2
      && pathSegments[0] === "hosts"
      && Number.isInteger(pathSegments[1]);
    return (SENSITIVE_KEY.test(key) && !allowedHostPassword)
      || hasDisallowedGeneratedSensitiveFields(child, [...pathSegments, key]);
  });
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
  if (normalizeServerInputAddress(address) === null) {
    throw new Error(`节点 address 无效：${name}`);
  }
  if (normalizeServerInputAddress(internalAddress) === null) {
    throw new Error(`节点 internalAddress 无效：${name}`);
  }
  if (user !== "root") throw new Error(`ROI 主机安装只支持 root SSH 用户：${name}`);
  if (typeof raw.password !== "string" || raw.password.trim() === "") throw new Error(`节点 password 未填写：${name}`);
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
  const sshEndpoints = new Set();
  const internalAddresses = new Set();
  for (const item of hosts) {
    if (names.has(item.name)) throw new Error(`节点名称必须唯一：${item.name}`);
    names.add(item.name);
    const normalizedAddress = normalizeServerInputAddress(item.address);
    const endpoint = `${normalizedAddress}\0${item.port}`;
    if (sshEndpoints.has(endpoint)) throw new Error(`节点地址（SSH endpoint）存在冲突：${item.address}:${item.port}`);
    sshEndpoints.add(endpoint);
    const normalizedInternalAddress = normalizeServerInputAddress(item.internalAddress);
    if (internalAddresses.has(normalizedInternalAddress)) {
      throw new Error(`节点 internalAddress 存在冲突：${item.internalAddress}`);
    }
    internalAddresses.add(normalizedInternalAddress);
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
      password: item.password,
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
  if (hasDisallowedGeneratedSensitiveFields(value)) throw new Error("基础向导不能生成私钥、Token 或其他未允许的敏感字段");
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

function readProtectedServerInput(filePath, {
  platform = process.platform,
  stateStore,
  fsImpl = fs,
  currentUid = typeof process.getuid === "function" ? process.getuid() : null,
} = {}) {
  if (!stateStore || typeof stateStore.assertProtectedRegularFile !== "function") {
    throw new Error("servers.txt 必须通过受保护文件检查");
  }
  const readOnce = () => {
    let opened;
    try {
      const noFollow = platform === "win32" ? 0 : (fsImpl.constants.O_NOFOLLOW || 0);
      opened = fsImpl.openSync(filePath, fsImpl.constants.O_RDONLY | noFollow);
    } catch (error) {
      if (["ELOOP", "EMLINK"].includes(error.code)) throw new Error("拒绝读取符号链接 servers.txt");
      throw error;
    }
    try {
      const info = fsImpl.fstatSync(opened);
      if (!info.isFile() || info.isSymbolicLink?.()) throw new Error("servers.txt 不是普通文件");
      if (currentUid !== null && info.uid !== currentUid) throw new Error("servers.txt 不属于当前用户");
      if (platform !== "win32" && (info.mode & 0o777) !== 0o600) {
        throw new Error("servers.txt 权限必须精确为 0600");
      }
      if (info.size > MAX_SERVER_INPUT_BYTES) throw new Error("servers.txt 大小不能超过 1 MiB");
      const bytes = Buffer.alloc(info.size);
      let offset = 0;
      while (offset < bytes.length) {
        const count = fsImpl.readSync(opened, bytes, offset, bytes.length - offset, offset);
        if (count === 0) throw new Error("servers.txt 在读取期间发生变化，拒绝继续");
        offset += count;
      }
      const extra = Buffer.alloc(1);
      if (fsImpl.readSync(opened, extra, 0, 1, offset) !== 0) {
        throw new Error("servers.txt 在读取期间增长或超过 1 MiB，拒绝继续");
      }
      const afterInfo = fsImpl.fstatSync(opened);
      if (sourceIdentity(info) !== sourceIdentity(afterInfo)) {
        throw new Error("servers.txt 在 descriptor 读取期间发生变化，拒绝继续");
      }
      return { bytes, info: afterInfo };
    } finally {
      fsImpl.closeSync(opened);
    }
  };

  const inspectWindowsAcl = () => {
    const protectedAcl = stateStore.assertProtectedRegularFile(filePath);
    const acl = typeof stateStore.assertSafeExternalRegularFile === "function"
      ? stateStore.assertSafeExternalRegularFile(filePath)
      : protectedAcl;
    if (!acl || typeof acl.fileIdentity !== "string" || acl.fileIdentity === "") {
      throw new Error("Windows servers.txt ACL 检查缺少 file identity");
    }
    return acl;
  };
  const beforeAcl = platform === "win32"
    ? inspectWindowsAcl()
    : (stateStore.assertProtectedRegularFile(filePath), null);
  const first = readOnce();
  if (platform === "win32") {
    if (beforeAcl.fileIdentity !== contentIdentity(first.bytes)) {
      throw new Error("Windows servers.txt ACL identity 与首次 fd 字节不匹配");
    }
    const afterAcl = inspectWindowsAcl();
    const second = readOnce();
    if (afterAcl.fileIdentity !== contentIdentity(second.bytes)) {
      throw new Error("Windows servers.txt ACL identity 与再次 fd 字节不匹配");
    }
    if (beforeAcl.fileIdentity !== afterAcl.fileIdentity
      || sourceIdentity(first.info) !== sourceIdentity(second.info)
      || sha256(first.bytes) !== sha256(second.bytes)) {
      throw new Error("servers.txt 在 ACL 检查和读取期间发生变化，拒绝继续");
    }
  } else {
    stateStore.assertProtectedRegularFile(filePath);
    const second = readOnce();
    if (sourceIdentity(first.info) !== sourceIdentity(second.info)
      || sha256(first.bytes) !== sha256(second.bytes)) {
      throw new Error("servers.txt 在两次受保护读取期间字节发生变化，拒绝继续");
    }
  }
  return first.bytes;
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

function createProtectedBytesExclusive(destinationPath, bytes, { stateStore, mode = 0o600 } = {}) {
  const target = path.resolve(destinationPath);
  const directory = path.dirname(target);
  if (stateStore) stateStore.ensurePrivateDirectory(directory);
  else {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") fs.chmodSync(directory, 0o700);
  }
  let fd;
  try {
    fd = fs.openSync(target, "wx", mode);
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
  } catch (error) {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch {}
      fd = undefined;
    }
    if (error.code === "EEXIST") throw new Error("受保护的 cluster.yaml 已存在，拒绝覆盖");
    try { fs.unlinkSync(target); } catch (cleanupError) { if (cleanupError.code !== "ENOENT") throw cleanupError; }
    throw error;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  try {
    if (process.platform !== "win32") fs.chmodSync(target, mode);
    if (stateStore) stateStore.protectRegularFile(target);
  } catch (error) {
    try { fs.unlinkSync(target); } catch (cleanupError) { if (cleanupError.code !== "ENOENT") throw cleanupError; }
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
  createProtectedBytesExclusive(destination, bytes, { stateStore });
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

function boundedOutputLimit(requested) {
  const value = Number(requested);
  if (!Number.isSafeInteger(value) || value <= 0) return MAX_CHILD_OUTPUT_BYTES;
  return Math.min(value, MAX_CHILD_OUTPUT_BYTES);
}

function childOutputLimitError() {
  const error = new Error(CHILD_OUTPUT_LIMIT_ERROR);
  error.code = "RAINSKILLS_CHILD_OUTPUT_LIMIT";
  return error;
}

function createByteCollector() {
  const segments = [];
  let current = null;
  let used = 0;
  let length = 0;
  return {
    append(input) {
      const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input);
      let offset = 0;
      while (offset < bytes.length) {
        if (!current) current = Buffer.allocUnsafe(64 * 1024);
        const copied = Math.min(current.length - used, bytes.length - offset);
        bytes.copy(current, used, offset, offset + copied);
        used += copied;
        offset += copied;
        length += copied;
        if (used === current.length) {
          segments.push(current);
          current = null;
          used = 0;
        }
      }
    },
    toString() {
      const parts = current && used > 0 ? [...segments, current.subarray(0, used)] : segments;
      return Buffer.concat(parts, length).toString("utf8");
    },
  };
}

function defaultSshRunner(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const spawnFn = options.spawnFn || spawn;
    const registerChild = options.registerChild || (() => {});
    const child = spawnFn(command, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    const unregister = registerChild(child, false);
    const outputLimit = boundedOutputLimit(options.maxOutputBytes);
    const collectors = { stdout: createByteCollector(), stderr: createByteCollector() };
    let collectedBytes = 0;
    let settled = false;
    let cleared = false;
    const clear = () => {
      if (cleared) return;
      cleared = true;
      if (typeof unregister === "function") unregister();
      else registerChild(null, false);
    };
    const exceedLimit = () => {
      if (settled) return;
      settled = true;
      clear();
      try { child.kill?.("SIGKILL"); } catch {}
      reject(childOutputLimitError());
    };
    const collect = (name) => (chunk) => {
      if (settled) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (collectedBytes + bytes.length > outputLimit) {
        exceedLimit();
        return;
      }
      collectedBytes += bytes.length;
      collectors[name].append(bytes);
    };
    child.stdout.on("data", collect("stdout"));
    child.stderr.on("data", collect("stderr"));
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clear();
      reject(error);
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clear();
      resolve({
        code,
        signal,
        stdout: collectors.stdout.toString(),
        stderr: collectors.stderr.toString(),
      });
    });
    child.stdin.end(options.input || "");
  });
}

function sshOptionsForSession(session) {
  return [
    "-o", "BatchMode=yes",
    ...(session?.controlPath ? ["-o", `ControlPath=${session.controlPath}`] : []),
  ];
}

async function prepareHostSshSessions(topology, {
  sessionFactory,
  interactive = process.stdin.isTTY && process.stdout.isTTY,
  write = (value) => process.stdout.write(value),
  configPath,
  packageVersion = require("../../package.json").version,
  platform = process.platform,
} = {}) {
  const sessions = new Map();
  const pending = [];
  if (typeof sessionFactory !== "function") return { waiting: false, sessions };
  for (const item of topology.hosts) {
    const session = await sessionFactory(item, { interactive, write, deferAuthenticationMessage: true });
    if (!session) {
      pending.push(item);
      continue;
    }
    sessions.set(item.name, session);
  }
  if (pending.length > 0) {
    write("\n[RAINSKILLS_USER_INPUT_REQUIRED:ssh_authentication]\n");
    writeUserMessage(write, "platform.ssh-authentication", renderHostClusterSshAuthenticationPrompt({
      nodes: pending,
      configPath,
      packageVersion,
      platform,
    }));
    return { waiting: true, sessions, pending };
  }
  return { waiting: false, sessions };
}

async function probeRemoteArchitecture(bootstrap, {
  session,
  sshRunner = defaultSshRunner,
  registerChild,
  sshSpawn,
} = {}) {
  const args = [
    ...sshOptionsForSession(session),
    "-p", String(bootstrap.port),
    `root@${bootstrap.address}`,
    "uname", "-m",
  ];
  const execution = await sshRunner("ssh", args, { registerChild, spawnFn: sshSpawn });
  if (execution.signal) {
    const error = new Error("读取 bootstrap 节点架构时被中断");
    error.code = "RAINSKILLS_HOST_CLUSTER_INTERRUPTED";
    error.signal = execution.signal;
    throw error;
  }
  if (execution.code !== 0) throw new Error("无法读取 bootstrap 节点的 CPU 架构");
  const value = String(execution.stdout || "").trim().toLowerCase();
  if (["x86_64", "x64", "amd64"].includes(value)) return "amd64";
  if (["aarch64", "arm64"].includes(value)) return "arm64";
  throw new Error("bootstrap 节点的 CPU 架构不受 ROI 支持");
}

function renderTopologyNodeLine(node) {
  return `- ${node.name}: ${node.roles.join(", ")}${node.bootstrap ? " (bootstrap)" : ""}`;
}

function renderValidatedTopologyStatus(summary, configPath) {
  const etcdNodes = (summary.nodes || []).filter(({ roles }) => roles.includes("etcd"));
  const lines = [
    "",
    "[RAINSKILLS_STATUS:host_cluster_config_valid]",
    "集群配置检查通过：",
    `- 节点：${summary.hosts} 个`,
    `- etcd：${etcdNodes.length} 个`,
    `- bootstrap：${summary.bootstrap}`,
    `- 存储模式：${summary.storageMode}`,
    `受保护配置：${configPath}`,
    "",
    "自动角色分配：",
    ...(summary.nodes || []).map(renderTopologyNodeLine),
    "",
    "正在准备所有服务器的 SSH 连接。",
  ];
  return `${lines.join("\n")}\n`;
}

function renderConfirmationSummary(summary) {
  const lines = ["\nROI 主机集群安装确认", "", `节点拓扑：${summary.hosts} 个节点`];
  for (const node of summary.nodes || []) lines.push(renderTopologyNodeLine(node));
  lines.push("", "将发生的系统变更：安装 RKE2、Containerd、Rainbond 及所选存储组件；写入 /opt/rainbond 和 /var/lib/rancher。", `受保护配置：${summary.configPath}`, "");
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
  const versionPattern = /^roi\s+version(?:\s+[A-Za-z0-9][A-Za-z0-9._+/-]{0,99}|:\s+[A-Za-z0-9][A-Za-z0-9._+/-]{0,99})$/i;
  const version = lines.find((line) => versionPattern.test(line));
  if (!version || version.length > 120 || /[\u0000-\u001f\u007f-\u009f]/u.test(version)) {
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

function normalizeSensitiveValues(sensitiveValues = []) {
  if (!Array.isArray(sensitiveValues)) return [];
  return [...new Set(sensitiveValues
    .filter((value) => typeof value === "string" && value.length > 0))]
    .sort((left, right) => right.length - left.length);
}

function selectSafeRedactionMarker(sensitiveValues) {
  const candidates = ["[REDACTED]", "[FILTERED]", "[MASKED]", "***", ""];
  return candidates.find((candidate) => (
    sensitiveValues.every((sensitiveValue) => !candidate.includes(sensitiveValue))
  )) ?? "";
}

function redactLiteralSensitiveValues(value, sensitiveValues, marker) {
  let safe = String(value || "");
  for (const sensitiveValue of sensitiveValues) {
    safe = safe.split(sensitiveValue).join(marker);
  }
  return safe;
}

function createLineRedactor(sensitiveValues = []) {
  const literalValues = normalizeSensitiveValues(sensitiveValues);
  const marker = selectSafeRedactionMarker(literalValues);
  let sensitiveBlockIndent = null;
  let pemBlock = false;
  let structuredBlockIndent = null;
  return (value) => {
    const line = redactLiteralSensitiveValues(String(value || "").replace(/\r$/, ""), literalValues, marker);
    const indent = line.match(/^\s*/)?.[0].length || 0;
    if (pemBlock) {
      if (/-----END [A-Z0-9 ]+-----/.test(line)) pemBlock = false;
      return `${line.slice(0, indent)}${marker}`;
    }
    const pemBegin = /-----BEGIN [A-Z0-9 ]+-----/.test(line);
    if (pemBegin) {
      if (!/-----END [A-Z0-9 ]+-----/.test(line)) pemBlock = true;
      return `${line.slice(0, indent)}${marker}`;
    }
    if (structuredBlockIndent !== null) {
      if (!line.trim() || indent > structuredBlockIndent) return `${line.slice(0, indent)}${marker}`;
      structuredBlockIndent = null;
      if (/^[}\]],?$/.test(line.trim())) return `${line.slice(0, indent)}${marker}`;
    }
    if (sensitiveBlockIndent !== null) {
      if (!line.trim() || indent > sensitiveBlockIndent) return `${line.slice(0, indent)}${marker}`;
      sensitiveBlockIndent = null;
    }
    if (
      /\b(?:Bearer|Basic)\s+\S+/i.test(line)
      || /\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/.test(line)
    ) return `${line.slice(0, indent)}${marker}`;
    const keyMatches = [...line.matchAll(/(?:password|passwd|token|secret|private.?key|credential|database|registry|authorization|proxy-authorization|set-cookie|cookie|api[-_ ]?key|apikey|grjwt|jwt)/ig)];
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
    const firstCandidate = candidates.reduce((earliest, candidate) => (
      !earliest || candidate.separator < earliest.separator ? candidate : earliest
    ), null);
    const separator = firstCandidate?.separator ?? -1;
    if (separator < 0) return marker;
    const remainder = blockCandidate?.remainder ?? firstCandidate.remainder;
    if (/-----BEGIN [A-Z0-9 ]+-----/.test(remainder) && !/-----END [A-Z0-9 ]+-----/.test(remainder)) pemBlock = true;
    else if (/^[\[{]/.test(remainder) || /[\[{]\s*$/.test(line)) structuredBlockIndent = indent;
    else if (!remainder || /^[|>][+-]?$/.test(remainder)) sensitiveBlockIndent = indent;
    return `${line.slice(0, separator + 1)} ${marker}`;
  };
}

function redactInstallLog(value, maxBytes = MAX_CHILD_OUTPUT_BYTES, sensitiveValues = []) {
  const outputLimit = boundedOutputLimit(maxBytes);
  const input = String(value || "");
  if (Buffer.byteLength(input) > outputLimit) throw childOutputLimitError();
  const redactLine = createLineRedactor(sensitiveValues);
  const output = [];
  let pending = "";
  let outputBytes = 0;
  let offset = 0;
  while (offset <= input.length) {
    const newline = input.indexOf("\n", offset);
    const atEnd = newline < 0;
    const line = input.slice(offset, atEnd ? input.length : newline);
    const safe = `${redactLine(line)}${atEnd ? "" : "\n"}`;
    outputBytes += Buffer.byteLength(safe);
    if (outputBytes > outputLimit) throw childOutputLimitError();
    pending += safe;
    if (pending.length >= 64 * 1024) {
      output.push(pending);
      pending = "";
    }
    if (atEnd) break;
    offset = newline + 1;
  }
  if (pending) output.push(pending);
  return output.join("");
}

function protectedInstallLogBytes(execution, sensitiveValues = []) {
  const rawStdout = String(execution?.stdout || "");
  const rawStderr = String(execution?.stderr || "");
  if (Buffer.byteLength(rawStdout) + Buffer.byteLength(rawStderr) > MAX_CHILD_OUTPUT_BYTES) {
    throw childOutputLimitError();
  }
  const stdout = redactInstallLog(rawStdout, MAX_CHILD_OUTPUT_BYTES, sensitiveValues);
  const stderr = redactInstallLog(rawStderr, MAX_CHILD_OUTPUT_BYTES, sensitiveValues);
  const stdoutLength = Buffer.byteLength(stdout);
  const stderrLength = Buffer.byteLength(stderr);
  const separatorLength = stdoutLength > 0 && stderrLength > 0 ? 1 : 0;
  if (stdoutLength + separatorLength + stderrLength > MAX_CHILD_OUTPUT_BYTES) throw childOutputLimitError();
  const stdoutBytes = Buffer.from(stdout, "utf8");
  const stderrBytes = Buffer.from(stderr, "utf8");
  const separator = stdoutBytes.length > 0 && stderrBytes.length > 0 ? Buffer.from("\n") : Buffer.alloc(0);
  return Buffer.concat([stdoutBytes, separator, stderrBytes]);
}

function assertSafeRemotePath(value) {
  const normalized = String(value || "");
  if (!SAFE_REMOTE_PATH.test(normalized) || normalized.includes("..") || normalized.includes("//")) throw new Error("远端操作路径无效");
  return normalized;
}

const ROI_COMPLETION_RECEIPT_LINE = "RECEIPT_PHASE=completed";

function isExactRoiCompletionReceiptLine(value) {
  const line = String(value || "");
  return (line.endsWith("\r") ? line.slice(0, -1) : line) === ROI_COMPLETION_RECEIPT_LINE;
}

function hasExactRoiCompletionReceipt(value) {
  return String(value || "").split("\n").some(isExactRoiCompletionReceiptLine);
}

function spawnRedactedAttached(command, args, {
  spawnFn = spawn,
  registerChild = () => {},
  stdoutWriter = process.stdout,
  stderrWriter = process.stderr,
  maxOutputBytes,
  input,
  sensitiveValues = [],
} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnFn(command, args, { stdio: [input === undefined ? "inherit" : "pipe", "pipe", "pipe"] });
    let settled = false;
    let cleared = false;
    let receivedBytes = 0;
    let emittedBytes = 0;
    let receiptCompleted = false;
    const outputLimit = boundedOutputLimit(maxOutputBytes);
    const collected = { stdout: [], stderr: [] };
    const pending = { stdout: "", stderr: "" };
    const buffers = { stdout: "", stderr: "" };
    const redactors = {
      stdout: createLineRedactor(sensitiveValues),
      stderr: createLineRedactor(sensitiveValues),
    };
    const unregister = registerChild(child, false);
    const clear = () => {
      if (cleared) return;
      cleared = true;
      if (typeof unregister === "function") unregister();
      else registerChild(null, false);
    };
    const exceedLimit = () => {
      if (settled) return;
      settled = true;
      clear();
      try { child.kill?.("SIGKILL"); } catch {}
      reject(childOutputLimitError());
    };
    const emitSafe = (name, writer, safe) => {
      const safeBytes = Buffer.byteLength(safe);
      if (emittedBytes + safeBytes > outputLimit) {
        exceedLimit();
        return false;
      }
      emittedBytes += safeBytes;
      pending[name] += safe;
      if (pending[name].length >= 64 * 1024) {
        collected[name].push(pending[name]);
        pending[name] = "";
      }
      writer.write(safe);
      return true;
    };
    const stream = (name, writer) => (chunk) => {
      if (settled) return;
      const chunkBytes = Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk));
      if (receivedBytes + chunkBytes > outputLimit) {
        exceedLimit();
        return;
      }
      receivedBytes += chunkBytes;
      buffers[name] += String(chunk);
      let newline;
      while ((newline = buffers[name].indexOf("\n")) >= 0) {
        const rawLine = buffers[name].slice(0, newline);
        if (name === "stdout" && isExactRoiCompletionReceiptLine(rawLine)) receiptCompleted = true;
        const safe = `${redactors[name](rawLine)}\n`;
        buffers[name] = buffers[name].slice(newline + 1);
        if (!emitSafe(name, writer, safe)) return;
      }
    };
    const flush = (name, writer) => {
      if (!buffers[name]) return;
      const rawLine = buffers[name];
      if (name === "stdout" && isExactRoiCompletionReceiptLine(rawLine)) receiptCompleted = true;
      const safe = redactors[name](rawLine);
      buffers[name] = "";
      emitSafe(name, writer, safe);
    };
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
      flush("stdout", stdoutWriter);
      if (settled) return;
      flush("stderr", stderrWriter);
      if (settled) return;
      settled = true;
      clear();
      for (const name of ["stdout", "stderr"]) {
        if (pending[name]) collected[name].push(pending[name]);
      }
      resolve({
        code,
        signal,
        stdout: collected.stdout.join(""),
        stderr: collected.stderr.join(""),
        redacted: true,
        receiptCompleted,
      });
    });
    if (input !== undefined) child.stdin.end(input);
  });
}

async function defaultTransfer({
  host, port, localPath, remotePath, sha256: expectedDigest, mode = 0o600, session,
  runner = spawnSync,
}) {
  const runOptions = { encoding: "utf8", timeout: 30_000, stdio: ["inherit", "pipe", "pipe"] };
  const scriptRunOptions = { ...runOptions, stdio: ["pipe", "pipe", "pipe"] };
  const sshOptions = sshOptionsForSession(session);
  const remoteDirectory = path.posix.dirname(remotePath);
  const remoteTemporary = path.posix.join(remoteDirectory, `.rainskills-upload-${crypto.randomBytes(16).toString("hex")}`);
  const mkdir = runner("ssh", [...sshOptions, "-p", String(port), host, "install", "-d", "-m", "700", "--", remoteDirectory], runOptions);
  if (mkdir.error || mkdir.status !== 0) throw new Error("无法准备 bootstrap 受保护操作目录");
  const stage = runner("ssh", [...sshOptions, "-p", String(port), host, "bash", "-s", "--", remoteDirectory, remoteTemporary], { ...scriptRunOptions, input: REMOTE_STAGE_SCRIPT });
  if (stage.error || stage.status !== 0) throw new Error("无法创建 bootstrap 安全上传暂存文件");
  const upload = runner("scp", [...sshOptions, "-P", String(port), localPath, `${host}:${remoteTemporary}`], { ...runOptions, timeout: 5 * 60_000 });
  if (upload.error || upload.status !== 0) throw new Error("无法把受保护安装文件传输到 bootstrap");
  const remoteMode = mode === 0o700 ? "700" : "600";
  const publish = runner("ssh", [
    ...sshOptions, "-p", String(port), host, "bash", "-s", "--",
    remoteTemporary, remotePath, expectedDigest, remoteMode,
  ], { ...scriptRunOptions, input: REMOTE_PUBLISH_SCRIPT });
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
  sshSpawn,
  write = (value) => process.stderr.write(value),
  abortState,
  sensitiveValues = [],
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
  const remoteReceipt = path.posix.join(protectedRemoteDir, "execution.receipt");
  const args = [
    "-tt", ...sshOptionsForSession(session), "-p", String(item.port), target,
    "bash", "-s", "--", protectedRemoteDir, remoteReceipt, resumeArgv[5],
    configDigest, artifactDigest, remoteArtifact, remoteConfig,
  ];
  const execution = await attachedRunner("ssh", args, {
    registerChild,
    spawnFn: sshSpawn,
    input: REMOTE_ROI_LAUNCH_SCRIPT,
    sensitiveValues,
  });
  const receiptCompleted = execution.receiptCompleted === true
    || (execution.receiptCompleted === undefined && hasExactRoiCompletionReceipt(execution.stdout));
  atomicWriteProtectedBytes(logPath, protectedInstallLogBytes(execution, sensitiveValues), { stateStore });
  if (execution.signal || execution.code === 130) {
    persistState({ stage: "executing", status: "interrupted", configSha256: configDigest, artifactSha256: artifactDigest, resumeArgv });
    write("\n[RAINSKILLS_AGENT_CONTINUATION_REQUIRED:host_cluster_interrupted]\n安装会话已中断，受保护状态已保留；当前任务将先进行安全核对再继续。\n");
    return { interrupted: true, signal: execution.signal || "SIGINT", resumeArgv };
  }
  if (execution.code !== 0) {
    persistState({ stage: "executing", status: "failed", configSha256: configDigest, artifactSha256: artifactDigest, resumeArgv });
    throw new Error(`ROI 主机集群安装失败，退出码 ${execution.code}`);
  }
  if (!receiptCompleted) {
    persistState({ stage: "executing", status: "failed", configSha256: configDigest, artifactSha256: artifactDigest, resumeArgv });
    throw new Error("ROI 已返回成功，但远端 completed receipt 验证结果缺失");
  }
  persistState({ stage: "verifying", status: "running", configSha256: configDigest, artifactSha256: artifactDigest, resumeArgv });
  return { interrupted: false, resumeArgv };
}

async function reconcileHostExecution({
  bootstrap,
  remoteDir,
  operationId,
  configSha256,
  artifactSha256,
  sshRunner = defaultSshRunner,
  inspectCluster,
  session,
  registerChild,
  sshSpawn,
  abortState,
}) {
  assertOperationNotAborted(abortState);
  const expectedConfigSha256 = /^[a-f0-9]{64}$/.test(String(configSha256 || "")) ? configSha256 : "0".repeat(64);
  const expectedArtifactSha256 = /^[a-f0-9]{64}$/.test(String(artifactSha256 || "")) ? artifactSha256 : "0".repeat(64);
  const expectedOperationId = /^[0-9a-f-]{36}$/i.test(String(operationId || "")) ? operationId : "00000000-0000-0000-0000-000000000000";
  const item = normalizeHost(bootstrap, 0);
  const protectedRemoteDir = assertSafeRemotePath(remoteDir);
  const remoteConfig = path.posix.join(protectedRemoteDir, "cluster.yaml");
  const remoteArtifact = path.posix.join(protectedRemoteDir, "roi");
  const remoteReceipt = path.posix.join(protectedRemoteDir, "execution.receipt");
  const execution = await sshRunner("ssh", [
    ...sshOptionsForSession(session), "-p", String(item.port), `root@${item.address}`,
    "bash", "-s", "--", protectedRemoteDir, remoteConfig, remoteArtifact, remoteReceipt,
    expectedOperationId, expectedConfigSha256, expectedArtifactSha256,
  ], { input: REMOTE_RECONCILE_SCRIPT, registerChild, spawnFn: sshSpawn });
  if (execution.signal) {
    const error = new Error("bootstrap 安装恢复核对被中断");
    error.code = "RAINSKILLS_HOST_CLUSTER_INTERRUPTED";
    error.signal = execution.signal;
    throw error;
  }
  assertOperationNotAborted(abortState);
  if (execution.code !== 0) return { disposition: "unknown", reason: "ownership_probe_failed" };
  const values = {};
  for (const line of String(execution.stdout || "").split("\n")) {
    const separator = line.indexOf("=");
    if (separator > 0) values[line.slice(0, separator)] = line.slice(separator + 1);
  }
  const ownershipVerified = parseBoolean(values.OWNERSHIP_VERIFIED);
  const bytesVerified = parseBoolean(values.BYTES_VERIFIED);
  const receiptPresent = parseBoolean(values.RECEIPT_PRESENT);
  const receiptPhase = String(values.RECEIPT_PHASE || "invalid");
  const started = parseBoolean(values.STARTED);
  if (!receiptPresent && !started && ownershipVerified && bytesVerified) {
    return { disposition: "not_started", ownershipVerified, bytesVerified, receiptPresent, receiptPhase };
  }
  if (!receiptPresent && started) {
    return { disposition: "unknown", ownershipVerified, bytesVerified, receiptPresent, receiptPhase, reason: "external_cluster_detected_without_operation_marker" };
  }
  if (receiptPresent && receiptPhase === "launching") {
    return { disposition: "unknown", ownershipVerified, bytesVerified, receiptPresent, receiptPhase, reason: "operation_launch_incomplete" };
  }
  if (receiptPresent && receiptPhase !== "completed") {
    return { disposition: "unknown", ownershipVerified, bytesVerified, receiptPresent, receiptPhase, reason: "operation_marker_invalid" };
  }
  if (!receiptPresent) return { disposition: "unknown", ownershipVerified, bytesVerified, receiptPresent, receiptPhase, reason: "remote_ownership_or_bytes_unverified" };
  if (!ownershipVerified || !bytesVerified) {
    return { disposition: "unknown", ownershipVerified, bytesVerified, receiptPresent, receiptPhase, reason: "operation_bytes_unverified" };
  }
  if (!started) {
    return { disposition: "started_unhealthy", ownershipVerified, bytesVerified, receiptPresent, receiptPhase, reason: "completed_operation_without_cluster_health" };
  }
  try {
    const cluster = await (inspectCluster || (() => inspectRemoteCluster({
      bootstrap: item, session, registerChild, sshSpawn, abortState,
    })))();
    return { disposition: "started", ownershipVerified, bytesVerified, receiptPresent, receiptPhase, cluster };
  } catch (error) {
    if (error?.code === "RAINSKILLS_HOST_CLUSTER_INTERRUPTED") throw error;
    return { disposition: "started_unhealthy", ownershipVerified, bytesVerified, reason: "cluster_health_unverified" };
  }
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
  const serverInputPath = path.join(hostRoot, "servers.txt");
  const driverStatePath = path.join(hostRoot, "state.json");
  const logPath = path.join(hostRoot, "roi.log");
  const loadedDriverState = loadDriverState(driverStatePath, stateStore);
  let driverState = loadedDriverState || {
    schema: "rainskills.host-cluster-state.v1", version: 1, operation_id: state.operation_id,
    stage: "configuration", status: "running", config_path: configPath,
  };
  const persistDriverState = (values) => {
    driverState = { ...driverState, ...values, updated_at: new Date().toISOString() };
    stateStore.atomicWriteJson(driverStatePath, driverState);
  };

  const write = dependencies.write || ((value) => process.stdout.write(value));
  if (!loadedDriverState) {
    if (fs.existsSync(configPath)) {
      throw new Error("发现来源不明的受保护 cluster.yaml，已停止；请将其作为外部文件重新导入，或移走后重新生成模板");
    }
    if (fs.existsSync(serverInputPath)) {
      throw new Error("发现来源不明的受保护 servers.txt，已停止；请移走后重新开始");
    }
    persistDriverState({
      config_source: options.clusterConfig ? "imported-file" : "generated-server-input",
      ...(options.clusterConfig ? { import_source_path: path.resolve(options.clusterConfig) } : {}),
      ...(!options.clusterConfig ? { server_input_path: serverInputPath } : {}),
    });
  } else if (!driverState.config_source) {
    if (driverState.stage !== "configuration" && driverState.config_sha256) {
      persistDriverState({
        config_source: "imported-file",
        import_source_sha256: driverState.config_sha256,
      });
    } else {
      throw new Error("主机集群配置来源状态不完整，拒绝读取 cluster.yaml");
    }
  }
  if (driverState.operation_id !== state.operation_id) throw new Error("主机集群配置 operation 不匹配");
  if (driverState.config_source === "generated-template" && options.clusterConfig) {
    throw new Error("当前流程已绑定自动生成的 cluster.yaml，不能切换为外部导入配置");
  }
  if (driverState.config_source === "generated-server-input" && options.clusterConfig) {
    throw new Error("当前流程已绑定自动生成的 servers.txt，不能切换为外部导入配置");
  }
  if (driverState.config_source === "imported-file" && options.clusterConfig
    && path.resolve(options.clusterConfig) !== driverState.import_source_path) {
    throw new Error("当前流程已绑定另一份外部 cluster.yaml，不能切换配置来源");
  }

  const handoff = options.agentHandoff
    ? agentHandoffBinding({ state, options, driverState })
    : null;
  if (options.agentHandoff && !options.yes && !options.cancel && driverState.agent_handoff) {
    assertMatchingAgentHandoff(driverState.agent_handoff, handoff);
    if (driverState.agent_handoff.phase === "waiting_confirmation"
      && driverState.stage === "confirmation" && driverState.status === "waiting_user") {
      return { waiting: true };
    }
    throw new Error("当前 AI 确认状态不能重新创建安装会话");
  }
  if (options.agentHandoff && options.cancel) {
    assertMatchingAgentHandoff(driverState.agent_handoff, handoff);
    if (driverState.agent_handoff.phase !== "waiting_confirmation"
      || driverState.stage !== "confirmation" || driverState.status !== "waiting_user") {
      throw new Error("当前没有可取消的 AI 安装确认");
    }
    persistDriverState({ stage: "confirmation", status: "cancelled", agent_handoff: null });
    return { waiting: true, cancelled: true };
  }
  if (options.agentHandoff && options.yes) {
    assertMatchingAgentHandoff(driverState.agent_handoff, handoff);
    const pendingConfirmation = driverState.agent_handoff.phase === "waiting_confirmation"
      && driverState.stage === "confirmation" && ["waiting_user", "interrupted"].includes(driverState.status);
    const safeResume = driverState.agent_handoff.phase === "approved"
      && ((["artifact", "executing", "verifying"].includes(driverState.stage)
        && ["interrupted", "running"].includes(driverState.status))
        || (driverState.stage === "completed" && driverState.status === "completed"));
    if (!pendingConfirmation && !safeResume) {
      throw new Error("当前 AI 确认状态不能继续安装");
    }
  }

  let config;
  if (driverState.config_source === "generated-server-input") {
    if (driverState.server_input_path !== serverInputPath) {
      throw new Error("主机集群 servers.txt 路径状态不匹配，拒绝继续");
    }
    if (!fs.existsSync(serverInputPath)) {
      if (fs.existsSync(configPath)) {
        throw new Error("servers.txt 缺失且发现无法验证来源的 cluster.yaml，拒绝继续");
      }
      const template = createHostServerInputTemplate();
      createProtectedBytesExclusive(serverInputPath, template, { stateStore });
      persistDriverState({
        stage: "configuration",
        status: "waiting_user",
        server_input_template_sha256: sha256(template),
      });
      write("\n[RAINSKILLS_USER_INPUT_REQUIRED:host_cluster_server_input]\n");
      writeUserMessage(write, "platform.host-cluster-server-input", renderHostServerInputPrompt({
        inputPath: serverInputPath,
        platform: dependencies.platform || process.platform,
      }));
      return { waiting: true, waitingStage: "waiting-host-cluster-server-input", inputPath: serverInputPath };
    }

    const inputBytes = readProtectedServerInput(serverInputPath, {
      platform: dependencies.platform || process.platform,
      stateStore,
    });
    const inputSha256 = sha256(inputBytes);
    if (driverState.server_input_sha256 && driverState.server_input_sha256 !== inputSha256) {
      throw new Error("恢复时 servers.txt 字节发生变化，拒绝继续");
    }

    if (driverState.server_input_sha256) {
      if (!driverState.generated_config_sha256 || !driverState.config_sha256) {
        throw new Error("自动生成的 cluster.yaml 摘要状态不完整，拒绝继续");
      }
      if (!fs.existsSync(configPath)) throw new Error("已锁定的 cluster.yaml 缺失，拒绝恢复");
      const locked = readSafeClusterSource(configPath, {
        platform: dependencies.platform || process.platform,
        sourceStateStore: stateStore,
      });
      const lockedSha256 = sha256(locked.bytes);
      if (lockedSha256 !== driverState.generated_config_sha256
        || lockedSha256 !== driverState.config_sha256) {
        throw new Error("恢复时 cluster.yaml 字节发生变化，拒绝继续");
      }
      config = locked.value;
    } else {
      const parsed = parseHostServerInput(inputBytes);
      if (parsed.issues.length > 0) {
        if (fs.existsSync(configPath)) {
          throw new Error("servers.txt 无效且发现无法验证的 cluster.yaml，拒绝继续");
        }
        persistDriverState({ stage: "configuration", status: "waiting_user" });
        write("\n[RAINSKILLS_USER_INPUT_REQUIRED:host_cluster_server_input]\n");
        writeUserMessage(write, "platform.host-cluster-server-input", renderHostServerInputPrompt({
          inputPath: serverInputPath,
          platform: dependencies.platform || process.platform,
          issues: parsed.issues,
        }));
        return {
          waiting: true,
          waitingStage: "waiting-host-cluster-server-input",
          inputPath: serverInputPath,
          issues: parsed.issues,
        };
      }

      const expectedConfigBytes = createClusterConfigFromServerInput(parsed.hosts);
      if (!fs.existsSync(configPath)) {
        createProtectedBytesExclusive(configPath, expectedConfigBytes, { stateStore });
      }
      const generated = readSafeClusterSource(configPath, {
        platform: dependencies.platform || process.platform,
        sourceStateStore: stateStore,
      });
      if (!generated.bytes.equals(expectedConfigBytes)) {
        throw new Error("已有 cluster.yaml 与 servers.txt 自动生成结果不匹配，拒绝采用");
      }
      const generatedSha256 = sha256(generated.bytes);
      persistDriverState({
        server_input_sha256: inputSha256,
        generated_config_sha256: generatedSha256,
        config_sha256: generatedSha256,
      });
      config = generated.value;
    }
  } else if (driverState.config_source === "generated-template") {
    if (!fs.existsSync(configPath)) {
      const template = createHostClusterTemplate();
      createProtectedBytesExclusive(configPath, template, { stateStore });
      persistDriverState({
        stage: "configuration",
        status: "waiting_user",
        template_sha256: sha256(template),
      });
      write("\n[RAINSKILLS_USER_INPUT_REQUIRED:host_cluster_config]\n");
      writeUserMessage(write, "platform.host-cluster-config", renderHostClusterConfigPrompt({
        configPath,
        platform: dependencies.platform || process.platform,
      }));
      return { waiting: true, waitingStage: "waiting-host-cluster-config", configPath };
    }
    stateStore.assertProtectedRegularFile(configPath);
    const { bytes } = readSafeClusterSource(configPath, {
      platform: dependencies.platform || process.platform,
      sourceStateStore: stateStore,
    });
    const diagnostic = diagnoseClusterConfig(bytes, { source: "generated-template" });
    if (diagnostic.issues.length > 0) {
      persistDriverState({ stage: "configuration", status: "waiting_user" });
      write("\n[RAINSKILLS_USER_INPUT_REQUIRED:host_cluster_config]\n");
      writeUserMessage(write, "platform.host-cluster-config", renderHostClusterConfigPrompt({
        configPath,
        platform: dependencies.platform || process.platform,
        issues: diagnostic.issues,
      }));
      return { waiting: true, waitingStage: "waiting-host-cluster-config", configPath, issues: diagnostic.issues };
    }
    config = diagnostic.value;
  } else if (driverState.config_source === "imported-file") {
    const readImportSource = () => {
      const requestedSource = String(options.clusterConfig || driverState.import_source_path || "").trim();
      if (!requestedSource) throw new Error("外部 cluster.yaml 来源缺失，无法继续导入");
      const sourcePath = path.resolve(requestedSource);
      if (sourcePath === configPath) throw new Error("外部 cluster.yaml 不能指向当前 onboarding 的受保护副本");
      const source = readSafeClusterSource(sourcePath, {
        platform: dependencies.platform || process.platform,
        sourceStateStore: stateStore,
      });
      validateClusterTopology(source.value);
      return { ...source, path: sourcePath, sha256: sha256(source.bytes) };
    };

    let protectedCopy;
    if (!fs.existsSync(configPath)) {
      const source = readImportSource();
      if (driverState.import_source_sha256 && driverState.import_source_sha256 !== source.sha256) {
        throw new Error("外部 cluster.yaml 在导入恢复期间发生变化，拒绝继续");
      }
      createProtectedBytesExclusive(configPath, source.bytes, { stateStore });
      protectedCopy = readSafeClusterSource(configPath, {
        platform: dependencies.platform || process.platform,
        sourceStateStore: stateStore,
      });
      if (!protectedCopy.bytes.equals(source.bytes)) {
        throw new Error("受保护的导入 cluster.yaml 副本与外部 source 字节不匹配，拒绝继续");
      }
      persistDriverState({
        import_source_path: source.path,
        import_source_sha256: source.sha256,
        config_sha256: source.sha256,
      });
    } else {
      stateStore.assertProtectedRegularFile(configPath);
      protectedCopy = readSafeClusterSource(configPath, {
        platform: dependencies.platform || process.platform,
        sourceStateStore: stateStore,
      });
      const protectedSha256 = sha256(protectedCopy.bytes);
      if (driverState.import_source_sha256) {
        if (driverState.import_source_sha256 !== protectedSha256) {
          throw new Error("受保护的导入 cluster.yaml 副本与已锁定 source 摘要不匹配，拒绝继续");
        }
      } else {
        if (!driverState.import_source_path) {
          throw new Error("导入来源状态不完整，缺少受信任的外部 cluster.yaml 路径");
        }
        const source = readImportSource();
        if (!protectedCopy.bytes.equals(source.bytes)) {
          throw new Error("受保护的导入 cluster.yaml 副本与外部 source 字节不匹配，拒绝继续");
        }
        persistDriverState({
          import_source_path: source.path,
          import_source_sha256: source.sha256,
          config_sha256: source.sha256,
        });
      }
    }
    config = protectedCopy.value;
  } else {
    throw new Error("不支持的主机集群配置来源");
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
  if (!driverState.config_sha256) persistDriverState({ config_sha256: configSha256 });
  if (driverState.stage === "configuration") {
    write(renderValidatedTopologyStatus(summarizeTopology(config), configPath));
  }
  const prepared = await prepareHostSshSessions(topology, { ...dependencies, configPath });
  const closeSessions = () => {
    if (typeof dependencies.closeSession !== "function") return;
    for (const session of prepared.sessions.values()) dependencies.closeSession(session);
  };
  if (prepared.waiting) {
    persistDriverState({ stage: "ssh", status: "waiting_user", config_sha256: configSha256 });
    closeSessions();
    return { waiting: true };
  }
  const bootstrapSession = prepared.sessions.get(topology.bootstrap.name);
  try {
    const verifyAndComplete = async (cluster) => {
      persistDriverState({ stage: "verifying", status: "running", resumeArgv });
      const verification = await (dependencies.verify || verifyHostCluster)({
        expectedNodes: topology.hosts.map(({ name }) => name),
        inspectCluster: cluster
          ? async () => cluster
          : dependencies.inspectCluster || (() => inspectRemoteCluster({
            bootstrap: topology.bootstrap,
            session: bootstrapSession,
            registerChild: dependencies.registerChild,
            abortState: dependencies.abortState,
          })),
        probeConsole: dependencies.probeConsole || probeConsole,
      });
      const afterVerification = interruptedAt("verifying");
      if (afterVerification) return afterVerification;
      persistDriverState({ stage: "completed", status: "completed", console_url: verification.consoleUrl, resumeArgv });
      return { verification };
    };
    const blockResume = (reason) => {
      persistDriverState({ stage: driverState.stage, status: "blocked", blocked_reason: reason, resumeArgv });
      (dependencies.write || ((value) => process.stdout.write(value)))(
        "\n[RAINSKILLS_AGENT_CONTINUATION_REQUIRED:host_cluster_resume_blocked]\n无法安全确认 ROI 的远端状态；已保留受保护断点，当前任务需要先完成安全核对。\n"
      );
      return { waiting: true, blocked: true, reason, resumeArgv };
    };
    const executeLockedArtifact = async (artifact) => {
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
          sensitiveValues: topology.hosts.map(({ password }) => password),
        });
      } catch (error) {
        if (error.code !== "RAINSKILLS_HOST_CLUSTER_INTERRUPTED") throw error;
        persistDriverState({ stage: "executing", status: "interrupted", signal: error.signal || "SIGINT", resumeArgv });
        return { waiting: true, interrupted: true, signal: error.signal || "SIGINT", resumeArgv };
      }
      if (execution.interrupted) {
        return { waiting: true, interrupted: true, signal: execution.signal || "SIGINT", resumeArgv };
      }
      const afterExecution = interruptedAt("executing");
      if (afterExecution) return afterExecution;
      return verifyAndComplete();
    };

    if (["verifying", "completed"].includes(driverState.stage)) return verifyAndComplete();

    const normalStages = new Set(["configuration", "ssh", "preflight", "confirmation", "artifact"]);
    if (!normalStages.has(driverState.stage)) {
      let reconciliation;
      try {
        reconciliation = await (dependencies.reconcile || reconcileHostExecution)({
          bootstrap: topology.bootstrap,
          remoteDir: `/root/.rainbond/rainskills/${state.operation_id}`,
          operationId: state.operation_id,
          configSha256,
          artifactSha256: driverState.artifact_sha256,
          session: bootstrapSession,
          registerChild: dependencies.registerChild,
          abortState: dependencies.abortState,
          inspectCluster: dependencies.inspectCluster,
        });
      } catch (error) {
        if (error.code !== "RAINSKILLS_HOST_CLUSTER_INTERRUPTED") throw error;
        persistDriverState({ stage: driverState.stage, status: "interrupted", signal: error.signal || "SIGINT", resumeArgv });
        return { waiting: true, interrupted: true, signal: error.signal || "SIGINT", resumeArgv };
      }
      if (reconciliation.disposition === "started") return verifyAndComplete(reconciliation.cluster);
      if (reconciliation.disposition !== "not_started") {
        return blockResume(reconciliation.reason || "cluster_execution_state_unverified");
      }
      if (driverState.stage !== "executing" && driverState.execution_approved !== true) {
        return blockResume("execution_approval_unverified");
      }
      const artifact = reuseLockedRoiArtifact({
        state: driverState,
        configPath,
        artifactPath: path.join(hostRoot, "roi"),
        stateStore,
      });
      if (!artifact) return blockResume("resume_lock_incomplete");
      return executeLockedArtifact(artifact);
    }

    const beforeConfirmation = interruptedAt("confirmation");
    if (beforeConfirmation) return beforeConfirmation;
    const summary = { ...summarizeTopology(config), configPath };
    const confirmation = await (dependencies.confirm || confirmRoiInstall)({
      summary,
      interactive: options.agentHandoff ? false : dependencies.interactive,
      yes: options.yes,
      ask: dependencies.ask,
      createPrompt: dependencies.createPrompt,
      write: dependencies.write,
      onAccepted: async () => {
        persistDriverState({
          execution_approved: true,
          resumeArgv,
          ...(options.agentHandoff ? { agent_handoff: { ...handoff, phase: "approved" } } : {}),
        });
        const artifactPath = path.join(hostRoot, "roi");
        let artifact;
        try {
          let bootstrapArch = driverState.bootstrap_arch;
          if (!bootstrapArch) {
            bootstrapArch = await (dependencies.probeArchitecture || probeRemoteArchitecture)(topology.bootstrap, {
              ...dependencies,
              session: bootstrapSession,
            });
          }
          persistDriverState({ stage: "artifact", status: "running", bootstrap_arch: bootstrapArch });
          artifact = reuseLockedRoiArtifact({
            state: driverState,
            configPath,
            artifactPath,
            stateStore,
          }) || await (dependencies.acquireArtifact || acquireRoiArtifact)({
            arch: bootstrapArch,
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
        return executeLockedArtifact(artifact);
      },
    });
    if (!confirmation.accepted) {
      persistDriverState({
        stage: "confirmation",
        status: confirmation.waiting ? "waiting_user" : "cancelled",
        ...(options.agentHandoff && confirmation.waiting
          ? { agent_handoff: { ...handoff, phase: "waiting_confirmation" } }
          : {}),
      });
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
  acquireRoiArtifact,
  atomicWriteProtectedBytes,
  confirmRoiInstall,
  createClusterConfigFromServerInput,
  createHostClusterTemplate,
  createHostServerInputTemplate,
  createProtectedBytesExclusive,
  defaultSshRunner,
  defaultTransfer,
  executeRoiInstall,
  diagnoseClusterConfig,
  hasSensitiveFields,
  importClusterConfig,
  inspectRemoteCluster,
  installHostCluster,
  parseClusterDocument,
  parseHostServerInput,
  probeRemoteArchitecture,
  probeRemoteRoiVersion,
  prepareHostSshSessions,
  probeConsole,
  readProtectedServerInput,
  readSafeClusterSource,
  reconcileHostExecution,
  redactInstallLog,
  renderHostClusterConfigPrompt,
  renderHostServerInputPrompt,
  renderHostClusterSshAuthenticationPrompt,
  renderConfirmationSummary,
  runClusterWizard,
  spawnRedactedAttached,
  reuseLockedRoiArtifact,
  serializeMinimalClusterConfig,
  summarizeTopology,
  validateClusterTopology,
  validateRoiResumeLock,
  verifyHostCluster,
};
