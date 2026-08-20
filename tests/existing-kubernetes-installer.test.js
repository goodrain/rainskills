"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const packageVersion = require("../package.json").version;

const installerPath = path.resolve(__dirname, "../rainbond-platform-installer/scripts/existing-kubernetes-installer.js");
const moduleUnderTest = () => require(installerPath);
const digest = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

function operationRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rainskills-k8s-"));
  fs.chmodSync(root, 0o700);
  return root;
}

function protectedFile(root, name, bytes) {
  const filePath = path.join(root, name);
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(filePath, bytes, { mode: 0o600 });
  fs.chmodSync(filePath, 0o600);
  return filePath;
}

function fakeStore(root) {
  return {
    ensurePrivateDirectory(directory) {
      assert.equal(path.relative(root, directory).startsWith(".."), false);
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      fs.chmodSync(directory, 0o700);
      return directory;
    },
    assertSafeExternalRegularFile(filePath) {
      const info = fs.lstatSync(filePath);
      if (info.isSymbolicLink() || !info.isFile()) throw new Error("source must be a regular file");
      if ((info.mode & 0o777) !== 0o600) throw new Error("source permissions must be 0600");
      return { path: filePath };
    },
    assertProtectedRegularFile(filePath) {
      const info = fs.lstatSync(filePath);
      if (info.isSymbolicLink() || !info.isFile()) throw new Error("protected file must be regular");
      if ((info.mode & 0o777) !== 0o600) throw new Error("protected file permissions must be 0600");
      return filePath;
    },
    protectRegularFile(filePath) { fs.chmodSync(filePath, 0o600); return filePath; },
    atomicWriteJson(filePath, value) { protectedFile(root, path.relative(root, filePath), `${JSON.stringify(value)}\n`); },
    readProtectedJson(filePath) { this.assertProtectedRegularFile(filePath); return JSON.parse(fs.readFileSync(filePath, "utf8")); },
  };
}

function identity(root, overrides = {}) {
  const kubeconfigPath = protectedFile(root, "protected/kubeconfig", Buffer.from("apiVersion: v1\nusers:\n- user:\n    token: TOP_SECRET\n"));
  return {
    kubeconfigPath,
    kubeconfigSha256: digest(fs.readFileSync(kubeconfigPath)),
    context: "production",
    apiOrigin: "https://10.0.0.10:6443",
    clusterUid: "cluster-uid-1",
    ...overrides,
  };
}

async function withHttpServer(handler, callback) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    return await callback(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("input import preserves kubeconfig and values original bytes and requires explicit context", () => {
  const { prepareProtectedInputs } = moduleUnderTest();
  const root = operationRoot();
  const kubeBytes = Buffer.from("# keep comment\napiVersion: v1\nusers:\n- user:\n    token: NEVER_LOG_THIS\n");
  const valuesBytes = Buffer.from("# unknown future field\ngateway:\n  password: NEVER_LOG_VALUES\n");
  const kubeSource = protectedFile(root, "source-kube.yaml", kubeBytes);
  const valuesSource = protectedFile(root, "source-values.yaml", valuesBytes);
  const store = fakeStore(root);

  assert.throws(() => prepareProtectedInputs({ operationDir: path.join(root, "operation"), kubeconfigSource: kubeSource, context: "", stateStore: store }), /context/i);
  const result = prepareProtectedInputs({
    operationDir: path.join(root, "operation"), kubeconfigSource: kubeSource,
    valuesSource, context: "production", stateStore: store,
  });
  assert.deepEqual(fs.readFileSync(result.kubeconfigPath), kubeBytes);
  assert.deepEqual(fs.readFileSync(result.valuesPath), valuesBytes);
  assert.equal(result.kubeconfigSha256, digest(kubeBytes));
  assert.equal(result.valuesSha256, digest(valuesBytes));
});

test("kubeconfig and values input rejects symlink and unsafe permissions", () => {
  const { prepareProtectedInputs } = moduleUnderTest();
  const root = operationRoot();
  const store = fakeStore(root);
  const source = protectedFile(root, "source", "safe\n");
  const link = path.join(root, "link");
  fs.symlinkSync(source, link);
  assert.throws(() => prepareProtectedInputs({ operationDir: path.join(root, "op1"), kubeconfigSource: link, context: "ctx", stateStore: store }), /regular|symbolic|symlink/i);
  fs.chmodSync(source, 0o644);
  assert.throws(() => prepareProtectedInputs({ operationDir: path.join(root, "op2"), kubeconfigSource: source, context: "ctx", stateStore: store }), /0600|permission/i);
});

test("Windows production adapter binds kubeconfig and values to sha256 digest plus byte length", () => {
  const { prepareProtectedInputs } = moduleUnderTest();
  const { createWindowsSecureStateStore } = require("../rainbond-platform-installer/scripts/windows-platform.js");
  const root = operationRoot(); const home = path.join(root, "profile"); fs.mkdirSync(home, { mode: 0o700 });
  const kubeSource = protectedFile(root, "repo/kubeconfig", "apiVersion: v1\nusers: []\n");
  const valuesSource = protectedFile(root, "repo/values.yaml", "gatewayNodes: [node1]\n");
  fs.chmodSync(kubeSource, 0o644); fs.chmodSync(valuesSource, 0o644); // Windows trust is ACL/handle-based, not POSIX mode bits.
  const currentSid = "S-1-5-21-111-222-333-1001";
  const runner = (_command, args) => {
    const action = args[args.indexOf("-Action") + 1];
    const targetPath = args[args.indexOf("-TargetPath") + 1];
    if (action === "ProtectState") return { status: 0, stdout: "", stderr: "" };
    if (["InspectState", "InspectSourceFile"].includes(action)) {
      const bytes = action === "InspectSourceFile" ? fs.readFileSync(targetPath) : null;
      return { status: 0, stdout: JSON.stringify({
        ownerSid: currentSid, writableSids: [currentSid, "S-1-5-18", "S-1-5-32-544"],
        readableSids: [currentSid, "S-1-5-18", "S-1-5-32-544"], reparsePoint: false,
        fileIdentity: bytes ? `sha256:${digest(bytes)}:${bytes.length}` : null,
      }), stderr: "" };
    }
    assert.fail(`unexpected action ${action}`);
  };
  const stateStore = createWindowsSecureStateStore({ home, currentSid, runner });
  const result = prepareProtectedInputs({ operationDir: path.join(home, ".rainbond", "k8s"), kubeconfigSource: kubeSource, valuesSource, context: "production", stateStore, platform: "win32" });
  assert.deepEqual(fs.readFileSync(result.kubeconfigPath), fs.readFileSync(kubeSource));
  assert.deepEqual(fs.readFileSync(result.valuesPath), fs.readFileSync(valuesSource));
});

test("context identity uses fixed kubeconfig argv, redacts API server, and state contains no secret", async () => {
  const { queryClusterIdentity, safeDriverState } = moduleUnderTest();
  const root = operationRoot();
  const locked = identity(root);
  const calls = [];
  const runner = async (command, args) => {
    calls.push([command, args]);
    if (args.includes("config")) return { code: 0, stdout: JSON.stringify({ clusters: [{ cluster: { server: "https://admin:password@10.0.0.10:6443/private" } }] }), stderr: "" };
    return { code: 0, stdout: JSON.stringify({ metadata: { uid: "cluster-uid-1" } }), stderr: "" };
  };
  const result = await queryClusterIdentity({ kubeconfigPath: locked.kubeconfigPath, context: "production", runner });
  assert.equal(result.apiOrigin, "https://10.0.0.10:6443");
  assert.equal(result.clusterUid, "cluster-uid-1");
  for (const [command, args] of calls) {
    assert.equal(command, "kubectl");
    assert.deepEqual(args.slice(0, 4), ["--kubeconfig", locked.kubeconfigPath, "--context", "production"]);
  }
  const serialized = JSON.stringify(safeDriverState({ ...locked, ...result, valuesPath: null, valuesSha256: null }));
  assert.doesNotMatch(serialized, /TOP_SECRET|password@|users:|token:/i);
});

test("preflight checks Kubernetes version, StorageClass, containerd, readiness and fixed conflicts", () => {
  const { evaluateKubernetesPreflight } = moduleUnderTest();
  const good = {
    kubernetesVersion: "1.29.3", helmVersion: "3.15.0", nodes: [
      { name: "node1", ready: true, runtime: "containerd://1.7", runtimePathReady: true, cpuCores: 8, memoryBytes: 16 * 1024 ** 3, occupiedPorts: [] },
    ], storageClasses: ["local-path"], gatewayNodes: ["node1"], chaosNodes: ["node1"],
    chartReachable: true, imageSourceReachable: true, namespaceExists: false,
    releaseExists: false, rainbondCrds: [], ingressConflicts: [], hostPortConflicts: [],
  };
  assert.deepEqual(evaluateKubernetesPreflight(good).blockers, []);
  const bad = evaluateKubernetesPreflight({ ...good, kubernetesVersion: "1.23.9", storageClasses: [], imageSourceReachable: false, namespaceExists: true, ingressConflicts: ["nginx"], hostPortConflicts: [80], nodes: [{ ...good.nodes[0], ready: false, runtime: "docker://20" }] });
  assert.deepEqual(new Set(bad.blockers.map((item) => item.category)), new Set([
    "kubernetes_version", "storage_class_missing", "image_source_unreachable", "namespace_conflict",
    "ingress_conflict", "entry_port_conflict", "node_not_ready", "containerd_required",
  ]));
});

test("preflight command plan keeps locked target flags and is read-only", () => {
  const { kubectlArgs, helmArgs, kubernetesPreflightPlan } = moduleUnderTest();
  const root = operationRoot();
  const locked = identity(root);
  for (const item of kubernetesPreflightPlan(locked)) {
    if (item.command === "kubectl") assert.deepEqual(item.args.slice(0, 4), kubectlArgs(locked));
    if (item.command === "helm") assert.deepEqual(item.args.slice(0, 4), helmArgs(locked));
    assert.doesNotMatch(item.args.join(" "), /delete|uninstall|patch|apply|create/);
  }
});

test("preflight rechecks locked cluster identity before and after every command", async () => {
  const { collectKubernetesPreflight, kubernetesPreflightPlan } = moduleUnderTest();
  const root = operationRoot();
  const locked = identity(root);
  let identities = 0; let index = 0;
  const responses = [
    JSON.stringify({ serverVersion: { gitVersion: "v1.29.3" } }), "v3.15.0",
    JSON.stringify({ items: [{ metadata: { name: "node1" }, status: { conditions: [{ type: "Ready", status: "True" }], nodeInfo: { containerRuntimeVersion: "containerd://1.7" }, capacity: { cpu: "8", memory: "16Gi", "ephemeral-storage": "100Gi" }, allocatable: { cpu: "8", memory: "16Gi", "ephemeral-storage": "100Gi" } } }] }),
    JSON.stringify({ items: [{ metadata: { name: "local-path" } }] }), "", "[]",
    JSON.stringify({ items: [] }), JSON.stringify({ items: [] }),
    JSON.stringify({ node: { runtime: { imageFs: { capacityBytes: 1000, availableBytes: 500 } } } }),
  ];
  const result = await collectKubernetesPreflight(locked, {
    runner: async () => ({ code: 0, stdout: responses[index++], stderr: "" }),
    assertIdentity: async () => { identities += 1; },
    reachability: async () => ({ chartReachable: true, imageSourceReachable: true }),
  });
  assert.deepEqual(result.blockers, []);
  assert.equal(identities, (kubernetesPreflightPlan(locked).length + 1) * 2);
});

test("preflight blocks when read-only kubelet runtime filesystem evidence is missing", async () => {
  const { collectKubernetesPreflight } = moduleUnderTest();
  const root = operationRoot(); const locked = identity(root);
  const responses = [
    JSON.stringify({ serverVersion: { gitVersion: "v1.29.3" } }), "v3.15.0",
    JSON.stringify({ items: [{ metadata: { name: "node1" }, status: { conditions: [{ type: "Ready", status: "True" }], nodeInfo: { containerRuntimeVersion: "containerd://1.7" }, allocatable: { cpu: "8", memory: "16Gi", "ephemeral-storage": "100Gi" } } }] }),
    JSON.stringify({ items: [{ metadata: { name: "local-path" } }] }), "", "[]", JSON.stringify({ items: [] }), JSON.stringify({ items: [] }),
    JSON.stringify({ node: { runtime: {} } }),
  ];
  let index = 0;
  const result = await collectKubernetesPreflight(locked, {
    runner: async (_command, args) => {
      if (args.includes("--raw")) assert.match(args.at(-1), /^\/api\/v1\/nodes\/node1\/proxy\/stats\/summary$/);
      return { code: 0, stdout: responses[index++], stderr: "" };
    },
    assertIdentity: async () => {}, reachability: async () => ({ chartReachable: true, imageSourceReachable: true }),
  });
  assert(result.blockers.some(({ category }) => category === "runtime_path_unavailable"));
});

test("mature clusters with ordinary Ingress and ingress controllers are not false-positive blockers", () => {
  const { analyzeWorkloadConflicts } = moduleUnderTest();
  const facts = analyzeWorkloadConflicts([
    { kind: "Ingress", metadata: { namespace: "business-a", name: "shop" }, spec: { rules: [{ host: "shop.example.com", http: { paths: [{ backend: { service: { name: "shop-api", port: { number: 8080 } } } }] } }] } },
    { kind: "Ingress", metadata: { namespace: "business-a", name: "rainbond-blog", labels: { app: "rainbond-blog" } }, spec: { rules: [{ http: { paths: [{ backend: { service: { name: "blog", port: { number: 8080 } } } }] } }] } },
    { kind: "Ingress", metadata: { namespace: "business-a", name: "same-name-backends" }, spec: { rules: [{ http: { paths: [
      { backend: { service: { name: "rainbond", port: { number: 80 } } } },
      { backend: { service: { name: "rbd-gateway", port: { number: 80 } } } },
      { backend: { service: { name: "rbd-app-ui", port: { number: 7070 } } } },
    ] } }] } },
    { kind: "Pod", metadata: { namespace: "ingress", name: "nginx-ingress-controller", labels: { "app.kubernetes.io/name": "ingress-nginx" } }, spec: { containers: [{ ports: [{ containerPort: 80 }, { containerPort: 443 }] }] } },
    { kind: "Service", metadata: { namespace: "ingress", name: "ingress-nginx-controller" }, spec: { type: "LoadBalancer", ports: [{ port: 443, nodePort: 30443 }] } },
    { kind: "Service", metadata: { namespace: "business-b", name: "web" }, spec: { type: "NodePort", ports: [{ port: 80, nodePort: 30080 }] } },
  ]);
  assert.deepEqual(facts.ingressConflicts, []);
  assert.deepEqual(facts.hostPortConflicts, []);
});

test("workload conflict analysis blocks only proven Rainbond target and entry-port conflicts", () => {
  const { analyzeWorkloadConflicts } = moduleUnderTest();
  const facts = analyzeWorkloadConflicts([
    { kind: "Ingress", metadata: { namespace: "rbd-system", name: "rainbond-console" }, spec: { rules: [{ http: { paths: [{ backend: { service: { name: "rbd-app-ui", port: { number: 7070 } } } }] } }] } },
    { kind: "Pod", metadata: { namespace: "tools", name: "host-port" }, spec: { containers: [{ ports: [{ hostPort: 7070 }] }] } },
    { kind: "Pod", metadata: { namespace: "ingress", name: "host-network-ingress", labels: { "app.kubernetes.io/name": "ingress-nginx" } }, spec: { hostNetwork: true, containers: [{ ports: [{ containerPort: 80 }] }] } },
    { kind: "Service", metadata: { namespace: "tools", name: "exact-node-entry" }, spec: { type: "NodePort", ports: [{ port: 8080, nodePort: 6060 }] } },
  ]);
  assert.deepEqual(new Set(facts.hostPortConflicts.map(({ source }) => source)), new Set(["hostPort", "hostNetwork", "Service"]));
  assert.deepEqual(new Set(facts.hostPortConflicts.filter(({ source }) => source === "Service").map(({ serviceType }) => serviceType)), new Set(["NodePort"]));
  assert.equal(facts.ingressConflicts.length, 1);
});

test("chart acquisition pins exact version, rejects redirect drift and size overflow", async () => {
  const { acquireChartPackage } = moduleUnderTest();
  const root = operationRoot();
  const store = fakeStore(root);
  const bytes = Buffer.from("rainbond chart package bytes");
  const request = async (url) => {
    if (url.endsWith("index.yaml")) return { statusCode: 200, headers: {}, body: Buffer.from("entries:\n  rainbond:\n    - version: 2.17.0\n      urls: [rainbond-2.17.0.tgz]\n") };
    if (url.endsWith(".prov")) return { statusCode: 404, headers: {}, body: Buffer.alloc(0) };
    return { statusCode: 200, headers: {}, body: bytes };
  };
  const lock = await acquireChartPackage({ operationDir: path.join(root, "op"), exactVersion: "2.17.0", stateStore: store, request, maximumBytes: 1024, persistLock: async () => {} });
  assert.equal(lock.version, "2.17.0");
  assert.equal(lock.sha256, digest(bytes));
  assert.deepEqual(fs.readFileSync(lock.path), bytes);

  await assert.rejects(() => acquireChartPackage({ operationDir: path.join(root, "cross"), exactVersion: "2.17.0", stateStore: store, request: async (url) => url.endsWith("index.yaml")
    ? { statusCode: 200, headers: {}, body: Buffer.from("entries:\n  rainbond:\n    - version: 2.17.0\n      urls: [https://evil.example/chart.tgz]\n") }
    : { statusCode: 200, headers: {}, body: bytes }, persistLock: async () => {} }), /origin|来源/i);
  await assert.rejects(() => acquireChartPackage({ operationDir: path.join(root, "large"), exactVersion: "2.17.0", stateStore: store, request: async (url) => url.endsWith("index.yaml")
    ? { statusCode: 200, headers: {}, body: Buffer.from("entries:\n  rainbond:\n    - version: 2.17.0\n      urls: [rainbond-2.17.0.tgz]\n") }
    : { statusCode: 200, headers: {}, body: Buffer.alloc(2048) }, maximumBytes: 100, persistLock: async () => {} }), /size|大小|上限/i);
});

test("chart redirect allows only bounded same-origin hops", async () => {
  const { fetchBoundedHttps } = moduleUnderTest();
  await assert.rejects(() => fetchBoundedHttps("https://chart.rainbond.com/a", { request: async () => ({ statusCode: 302, headers: { location: "https://evil.example/b" }, body: Buffer.alloc(0) }) }), /origin|同源/i);
  await assert.rejects(() => fetchBoundedHttps("https://chart.rainbond.com/a", { maxRedirects: 1, request: async (url) => ({ statusCode: 302, headers: { location: url.endsWith("/a") ? "/b" : "/c" }, body: Buffer.alloc(0) }) }), /redirect|跳转/i);
  await assert.rejects(() => fetchBoundedHttps("https://chart.rainbond.com/rainbond.tgz", {
    allowedFinalPath: /\.tgz$/,
    request: async () => ({ statusCode: 302, headers: { location: "/login" }, body: Buffer.alloc(0) }),
  }), /path|路径/i);
});

test("published chart checksum is mandatory and lock precedes crash-safe publish", async () => {
  const { acquireChartPackage, resumeLockedChart } = moduleUnderTest();
  const root = operationRoot();
  const store = fakeStore(root);
  const bytes = Buffer.from("signed chart bytes");
  const expected = digest(bytes);
  const events = [];
  const request = async (url) => {
    if (url.endsWith("index.yaml")) return { statusCode: 200, headers: {}, body: Buffer.from(`entries:\n  rainbond:\n    - version: 2.17.0\n      digest: ${expected}\n      urls: [rainbond-2.17.0.tgz]\n`) };
    if (url.endsWith(".prov")) return { statusCode: 404, headers: {}, body: Buffer.alloc(0) };
    return { statusCode: 200, headers: {}, body: bytes };
  };
  const lock = await acquireChartPackage({ operationDir: path.join(root, "op"), exactVersion: "2.17.0", stateStore: store, request, persistLock: async (value) => {
    assert(fs.existsSync(value.partialPath), "locked partial must exist before durable state");
    assert.equal(fs.existsSync(value.path), false, "final must not publish before durable lock");
    events.push("lock");
  } });
  assert.deepEqual(events, ["lock"]);
  assert.equal(lock.checksumPublished, true);
  assert(fs.existsSync(lock.path));

  const recoveredFinal = path.join(root, "recover", "rainbond-2.17.0.tgz");
  const partial = protectedFile(root, "recover/.rainbond-2.17.0.tgz.partial", bytes);
  const recovered = resumeLockedChart({ path: recoveredFinal, partialPath: partial, sha256: expected, version: "2.17.0", origin: "https://chart.rainbond.com", name: "rainbond/rainbond" }, store);
  assert.equal(recovered.recoveredPartial, true);
  assert.deepEqual(fs.readFileSync(recoveredFinal), bytes);

  await assert.rejects(() => acquireChartPackage({ operationDir: path.join(root, "bad-digest"), exactVersion: "2.17.0", stateStore: store, request: async (url) => {
    if (url.endsWith("index.yaml")) return { statusCode: 200, headers: {}, body: Buffer.from(`entries:\n  rainbond:\n    - version: 2.17.0\n      digest: ${"0".repeat(64)}\n      urls: [rainbond-2.17.0.tgz]\n`) };
    return { statusCode: 200, headers: {}, body: bytes };
  }, persistLock: async () => {} }), /checksum|digest/i);
});

test("published chart provenance must be downloaded from the same origin and verified", async () => {
  const { acquireChartPackage } = moduleUnderTest();
  const root = operationRoot(); const store = fakeStore(root);
  const bytes = Buffer.from("chart with provenance"); const expected = digest(bytes);
  let verified = 0;
  const lock = await acquireChartPackage({
    operationDir: path.join(root, "op"), exactVersion: "2.17.0", stateStore: store,
    request: async (url) => {
      if (url.endsWith("index.yaml")) return { statusCode: 200, headers: {}, body: Buffer.from(`entries:\n  rainbond:\n    - version: 2.17.0\n      digest: ${expected}\n      urls: [rainbond-2.17.0.tgz]\n`) };
      if (url.endsWith(".prov")) return { statusCode: 200, headers: {}, body: Buffer.from("signed provenance bytes") };
      return { statusCode: 200, headers: {}, body: bytes };
    },
    verifyProvenance: async ({ chartPath, provenancePath }) => {
      verified += 1;
      assert.deepEqual(fs.readFileSync(chartPath), bytes);
      assert.deepEqual(fs.readFileSync(provenancePath), Buffer.from("signed provenance bytes"));
    },
    persistLock: async () => {},
  });
  assert.equal(verified, 1);
  assert.equal(lock.provenancePublished, true);
});

test("provenance verification interruption resumes the durable locked partial bytes without redownload", async () => {
  const { acquireChartPackage, verifyAndResumeLockedChart } = moduleUnderTest();
  const root = operationRoot(); const store = fakeStore(root); const bytes = Buffer.from("chart-provenance-resume");
  const expected = digest(bytes); const persisted = []; let requestCount = 0;
  const request = async (url) => {
    requestCount += 1;
    if (url.endsWith("index.yaml")) return { statusCode: 200, headers: {}, body: Buffer.from(`entries:\n  rainbond:\n    - version: 2.17.0\n      digest: ${expected}\n      urls: [rainbond-2.17.0.tgz]\n`) };
    if (url.endsWith(".prov")) return { statusCode: 200, headers: {}, body: Buffer.from("provenance") };
    return { statusCode: 200, headers: {}, body: bytes };
  };
  let durableLock;
  await assert.rejects(() => acquireChartPackage({
    operationDir: path.join(root, "op"), exactVersion: "2.17.0", stateStore: store, request,
    persistLock: async (lock) => { persisted.push({ ...lock }); durableLock = { ...lock }; },
    verifyProvenance: async ({ chartPath, provenancePath }) => {
      assert.equal(persisted.length, 1, "complete chart+provenance lock must be durable before verify");
      assert(fs.existsSync(chartPath)); assert(fs.existsSync(provenancePath));
      throw Object.assign(new Error("verify interrupted"), { code: "RAINSKILLS_KUBERNETES_INTERRUPTED", signal: "SIGTERM" });
    },
  }), (error) => error.code === "RAINSKILLS_KUBERNETES_INTERRUPTED");
  assert.equal(fs.existsSync(durableLock.path), false);
  assert.equal(durableLock.provenanceVerified, false);
  const beforeResumeRequests = requestCount;
  let resumedVerifies = 0;
  const resumed = await verifyAndResumeLockedChart(durableLock, {
    stateStore: store,
    verifyProvenance: async () => { resumedVerifies += 1; },
    persistLock: async (lock) => { durableLock = { ...lock }; },
  });
  assert.equal(requestCount, beforeResumeRequests);
  assert.equal(resumedVerifies, 1);
  assert.equal(durableLock.provenanceVerified, true);
  assert.deepEqual(fs.readFileSync(resumed.path), bytes);

  const badRoot = operationRoot(); const badStore = fakeStore(badRoot);
  const badChart = protectedFile(badRoot, "op/.chart.partial", "tampered");
  const badProv = protectedFile(badRoot, "op/.chart.partial.prov", "provenance");
  await assert.rejects(() => verifyAndResumeLockedChart({ ...durableLock, path: path.join(badRoot, "op/chart.tgz"), partialPath: badChart, sha256: expected, provenancePath: path.join(badRoot, "op/chart.tgz.prov"), provenancePartialPath: badProv, provenanceSha256: digest(Buffer.from("provenance")), provenanceVerified: false }, {
    stateStore: badStore, verifyProvenance: async () => assert.fail("bad bytes must fail before verify"), persistLock: async () => {},
  }), /digest|bytes|变化/i);
});

test("chart download abort destroys the phase before provenance, publish, or later Helm stages", async () => {
  const { acquireChartPackage } = moduleUnderTest();
  const root = operationRoot(); const store = fakeStore(root); const abortState = { aborted: false, signal: null };
  let provenance = 0;
  await assert.rejects(() => acquireChartPackage({
    operationDir: path.join(root, "op"), exactVersion: "2.17.0", stateStore: store, abortState,
    request: async (url) => {
      if (url.endsWith("index.yaml")) return { statusCode: 200, headers: {}, body: Buffer.from("entries:\n  rainbond:\n    - version: 2.17.0\n      provenance: rainbond-2.17.0.tgz.prov\n      urls: [rainbond-2.17.0.tgz]\n") };
      abortState.aborted = true; abortState.signal = "SIGTERM";
      return { statusCode: 200, headers: {}, body: Buffer.from("downloaded-but-aborted") };
    },
    verifyProvenance: async () => { provenance += 1; },
    persistLock: async () => {},
  }), (error) => error.code === "RAINSKILLS_KUBERNETES_INTERRUPTED");
  assert.equal(provenance, 0);
  assert.deepEqual(fs.readdirSync(path.join(root, "op")), []);
});

test("signal after chart lock but before publish retains partial and never publishes final", async () => {
  const { acquireChartPackage } = moduleUnderTest();
  const root = operationRoot(); const store = fakeStore(root); const abortState = { aborted: false, signal: null };
  const bytes = Buffer.from("locked-before-signal"); let locked;
  await assert.rejects(() => acquireChartPackage({
    operationDir: path.join(root, "op"), exactVersion: "2.17.0", stateStore: store, abortState,
    request: async (url) => url.endsWith("index.yaml")
      ? { statusCode: 200, headers: {}, body: Buffer.from("entries:\n  rainbond:\n    - version: 2.17.0\n      urls: [rainbond-2.17.0.tgz]\n") }
      : url.endsWith(".prov") ? { statusCode: 404, headers: {}, body: Buffer.alloc(0) }
      : { statusCode: 200, headers: {}, body: bytes },
    persistLock: async (value) => { locked = value; abortState.aborted = true; abortState.signal = "SIGINT"; },
  }), (error) => error.code === "RAINSKILLS_KUBERNETES_INTERRUPTED");
  assert(fs.existsSync(locked.partialPath));
  assert.equal(fs.existsSync(locked.path), false);
});

test("resume bytes rejects changed kubeconfig, values or chart and never replaces them", () => {
  const { validateResumeBytes } = moduleUnderTest();
  const root = operationRoot();
  const locked = identity(root);
  const valuesPath = protectedFile(root, "protected/values.yaml", "x: 1\n");
  const chartPath = protectedFile(root, "protected/rainbond.tgz", "chart\n");
  const lock = { ...locked, valuesPath, valuesSha256: digest(fs.readFileSync(valuesPath)), chartPath, chartSha256: digest(fs.readFileSync(chartPath)) };
  assert.doesNotThrow(() => validateResumeBytes(lock));
  fs.writeFileSync(chartPath, "changed\n"); fs.chmodSync(chartPath, 0o600);
  assert.throws(() => validateResumeBytes(lock), /chart.*变化|chart.*drift/i);
});

test("lint template dry-run reuse one protected chart values kubeconfig context", async () => {
  const { runHelmValidation } = moduleUnderTest();
  const root = operationRoot();
  const locked = identity(root);
  locked.valuesPath = protectedFile(root, "values.yaml", "x: 1\n");
  locked.valuesSha256 = digest(fs.readFileSync(locked.valuesPath));
  locked.chartPath = protectedFile(root, "rainbond.tgz", "chart\n");
  locked.chartSha256 = digest(fs.readFileSync(locked.chartPath));
  const calls = [];
  let identities = 0;
  await runHelmValidation(locked, { runner: async (command, args) => { calls.push([command, args]); return { code: 0, stdout: "", stderr: "" }; }, assertIdentity: async () => { identities += 1; } });
  assert.deepEqual(calls.map(([, args]) => args[4]), ["lint", "template", "install"]);
  assert.equal(identities, 6, "identity must be checked before and after every validation phase");
  for (const [, args] of calls) {
    assert(args.includes(locked.chartPath)); assert(args.includes(locked.valuesPath));
    assert.deepEqual(args.slice(0, 4), ["--kubeconfig", locked.kubeconfigPath, "--kube-context", locked.context]);
  }
});

test("Helm confirmation accept/reject/cancel and nonTTY without yes make zero installs", async () => {
  const { confirmHelmInstall } = moduleUnderTest();
  const summary = { context: "production", clusterUid: "uid", apiOrigin: "https://cluster:6443", chartVersion: "2.17.0", chartSha256: "a".repeat(64), valuesPath: null, valuesSha256: null, namespace: "rbd-system", release: "rainbond", blockers: [], manualChanges: [] };
  const quiet = { write: () => {} };
  assert.equal((await confirmHelmInstall({ summary, yes: true, interactive: false, ...quiet })).accepted, true);
  assert.equal((await confirmHelmInstall({ summary, yes: false, interactive: false, ...quiet })).waiting, true);
  assert.equal((await confirmHelmInstall({ summary, interactive: true, ask: async () => "no", ...quiet })).accepted, false);
  assert.equal((await confirmHelmInstall({ summary, interactive: true, ask: async () => "cancel", ...quiet })).cancelled, true);
});

test("Helm install uses fixed local package and target flags", async () => {
  const { executeHelmInstall } = moduleUnderTest();
  const root = operationRoot();
  const locked = identity(root);
  locked.chartPath = protectedFile(root, "rainbond.tgz", "chart\n");
  locked.chartSha256 = digest(fs.readFileSync(locked.chartPath));
  locked.valuesPath = protectedFile(root, "values.yaml", "x: 1\n");
  locked.valuesSha256 = digest(fs.readFileSync(locked.valuesPath));
  let invocation;
  let identities = 0; let ownershipChecks = 0;
  await executeHelmInstall(locked, { operationId: "op-id", runner: async (command, args) => { invocation = [command, args]; return { code: 0, stdout: "", stderr: "" }; }, assertIdentity: async () => { identities += 1; }, assertOwnership: async () => { ownershipChecks += 1; } });
  assert.equal(identities, 2);
  assert.equal(ownershipChecks, 2, "namespace ownership must be checked immediately before and after Helm side effects");
  assert.equal(invocation[0], "helm");
  assert.deepEqual(invocation[1].slice(0, 8), ["--kubeconfig", locked.kubeconfigPath, "--kube-context", "production", "install", "rainbond", locked.chartPath, "--create-namespace"]);
  assert(invocation[1].includes("rbd-system"));
});

test("namespace claim blocks a post-confirmation namespace race before any create", async () => {
  const { claimNamespaceForInstall } = moduleUnderTest();
  const root = operationRoot(); const locked = identity(root); let creates = 0;
  const runner = async (command, args) => {
    if (command === "kubectl" && args.includes("namespace")) return { code: 0, stdout: JSON.stringify({ metadata: { name: "rbd-system", uid: "external-uid", labels: {}, annotations: {} } }), stderr: "" };
    if (command === "helm") return { code: 0, stdout: "[]", stderr: "" };
    if (command === "kubectl" && args.includes("crd")) return { code: 0, stdout: JSON.stringify({ items: [] }), stderr: "" };
    if (command === "kubectl" && args.includes("create")) creates += 1;
    return { code: 0, stdout: "", stderr: "" };
  };
  await assert.rejects(() => claimNamespaceForInstall(locked, {
    operationDir: root, operationId: "1d6754d6-6fb3-4bda-9a04-15c2d261d178", stateStore: fakeStore(root), runner,
    assertIdentity: async () => {}, persist: () => {},
  }), /namespace|ownership|外部|冲突/i);
  assert.equal(creates, 0);
});

test("namespace create EEXIST fails closed and leaves only a protected deterministic manifest", async () => {
  const { claimNamespaceForInstall } = moduleUnderTest();
  const root = operationRoot(); const locked = identity(root); let namespaceReads = 0; let creates = 0; const persisted = [];
  const runner = async (command, args) => {
    if (command === "kubectl" && args.includes("namespace")) { namespaceReads += 1; return { code: 0, stdout: "", stderr: "" }; }
    if (command === "helm") return { code: 0, stdout: "[]", stderr: "" };
    if (command === "kubectl" && args.includes("crd")) return { code: 0, stdout: JSON.stringify({ items: [] }), stderr: "" };
    if (command === "kubectl" && args.includes("create")) { creates += 1; return { code: 1, stdout: "", stderr: "AlreadyExists" }; }
    return { code: 0, stdout: "", stderr: "" };
  };
  await assert.rejects(() => claimNamespaceForInstall(locked, {
    operationDir: root, operationId: "1d6754d6-6fb3-4bda-9a04-15c2d261d178", stateStore: fakeStore(root), runner,
    assertIdentity: async () => {}, persist: (value) => persisted.push(value),
  }), /create|exit|已存在/i);
  assert.equal(namespaceReads, 1); assert.equal(creates, 1); assert.equal(persisted.length, 0);
  const manifestPath = path.join(root, "namespace.json");
  assert.equal(fs.statSync(manifestPath).mode & 0o777, 0o600);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  assert.equal(manifest.kind, "Namespace"); assert.equal(manifest.metadata.name, "rbd-system");
  assert.equal(manifest.metadata.annotations["rainskills.goodrain.com/operation-id"], "1d6754d6-6fb3-4bda-9a04-15c2d261d178");
});

test("namespace claim resumes only the same UID and operation owner without recreating it", async () => {
  const { claimNamespaceForInstall } = moduleUnderTest();
  const root = operationRoot(); const locked = identity(root); let creates = 0; const persisted = [];
  const operationId = "1d6754d6-6fb3-4bda-9a04-15c2d261d178";
  const owned = { metadata: { name: "rbd-system", uid: "owned-uid", labels: { "app.kubernetes.io/managed-by": "rainskills" }, annotations: { "rainskills.goodrain.com/operation-id": operationId } } };
  const runner = async (command, args) => {
    if (command === "kubectl" && args.includes("namespace")) return { code: 0, stdout: JSON.stringify(owned), stderr: "" };
    if (command === "helm") return { code: 0, stdout: "[]", stderr: "" };
    if (command === "kubectl" && args.includes("crd")) return { code: 0, stdout: JSON.stringify({ items: [] }), stderr: "" };
    if (command === "kubectl" && args.includes("create")) creates += 1;
    return { code: 0, stdout: "", stderr: "" };
  };
  const result = await claimNamespaceForInstall(locked, {
    operationDir: root, operationId, expectedUid: "owned-uid", stateStore: fakeStore(root), runner,
    assertIdentity: async () => {}, persist: (value) => persisted.push(value),
  });
  assert.equal(result.uid, "owned-uid"); assert.equal(creates, 0);
  assert.equal(persisted.at(-1).namespace_uid, "owned-uid");
  assert.equal(fs.statSync(path.join(root, "namespace.json")).mode & 0o777, 0o600);
  await assert.rejects(() => claimNamespaceForInstall(locked, {
    operationDir: root, operationId, expectedUid: "replaced-uid", stateStore: fakeStore(root), runner,
    assertIdentity: async () => {}, persist: () => {},
  }), /UID|ownership|匹配/i);
});

test("identity drift blocks validation before the next phase", async () => {
  const { runHelmValidation } = moduleUnderTest();
  const root = operationRoot();
  const locked = identity(root);
  locked.chartPath = protectedFile(root, "rainbond.tgz", "chart\n");
  locked.chartSha256 = digest(fs.readFileSync(locked.chartPath));
  let checks = 0; let commands = 0;
  await assert.rejects(() => runHelmValidation(locked, {
    runner: async () => { commands += 1; return { code: 0, stdout: "", stderr: "" }; },
    assertIdentity: async () => { checks += 1; if (checks === 2) throw new Error("identity drift"); },
  }), /identity drift/i);
  assert.equal(commands, 1);
});

test("high-level nonTTY dry-run pauses with zero Helm install and fixed locked resume", async () => {
  const { installExistingKubernetes } = moduleUnderTest();
  const root = operationRoot();
  const source = protectedFile(root, "source-kube", "apiVersion: v1\n");
  const calls = [];
  const stateStore = fakeStore(root);
  const chartBytes = Buffer.from("chart");
  const runner = async (command, args) => {
    calls.push([command, args]);
    if (command === "kubectl" && args.includes("config")) return { code: 0, stdout: JSON.stringify({ clusters: [{ cluster: { server: "https://10.0.0.10:6443" } }] }), stderr: "" };
    if (command === "kubectl" && args.includes("kube-system")) return { code: 0, stdout: JSON.stringify({ metadata: { uid: "cluster-uid-1" } }), stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  const common = {
    state: { operation_id: "1d6754d6-6fb3-4bda-9a04-15c2d261d178" }, paths: { root }, abortState: { aborted: false, signal: null },
    options: { kubeconfig: source, kubeContext: "production", chartVersion: "2.17.0", yes: false },
  };
  const result = await installExistingKubernetes(common, {
    stateStore, runner, interactive: false, write: () => {},
    preflight: async () => ({ blockers: [], facts: {} }),
    acquireChart: async ({ operationDir }) => {
      const chartPath = protectedFile(root, path.relative(root, path.join(operationDir, "rainbond-2.17.0.tgz")), chartBytes);
      return { path: chartPath, sha256: digest(chartBytes), origin: "https://chart.rainbond.com", name: "rainbond/rainbond", version: "2.17.0" };
    },
  });
  assert.equal(result.waiting, true);
  assert.equal(calls.filter(([command, args]) => command === "helm" && args[4] === "install" && !args.includes("--dry-run")).length, 0);
  const saved = JSON.parse(fs.readFileSync(path.join(root, "existing-kubernetes", "state.json"), "utf8"));
  assert.equal(saved.context, "production");
  assert.equal(saved.cluster_uid, "cluster-uid-1");
  assert.doesNotMatch(JSON.stringify(saved), /users:|token:|apiVersion:/i);
});

test("high-level resume promotes the exact locked chart partial without reacquiring mutable bytes", async () => {
  const { installExistingKubernetes } = moduleUnderTest();
  const root = operationRoot(); const stateStore = fakeStore(root);
  const operationId = "1d6754d6-6fb3-4bda-9a04-15c2d261d178";
  const operationDir = path.join(root, "existing-kubernetes");
  fs.mkdirSync(operationDir, { recursive: true, mode: 0o700 });
  const kubeconfigPath = protectedFile(root, "existing-kubernetes/kubeconfig", "apiVersion: v1\n");
  const partialPath = protectedFile(root, "existing-kubernetes/.rainbond-2.17.0.tgz.partial", "locked-chart");
  const chartPath = path.join(operationDir, "rainbond-2.17.0.tgz");
  stateStore.atomicWriteJson(path.join(operationDir, "state.json"), {
    schema: "rainskills.existing-kubernetes-state.v1", version: 1, operation_id: operationId,
    stage: "chart", status: "running", kubeconfig_path: kubeconfigPath, kubeconfig_sha256: digest(fs.readFileSync(kubeconfigPath)),
    values_path: null, values_sha256: null, context: "production", api_origin: "https://10.0.0.10:6443", cluster_uid: "cluster-uid-1",
    chart_path: chartPath, chart_partial_path: partialPath, chart_origin: "https://chart.rainbond.com", chart_name: "rainbond/rainbond", chart_version: "2.17.0", chart_sha256: digest(fs.readFileSync(partialPath)),
  });
  let acquired = 0;
  const runner = async (command, args) => {
    if (command === "kubectl" && args.includes("config")) return { code: 0, stdout: JSON.stringify({ clusters: [{ cluster: { server: "https://10.0.0.10:6443" } }] }), stderr: "" };
    if (command === "kubectl" && args.includes("kube-system")) return { code: 0, stdout: JSON.stringify({ metadata: { uid: "cluster-uid-1" } }), stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  const result = await installExistingKubernetes({ state: { operation_id: operationId }, paths: { root }, options: { kubeContext: "production", yes: false }, abortState: { aborted: false, signal: null } }, {
    stateStore, runner, interactive: false, write: () => {}, preflight: async () => ({ blockers: [] }),
    acquireChart: async () => { acquired += 1; throw new Error("must not acquire"); },
  });
  assert.equal(result.waiting, true);
  assert.equal(acquired, 0);
  assert.deepEqual(fs.readFileSync(chartPath), Buffer.from("locked-chart"));
  assert.equal(fs.existsSync(partialPath), false);
});

test("high-level download interruption persists fixed resume and skips dry-run install verify", async () => {
  const { installExistingKubernetes } = moduleUnderTest();
  const root = operationRoot(); const stateStore = fakeStore(root);
  const operationId = "1d6754d6-6fb3-4bda-9a04-15c2d261d178";
  const source = protectedFile(root, "source-kube", "apiVersion: v1\n");
  const abortState = { aborted: false, signal: null }; let helmCalls = 0; let verifies = 0;
  const runner = async (command, args) => {
    if (command === "kubectl" && args.includes("config")) return { code: 0, stdout: JSON.stringify({ clusters: [{ cluster: { server: "https://10.0.0.10:6443" } }] }), stderr: "" };
    if (command === "kubectl" && args.includes("kube-system")) return { code: 0, stdout: JSON.stringify({ metadata: { uid: "cluster-uid-1" } }), stderr: "" };
    if (command === "helm") helmCalls += 1;
    return { code: 0, stdout: "", stderr: "" };
  };
  const result = await installExistingKubernetes({ state: { operation_id: operationId }, paths: { root }, options: { kubeconfig: source, kubeContext: "production", yes: true }, abortState }, {
    stateStore, runner, write: () => {}, preflight: async () => ({ blockers: [] }),
    acquireChart: async () => { abortState.aborted = true; abortState.signal = "SIGTERM"; throw Object.assign(new Error("interrupted"), { code: "RAINSKILLS_KUBERNETES_INTERRUPTED", signal: "SIGTERM" }); },
    inspect: async () => { verifies += 1; },
  });
  assert.equal(result.interrupted, true);
  assert.equal(helmCalls, 0);
  assert.equal(verifies, 0);
  const saved = JSON.parse(fs.readFileSync(path.join(root, "existing-kubernetes", "state.json"), "utf8"));
  assert.equal(saved.status, "interrupted");
  assert.deepEqual(saved.resume_argv, ["npx", `rainskills@${packageVersion}`, "platform", "install", "--onboarding-id", operationId]);
});

test("install success and verification interruption resume owned release without preflight or reinstall", async () => {
  const { installExistingKubernetes } = moduleUnderTest();
  const root = operationRoot(); const stateStore = fakeStore(root);
  const operationId = "1d6754d6-6fb3-4bda-9a04-15c2d261d178";
  const source = protectedFile(root, "source-kube", "apiVersion: v1\n");
  const chartBytes = Buffer.from("owned-release-chart");
  let installCalls = 0; let preflightCalls = 0; let inspectionCalls = 0; let namespaceCreates = 0;
  let namespace = null;
  const runner = async (command, args) => {
    if (command === "kubectl" && args.includes("config")) return { code: 0, stdout: JSON.stringify({ clusters: [{ cluster: { server: "https://10.0.0.10:6443" } }] }), stderr: "" };
    if (command === "kubectl" && args.includes("kube-system")) return { code: 0, stdout: JSON.stringify({ metadata: { uid: "cluster-uid-1" } }), stderr: "" };
    if (command === "kubectl" && args.includes("namespace") && args.includes("rbd-system")) return { code: 0, stdout: namespace ? JSON.stringify(namespace) : "", stderr: "" };
    if (command === "kubectl" && args.includes("create")) {
      namespaceCreates += 1;
      namespace = { metadata: { name: "rbd-system", uid: "owned-namespace-uid", labels: { "app.kubernetes.io/managed-by": "rainskills" }, annotations: { "rainskills.goodrain.com/operation-id": operationId } } };
      return { code: 0, stdout: "namespace/rbd-system created", stderr: "" };
    }
    if (command === "kubectl" && args.includes("crd")) return { code: 0, stdout: JSON.stringify({ items: [] }), stderr: "" };
    if (command === "helm" && args[4] === "list") return { code: 0, stdout: "[]", stderr: "" };
    if (command === "helm" && args[4] === "status") return { code: 0, stdout: JSON.stringify({ name: "rainbond", namespace: "rbd-system", version: 7, info: { status: "deployed", description: `rainskills-operation=${operationId}` } }), stderr: "" };
    if (command === "helm" && args[4] === "install" && !args.includes("--dry-run")) {
      installCalls += 1;
      assert(args.includes(`rainskills-operation=${operationId}`));
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  const context = { state: { operation_id: operationId }, paths: { root }, options: { kubeconfig: source, kubeContext: "production", yes: true }, abortState: { aborted: false, signal: null } };
  const dependencies = {
    stateStore, runner, interactive: false, write: () => {},
    preflight: async () => { preflightCalls += 1; return { blockers: [] }; },
    acquireChart: async ({ operationDir }) => {
      const chartPath = protectedFile(root, path.relative(root, path.join(operationDir, "rainbond-2.17.0.tgz")), chartBytes);
      return { path: chartPath, sha256: digest(chartBytes), origin: "https://chart.rainbond.com", name: "rainbond/rainbond", version: "2.17.0" };
    },
    inspect: async () => {
      inspectionCalls += 1;
      if (inspectionCalls === 1) throw Object.assign(new Error("verification interrupted"), { code: "RAINSKILLS_KUBERNETES_INTERRUPTED", signal: "SIGTERM" });
      return { releaseReady: true, operatorReady: true, corePodsReady: true, appUiReady: true, consoleUrl: "http://10.0.0.20:7070", context: "production" };
    },
    probeConsole: async () => {},
  };
  const interrupted = await installExistingKubernetes(context, dependencies);
  assert.equal(interrupted.interrupted, true);
  assert.equal(installCalls, 1);
  const afterInstall = JSON.parse(fs.readFileSync(path.join(root, "existing-kubernetes", "state.json"), "utf8"));
  assert.equal(afterInstall.install_succeeded, true);
  assert.equal(afterInstall.release_revision, 7);
  assert.equal(afterInstall.namespace_uid, "owned-namespace-uid");
  assert.equal(namespaceCreates, 1);

  const resumed = await installExistingKubernetes(context, dependencies);
  assert.equal(resumed.verification.consoleUrl, "http://10.0.0.20:7070");
  assert.equal(installCalls, 1, "owned release resume must never call helm install again");
  assert.equal(preflightCalls, 1, "post-install resume must skip ordinary conflict preflight");
  assert.equal(namespaceCreates, 1, "owned namespace resume must never recreate it");

  const completed = await installExistingKubernetes(context, dependencies);
  assert.equal(completed.verification.consoleUrl, "http://10.0.0.20:7070");
  assert.equal(installCalls, 1);
  assert.equal(preflightCalls, 1);
});

async function recoverInstallBeforeRelease(mode) {
  const { installExistingKubernetes } = moduleUnderTest();
  const root = operationRoot(); const stateStore = fakeStore(root);
  const operationId = "1d6754d6-6fb3-4bda-9a04-15c2d261d178";
  const source = protectedFile(root, "source-kube", "apiVersion: v1\n");
  const chartBytes = Buffer.from("retry-owned-release-chart");
  const abortState = { aborted: false, signal: null };
  let namespace = null; let installCalls = 0; let releaseExists = false;
  const runner = async (command, args) => {
    if (command === "kubectl" && args.includes("config")) return { code: 0, stdout: JSON.stringify({ clusters: [{ cluster: { server: "https://10.0.0.10:6443" } }] }), stderr: "" };
    if (command === "kubectl" && args.includes("kube-system")) return { code: 0, stdout: JSON.stringify({ metadata: { uid: "cluster-uid-1" } }), stderr: "" };
    if (command === "kubectl" && args.includes("namespace") && args.includes("rbd-system")) return { code: 0, stdout: namespace ? JSON.stringify(namespace) : "", stderr: "" };
    if (command === "kubectl" && args.includes("create")) {
      namespace = { metadata: { name: "rbd-system", uid: "owned-namespace-uid", labels: { "app.kubernetes.io/managed-by": "rainskills" }, annotations: { "rainskills.goodrain.com/operation-id": operationId } } };
      return { code: 0, stdout: "namespace/rbd-system created", stderr: "" };
    }
    if (command === "kubectl" && args.includes("crd")) return { code: 0, stdout: JSON.stringify({ items: [] }), stderr: "" };
    if (command === "kubectl" && args.includes("api-resources")) return { code: 0, stdout: "clusterroles.rbac.authorization.k8s.io\nwidgets.example.io\n", stderr: "" };
    if (command === "kubectl" && args.some((arg) => String(arg).includes("widgets.example.io"))) return { code: 0, stdout: JSON.stringify({ items: [] }), stderr: "" };
    if (command === "kubectl" && args.some((arg) => String(arg).startsWith("all,"))) {
      return { code: 0, stdout: JSON.stringify({ items: [
        { kind: "ServiceAccount", metadata: { namespace: "rbd-system", name: "default" } },
        { kind: "ConfigMap", metadata: { namespace: "rbd-system", name: "kube-root-ca.crt" } },
      ] }), stderr: "" };
    }
    if (command === "helm" && args[4] === "list") return { code: 0, stdout: "[]", stderr: "" };
    if (command === "helm" && args[4] === "status") {
      if (!releaseExists) return { code: 1, stdout: "", stderr: "Error: release: not found" };
      return { code: 0, stdout: JSON.stringify({ name: "rainbond", namespace: "rbd-system", version: 1, info: { status: "deployed", description: `rainskills-operation=${operationId}` } }), stderr: "" };
    }
    if (command === "helm" && args[4] === "install" && !args.includes("--dry-run")) {
      installCalls += 1;
      if (installCalls === 1 && mode === "signal") {
        abortState.aborted = true; abortState.signal = "SIGINT";
        throw Object.assign(new Error("interrupted before release"), { code: "RAINSKILLS_KUBERNETES_INTERRUPTED", signal: "SIGINT" });
      }
      if (installCalls === 1 && mode === "exit") return { code: 1, stdout: "", stderr: "install exited before release creation" };
      releaseExists = true;
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  const context = { state: { operation_id: operationId }, paths: { root }, options: { kubeconfig: source, kubeContext: "production", yes: true }, abortState };
  const dependencies = {
    stateStore, runner, interactive: false, write: () => {}, preflight: async () => ({ blockers: [] }),
    acquireChart: async ({ operationDir }) => {
      const chartPath = protectedFile(root, path.relative(root, path.join(operationDir, "rainbond-2.17.0.tgz")), chartBytes);
      return { path: chartPath, sha256: digest(chartBytes), origin: "https://chart.rainbond.com", name: "rainbond/rainbond", version: "2.17.0" };
    },
    inspect: async () => ({ releaseReady: true, operatorReady: true, corePodsReady: true, appUiReady: true, consoleUrl: "http://10.0.0.20:7070", context: "production" }),
    probeConsole: async () => {},
  };
  const first = installExistingKubernetes(context, dependencies);
  if (mode === "signal") assert.equal((await first).interrupted, true);
  else await assert.rejects(first, /helm install|exit 1/i);
  let saved = JSON.parse(fs.readFileSync(path.join(root, "existing-kubernetes", "state.json"), "utf8"));
  assert.equal(saved.install_attempt_count, 1);
  abortState.aborted = false; abortState.signal = null;
  const resumed = await installExistingKubernetes(context, dependencies);
  saved = JSON.parse(fs.readFileSync(path.join(root, "existing-kubernetes", "state.json"), "utf8"));
  assert.equal(resumed.verification.consoleUrl, "http://10.0.0.20:7070");
  assert.equal(installCalls, 2);
  assert.equal(saved.install_attempt_count, 2);
  assert.equal(saved.status, "completed");
}

test("SIGINT before Helm creates a release resumes an absent release with the locked inputs", async () => {
  await recoverInstallBeforeRelease("signal");
});

test("Helm exit before release creation resumes an absent release with a controlled retry", async () => {
  await recoverInstallBeforeRelease("exit");
});

test("owned failed and pending Helm releases stay read-only and report an explicit recovery action", async () => {
  const { inspectReleaseRecoveryState, assertReleaseRecoveryAction } = moduleUnderTest();
  const root = operationRoot(); const locked = identity(root); const operationId = "op-id";
  for (const status of ["failed", "pending-install"]) {
    let mutations = 0;
    const state = await inspectReleaseRecoveryState(locked, { operationId, runner: async (command, args) => {
      if (command === "helm" && args[4] === "status") return { code: 0, stdout: JSON.stringify({ name: "rainbond", namespace: "rbd-system", version: 1, info: { status, description: `rainskills-operation=${operationId}` } }), stderr: "" };
      mutations += 1; return { code: 0, stdout: "", stderr: "" };
    } });
    assert.equal(state.status, status);
    assert.throws(() => assertReleaseRecoveryAction(state), /只读|人工|重试|恢复/i);
    assert.equal(mutations, 0);
  }
});

test("absent release recovery blocks when the owned namespace has residual resources", async () => {
  const { inspectFreshRetryState } = moduleUnderTest();
  const root = operationRoot(); const locked = identity(root);
  const runner = async (command, args) => {
    if (command === "helm") return { code: 0, stdout: "[]", stderr: "" };
    if (args.includes("crd")) return { code: 0, stdout: JSON.stringify({ items: [] }), stderr: "" };
    if (args.includes("api-resources")) return { code: 0, stdout: "clusterroles.rbac.authorization.k8s.io\n", stderr: "" };
    if (args.some((arg) => String(arg).startsWith("clusterroles.rbac"))) return { code: 0, stdout: JSON.stringify({ items: [] }), stderr: "" };
    return { code: 0, stdout: JSON.stringify({ items: [{ kind: "Deployment", metadata: { namespace: "rbd-system", name: "leftover" } }] }), stderr: "" };
  };
  await assert.rejects(() => inspectFreshRetryState(locked, { runner, assertIdentity: async () => {} }), /残留|residu|资源/i);
  await assert.rejects(() => inspectFreshRetryState(locked, { runner: async (command, args) => {
    if (command === "helm") return { code: 0, stdout: "[]", stderr: "" };
    if (args.includes("crd")) return { code: 0, stdout: JSON.stringify({ items: [] }), stderr: "" };
    if (args.includes("api-resources")) return { code: 0, stdout: "clusterroles.rbac.authorization.k8s.io\n", stderr: "" };
    if (args.some((arg) => String(arg).startsWith("clusterroles.rbac"))) return { code: 0, stdout: JSON.stringify({ items: [] }), stderr: "" };
    return { code: 0, stdout: "{}", stderr: "" };
  }, assertIdentity: async () => {} }), /结构|无效|检查/i);
});

test("absent release recovery proves Rainbond cluster-scoped resources are absent", async () => {
  const { inspectFreshRetryState } = moduleUnderTest();
  const root = operationRoot(); const locked = identity(root);
  const dynamicGets = [];
  const runWithClusterItems = (items) => inspectFreshRetryState(locked, { runner: async (command, args) => {
    if (command === "helm") return { code: 0, stdout: "[]", stderr: "" };
    if (args.includes("crd")) return { code: 0, stdout: JSON.stringify({ items: [] }), stderr: "" };
    if (args.includes("api-resources")) return { code: 0, stdout: "clusterroles.rbac.authorization.k8s.io\nwidgets.example.io\n", stderr: "" };
    if (args.some((arg) => String(arg).includes("widgets.example.io"))) { dynamicGets.push(args); return { code: 0, stdout: JSON.stringify({ items }), stderr: "" }; }
    return { code: 0, stdout: JSON.stringify({ items: [] }), stderr: "" };
  }, assertIdentity: async () => {} });
  await runWithClusterItems([
    { kind: "ClusterRole", metadata: { name: "unrelated-controller", labels: { "app.kubernetes.io/instance": "other" } } },
    { kind: "ClusterRole", metadata: { name: "rainbond-blog", labels: { "app.kubernetes.io/instance": "other" } } },
  ]);
  assert(dynamicGets.some((args) => args.some((arg) => String(arg).includes("widgets.example.io"))), "dynamic cluster-scoped API resources must be included in the proof");
  await assert.rejects(() => runWithClusterItems([{ kind: "ClusterRole", metadata: { name: "rbd-operator", annotations: { "meta.helm.sh/release-name": "rainbond", "meta.helm.sh/release-namespace": "rbd-system" } } }]), /cluster|集群|残留|资源/i);
  await assert.rejects(() => inspectFreshRetryState(locked, { runner: async (command, args) => {
    if (command === "helm") return { code: 0, stdout: "[]", stderr: "" };
    if (args.includes("crd")) return { code: 0, stdout: JSON.stringify({ items: [] }), stderr: "" };
    if (args.includes("api-resources")) return { code: 0, stdout: "clusterroles.rbac.authorization.k8s.io\n", stderr: "" };
    if (args.some((arg) => String(arg).startsWith("clusterroles.rbac"))) return { code: 0, stdout: "{}", stderr: "" };
    return { code: 0, stdout: JSON.stringify({ items: [] }), stderr: "" };
  }, assertIdentity: async () => {} }), /结构|无效|检查/i);
});

test("fresh retry checks namespace ownership around every residue read and once after completion", async () => {
  const { inspectFreshRetryState } = moduleUnderTest();
  const root = operationRoot(); const locked = identity(root);
  let ownershipChecks = 0; let commands = 0;
  await inspectFreshRetryState(locked, { runner: async (command, args) => {
    commands += 1;
    if (command === "helm") return { code: 0, stdout: "[]", stderr: "" };
    if (args.includes("api-resources")) return { code: 0, stdout: "clusterroles.rbac.authorization.k8s.io\n", stderr: "" };
    return { code: 0, stdout: JSON.stringify({ items: [] }), stderr: "" };
  }, assertIdentity: async () => {}, assertOwnership: async () => { ownershipChecks += 1; } });
  assert.equal(commands, 5);
  assert.equal(ownershipChecks, commands * 2 + 1);
});

async function attemptedRecoveryFixture({ releaseStatus, residue = [], clusterResidue = [], installSucceeded = false, attemptCount = 1, releaseOwner = "same", replaceNamespaceAfterResidueRead = false }) {
  const { installExistingKubernetes } = moduleUnderTest();
  const root = operationRoot(); const stateStore = fakeStore(root);
  const operationId = "1d6754d6-6fb3-4bda-9a04-15c2d261d178";
  const operationDir = path.join(root, "existing-kubernetes");
  fs.mkdirSync(operationDir, { recursive: true, mode: 0o700 });
  const kubeconfigPath = protectedFile(root, "existing-kubernetes/kubeconfig", "apiVersion: v1\n");
  const chartPath = protectedFile(root, "existing-kubernetes/rainbond-2.17.0.tgz", "locked-chart\n");
  let namespace = { metadata: { name: "rbd-system", uid: "owned-namespace-uid", labels: { "app.kubernetes.io/managed-by": "rainskills" }, annotations: { "rainskills.goodrain.com/operation-id": operationId } } };
  stateStore.atomicWriteJson(path.join(operationDir, "state.json"), {
    schema: "rainskills.existing-kubernetes-state.v1", version: 1, operation_id: operationId,
    stage: "install", status: "interrupted", kubeconfig_path: kubeconfigPath, kubeconfig_sha256: digest(fs.readFileSync(kubeconfigPath)),
    values_path: null, values_sha256: null, context: "production", api_origin: "https://10.0.0.10:6443", cluster_uid: "cluster-uid-1",
    chart_path: chartPath, chart_partial_path: null, chart_origin: "https://chart.rainbond.com", chart_name: "rainbond/rainbond", chart_version: "2.17.0", chart_sha256: digest(fs.readFileSync(chartPath)),
    installation_confirmed: true, namespace_uid: "owned-namespace-uid", namespace_owner_operation_id: operationId,
    install_attempted: true, install_succeeded: installSucceeded, install_attempt_count: attemptCount,
    release_owner_operation_id: releaseOwner === "same" ? operationId : releaseOwner,
  });
  let installs = 0;
  const runner = async (command, args) => {
    if (command === "kubectl" && args.includes("config")) return { code: 0, stdout: JSON.stringify({ clusters: [{ cluster: { server: "https://10.0.0.10:6443" } }] }), stderr: "" };
    if (command === "kubectl" && args.includes("kube-system")) return { code: 0, stdout: JSON.stringify({ metadata: { uid: "cluster-uid-1" } }), stderr: "" };
    if (command === "kubectl" && args.includes("namespace")) return { code: 0, stdout: JSON.stringify(namespace), stderr: "" };
    if (command === "kubectl" && args.includes("crd")) return { code: 0, stdout: JSON.stringify({ items: [] }), stderr: "" };
    if (command === "kubectl" && args.includes("api-resources")) return { code: 0, stdout: "clusterroles.rbac.authorization.k8s.io\nwidgets.example.io\n", stderr: "" };
    if (command === "kubectl" && args.some((arg) => String(arg).includes("widgets.example.io"))) return { code: 0, stdout: JSON.stringify({ items: clusterResidue }), stderr: "" };
    if (command === "kubectl" && args.some((arg) => String(arg).startsWith("all,"))) {
      if (replaceNamespaceAfterResidueRead) namespace = { metadata: { name: "rbd-system", uid: "replacement-uid", labels: {}, annotations: {} } };
      return { code: 0, stdout: JSON.stringify({ items: residue }), stderr: "" };
    }
    if (command === "helm" && args[4] === "list") return { code: 0, stdout: "[]", stderr: "" };
    if (command === "helm" && args[4] === "status") {
      if (releaseStatus === "absent") return { code: 1, stdout: "", stderr: "Error: release: not found" };
      return { code: 0, stdout: JSON.stringify({ name: "rainbond", namespace: "rbd-system", version: 1, info: { status: releaseStatus, description: `rainskills-operation=${operationId}` } }), stderr: "" };
    }
    if (command === "helm" && args[4] === "install" && !args.includes("--dry-run")) installs += 1;
    return { code: 0, stdout: "", stderr: "" };
  };
  const promise = installExistingKubernetes({ state: { operation_id: operationId }, paths: { root }, options: { kubeContext: "production", yes: true }, abortState: { aborted: false, signal: null } }, {
    stateStore, runner, write: () => {}, inspect: async () => { throw new Error("verification must not run"); }, probeConsole: async () => {},
  });
  return { root, stateStore, operationId, get installs() { return installs; }, promise };
}

test("high-level pending and failed release recovery remains read-only and records the recovery state", async () => {
  for (const releaseStatus of ["pending-install", "failed"]) {
    const fixture = await attemptedRecoveryFixture({ releaseStatus });
    await assert.rejects(fixture.promise, /只读|人工|重试|恢复/i);
    assert.equal(fixture.installs, 0);
    const saved = JSON.parse(fs.readFileSync(path.join(fixture.root, "existing-kubernetes", "state.json"), "utf8"));
    assert.equal(saved.stage, "install_recovery");
    assert.equal(saved.status, "waiting_recovery");
    assert.equal(saved.release_status, releaseStatus);
  }
});

test("high-level absent release recovery refuses retry when owned namespace residue exists", async () => {
  const fixture = await attemptedRecoveryFixture({ releaseStatus: "absent", residue: [{ kind: "Deployment", metadata: { namespace: "rbd-system", name: "leftover" } }] });
  await assert.rejects(fixture.promise, /残留|资源|residu/i);
  assert.equal(fixture.installs, 0);
  const saved = JSON.parse(fs.readFileSync(path.join(fixture.root, "existing-kubernetes", "state.json"), "utf8"));
  assert.equal(saved.stage, "install_recovery");
  assert.equal(saved.status, "waiting_recovery");
});

test("high-level absent release recovery refuses Rainbond cluster-scoped residue", async () => {
  const fixture = await attemptedRecoveryFixture({ releaseStatus: "absent", clusterResidue: [{ kind: "ClusterRoleBinding", metadata: { name: "rainbond-operator", labels: { "app.kubernetes.io/instance": "rainbond" } } }] });
  await assert.rejects(fixture.promise, /cluster|集群|残留|资源/i);
  assert.equal(fixture.installs, 0);
});

test("absent retry detects namespace replacement during residue reads before Helm install", async () => {
  const fixture = await attemptedRecoveryFixture({ releaseStatus: "absent", replaceNamespaceAfterResidueRead: true });
  await assert.rejects(fixture.promise, /namespace|ownership|uid|匹配|所有权/i);
  assert.equal(fixture.installs, 0);
});

test("recovery blocks explicitly when an absent release cannot be retried safely", async () => {
  const cases = [
    { name: "attempt limit", options: { releaseStatus: "absent", attemptCount: 3 } },
    { name: "previously succeeded release disappeared", options: { releaseStatus: "absent", installSucceeded: true } },
    { name: "saved release owner mismatch", options: { releaseStatus: "absent", releaseOwner: "other-operation" } },
  ];
  for (const scenario of cases) {
    const fixture = await attemptedRecoveryFixture(scenario.options);
    await assert.rejects(fixture.promise, /重试|恢复|ownership|所有权|缺失|上限/i, scenario.name);
    assert.equal(fixture.installs, 0, scenario.name);
  }
});

test("a retry command that exits successfully without creating the release remains recoverably blocked", async () => {
  const fixture = await attemptedRecoveryFixture({ releaseStatus: "absent" });
  await assert.rejects(fixture.promise, /release|恢复|absent|缺失/i);
  assert.equal(fixture.installs, 1);
  const saved = JSON.parse(fs.readFileSync(path.join(fixture.root, "existing-kubernetes", "state.json"), "utf8"));
  assert.equal(saved.stage, "install_recovery");
  assert.equal(saved.status, "waiting_recovery");
});

test("release recovery fails closed for an unknown status error or mismatched ownership", async () => {
  const { inspectReleaseRecoveryState } = moduleUnderTest();
  const root = operationRoot(); const locked = identity(root);
  await assert.rejects(() => inspectReleaseRecoveryState(locked, { operationId: "op-id", runner: async () => ({ code: 1, stdout: "", stderr: "TLS handshake failed" }) }), /status|检查|失败|exit/i);
  await assert.rejects(() => inspectReleaseRecoveryState(locked, { operationId: "op-id", runner: async () => ({ code: 0, stdout: JSON.stringify({ name: "rainbond", namespace: "rbd-system", version: 1, info: { status: "deployed", description: "external" } }), stderr: "" }) }), /ownership|外部|所有权/i);
  await assert.rejects(() => inspectReleaseRecoveryState(locked, { operationId: "op-id", runner: async () => ({ code: 0, stdout: JSON.stringify({ name: "rainbond", namespace: "rbd-system", version: 1, info: { status: "pending-install\nDO_NOT_REFLECT", description: "rainskills-operation=op-id" } }), stderr: "" }) }), (error) => {
    assert.match(error.message, /status|状态|无效/i);
    assert.doesNotMatch(error.message, /DO_NOT_REFLECT/);
    return true;
  });
});

test("unknown install result refuses an unowned or mismatched Helm release", async () => {
  const { inspectOwnedRelease } = moduleUnderTest();
  const root = operationRoot(); const locked = identity(root);
  const runner = async () => ({ code: 0, stdout: JSON.stringify({ name: "rainbond", namespace: "rbd-system", version: 1, info: { status: "deployed", description: "external-install" } }), stderr: "" });
  await assert.rejects(() => inspectOwnedRelease(locked, { operationId: "op-id", runner }), /ownership|所有权|外部/i);
});

test("active child registration converts shared signal termination into a fixed interruption", async () => {
  const { runCommand } = moduleUnderTest();
  const abortState = { aborted: false, signal: null }; let registered = 0; let unregistered = 0;
  await assert.rejects(() => runCommand(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], {
    abortState,
    registerChild(child) {
      registered += 1;
      setImmediate(() => { abortState.aborted = true; abortState.signal = "SIGTERM"; child.kill("SIGTERM"); });
      return () => { unregistered += 1; };
    },
  }), (error) => error.code === "RAINSKILLS_KUBERNETES_INTERRUPTED" && error.signal === "SIGTERM");
  assert.equal(registered, 1);
  assert.equal(unregistered, 1);
});

test("interruption preserves fixed resume argv and Kubernetes verification requires all health gates", async () => {
  const { interruptionResult, verifyKubernetesInstallation } = moduleUnderTest();
  assert.deepEqual(interruptionResult("op-id", "SIGTERM", "install").resumeArgv, ["npx", `rainskills@${packageVersion}`, "platform", "install", "--onboarding-id", "op-id"]);
  await assert.rejects(() => verifyKubernetesInstallation({ inspect: async () => ({ releaseReady: true, operatorReady: true, corePodsReady: true, appUiReady: false, consoleUrl: "http://127.0.0.1:7070" }), probeConsole: async () => {} }), /rbd-app-ui/i);
  const result = await verifyKubernetesInstallation({ inspect: async () => ({ releaseReady: true, operatorReady: true, corePodsReady: true, appUiReady: true, consoleUrl: "http://127.0.0.1:7070" }), probeConsole: async () => {} });
  assert.equal(result.consoleUrl, "http://127.0.0.1:7070");
});

test("Console discovery ignores ClusterIP and orders values, gateway hosts, Ready node addresses, then load balancer", () => {
  const { buildConsoleCandidates } = moduleUnderTest();
  const candidates = buildConsoleCandidates({
    values: { Cluster: { gatewayIngressIPs: ["203.0.113.10", "console.example.com"] } },
    pods: [{ metadata: { name: "rbd-gateway-0" }, spec: { nodeName: "node1" }, status: { hostIP: "10.0.0.10" } }],
    nodes: [{ metadata: { name: "node1" }, status: { conditions: [{ type: "Ready", status: "True" }], addresses: [{ type: "InternalIP", address: "10.0.0.10" }, { type: "ExternalIP", address: "198.51.100.20" }] } }],
    service: { spec: { type: "ClusterIP", clusterIP: "10.43.1.8" }, status: {} },
  });
  assert.deepEqual(candidates, [
    "http://203.0.113.10:7070", "http://console.example.com:7070",
    "http://10.0.0.10:7070", "http://198.51.100.20:7070",
  ]);
  assert.doesNotMatch(candidates.join(" "), /10\.43\.1\.8/);
  assert.throws(() => buildConsoleCandidates({ values: { gatewayIngressIPs: ["https://user@example.com/path"] }, pods: [], nodes: [], service: {} }), /gatewayIngressIPs|host/i);
});

test("Console selection probes ordered unique candidates and returns the first reachable URL", async () => {
  const { selectReachableConsole } = moduleUnderTest();
  const probes = [];
  const selected = await selectReachableConsole([
    "http://10.0.0.10:7070", "http://10.0.0.10:7070", "http://198.51.100.20:7070",
  ], { probe: async (url) => { probes.push(url); if (url.includes("10.0.0.10")) throw new Error("unreachable"); } });
  assert.equal(selected, "http://198.51.100.20:7070");
  assert.deepEqual(probes, ["http://10.0.0.10:7070", "http://198.51.100.20:7070"]);
});

test("Console discovery accepts a scalar gatewayIngressIPs and rejects unsafe non-scalar values", () => {
  const { buildConsoleCandidates } = moduleUnderTest();
  assert.deepEqual(buildConsoleCandidates({
    values: { Cluster: { gatewayIngressIPs: "console.example.com" } }, pods: [], nodes: [], service: {},
  }), ["http://console.example.com:7070"]);
  for (const gatewayIngressIPs of [{ host: "console.example.com" }, 7070, "console.example.com\u0000.attacker.invalid"]) {
    assert.throws(() => buildConsoleCandidates({ values: { Cluster: { gatewayIngressIPs } }, pods: [], nodes: [], service: {} }), /gatewayIngressIPs|host/i);
  }
});

test("an unreachable scalar gatewayIngressIPs falls back to the gateway Pod address", async () => {
  const { buildConsoleCandidates, selectReachableConsole } = moduleUnderTest();
  const candidates = buildConsoleCandidates({
    values: { Cluster: { gatewayIngressIPs: "console.example.com" } },
    pods: [{ metadata: { name: "rbd-gateway-0" }, spec: { nodeName: "node1" }, status: { hostIP: "10.0.0.10" } }],
    nodes: [{ metadata: { name: "node1" }, status: { conditions: [{ type: "Ready", status: "True" }], addresses: [{ type: "InternalIP", address: "10.0.0.10" }] } }],
    service: {},
  });
  const probes = [];
  const selected = await selectReachableConsole(candidates, { probe: async (url) => {
    probes.push(url);
    if (url === "http://console.example.com:7070") throw new Error("unreachable");
  } });
  assert.equal(selected, "http://10.0.0.10:7070");
  assert.deepEqual(probes, ["http://console.example.com:7070", "http://10.0.0.10:7070"]);
});

test("bounded Kubernetes verification becomes ready on the Nth round with identity and ownership checks", async () => {
  const { waitForKubernetesVerification } = moduleUnderTest();
  let clock = 0; let rounds = 0; let identities = 0; let ownership = 0;
  const result = await waitForKubernetesVerification({
    inspect: async () => {
      rounds += 1;
      return { releaseReady: true, operatorReady: rounds >= 3, corePodsReady: rounds >= 3, appUiReady: rounds >= 3, consoleCandidates: ["http://10.0.0.10:7070"] };
    },
    probeConsole: async () => {}, assertIdentity: async () => { identities += 1; }, assertOwnership: async () => { ownership += 1; },
    abortState: { aborted: false, signal: null }, deadlineMs: 1000, intervalMs: 100,
    now: () => clock, sleep: async (ms) => { clock += ms; },
  });
  assert.equal(rounds, 3); assert.equal(identities, 3); assert.equal(ownership, 3);
  assert.equal(result.consoleUrl, "http://10.0.0.10:7070");
});

test("bounded Kubernetes verification has fixed timeout, identity drift, and signal behavior", async () => {
  const { waitForKubernetesVerification } = moduleUnderTest();
  let clock = 0;
  await assert.rejects(() => waitForKubernetesVerification({
    inspect: async () => ({ releaseReady: false, operatorReady: false, corePodsReady: false, appUiReady: false, consoleCandidates: [] }),
    probeConsole: async () => {}, assertIdentity: async () => {}, assertOwnership: async () => {}, abortState: { aborted: false },
    deadlineMs: 200, intervalMs: 100, now: () => clock, sleep: async (ms) => { clock += ms; },
  }), (error) => error.code === "RAINSKILLS_KUBERNETES_VERIFY_TIMEOUT");

  let identityChecks = 0; let inspections = 0;
  await assert.rejects(() => waitForKubernetesVerification({
    inspect: async () => { inspections += 1; return { releaseReady: false }; }, probeConsole: async () => {},
    assertIdentity: async () => { identityChecks += 1; if (identityChecks === 2) throw new Error("identity drift"); }, assertOwnership: async () => {}, abortState: { aborted: false },
    deadlineMs: 1000, intervalMs: 10, now: () => 0, sleep: async () => {},
  }), /identity drift/i);
  assert.equal(inspections, 1);

  const abortState = { aborted: false, signal: null };
  await assert.rejects(() => waitForKubernetesVerification({
    inspect: async () => ({ releaseReady: false }), probeConsole: async () => {}, assertIdentity: async () => {}, assertOwnership: async () => {}, abortState,
    deadlineMs: 1000, intervalMs: 10, now: () => 0, sleep: async () => { abortState.aborted = true; abortState.signal = "SIGTERM"; },
  }), (error) => error.code === "RAINSKILLS_KUBERNETES_INTERRUPTED" && error.signal === "SIGTERM");
});

test("default inspection treats missing expected Pods and Service as not ready until they appear", async () => {
  const { defaultInspection, waitForKubernetesVerification } = moduleUnderTest();
  const root = operationRoot(); const locked = identity(root); let round = 0; let clock = 0; const serviceArgv = [];
  const readyPods = ["rbd-operator-0", "rbd-api-0", "rbd-gateway-0", "rbd-app-ui-0"].map((name) => ({
    metadata: { name }, spec: { nodeName: "node1" }, status: { hostIP: "10.0.0.10", conditions: [{ type: "Ready", status: "True" }] },
  }));
  const runner = async (command, args) => {
    if (command === "helm") return { code: 0, stdout: JSON.stringify({ info: { status: "deployed" } }), stderr: "" };
    if (args.includes("pods")) { round += 1; return { code: 0, stdout: JSON.stringify({ items: round < 3 ? [] : readyPods }), stderr: "" }; }
    if (args.includes("nodes")) return { code: 0, stdout: JSON.stringify({ items: [{ metadata: { name: "node1" }, status: { conditions: [{ type: "Ready", status: "True" }], addresses: [{ type: "InternalIP", address: "10.0.0.10" }] } }] }), stderr: "" };
    if (args.includes("service")) {
      serviceArgv.push(args);
      return { code: 0, stdout: round < 3 ? "" : JSON.stringify({ spec: { type: "ClusterIP", clusterIP: "10.43.1.8" } }), stderr: "" };
    }
    assert.fail(`unexpected command: ${command} ${args.join(" ")}`);
  };
  const result = await waitForKubernetesVerification({
    inspect: () => defaultInspection(locked, runner), probeConsole: async () => {},
    assertIdentity: async () => {}, assertOwnership: async () => {}, abortState: { aborted: false },
    deadlineMs: 1000, intervalMs: 100, now: () => clock, sleep: async (ms) => { clock += ms; },
  });
  assert.equal(round, 3);
  assert.equal(result.consoleUrl, "http://10.0.0.10:7070");
  assert.equal(serviceArgv.every((args) => args.includes("--ignore-not-found")), true);
});

test("continuously missing expected resources time out without turning malformed JSON into not-ready", async () => {
  const { defaultInspection, waitForKubernetesVerification } = moduleUnderTest();
  const root = operationRoot(); const locked = identity(root); let clock = 0; let malformed = false; let sleeps = 0;
  const runner = async (command, args) => {
    if (command === "helm") return { code: 0, stdout: JSON.stringify({ info: { status: "deployed" } }), stderr: "" };
    if (args.includes("pods")) return { code: 0, stdout: malformed ? "{" : JSON.stringify({ items: [] }), stderr: "" };
    if (args.includes("nodes")) return { code: 0, stdout: JSON.stringify({ items: [] }), stderr: "" };
    if (args.includes("service")) return { code: 0, stdout: "", stderr: "" };
    assert.fail(`unexpected command: ${command} ${args.join(" ")}`);
  };
  const wait = () => waitForKubernetesVerification({
    inspect: () => defaultInspection(locked, runner), probeConsole: async () => {},
    assertIdentity: async () => {}, assertOwnership: async () => {}, abortState: { aborted: false },
    deadlineMs: 200, intervalMs: 100, now: () => clock, sleep: async (ms) => { sleeps += 1; clock += ms; },
  });
  await assert.rejects(wait, (error) => error.code === "RAINSKILLS_KUBERNETES_VERIFY_TIMEOUT");

  malformed = true; clock = 0; sleeps = 0;
  await assert.rejects(wait, /无效 JSON/);
  assert.equal(sleeps, 0);
});

test("default Console probe rejects a real 404 and a non-Rainbond success body", async () => {
  const { probeConsole } = moduleUnderTest();
  await withHttpServer((_request, response) => {
    response.writeHead(404, { "content-type": "text/html" }); response.end("<title>not found</title>");
  }, async (origin) => assert.rejects(() => probeConsole(origin), /Console|HTTP|Rainbond/i));
  await withHttpServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" }); response.end("<title>Another product</title>");
  }, async (origin) => assert.rejects(() => probeConsole(origin), /Console|Rainbond|识别/i));
});

test("default Console probe accepts the official fixed root HTML contract", async () => {
  const { probeConsole } = moduleUnderTest(); let requestedPath = null;
  await withHttpServer((request, response) => {
    requestedPath = request.url;
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end("<!doctype html><html><head><title>Rainbond | 云原生多云应用管理平台</title></head></html>");
  }, async (origin) => probeConsole(origin));
  assert.equal(requestedPath, "/");
});

test("default Console probe rejects redirects and oversized bodies without following them", async () => {
  const { probeConsole } = moduleUnderTest(); let requests = 0;
  await withHttpServer((_request, response) => {
    requests += 1; response.writeHead(302, { location: "/login" }); response.end();
  }, async (origin) => assert.rejects(() => probeConsole(origin), /redirect|重定向|HTTP/i));
  assert.equal(requests, 1);
  await withHttpServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" }); response.end("x".repeat(300 * 1024));
  }, async (origin) => assert.rejects(() => probeConsole(origin), /large|size|过大|上限/i));
});

test("default Console probe aborts a live request on the shared signal", async () => {
  const { probeConsole } = moduleUnderTest();
  const abortState = { aborted: false, signal: null };
  await withHttpServer((_request, _response) => {
    setTimeout(() => { abortState.aborted = true; abortState.signal = "SIGTERM"; }, 10);
  }, async (origin) => assert.rejects(() => probeConsole(origin, { abortState }), (error) => (
    error.code === "RAINSKILLS_KUBERNETES_INTERRUPTED" && error.signal === "SIGTERM"
  )));
});
