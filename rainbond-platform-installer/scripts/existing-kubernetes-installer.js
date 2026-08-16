"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const https = require("node:https");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline/promises");
const { spawn } = require("node:child_process");
const YAML = require("yaml");
const { createSecureStateStore } = require("./secure-state.js");
const { createWindowsSecureStateStore } = require("./windows-platform.js");

const POLICY = require("../references/installation-policy.json");
const packageVersion = require("../../package.json").version;
const CHART_ORIGIN = "https://chart.rainbond.com";
const RELEASE = "rainbond";
const NAMESPACE = "rbd-system";
const MAX_COMMAND_OUTPUT = 4 * 1024 * 1024;
const MAX_CONSOLE_PROBE_BYTES = 256 * 1024;
const NAMESPACE_OPERATION_ANNOTATION = "rainskills.goodrain.com/operation-id";
const NAMESPACE_MANAGED_LABEL = "app.kubernetes.io/managed-by";

function interruptedError(abortState) {
  return Object.assign(new Error("Kubernetes 安装已被信号中断"), {
    code: "RAINSKILLS_KUBERNETES_INTERRUPTED",
    signal: abortState?.signal || "SIGINT",
  });
}

function assertNotAborted(abortState) {
  if (abortState?.aborted) throw interruptedError(abortState);
}

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function contentIdentity(bytes) {
  return `sha256:${sha256(bytes)}:${bytes.length}`;
}

function sourceIdentity(info) {
  return `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}`;
}

function descriptorRead(filePath, { platform = process.platform, stateStore, fsImpl = fs } = {}) {
  const before = platform === "win32"
    ? stateStore?.assertSafeExternalRegularFile(filePath)
    : null;
  if (platform === "win32" && !before) throw new Error("Windows 输入文件必须通过当前用户 ACL 检查");
  const flags = fsImpl.constants.O_RDONLY | (platform === "win32" ? 0 : (fsImpl.constants.O_NOFOLLOW || 0));
  let fd;
  try {
    fd = fsImpl.openSync(filePath, flags);
  } catch (error) {
    if (["ELOOP", "EMLINK"].includes(error.code)) throw new Error("拒绝读取 symbolic link 输入文件");
    throw error;
  }
  try {
    const info = fsImpl.fstatSync(fd);
    if (!info.isFile()) throw new Error("输入必须是 regular file");
    const bytes = fsImpl.readFileSync(fd);
    if (platform === "win32") {
      if (before.fileIdentity !== contentIdentity(bytes)) throw new Error("Windows ACL identity 与打开句柄字节不匹配");
      const after = stateStore.assertSafeExternalRegularFile(filePath);
      if (after.fileIdentity !== contentIdentity(bytes)) throw new Error("Windows 输入在 ACL 检查期间发生变化");
    } else {
      if (typeof process.getuid === "function" && info.uid !== process.getuid()) throw new Error("输入文件不属于当前用户");
      if ((info.mode & 0o777) !== 0o600) throw new Error("kubeconfig/values source permissions must be 0600");
      const current = fsImpl.lstatSync(filePath);
      if (current.isSymbolicLink() || sourceIdentity(current) !== sourceIdentity(info)) throw new Error("输入文件在安全读取期间发生变化");
    }
    return bytes;
  } finally {
    fsImpl.closeSync(fd);
  }
}

function atomicWriteProtectedBytes(destinationPath, bytes, stateStore) {
  const directory = path.dirname(destinationPath);
  stateStore.ensurePrivateDirectory(directory);
  if (fs.existsSync(destinationPath) && fs.lstatSync(destinationPath).isSymbolicLink()) throw new Error("拒绝覆盖 symbolic link");
  const temporary = path.join(directory, `.${path.basename(destinationPath)}.${process.pid}.${crypto.randomBytes(8).toString("hex")}`);
  let fd;
  try {
    fd = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  try {
    if (process.platform !== "win32") fs.chmodSync(temporary, 0o600);
    stateStore.protectRegularFile(temporary);
    fs.renameSync(temporary, destinationPath);
    stateStore.protectRegularFile(destinationPath);
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch (cleanup) { if (cleanup.code !== "ENOENT") throw cleanup; }
    throw error;
  }
  return destinationPath;
}

function importProtectedSource(sourcePath, destinationPath, stateStore, { platform = process.platform } = {}) {
  const source = path.resolve(String(sourcePath || ""));
  const destination = path.resolve(destinationPath);
  if (!source || source === destination) throw new Error("输入源与受保护目标不能相同");
  stateStore.assertSafeExternalRegularFile(source);
  const bytes = descriptorRead(source, { stateStore, platform });
  atomicWriteProtectedBytes(destination, bytes, stateStore);
  return { path: destination, sha256: sha256(bytes) };
}

function prepareProtectedInputs({ operationDir, kubeconfigSource, valuesSource = "", context, stateStore, platform = process.platform }) {
  const lockedContext = String(context || "").trim();
  if (!lockedContext || /[\u0000-\u001f\u007f]/u.test(lockedContext) || lockedContext.startsWith("-")) {
    throw new Error("必须显式提供有效 Kubernetes context");
  }
  stateStore.ensurePrivateDirectory(operationDir);
  const kubeconfig = importProtectedSource(kubeconfigSource, path.join(operationDir, "kubeconfig"), stateStore, { platform });
  const values = valuesSource
    ? importProtectedSource(valuesSource, path.join(operationDir, "values.yaml"), stateStore, { platform })
    : { path: null, sha256: null };
  return {
    kubeconfigPath: kubeconfig.path,
    kubeconfigSha256: kubeconfig.sha256,
    valuesPath: values.path,
    valuesSha256: values.sha256,
    context: lockedContext,
  };
}

function kubectlArgs(target) {
  return ["--kubeconfig", target.kubeconfigPath, "--context", target.context];
}

function helmArgs(target) {
  return ["--kubeconfig", target.kubeconfigPath, "--kube-context", target.context];
}

function assertCommandSucceeded(result, label) {
  const code = result?.code ?? result?.status ?? 0;
  if (code !== 0) throw new Error(`${label}失败（exit ${code}）`);
  return String(result?.stdout || "");
}

function parseJsonOutput(result, label) {
  const output = assertCommandSucceeded(result, label);
  try { return JSON.parse(output); } catch { throw new Error(`${label}返回了无效 JSON`); }
}

function parseOptionalJsonOutput(result, label) {
  const output = assertCommandSucceeded(result, label);
  if (!output.trim()) return null;
  try { return JSON.parse(output); } catch { throw new Error(`${label}返回了无效 JSON`); }
}

function normalizeApiOrigin(server) {
  let url;
  try { url = new URL(String(server || "")); } catch { throw new Error("context API server 无效"); }
  if (url.protocol !== "https:" || !url.hostname) throw new Error("context API server 必须使用 HTTPS");
  return url.origin;
}

async function queryClusterIdentity({ kubeconfigPath, context, runner = runCommand }) {
  const target = { kubeconfigPath, context };
  const view = parseJsonOutput(await runner("kubectl", [...kubectlArgs(target), "config", "view", "--minify", "-o", "json"]), "读取 context");
  const server = view?.clusters?.[0]?.cluster?.server;
  const namespace = parseJsonOutput(await runner("kubectl", [...kubectlArgs(target), "get", "namespace", "kube-system", "-o", "json"]), "读取 cluster UID");
  const clusterUid = String(namespace?.metadata?.uid || "");
  if (!clusterUid || /[\u0000-\u001f\u007f]/u.test(clusterUid)) throw new Error("目标集群缺少稳定 UID");
  return { apiOrigin: normalizeApiOrigin(server), clusterUid };
}

function safeDriverState(value) {
  return {
    schema: "rainskills.existing-kubernetes-state.v1",
    version: 1,
    operation_id: value.operationId || value.operation_id,
    stage: value.stage || "identity",
    status: value.status || "running",
    kubeconfig_path: value.kubeconfigPath,
    kubeconfig_sha256: value.kubeconfigSha256,
    values_path: value.valuesPath || null,
    values_sha256: value.valuesSha256 || null,
    context: value.context,
    api_origin: value.apiOrigin,
    cluster_uid: value.clusterUid,
    chart_path: value.chartPath || null,
    chart_origin: value.chartOrigin || null,
    chart_name: value.chartName || null,
    chart_version: value.chartVersion || null,
    chart_sha256: value.chartSha256 || null,
    chart_partial_path: value.chartPartialPath || null,
    chart_checksum_published: value.chartChecksumPublished === true,
    chart_provenance_published: value.chartProvenancePublished === true,
    chart_provenance_verified: value.chartProvenanceVerified === true,
    chart_provenance_path: value.chartProvenancePath || null,
    chart_provenance_partial_path: value.chartProvenancePartialPath || null,
    chart_provenance_sha256: value.chartProvenanceSha256 || null,
    updated_at: new Date().toISOString(),
  };
}

function semverTuple(value) {
  const match = String(value || "").match(/v?(\d+)\.(\d+)(?:\.(\d+))?/);
  return match ? match.slice(1).map((part) => Number(part || 0)) : null;
}

function versionAtLeast(value, required) {
  const actual = semverTuple(value);
  const minimum = semverTuple(required);
  if (!actual || !minimum) return false;
  for (let index = 0; index < 3; index += 1) {
    if (actual[index] !== minimum[index]) return actual[index] > minimum[index];
  }
  return true;
}

function evaluateKubernetesPreflight(facts) {
  const blockers = [];
  const add = (category, message) => blockers.push({ category, message });
  if (!versionAtLeast(facts.kubernetesVersion, "1.24.0")) add("kubernetes_version", "Kubernetes 必须为 1.24 或更高版本");
  if (!versionAtLeast(facts.helmVersion, "3.0.0")) add("helm_version", "需要 Helm 3");
  if (!Array.isArray(facts.storageClasses) || facts.storageClasses.length === 0) add("storage_class_missing", "集群缺少 StorageClass");
  for (const node of facts.nodes || []) {
    if (node.ready !== true) add("node_not_ready", `${node.name || "node"} 未 Ready`);
    if (!String(node.runtime || "").startsWith("containerd://")) add("containerd_required", `${node.name || "node"} 未使用 containerd；请手动处理，安装器不会修改或重启运行时`);
    if (node.runtimePathReady !== true) add("runtime_path_unavailable", `${node.name || "node"} 缺少只读 kubelet runtime image/container filesystem 可用证据；请人工检查 containerd 数据目录后重试`);
    if (Number(node.cpuCores || 0) < 2 || Number(node.memoryBytes || 0) < 4 * 1024 ** 3) add("node_resources", `${node.name || "node"} 资源低于 2 CPU / 4 GiB`);
    if ((node.occupiedPorts || []).length > 0) add("entry_port_conflict", `${node.name || "node"} 入口端口冲突`);
  }
  if ((facts.gatewayNodes || []).some((name) => !(facts.nodes || []).some((node) => node.name === name))) add("gateway_node_invalid", "gateway 节点引用无效");
  if ((facts.chaosNodes || []).some((name) => !(facts.nodes || []).some((node) => node.name === name))) add("chaos_node_invalid", "chaos 节点引用无效");
  if (facts.chartReachable !== true) add("chart_source_unreachable", "Helm chart 来源不可访问");
  if (facts.imageSourceReachable !== true) add("image_source_unreachable", "Rainbond 镜像来源不可访问");
  if (facts.namespaceExists) add("namespace_conflict", "rbd-system 已存在，拒绝覆盖");
  if (facts.releaseExists) add("release_conflict", "rainbond Helm release 已存在，拒绝覆盖");
  if ((facts.rainbondCrds || []).length > 0) add("crd_conflict", "已存在 Rainbond CRD，拒绝覆盖");
  if ((facts.ingressConflicts || []).length > 0) add("ingress_conflict", "已有 Ingress/ingress-controller 与入口冲突");
  if ((facts.hostPortConflicts || []).length > 0) add("entry_port_conflict", "已有工作负载占用 Rainbond 入口 hostPort");
  return { blockers, facts };
}

function kubernetesPreflightPlan(target) {
  const k = kubectlArgs(target);
  const h = helmArgs(target);
  return [
    { command: "kubectl", args: [...k, "version", "-o", "json"] },
    { command: "helm", args: [...h, "version", "--template", "{{.Version}}"] },
    { command: "kubectl", args: [...k, "get", "nodes", "-o", "json"] },
    { command: "kubectl", args: [...k, "get", "storageclass", "-o", "json"] },
    { command: "kubectl", args: [...k, "get", "namespace", NAMESPACE, "--ignore-not-found", "-o", "json"] },
    { command: "helm", args: [...h, "list", "-n", NAMESPACE, "-o", "json"] },
    { command: "kubectl", args: [...k, "get", "crd", "-o", "json"] },
    { command: "kubectl", args: [...k, "get", "ingress,pods,services", "-A", "-o", "json"] },
  ];
}

function nodeFacts(item, runtimeSummary) {
  const ready = (item.status?.conditions || []).some((condition) => condition.type === "Ready" && condition.status === "True");
  const cpu = String(item.status?.allocatable?.cpu || item.status?.capacity?.cpu || "0");
  const memory = String(item.status?.allocatable?.memory || item.status?.capacity?.memory || "0");
  const cpuCores = cpu.endsWith("m") ? Number(cpu.slice(0, -1)) / 1000 : Number(cpu);
  const units = { Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, Ti: 1024 ** 4 };
  const memoryMatch = memory.match(/^(\d+(?:\.\d+)?)(Ki|Mi|Gi|Ti)?$/);
  const memoryBytes = memoryMatch ? Number(memoryMatch[1]) * (units[memoryMatch[2]] || 1) : 0;
  const explicitlyUnavailable = item.metadata?.labels?.["rainskills.goodrain.com/runtime-path-ready"] === "false";
  const runtimeFs = runtimeSummary?.node?.runtime?.containerFs || runtimeSummary?.node?.runtime?.imageFs;
  const runtimePathReady = !explicitlyUnavailable
    && Number(runtimeFs?.capacityBytes || 0) > 0
    && Number(runtimeFs?.availableBytes ?? -1) >= 0;
  return { name: item.metadata?.name, ready, runtime: item.status?.nodeInfo?.containerRuntimeVersion || "", runtimePathReady, cpuCores, memoryBytes, occupiedPorts: [] };
}

function analyzeWorkloadConflicts(items) {
  const required = new Set([80, 443, 6060, 7070]);
  const ingressConflicts = [];
  const hostPortConflicts = [];
  const ingressTargetsRainbond = (item) => {
    if (String(item.metadata?.namespace || "default") !== NAMESPACE) return false;
    const rainbondEntryServices = new Set(["rbd-app-ui", "rbd-gateway", "rainbond"]);
    const services = [];
    const backendName = (backend) => backend?.service?.name || backend?.serviceName || "";
    services.push(backendName(item.spec?.defaultBackend || item.spec?.backend));
    for (const rule of item.spec?.rules || []) {
      for (const route of rule.http?.paths || []) services.push(backendName(route.backend));
    }
    return services.some((name) => rainbondEntryServices.has(String(name)));
  };
  for (const item of items || []) {
    const name = String(item.metadata?.name || "");
    const namespace = String(item.metadata?.namespace || "default");
    if (item.kind === "Ingress" && ingressTargetsRainbond(item)) {
      ingressConflicts.push({ kind: item.kind, namespace, name });
    }
    if (item.kind === "Pod") {
      for (const container of item.spec?.containers || []) {
        for (const port of container.ports || []) {
          if (required.has(Number(port.hostPort))) hostPortConflicts.push({ source: "hostPort", namespace, name, port: Number(port.hostPort) });
          if (item.spec?.hostNetwork === true && required.has(Number(port.containerPort))) hostPortConflicts.push({ source: "hostNetwork", namespace, name, port: Number(port.containerPort) });
        }
      }
    }
    if (item.kind === "Service" && item.spec?.type === "NodePort") {
      for (const port of item.spec?.ports || []) {
        if (required.has(Number(port.nodePort))) {
          hostPortConflicts.push({ source: "Service", serviceType: item.spec.type, namespace, name, port: Number(port.port), nodePort: Number(port.nodePort || 0) });
        }
      }
    }
  }
  return { ingressConflicts, hostPortConflicts };
}

async function defaultReachability({ abortState } = {}) {
  const probe = async (url, accepted) => {
    try {
      const result = await defaultHttpsRequest(url, { maximumBytes: 4 * 1024 * 1024, abortState });
      assertNotAborted(abortState);
      return accepted(result.statusCode);
    } catch (error) {
      if (error.code === "RAINSKILLS_KUBERNETES_INTERRUPTED") throw error;
      return false;
    }
  };
  const [chartReachable, imageSourceReachable] = await Promise.all([
    probe(`${CHART_ORIGIN}/index.yaml`, (status) => status === 200),
    probe("https://registry.cn-hangzhou.aliyuncs.com/v2/", (status) => status >= 200 && status < 500),
  ]);
  return { chartReachable, imageSourceReachable };
}

function selectedNodesFromValues(valuesPath) {
  if (!valuesPath) return { gatewayNodes: [], chaosNodes: [] };
  let value;
  try { value = YAML.parse(fs.readFileSync(valuesPath, "utf8")); } catch { throw new Error("受保护 values YAML 无效"); }
  const found = { gatewayNodes: [], chaosNodes: [] };
  const walk = (child) => {
    if (!child || typeof child !== "object") return;
    if (Array.isArray(child)) { child.forEach(walk); return; }
    for (const [key, nested] of Object.entries(child)) {
      const normalized = key.replace(/[-_]/g, "").toLowerCase();
      if (["gatewaynodes", "gatewaynodenames", "rbdgatewaynodes"].includes(normalized) && Array.isArray(nested)) found.gatewayNodes.push(...nested.map(String));
      else if (["chaosnodes", "chaosnodenames", "rbdchaosnodes"].includes(normalized) && Array.isArray(nested)) found.chaosNodes.push(...nested.map(String));
      walk(nested);
    }
  };
  walk(value);
  return { gatewayNodes: [...new Set(found.gatewayNodes)], chaosNodes: [...new Set(found.chaosNodes)] };
}

async function collectKubernetesPreflight(target, { runner = runCommand, assertIdentity = async () => {}, reachability = async () => ({ chartReachable: true, imageSourceReachable: true }) } = {}) {
  const results = [];
  for (const step of kubernetesPreflightPlan(target)) {
    await assertIdentity();
    results.push(await runner(step.command, step.args));
    await assertIdentity();
  }
  const version = parseJsonOutput(results[0], "kubectl version");
  const helmVersion = assertCommandSucceeded(results[1], "helm version");
  const nodes = parseJsonOutput(results[2], "读取节点");
  const storage = parseJsonOutput(results[3], "读取 StorageClass");
  const namespaceText = assertCommandSucceeded(results[4], "检查 namespace").trim();
  const releases = parseJsonOutput(results[5], "检查 Helm release");
  const crds = parseJsonOutput(results[6], "检查 CRD");
  const workloads = parseJsonOutput(results[7], "检查入口冲突");
  const items = workloads.items || [];
  const runtimeSummaries = new Map();
  for (const item of nodes.items || []) {
    const name = String(item.metadata?.name || "");
    let summary = null;
    await assertIdentity();
    try {
      summary = parseJsonOutput(await runner("kubectl", [...kubectlArgs(target), "get", "--raw", `/api/v1/nodes/${encodeURIComponent(name)}/proxy/stats/summary`]), `读取节点 ${name} runtime filesystem`);
    } catch {
      summary = null;
    }
    await assertIdentity();
    runtimeSummaries.set(name, summary);
  }
  const conflicts = analyzeWorkloadConflicts(items);
  const reachable = await reachability();
  const selectedNodes = selectedNodesFromValues(target.valuesPath);
  return evaluateKubernetesPreflight({
    kubernetesVersion: version.serverVersion?.gitVersion || version.serverVersion?.major + "." + version.serverVersion?.minor,
    helmVersion, nodes: (nodes.items || []).map((item) => nodeFacts(item, runtimeSummaries.get(String(item.metadata?.name || "")))), storageClasses: (storage.items || []).map((item) => item.metadata?.name),
    ...selectedNodes, ...reachable, namespaceExists: Boolean(namespaceText),
    releaseExists: (releases || []).some((item) => item.name === RELEASE),
    rainbondCrds: (crds.items || []).filter((item) => /rainbond|goodrain/i.test(item.metadata?.name || "")).map((item) => item.metadata?.name),
    ...conflicts,
  });
}

function defaultHttpsRequest(url, { maximumBytes = 2 * 1024 * 1024, abortState } = {}) {
  return new Promise((resolve, reject) => {
    let response = null; let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true; clearInterval(abortPoll); callback(value);
    };
    const request = https.get(url, { headers: { "User-Agent": "rainskills-kubernetes-installer" }, timeout: 30_000 }, (incoming) => {
      response = incoming;
      const chunks = []; let total = 0;
      incoming.on("data", (chunk) => {
        total += chunk.length;
        if (total > maximumBytes) { request.destroy(new Error("响应大小超过安全上限")); return; }
        chunks.push(chunk);
      });
      incoming.on("end", () => finish(resolve, { statusCode: incoming.statusCode, headers: incoming.headers, body: Buffer.concat(chunks) }));
      incoming.on("error", (error) => finish(reject, abortState?.aborted ? interruptedError(abortState) : error));
    });
    const abortPoll = setInterval(() => {
      if (!abortState?.aborted) return;
      response?.destroy(interruptedError(abortState));
      request.destroy(interruptedError(abortState));
    }, 25);
    abortPoll.unref?.();
    request.on("timeout", () => request.destroy(new Error("chart 请求超时")));
    request.on("error", (error) => finish(reject, abortState?.aborted ? interruptedError(abortState) : error));
    if (abortState?.aborted) request.destroy(interruptedError(abortState));
  });
}

async function fetchBoundedHttps(initialUrl, { request = defaultHttpsRequest, maximumBytes = 128 * 1024 * 1024, maxRedirects = 3, allowedFinalPath = null, allowNotFound = false, abortState } = {}) {
  let current = new URL(initialUrl);
  if (current.origin !== CHART_ORIGIN || current.protocol !== "https:") throw new Error("chart 来源 origin 不受信任");
  for (let redirects = 0; ; redirects += 1) {
    assertNotAborted(abortState);
    const result = await request(current.toString(), { maximumBytes, abortState });
    assertNotAborted(abortState);
    if ([301, 302, 303, 307, 308].includes(result.statusCode)) {
      if (redirects >= maxRedirects) throw new Error("chart redirect 跳转次数超过上限");
      const next = new URL(String(result.headers?.location || ""), current);
      if (next.protocol !== "https:" || next.origin !== CHART_ORIGIN) throw new Error("chart redirect 必须保持同源 origin");
      if (allowedFinalPath && !allowedFinalPath.test(next.pathname)) throw new Error("chart redirect 最终路径不受信任");
      current = next; continue;
    }
    if (allowNotFound && result.statusCode === 404) return null;
    if (result.statusCode !== 200) throw new Error(`chart 下载返回 HTTP ${result.statusCode}`);
    const body = Buffer.from(result.body || Buffer.alloc(0));
    if (body.length === 0 || body.length > maximumBytes) throw new Error("chart 响应大小无效或超过上限");
    if (allowedFinalPath && !allowedFinalPath.test(current.pathname)) throw new Error("chart 最终路径不受信任");
    return { body, finalUrl: current.toString() };
  }
}

function chartEntry(indexBytes, exactVersion) {
  let index;
  try { index = YAML.parse(indexBytes.toString("utf8")); } catch { throw new Error("chart index YAML 无效"); }
  const entries = index?.entries?.rainbond;
  if (!Array.isArray(entries) || entries.length === 0) throw new Error("chart index 缺少 rainbond/rainbond");
  const selected = exactVersion ? entries.find((item) => String(item.version) === exactVersion) : entries[0];
  if (!selected || !/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(String(selected.version || ""))) throw new Error("必须解析并锁定 exact chart version");
  const rawUrl = Array.isArray(selected.urls) ? selected.urls[0] : "";
  const url = new URL(rawUrl, `${CHART_ORIGIN}/`);
  if (url.origin !== CHART_ORIGIN || url.protocol !== "https:") throw new Error("chart package origin 不受信任");
  let publishedDigest = null;
  if (selected.digest !== undefined && selected.digest !== null && selected.digest !== "") {
    publishedDigest = String(selected.digest).toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(publishedDigest)) throw new Error("chart index published checksum 格式无效");
  }
  let provenanceUrl = null;
  if (selected.provenance) {
    const provenance = new URL(String(selected.provenance), `${CHART_ORIGIN}/`);
    if (provenance.origin !== CHART_ORIGIN || provenance.protocol !== "https:" || !/\.prov$/.test(provenance.pathname)) throw new Error("chart provenance 来源或路径不受信任");
    provenanceUrl = provenance.toString();
  }
  return { version: String(selected.version), url: url.toString(), publishedDigest, provenanceUrl };
}

async function acquireChartPackage({ operationDir, exactVersion = "", stateStore, request = defaultHttpsRequest, maximumBytes = POLICY.helm?.max_bytes || 134217728, maxRedirects = POLICY.helm?.max_redirects || 3, abortState, persistLock, verifyProvenance }) {
  if (typeof persistLock !== "function") throw new Error("chart 发布前必须提供 durable persistLock");
  stateStore.ensurePrivateDirectory(operationDir);
  const index = await fetchBoundedHttps(`${CHART_ORIGIN}/index.yaml`, { request, maximumBytes: 4 * 1024 * 1024, maxRedirects, allowedFinalPath: /\/index\.yaml$/, abortState });
  const entry = chartEntry(index.body, exactVersion);
  const chart = await fetchBoundedHttps(entry.url, { request, maximumBytes, maxRedirects, allowedFinalPath: /\.tgz$/, abortState });
  assertNotAborted(abortState);
  const actualDigest = sha256(chart.body);
  if (entry.publishedDigest && entry.publishedDigest !== actualDigest) throw new Error("chart published checksum 与下载字节不匹配");
  const destination = path.join(operationDir, `rainbond-${entry.version}.tgz`);
  const partialPath = path.join(operationDir, `.rainbond-${entry.version}.tgz.partial`);
  atomicWriteProtectedBytes(partialPath, chart.body, stateStore);
  let provenance = {};
  const provenanceUrl = entry.provenanceUrl || `${entry.url}.prov`;
  const downloadedProvenance = await fetchBoundedHttps(provenanceUrl, { request, maximumBytes: 4 * 1024 * 1024, maxRedirects, allowedFinalPath: /\.prov$/, allowNotFound: true, abortState });
  if (downloadedProvenance) {
    if (typeof verifyProvenance !== "function") throw new Error("chart 发布了 provenance，但缺少受信任验证器");
    const provenancePath = `${destination}.prov`;
    const provenancePartialPath = `${partialPath}.prov`;
    atomicWriteProtectedBytes(provenancePartialPath, downloadedProvenance.body, stateStore);
    provenance = { provenancePublished: true, provenanceVerified: false, provenancePath, provenancePartialPath, provenanceSha256: sha256(downloadedProvenance.body) };
  }
  const lock = { path: destination, partialPath, origin: CHART_ORIGIN, name: "rainbond/rainbond", version: entry.version, sha256: actualDigest, finalUrl: chart.finalUrl, checksumPublished: Boolean(entry.publishedDigest), ...provenance };
  await persistLock(lock);
  assertNotAborted(abortState);
  return verifyAndResumeLockedChart(lock, { stateStore, verifyProvenance, persistLock, abortState });
}

function resumeLockedChart(lock, stateStore) {
  if (!lock || lock.origin !== CHART_ORIGIN || lock.name !== "rainbond/rainbond" || !/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(String(lock.version || ""))) {
    throw new Error("chart 恢复锁无效");
  }
  if (fs.existsSync(lock.path)) {
    stateStore.assertProtectedRegularFile(lock.path);
    if (sha256(fs.readFileSync(lock.path)) !== lock.sha256) throw new Error("chart bytes 发生变化，拒绝恢复");
  } else {
    if (!lock.partialPath || !fs.existsSync(lock.partialPath)) throw new Error("已锁定 chart partial 缺失，拒绝重新下载或替换字节");
    stateStore.assertProtectedRegularFile(lock.partialPath);
    if (sha256(fs.readFileSync(lock.partialPath)) !== lock.sha256) throw new Error("chart partial digest 与恢复锁不匹配");
    fs.linkSync(lock.partialPath, lock.path);
    try {
      stateStore.protectRegularFile(lock.path);
      const partial = fs.lstatSync(lock.partialPath);
      const published = fs.lstatSync(lock.path);
      if (partial.dev !== published.dev || partial.ino !== published.ino) throw new Error("chart crash-safe publish identity 不匹配");
      if (sha256(fs.readFileSync(lock.path)) !== lock.sha256) throw new Error("chart publish 后 digest 变化");
      fs.unlinkSync(lock.partialPath);
    } catch (error) {
      try { fs.unlinkSync(lock.path); } catch (cleanup) { if (cleanup.code !== "ENOENT") throw cleanup; }
      throw error;
    }
  }
  if (lock.provenancePublished) {
    if (lock.provenanceVerified !== true) throw new Error("chart provenance 尚未完成 durable verification，拒绝发布");
    if (fs.existsSync(lock.provenancePath)) {
      stateStore.assertProtectedRegularFile(lock.provenancePath);
      if (sha256(fs.readFileSync(lock.provenancePath)) !== lock.provenanceSha256) throw new Error("chart provenance bytes 发生变化");
    } else {
      if (!lock.provenancePartialPath || !fs.existsSync(lock.provenancePartialPath)) throw new Error("已锁定 chart provenance partial 缺失");
      stateStore.assertProtectedRegularFile(lock.provenancePartialPath);
      if (sha256(fs.readFileSync(lock.provenancePartialPath)) !== lock.provenanceSha256) throw new Error("chart provenance digest 不匹配");
      fs.linkSync(lock.provenancePartialPath, lock.provenancePath);
      stateStore.protectRegularFile(lock.provenancePath);
      fs.unlinkSync(lock.provenancePartialPath);
    }
  }
  return { ...lock, recoveredPartial: true, reused: fs.existsSync(lock.path) };
}

function lockedChartSource(lock, stateStore, finalKey, partialKey, digestKey, label) {
  const finalPath = lock[finalKey];
  const partialPath = lock[partialKey];
  const selected = finalPath && fs.existsSync(finalPath) ? finalPath : partialPath;
  if (!selected || !fs.existsSync(selected)) throw new Error(`已锁定 ${label} partial 缺失`);
  stateStore.assertProtectedRegularFile(selected);
  if (sha256(fs.readFileSync(selected)) !== lock[digestKey]) throw new Error(`${label} digest/bytes 与 durable lock 不匹配`);
  return selected;
}

async function verifyAndResumeLockedChart(lock, { stateStore, verifyProvenance, persistLock, abortState } = {}) {
  const chartPath = lockedChartSource(lock, stateStore, "path", "partialPath", "sha256", "chart");
  let current = { ...lock };
  if (current.provenancePublished) {
    const provenancePath = lockedChartSource(current, stateStore, "provenancePath", "provenancePartialPath", "provenanceSha256", "chart provenance");
    if (current.provenanceVerified !== true) {
      if (typeof verifyProvenance !== "function" || typeof persistLock !== "function") throw new Error("恢复 provenance verification 需要验证器和 durable persistLock");
      assertNotAborted(abortState);
      await verifyProvenance({ chartPath, provenancePath });
      assertNotAborted(abortState);
      current = { ...current, provenanceVerified: true };
      await persistLock(current);
      assertNotAborted(abortState);
    }
  }
  return resumeLockedChart(current, stateStore);
}

function validateResumeBytes(lock, stateStore) {
  const checks = [
    ["kubeconfig", lock.kubeconfigPath, lock.kubeconfigSha256],
    ["values", lock.valuesPath, lock.valuesSha256],
    ["chart", lock.chartPath, lock.chartSha256],
  ];
  for (const [label, filePath, expected] of checks) {
    if (!filePath && !expected) continue;
    if (!filePath || !expected || !fs.existsSync(filePath)) throw new Error(`${label} 恢复锁不完整`);
    if (stateStore) stateStore.assertProtectedRegularFile(filePath);
    const actual = sha256(fs.readFileSync(filePath));
    if (actual !== expected) throw new Error(`${label} bytes 发生变化，拒绝恢复`);
  }
  return true;
}

async function assertClusterIdentity(lock, { runner = runCommand } = {}) {
  validateResumeBytes(lock);
  const current = await queryClusterIdentity({ kubeconfigPath: lock.kubeconfigPath, context: lock.context, runner });
  if (current.apiOrigin !== lock.apiOrigin || current.clusterUid !== lock.clusterUid) throw new Error("Kubernetes identity drift：API server 或 cluster UID 已变化");
  return current;
}

async function runHelmValidation(lock, { runner = runCommand, assertIdentity = () => assertClusterIdentity(lock, { runner }) } = {}) {
  const values = lock.valuesPath ? ["--values", lock.valuesPath] : [];
  const phases = [
    ["lint", lock.chartPath, ...values],
    ["template", RELEASE, lock.chartPath, "--namespace", NAMESPACE, ...values],
    ["install", RELEASE, lock.chartPath, "--namespace", NAMESPACE, "--create-namespace", "--dry-run", ...values],
  ];
  for (const args of phases) {
    await assertIdentity();
    assertCommandSucceeded(await runner("helm", [...helmArgs(lock), ...args]), `helm ${args[0]}`);
    await assertIdentity();
  }
}

function renderConfirmationSummary(summary) {
  return [
    "\n已有 Kubernetes 安装计划",
    `Context：${summary.context}`,
    `Cluster UID：${summary.clusterUid}`,
    `API：${summary.apiOrigin}`,
    `Chart：rainbond/rainbond ${summary.chartVersion} (${summary.chartSha256})`,
    `Values：${summary.valuesPath || "未提供"}${summary.valuesSha256 ? ` (${summary.valuesSha256})` : ""}`,
    `Namespace / Release：${summary.namespace} / ${summary.release}`,
    `冲突：${summary.blockers?.length ? summary.blockers.map((item) => item.category).join(", ") : "无"}`,
    `节点级手动变更：${summary.manualChanges?.length ? summary.manualChanges.join("；") : "无"}`,
    "将创建 Rainbond 的命名空间、CRD、控制器和应用运行组件。",
  ].join("\n") + "\n";
}

async function confirmHelmInstall({ summary, yes = false, interactive = process.stdin.isTTY && process.stdout.isTTY, ask, write = (value) => process.stdout.write(value) }) {
  write(renderConfirmationSummary(summary));
  if ((summary.blockers || []).length > 0) throw new Error(`Kubernetes 预检存在阻断项：${summary.blockers.map((item) => item.category).join(", ")}`);
  if (yes) return { accepted: true };
  if (!interactive) {
    write("[RAINSKILLS_USER_CONFIRMATION_REQUIRED:existing_kubernetes_install]\ndry-run 已通过；非交互安装请重新执行并显式添加 --yes。\n");
    return { accepted: false, waiting: true };
  }
  const answer = String(await ask("dry-run 已通过，确认安装到上述集群？输入 yes 继续，no 拒绝，cancel 取消：")).trim().toLowerCase();
  if (answer === "yes") return { accepted: true };
  if (answer === "cancel") return { accepted: false, cancelled: true };
  return { accepted: false };
}

async function executeHelmInstall(lock, { operationId, runner = runCommand, assertIdentity = () => assertClusterIdentity(lock, { runner }), assertOwnership = async () => {} } = {}) {
  await assertIdentity();
  const values = lock.valuesPath ? ["--values", lock.valuesPath] : [];
  const ownership = String(operationId || "");
  if (!ownership || /[\u0000-\u001f\u007f]/u.test(ownership)) throw new Error("Helm install 缺少安全 operation ownership");
  const args = [...helmArgs(lock), "install", RELEASE, lock.chartPath, "--create-namespace", "-n", NAMESPACE, "--description", `rainskills-operation=${ownership}`, ...values];
  await assertOwnership();
  assertCommandSucceeded(await runner("helm", args), "helm install");
  await assertOwnership();
  await assertIdentity();
  return { command: "helm", args };
}

function namespaceManifestBytes(operationId) {
  const owner = String(operationId || "");
  if (!owner || owner.length > 128 || /[\u0000-\u001f\u007f]/u.test(owner)) throw new Error("Namespace operation ownership 无效");
  return Buffer.from(`${JSON.stringify({
    apiVersion: "v1",
    kind: "Namespace",
    metadata: {
      name: NAMESPACE,
      labels: { [NAMESPACE_MANAGED_LABEL]: "rainskills" },
      annotations: { [NAMESPACE_OPERATION_ANNOTATION]: owner },
    },
  }, null, 2)}\n`);
}

function prepareNamespaceManifest(operationDir, operationId, stateStore) {
  const manifestPath = path.join(operationDir, "namespace.json");
  const expected = namespaceManifestBytes(operationId);
  if (fs.existsSync(manifestPath)) {
    stateStore.assertProtectedRegularFile(manifestPath);
    if (!fs.readFileSync(manifestPath).equals(expected)) throw new Error("受保护 Namespace manifest 与当前 operation 不匹配");
  } else {
    atomicWriteProtectedBytes(manifestPath, expected, stateStore);
  }
  return { path: manifestPath, sha256: sha256(expected) };
}

function assertOwnedNamespace(resource, { operationId, expectedUid = null } = {}) {
  const metadata = resource?.metadata || {};
  const uid = String(metadata.uid || "");
  const owner = metadata.annotations?.[NAMESPACE_OPERATION_ANNOTATION];
  const managedBy = metadata.labels?.[NAMESPACE_MANAGED_LABEL];
  if (metadata.name !== NAMESPACE || !uid || owner !== operationId || managedBy !== "rainskills") {
    throw new Error("rbd-system Namespace ownership 不属于当前 operation，拒绝 adopt");
  }
  if (expectedUid && uid !== expectedUid) throw new Error("rbd-system Namespace UID 与恢复状态不匹配");
  return { uid, operationId: owner };
}

async function inspectInstallConflicts(lock, { runner, assertIdentity }) {
  const lockedRun = async (command, args) => {
    await assertIdentity();
    const result = await runner(command, args);
    await assertIdentity();
    return result;
  };
  const namespace = parseOptionalJsonOutput(await lockedRun("kubectl", [...kubectlArgs(lock), "get", "namespace", NAMESPACE, "--ignore-not-found", "-o", "json"]), "检查 rbd-system Namespace");
  const releases = parseJsonOutput(await lockedRun("helm", [...helmArgs(lock), "list", "-n", NAMESPACE, "-o", "json"]), "重新检查 Helm release");
  const crds = parseJsonOutput(await lockedRun("kubectl", [...kubectlArgs(lock), "get", "crd", "-o", "json"]), "重新检查 Rainbond CRD");
  if (!Array.isArray(releases) || !Array.isArray(crds.items || [])) throw new Error("安装冲突检查返回结构无效");
  return {
    namespace,
    releaseConflict: releases.some((item) => item.name === RELEASE),
    crdConflicts: (crds.items || []).filter((item) => /rainbond|goodrain/i.test(item.metadata?.name || "")).map((item) => item.metadata?.name),
  };
}

function assertNoInstallConflicts(snapshot) {
  if (snapshot.releaseConflict) throw new Error("rainbond Helm release 在确认后出现冲突，拒绝覆盖");
  if (snapshot.crdConflicts.length > 0) throw new Error("Rainbond CRD 在确认后出现冲突，拒绝覆盖");
}

async function inspectOwnedNamespace(lock, { operationId, expectedUid = null, allowMissing = false, runner, assertIdentity }) {
  await assertIdentity();
  const resource = parseOptionalJsonOutput(await runner("kubectl", [...kubectlArgs(lock), "get", "namespace", NAMESPACE, "--ignore-not-found", "-o", "json"]), "复核 rbd-system Namespace");
  await assertIdentity();
  if (!resource) {
    if (allowMissing && !expectedUid) return null;
    throw new Error("当前 operation 拥有的 rbd-system Namespace 已缺失");
  }
  return assertOwnedNamespace(resource, { operationId, expectedUid });
}

async function claimNamespaceForInstall(lock, {
  operationDir, operationId, expectedUid = null, stateStore, runner, assertIdentity, persist,
}) {
  const before = await inspectInstallConflicts(lock, { runner, assertIdentity });
  let ownership = null;
  if (before.namespace) ownership = assertOwnedNamespace(before.namespace, { operationId, expectedUid });
  else if (expectedUid) throw new Error("当前 operation 拥有的 rbd-system Namespace 已缺失");
  assertNoInstallConflicts(before);
  const manifest = prepareNamespaceManifest(operationDir, operationId, stateStore);
  if (!ownership) {
    await assertIdentity();
    assertCommandSucceeded(await runner("kubectl", [...kubectlArgs(lock), "create", "-f", manifest.path]), "kubectl create Namespace");
    await assertIdentity();
    ownership = await inspectOwnedNamespace(lock, { operationId, runner, assertIdentity });
  }
  persist({
    stage: "namespace", status: "running", installation_confirmed: true,
    namespace_uid: ownership.uid, namespace_owner_operation_id: operationId,
    namespace_manifest_path: manifest.path,
    namespace_manifest_sha256: manifest.sha256,
  });
  const after = await inspectInstallConflicts(lock, { runner, assertIdentity });
  assertOwnedNamespace(after.namespace, { operationId, expectedUid: ownership.uid });
  assertNoInstallConflicts(after);
  return ownership;
}

async function inspectReleaseRecoveryState(lock, { operationId, runner = runCommand } = {}) {
  const commandResult = await runner("helm", [...helmArgs(lock), "status", RELEASE, "-n", NAMESPACE, "-o", "json"]);
  const code = commandResult?.code ?? commandResult?.status ?? 0;
  if (code !== 0) {
    if (/release(?::|\s)+(?:\"?rainbond\"?\s+)?not found|release not found/i.test(String(commandResult?.stderr || ""))) {
      return { presence: "absent", status: "absent", revision: null };
    }
    throw new Error(`检查 Helm release status 失败（exit ${code}）`);
  }
  const result = parseJsonOutput(commandResult, "检查 Helm release ownership");
  const revision = Number(result.version);
  const owned = result.name === RELEASE
    && result.namespace === NAMESPACE
    && result.info?.description === `rainskills-operation=${operationId}`;
  if (!owned) throw new Error("Helm release ownership 不属于当前 operation，可能是外部资源，拒绝覆盖");
  if (!Number.isInteger(revision) || revision < 1) throw new Error("当前 operation 的 Helm release revision 无效");
  const status = String(result.info?.status || "unknown");
  const allowedStatuses = new Set(["unknown", "deployed", "uninstalled", "superseded", "failed", "uninstalling", "pending-install", "pending-upgrade", "pending-rollback"]);
  if (!allowedStatuses.has(status)) throw new Error("Helm release status 无效，拒绝恢复");
  return { presence: "owned", revision, status, description: result.info.description };
}

function assertReleaseRecoveryAction(result) {
  if (result.presence === "absent") return "retry";
  if (result.presence !== "owned") throw new Error("Helm release 状态未知，拒绝恢复");
  if (result.status === "deployed") return "verify";
  if (String(result.status).startsWith("pending-")) {
    throw new Error(`当前 operation 的 Helm release 为 ${result.status}；安装器仅执行只读诊断，请等待 Helm 操作结束后用固定 resume 命令重试`);
  }
  if (result.status === "failed") {
    throw new Error("当前 operation 的 Helm release 为 failed；安装器仅执行只读诊断，请人工检查 helm status/history 并处理失败 release 后再用固定 resume 命令恢复");
  }
  throw new Error(`当前 operation 的 Helm release 状态 ${result.status} 不支持自动恢复；请人工只读诊断后重试`);
}

async function inspectFreshRetryState(lock, { runner = runCommand, assertIdentity = async () => {}, assertOwnership = async () => {} } = {}) {
  const lockedRun = async (command, args) => {
    await assertIdentity();
    await assertOwnership();
    const result = await runner(command, args);
    await assertOwnership();
    await assertIdentity();
    return result;
  };
  const releases = parseJsonOutput(await lockedRun("helm", [...helmArgs(lock), "list", "--all", "-n", NAMESPACE, "-o", "json"]), "恢复前检查 Helm release");
  const crds = parseJsonOutput(await lockedRun("kubectl", [...kubectlArgs(lock), "get", "crd", "-o", "json"]), "恢复前检查 Rainbond CRD");
  const discovery = assertCommandSucceeded(await lockedRun("kubectl", [...kubectlArgs(lock), "api-resources", "--verbs=list", "--namespaced=false", "-o", "name"]), "发现集群级资源");
  const clusterKinds = [...new Set(discovery.split(/\r?\n/u).map((value) => value.trim()).filter(Boolean))];
  if (clusterKinds.length === 0 || clusterKinds.length > 256 || clusterKinds.some((value) => !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u.test(value)) || clusterKinds.join(",").length > 16 * 1024) {
    throw new Error("集群级资源发现结果无效，无法证明恢复环境干净");
  }
  const clusterResources = parseJsonOutput(await lockedRun("kubectl", [...kubectlArgs(lock), "get", clusterKinds.join(","), "-o", "json"]), "恢复前检查集群级资源");
  const resources = parseJsonOutput(await lockedRun("kubectl", [...kubectlArgs(lock), "get", "all,configmap,secret,serviceaccount,role,rolebinding,persistentvolumeclaim,networkpolicy,poddisruptionbudget,resourcequota,limitrange", "-n", NAMESPACE, "-o", "json"]), "恢复前检查 Namespace 资源");
  if (!Array.isArray(releases) || !Array.isArray(crds.items) || !Array.isArray(clusterResources.items) || !Array.isArray(resources.items)) throw new Error("恢复前残留资源检查返回结构无效");
  if (releases.some((item) => item.name === RELEASE)) throw new Error("恢复前发现 rainbond Helm release 残留，拒绝重试");
  const rainbondCrds = crds.items.filter((item) => /rainbond|goodrain/i.test(item.metadata?.name || ""));
  if (rainbondCrds.length > 0) throw new Error("恢复前发现 Rainbond CRD 残留，拒绝重试");
  const clusterResidue = clusterResources.items.filter((item) => {
    const metadata = item.metadata || {};
    const labels = metadata.labels || {};
    const annotations = metadata.annotations || {};
    const helmOwned = annotations["meta.helm.sh/release-name"] === RELEASE
      && annotations["meta.helm.sh/release-namespace"] === NAMESPACE;
    const labeled = labels["app.kubernetes.io/instance"] === RELEASE
      || labels["app.kubernetes.io/name"] === RELEASE;
    const claimed = item.kind === "PersistentVolume" && item.spec?.claimRef?.namespace === NAMESPACE;
    return helmOwned || labeled || claimed;
  });
  if (clusterResidue.length > 0) throw new Error("恢复前发现 Rainbond 集群级残留资源，拒绝自动重试");
  const benign = (item) => (item.kind === "ServiceAccount" && item.metadata?.name === "default")
    || (item.kind === "ConfigMap" && item.metadata?.name === "kube-root-ca.crt");
  const residue = resources.items.filter((item) => !benign(item));
  if (residue.length > 0) throw new Error("恢复前发现 rbd-system 残留资源，拒绝自动重试");
  await assertOwnership();
  return { releaseCount: 0, crdCount: 0, clusterResourceCount: 0, resourceCount: 0 };
}

async function inspectOwnedRelease(lock, { operationId, expectedRevision = null, runner = runCommand } = {}) {
  const result = await inspectReleaseRecoveryState(lock, { operationId, runner });
  if (assertReleaseRecoveryAction(result) !== "verify") throw new Error("当前 operation 的 Helm release 尚未稳定 deployed");
  if (expectedRevision !== null && Number(expectedRevision) !== result.revision) throw new Error("Helm release revision 与恢复状态不匹配");
  return result;
}

function interruptionResult(operationId, signal, stage) {
  return { waiting: true, interrupted: true, signal, stage, resumeArgv: ["npx", `rainskills@${packageVersion}`, "platform", "install", "--onboarding-id", operationId] };
}

async function verifyKubernetesInstallation({ inspect, probeConsole, assertIdentity = async () => {} }) {
  await assertIdentity();
  const result = await inspect();
  if (result.releaseReady !== true) throw new Error("Rainbond Helm release 尚未就绪");
  if (result.operatorReady !== true) throw new Error("Rainbond operator 尚未就绪");
  if (result.corePodsReady !== true) throw new Error("rbd-system core pods 尚未就绪");
  if (result.appUiReady !== true) throw new Error("rbd-app-ui 尚未就绪");
  const candidates = result.consoleCandidates || (result.consoleUrl ? [result.consoleUrl] : []);
  const consoleUrl = await selectReachableConsole(candidates, { probe: probeConsole });
  await assertIdentity();
  return { consoleUrl, location: `existing-kubernetes (${result.context || "locked context"})`, nodeReady: true, componentsReady: true };
}

function gatewayIngressHosts(values) {
  const found = [];
  const walk = (value) => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) { value.forEach(walk); return; }
    for (const [key, child] of Object.entries(value)) {
      if (key.replace(/[-_]/g, "").toLowerCase() === "gatewayingressips") {
        if (child === null || child === "") continue;
        const entries = Array.isArray(child) ? child : [child];
        if (!entries.every((entry) => typeof entry === "string")) throw new Error("gatewayIngressIPs 必须是 IP/DNS 字符串或字符串数组");
        found.push(...entries);
      } else walk(child);
    }
  };
  walk(values);
  return found;
}

function validConsoleHost(value) {
  const raw = String(value || "");
  if (!raw || raw !== raw.trim() || /[\u0000-\u001f\u007f]/u.test(raw)) return false;
  const host = raw.startsWith("[") && raw.endsWith("]") ? raw.slice(1, -1) : raw;
  if (net.isIP(host)) return true;
  if (host.length > 253 || host.includes(":") || host.includes("/") || host.includes("@")) return false;
  return host.split(".").every((label) => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label));
}

function consoleUrlForHost(host) {
  if (!validConsoleHost(host)) throw new Error(`gatewayIngressIPs/Console host 无效：${String(host || "")}`);
  return `http://${net.isIP(host) === 6 ? `[${host}]` : host}:7070`;
}

function buildConsoleCandidates({ values = {}, pods = [], nodes = [], service = {} }) {
  const hosts = [];
  hosts.push(...gatewayIngressHosts(values));
  const readyNodes = new Map((nodes || []).filter((node) => (
    (node.status?.conditions || []).some((condition) => condition.type === "Ready" && condition.status === "True")
  )).map((node) => [node.metadata?.name, node]));
  for (const pod of pods || []) {
    const labels = JSON.stringify(pod.metadata?.labels || {});
    if (!/rbd-gateway/i.test(String(pod.metadata?.name || "")) && !/rbd-gateway/i.test(labels)) continue;
    const node = readyNodes.get(pod.spec?.nodeName);
    if (!node) continue;
    if (pod.status?.hostIP) hosts.push(String(pod.status.hostIP));
    for (const type of ["InternalIP", "ExternalIP"]) {
      hosts.push(...(node.status?.addresses || []).filter((item) => item.type === type).map((item) => String(item.address)));
    }
  }
  for (const ingress of service.status?.loadBalancer?.ingress || []) {
    if (ingress.ip) hosts.push(String(ingress.ip));
    if (ingress.hostname) hosts.push(String(ingress.hostname));
  }
  return [...new Set(hosts.map(consoleUrlForHost))];
}

async function selectReachableConsole(candidates, { probe }) {
  const unique = [...new Set((candidates || []).map((candidate) => {
    const parsed = new URL(String(candidate));
    if (parsed.protocol !== "http:" || parsed.port !== "7070" || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
      throw new Error("Console candidate 必须是无凭据的固定 http://host:7070 origin");
    }
    if (!validConsoleHost(parsed.hostname)) throw new Error("Console candidate host 无效");
    return parsed.origin;
  }))];
  for (const candidate of unique) {
    try { await probe(candidate); return candidate; } catch (error) {
      if (error.code === "RAINSKILLS_KUBERNETES_INTERRUPTED") throw error;
    }
  }
  const error = new Error("Console 从当前控制端暂未可访问");
  error.code = "KUBERNETES_NOT_READY";
  throw error;
}

function sleepWithAbort(ms, abortState) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => { if (settled) return; settled = true; clearTimeout(timer); clearInterval(poll); callback(value); };
    const timer = setTimeout(() => finish(resolve), ms);
    const poll = setInterval(() => { if (abortState?.aborted) finish(reject, interruptedError(abortState)); }, 25);
    poll.unref?.();
  });
}

async function waitForKubernetesVerification({
  inspect, probeConsole, assertIdentity, assertOwnership, abortState,
  deadlineMs = 20 * 60_000, intervalMs = 10_000,
  now = Date.now, sleep = null,
}) {
  const startedAt = now();
  for (;;) {
    assertNotAborted(abortState);
    await assertIdentity();
    await assertOwnership();
    assertNotAborted(abortState);
    let result;
    try {
      result = await inspect();
    } catch (error) {
      if (error.code !== "KUBERNETES_NOT_READY") throw error;
      result = {};
    }
    const ready = result.releaseReady === true && result.operatorReady === true
      && result.corePodsReady === true && result.appUiReady === true;
    if (ready) {
      try {
        const consoleUrl = await selectReachableConsole(result.consoleCandidates || (result.consoleUrl ? [result.consoleUrl] : []), { probe: probeConsole });
        return { consoleUrl, location: `existing-kubernetes (${result.context || "locked context"})`, nodeReady: true, componentsReady: true };
      } catch (error) {
        if (error.code !== "KUBERNETES_NOT_READY") throw error;
        // Console may become reachable after the Kubernetes workloads report Ready.
      }
    }
    assertNotAborted(abortState);
    if (now() - startedAt >= deadlineMs) {
      const error = new Error("Kubernetes verification 在固定期限内未就绪");
      error.code = "RAINSKILLS_KUBERNETES_VERIFY_TIMEOUT";
      throw error;
    }
    if (sleep) await sleep(intervalMs);
    else await sleepWithAbort(intervalMs, abortState);
  }
}

function runCommand(command, args, { abortState, registerChild = () => () => {} } = {}) {
  return new Promise((resolve, reject) => {
    if (abortState?.aborted) { reject(Object.assign(new Error("Kubernetes 安装已中断"), { code: "RAINSKILLS_KUBERNETES_INTERRUPTED", signal: abortState.signal })); return; }
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], shell: false });
    const unregister = registerChild(child, false);
    let stdout = Buffer.alloc(0); let stderr = Buffer.alloc(0); let settled = false;
    const append = (current, chunk) => {
      const next = Buffer.concat([current, chunk]);
      if (next.length > MAX_COMMAND_OUTPUT) { child.kill("SIGTERM"); throw new Error("命令输出超过安全上限"); }
      return next;
    };
    child.stdout.on("data", (chunk) => { try { stdout = append(stdout, chunk); } catch (error) { if (!settled) { settled = true; unregister(); reject(error); } } });
    child.stderr.on("data", (chunk) => { try { stderr = append(stderr, chunk); } catch (error) { if (!settled) { settled = true; unregister(); reject(error); } } });
    child.on("error", (error) => { if (!settled) { settled = true; unregister(); reject(error); } });
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true; unregister();
      if (abortState?.aborted) reject(interruptedError(abortState));
      else resolve({ code, signal, stdout: stdout.toString("utf8"), stderr: stderr.toString("utf8") });
    });
  });
}

function createStateStore() {
  return process.platform === "win32" ? createWindowsSecureStateStore() : createSecureStateStore();
}

async function defaultInspection(lock, runner) {
  const release = parseJsonOutput(await runner("helm", [...helmArgs(lock), "status", RELEASE, "-n", NAMESPACE, "-o", "json"]), "检查 Helm release");
  const pods = parseJsonOutput(await runner("kubectl", [...kubectlArgs(lock), "get", "pods", "-n", NAMESPACE, "-o", "json"]), "检查 rbd-system pods");
  const nodes = parseJsonOutput(await runner("kubectl", [...kubectlArgs(lock), "get", "nodes", "-o", "json"]), "检查 gateway 节点地址");
  const readyNames = new Set((pods.items || []).filter((item) => (item.status?.conditions || []).some((condition) => condition.type === "Ready" && condition.status === "True")).map((item) => item.metadata?.name || ""));
  const has = (pattern) => [...readyNames].some((name) => pattern.test(name));
  const service = parseOptionalJsonOutput(await runner("kubectl", [...kubectlArgs(lock), "get", "service", "rbd-app-ui", "-n", NAMESPACE, "--ignore-not-found", "-o", "json"]), "检查 rbd-app-ui") || {};
  let values = {};
  if (lock.valuesPath) {
    try { values = YAML.parse(fs.readFileSync(lock.valuesPath, "utf8")) || {}; } catch { throw new Error("受保护 values YAML 无效"); }
  }
  const consoleCandidates = buildConsoleCandidates({ values, pods: pods.items || [], nodes: nodes.items || [], service });
  return { releaseReady: release.info?.status === "deployed", operatorReady: has(/operator/i), corePodsReady: has(/rbd-api/i) && has(/rbd-gateway/i), appUiReady: has(/rbd-app-ui/i), consoleCandidates, context: lock.context };
}

async function probeConsole(url, { abortState } = {}) {
  if (!url) throw new Error("Console URL 不可用");
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error("Console URL 无效"); }
  if (parsed.protocol !== "http:" || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error("Console probe 只接受固定无凭据 HTTP origin");
  }
  const target = new URL("/", parsed.origin);
  return new Promise((resolve, reject) => {
    let settled = false; let response = null; let size = 0; const chunks = [];
    const finish = (callback, value) => { if (settled) return; settled = true; clearInterval(poll); callback(value); };
    const request = require("node:http").get(target, { timeout: 5000 }, (incoming) => {
      response = incoming;
      const statusCode = incoming.statusCode;
      incoming.on("error", (error) => finish(reject, abortState?.aborted ? interruptedError(abortState) : error));
      if (statusCode >= 300 && statusCode < 400) {
        incoming.resume();
        finish(reject, new Error("Console probe 拒绝 HTTP 重定向"));
        return;
      }
      if (statusCode !== 200) {
        incoming.resume();
        finish(reject, new Error(`Console HTTP 状态无效（${statusCode}）`));
        return;
      }
      const contentType = String(incoming.headers["content-type"] || "").toLowerCase();
      if (!contentType.startsWith("text/html")) {
        incoming.resume();
        finish(reject, new Error("Console probe 响应不是 Rainbond HTML"));
        return;
      }
      incoming.on("data", (chunk) => {
        if (settled) return;
        size += chunk.length;
        if (size > MAX_CONSOLE_PROBE_BYTES) {
          incoming.destroy(new Error("Console probe 响应体超过安全上限"));
          return;
        }
        chunks.push(chunk);
      });
      incoming.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        if (!/<title(?:\s[^>]*)?>\s*Rainbond(?:\s|\||<)/iu.test(body)) {
          finish(reject, new Error("Console probe 未识别到 Rainbond 页面特征"));
          return;
        }
        finish(resolve);
      });
    });
    const poll = setInterval(() => {
      if (!abortState?.aborted) return;
      response?.destroy(interruptedError(abortState));
      request.destroy(interruptedError(abortState));
    }, 25);
    poll.unref?.();
    request.on("timeout", () => request.destroy(new Error("Console 请求超时")));
    request.on("error", (error) => finish(reject, abortState?.aborted ? interruptedError(abortState) : error));
    if (abortState?.aborted) request.destroy(interruptedError(abortState));
  });
}

async function installExistingKubernetesFlow({ state, paths, options, abortState }, dependencies = {}) {
  const stateStore = dependencies.stateStore || createStateStore();
  const operationDir = path.join(paths.root, "existing-kubernetes");
  stateStore.ensurePrivateDirectory(operationDir);
  const driverStatePath = path.join(operationDir, "state.json");
  let saved = fs.existsSync(driverStatePath) ? stateStore.readProtectedJson(driverStatePath) : null;
  if (saved && (saved.schema !== "rainskills.existing-kubernetes-state.v1" || saved.operation_id !== state.operation_id)) throw new Error("已有 Kubernetes 恢复状态无效");
  const persist = (patch) => {
    saved = { ...(saved || {}), ...patch, schema: "rainskills.existing-kubernetes-state.v1", version: 1, operation_id: state.operation_id, updated_at: new Date().toISOString() };
    stateStore.atomicWriteJson(driverStatePath, saved);
  };
  const interrupted = (stage) => {
    if (!abortState?.aborted) return null;
    const result = interruptionResult(state.operation_id, abortState.signal || "SIGINT", stage);
    persist({ stage, status: "interrupted", signal: result.signal, resume_argv: result.resumeArgv });
    return result;
  };
  const write = dependencies.write || ((value) => process.stdout.write(value));
  const defaultKubeconfig = path.join(os.homedir(), ".kube", "config");
  const kubeconfigSource = options.kubeconfig || defaultKubeconfig;
  const context = options.kubeContext || "";
  if (!context) {
    write("\n[RAINSKILLS_USER_INPUT_REQUIRED:existing_kubernetes_context]\n请提供 --kube-context <context>，可选 --kubeconfig <path>、--values <path>、--chart-version <version>。\n");
    persist({ stage: "input", status: "waiting_user" });
    return { waiting: true };
  }
  let lock;
  if (saved?.kubeconfig_path) {
    lock = {
      kubeconfigPath: saved.kubeconfig_path, kubeconfigSha256: saved.kubeconfig_sha256,
      valuesPath: saved.values_path, valuesSha256: saved.values_sha256, context: saved.context,
      apiOrigin: saved.api_origin, clusterUid: saved.cluster_uid,
      chartPath: saved.chart_path, chartSha256: saved.chart_sha256,
      chartPartialPath: saved.chart_partial_path,
      chartOrigin: saved.chart_origin, chartName: saved.chart_name, chartVersion: saved.chart_version,
      provenancePublished: saved.chart_provenance_published === true,
      provenanceVerified: saved.chart_provenance_verified === true,
      provenancePath: saved.chart_provenance_path, provenancePartialPath: saved.chart_provenance_partial_path,
      provenanceSha256: saved.chart_provenance_sha256,
    };
    if (context !== lock.context) throw new Error("恢复时 Kubernetes context 发生变化");
    validateResumeBytes({ ...lock, chartPath: null, chartSha256: null }, stateStore);
  } else {
    const inputs = prepareProtectedInputs({ operationDir, kubeconfigSource, valuesSource: options.values, context, stateStore });
    const target = await queryClusterIdentity({ ...inputs, runner: dependencies.runner || ((command, args) => runCommand(command, args, { abortState, registerChild: dependencies.registerChild })) });
    lock = { ...inputs, ...target };
    persist(safeDriverState({ ...lock, operationId: state.operation_id, stage: "preflight" }));
  }
  const stop = interrupted("preflight"); if (stop) return stop;
  const runner = dependencies.runner || ((command, args) => runCommand(command, args, { abortState, registerChild: dependencies.registerChild }));
  const assertIdentity = () => assertClusterIdentity(
    lock.chartPath && !fs.existsSync(lock.chartPath)
      ? { ...lock, chartPath: null, chartSha256: null }
      : lock,
    { runner }
  );
  const verifyProvenance = dependencies.verifyProvenance || (async ({ chartPath }) => {
    assertCommandSucceeded(await runner("helm", [...helmArgs(lock), "verify", chartPath]), "helm verify provenance");
  });
  const persistChartLock = async (artifact) => persist({
    stage: ["install", "verify", "completed"].includes(saved?.stage) ? saved.stage : "chart", status: "running", chart_path: artifact.path, chart_origin: artifact.origin,
    chart_name: artifact.name, chart_version: artifact.version, chart_sha256: artifact.sha256, chart_partial_path: artifact.partialPath,
    chart_checksum_published: artifact.checksumPublished,
    chart_provenance_published: artifact.provenancePublished === true, chart_provenance_verified: artifact.provenanceVerified === true,
    chart_provenance_path: artifact.provenancePath || null, chart_provenance_partial_path: artifact.provenancePartialPath || null,
    chart_provenance_sha256: artifact.provenanceSha256 || null,
  });
  const postInstallResume = saved?.install_succeeded === true
    || saved?.install_attempted === true
    || ["verify", "completed"].includes(saved?.stage);
  if (postInstallResume) {
    if (!lock.chartPath) throw new Error("post-install 恢复缺少 locked chart");
    if (saved.namespace_owner_operation_id !== state.operation_id || !saved.namespace_uid) throw new Error("post-install 恢复缺少 Namespace ownership");
    if (saved.release_owner_operation_id && saved.release_owner_operation_id !== state.operation_id) throw new Error("post-install 恢复的 Helm release ownership 与当前 operation 不匹配");
    await assertIdentity();
    const assertNamespaceOwnership = () => inspectOwnedNamespace(lock, {
      operationId: state.operation_id, expectedUid: saved.namespace_uid, runner, assertIdentity,
    });
    await assertNamespaceOwnership();
    const resumedChart = await verifyAndResumeLockedChart({
      path: lock.chartPath, partialPath: lock.chartPartialPath, sha256: lock.chartSha256,
      origin: lock.chartOrigin, name: lock.chartName, version: lock.chartVersion,
      checksumPublished: saved.chart_checksum_published === true,
      provenancePublished: lock.provenancePublished, provenanceVerified: lock.provenanceVerified,
      provenancePath: lock.provenancePath, provenancePartialPath: lock.provenancePartialPath,
      provenanceSha256: lock.provenanceSha256,
    }, { stateStore, verifyProvenance, persistLock: persistChartLock, abortState });
    Object.assign(lock, { chartPath: resumedChart.path, chartPartialPath: resumedChart.partialPath, provenanceVerified: resumedChart.provenanceVerified === true });
    validateResumeBytes(lock, stateStore);
    let ownedRelease = await inspectReleaseRecoveryState(lock, { operationId: state.operation_id, runner });
    let recoveryAction;
    try {
      recoveryAction = assertReleaseRecoveryAction(ownedRelease);
    } catch (error) {
      persist({ stage: "install_recovery", status: "waiting_recovery", release_status: ownedRelease.status, recovery_action: "read_only_diagnosis" });
      throw error;
    }
    if (recoveryAction === "retry") {
      if (saved.install_succeeded === true || saved.release_revision) {
        persist({ stage: "install_recovery", status: "waiting_recovery", release_status: "absent", recovery_action: "read_only_diagnosis" });
        throw new Error("曾成功安装的 Helm release 现已缺失；拒绝自动重试，请人工只读诊断后恢复");
      }
      try {
        await inspectFreshRetryState(lock, { runner, assertIdentity, assertOwnership: assertNamespaceOwnership });
        await assertNamespaceOwnership();
      } catch (error) {
        persist({ stage: "install_recovery", status: "waiting_recovery", release_status: "absent", recovery_action: "remove_residue_or_restore_release" });
        throw error;
      }
      const previousAttempts = Number(saved.install_attempt_count || (saved.install_attempted ? 1 : 0));
      if (!Number.isInteger(previousAttempts) || previousAttempts < 1 || previousAttempts >= 3) {
        persist({ stage: "install_recovery", status: "waiting_recovery", release_status: "absent", recovery_action: "manual_diagnosis_after_retry_limit" });
        throw new Error("Helm install 已达到受控重试上限；请人工只读诊断后再决定恢复方式");
      }
      const nextAttempt = previousAttempts + 1;
      await assertNamespaceOwnership();
      persist({ stage: "install", status: "running", install_attempted: true, install_succeeded: false, install_attempt_count: nextAttempt, release_status: "absent", recovery_action: "retry_locked_inputs" });
      await executeHelmInstall(lock, { operationId: state.operation_id, runner, assertIdentity, assertOwnership: assertNamespaceOwnership });
      const retryStop = interrupted("install"); if (retryStop) return retryStop;
      ownedRelease = await inspectReleaseRecoveryState(lock, { operationId: state.operation_id, runner });
      try {
        const result = assertReleaseRecoveryAction(ownedRelease);
        if (result !== "verify") throw new Error("Helm install 命令完成后 release 仍缺失；请人工只读诊断后用固定 resume 命令恢复");
      } catch (error) {
        persist({ stage: "install_recovery", status: "waiting_recovery", release_status: ownedRelease.status, recovery_action: "read_only_diagnosis" });
        throw error;
      }
    }
    if (saved.release_revision && Number(saved.release_revision) !== ownedRelease.revision) throw new Error("Helm release revision 与恢复状态不匹配");
    persist({ stage: "verify", status: "running", install_attempted: true, install_succeeded: true, release_owner_operation_id: state.operation_id, release_revision: ownedRelease.revision, release_status: ownedRelease.status });
    const assertOperationOwnership = async () => {
      await inspectOwnedNamespace(lock, { operationId: state.operation_id, expectedUid: saved.namespace_uid, runner, assertIdentity });
      return inspectOwnedRelease(lock, { operationId: state.operation_id, expectedRevision: ownedRelease.revision, runner });
    };
    const resumedVerification = await waitForKubernetesVerification({
      inspect: dependencies.inspect || (() => defaultInspection(lock, runner)),
      probeConsole: dependencies.probeConsole || ((url) => probeConsole(url, { abortState })),
      assertIdentity,
      assertOwnership: assertOperationOwnership,
      abortState,
      deadlineMs: dependencies.verificationDeadlineMs,
      intervalMs: dependencies.verificationIntervalMs,
      now: dependencies.now,
      sleep: dependencies.sleep,
    });
    const postVerifyStop = interrupted("verify"); if (postVerifyStop) return postVerifyStop;
    persist({ stage: "completed", status: "completed", console_url: resumedVerification.consoleUrl });
    return { verification: resumedVerification };
  }
  await assertIdentity();
  let resumedNamespace = null;
  if (saved?.installation_confirmed === true) {
    resumedNamespace = await inspectOwnedNamespace(lock, {
      operationId: state.operation_id, expectedUid: saved.namespace_uid || null,
      allowMissing: !saved.namespace_uid, runner, assertIdentity,
    });
    if (resumedNamespace && !saved.namespace_uid) {
      persist({ namespace_uid: resumedNamespace.uid, namespace_owner_operation_id: state.operation_id });
    }
  }
  const preflight = await (dependencies.preflight || collectKubernetesPreflight)(lock, { runner, assertIdentity, reachability: dependencies.reachability || (() => defaultReachability({ abortState })) });
  const preflightBlockers = (preflight.blockers || []).filter((item) => !(resumedNamespace && item.category === "namespace_conflict"));
  if (preflightBlockers.length > 0) throw new Error(`Kubernetes 预检存在阻断项：${preflightBlockers.map((item) => item.category).join(", ")}`);
  let chart;
  if (lock.chartPath) {
    chart = await verifyAndResumeLockedChart({ path: lock.chartPath, partialPath: lock.chartPartialPath, sha256: lock.chartSha256, origin: lock.chartOrigin, name: lock.chartName, version: lock.chartVersion, checksumPublished: saved.chart_checksum_published === true, provenancePublished: lock.provenancePublished, provenanceVerified: lock.provenanceVerified, provenancePath: lock.provenancePath, provenancePartialPath: lock.provenancePartialPath, provenanceSha256: lock.provenanceSha256 }, { stateStore, verifyProvenance, persistLock: persistChartLock, abortState });
  } else {
    await assertIdentity();
    try {
      chart = await (dependencies.acquireChart || acquireChartPackage)({
        operationDir, exactVersion: options.chartVersion || "", stateStore, request: dependencies.request,
        verifyProvenance,
        abortState, persistLock: persistChartLock,
      });
    } catch (error) {
      if (error.code !== "RAINSKILLS_KUBERNETES_INTERRUPTED") throw error;
      const result = interruptionResult(state.operation_id, error.signal || abortState?.signal || "SIGINT", "chart");
      persist({ stage: "chart", status: "interrupted", signal: result.signal, resume_argv: result.resumeArgv });
      return result;
    }
    await assertIdentity();
    Object.assign(lock, { chartPath: chart.path, chartPartialPath: chart.partialPath, chartSha256: chart.sha256, chartOrigin: chart.origin, chartName: chart.name, chartVersion: chart.version, provenancePublished: chart.provenancePublished === true, provenanceVerified: chart.provenanceVerified === true, provenancePath: chart.provenancePath, provenancePartialPath: chart.provenancePartialPath, provenanceSha256: chart.provenanceSha256 });
    await persistChartLock(chart);
  }
  validateResumeBytes(lock, stateStore);
  await runHelmValidation(lock, { runner, assertIdentity });
  const stopAfterDryRun = interrupted("dry-run"); if (stopAfterDryRun) return stopAfterDryRun;
  if (saved?.installation_confirmed !== true) persist({ stage: "confirmation", status: "waiting_user" });
  let rl;
  const ask = dependencies.ask || (async (question) => {
    rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return rl.question(question);
  });
  let confirmation = { accepted: true };
  if (saved?.installation_confirmed !== true) {
    try {
      confirmation = await confirmHelmInstall({
        summary: { context: lock.context, clusterUid: lock.clusterUid, apiOrigin: lock.apiOrigin, chartVersion: lock.chartVersion, chartSha256: lock.chartSha256, valuesPath: lock.valuesPath, valuesSha256: lock.valuesSha256, namespace: NAMESPACE, release: RELEASE, blockers: preflightBlockers, manualChanges: [] },
        yes: options.yes, interactive: dependencies.interactive, ask, write,
      });
    } finally { rl?.close(); }
  }
  if (!confirmation.accepted) { persist({ stage: "confirmation", status: confirmation.waiting ? "waiting_user" : "cancelled" }); return { waiting: true, cancelled: confirmation.cancelled === true }; }
  if (saved?.installation_confirmed !== true) persist({ stage: "confirmation", status: "running", installation_confirmed: true });
  const namespaceOwnership = await claimNamespaceForInstall(lock, {
    operationDir, operationId: state.operation_id, expectedUid: saved?.namespace_uid || null,
    stateStore, runner, assertIdentity, persist,
  });
  const assertNamespaceOwnership = () => inspectOwnedNamespace(lock, {
    operationId: state.operation_id, expectedUid: namespaceOwnership.uid, runner, assertIdentity,
  });
  await assertNamespaceOwnership();
  persist({ stage: "install", status: "running", install_attempted: true, install_succeeded: false, install_attempt_count: 1, release_owner_operation_id: state.operation_id });
  await executeHelmInstall(lock, { operationId: state.operation_id, runner, assertIdentity, assertOwnership: assertNamespaceOwnership });
  const stopAfterInstall = interrupted("install"); if (stopAfterInstall) return stopAfterInstall;
  const ownedRelease = await inspectOwnedRelease(lock, { operationId: state.operation_id, runner });
  persist({ stage: "verify", status: "running", install_succeeded: true, release_revision: ownedRelease.revision, release_status: ownedRelease.status });
  const assertOperationOwnership = async () => {
    await inspectOwnedNamespace(lock, { operationId: state.operation_id, expectedUid: namespaceOwnership.uid, runner, assertIdentity });
    return inspectOwnedRelease(lock, { operationId: state.operation_id, expectedRevision: ownedRelease.revision, runner });
  };
  const verification = await waitForKubernetesVerification({
    inspect: dependencies.inspect || (() => defaultInspection(lock, runner)),
    probeConsole: dependencies.probeConsole || ((url) => probeConsole(url, { abortState })),
    assertIdentity,
    assertOwnership: assertOperationOwnership,
    abortState,
    deadlineMs: dependencies.verificationDeadlineMs,
    intervalMs: dependencies.verificationIntervalMs,
    now: dependencies.now,
    sleep: dependencies.sleep,
  });
  const stopAfterVerify = interrupted("verify"); if (stopAfterVerify) return stopAfterVerify;
  persist({ stage: "completed", status: "completed", console_url: verification.consoleUrl });
  return { verification };
}

async function installExistingKubernetes(context, dependencies = {}) {
  try {
    return await installExistingKubernetesFlow(context, dependencies);
  } catch (error) {
    if (error.code !== "RAINSKILLS_KUBERNETES_INTERRUPTED") throw error;
    const stateStore = dependencies.stateStore || createStateStore();
    const operationDir = path.join(context.paths.root, "existing-kubernetes");
    const driverStatePath = path.join(operationDir, "state.json");
    const current = fs.existsSync(driverStatePath) ? stateStore.readProtectedJson(driverStatePath) : {
      schema: "rainskills.existing-kubernetes-state.v1", version: 1, operation_id: context.state.operation_id,
    };
    const result = interruptionResult(context.state.operation_id, error.signal || context.abortState?.signal || "SIGINT", current.stage || "interrupted");
    stateStore.atomicWriteJson(driverStatePath, { ...current, stage: result.stage, status: "interrupted", signal: result.signal, resume_argv: result.resumeArgv, updated_at: new Date().toISOString() });
    return result;
  }
}

module.exports = {
  CHART_ORIGIN,
  acquireChartPackage,
  analyzeWorkloadConflicts,
  assertClusterIdentity,
  atomicWriteProtectedBytes,
  buildConsoleCandidates,
  claimNamespaceForInstall,
  collectKubernetesPreflight,
  confirmHelmInstall,
  descriptorRead,
  defaultInspection,
  defaultReachability,
  evaluateKubernetesPreflight,
  executeHelmInstall,
  fetchBoundedHttps,
  helmArgs,
  importProtectedSource,
  inspectFreshRetryState,
  inspectOwnedRelease,
  inspectReleaseRecoveryState,
  assertReleaseRecoveryAction,
  installExistingKubernetes,
  interruptionResult,
  kubectlArgs,
  kubernetesPreflightPlan,
  prepareProtectedInputs,
  probeConsole,
  queryClusterIdentity,
  renderConfirmationSummary,
  resumeLockedChart,
  runCommand,
  runHelmValidation,
  safeDriverState,
  selectReachableConsole,
  validateResumeBytes,
  verifyAndResumeLockedChart,
  verifyKubernetesInstallation,
  waitForKubernetesVerification,
};
