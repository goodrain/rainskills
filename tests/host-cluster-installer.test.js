"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { PassThrough } = require("node:stream");
const YAML = require("yaml");
const packageVersion = require("../package.json").version;

const installerPath = path.resolve(
  __dirname,
  "../rainbond-platform-installer/scripts/host-cluster-installer.js"
);

function moduleUnderTest() {
  return require(installerPath);
}

function cluster(overrides = {}) {
  const value = {
    hosts: [
      {
        name: "node1",
        address: "10.0.0.1",
        internalAddress: "10.0.0.1",
        user: "root",
        port: 22,
        bootstrap: true,
      },
    ],
    roleGroups: {
      etcd: ["node1"],
      master: ["node1"],
      worker: ["node1"],
      "rbd-gateway": ["node1"],
      "rbd-chaos": ["node1"],
      "nfs-server": ["node1"],
    },
    storage: {
      nfs: { enabled: true, sharePath: "/nfs-data/k8s", storageClass: { enabled: true } },
      existingStorageClass: { enabled: false },
    },
    registry: { external: { enabled: false } },
    database: { mysql: { enabled: false }, custom: { enabled: false } },
  };
  return { ...value, ...overrides };
}

function host(name, address, extra = {}) {
  return {
    name,
    address,
    internalAddress: address,
    user: "root",
    port: 22,
    ...extra,
  };
}

function tempOperation(prefix = "rainskills-host-") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.chmodSync(root, 0o700);
  return root;
}

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function elfBinary(arch = "amd64", payload = "roi-safe") {
  const bytes = Buffer.alloc(64 + Buffer.byteLength(payload));
  bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1], 0);
  bytes.writeUInt16LE(2, 16);
  bytes.writeUInt16LE(arch === "arm64" ? 183 : 62, 18);
  bytes.write(payload, 64);
  return bytes;
}

test("topology accepts one, two, and N hosts without a three-node minimum", () => {
  const { validateClusterTopology } = moduleUnderTest();
  assert.equal(validateClusterTopology(cluster()).hosts.length, 1);

  const two = cluster({
    hosts: [host("node1", "10.0.0.1", { bootstrap: true }), host("node2", "10.0.0.2")],
    roleGroups: {
      etcd: ["node1"], master: ["node1"], worker: ["node1", "node2"],
      "rbd-gateway": ["node1"], "rbd-chaos": ["node2"], "nfs-server": ["node1"],
    },
  });
  assert.equal(validateClusterTopology(two).hosts.length, 2);

  const manyHosts = Array.from({ length: 5 }, (_, index) => host(
    `node${index + 1}`,
    `10.0.0.${index + 1}`,
    index === 0 ? { bootstrap: true } : {}
  ));
  const many = cluster({
    hosts: manyHosts,
    roleGroups: {
      etcd: ["node1", "node2", "node3"], master: ["node1", "node2", "node3"],
      worker: manyHosts.map(({ name }) => name), "rbd-gateway": ["node1", "node2"],
      "rbd-chaos": ["node4", "node5"], "nfs-server": ["node1"],
    },
  });
  assert.equal(validateClusterTopology(many).hosts.length, 5);
});

test("topology rejects zero/even etcd and invalid bootstrap, roles, names, or addresses", () => {
  const { validateClusterTopology } = moduleUnderTest();
  const assertInvalid = (value, pattern) => assert.throws(() => validateClusterTopology(value), pattern);
  assertInvalid(cluster({ roleGroups: { ...cluster().roleGroups, etcd: [] } }), /etcd.*正奇数|positive odd/i);
  assertInvalid(cluster({
    hosts: [host("node1", "10.0.0.1", { bootstrap: true }), host("node2", "10.0.0.2")],
    roleGroups: { ...cluster().roleGroups, etcd: ["node1", "node2"] },
  }), /etcd.*奇数|odd/i);
  assertInvalid(cluster({ hosts: [host("node1", "10.0.0.1")] }), /bootstrap.*恰好|exactly one/i);
  assertInvalid(cluster({
    hosts: [host("node1", "10.0.0.1", { bootstrap: true })],
    roleGroups: { ...cluster().roleGroups, master: ["missing"] },
  }), /引用.*不存在|unknown host/i);
  assertInvalid(cluster({
    hosts: [host("node1", "10.0.0.1", { bootstrap: true }), host("node1", "10.0.0.2")],
  }), /名称.*唯一|unique.*name/i);
  assertInvalid(cluster({
    hosts: [host("node1", "10.0.0.1", { bootstrap: true }), host("node2", "10.0.0.1")],
  }), /地址.*冲突|duplicate.*address/i);
  for (const role of ["master", "worker", "rbd-gateway", "rbd-chaos"]) {
    assertInvalid(cluster({ roleGroups: { ...cluster().roleGroups, [role]: [] } }), new RegExp(role));
  }
  assertInvalid(cluster({
    hosts: [host("node1", "10.0.0.1", { bootstrap: true }), host("node2", "10.0.0.2")],
    roleGroups: { ...cluster().roleGroups, master: ["node2"] },
  }), /bootstrap.*master/i);
});

test("topology enforces nfs-server only for built-in NFS", () => {
  const { validateClusterTopology } = moduleUnderTest();
  assert.equal(validateClusterTopology(cluster()).storageMode, "builtin-nfs");
  assert.throws(() => validateClusterTopology(cluster({
    roleGroups: { ...cluster().roleGroups, "nfs-server": [] },
  })), /nfs-server.*恰好|exactly one/i);
  assert.throws(() => validateClusterTopology(cluster({
    roleGroups: { ...cluster().roleGroups, "nfs-server": ["node1", "node2"] },
  })), /nfs-server.*恰好|exactly one/i);

  const external = cluster({
    roleGroups: { ...cluster().roleGroups, "nfs-server": [] },
    storage: { nfs: { enabled: true, server: "10.0.0.50", sharePath: "/data" } },
  });
  assert.equal(validateClusterTopology(external).storageMode, "external-nfs");
  assert.throws(() => validateClusterTopology({
    ...external,
    roleGroups: { ...external.roleGroups, "nfs-server": ["node1"] },
  }), /nfs-server.*必须为空|must be empty/i);

  const existing = cluster({
    roleGroups: { ...cluster().roleGroups, "nfs-server": [] },
    storage: {
      nfs: { enabled: false },
      existingStorageClass: { enabled: true, name: "shared" },
    },
  });
  assert.equal(validateClusterTopology(existing).storageMode, "existing-storage-class");
  assert.throws(() => validateClusterTopology({
    ...existing,
    roleGroups: { ...existing.roleGroups, "nfs-server": ["node1"] },
  }), /nfs-server.*必须为空|must be empty/i);
});

test("import preserves unknown fields byte-for-byte and blocks symlinks or unsafe sensitive permissions", () => {
  const { importClusterConfig } = moduleUnderTest();
  const root = tempOperation();
  const source = path.join(root, "source.yaml");
  const destination = path.join(root, "protected", "cluster.yaml");
  const unknownBytes = Buffer.from(`${YAML.stringify({
    ...cluster(),
    customFutureField: { retain: ["order", "and", "comments"] },
  })}# future ROI comment must survive\n`);
  fs.writeFileSync(source, unknownBytes, { mode: 0o600 });
  const imported = importClusterConfig({ sourcePath: source, destinationPath: destination });
  assert.deepEqual(fs.readFileSync(destination), unknownBytes);
  assert.equal(imported.sha256, sha256(unknownBytes));
  if (process.platform !== "win32") assert.equal(fs.statSync(destination).mode & 0o777, 0o600);

  const link = path.join(root, "link.yaml");
  fs.symlinkSync(source, link);
  assert.throws(() => importClusterConfig({ sourcePath: link, destinationPath: path.join(root, "other.yaml") }), /符号链接|symlink/i);

  const sensitive = path.join(root, "sensitive.yaml");
  fs.writeFileSync(sensitive, YAML.stringify({ ...cluster(), database: { custom: { enabled: true, password: "do-not-log" } } }), { mode: 0o644 });
  if (process.platform !== "win32") {
    assert.throws(() => importClusterConfig({ sourcePath: sensitive, destinationPath: path.join(root, "sensitive-copy.yaml") }), /0600|权限|permission/i);
  }

  let windowsAclChecks = 0;
  const windowsDestination = path.join(root, "windows-sensitive-copy.yaml");
  importClusterConfig({
    sourcePath: sensitive,
    destinationPath: windowsDestination,
    platform: "win32",
    sourceStateStore: { assertSafeExternalRegularFile: (filePath) => {
      windowsAclChecks += 1;
      const value = fs.readFileSync(filePath);
      return { fileIdentity: `sha256:${sha256(value)}:${value.length}` };
    } },
  });
  assert.equal(windowsAclChecks, 2);

  const unsafeModes = [0o620, 0o660, 0o700];
  for (const mode of unsafeModes) {
    fs.chmodSync(sensitive, mode);
    assert.throws(
      () => importClusterConfig({ sourcePath: sensitive, destinationPath: path.join(root, `sensitive-${mode.toString(8)}.yaml`) }),
      /0600|权限|permission/i,
      `sensitive config mode ${mode.toString(8)} must be rejected`
    );
  }
});

test("YAML parser errors are fixed and never reflect sensitive source text", () => {
  const { parseClusterDocument } = moduleUnderTest();
  const sourceSecret = "databasePassword=must-never-appear";
  assert.throws(
    () => parseClusterDocument(`hosts:\n  - name: [${sourceSecret}\n`),
    (error) => {
      assert.equal(error.message, "cluster.yaml 解析失败，请检查 YAML 语法");
      assert.doesNotMatch(error.message, /must-never-appear|databasePassword/);
      return true;
    }
  );
});

test("Windows production ACL adapter accepts a protected source outside USERPROFILE and protects the imported copy", () => {
  const { importClusterConfig } = moduleUnderTest();
  const { createWindowsSecureStateStore } = require("../rainbond-platform-installer/scripts/windows-platform.js");
  const root = tempOperation("rainskills-windows-external-cluster-");
  const home = path.join(root, "user-profile");
  const external = path.join(root, "repo", "cluster.yaml");
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.dirname(external), { recursive: true, mode: 0o700 });
  fs.writeFileSync(external, YAML.stringify({
    ...cluster(),
    database: { custom: { enabled: true, password: "source-value-must-not-leak" } },
  }), { mode: 0o600 });
  const currentSid = "S-1-5-21-111-222-333-1001";
  const calls = [];
  const runner = (command, args) => {
    calls.push({ command, args: [...args] });
    const action = args[args.indexOf("-Action") + 1];
    if (action === "ProtectState") return { status: 0, stdout: "", stderr: "" };
    if (["InspectState", "InspectSourceFile"].includes(action)) {
      const targetPath = args[args.indexOf("-TargetPath") + 1];
      const targetBytes = action === "InspectSourceFile" ? fs.readFileSync(targetPath) : null;
      return {
        status: 0,
        stdout: JSON.stringify({
          ownerSid: currentSid,
          writableSids: [currentSid, "S-1-5-18", "S-1-5-32-544"],
          readableSids: [currentSid, "S-1-5-18", "S-1-5-32-544"],
          reparsePoint: false,
          fileIdentity: targetBytes ? `sha256:${sha256(targetBytes)}:${targetBytes.length}` : null,
        }),
        stderr: "",
      };
    }
    assert.fail(`unexpected Windows state action ${action}`);
  };
  const stateStore = createWindowsSecureStateStore({ home, currentSid, runner });
  const destination = path.join(home, ".rainbond", "host-cluster", "cluster.yaml");
  const result = importClusterConfig({
    sourcePath: external,
    destinationPath: destination,
    platform: "win32",
    stateStore,
    sourceStateStore: stateStore,
  });
  assert.equal(result.path, destination);
  assert.deepEqual(fs.readFileSync(destination), fs.readFileSync(external));
  const sourceInspection = calls.find(({ args }) => args.includes("InspectSourceFile"));
  assert(sourceInspection, "external source must use the production source-file ACL action");
  assert.equal(sourceInspection.args[sourceInspection.args.indexOf("-TargetPath") + 1], external);
  assert(calls.some(({ args }) => args.includes("ProtectState") && args.includes(destination)));
});

test("cluster source reads are descriptor-bound and Windows replacement between ACL checks fails closed", () => {
  const { importClusterConfig, readSafeClusterSource } = moduleUnderTest();
  const bytes = Buffer.from(YAML.stringify(cluster()));
  const stat = { isSymbolicLink: () => false, isFile: () => true, uid: typeof process.getuid === "function" ? process.getuid() : 0, mode: 0o100600, dev: 1, ino: 2, size: bytes.length, mtimeMs: 3, ctimeMs: 4 };
  let openedFlags = 0;
  const read = readSafeClusterSource("/protected/source.yaml", {
    fsImpl: {
      constants: fs.constants,
      openSync(filePath, flags) { openedFlags = flags; return 7; },
      fstatSync(fd) { assert.equal(fd, 7); return stat; },
      readFileSync(fd) { assert.equal(fd, 7, "source bytes must be read from the opened descriptor"); return bytes; },
      closeSync(fd) { assert.equal(fd, 7); },
    },
    platform: "linux",
    currentUid: stat.uid,
  });
  assert.deepEqual(read.bytes, bytes);
  if (fs.constants.O_NOFOLLOW) assert.notEqual(openedFlags & fs.constants.O_NOFOLLOW, 0);

  const root = tempOperation("rainskills-windows-source-race-");
  const home = path.join(root, "home");
  const source = path.join(root, "repo", "cluster.yaml");
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.dirname(source), { recursive: true, mode: 0o700 });
  fs.writeFileSync(source, YAML.stringify({ ...cluster(), database: { custom: { password: "first-value" } } }), { mode: 0o600 });
  let inspections = 0;
  const sourceStateStore = {
    assertSafeExternalRegularFile() {
      inspections += 1;
      if (inspections === 2) fs.writeFileSync(source, YAML.stringify({ ...cluster(), database: { custom: { password: "replacement-value" } } }), { mode: 0o600 });
      const value = fs.readFileSync(source);
      return { fileIdentity: `sha256:${sha256(value)}:${value.length}` };
    },
  };
  assert.throws(() => importClusterConfig({
    sourcePath: source,
    destinationPath: path.join(home, "cluster.yaml"),
    platform: "win32",
    sourceStateStore,
  }), /读取期间.*变化|changed.*read|identity|digest/i);
  assert.equal(inspections, 2);

  const safeBytes = Buffer.from(YAML.stringify(cluster()));
  const unsafeBytes = Buffer.from(YAML.stringify({ ...cluster(), database: { custom: { password: "unsafe-fd-value" } } }));
  let nextFd = 10;
  assert.throws(() => readSafeClusterSource("C:\\repo\\cluster.yaml", {
    platform: "win32",
    currentUid: stat.uid,
    sourceStateStore: {
      assertSafeExternalRegularFile: () => ({ fileIdentity: `sha256:${sha256(safeBytes)}:${safeBytes.length}` }),
    },
    fsImpl: {
      constants: fs.constants,
      openSync: () => nextFd++,
      fstatSync: () => ({ ...stat, size: unsafeBytes.length }),
      readFileSync: () => unsafeBytes,
      closeSync: () => {},
    },
  }), /ACL.*identity|身份|identity/i, "safe path ACL identity must not authorize different fd bytes");
});

test("wizard supports add/list/edit/delete, writes a minimal secret-free config, and cancel is atomic", async () => {
  const { runClusterWizard } = moduleUnderTest();
  const original = cluster();
  const answers = [
    { action: "add", host: host("node2", "10.0.0.2"), roles: ["worker", "rbd-chaos"] },
    { action: "list" },
    { action: "edit", name: "node2", host: host("node2", "10.0.0.20"), roles: ["worker", "rbd-chaos"] },
    { action: "delete", name: "node2" },
    { action: "save" },
  ];
  const writes = [];
  const output = [];
  const saved = await runClusterWizard({
    initialConfig: original,
    prompt: async () => answers.shift(),
    write: (value) => output.push(value),
    persist: (bytes) => writes.push(Buffer.from(bytes)),
  });
  assert.equal(writes.length, 1);
  const parsed = YAML.parse(writes[0].toString("utf8"));
  assert.deepEqual(parsed.hosts.map(({ name }) => name), ["node1"]);
  assert.equal(parsed.storage.nfs.enabled, true);
  assert.equal(parsed.database.mysql.enabled, false);
  assert.equal(parsed.registry.external.enabled, false);
  assert.doesNotMatch(writes[0].toString("utf8"), /password/i);
  assert.match(output.join(""), /node1|node2/);
  assert.equal(saved.cancelled, false);

  let cancelledWrites = 0;
  const cancelled = await runClusterWizard({
    initialConfig: original,
    prompt: async () => ({ action: "cancel" }),
    persist: () => { cancelledWrites += 1; },
  });
  assert.equal(cancelled.cancelled, true);
  assert.equal(cancelledWrites, 0);
  assert.deepEqual(original, cluster());
});

test("preflight uses fixed SSH argv concurrently and returns stable redacted summaries", async () => {
  const { runHostPreflight } = moduleUnderTest();
  const value = cluster({
    hosts: [host("slow", "10.0.0.1", { bootstrap: true }), host("fast", "10.0.0.2")],
    roleGroups: {
      etcd: ["slow"], master: ["slow"], worker: ["slow", "fast"],
      "rbd-gateway": ["slow"], "rbd-chaos": ["fast"], "nfs-server": ["slow"],
    },
  });
  const calls = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const result = await runHostPreflight(value, {
    sessions: new Map([
      ["slow", { controlPath: "/protected/slow-control", interactive: false }],
      ["fast", { controlPath: "/protected/fast-control", interactive: false }],
    ]),
    sshRunner: async (command, args) => {
      calls.push({ command, args });
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      const target = args[args.indexOf("-p") + 2];
      await new Promise((resolve) => setTimeout(resolve, target.includes("10.0.0.1") ? 20 : 1));
      inFlight -= 1;
      return {
        code: 0,
        stdout: JSON.stringify({
          root: true, platform: "linux", arch: "amd64", cpu: 8, memoryBytes: 16 * 1024 ** 3,
          optBytes: 80 * 1024 ** 3, rancherBytes: 80 * 1024 ** 3, occupiedPorts: [],
          sourceReachable: true, imageReachable: true, softwareReachable: true,
          bootstrapReachable: true, existingRke2: false, existingRainbond: false,
          secret: "password=must-not-leak",
        }),
        stderr: "registryPassword=must-not-leak",
      };
    },
  });
  assert(maxInFlight > 1);
  assert.deepEqual(result.nodes.map(({ name }) => name), ["slow", "fast"]);
  assert.deepEqual(calls.map(({ command }) => command), ["ssh", "ssh"]);
  for (const { args } of calls) {
    assert(Array.isArray(args));
    assert.deepEqual(args.slice(0, 2), ["-o", "BatchMode=yes"]);
    assert.equal(args[args.indexOf("-p") + 1], "22");
    assert(args.includes("rainskills-host-preflight-v1"));
  }
  assert(calls[0].args.includes("10.0.0.2"), "bootstrap preflight must check peer reachability");
  assert(calls[0].args.includes("ControlPath=/protected/slow-control"));
  assert(calls[1].args.includes("ControlPath=/protected/fast-control"));
  assert.equal(result.ok, true);
  assert.doesNotMatch(JSON.stringify(result), /must-not-leak|password|stdout|stderr/i);
});

test("host SSH sessions reuse key or one attached password authentication and pause safely without a TTY", async () => {
  const { prepareHostSshSessions, validateClusterTopology } = moduleUnderTest();
  const topology = validateClusterTopology(cluster());
  for (const kind of ["key", "password"]) {
    const calls = [];
    const result = await prepareHostSshSessions(topology, {
      interactive: true,
      sessionFactory: async (item, options) => {
        calls.push({ item, options });
        return {
          target: { host: `root@${item.address}`, port: item.port },
          controlPath: kind === "password" ? "/protected/one-attached-auth" : null,
          interactive: false,
          authentication: kind,
        };
      },
    });
    assert.equal(result.waiting, false);
    assert.equal(calls.length, 1, `${kind} authentication must be established once per host`);
    assert.equal(calls[0].options.interactive, true);
    assert.equal(result.sessions.get("node1").authentication, kind);
  }

  const output = [];
  let prompts = 0;
  const waiting = await prepareHostSshSessions(topology, {
    interactive: false,
    write: (value) => output.push(value),
    sessionFactory: async () => { prompts += 1; return null; },
  });
  assert.equal(waiting.waiting, true);
  assert.equal(prompts, 1);
  assert.match(output.join(""), /RAINSKILLS_USER_INPUT_REQUIRED:host_cluster_ssh_authentication/);
  assert.doesNotMatch(output.join(""), /password\s*=|密码[:：]\s*\S+/i);
});

test("preflight classifies root, platform, architecture, resources, network, ports, and conflicts", async () => {
  const { evaluateHostFacts } = moduleUnderTest();
  const blockers = evaluateHostFacts({
    root: false,
    platform: "darwin",
    arch: "s390x",
    cpu: 1,
    memoryBytes: 2 * 1024 ** 3,
    optBytes: 1,
    rancherBytes: 1,
    occupiedPorts: [80, 443, 6060, 7070],
    sourceReachable: false,
    imageReachable: false,
    softwareReachable: false,
    bootstrapReachable: false,
    existingRke2: true,
    existingRainbond: true,
  }, { bootstrap: true });
  const codes = blockers.map(({ code }) => code);
  for (const code of [
    "root_required", "linux_required", "architecture_unsupported", "cpu_insufficient",
    "memory_insufficient", "opt_disk_insufficient", "rancher_disk_insufficient",
    "ports_occupied", "source_unreachable", "image_unreachable", "software_unreachable",
    "bootstrap_network_unreachable", "existing_rke2", "existing_rainbond",
  ]) assert(codes.includes(code), `${code} missing`);
});

test("ROI confirmation requires explicit acceptance before downloads or execution", async () => {
  const { confirmRoiInstall } = moduleUnderTest();
  for (const decision of ["reject", "cancel"]) {
    let effects = 0;
    const result = await confirmRoiInstall({
      summary: { hosts: 2, warnings: ["control-plane-not-ha"], blockers: [], configPath: "/protected/cluster.yaml" },
      interactive: true,
      ask: async () => decision,
      onAccepted: async () => { effects += 1; },
    });
    assert.equal(result.accepted, false);
    assert.equal(effects, 0);
  }
  let nonTtyEffects = 0;
  const output = [];
  const waiting = await confirmRoiInstall({
    summary: { hosts: 1, warnings: ["not-ha"], blockers: [], configPath: "/protected/cluster.yaml" },
    interactive: false,
    yes: false,
    write: (value) => output.push(value),
    onAccepted: async () => { nonTtyEffects += 1; },
  });
  assert.equal(waiting.waiting, true);
  assert.equal(nonTtyEffects, 0);
  assert.match(output.join(""), /RAINSKILLS_USER_CONFIRMATION_REQUIRED:roi_install/);
  assert.match(output.join(""), /拓扑|节点|系统变更|protected|cluster.yaml/i);

  let acceptedEffects = 0;
  const accepted = await confirmRoiInstall({
    summary: { hosts: 3, warnings: [], blockers: [], configPath: "/protected/cluster.yaml" },
    interactive: false,
    yes: true,
    onAccepted: async () => { acceptedEffects += 1; return "done"; },
  });
  assert.equal(accepted.accepted, true);
  assert.equal(accepted.value, "done");
  assert.equal(acceptedEffects, 1);
});

test("host installer TTY confirmation has a real prompt and reject has zero artifact or execution effects", async () => {
  const { installHostCluster } = moduleUnderTest();
  for (const answer of ["no", "yes"]) {
    const root = tempOperation(`rainskills-host-confirm-${answer}-`);
    const home = path.join(root, "home");
    fs.mkdirSync(home, { mode: 0o700 });
    const stateStore = require("./helpers/portable-secure-state.js").createPortableSecureStateStore(home);
    const source = path.join(home, "source.yaml");
    fs.writeFileSync(source, YAML.stringify(cluster()), { mode: 0o600 });
    const operationId = "1d6754d6-6fb3-4bda-9a04-15c2d261d178";
    const paths = { root: path.join(home, ".rainbond", "platform-installer", operationId) };
    stateStore.ensurePrivateDirectory(paths.root);
    let prompts = 0;
    let closes = 0;
    let downloads = 0;
    let executions = 0;
    const result = await installHostCluster({
      onboarding: { operation_id: operationId },
      state: { operation_id: operationId },
      paths,
      options: { clusterConfig: source, yes: false },
    }, {
      stateStore,
      interactive: true,
      createPrompt: () => ({
        question: async () => { prompts += 1; return answer; },
        close: () => { closes += 1; },
      }),
      sessionFactory: async (item) => ({ target: { host: `root@${item.address}`, port: item.port }, controlPath: null, interactive: false }),
      closeSession: () => {},
      runPreflight: async () => ({ ok: true, blockers: [], nodes: [{ name: "node1", arch: "amd64", blockers: [] }] }),
      acquireArtifact: async ({ operationDir, persistLock }) => {
        downloads += 1;
        const artifactPath = path.join(operationDir, "roi");
        const bytes = elfBinary("amd64");
        fs.writeFileSync(artifactPath, bytes, { mode: 0o600 });
        const lock = { finalUrl: "https://get.rainbond.com/roi/roi-amd64", version: "roi version v1", sha256: sha256(bytes), checksum: { published: false, sourceUrl: null } };
        persistLock(lock);
        return { path: artifactPath, ...lock };
      },
      execute: async () => { executions += 1; return { interrupted: false }; },
      verify: async () => ({ verification: true, consoleUrl: "http://10.0.0.1:7070", location: "host-cluster (1 nodes)" }),
    });
    assert.equal(prompts, 1);
    assert.equal(closes, 1);
    if (answer === "no") {
      assert.equal(result.waiting, true);
      assert.equal(downloads, 0);
      assert.equal(executions, 0);
    } else {
      assert.equal(result.verification.consoleUrl, "http://10.0.0.1:7070");
      assert.equal(downloads, 1);
      assert.equal(executions, 1);
    }
  }
});

test("ROI artifact follows only bounded same-origin redirects and locks final URL, version, and digest", async () => {
  const { acquireRoiArtifact } = moduleUnderTest();
  const root = tempOperation();
  const binary = elfBinary("amd64");
  const requests = [];
  const result = await acquireRoiArtifact({
    arch: "amd64",
    operationDir: root,
    request: async (url) => {
      requests.push(url);
      if (url.endsWith("roi-amd64")) return { statusCode: 302, headers: { location: "/roi/roi-amd64-v1" }, body: Buffer.alloc(0) };
      return { statusCode: 200, headers: { "content-length": String(binary.length) }, body: binary };
    },
    discoverChecksum: async () => ({ published: true, sha256: sha256(binary), sourceUrl: "https://get.rainbond.com/roi/roi-amd64.sha256" }),
    probeVersion: async (filePath) => {
      assert.deepEqual(fs.readFileSync(filePath), binary);
      return "roi version v1.2.3";
    },
    persistLock: async () => {},
  });
  assert.deepEqual(requests, [
    "https://get.rainbond.com/roi/roi-amd64",
    "https://get.rainbond.com/roi/roi-amd64-v1",
  ]);
  assert.equal(result.finalUrl, "https://get.rainbond.com/roi/roi-amd64-v1");
  assert.equal(result.sha256, sha256(binary));
  assert.equal(result.version, "roi version v1.2.3");
  assert.equal(result.checksum.published, true);
  assert.deepEqual(fs.readFileSync(result.path), binary);
  assert.equal(fs.existsSync(`${result.path}.partial`), false);
});

test("ROI artifact never publishes final bytes before its durable lock and unlocked finals fail closed", async () => {
  const { acquireRoiArtifact, reuseLockedRoiArtifact } = moduleUnderTest();
  const root = tempOperation("rainskills-roi-lock-crash-");
  const binary = elfBinary("amd64");
  await assert.rejects(() => acquireRoiArtifact({
    arch: "amd64",
    operationDir: root,
    request: async () => ({ statusCode: 200, headers: {}, body: binary }),
    discoverChecksum: async () => ({ published: false, sourceUrl: null }),
    probeVersion: async () => "roi version v1.2.3",
    persistLock: async () => { throw new Error("simulated lock persistence crash"); },
  }), /simulated lock persistence crash/);
  assert.equal(fs.existsSync(path.join(root, "roi")), false, "final artifact must not exist without a durable lock");

  const configPath = path.join(root, "cluster.yaml");
  fs.writeFileSync(configPath, YAML.stringify(cluster()), { mode: 0o600 });
  fs.writeFileSync(path.join(root, "roi"), binary, { mode: 0o700 });
  assert.throws(() => reuseLockedRoiArtifact({ state: {}, configPath, artifactPath: path.join(root, "roi") }), /未锁定|unlocked|完整锁/i);
});

test("ROI version is probed on the Linux bootstrap with fixed argv and matching remote bytes", async () => {
  const { probeRemoteRoiVersion } = moduleUnderTest();
  const root = tempOperation();
  const artifactPath = path.join(root, "roi");
  const bytes = elfBinary("amd64");
  fs.writeFileSync(artifactPath, bytes, { mode: 0o600 });
  const transfers = [];
  const calls = [];
  const version = await probeRemoteRoiVersion({
    bootstrap: host("node1", "10.0.0.1", { bootstrap: true }),
    artifactPath,
    remoteDir: "/root/.rainbond/rainskills/op-1",
    session: { controlPath: "/protected/bootstrap-control", interactive: false },
    transfer: async (input) => { transfers.push(input); return { remoteSha256: input.sha256 }; },
    sshRunner: async (command, args) => {
      calls.push({ command, args });
      return { code: 0, stdout: "roi version v1.2.3\n", stderr: "" };
    },
  });
  assert.equal(version, "roi version v1.2.3");
  assert.equal(transfers.length, 1);
  assert.equal(transfers[0].mode, 0o700);
  assert.equal(transfers[0].sha256, sha256(bytes));
  assert.deepEqual(calls, [{
    command: "ssh",
    args: ["-o", "BatchMode=yes", "-o", "ControlPath=/protected/bootstrap-control", "-p", "22", "root@10.0.0.1", "/root/.rainbond/rainskills/op-1/roi.probe", "version"],
  }]);
});

test("ROI artifact rejects cross-origin redirect, byte overflow, bad format/version/checksum, and changed resume bytes", async () => {
  const { acquireRoiArtifact, validateRoiResumeLock } = moduleUnderTest();
  const base = { arch: "amd64", operationDir: tempOperation() };
  await assert.rejects(() => acquireRoiArtifact({
    ...base,
    request: async () => ({ statusCode: 302, headers: { location: "https://evil.example/roi" }, body: Buffer.alloc(0) }),
  }), /同源|origin/i);
  for (const location of [
    "https://user:password@get.rainbond.com/roi/roi-amd64-v2",
    "https://get.rainbond.com/roi/roi-amd64-v2?token=secret",
    "https://get.rainbond.com/roi/roi-amd64-v2#fragment",
  ]) {
    await assert.rejects(() => acquireRoiArtifact({
      ...base,
      request: async () => ({ statusCode: 302, headers: { location }, body: Buffer.alloc(0) }),
    }), /重定向|redirect|userinfo|query|fragment|同源/i);
  }
  await assert.rejects(() => acquireRoiArtifact({
    ...base,
    maxBytes: 4,
    request: async () => ({ statusCode: 200, headers: {}, body: Buffer.alloc(5) }),
  }), /大小|size/i);
  await assert.rejects(() => acquireRoiArtifact({
    ...base,
    request: async () => ({ statusCode: 200, headers: {}, body: Buffer.from("script") }),
  }), /ELF|格式|executable/i);
  const binary = elfBinary("amd64");
  await assert.rejects(() => acquireRoiArtifact({
    ...base,
    request: async () => ({ statusCode: 200, headers: {}, body: binary }),
    discoverChecksum: async () => ({ published: true, sha256: "0".repeat(64) }),
  }), /checksum|摘要/i);
  await assert.rejects(() => acquireRoiArtifact({
    ...base,
    request: async () => ({ statusCode: 200, headers: {}, body: binary }),
    discoverChecksum: async () => ({ published: false }),
    probeVersion: async () => "not roi",
  }), /version|版本/i);

  const configPath = path.join(base.operationDir, "cluster.yaml");
  const artifactPath = path.join(base.operationDir, "roi");
  fs.writeFileSync(configPath, "hosts: []\n", { mode: 0o600 });
  fs.writeFileSync(artifactPath, binary, { mode: 0o700 });
  const lock = { configSha256: sha256(fs.readFileSync(configPath)), artifactSha256: sha256(binary), finalUrl: "https://get.rainbond.com/roi/roi-amd64", version: "roi version v1" };
  validateRoiResumeLock(lock, { configPath, artifactPath });
  fs.appendFileSync(configPath, "# changed\n");
  assert.throws(() => validateRoiResumeLock(lock, { configPath, artifactPath }), /配置.*变化|config.*changed/i);
});

test("resume bytes reuse the locked ROI artifact and reject missing or changed files", () => {
  const { reuseLockedRoiArtifact } = moduleUnderTest();
  const root = tempOperation();
  const configPath = path.join(root, "cluster.yaml");
  const artifactPath = path.join(root, "roi");
  const configBytes = Buffer.from(YAML.stringify(cluster()));
  const artifactBytes = elfBinary("amd64");
  fs.writeFileSync(configPath, configBytes, { mode: 0o600 });
  fs.writeFileSync(artifactPath, artifactBytes, { mode: 0o700 });
  const state = {
    config_sha256: sha256(configBytes),
    artifact_sha256: sha256(artifactBytes),
    artifact_final_url: "https://get.rainbond.com/roi/roi-amd64",
    artifact_version: "roi version v1.2.3",
    artifact_checksum_published: false,
    artifact_checksum_url: null,
  };
  assert.deepEqual(reuseLockedRoiArtifact({ state, configPath, artifactPath }), {
    path: artifactPath,
    sha256: state.artifact_sha256,
    finalUrl: state.artifact_final_url,
    version: state.artifact_version,
    checksum: { published: false, sourceUrl: null },
    reused: true,
  });
  fs.unlinkSync(artifactPath);
  assert.throws(() => reuseLockedRoiArtifact({ state, configPath, artifactPath }), /锁定.*缺失|missing.*locked/i);
});

test("resume atomically promotes only the exact protected locked ROI partial without downloading", () => {
  const { reuseLockedRoiArtifact } = moduleUnderTest();
  const makeCase = (name) => {
    const root = tempOperation(`rainskills-roi-partial-${name}-`);
    const configPath = path.join(root, "cluster.yaml");
    const artifactPath = path.join(root, "roi");
    const partialPath = `${artifactPath}.partial`;
    const configBytes = Buffer.from(YAML.stringify(cluster()));
    const artifactBytes = elfBinary("amd64");
    fs.writeFileSync(configPath, configBytes, { mode: 0o600 });
    fs.writeFileSync(partialPath, artifactBytes, { mode: 0o600 });
    return {
      root, configPath, artifactPath, partialPath, configBytes, artifactBytes,
      state: {
        config_sha256: sha256(configBytes), artifact_sha256: sha256(artifactBytes),
        artifact_final_url: "https://get.rainbond.com/roi/roi-amd64",
        artifact_version: "roi version v1.2.3",
        artifact_checksum_published: false, artifact_checksum_url: null,
      },
    };
  };

  const valid = makeCase("valid");
  let downloads = 0;
  const recovered = reuseLockedRoiArtifact({
    state: valid.state, configPath: valid.configPath, artifactPath: valid.artifactPath,
  }) || (() => { downloads += 1; })();
  assert.equal(downloads, 0);
  assert.equal(recovered.recoveredPartial, true);
  assert.deepEqual(fs.readFileSync(valid.artifactPath), valid.artifactBytes);
  assert.equal(fs.existsSync(valid.partialPath), false);

  for (const kind of ["digest", "mode", "symlink", "config"]) {
    const value = makeCase(kind);
    if (kind === "digest") fs.writeFileSync(value.partialPath, elfBinary("arm64"), { mode: 0o600 });
    if (kind === "mode") fs.chmodSync(value.partialPath, 0o644);
    if (kind === "symlink") {
      fs.unlinkSync(value.partialPath);
      fs.symlinkSync(path.join(value.root, "attacker"), value.partialPath);
    }
    if (kind === "config") fs.appendFileSync(value.configPath, "# changed\n");
    let invalidDownloads = 0;
    assert.throws(() => reuseLockedRoiArtifact({
      state: value.state, configPath: value.configPath, artifactPath: value.artifactPath,
    }) || (() => { invalidDownloads += 1; })(), /锁定|partial|权限|符号链接|摘要|配置|变化/i, kind);
    assert.equal(invalidDownloads, 0, `${kind} mismatch must fail before download`);
    assert.equal(fs.existsSync(value.artifactPath), false);
  }

  for (const kind of ["partial-swap", "final-create"]) {
    const value = makeCase(kind);
    const attackerBytes = Buffer.from(`attacker-${kind}`);
    assert.throws(() => reuseLockedRoiArtifact({
      state: value.state,
      configPath: value.configPath,
      artifactPath: value.artifactPath,
      publishLink(source, destination) {
        if (kind === "partial-swap") {
          fs.unlinkSync(source);
          fs.writeFileSync(source, attackerBytes, { mode: 0o600 });
        } else {
          fs.writeFileSync(destination, attackerBytes, { mode: 0o600 });
        }
        fs.linkSync(source, destination);
      },
    }), /partial|发布|竞争|存在|identity|inode|EEXIST/i, kind);
    assert.deepEqual(fs.readFileSync(value.artifactPath), attackerBytes, `${kind} must not overwrite the raced final path`);
  }
});

test("ROI execution transfers fixed bytes, invokes attached roi up, redacts logs, and saves interruption argv", async () => {
  const { executeRoiInstall } = moduleUnderTest();
  const root = tempOperation();
  const configPath = path.join(root, "cluster.yaml");
  const artifactPath = path.join(root, "roi");
  const logPath = path.join(root, "roi.log");
  const configBytes = Buffer.from(YAML.stringify(cluster()));
  const artifactBytes = elfBinary("amd64");
  fs.writeFileSync(configPath, configBytes, { mode: 0o600 });
  fs.writeFileSync(artifactPath, artifactBytes, { mode: 0o700 });
  const transfers = [];
  const states = [];
  const calls = [];
  const output = [];
  const resumeArgv = ["npx", `rainskills@${packageVersion}`, "platform", "install", "--onboarding-id", "1d6754d6-6fb3-4bda-9a04-15c2d261d178"];
  const result = await executeRoiInstall({
    bootstrap: host("node1", "10.0.0.1", { bootstrap: true }),
    configPath,
    artifactPath,
    logPath,
    remoteDir: "/root/.rainbond/rainskills/op-1",
    resumeArgv,
    transfer: async (input) => { transfers.push(input); return { remoteSha256: input.sha256 }; },
    attachedRunner: async (command, args, options) => {
      calls.push({ command, args, input: options.input });
      return {
        code: 130,
        signal: "SIGINT",
        stdout: "building\ndatabase.password: |\n  multiline-log-must-not-leak\nINFO: database: {\n  \"dsn\": \"PREFIX-LOG-MUST-NOT-LEAK\"\n}\nINFO registry status: database: {\n  \"dsn\": \"MULTI-KEY-LOG-MUST-NOT-LEAK\"\n}\nregistry password: secret\nAuthorization: Bearer AUTH-LOG-MUST-NOT-LEAK\nCookie: sid=COOKIE-LOG-MUST-NOT-LEAK\napi_key=API-LOG-MUST-NOT-LEAK\nGRJWT=GRJWT-LOG-MUST-NOT-LEAK\ntoken=FIRST-MULTI-LOG-MUST-NOT-LEAK secret={\n  nested: SECOND-MULTI-LOG-MUST-NOT-LEAK\n}\nCookie=COOKIE-MULTI-LOG-MUST-NOT-LEAK authorization={\n  nested: AUTH-MULTI-LOG-MUST-NOT-LEAK\n}",
        stderr: "masterPassword: |\n  stderr-log-must-not-leak\nINFO: privateKey: -----BEGIN PRIVATE KEY-----\nPREFIX-PEM-LOG-MUST-NOT-LEAK\n-----END PRIVATE KEY-----\n-----BEGIN PRIVATE KEY-----\nNAKED-PEM-LOG-MUST-NOT-LEAK\n-----END PRIVATE KEY-----\neyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJKV1QtTE9HLU1VU1QtTk9ULUxFQUsifQ.signature123",
      };
    },
    persistState: (state) => states.push(state),
    write: (value) => output.push(value),
  });
  assert.equal(result.interrupted, true);
  assert.equal(transfers.length, 2);
  assert.deepEqual(transfers.map(({ sha256: digest }) => digest), [sha256(configBytes), sha256(artifactBytes)]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "ssh");
  assert.deepEqual(calls[0].args.slice(-10), [
    "bash", "-s", "--", "/root/.rainbond/rainskills/op-1",
    "/root/.rainbond/rainskills/op-1/execution.receipt", resumeArgv[5], sha256(configBytes), sha256(artifactBytes),
    "/root/.rainbond/rainskills/op-1/roi", "/root/.rainbond/rainskills/op-1/cluster.yaml",
  ]);
  assert.match(calls[0].input, /receipt_text launching/);
  assert.match(calls[0].input, /receipt_text completed/);
  assert.match(calls[0].input, /"\$artifact" up -f "\$config"/);
  assert.deepEqual(states.at(-1).resumeArgv, resumeArgv);
  assert.doesNotMatch(JSON.stringify(states), /secret|database|registry|password/i);
  assert.doesNotMatch(fs.readFileSync(logPath, "utf8"), /secret|multiline-log-must-not-leak|stderr-log-must-not-leak|PREFIX-(?:LOG|PEM-LOG)|MULTI-KEY-LOG|AUTH-LOG|COOKIE-LOG|API-LOG|GRJWT-LOG|NAKED-PEM-LOG|JWT-LOG|FIRST-MULTI-LOG|SECOND-MULTI-LOG|COOKIE-MULTI-LOG|AUTH-MULTI-LOG/i);
  assert.match(fs.readFileSync(logPath, "utf8"), /\[REDACTED\]/);
  assert.match(output.join(""), new RegExp(`npx rainskills@${packageVersion.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} platform install --onboarding-id`));
  assert.doesNotMatch(output.join(""), /secret|database\.password|registry password/i);

  const terminatedStates = [];
  const terminated = await executeRoiInstall({
    bootstrap: host("node1", "10.0.0.1", { bootstrap: true }),
    configPath,
    artifactPath,
    logPath: path.join(root, "roi-term.log"),
    remoteDir: "/root/.rainbond/rainskills/op-1",
    resumeArgv,
    transfer: async (input) => ({ remoteSha256: input.sha256 }),
    attachedRunner: async () => ({ code: null, signal: "SIGTERM", stdout: "password=term-secret", stderr: "" }),
    persistState: (state) => terminatedStates.push(state),
    write: () => {},
  });
  assert.equal(terminated.signal, "SIGTERM");
  assert.equal(terminatedStates.at(-1).status, "interrupted");
  assert.deepEqual(terminatedStates.at(-1).resumeArgv, resumeArgv);
});

test("attached ROI runner registers the active child and streams only redacted progress", async () => {
  const { spawnRedactedAttached } = moduleUnderTest();
  const child = new EventEmitter();
  child.pid = 4242;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  const registered = [];
  const stdout = [];
  const stderr = [];
  const running = spawnRedactedAttached("ssh", ["fixed"], {
    spawnFn: () => child,
    registerChild: (value, detached) => registered.push({ value, detached }),
    stdoutWriter: { write: (value) => stdout.push(String(value)) },
    stderrWriter: { write: (value) => stderr.push(String(value)) },
  });
  child.stdout.write("installing step 1\npassword: |\n  must-");
  child.stdout.write("not-leak\nINFO: database: {\n  \"dsn\": \"PREFIX-JSON-MUST-");
  child.stdout.write("NOT-LEAK\"\n}\nINFO registry status: database: {\n  \"dsn\": \"MULTI-KEY-JSON-MUST-");
  child.stdout.write("NOT-LEAK\"\n}\ninstalling step 2\n");
  child.stderr.write("privateKey: |\n  stderr-must-");
  child.stderr.write("not-leak\nprivateKey: -----BEGIN PRIVATE KEY-----\nPEM-MUST-");
  child.stderr.write("NOT-LEAK\n-----END PRIVATE KEY-----\nINFO: privateKey: -----BEGIN PRIVATE KEY-----\nPREFIX-PEM-MUST-");
  child.stderr.write("NOT-LEAK\n-----END PRIVATE KEY-----\n\"database\": {\n  \"note\": \"}\"\n  \"dsn\": \"JSON-MUST-NOT-LEAK\"\n}\n\"registry\": {\n  \"auth\": \"REGISTRY-JSON-MUST-NOT-LEAK\"\n}\n");
  child.stdout.end();
  child.stderr.end();
  child.emit("close", null, "SIGINT");
  const result = await running;
  assert.equal(result.signal, "SIGINT");
  assert.equal(registered[0].value, child);
  assert.equal(registered[0].detached, false);
  assert.equal(registered.at(-1).value, null);
  assert.match(stdout.join(""), /installing step 1/);
  assert.match(`${stdout.join("")}\n${stderr.join("")}`, /\[REDACTED\]/);
  assert.doesNotMatch(`${stdout.join("")}\n${stderr.join("")}`, /must-not-leak|stderr-must|PEM-MUST|JSON-MUST|REGISTRY-JSON|PREFIX-(?:JSON|PEM)|MULTI-KEY-JSON/i);
  assert.match(stdout.join(""), /installing step 2/);
});

test("attached ROI runner sends only the fixed launch script through piped stdin", async () => {
  const { spawnRedactedAttached } = moduleUnderTest();
  const child = new EventEmitter();
  child.pid = 4247;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.kill = () => true;
  const spawnOptions = [];
  const stdin = [];
  child.stdin.on("data", (chunk) => stdin.push(chunk));
  const running = spawnRedactedAttached("ssh", ["fixed"], {
    input: "fixed-launch-script",
    spawnFn: (command, args, options) => { spawnOptions.push(options); return child; },
    stdoutWriter: { write: () => {} }, stderrWriter: { write: () => {} },
  });
  child.stdout.end();
  child.stderr.end();
  child.emit("close", 0, null);
  await running;
  assert.equal(spawnOptions[0].stdio[0], "pipe");
  assert.equal(Buffer.concat(stdin).toString("utf8"), "fixed-launch-script");
});

test("ROI streaming redaction covers auth headers, cookies, JWTs, API keys, GRJWT, and naked PEM blocks across chunks", async () => {
  const { spawnRedactedAttached } = moduleUnderTest();
  const child = new EventEmitter();
  child.pid = 4243;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.kill = () => true;
  const stdout = [];
  const stderr = [];
  const running = spawnRedactedAttached("ssh", ["fixed"], {
    spawnFn: () => child,
    stdoutWriter: { write: (value) => stdout.push(String(value)) },
    stderrWriter: { write: (value) => stderr.push(String(value)) },
  });
  child.stdout.write("installing safe step\nAuthorization: Bearer AUTH-MUST-");
  child.stdout.write("NOT-LEAK\nCookie: sid=COOKIE-MUST-NOT-LEAK\n");
  child.stdout.write("api_key=APIKEY-MUST-NOT-LEAK\nGRJWT=GRJWT-MUST-NOT-LEAK\n");
  child.stdout.write("Bearer BEARER-MUST-NOT-LEAK\n");
  child.stderr.write("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJKV1QtTVVTVC1OT1QtTEVBSyJ9.signature123\n");
  child.stderr.write("-----BEGIN PRIVATE ");
  child.stderr.write("KEY-----\nPEM-MUST-NOT-LEAK\n-----END PRIVATE KEY-----\n");
  child.stdout.end();
  child.stderr.end();
  child.emit("close", 0, null);
  const result = await running;
  const visible = `${stdout.join("")}\n${stderr.join("")}\n${result.stdout}\n${result.stderr}`;
  assert.match(visible, /installing safe step/);
  assert.match(visible, /\[REDACTED\]/);
  assert.doesNotMatch(visible, /AUTH-MUST|COOKIE-MUST|APIKEY-MUST|GRJWT-MUST|BEARER-MUST|JWT-MUST|PEM-MUST/i);
});

test("multi-sensitive lines redact from the earliest value while later candidates control block state", async () => {
  const { redactInstallLog, spawnRedactedAttached } = moduleUnderTest();
  const raw = [
    "token=FIRST-MUST-NOT-LEAK secret={",
    "  nested: SECOND-MUST-NOT-LEAK",
    "}",
    "Cookie=COOKIE-MUST-NOT-LEAK authorization={",
    "  bearer: AUTH-BLOCK-MUST-NOT-LEAK",
    "}",
    "api_key=API-MUST-NOT-LEAK privateKey: |",
    "  PRIVATE-MUST-NOT-LEAK",
    "safe progress",
  ].join("\n");
  const exact = redactInstallLog(raw);
  assert.match(exact, /token= \[REDACTED\]/);
  assert.match(exact, /Cookie= \[REDACTED\]/);
  assert.match(exact, /api_key= \[REDACTED\]/);
  assert.match(exact, /safe progress/);
  assert.doesNotMatch(exact, /FIRST-MUST|SECOND-MUST|COOKIE-MUST|AUTH-BLOCK-MUST|API-MUST|PRIVATE-MUST/i);

  const child = new EventEmitter();
  child.pid = 4246;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.kill = () => true;
  const visible = [];
  const running = spawnRedactedAttached("ssh", ["fixed"], {
    spawnFn: () => child,
    stdoutWriter: { write: (value) => visible.push(String(value)) },
    stderrWriter: { write: (value) => visible.push(String(value)) },
  });
  child.stdout.write("token=FIRST-MUST-");
  child.stdout.write("NOT-LEAK secret={\n  nested: SECOND-MUST-");
  child.stdout.write("NOT-LEAK\n}\nCookie=COOKIE-MUST-NOT-LEAK author");
  child.stdout.write("ization={\n  bearer: AUTH-BLOCK-MUST-NOT-LEAK\n}\n");
  child.stdout.write("api_key=API-MUST-NOT-LEAK privateKey: |\n  PRIVATE-MUST-");
  child.stdout.write("NOT-LEAK\nsafe progress\n");
  child.stdout.end();
  child.stderr.end();
  child.emit("close", 0, null);
  const streamed = await running;
  const streamedOutput = `${visible.join("")}\n${streamed.stdout}\n${streamed.stderr}`;
  assert.match(streamedOutput, /safe progress/);
  assert.doesNotMatch(streamedOutput, /FIRST-MUST|SECOND-MUST|COOKIE-MUST|AUTH-BLOCK-MUST|API-MUST|PRIVATE-MUST/i);
});

test("SSH and attached ROI runners kill children at a fixed output ceiling without unbounded collection", async () => {
  const { defaultSshRunner, spawnRedactedAttached } = moduleUnderTest();
  for (const kind of ["ssh", "attached"]) {
    const child = new EventEmitter();
    child.pid = kind === "ssh" ? 4244 : 4245;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    const kills = [];
    child.kill = (signal) => { kills.push(signal); return true; };
    const visible = [];
    const running = kind === "ssh"
      ? defaultSshRunner("ssh", ["fixed"], { spawnFn: () => child })
      : spawnRedactedAttached("ssh", ["fixed"], {
        spawnFn: () => child,
        stdoutWriter: { write: (value) => visible.push(String(value)) },
        stderrWriter: { write: (value) => visible.push(String(value)) },
      });
    if (kind === "attached") child.stdout.write("useful progress\n");
    child.stdout.write(Buffer.alloc(3 * 1024 * 1024, 0x61));
    child.stderr.write(Buffer.alloc(3 * 1024 * 1024, 0x62));
    await assert.rejects(running, (error) => (
      error.code === "RAINSKILLS_CHILD_OUTPUT_LIMIT"
      && error.message === "子进程输出超过安全上限"
    ));
    assert.deepEqual(kills, ["SIGKILL"], kind);
    if (kind === "attached") assert.match(visible.join(""), /useful progress/);
  }
});

test("read-only SSH children register for signals and preflight interruption stops before artifact or ROI", async () => {
  const { defaultSshRunner, installHostCluster, probeRemoteRoiVersion, runHostPreflight } = moduleUnderTest();
  const child = new EventEmitter();
  child.pid = 4343;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  const registrations = [];
  const running = defaultSshRunner("ssh", ["fixed"], {
    spawnFn: () => child,
    registerChild: (value) => registrations.push(value),
  });
  child.emit("close", null, "SIGTERM");
  const ssh = await running;
  assert.equal(ssh.signal, "SIGTERM");
  assert.equal(registrations[0], child);
  assert.equal(registrations.at(-1), null);

  const concurrentChildren = [];
  const concurrentRegistrations = new Set();
  const concurrent = runHostPreflight(cluster({
    hosts: [host("node1", "10.0.0.1", { bootstrap: true }), host("node2", "10.0.0.2")],
    roleGroups: {
      etcd: ["node1"], master: ["node1"], worker: ["node1", "node2"],
      "rbd-gateway": ["node1"], "rbd-chaos": ["node2"], "nfs-server": ["node1"],
    },
  }), {
    registerChild(value) {
      if (value) concurrentRegistrations.add(value);
      return () => concurrentRegistrations.delete(value);
    },
    sshSpawn: () => {
      const value = new EventEmitter();
      value.pid = 5000 + concurrentChildren.length;
      value.stdout = new PassThrough(); value.stderr = new PassThrough(); value.stdin = new PassThrough();
      concurrentChildren.push(value);
      if (concurrentChildren.length === 2) queueMicrotask(() => concurrentChildren.forEach((item) => item.emit("close", null, "SIGINT")));
      return value;
    },
  });
  const concurrentResult = await concurrent;
  assert.equal(concurrentResult.interrupted, true);
  assert.equal(concurrentChildren.length, 2);
  assert.equal(concurrentRegistrations.size, 0);

  const versionRoot = tempOperation("rainskills-version-interrupt-");
  const versionArtifact = path.join(versionRoot, "roi");
  fs.writeFileSync(versionArtifact, elfBinary("amd64"), { mode: 0o700 });
  const versionChildren = [];
  await assert.rejects(() => probeRemoteRoiVersion({
    bootstrap: host("node1", "10.0.0.1", { bootstrap: true }),
    artifactPath: versionArtifact,
    remoteDir: "/root/.rainbond/rainskills/op",
    transfer: async (input) => ({ remoteSha256: input.sha256 }),
    registerChild: (value) => { if (value) versionChildren.push(value); return () => {}; },
    sshSpawn: () => {
      const value = new EventEmitter();
      value.pid = 6000; value.stdout = new PassThrough(); value.stderr = new PassThrough(); value.stdin = new PassThrough();
      queueMicrotask(() => value.emit("close", null, "SIGTERM"));
      return value;
    },
  }), (error) => error.code === "RAINSKILLS_HOST_CLUSTER_INTERRUPTED" && error.signal === "SIGTERM");
  assert.equal(versionChildren.length, 1);

  const root = tempOperation("rainskills-preflight-interrupt-");
  const home = path.join(root, "home");
  fs.mkdirSync(home, { mode: 0o700 });
  const stateStore = require("./helpers/portable-secure-state.js").createPortableSecureStateStore(home);
  const source = path.join(home, "cluster.yaml");
  fs.writeFileSync(source, YAML.stringify(cluster()), { mode: 0o600 });
  const operationId = "1d6754d6-6fb3-4bda-9a04-15c2d261d178";
  const paths = { root: path.join(home, ".rainbond", "platform-installer", operationId) };
  stateStore.ensurePrivateDirectory(paths.root);
  let downloads = 0;
  let executions = 0;
  const result = await installHostCluster({
    onboarding: { operation_id: operationId }, state: { operation_id: operationId }, paths,
    options: { clusterConfig: source, yes: true },
  }, {
    stateStore,
    interactive: false,
    sessionFactory: async () => ({ controlPath: null, interactive: false }),
    closeSession: () => {},
    runPreflight: async () => ({ interrupted: true, signal: "SIGINT", blockers: [], nodes: [] }),
    acquireArtifact: async () => { downloads += 1; },
    execute: async () => { executions += 1; },
  });
  assert.equal(result.interrupted, true);
  assert.equal(downloads, 0);
  assert.equal(executions, 0);
  const driverState = stateStore.readProtectedJson(path.join(paths.root, "host-cluster", "state.json"));
  assert.equal(driverState.status, "interrupted");
});

test("remote transfer stages bytes and refuses a symlink final without overwriting it", async () => {
  const { defaultTransfer } = moduleUnderTest();
  const root = tempOperation("rainskills-remote-transfer-");
  const localPath = path.join(root, "cluster.yaml");
  const bytes = Buffer.from("safe bytes");
  fs.writeFileSync(localPath, bytes, { mode: 0o600 });
  const calls = [];
  await assert.rejects(() => defaultTransfer({
    host: "root@10.0.0.1", port: 22, localPath,
    remotePath: "/root/.rainbond/rainskills/op/cluster.yaml",
    sha256: sha256(bytes), mode: 0o600,
    runner: (command, args, options) => {
      calls.push({ command, args: [...args], input: options?.input });
      if (command === "ssh" && options?.input && String(options.input).includes("FINAL_NOT_REGULAR")) {
        return { status: 73, stdout: "", stderr: "FINAL_NOT_REGULAR" };
      }
      return { status: 0, stdout: "", stderr: "" };
    },
  }), /普通文件|regular|symlink/i);
  const scp = calls.find(({ command }) => command === "scp");
  assert(scp);
  assert.notEqual(scp.args.at(-1), "root@10.0.0.1:/root/.rainbond/rainskills/op/cluster.yaml");
  assert(calls.every(({ command, args }) => command !== "scp" || !args.at(-1).endsWith("/cluster.yaml")), "scp must never target the fixed final path");
});

test("verification children register and stage-bound aborts prevent every later side effect", async () => {
  const { inspectRemoteCluster, installHostCluster } = moduleUnderTest();
  const registered = [];
  await assert.rejects(() => inspectRemoteCluster({
    bootstrap: host("node1", "10.0.0.1", { bootstrap: true }),
    registerChild: (child) => { registered.push(child); return () => registered.push(null); },
    sshRunner: async (command, args, options) => {
      assert.equal(typeof options.registerChild, "function");
      const child = { pid: 7000 };
      const unregister = options.registerChild(child, false);
      unregister();
      return { code: null, signal: "SIGTERM", stdout: "", stderr: "" };
    },
  }), (error) => error.code === "RAINSKILLS_HOST_CLUSTER_INTERRUPTED");
  assert.equal(registered[0].pid, 7000);
  assert.equal(registered.at(-1), null);

  for (const abortAt of ["artifact", "execute"]) {
    const root = tempOperation(`rainskills-stage-abort-${abortAt}-`);
    const home = path.join(root, "home");
    fs.mkdirSync(home, { mode: 0o700 });
    const stateStore = require("./helpers/portable-secure-state.js").createPortableSecureStateStore(home);
    const source = path.join(home, "cluster.yaml");
    fs.writeFileSync(source, YAML.stringify(cluster()), { mode: 0o600 });
    const operationId = "1d6754d6-6fb3-4bda-9a04-15c2d261d178";
    const paths = { root: path.join(home, ".rainbond", "platform-installer", operationId) };
    stateStore.ensurePrivateDirectory(paths.root);
    const abortState = { aborted: false, signal: null };
    let executes = 0;
    let verifies = 0;
    const result = await installHostCluster({
      onboarding: { operation_id: operationId }, state: { operation_id: operationId }, paths,
      options: { clusterConfig: source, yes: true },
    }, {
      stateStore, abortState, interactive: false,
      sessionFactory: async () => ({ controlPath: null, interactive: false }), closeSession: () => {},
      runPreflight: async () => ({ ok: true, blockers: [], nodes: [{ name: "node1", arch: "amd64", blockers: [] }] }),
      acquireArtifact: async ({ operationDir, persistLock }) => {
        const artifactPath = path.join(operationDir, "roi");
        const artifactBytes = elfBinary("amd64");
        fs.writeFileSync(artifactPath, artifactBytes, { mode: 0o600 });
        const lock = { finalUrl: "https://get.rainbond.com/roi/roi-amd64", version: "roi version v1", sha256: sha256(artifactBytes), checksum: { published: false, sourceUrl: null } };
        persistLock(lock);
        if (abortAt === "artifact") Object.assign(abortState, { aborted: true, signal: "SIGINT" });
        return { path: artifactPath, ...lock };
      },
      execute: async () => {
        executes += 1;
        if (abortAt === "execute") Object.assign(abortState, { aborted: true, signal: "SIGTERM" });
        return { interrupted: false };
      },
      verify: async () => { verifies += 1; return { consoleUrl: "http://10.0.0.1:7070" }; },
    });
    assert.equal(result.interrupted, true, abortAt);
    assert.equal(executes, abortAt === "artifact" ? 0 : 1, abortAt);
    assert.equal(verifies, 0, abortAt);
  }
});

test("an interrupted ROI execution resumes by read-only reconciliation and never runs roi up twice", async () => {
  const { installHostCluster } = moduleUnderTest();
  const root = tempOperation("rainskills-execute-reconcile-");
  const home = path.join(root, "home");
  fs.mkdirSync(home, { mode: 0o700 });
  const stateStore = require("./helpers/portable-secure-state.js").createPortableSecureStateStore(home);
  const source = path.join(home, "cluster.yaml");
  fs.writeFileSync(source, YAML.stringify(cluster()), { mode: 0o600 });
  const operationId = "1d6754d6-6fb3-4bda-9a04-15c2d261d178";
  const originalIntent = { type: "deploy", project_root: "/workspace/app", source_kind: "local" };
  const onboarding = { operation_id: operationId, intent: structuredClone(originalIntent) };
  const paths = { root: path.join(home, ".rainbond", "platform-installer", operationId) };
  stateStore.ensurePrivateDirectory(paths.root);
  let preflights = 0;
  let downloads = 0;
  let executions = 0;
  let reconciliations = 0;
  let verifications = 0;
  const dependencies = {
    stateStore,
    interactive: false,
    sessionFactory: async () => ({ controlPath: null, interactive: false }),
    closeSession: () => {},
    runPreflight: async () => {
      preflights += 1;
      if (preflights > 1) throw new Error("existing Rainbond markers must not re-enter preflight");
      return { ok: true, blockers: [], nodes: [{ name: "node1", arch: "amd64", blockers: [] }] };
    },
    acquireArtifact: async ({ operationDir, persistLock }) => {
      downloads += 1;
      const artifactPath = path.join(operationDir, "roi");
      const bytes = elfBinary("amd64");
      fs.writeFileSync(artifactPath, bytes, { mode: 0o700 });
      const lock = { finalUrl: "https://get.rainbond.com/roi/roi-amd64", version: "roi version v1", sha256: sha256(bytes), checksum: { published: false, sourceUrl: null } };
      persistLock(lock);
      return { path: artifactPath, ...lock };
    },
    execute: async ({ persistState, resumeArgv }) => {
      executions += 1;
      persistState({ stage: "executing", status: "interrupted", resumeArgv });
      return { interrupted: true, signal: "SIGINT", resumeArgv };
    },
    reconcile: async () => {
      reconciliations += 1;
      return {
        disposition: "started",
        cluster: {
          nodes: [{ name: "node1", ready: true }],
          workloads: { "rbd-api": true, "rbd-gateway": true, "rbd-app-ui": true },
          consoleUrl: "http://10.0.0.1:7070",
        },
      };
    },
    verify: async ({ inspectCluster }) => {
      verifications += 1;
      const clusterState = await inspectCluster();
      assert.equal(clusterState.nodes[0].ready, true);
      return { consoleUrl: clusterState.consoleUrl, location: "host-cluster (1 nodes)" };
    },
  };
  const first = await installHostCluster({ onboarding, state: { operation_id: operationId }, paths, options: { clusterConfig: source, yes: true } }, dependencies);
  assert.equal(first.interrupted, true);
  assert.equal(executions, 1);

  const second = await installHostCluster({ onboarding, state: { operation_id: operationId }, paths, options: { clusterConfig: source, yes: true } }, dependencies);
  assert.equal(second.verification.consoleUrl, "http://10.0.0.1:7070");
  assert.equal(preflights, 1);
  assert.equal(downloads, 1);
  assert.equal(executions, 1);
  assert.equal(reconciliations, 1);
  assert.equal(verifications, 1);
  assert.deepEqual(onboarding.intent, originalIntent);
  const driverState = stateStore.readProtectedJson(path.join(paths.root, "host-cluster", "state.json"));
  assert.equal(driverState.stage, "completed");
  assert.deepEqual(driverState.resumeArgv, ["npx", `rainskills@${require("../package.json").version}`, "platform", "install", "--onboarding-id", operationId]);
});

test("executing resume only reuses locked bytes after reconciliation proves ROI never started", async () => {
  const { installHostCluster } = moduleUnderTest();
  const root = tempOperation("rainskills-not-started-reconcile-");
  const home = path.join(root, "home");
  fs.mkdirSync(home, { mode: 0o700 });
  const stateStore = require("./helpers/portable-secure-state.js").createPortableSecureStateStore(home);
  const operationId = "1d6754d6-6fb3-4bda-9a04-15c2d261d178";
  const paths = { root: path.join(home, ".rainbond", "platform-installer", operationId) };
  const hostRoot = path.join(paths.root, "host-cluster");
  stateStore.ensurePrivateDirectory(hostRoot);
  const configPath = path.join(hostRoot, "cluster.yaml");
  const artifactPath = path.join(hostRoot, "roi");
  const configBytes = Buffer.from(YAML.stringify(cluster()));
  const artifactBytes = elfBinary("amd64");
  fs.writeFileSync(configPath, configBytes, { mode: 0o600 });
  fs.writeFileSync(artifactPath, artifactBytes, { mode: 0o700 });
  stateStore.atomicWriteJson(path.join(hostRoot, "state.json"), {
    schema: "rainskills.host-cluster-state.v1", version: 1, operation_id: operationId,
    stage: "executing", status: "interrupted", config_path: configPath,
    config_sha256: sha256(configBytes), artifact_sha256: sha256(artifactBytes),
    artifact_final_url: "https://get.rainbond.com/roi/roi-amd64", artifact_version: "roi version v1",
    execution_approved: true,
  });
  let executions = 0;
  let preflights = 0;
  let downloads = 0;
  const result = await installHostCluster({
    onboarding: { operation_id: operationId }, state: { operation_id: operationId }, paths,
    options: { yes: true },
  }, {
    stateStore, interactive: false,
    sessionFactory: async () => ({ controlPath: null, interactive: false }), closeSession: () => {},
    runPreflight: async () => { preflights += 1; throw new Error("must not preflight"); },
    acquireArtifact: async () => { downloads += 1; throw new Error("must not download"); },
    reconcile: async () => ({ disposition: "not_started", ownershipVerified: true, bytesVerified: true }),
    execute: async () => { executions += 1; return { interrupted: false }; },
    verify: async () => ({ consoleUrl: "http://10.0.0.1:7070" }),
  });
  assert.equal(result.verification.consoleUrl, "http://10.0.0.1:7070");
  assert.equal(executions, 1);
  assert.equal(preflights, 0);
  assert.equal(downloads, 0);
});

test("unknown host resume state reconciles read-only then blocks with the fixed resume command", async () => {
  const { installHostCluster } = moduleUnderTest();
  const root = tempOperation("rainskills-unknown-reconcile-");
  const home = path.join(root, "home");
  fs.mkdirSync(home, { mode: 0o700 });
  const stateStore = require("./helpers/portable-secure-state.js").createPortableSecureStateStore(home);
  const operationId = "1d6754d6-6fb3-4bda-9a04-15c2d261d178";
  const paths = { root: path.join(home, ".rainbond", "platform-installer", operationId) };
  const hostRoot = path.join(paths.root, "host-cluster");
  stateStore.ensurePrivateDirectory(hostRoot);
  const configPath = path.join(hostRoot, "cluster.yaml");
  const configBytes = Buffer.from(YAML.stringify(cluster()));
  fs.writeFileSync(configPath, configBytes, { mode: 0o600 });
  stateStore.atomicWriteJson(path.join(hostRoot, "state.json"), {
    schema: "rainskills.host-cluster-state.v1", version: 1, operation_id: operationId,
    stage: "future-stage", status: "interrupted", config_path: configPath,
    config_sha256: sha256(configBytes),
  });
  const output = [];
  let reconciliations = 0;
  let sideEffects = 0;
  const result = await installHostCluster({
    onboarding: { operation_id: operationId }, state: { operation_id: operationId }, paths,
    options: { yes: true },
  }, {
    stateStore, interactive: false, write: (value) => output.push(value),
    sessionFactory: async () => ({ controlPath: null, interactive: false }), closeSession: () => {},
    reconcile: async () => { reconciliations += 1; return { disposition: "unknown" }; },
    runPreflight: async () => { sideEffects += 1; }, acquireArtifact: async () => { sideEffects += 1; },
    execute: async () => { sideEffects += 1; }, verify: async () => { sideEffects += 1; },
  });
  assert.equal(result.waiting, true);
  assert.equal(result.blocked, true);
  assert.equal(reconciliations, 1);
  assert.equal(sideEffects, 0);
  assert.match(output.join(""), /RAINSKILLS_ACTION_REQUIRED:host_cluster_resume_blocked/);
  assert.deepEqual(result.resumeArgv, ["npx", `rainskills@${require("../package.json").version}`, "platform", "install", "--onboarding-id", operationId]);
});

test("verifying and completed host stages only run verification and completion", async () => {
  const { installHostCluster } = moduleUnderTest();
  for (const stage of ["verifying", "completed"]) {
    const root = tempOperation(`rainskills-${stage}-only-`);
    const home = path.join(root, "home");
    fs.mkdirSync(home, { mode: 0o700 });
    const stateStore = require("./helpers/portable-secure-state.js").createPortableSecureStateStore(home);
    const operationId = "1d6754d6-6fb3-4bda-9a04-15c2d261d178";
    const paths = { root: path.join(home, ".rainbond", "platform-installer", operationId) };
    const hostRoot = path.join(paths.root, "host-cluster");
    stateStore.ensurePrivateDirectory(hostRoot);
    const configPath = path.join(hostRoot, "cluster.yaml");
    const configBytes = Buffer.from(YAML.stringify(cluster()));
    fs.writeFileSync(configPath, configBytes, { mode: 0o600 });
    stateStore.atomicWriteJson(path.join(hostRoot, "state.json"), {
      schema: "rainskills.host-cluster-state.v1", version: 1, operation_id: operationId,
      stage, status: stage === "completed" ? "completed" : "running", config_path: configPath,
      config_sha256: sha256(configBytes),
    });
    let verifications = 0;
    let other = 0;
    const result = await installHostCluster({
      onboarding: { operation_id: operationId }, state: { operation_id: operationId }, paths, options: {},
    }, {
      stateStore, interactive: false,
      sessionFactory: async () => ({ controlPath: null, interactive: false }), closeSession: () => {},
      verify: async () => { verifications += 1; return { consoleUrl: "http://10.0.0.1:7070" }; },
      runPreflight: async () => { other += 1; }, acquireArtifact: async () => { other += 1; },
      execute: async () => { other += 1; }, reconcile: async () => { other += 1; },
    });
    assert.equal(result.verification.consoleUrl, "http://10.0.0.1:7070");
    assert.equal(verifications, 1, stage);
    assert.equal(other, 0, stage);
  }
});

test("production host reconciliation verifies operation ownership and bytes before cluster health", async () => {
  const { reconcileHostExecution } = moduleUnderTest();
  const calls = [];
  let inspections = 0;
  const digestA = "a".repeat(64);
  const digestB = "b".repeat(64);
  const operationId = "1d6754d6-6fb3-4bda-9a04-15c2d261d178";
  const healthy = await reconcileHostExecution({
    bootstrap: host("node1", "10.0.0.1", { bootstrap: true }),
    remoteDir: "/root/.rainbond/rainskills/op-1",
    operationId,
    configSha256: digestA,
    artifactSha256: digestB,
    session: { controlPath: "/protected/control", interactive: false },
    sshRunner: async (command, args, options) => {
      calls.push({ command, args, input: options.input });
      return { code: 0, stdout: "OWNERSHIP_VERIFIED=true\nBYTES_VERIFIED=true\nRECEIPT_PRESENT=true\nRECEIPT_PHASE=completed\nSTARTED=true\n", stderr: "" };
    },
    inspectCluster: async () => {
      inspections += 1;
      return { nodes: [{ name: "node1", ready: true }], workloads: {}, consoleUrl: "http://10.0.0.1:7070" };
    },
  });
  assert.equal(healthy.disposition, "started");
  assert.equal(inspections, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "ssh");
  assert.deepEqual(calls[0].args.slice(0, 4), ["-o", "BatchMode=yes", "-o", "ControlPath=/protected/control"]);
  assert.deepEqual(calls[0].args.slice(-10), [
    "bash", "-s", "--", "/root/.rainbond/rainskills/op-1",
    "/root/.rainbond/rainskills/op-1/cluster.yaml", "/root/.rainbond/rainskills/op-1/roi",
    "/root/.rainbond/rainskills/op-1/execution.receipt", operationId, digestA, digestB,
  ]);
  assert.match(calls[0].input, /OWNERSHIP_VERIFIED/);

  for (const started of [false, true]) {
    const incomplete = await reconcileHostExecution({
      bootstrap: host("node1", "10.0.0.1", { bootstrap: true }),
      remoteDir: "/root/.rainbond/rainskills/op-1",
      operationId,
      configSha256: digestA,
      artifactSha256: digestB,
      sshRunner: async () => ({
        code: 0,
        stdout: `OWNERSHIP_VERIFIED=true\nBYTES_VERIFIED=true\nRECEIPT_PRESENT=true\nRECEIPT_PHASE=launching\nSTARTED=${started}\n`,
        stderr: "",
      }),
      inspectCluster: async () => { inspections += 1; return {}; },
    });
    assert.equal(incomplete.disposition, "unknown", `launching started=${started}`);
    assert.equal(incomplete.reason, "operation_launch_incomplete", `launching started=${started}`);
    assert.equal(inspections, 1, "launching receipt must never adopt or inspect a cluster");
  }

  const unrelated = await reconcileHostExecution({
    bootstrap: host("node1", "10.0.0.1", { bootstrap: true }),
    remoteDir: "/root/.rainbond/rainskills/op-1",
    operationId,
    configSha256: digestA,
    artifactSha256: digestB,
    sshRunner: async () => ({ code: 0, stdout: "OWNERSHIP_VERIFIED=true\nBYTES_VERIFIED=true\nRECEIPT_PRESENT=false\nRECEIPT_PHASE=absent\nSTARTED=true\n", stderr: "" }),
    inspectCluster: async () => { inspections += 1; return {}; },
  });
  assert.equal(unrelated.disposition, "unknown");
  assert.equal(unrelated.reason, "external_cluster_detected_without_operation_marker");
  assert.equal(inspections, 1, "an unrelated cluster must not be adopted or inspected as this operation");
});

test("cluster verification requires expected Ready nodes, critical workloads, and reachable Console", async () => {
  const { verifyHostCluster } = moduleUnderTest();
  const verified = await verifyHostCluster({
    expectedNodes: ["node1", "node2"],
    inspectCluster: async () => ({
      nodes: [{ name: "node1", ready: true }, { name: "node2", ready: true }],
      workloads: {
        "rbd-api": true, "rbd-gateway": true, "rbd-app-ui": true,
      },
      consoleUrl: "http://10.0.0.1:7070",
    }),
    probeConsole: async () => 200,
  });
  assert.equal(verified.consoleUrl, "http://10.0.0.1:7070");
  assert.equal(verified.location, "host-cluster (2 nodes)");

  await assert.rejects(() => verifyHostCluster({
    expectedNodes: ["node1", "node2"],
    inspectCluster: async () => ({ nodes: [{ name: "node1", ready: true }], workloads: {}, consoleUrl: "http://10.0.0.1:7070" }),
    probeConsole: async () => 200,
  }), /node2|Ready/i);
  await assert.rejects(() => verifyHostCluster({
    expectedNodes: ["node1"],
    inspectCluster: async () => ({ nodes: [{ name: "node1", ready: true }], workloads: { "rbd-api": true }, consoleUrl: "http://10.0.0.1:7070" }),
    probeConsole: async () => 200,
  }), /rbd-gateway|rbd-app-ui/i);
  await assert.rejects(() => verifyHostCluster({
    expectedNodes: ["node1"],
    inspectCluster: async () => ({ nodes: [{ name: "node1", ready: true }], workloads: { "rbd-api": true, "rbd-gateway": true, "rbd-app-ui": true }, consoleUrl: "http://10.0.0.1:7070" }),
    probeConsole: async () => { throw new Error("offline"); },
  }), /Console/i);
});

test("cluster verification inspector uses fixed SSH argv and parses Kubernetes JSON", async () => {
  const { inspectRemoteCluster } = moduleUnderTest();
  const calls = [];
  const responses = [
    { code: 0, stdout: JSON.stringify({ items: [
      { metadata: { name: "node1" }, status: { conditions: [{ type: "Ready", status: "True" }] } },
    ] }) },
    { code: 0, stdout: JSON.stringify({ items: [
      { metadata: { name: "rbd-api" }, status: { availableReplicas: 1 } },
      { metadata: { name: "rbd-gateway" }, status: { numberReady: 1 } },
      { metadata: { name: "rbd-app-ui" }, status: { readyReplicas: 1 } },
    ] }) },
  ];
  const result = await inspectRemoteCluster({
    bootstrap: host("node1", "10.0.0.1", { bootstrap: true }),
    sshRunner: async (command, args) => {
      calls.push({ command, args });
      return responses.shift();
    },
  });
  assert.equal(calls.length, 2);
  assert(calls.every(({ command, args }) => command === "ssh" && Array.isArray(args)));
  assert.deepEqual(calls[0].args.slice(-6), ["kubectl", "get", "nodes", "-o", "json", "--request-timeout=30s"]);
  assert.deepEqual(calls[1].args.slice(-8), ["kubectl", "get", "deployments,statefulsets,daemonsets", "-n", "rbd-system", "-o", "json", "--request-timeout=30s"]);
  assert.deepEqual(result.nodes, [{ name: "node1", ready: true }]);
  assert.deepEqual(result.workloads, { "rbd-api": true, "rbd-gateway": true, "rbd-app-ui": true });
  assert.equal(result.consoleUrl, "http://10.0.0.1:7070");
});
