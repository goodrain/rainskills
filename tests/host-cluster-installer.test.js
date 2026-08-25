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
        password: "fixture-password",
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
    password: "fixture-password",
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

function userMessageBody(output, messageId) {
  const begin = `[RAINSKILLS_USER_MESSAGE_BEGIN:${messageId}]\n`;
  const end = `\n[RAINSKILLS_USER_MESSAGE_END:${messageId}]`;
  const start = output.indexOf(begin);
  assert.notEqual(start, -1, `missing user message ${messageId}`);
  const finish = output.indexOf(end, start + begin.length);
  assert.notEqual(finish, -1, `unterminated user message ${messageId}`);
  return output.slice(start + begin.length, finish);
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

test("topology requires a non-empty ROI password for every host without reflecting it", () => {
  const { validateClusterTopology } = moduleUnderTest();
  for (const password of [undefined, "", "   ", 123]) {
    const value = cluster();
    value.hosts[0].password = password;
    assert.throws(() => validateClusterTopology(value), /password.*未填写|password.*必填/i);
  }
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

test("imported topology strictly rejects malformed IP and DNS addresses while preserving valid host forms", () => {
  const { diagnoseClusterConfig, validateClusterTopology } = moduleUnderTest();
  const malformed = [
    { field: "address", value: "1:2:3" },
    { field: "internalAddress", value: "a.-b.example" },
    { field: "address", value: `${"a".repeat(64)}.example` },
  ];
  for (const { field, value } of malformed) {
    const invalid = cluster();
    invalid.hosts[0][field] = value;
    assert.throws(() => validateClusterTopology(invalid), new RegExp(`${field}.*无效|无效.*${field}`));
    const diagnostic = diagnoseClusterConfig(Buffer.from(YAML.stringify(invalid)), { source: "imported-file" });
    assert.match(diagnostic.issues.join("\n"), new RegExp(`${field}.*无效|无效.*${field}`));
  }

  for (const [address, internalAddress] of [
    ["192.0.2.10", "10.0.0.10"],
    ["2001:db8::10", "fd00::10"],
    ["Gateway.Example.com", "node-10.internal"],
    ["ssh-alias", "node-10"],
  ]) {
    const valid = cluster();
    Object.assign(valid.hosts[0], { address, internalAddress });
    assert.doesNotThrow(() => validateClusterTopology(valid));
    assert.deepEqual(
      diagnoseClusterConfig(Buffer.from(YAML.stringify(valid)), { source: "imported-file" }).issues,
      [],
    );
  }
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

test("one-shot cluster template includes blank protected password fields and requires them before ROI", () => {
  const {
    createHostClusterTemplate,
    diagnoseClusterConfig,
    parseClusterDocument,
  } = moduleUnderTest();
  const bytes = createHostClusterTemplate();
  const text = bytes.toString("utf8");
  const value = parseClusterDocument(bytes).value;
  assert.equal(value.hosts.length, 3);
  assert.deepEqual(value.hosts.map((item) => item.password), ["", "", ""]);
  assert.equal(text.split("对应服务器的 root 密码，只在本地文件中填写").length - 1, 1);
  assert.deepEqual(value.roleGroups.etcd, ["node1", "node2", "node3"]);
  const diagnostic = diagnoseClusterConfig(bytes, { source: "generated-template" });
  assert.equal(diagnostic.value.hosts.length, 3);
  assert.deepEqual(diagnostic.issues, [
    "节点 node1 的 password 未填写",
    "请把 hosts.node1.address 和 internalAddress 改为真实服务器地址",
    "节点 node2 的 password 未填写",
    "请把 hosts.node2.address 和 internalAddress 改为真实服务器地址",
    "节点 node3 的 password 未填写",
    "请把 hosts.node3.address 和 internalAddress 改为真实服务器地址",
  ]);

  value.hosts.forEach((item, index) => {
    item.address = `10.0.0.${index + 1}`;
    item.internalAddress = item.address;
    item.password = `fixture-password-${index + 1}`;
  });
  assert.deepEqual(
    diagnoseClusterConfig(Buffer.from(YAML.stringify(value)), { source: "generated-template" }).issues,
    [],
  );
});

test("one-shot cluster template explains each field once without changing the existing structure", () => {
  const { createHostClusterTemplate, parseClusterDocument } = moduleUnderTest();
  const bytes = createHostClusterTemplate();
  const text = bytes.toString("utf8");
  const value = parseClusterDocument(bytes).value;

  for (const guidance of [
    "以下 IP 均为示例地址，必须替换成真实服务器地址",
    "节点名称，集群内必须唯一",
    "SSH 地址，请改成服务器 IP 或域名",
    "节点内网通信地址；没有独立内网时与 address 相同",
    "SSH 用户，当前使用 root",
    "对应服务器的 root 密码，只在本地文件中填写",
    "SSH 端口",
    "引导节点，只能配置一个且必须属于 master",
    "etcd 节点数必须是正奇数",
    "内置 NFS 只能指定一个节点",
    "没有外部镜像仓库时保持 false",
    "没有外部数据库时保持 false",
  ]) {
    assert.equal(text.split(guidance).length - 1, 1, `guidance must appear once: ${guidance}`);
  }

  assert.deepEqual(value, {
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
});

function serverInputSection(index, overrides = {}) {
  const values = {
    public_ip: `203.0.113.${index}`,
    private_ip: `10.0.0.${index}`,
    ssh_port: "22",
    password: `fixture-password-${index}`,
    ...overrides,
  };
  return [
    `[server-${index}]`,
    `public_ip=${values.public_ip}`,
    `private_ip=${values.private_ip}`,
    `ssh_port=${values.ssh_port}`,
    `password=${values.password}`,
  ].join("\n");
}

function serverInput(count, overrides = {}) {
  return Array.from({ length: count }, (_, index) => (
    serverInputSection(index + 1, overrides[index + 1])
  )).join("\n\n");
}

function hostClusterWorkflowFixture(prefix = "rainskills-host-server-input-") {
  const root = tempOperation(prefix);
  const home = path.join(root, "home");
  fs.mkdirSync(home, { mode: 0o700 });
  const stateStore = require("./helpers/portable-secure-state.js").createPortableSecureStateStore(home);
  const operationId = "1d6754d6-6fb3-4bda-9a04-15c2d261d178";
  const paths = { root: path.join(home, ".rainbond", "platform-installer", operationId) };
  stateStore.ensurePrivateDirectory(paths.root);
  const hostRoot = path.join(paths.root, "host-cluster");
  return {
    operationId,
    paths,
    hostRoot,
    statePath: path.join(hostRoot, "state.json"),
    configPath: path.join(hostRoot, "cluster.yaml"),
    serverInputPath: path.join(hostRoot, "servers.txt"),
    stateStore,
    context: {
      onboarding: { operation_id: operationId },
      state: { operation_id: operationId },
      paths,
      options: { yes: true },
    },
  };
}

test("generated-server-input descriptor reader never requests more than the 1 MiB protected limit", () => {
  const { readProtectedServerInput } = moduleUnderTest();
  assert.equal(typeof readProtectedServerInput, "function");
  const maximumBytes = 1024 * 1024;
  const source = Buffer.alloc(maximumBytes, 0x20);
  let closed = 0;
  let largestRead = 0;
  const bytes = readProtectedServerInput("/protected/servers.txt", {
    platform: "linux",
    currentUid: 501,
    stateStore: { assertProtectedRegularFile: () => {} },
    fsImpl: {
      constants: { O_RDONLY: 0, O_NOFOLLOW: 0x100 },
      openSync: () => 7,
      fstatSync: () => ({
        isFile: () => true,
        isSymbolicLink: () => false,
        uid: 501,
        mode: 0o100600,
        size: maximumBytes,
      }),
      readFileSync: () => assert.fail("descriptor reader must not use an unbounded read"),
      readSync(fd, destination, offset, length, position) {
        assert.equal(fd, 7);
        largestRead = Math.max(largestRead, length);
        if (position >= source.length) return 0;
        const count = Math.min(length, source.length - position);
        source.copy(destination, offset, position, position + count);
        return count;
      },
      closeSync: () => { closed += 1; },
    },
  });
  assert.equal(bytes.length, maximumBytes);
  assert(largestRead <= maximumBytes);
  assert.equal(closed, 2);
});

test("generated-server-input Windows reads bind both ACL identities to descriptor bytes and reject replacement", () => {
  const { readProtectedServerInput } = moduleUnderTest();
  const original = Buffer.from("original protected bytes");
  const replacement = Buffer.from("replacement fd bytes");
  const identity = (bytes) => `sha256:${sha256(bytes)}:${bytes.length}`;
  const fsImpl = {
    constants: { O_RDONLY: 0 },
    openSync: () => 11,
    fstatSync: () => ({
      isFile: () => true,
      isSymbolicLink: () => false,
      uid: 501,
      mode: 0o100600,
      dev: 1,
      ino: 2,
      size: replacement.length,
      mtimeMs: 3,
      ctimeMs: 4,
    }),
    readSync(fd, destination, offset, length, position) {
      assert.equal(fd, 11);
      if (position >= replacement.length) return 0;
      const count = Math.min(length, replacement.length - position);
      replacement.copy(destination, offset, position, position + count);
      return count;
    },
    closeSync: () => {},
  };

  assert.throws(() => readProtectedServerInput("C:\\protected\\servers.txt", {
    platform: "win32",
    currentUid: null,
    fsImpl,
    stateStore: {
      assertProtectedRegularFile: () => {},
      assertSafeExternalRegularFile: () => ({ fileIdentity: identity(original) }),
    },
  }), /ACL.*identity|ACL.*身份|身份.*ACL/i, "the ACL-authorized bytes must match both descriptor reads");

  let inspections = 0;
  assert.throws(() => readProtectedServerInput("C:\\protected\\servers.txt", {
    platform: "win32",
    currentUid: null,
    fsImpl,
    stateStore: {
      assertProtectedRegularFile: () => {},
      assertSafeExternalRegularFile: () => ({
        fileIdentity: inspections++ === 0 ? identity(replacement) : identity(original),
      }),
    },
  }), /ACL.*identity|ACL.*身份|身份.*ACL/i, "a replacement between ACL inspections must fail closed");
  assert.equal(inspections, 2);
});

test("generated-server-input POSIX reads twice and rejects same-inode same-size content replacement", () => {
  const { readProtectedServerInput } = moduleUnderTest();
  const firstBytes = Buffer.from("first protected bytes!");
  const secondBytes = Buffer.from("other protected bytes!");
  assert.equal(firstBytes.length, secondBytes.length);
  let opens = 0;
  let stats = 0;
  let assertions = 0;
  const byFd = new Map();
  assert.throws(() => readProtectedServerInput("/protected/servers.txt", {
    platform: "linux",
    currentUid: 501,
    stateStore: { assertProtectedRegularFile: () => { assertions += 1; } },
    fsImpl: {
      constants: { O_RDONLY: 0, O_NOFOLLOW: 0x100 },
      openSync() {
        opens += 1;
        const fd = 20 + opens;
        byFd.set(fd, opens === 1 ? firstBytes : secondBytes);
        return fd;
      },
      fstatSync: () => {
        stats += 1;
        return {
          isFile: () => true,
          isSymbolicLink: () => false,
          uid: 501,
          mode: 0o100600,
          dev: 9,
          ino: 10,
          size: firstBytes.length,
          mtimeMs: 11,
          ctimeMs: 12,
        };
      },
      readSync(fd, destination, offset, length, position) {
        const source = byFd.get(fd);
        if (position >= source.length) return 0;
        const count = Math.min(length, source.length - position);
        source.copy(destination, offset, position, position + count);
        return count;
      },
      closeSync: () => {},
    },
  }), /读取期间.*变化|字节.*变化|digest|identity/i);
  assert.equal(opens, 2);
  assert.equal(stats, 4, "each bounded descriptor read must fstat before and after");
  assert.equal(assertions, 2);
});

test("servers.txt template has Chinese guidance and three editable server input sections", () => {
  const { createHostServerInputTemplate } = moduleUnderTest();
  const bytes = createHostServerInputTemplate();
  assert(Buffer.isBuffer(bytes));
  const text = bytes.toString("utf8");

  const expectedGuidance = [
    "# Rainbond 多节点服务器信息",
    "# 密码只写入受保护的本地和远端安装文件，不会写入聊天、日志或状态；不要填写私钥或 Token。",
    "# 超过三台服务器时，复制完整的 [server-N] 区块并按顺序编号。",
  ];
  assert.deepEqual(text.split("\n").slice(0, 3), expectedGuidance);
  assert.deepEqual([...text.matchAll(/^\[server-(\d+)\]$/gm)].map((match) => match[1]), ["1", "2", "3"]);
  for (const field of ["public_ip", "private_ip", "ssh_port", "password"]) {
    assert.equal(text.match(new RegExp(`^${field}=`, "gm"))?.length, 3, field);
  }
  for (const guidance of [
    "# 公网 IP：控制端通过 SSH 访问该服务器的地址；没有独立公网 IP 时可与内网 IP 相同",
    "# 内网 IP：集群节点之间通信使用的地址",
    "# SSH 端口：按服务器实际端口填写，不要求为 22",
    "# root 密码：保留所有特殊字符；不要添加引号",
  ]) {
    assert.equal(text.split(guidance).length - 1, 3, guidance);
  }
  assert.doesNotMatch(text, /cluster\.yaml|YAML|角色/);
});

test("servers.txt prompt links the file and provides native open commands without YAML or role editing", () => {
  const { renderHostServerInputPrompt } = moduleUnderTest();
  const posixPath = "/Users/example user/.rainbond/platform-installer/op/host-cluster/servers.txt";
  const windowsPath = "C:\\Users\\example user\\.rainbond\\platform-installer\\op\\host-cluster\\servers.txt";

  const macOS = renderHostServerInputPrompt({ inputPath: posixPath, platform: "darwin" });
  assert.match(macOS, new RegExp(`\\[点击打开 servers\\.txt\\]\\(<${posixPath.replace(/\./g, "\\.").replace(/ /g, "%20")}>\\)`));
  assert.match(macOS, /open '\/Users\/example user\/.*servers\.txt'/);
  assert.match(macOS, /public_ip、private_ip、ssh_port 和 password/);
  assert.match(macOS, /公网 IP：控制端 SSH 地址；没有独立公网 IP 时可与内网 IP 相同。/);
  assert.match(macOS, /内网 IP：节点通信地址。/);
  assert.match(macOS, /SSH 端口：填写每台服务器的实际端口，不强制为 22。/);
  assert.match(macOS, /root 密码：只写入受保护的本地和远端安装文件，不得发送到聊天。/);
  assert.match(macOS, /密码只写入受保护的本地和远端安装文件，不会写入聊天、日志或状态；不要填写私钥或 Token。/);
  assert.doesNotMatch(macOS, /密码只保存在这个受保护的本地文件/);
  assert.match(macOS, /回复“已完成”/);
  assert.doesNotMatch(macOS, /cluster\.yaml|YAML|角色/);

  assert.match(
    renderHostServerInputPrompt({ inputPath: posixPath, platform: "linux" }),
    /xdg-open '\/Users\/example user\/.*servers\.txt'/,
  );
  const windows = renderHostServerInputPrompt({ inputPath: windowsPath, platform: "win32" });
  assert.match(windows, /explorer\.exe "C:\\Users\\example user\\.*servers\.txt"/);
  assert.match(windows, /\[点击打开 servers\.txt\]\(<C:\/Users\/example%20user\//);
});

test("server input accepts UTF-8 BOM and CRLF and preserves password characters after the first equals", () => {
  const { parseHostServerInput } = moduleUnderTest();
  const sentinel = "  MUST-NOT-LEAK=part#tail  ";
  const text = `\ufeff# 注释\r\n\r\n${serverInput(3, {
    1: { password: sentinel, ssh_port: " 1 " },
    2: { ssh_port: "65535" },
    3: { public_ip: "2001:db8::3", private_ip: "node-3.internal" },
  }).replace(/\n/g, "\r\n")}`;
  const result = parseHostServerInput(Buffer.from(text, "utf8"));

  assert.deepEqual(result.issues, []);
  assert.equal(result.hosts.length, 3);
  assert.equal(result.hosts[0].password, sentinel);
  assert.equal(result.hosts[0].sshPort, 1);
  assert.equal(result.hosts[1].sshPort, 65535);
  assert.equal(result.hosts[2].publicIp, "2001:db8::3");
  assert.equal(result.hosts[2].privateIp, "node-3.internal");
});

test("server input aggregates strict section and field errors without reflecting password values", () => {
  const { parseHostServerInput } = moduleUnderTest();
  const sentinel = "MUST-NOT-LEAK-SERVER-INPUT-SECRET";
  const text = [
    "[server-1]",
    "public_ip=203.0.113.1",
    "public_ip=203.0.113.9",
    "private_ip=10.0.0.1",
    "ssh_port=22",
    `password=${sentinel}`,
    "unknown=value",
    "",
    "[server-1]",
    "public_ip=203.0.113.2",
    "private_ip=10.0.0.2",
    "ssh_port=22",
    `password=${sentinel}`,
    "",
    "[server-3]",
    "public_ip=203.0.113.3",
    "ssh_port=22",
    "password=   ",
    "",
    "[other]",
    "public_ip=203.0.113.4",
  ].join("\n");
  const result = parseHostServerInput(text);
  const report = result.issues.join("\n");

  assert(result.issues.length >= 6, report);
  assert.match(report, /重复.*server-1|server-1.*重复/);
  assert.match(report, /区块.*连续|连续.*区块/);
  assert.match(report, /public_ip.*重复|重复.*public_ip/);
  assert.match(report, /未知字段/);
  assert.match(report, /private_ip.*缺失|缺失.*private_ip/);
  assert.match(report, /password.*空|password.*未填写/);
  assert.match(report, /未知区块/);
  assert.doesNotMatch(report, new RegExp(sentinel));
});

test("server input rejects NUL and other control characters without leaking the affected values", () => {
  const { parseHostServerInput } = moduleUnderTest();
  const sentinel = "MUST-NOT-LEAK-CONTROL-SECRET";
  const result = parseHostServerInput(`${serverInput(3)}\n# ${sentinel}\u0000\npassword=${sentinel}\u0007`);
  const report = result.issues.join("\n");
  assert.match(report, /控制字符|NUL/);
  assert.doesNotMatch(report, new RegExp(sentinel));
});

test("server input rejects Unicode C1 controls inside passwords without leaking their values", () => {
  const { parseHostServerInput } = moduleUnderTest();
  const sentinel = "MUST-NOT-LEAK-C1-SECRET";
  const result = parseHostServerInput(serverInput(3, {
    2: { password: `${sentinel}\u0085tail` },
  }));
  const report = result.issues.join("\n");
  assert.match(report, /控制字符/);
  assert.doesNotMatch(report, new RegExp(sentinel));
});

test("server input rejects section numbers with leading zeroes", () => {
  const { parseHostServerInput } = moduleUnderTest();
  const input = serverInput(3).replace("[server-1]", "[server-01]");
  assert.match(parseHostServerInput(input).issues.join("\n"), /区块编号.*连续|连续.*区块编号/);
});

test("server input enforces node count and file size limits", () => {
  const { parseHostServerInput } = moduleUnderTest();
  assert.match(parseHostServerInput(serverInput(2)).issues.join("\n"), /至少.*3|3.*节点/);
  assert.match(parseHostServerInput(serverInput(101)).issues.join("\n"), /最多.*100|100.*节点/);
  assert.match(parseHostServerInput(Buffer.alloc(1024 * 1024 + 1, 0x20)).issues.join("\n"), /1 MiB|大小/);
});

test("server input bounds dense diagnostics and stops collecting after server-100", () => {
  const { parseHostServerInput } = moduleUnderTest();
  const denseErrors = Array.from({ length: 500 }, (_, index) => `unknown_${index}=value`).join("\n");
  const denseResult = parseHostServerInput(`${serverInput(3)}\n${denseErrors}`);
  assert(denseResult.issues.length <= 201, `unbounded diagnostics: ${denseResult.issues.length}`);
  assert.match(denseResult.issues.at(-1), /诊断.*截断|问题.*过多/);

  const nodeLimitResult = parseHostServerInput(`${serverInput(101)}\n${denseErrors}`);
  assert.equal(nodeLimitResult.hosts.length, 100);
  assert.match(nodeLimitResult.issues.join("\n"), /最多.*100|100.*节点/);
  assert(nodeLimitResult.issues.length <= 201, `unbounded diagnostics: ${nodeLimitResult.issues.length}`);
});

test("server input size limit is byte-exact and malformed UTF-8 fails closed", () => {
  const { parseHostServerInput } = moduleUnderTest();
  const maximumBytes = 1024 * 1024;
  const validPrefix = Buffer.from(`${serverInput(3)}\n#`, "utf8");
  const exactLimit = Buffer.concat([validPrefix, Buffer.alloc(maximumBytes - validPrefix.length, 0x20)]);
  assert.equal(exactLimit.length, maximumBytes);
  assert.doesNotMatch(parseHostServerInput(exactLimit).issues.join("\n"), /1 MiB|大小/);

  const multibyteOverflow = Buffer.from(`#${"界".repeat(Math.ceil(maximumBytes / 3))}`, "utf8");
  assert(multibyteOverflow.length > maximumBytes);
  assert.match(parseHostServerInput(multibyteOverflow).issues.join("\n"), /1 MiB|大小/);
  assert.match(parseHostServerInput(Buffer.from([0xc3, 0x28])).issues.join("\n"), /UTF-8/);
});

test("server input validates address and port boundaries while allowing distinct ports on one public IP", () => {
  const { parseHostServerInput } = moduleUnderTest();
  const valid = parseHostServerInput(serverInput(3, {
    1: { public_ip: "gateway.example.com", ssh_port: "1" },
    2: { public_ip: "gateway.example.com", ssh_port: "65535" },
    3: { public_ip: "2001:db8::3", private_ip: "fd00::3", ssh_port: "2222" },
  }));
  assert.deepEqual(valid.issues, []);

  const invalid = parseHostServerInput(serverInput(3, {
    1: { public_ip: "-bad.example", ssh_port: "0" },
    2: { private_ip: "bad..internal", ssh_port: "65536" },
    3: { ssh_port: "22.5" },
  }));
  const report = invalid.issues.join("\n");
  assert.match(report, /server-1.*public_ip|public_ip.*server-1/);
  assert.match(report, /server-2.*private_ip|private_ip.*server-2/);
  assert.equal(invalid.issues.filter((issue) => /ssh_port/.test(issue)).length, 3);
});

test("server input rejects malformed IPv6 and DNS labels", () => {
  const { parseHostServerInput } = moduleUnderTest();
  const result = parseHostServerInput(serverInput(3, {
    1: { public_ip: ":::" },
    2: { private_ip: "1:2:3:4:5:6:7:8:9" },
    3: { public_ip: "a.-b.example" },
  }));
  assert.equal(result.issues.filter((issue) => /地址无效/.test(issue)).length, 3, result.issues.join("\n"));
});

test("generated-server-input rejects IPv6 zone ids as fixed invalid-address diagnostics in TXT and imported YAML", () => {
  const { diagnoseClusterConfig, parseHostServerInput, validateClusterTopology } = moduleUnderTest();
  let parsed;
  assert.doesNotThrow(() => {
    parsed = parseHostServerInput(serverInput(3, { 1: { public_ip: "fe80::1%eth0" } }));
  });
  assert.match(parsed.issues.join("\n"), /server-1.*public_ip.*地址无效|public_ip.*地址无效/);

  const imported = cluster();
  imported.hosts[0].address = "fe80::1%eth0";
  let diagnostic;
  assert.doesNotThrow(() => {
    diagnostic = diagnoseClusterConfig(Buffer.from(YAML.stringify(imported)), { source: "imported-file" });
  });
  assert.match(diagnostic.issues.join("\n"), /address.*无效/);
  assert.throws(
    () => validateClusterTopology(imported),
    (error) => error instanceof Error && !(error instanceof TypeError) && /address.*无效/.test(error.message),
  );
});

test("server input detects case-insensitive DNS and equivalent IPv6 address conflicts", () => {
  const { parseHostServerInput } = moduleUnderTest();
  const result = parseHostServerInput(serverInput(4, {
    1: { public_ip: "Gateway.Example.com", private_ip: "2001:db8::1" },
    2: { public_ip: "gateway.example.com", private_ip: "2001:0db8:0:0:0:0:0:1" },
    3: { public_ip: "2001:db8::3", private_ip: "Node-3.Internal" },
    4: { public_ip: "2001:0db8:0:0:0:0:0:3", private_ip: "node-3.internal" },
  }));
  assert.equal(result.issues.filter((issue) => /SSH endpoint/.test(issue)).length, 2, result.issues.join("\n"));
  assert.equal(result.issues.filter((issue) => /private_ip.*重复/.test(issue)).length, 2, result.issues.join("\n"));
});

test("server input rejects duplicate SSH endpoints and private addresses without password leakage", () => {
  const { parseHostServerInput } = moduleUnderTest();
  const sentinel = "MUST-NOT-LEAK-DUPLICATE-SECRET";
  const result = parseHostServerInput(serverInput(3, {
    1: { public_ip: "gateway.example.com", private_ip: "10.0.0.1", password: sentinel },
    2: { public_ip: "gateway.example.com", private_ip: "10.0.0.2", password: sentinel },
    3: { public_ip: "different.example.com", private_ip: "10.0.0.2", password: sentinel },
  }));
  const report = result.issues.join("\n");
  assert.match(report, /SSH.*重复|重复.*SSH/);
  assert.match(report, /private_ip.*重复|重复.*private_ip/);
  assert.doesNotMatch(report, new RegExp(sentinel));
});

function expectedGeneratedRoiConfig(hosts) {
  const nodeNames = hosts.map((_, index) => `node${index + 1}`);
  const controlPlaneNodes = nodeNames.slice(0, 3);
  return {
    hosts: hosts.map((item, index) => ({
      name: nodeNames[index],
      address: item.publicIp,
      internalAddress: item.privateIp,
      user: "root",
      password: item.password,
      port: item.sshPort,
      ...(index === 0 ? { bootstrap: true } : {}),
    })),
    roleGroups: {
      etcd: controlPlaneNodes,
      master: controlPlaneNodes,
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
}

test("generated ROI YAML maps three parsed servers deterministically and preserves password bytes", () => {
  const { createClusterConfigFromServerInput, parseHostServerInput } = moduleUnderTest();
  const password = "  edge=value#fragment and trailing spaces  ";
  const parsed = parseHostServerInput(serverInput(3, {
    1: { ssh_port: "2201", password },
    2: { ssh_port: "2202" },
    3: { ssh_port: "2203" },
  }));
  assert.deepEqual(parsed.issues, []);

  const first = createClusterConfigFromServerInput(parsed.hosts);
  const second = createClusterConfigFromServerInput(parsed.hosts);
  assert(Buffer.isBuffer(first));
  assert.deepEqual(first, second);

  const generated = YAML.parse(first.toString("utf8"));
  assert.deepEqual(generated, expectedGeneratedRoiConfig(parsed.hosts));
  assert.equal(generated.hosts[0].password, password);
});

test("generated ROI YAML maps four parsed servers to three control-plane and all worker nodes", () => {
  const { createClusterConfigFromServerInput, parseHostServerInput } = moduleUnderTest();
  const parsed = parseHostServerInput(serverInput(4, {
    1: { public_ip: "gateway.example.com", ssh_port: "2221" },
    2: { public_ip: "gateway.example.com", ssh_port: "2222" },
    3: { ssh_port: "2223" },
    4: { ssh_port: "2224" },
  }));
  assert.deepEqual(parsed.issues, []);

  const bytes = createClusterConfigFromServerInput(parsed.hosts);
  assert(Buffer.isBuffer(bytes));
  assert.deepEqual(YAML.parse(bytes.toString("utf8")), expectedGeneratedRoiConfig(parsed.hosts));
});

test("generated ROI YAML rejects sparse and malformed validated host arrays without secrets", () => {
  const { createClusterConfigFromServerInput } = moduleUnderTest();
  const sentinel = "MUST-NOT-LEAK-GENERATOR-SECRET";
  const validHost = (index) => ({
    publicIp: `203.0.113.${index}`,
    privateIp: `10.0.0.${index}`,
    sshPort: 2200 + index,
    password: sentinel,
  });
  const sparse = new Array(3);
  sparse[0] = validHost(1);
  sparse[2] = validHost(3);
  const invalidInputs = [
    sparse,
    [validHost(1), sentinel, validHost(3)],
    [validHost(1), { ...validHost(2), publicIp: undefined }, validHost(3)],
    [validHost(1), { ...validHost(2), sshPort: 65536 }, validHost(3)],
    [validHost(1), validHost(2)],
    Array.from({ length: 101 }, (_, index) => validHost(index + 1)),
  ];

  for (const hosts of invalidInputs) {
    let error;
    try {
      createClusterConfigFromServerInput(hosts);
    } catch (caught) {
      error = caught;
    }
    assert(error, "invalid host input must be rejected");
    assert.equal(error.message, "servers.txt 解析结果无效");
    assert.doesNotMatch(error.message, new RegExp(sentinel));
  }
});

test("topology treats address and port as the SSH endpoint and internalAddress as independently unique", () => {
  const { validateClusterTopology } = moduleUnderTest();
  const hosts = [
    host("node1", "gateway.example.com", { internalAddress: "10.0.0.1", port: 2221, bootstrap: true }),
    host("node2", "gateway.example.com", { internalAddress: "10.0.0.2", port: 2222 }),
  ];
  const value = cluster({
    hosts,
    roleGroups: {
      etcd: ["node1"], master: ["node1"], worker: ["node1", "node2"],
      "rbd-gateway": ["node1", "node2"], "rbd-chaos": ["node1", "node2"], "nfs-server": ["node1"],
    },
  });
  assert.equal(validateClusterTopology(value).hosts.length, 2);

  const duplicateEndpoint = structuredClone(value);
  duplicateEndpoint.hosts[1].port = 2221;
  assert.throws(() => validateClusterTopology(duplicateEndpoint), /SSH endpoint.*冲突|地址.*冲突/i);

  const duplicateInternalAddress = structuredClone(value);
  duplicateInternalAddress.hosts[1].internalAddress = "10.0.0.1";
  assert.throws(() => validateClusterTopology(duplicateInternalAddress), /internalAddress.*冲突|地址.*冲突/i);
});

test("one-shot diagnostics return all detectable topology problems in stable order", () => {
  const { diagnoseClusterConfig } = moduleUnderTest();
  const invalid = cluster({
    hosts: [
      host("node1", "10.0.0.1"),
      host("node1", "10.0.0.1"),
    ],
    roleGroups: {
      etcd: ["node1", "missing"],
      master: [],
      worker: ["missing"],
      "rbd-gateway": [],
      "rbd-chaos": [],
      "nfs-server": [],
    },
  });
  const diagnostic = diagnoseClusterConfig(Buffer.from(YAML.stringify(invalid)), { source: "generated-template" });
  assert.equal(diagnostic.value.hosts.length, 2);
  assert(diagnostic.issues.length >= 8, diagnostic.issues.join("\n"));
  assert(diagnostic.issues.some((issue) => /节点名称.*重复/.test(issue)));
  assert(diagnostic.issues.some((issue) => /节点地址.*重复/.test(issue)));
  assert(diagnostic.issues.some((issue) => /etcd.*正奇数/.test(issue)));
  assert(diagnostic.issues.some((issue) => /bootstrap.*恰好/.test(issue)));
  assert(diagnostic.issues.some((issue) => /master.*至少/.test(issue)));
  assert(diagnostic.issues.some((issue) => /不存在.*missing|missing.*不存在/.test(issue)));
  assert.equal(new Set(diagnostic.issues).size, diagnostic.issues.length);
});

test("generated template diagnostics reject sensitive fields without echoing their values", () => {
  const { diagnoseClusterConfig } = moduleUnderTest();
  const sentinel = "MUST-NOT-LEAK-CLUSTER-SECRET";
  const value = cluster({ registry: { external: { enabled: false, token: sentinel } } });
  const diagnostic = diagnoseClusterConfig(Buffer.from(YAML.stringify(value)), { source: "generated-template" });
  assert(diagnostic.issues.some((issue) => /密码|私钥|Token|敏感/.test(issue)));
  assert.doesNotMatch(JSON.stringify(diagnostic), new RegExp(sentinel));
  const imported = diagnoseClusterConfig(Buffer.from(YAML.stringify(value)), { source: "imported-file" });
  assert.equal(imported.issues.some((issue) => /密码|私钥|Token|敏感/.test(issue)), false);
});

test("server input workflow first entry creates only protected servers.txt and waits without SSH side effects", async () => {
  const { installHostCluster } = moduleUnderTest();
  const fixture = hostClusterWorkflowFixture();
  const output = [];
  let sessions = 0;
  const result = await installHostCluster(fixture.context, {
    stateStore: fixture.stateStore,
    platform: "darwin",
    interactive: false,
    write: (value) => output.push(value),
    sessionFactory: async () => { sessions += 1; throw new Error("must not prepare SSH"); },
  });
  assert.equal(result.waiting, true);
  assert.equal(result.waitingStage, "waiting-host-cluster-server-input");
  assert.equal(result.inputPath, fixture.serverInputPath);
  assert.equal(sessions, 0);
  assert.equal(fs.existsSync(fixture.serverInputPath), true);
  assert.equal(fs.existsSync(fixture.configPath), false);
  if (process.platform !== "win32") assert.equal(fs.statSync(fixture.serverInputPath).mode & 0o777, 0o600);
  const state = fixture.stateStore.readProtectedJson(fixture.statePath);
  assert.equal(state.stage, "configuration");
  assert.equal(state.status, "waiting_user");
  assert.equal(state.config_source, "generated-server-input");
  assert.equal(state.server_input_path, fixture.serverInputPath);
  assert.match(output.join(""), /\[RAINSKILLS_USER_INPUT_REQUIRED:host_cluster_server_input\]/);
  const message = userMessageBody(output.join(""), "platform.host-cluster-server-input");
  assert.match(message, /服务器信息文件已生成/);
  assert.match(message, new RegExp(`\\[点击打开 servers\\.txt\\]\\(<${fixture.serverInputPath}>\\)`));
  assert.match(message, new RegExp(`open '${fixture.serverInputPath}'`));
  assert.match(message, /编辑完成后回复“已完成”/);
  assert.match(message, /public_ip、private_ip、ssh_port 和 password/);
  assert.doesNotMatch(message, /cluster\.yaml|YAML|角色/);
});

test("generated-server-input invalid resume reports all issues once and never creates YAML or starts SSH", async () => {
  const { installHostCluster } = moduleUnderTest();
  const fixture = hostClusterWorkflowFixture("rainskills-host-server-input-invalid-");
  await installHostCluster(fixture.context, { stateStore: fixture.stateStore, interactive: false, write: () => {} });
  fs.writeFileSync(fixture.serverInputPath, [
    "[server-1]", "public_ip=bad..address", "private_ip=10.0.0.1", "ssh_port=0", "password=",
    "", "[server-2]", "public_ip=203.0.113.2", "private_ip=10.0.0.1", "ssh_port=22", "password=second",
  ].join("\n"), { mode: 0o600 });
  const output = [];
  let sessions = 0;
  const result = await installHostCluster(fixture.context, {
    stateStore: fixture.stateStore,
    interactive: false,
    write: (value) => output.push(value),
    sessionFactory: async () => { sessions += 1; return null; },
  });
  assert.equal(result.waitingStage, "waiting-host-cluster-server-input");
  assert.equal(result.inputPath, fixture.serverInputPath);
  assert.equal(sessions, 0);
  assert.equal(fs.existsSync(fixture.configPath), false);
  assert(result.issues.length >= 5, result.issues.join("\n"));
  assert.equal(new Set(result.issues).size, result.issues.length);
  const message = userMessageBody(output.join(""), "platform.host-cluster-server-input");
  for (const issue of result.issues) assert.equal(message.split(issue).length - 1, 1, issue);
  assert.match(message, new RegExp(`\\[点击打开 servers\\.txt\\]\\(<${fixture.serverInputPath}>\\)`));
  assert.doesNotMatch(message, /cluster\.yaml|YAML|角色/);
});

test("generated-server-input valid resume no-clobber generates protected YAML, locks both digests, and reaches SSH", async () => {
  const { installHostCluster } = moduleUnderTest();
  const fixture = hostClusterWorkflowFixture("rainskills-host-server-input-valid-");
  const sentinel = "MUST-NOT-LEAK-SERVER-INPUT-PASSWORD";
  await installHostCluster(fixture.context, { stateStore: fixture.stateStore, interactive: false, write: () => {} });
  const inputBytes = Buffer.from(serverInput(3, { 1: { password: sentinel } }));
  fs.writeFileSync(fixture.serverInputPath, inputBytes, { mode: 0o600 });
  const output = [];
  let sessions = 0;
  let result;
  try {
    result = await installHostCluster(fixture.context, {
      stateStore: fixture.stateStore,
      interactive: false,
      write: (value) => output.push(value),
      sessionFactory: async () => { sessions += 1; return null; },
    });
  } catch (error) {
    assert.doesNotMatch(String(error), new RegExp(sentinel));
    throw error;
  }
  assert.equal(result.waiting, true);
  assert.equal(sessions, 3);
  assert.equal(fs.existsSync(fixture.configPath), true);
  if (process.platform !== "win32") assert.equal(fs.statSync(fixture.configPath).mode & 0o777, 0o600);
  const yamlBytes = fs.readFileSync(fixture.configPath);
  const generated = YAML.parse(yamlBytes.toString("utf8"));
  assert.equal(generated.hosts[0].password, sentinel);
  assert.deepEqual(generated.roleGroups.etcd, ["node1", "node2", "node3"]);
  const state = fixture.stateStore.readProtectedJson(fixture.statePath);
  assert.equal(state.server_input_sha256, sha256(inputBytes));
  assert.equal(state.generated_config_sha256, sha256(yamlBytes));
  assert.equal(state.config_sha256, sha256(yamlBytes));
  assert.equal(JSON.stringify(state).includes(sentinel), false);
  assert.equal(output.join("").includes(sentinel), false);
  assert.equal(JSON.stringify(result).includes(sentinel), false);
});

test("generated-server-input real helper emits every automatic node role before the first SSH session action", async () => {
  const { installHostCluster } = moduleUnderTest();
  const fixture = hostClusterWorkflowFixture("rainskills-host-server-input-topology-order-");
  const sentinel = "MUST-NOT-LEAK-TOPOLOGY-PASSWORD";
  await installHostCluster(fixture.context, {
    stateStore: fixture.stateStore,
    interactive: false,
    write: () => {},
  });
  fs.writeFileSync(fixture.serverInputPath, serverInput(3, {
    1: { password: sentinel },
  }), { mode: 0o600 });

  const output = [];
  let sessions = 0;
  await installHostCluster(fixture.context, {
    stateStore: fixture.stateStore,
    interactive: false,
    write: (value) => output.push(value),
    sessionFactory: async () => {
      sessions += 1;
      const beforeSsh = output.join("");
      assert.match(beforeSsh, /RAINSKILLS_STATUS:host_cluster_config_valid/);
      assert.match(beforeSsh, /自动角色分配：/);
      assert.match(beforeSsh, /- node1: etcd, master, worker, rbd-gateway, rbd-chaos, nfs-server \(bootstrap\)/);
      assert.match(beforeSsh, /- node2: etcd, master, worker, rbd-gateway, rbd-chaos/);
      assert.match(beforeSsh, /- node3: etcd, master, worker, rbd-chaos/);
      assert.match(beforeSsh, new RegExp(`受保护配置：${fixture.configPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
      assert.doesNotMatch(beforeSsh, new RegExp(sentinel));
      return null;
    },
  });
  assert.equal(sessions, 3);
});

test("generated-server-input adopts only matching crash-residue YAML and fails closed for mismatches or symlinks", async () => {
  const { createClusterConfigFromServerInput, installHostCluster, parseHostServerInput } = moduleUnderTest();
  for (const scenario of ["matching", "mismatch", "symlink"]) {
    const fixture = hostClusterWorkflowFixture(`rainskills-host-server-input-residue-${scenario}-`);
    await installHostCluster(fixture.context, { stateStore: fixture.stateStore, interactive: false, write: () => {} });
    const inputBytes = Buffer.from(serverInput(3));
    fs.writeFileSync(fixture.serverInputPath, inputBytes, { mode: 0o600 });
    const expected = createClusterConfigFromServerInput(parseHostServerInput(inputBytes).hosts);
    if (scenario === "matching") {
      fs.writeFileSync(fixture.configPath, expected, { mode: 0o600 });
    } else if (scenario === "mismatch") {
      fs.writeFileSync(fixture.configPath, Buffer.from(YAML.stringify(cluster())), { mode: 0o600 });
    } else {
      const victim = path.join(fixture.hostRoot, "victim.yaml");
      fs.writeFileSync(victim, expected, { mode: 0o600 });
      fs.symlinkSync(victim, fixture.configPath);
    }
    let sessions = 0;
    const run = () => installHostCluster(fixture.context, {
      stateStore: fixture.stateStore,
      interactive: false,
      write: () => {},
      sessionFactory: async () => { sessions += 1; return null; },
    });
    if (scenario === "matching") {
      await run();
      assert.equal(sessions, 3);
      const state = fixture.stateStore.readProtectedJson(fixture.statePath);
      assert.equal(state.generated_config_sha256, sha256(expected));
    } else {
      await assert.rejects(run, /cluster\.yaml.*(不匹配|来源|符号链接|拒绝)|(不匹配|来源|符号链接|拒绝).*cluster\.yaml/i);
      assert.equal(sessions, 0);
    }
  }
});

test("generated-server-input fails closed for unknown YAML source and for TXT or YAML drift after lock", async () => {
  const { installHostCluster } = moduleUnderTest();
  const unknown = hostClusterWorkflowFixture("rainskills-host-server-input-unknown-");
  unknown.stateStore.ensurePrivateDirectory(unknown.hostRoot);
  fs.writeFileSync(unknown.configPath, YAML.stringify(cluster()), { mode: 0o600 });
  await assert.rejects(
    () => installHostCluster(unknown.context, { stateStore: unknown.stateStore, interactive: false, write: () => {} }),
    /来源不明.*cluster\.yaml|cluster\.yaml.*来源不明/,
  );

  for (const drift of ["txt", "yaml"]) {
    const fixture = hostClusterWorkflowFixture(`rainskills-host-server-input-${drift}-drift-`);
    await installHostCluster(fixture.context, { stateStore: fixture.stateStore, interactive: false, write: () => {} });
    fs.writeFileSync(fixture.serverInputPath, serverInput(3), { mode: 0o600 });
    await installHostCluster(fixture.context, {
      stateStore: fixture.stateStore, interactive: false, write: () => {}, sessionFactory: async () => null,
    });
    const target = drift === "txt" ? fixture.serverInputPath : fixture.configPath;
    fs.appendFileSync(target, "\n# drift\n");
    let sessions = 0;
    await assert.rejects(
      () => installHostCluster(fixture.context, {
        stateStore: fixture.stateStore,
        interactive: false,
        write: () => {},
        sessionFactory: async () => { sessions += 1; return null; },
      }),
      new RegExp(`${drift === "txt" ? "servers\\.txt" : "cluster\\.yaml"}.*(变化|漂移)|恢复.*${drift === "txt" ? "servers\\.txt" : "cluster\\.yaml"}`),
    );
    assert.equal(sessions, 0);
  }
});

test("legacy generated-template waiting and locked states continue the original YAML workflow", async () => {
  const { createHostClusterTemplate, installHostCluster } = moduleUnderTest();
  for (const locked of [false, true]) {
    const fixture = hostClusterWorkflowFixture(`rainskills-legacy-generated-template-${locked}-`);
    fixture.stateStore.ensurePrivateDirectory(fixture.hostRoot);
    const bytes = locked ? Buffer.from(YAML.stringify(cluster())) : createHostClusterTemplate();
    fs.writeFileSync(fixture.configPath, bytes, { mode: 0o600 });
    fixture.stateStore.atomicWriteJson(fixture.statePath, {
      schema: "rainskills.host-cluster-state.v1",
      version: 1,
      operation_id: fixture.operationId,
      stage: "configuration",
      status: locked ? "running" : "waiting_user",
      config_path: fixture.configPath,
      config_source: "generated-template",
      ...(locked ? { config_sha256: sha256(bytes) } : {}),
    });
    const output = [];
    let sessions = 0;
    const result = await installHostCluster(fixture.context, {
      stateStore: fixture.stateStore,
      interactive: false,
      write: (value) => output.push(value),
      sessionFactory: async () => { sessions += 1; return null; },
    });
    if (locked) {
      assert.equal(sessions, 1);
      assert.equal(result.waiting, true);
    } else {
      assert.equal(result.waitingStage, "waiting-host-cluster-config");
      assert.equal(sessions, 0);
      assert.match(output.join(""), /RAINSKILLS_USER_INPUT_REQUIRED:host_cluster_config/);
      userMessageBody(output.join(""), "platform.host-cluster-config");
    }
  }
});

test("legacy generated-template compatibility migrates missing source and imported bytes retain 1, 2, and N host support", async () => {
  const { installHostCluster } = moduleUnderTest();
  for (const count of [1, 2, 5]) {
    const fixture = hostClusterWorkflowFixture(`rainskills-host-import-compat-${count}-`);
    fixture.stateStore.ensurePrivateDirectory(fixture.hostRoot);
    const hosts = Array.from({ length: count }, (_, index) => host(
      `node${index + 1}`,
      `10.0.0.${index + 1}`,
      index === 0 ? { bootstrap: true } : {},
    ));
    const names = hosts.map(({ name }) => name);
    const bytes = Buffer.from(`${YAML.stringify(cluster({
      hosts,
      roleGroups: {
        etcd: ["node1"], master: ["node1"], worker: names,
        "rbd-gateway": ["node1"], "rbd-chaos": names, "nfs-server": ["node1"],
      },
    }))}# imported bytes must survive\n`);
    fs.writeFileSync(fixture.configPath, bytes, { mode: 0o600 });
    fixture.stateStore.atomicWriteJson(fixture.statePath, {
      schema: "rainskills.host-cluster-state.v1",
      version: 1,
      operation_id: fixture.operationId,
      stage: "ssh",
      status: "waiting_user",
      config_path: fixture.configPath,
      config_sha256: sha256(bytes),
    });
    let sessions = 0;
    await installHostCluster(fixture.context, {
      stateStore: fixture.stateStore,
      interactive: false,
      write: () => {},
      sessionFactory: async () => { sessions += 1; return null; },
    });
    assert.equal(sessions, count);
    assert.deepEqual(fs.readFileSync(fixture.configPath), bytes);
    assert.equal(fixture.stateStore.readProtectedJson(fixture.statePath).config_source, "imported-file");
  }
});

test("imported-file crash residue rebinds the original source before adopting an unlocked protected copy", async () => {
  const { installHostCluster } = moduleUnderTest();
  const fixture = hostClusterWorkflowFixture("rainskills-host-import-crash-residue-");
  fixture.stateStore.ensurePrivateDirectory(fixture.hostRoot);
  const sourcePath = path.join(path.dirname(fixture.paths.root), "import-source.yaml");
  const sourceBytes = Buffer.from(`${YAML.stringify(cluster())}# original source\n`);
  const tampered = cluster();
  tampered.hosts[0].address = "10.0.0.99";
  const tamperedBytes = Buffer.from(`${YAML.stringify(tampered)}# changed protected copy\n`);
  fs.writeFileSync(sourcePath, sourceBytes, { mode: 0o600 });
  fs.writeFileSync(fixture.configPath, tamperedBytes, { mode: 0o600 });
  fixture.stateStore.atomicWriteJson(fixture.statePath, {
    schema: "rainskills.host-cluster-state.v1",
    version: 1,
    operation_id: fixture.operationId,
    stage: "configuration",
    status: "running",
    config_path: fixture.configPath,
    config_source: "imported-file",
    import_source_path: sourcePath,
  });
  let sessions = 0;
  await assert.rejects(
    () => installHostCluster(fixture.context, {
      stateStore: fixture.stateStore,
      interactive: false,
      write: () => {},
      sessionFactory: async () => { sessions += 1; return null; },
    }),
    /外部.*source|导入.*副本|字节.*不匹配|cluster\.yaml.*不匹配/i,
  );
  assert.equal(sessions, 0);
  const state = fixture.stateStore.readProtectedJson(fixture.statePath);
  assert.equal(state.import_source_sha256, undefined);
  assert.equal(state.config_sha256, undefined);

  fs.writeFileSync(fixture.configPath, sourceBytes, { mode: 0o600 });
  await installHostCluster(fixture.context, {
    stateStore: fixture.stateStore,
    interactive: false,
    write: () => {},
    sessionFactory: async () => { sessions += 1; return null; },
  });
  const adopted = fixture.stateStore.readProtectedJson(fixture.statePath);
  assert.equal(adopted.import_source_sha256, sha256(sourceBytes));
  assert.equal(adopted.config_sha256, sha256(sourceBytes));
  assert.equal(sessions, 1);

  fs.unlinkSync(sourcePath);
  await installHostCluster(fixture.context, {
    stateStore: fixture.stateStore,
    interactive: false,
    write: () => {},
    sessionFactory: async () => null,
  });
});

test("imported-file explicit state without any source binding fails closed before SSH", async () => {
  const { installHostCluster } = moduleUnderTest();
  const fixture = hostClusterWorkflowFixture("rainskills-host-import-source-state-missing-");
  fixture.stateStore.ensurePrivateDirectory(fixture.hostRoot);
  fs.writeFileSync(fixture.configPath, YAML.stringify(cluster()), { mode: 0o600 });
  fixture.stateStore.atomicWriteJson(fixture.statePath, {
    schema: "rainskills.host-cluster-state.v1",
    version: 1,
    operation_id: fixture.operationId,
    stage: "configuration",
    status: "running",
    config_path: fixture.configPath,
    config_source: "imported-file",
  });
  let sessions = 0;
  await assert.rejects(
    () => installHostCluster(fixture.context, {
      stateStore: fixture.stateStore,
      interactive: false,
      write: () => {},
      sessionFactory: async () => { sessions += 1; return null; },
    }),
    /导入来源状态不完整|source.*不完整|import.*source/i,
  );
  assert.equal(sessions, 0);
  assert.equal(fixture.stateStore.readProtectedJson(fixture.statePath).config_sha256, undefined);
});

test("host cluster config prompt provides native open commands on macOS Linux and Windows", () => {
  const { renderHostClusterConfigPrompt } = moduleUnderTest();
  const posixPath = "/Users/example user/.rainbond/platform-installer/op/host-cluster/cluster.yaml";
  const windowsPath = "C:\\Users\\example user\\.rainbond\\platform-installer\\op\\host-cluster\\cluster.yaml";

  assert.match(
    renderHostClusterConfigPrompt({ configPath: posixPath, platform: "darwin" }),
    /open '\/Users\/example user\/\.rainbond\/platform-installer\/op\/host-cluster\/cluster\.yaml'/,
  );
  assert.match(
    renderHostClusterConfigPrompt({ configPath: posixPath, platform: "linux" }),
    /xdg-open '\/Users\/example user\/\.rainbond\/platform-installer\/op\/host-cluster\/cluster\.yaml'/,
  );
  const windowsMessage = renderHostClusterConfigPrompt({ configPath: windowsPath, platform: "win32" });
  assert.match(windowsMessage, /explorer\.exe "C:\\Users\\example user\\\.rainbond/);
  assert.match(windowsMessage, /\[点击打开 cluster\.yaml\]\(<C:\/Users\/example%20user\//);
});

test("protected template creation is no-clobber and preserves competing files or symlinks", () => {
  const { createProtectedBytesExclusive } = moduleUnderTest();
  const root = tempOperation("rainskills-host-template-exclusive-");
  const target = path.join(root, "cluster.yaml");
  fs.writeFileSync(target, "competitor\n", { mode: 0o600 });
  assert.throws(() => createProtectedBytesExclusive(target, Buffer.from("template\n")), /已存在|拒绝覆盖/);
  assert.equal(fs.readFileSync(target, "utf8"), "competitor\n");

  const symlink = path.join(root, "cluster-link.yaml");
  const victim = path.join(root, "victim.txt");
  fs.writeFileSync(victim, "victim\n", { mode: 0o600 });
  fs.symlinkSync(victim, symlink);
  assert.throws(() => createProtectedBytesExclusive(symlink, Buffer.from("template\n")), /已存在|拒绝覆盖/);
  assert.equal(fs.readFileSync(victim, "utf8"), "victim\n");
});

test("legacy generated-template valid edited one-shot config prepares SSH without host preflight", async () => {
  const { installHostCluster } = moduleUnderTest();
  const root = tempOperation("rainskills-host-template-resume-");
  const home = path.join(root, "home");
  fs.mkdirSync(home, { mode: 0o700 });
  const stateStore = require("./helpers/portable-secure-state.js").createPortableSecureStateStore(home);
  const operationId = "1d6754d6-6fb3-4bda-9a04-15c2d261d178";
  const paths = { root: path.join(home, ".rainbond", "platform-installer", operationId) };
  stateStore.ensurePrivateDirectory(paths.root);
  const context = {
    onboarding: { operation_id: operationId },
    state: { operation_id: operationId },
    paths,
    options: { yes: true },
  };
  const hostRoot = path.join(paths.root, "host-cluster");
  stateStore.ensurePrivateDirectory(hostRoot);
  const configPath = path.join(hostRoot, "cluster.yaml");
  fs.writeFileSync(configPath, YAML.stringify(cluster()), { mode: 0o600 });
  stateStore.atomicWriteJson(path.join(hostRoot, "state.json"), {
    schema: "rainskills.host-cluster-state.v1",
    version: 1,
    operation_id: operationId,
    stage: "configuration",
    status: "waiting_user",
    config_path: configPath,
    config_source: "generated-template",
  });
  const output = [];
  let sessions = 0;
  let confirmations = 0;
  const result = await installHostCluster(context, {
    stateStore,
    interactive: false,
    write: (value) => output.push(value),
    sessionFactory: async () => { sessions += 1; return { controlPath: null, interactive: false }; },
    closeSession: () => {},
    confirm: async ({ summary }) => {
      confirmations += 1;
      assert.equal(summary.blockers, undefined);
      return { accepted: false, waiting: true };
    },
  });
  assert.equal(result.waiting, true);
  assert.equal(sessions, 1);
  assert.equal(confirmations, 1);
  assert.match(output.join(""), /集群配置检查通过/);
  assert.match(output.join(""), /节点：1 个/);
  assert.match(output.join(""), /etcd：1 个/);
  assert.match(output.join(""), /bootstrap：node1/);
  assert.match(output.join(""), /正在准备所有服务器的 SSH 连接/);
  assert.doesNotMatch(output.join(""), /运行条件|预检/);
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

test("wizard preserves host passwords only in the persisted config and cancel is atomic", async () => {
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
  const persisted = YAML.parse(writes[0].toString("utf8"));
  assert.equal(persisted.hosts[0].password, "fixture-password");
  assert.doesNotMatch(output.join(""), /fixture-password/);
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

test("host SSH sessions collect all unavailable nodes and emit one labeled batch command", async () => {
  const { prepareHostSshSessions, validateClusterTopology } = moduleUnderTest();
  const config = cluster({
    hosts: [
      host("node1", "118.196.125.15", { bootstrap: true }),
      host("node2", "118.196.125.168"),
      host("node3", "118.196.125.169"),
    ],
    roleGroups: {
      etcd: ["node1", "node2", "node3"], master: ["node1", "node2", "node3"], worker: ["node1", "node2", "node3"],
      "rbd-gateway": ["node1", "node2"], "rbd-chaos": ["node1", "node2", "node3"], "nfs-server": ["node1"],
    },
  });
  const topology = validateClusterTopology(config);
  const calls = [];
  for (const interactive of [true, false]) {
    const output = [];
    const waiting = await prepareHostSshSessions(topology, {
      interactive,
      write: (value) => output.push(value),
      configPath: "/Users/example/.rainbond/platform-installer/operation/host-cluster/cluster.yaml",
      packageVersion: "0.1.0-test",
      platform: "darwin",
      sessionFactory: async (item, options) => {
        calls.push({ item, options });
        return item.name === "node2"
          ? { target: { host: `root@${item.address}`, port: item.port }, controlPath: null, authentication: "key" }
          : null;
      },
    });
    assert.equal(waiting.waiting, true);
    assert.deepEqual(waiting.pending.map(({ name }) => name), ["node1", "node3"]);
    const combined = output.join("");
    assert.equal((combined.match(/RAINSKILLS_USER_MESSAGE_BEGIN:platform\.ssh-authentication/g) || []).length, 1);
    const message = userMessageBody(combined, "platform.ssh-authentication");
    assert.match(message, /1\. node1：root@118\.196\.125\.15:22/);
    assert.match(message, /2\. node3：root@118\.196\.125\.169:22/);
    assert.doesNotMatch(message, /node2/);
    assert.match(message, /npx --yes rainskills@0\.1\.0-test ssh prepare-cluster --cluster-config/);
    assert.match(message, /全部完成后.*回复“已完成”/s);
    assert(calls.slice(-3).every(({ options }) => options.deferAuthenticationMessage === true));
  }
});

test("bootstrap architecture selection uses one fixed uname command instead of host preflight", async () => {
  const { probeRemoteArchitecture } = moduleUnderTest();
  const calls = [];
  const arch = await probeRemoteArchitecture({ name: "node1", address: "10.0.0.1", port: 22 }, {
    session: { controlPath: "/protected/control" },
    sshRunner: async (command, args) => {
      calls.push({ command, args });
      return { code: 0, signal: null, stdout: "x86_64\n", stderr: "" };
    },
  });
  assert.equal(arch, "amd64");
  assert.deepEqual(calls, [{
    command: "ssh",
    args: ["-o", "BatchMode=yes", "-o", "ControlPath=/protected/control", "-p", "22", "root@10.0.0.1", "uname", "-m"],
  }]);
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
  assert.doesNotMatch(output.join(""), /阻断项|风险提示|预检/);

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
      probeArchitecture: async () => "amd64",
      acquireArtifact: async ({ operationDir, persistLock }) => {
        downloads += 1;
        const artifactPath = path.join(operationDir, "roi");
        const bytes = elfBinary("amd64");
        fs.writeFileSync(artifactPath, bytes, { mode: 0o600 });
        const lock = { finalUrl: "https://get.rainbond.com/roi/roi-amd64", version: "roi version v1", sha256: sha256(bytes), checksum: { published: false, sourceUrl: null } };
        persistLock(lock);
        return { path: artifactPath, ...lock };
      },
      execute: async ({ sensitiveValues }) => {
        executions += 1;
        assert.deepEqual(sensitiveValues, ["fixture-password"]);
        return { interrupted: false };
      },
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

test("ROI version probe accepts the official ROI v2 colon format", async () => {
  const { probeRemoteRoiVersion } = moduleUnderTest();
  const root = tempOperation();
  const artifactPath = path.join(root, "roi");
  const bytes = elfBinary("amd64");
  fs.writeFileSync(artifactPath, bytes, { mode: 0o600 });

  const version = await probeRemoteRoiVersion({
    bootstrap: host("node1", "10.0.0.1", { bootstrap: true }),
    artifactPath,
    remoteDir: "/root/.rainbond/rainskills/op-1",
    session: { controlPath: "/protected/bootstrap-control", interactive: false },
    transfer: async (input) => ({ remoteSha256: input.sha256 }),
    sshRunner: async () => ({ code: 0, stdout: "ROI Version: v2.0.0\n", stderr: "" }),
  });

  assert.equal(version, "ROI Version: v2.0.0");
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
  assert.equal(
    calls[0].input.includes("printf '%s\\n' y | \"$artifact\" up -f \"$config\""),
    true,
  );
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

test("ROI literal sensitive values redact unkeyed cross-chunk output, returned bytes, and protected logs", async () => {
  const { executeRoiInstall, redactInstallLog, spawnRedactedAttached } = moduleUnderTest();
  const sensitiveValue = ["opaque", "value", "for", "roi", "xyz"].join("-");
  const overlappingValue = sensitiveValue.slice(0, sensitiveValue.lastIndexOf("-"));
  const direct = redactInstallLog(`connected using ${sensitiveValue}`, undefined, [overlappingValue, sensitiveValue]);
  assert.equal(direct.includes(sensitiveValue), false, "direct log redaction exposed a literal sensitive value");
  assert.match(direct, /^connected using \[REDACTED\]$/);

  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  const streamed = [];
  const running = spawnRedactedAttached("ssh", ["fixed"], {
    spawnFn: () => child,
    stdoutWriter: { write: (value) => streamed.push(String(value)) },
    stderrWriter: { write: (value) => streamed.push(String(value)) },
    sensitiveValues: [overlappingValue, sensitiveValue, sensitiveValue],
  });
  const splitAt = Math.floor(sensitiveValue.length / 2);
  child.stdout.write(`connected using ${sensitiveValue.slice(0, splitAt)}`);
  child.stdout.write(`${sensitiveValue.slice(splitAt)}\n`);
  child.stdout.end();
  child.stderr.end();
  child.emit("close", 130, null);
  const streamedResult = await running;
  assert.equal(streamed.join("").includes(sensitiveValue), false, "stream writer exposed a literal sensitive value");
  assert.equal(streamedResult.stdout.includes(sensitiveValue), false, "runner result exposed a literal sensitive value");
  assert.match(`${streamed.join("")}\n${streamedResult.stdout}`, /\[REDACTED\]/);

  const root = tempOperation("rainskills-roi-literal-redaction-");
  const configPath = path.join(root, "cluster.yaml");
  const artifactPath = path.join(root, "roi");
  const logPath = path.join(root, "roi.log");
  fs.writeFileSync(configPath, YAML.stringify(cluster()), { mode: 0o600 });
  fs.writeFileSync(artifactPath, elfBinary("amd64"), { mode: 0o700 });
  const output = [];
  await executeRoiInstall({
    bootstrap: host("node1", "10.0.0.1", { bootstrap: true }),
    configPath,
    artifactPath,
    logPath,
    remoteDir: "/root/.rainbond/rainskills/op-1",
    resumeArgv: ["npx", `rainskills@${packageVersion}`, "platform", "install", "--onboarding-id", "1d6754d6-6fb3-4bda-9a04-15c2d261d178"],
    sensitiveValues: [sensitiveValue],
    transfer: async (input) => ({ remoteSha256: input.sha256 }),
    attachedRunner: async () => ({
      code: 130,
      signal: "SIGINT",
      redacted: false,
      stdout: `connected using ${sensitiveValue}`,
      stderr: "",
    }),
    write: (value) => output.push(value),
  });
  assert.equal(fs.readFileSync(logPath, "utf8").includes(sensitiveValue), false, "protected log exposed a literal sensitive value");
  assert.match(fs.readFileSync(logPath, "utf8"), /\[REDACTED\]/);
  assert.equal(output.join("").includes(sensitiveValue), false, "user output exposed a literal sensitive value");
});

test("ROI redaction marker never contains colliding sensitive values and preserves an unrelated receipt", async () => {
  const { executeRoiInstall, redactInstallLog, spawnRedactedAttached } = moduleUnderTest();
  const sensitiveValues = ["REDACTED", "[REDACTED]", "ACT"];
  const containsSensitiveValue = (value) => sensitiveValues.some((item) => String(value).includes(item));
  const literal = redactInstallLog(
    "connected using [REDACTED] then REDACTED then ACT",
    undefined,
    sensitiveValues,
  );
  assert.equal(containsSensitiveValue(literal), false, "literal redaction marker collided with a sensitive value");
  const keyword = redactInstallLog("password=ordinary-value", undefined, sensitiveValues);
  assert.equal(containsSensitiveValue(keyword), false, "keyword redaction marker collided with a sensitive value");
  assert.equal(redactInstallLog("RECEIPT_PHASE=completed", undefined, sensitiveValues), "RECEIPT_PHASE=completed");

  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  const streamed = [];
  const running = spawnRedactedAttached("ssh", ["fixed"], {
    spawnFn: () => child,
    stdoutWriter: { write: (value) => streamed.push(String(value)) },
    stderrWriter: { write: (value) => streamed.push(String(value)) },
    sensitiveValues,
  });
  child.stdout.write("connected using [RE");
  child.stdout.write("DACTED]\nRECEIPT_PHASE=completed\n");
  child.stdout.end();
  child.stderr.end();
  child.emit("close", 130, null);
  const streamedResult = await running;
  assert.equal(containsSensitiveValue(streamed.join("")), false, "stream marker collided with a sensitive value");
  assert.equal(containsSensitiveValue(streamedResult.stdout), false, "returned marker collided with a sensitive value");
  assert.match(streamedResult.stdout, /RECEIPT_PHASE=completed/);

  const root = tempOperation("rainskills-roi-marker-collision-");
  const configPath = path.join(root, "cluster.yaml");
  const artifactPath = path.join(root, "roi");
  const logPath = path.join(root, "roi.log");
  fs.writeFileSync(configPath, YAML.stringify(cluster()), { mode: 0o600 });
  fs.writeFileSync(artifactPath, elfBinary("amd64"), { mode: 0o700 });
  await executeRoiInstall({
    bootstrap: host("node1", "10.0.0.1", { bootstrap: true }),
    configPath,
    artifactPath,
    logPath,
    remoteDir: "/root/.rainbond/rainskills/op-1",
    resumeArgv: ["npx", `rainskills@${packageVersion}`, "platform", "install", "--onboarding-id", "1d6754d6-6fb3-4bda-9a04-15c2d261d178"],
    sensitiveValues,
    transfer: async (input) => ({ remoteSha256: input.sha256 }),
    attachedRunner: async () => ({
      code: 130,
      signal: "SIGINT",
      redacted: false,
      stdout: "connected using [REDACTED]\npassword=ordinary-value",
      stderr: "",
    }),
    write: () => {},
  });
  assert.equal(containsSensitiveValue(fs.readFileSync(logPath, "utf8")), false, "protected log marker collided with a sensitive value");
});

test("ROI exact CRLF completion receipt survives literal password redaction on the real attached path", async () => {
  const { executeRoiInstall, spawnRedactedAttached } = moduleUnderTest();
  for (const sensitiveValue of ["completed", "RECEIPT"]) {
    const root = tempOperation("rainskills-roi-receipt-redaction-");
    const configPath = path.join(root, "cluster.yaml");
    const artifactPath = path.join(root, "roi");
    const logPath = path.join(root, "roi.log");
    fs.writeFileSync(configPath, YAML.stringify(cluster()), { mode: 0o600 });
    fs.writeFileSync(artifactPath, elfBinary("amd64"), { mode: 0o700 });
    const visible = [];
    let attachedResult;
    const sshSpawn = () => {
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.stdin = new PassThrough();
      child.kill = () => true;
      queueMicrotask(() => {
        child.stdout.end(`connected using ${sensitiveValue}\r\nRECEIPT_PHASE=completed\r\n`);
        child.stderr.end();
        child.emit("close", 0, null);
      });
      return child;
    };
    const result = await executeRoiInstall({
      bootstrap: host("node1", "10.0.0.1", { bootstrap: true }),
      configPath,
      artifactPath,
      logPath,
      remoteDir: "/root/.rainbond/rainskills/op-1",
      resumeArgv: ["npx", `rainskills@${packageVersion}`, "platform", "install", "--onboarding-id", "1d6754d6-6fb3-4bda-9a04-15c2d261d178"],
      sensitiveValues: [sensitiveValue],
      transfer: async (input) => ({ remoteSha256: input.sha256 }),
      sshSpawn,
      attachedRunner: async (command, args, options) => {
        attachedResult = await spawnRedactedAttached(command, args, {
          ...options,
          stdoutWriter: { write: (value) => visible.push(String(value)) },
          stderrWriter: { write: (value) => visible.push(String(value)) },
        });
        return attachedResult;
      },
      write: (value) => visible.push(String(value)),
    });
    assert.equal(result.interrupted, false);
    assert.equal(attachedResult.receiptCompleted, true);
    assert.equal(visible.join("").includes(sensitiveValue), false, "visible output exposed the literal password");
    assert.equal(attachedResult.stdout.includes(sensitiveValue), false, "returned stdout exposed the literal password");
    assert.equal(fs.readFileSync(logPath, "utf8").includes(sensitiveValue), false, "protected log exposed the literal password");
  }
});

test("ROI custom attached runner detects an exact raw CRLF completion receipt before protecting its log", async () => {
  const { executeRoiInstall } = moduleUnderTest();
  const sensitiveValue = "completed";
  const root = tempOperation("rainskills-roi-custom-receipt-");
  const configPath = path.join(root, "cluster.yaml");
  const artifactPath = path.join(root, "roi");
  const logPath = path.join(root, "roi.log");
  fs.writeFileSync(configPath, YAML.stringify(cluster()), { mode: 0o600 });
  fs.writeFileSync(artifactPath, elfBinary("amd64"), { mode: 0o700 });
  const result = await executeRoiInstall({
    bootstrap: host("node1", "10.0.0.1", { bootstrap: true }),
    configPath,
    artifactPath,
    logPath,
    remoteDir: "/root/.rainbond/rainskills/op-1",
    resumeArgv: ["npx", `rainskills@${packageVersion}`, "platform", "install", "--onboarding-id", "1d6754d6-6fb3-4bda-9a04-15c2d261d178"],
    sensitiveValues: [sensitiveValue],
    transfer: async (input) => ({ remoteSha256: input.sha256 }),
    attachedRunner: async () => ({
      code: 0,
      signal: null,
      stdout: `connected using ${sensitiveValue}\r\nRECEIPT_PHASE=completed\r\n`,
      stderr: "",
    }),
    write: () => {},
  });
  assert.equal(result.interrupted, false);
  assert.equal(fs.readFileSync(logPath, "utf8").includes(sensitiveValue), false, "protected custom-runner log exposed the literal password");
});

test("ROI real attached path rejects a successful process without the exact completion receipt", async () => {
  const { executeRoiInstall, spawnRedactedAttached } = moduleUnderTest();
  const sensitiveValue = "completed";
  const root = tempOperation("rainskills-roi-receipt-missing-");
  const configPath = path.join(root, "cluster.yaml");
  const artifactPath = path.join(root, "roi");
  const logPath = path.join(root, "roi.log");
  fs.writeFileSync(configPath, YAML.stringify(cluster()), { mode: 0o600 });
  fs.writeFileSync(artifactPath, elfBinary("amd64"), { mode: 0o700 });
  const visible = [];
  let attachedResult;
  const sshSpawn = () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.kill = () => true;
    queueMicrotask(() => {
      child.stdout.end(
        `connected using ${sensitiveValue}\r\n`
        + " RECEIPT_PHASE=completed\r\n"
        + "RECEIPT_PHASE=completed \r\n"
        + "prefixRECEIPT_PHASE=completed\r\n",
      );
      child.stderr.end();
      child.emit("close", 0, null);
    });
    return child;
  };
  await assert.rejects(
    () => executeRoiInstall({
      bootstrap: host("node1", "10.0.0.1", { bootstrap: true }),
      configPath,
      artifactPath,
      logPath,
      remoteDir: "/root/.rainbond/rainskills/op-1",
      resumeArgv: ["npx", `rainskills@${packageVersion}`, "platform", "install", "--onboarding-id", "1d6754d6-6fb3-4bda-9a04-15c2d261d178"],
      sensitiveValues: [sensitiveValue],
      transfer: async (input) => ({ remoteSha256: input.sha256 }),
      sshSpawn,
      attachedRunner: async (command, args, options) => {
        attachedResult = await spawnRedactedAttached(command, args, {
          ...options,
          stdoutWriter: { write: (value) => visible.push(String(value)) },
          stderrWriter: { write: (value) => visible.push(String(value)) },
        });
        return attachedResult;
      },
      write: (value) => visible.push(String(value)),
    }),
    /completed receipt.*缺失|receipt.*缺失/i,
  );
  assert.equal(attachedResult.receiptCompleted, false);
  assert.equal(visible.join("").includes(sensitiveValue), false, "visible output exposed the literal password");
  assert.equal(attachedResult.stdout.includes(sensitiveValue), false, "returned stdout exposed the literal password");
  assert.equal(fs.readFileSync(logPath, "utf8").includes(sensitiveValue), false, "protected log exposed the literal password");
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

test("read-only SSH children register for signals and architecture interruption stops before artifact or ROI", async () => {
  const { defaultSshRunner, installHostCluster, probeRemoteRoiVersion } = moduleUnderTest();
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

  const root = tempOperation("rainskills-architecture-interrupt-");
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
    probeArchitecture: async () => {
      const error = new Error("SSH architecture query interrupted");
      error.code = "RAINSKILLS_HOST_CLUSTER_INTERRUPTED";
      error.signal = "SIGINT";
      throw error;
    },
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

test("remote transfer pipes fixed stage and publish scripts to bash stdin", async () => {
  const { defaultTransfer } = moduleUnderTest();
  const root = tempOperation("rainskills-remote-stdin-");
  const localPath = path.join(root, "cluster.yaml");
  const bytes = Buffer.from("protected cluster bytes");
  const digest = sha256(bytes);
  fs.writeFileSync(localPath, bytes, { mode: 0o600 });
  const scriptCalls = [];

  const result = await defaultTransfer({
    host: "root@10.0.0.1",
    port: 22,
    localPath,
    remotePath: "/root/.rainbond/rainskills/op/cluster.yaml",
    sha256: digest,
    mode: 0o600,
    runner: (command, args, options) => {
      if (command === "ssh" && args.includes("bash")) {
        scriptCalls.push({ args: [...args], options });
        assert.equal(options.stdio[0], "pipe", "bash -s must receive the fixed script through a pipe");
        assert.equal(typeof options.input, "string");
        return { status: 0, stdout: args.includes(digest) ? `${digest}\n` : "", stderr: "" };
      }
      return { status: 0, stdout: "", stderr: "" };
    },
  });

  assert.equal(scriptCalls.length, 2);
  assert.equal(result.remoteSha256, digest);
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
      probeArchitecture: async () => "amd64",
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
  let architectureProbes = 0;
  let downloads = 0;
  let executions = 0;
  let reconciliations = 0;
  let verifications = 0;
  const dependencies = {
    stateStore,
    interactive: false,
    sessionFactory: async () => ({ controlPath: null, interactive: false }),
    closeSession: () => {},
    probeArchitecture: async () => {
      architectureProbes += 1;
      if (architectureProbes > 1) throw new Error("resume must not repeat architecture selection");
      return "amd64";
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
  assert.equal(architectureProbes, 1);
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
  let architectureProbes = 0;
  let downloads = 0;
  const result = await installHostCluster({
    onboarding: { operation_id: operationId }, state: { operation_id: operationId }, paths,
    options: { yes: true },
  }, {
    stateStore, interactive: false,
    sessionFactory: async () => ({ controlPath: null, interactive: false }), closeSession: () => {},
    probeArchitecture: async () => { architectureProbes += 1; throw new Error("must not re-select architecture"); },
    acquireArtifact: async () => { downloads += 1; throw new Error("must not download"); },
    reconcile: async () => ({ disposition: "not_started", ownershipVerified: true, bytesVerified: true }),
    execute: async () => { executions += 1; return { interrupted: false }; },
    verify: async () => ({ consoleUrl: "http://10.0.0.1:7070" }),
  });
  assert.equal(result.verification.consoleUrl, "http://10.0.0.1:7070");
  assert.equal(executions, 1);
  assert.equal(architectureProbes, 0);
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
    probeArchitecture: async () => { sideEffects += 1; }, acquireArtifact: async () => { sideEffects += 1; },
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
      probeArchitecture: async () => { other += 1; }, acquireArtifact: async () => { other += 1; },
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
