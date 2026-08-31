const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const YAML = require("yaml");

const modulePath = path.resolve(
  __dirname,
  "..",
  "rainbond-platform-installer",
  "scripts",
  "ssh-key-setup.js"
);

test("SSH prepare validates fixed arguments and rejects unsafe targets", () => {
  const { parseSshPrepareArgs } = require(modulePath);
  assert.deepEqual(
    parseSshPrepareArgs(["prepare", "--ssh", "root@example.com", "--ssh-port", "2202"]),
    { command: "prepare", ssh: "root@example.com", sshPort: 2202 }
  );
  assert.throws(() => parseSshPrepareArgs(["prepare", "--ssh", "root@host;id"]), /SSH/);
  assert.throws(() => parseSshPrepareArgs(["prepare", "--ssh", "root@host\ninvalid"]), /SSH/);
  assert.throws(() => parseSshPrepareArgs(["prepare", "--unknown", "value"]), /未知参数/);
});

test("cluster SSH prepare parses one protected config path and rejects unrelated arguments", () => {
  const { parseSshPrepareArgs } = require(modulePath);
  const configPath = path.join(os.tmpdir(), "rainskills cluster", "cluster.yaml");
  assert.deepEqual(
    parseSshPrepareArgs(["prepare-cluster", "--cluster-config", configPath]),
    { command: "prepare-cluster", clusterConfig: path.resolve(configPath) }
  );
  assert.throws(
    () => parseSshPrepareArgs(["prepare-cluster", "--cluster-config", "bad\npath"]),
    /cluster-config|配置路径/i
  );
  assert.throws(
    () => parseSshPrepareArgs(["prepare-cluster", "--ssh", "root@example.com"]),
    /未知参数|cluster-config/i
  );
});

test("cluster SSH prepare labels every node, runs sequentially, and reports completion once", async () => {
  const { prepareClusterSshAccess } = require(modulePath);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rainskills-ssh-batch-"));
  fs.chmodSync(root, 0o700);
  const configPath = path.join(root, "cluster.yaml");
  const config = {
    hosts: [
      { name: "node1", address: "118.196.125.15", internalAddress: "118.196.125.15", user: "root", password: "fixture-password", port: 22, bootstrap: true },
      { name: "node2", address: "118.196.125.168", internalAddress: "118.196.125.168", user: "root", password: "fixture-password", port: 2202 },
      { name: "node3", address: "118.196.125.169", internalAddress: "118.196.125.169", user: "root", password: "fixture-password", port: 22 },
    ],
    roleGroups: {
      etcd: ["node1", "node2", "node3"], master: ["node1", "node2", "node3"], worker: ["node1", "node2", "node3"],
      "rbd-gateway": ["node1", "node2"], "rbd-chaos": ["node1", "node2", "node3"], "nfs-server": ["node1"],
    },
    storage: { nfs: { enabled: true, sharePath: "/nfs-data/k8s", storageClass: { enabled: true } }, existingStorageClass: { enabled: false } },
    registry: { external: { enabled: false } },
    database: { mysql: { enabled: false }, custom: { enabled: false } },
  };
  fs.writeFileSync(configPath, YAML.stringify(config), { mode: 0o600 });
  const calls = [];
  const output = [];
  const result = await prepareClusterSshAccess(
    { clusterConfig: configPath },
    {
      interactive: true,
      probeAccess: () => false,
      prepareAccess: async (options, dependencies) => {
        calls.push({ options, dependencies });
        dependencies.write(`prepared ${options.ssh}\n`);
        return { ok: true };
      },
      write: (value) => output.push(value),
    }
  );

  assert.equal(result.ok, true);
  assert.deepEqual(calls.map(({ options }) => options), [
    { ssh: "root@118.196.125.15", sshPort: 22 },
    { ssh: "root@118.196.125.168", sshPort: 2202 },
    { ssh: "root@118.196.125.169", sshPort: 22 },
  ]);
  assert(calls.every(({ dependencies }) => dependencies.completionMessage === false));
  const message = output.join("");
  assert.match(message, /\[1\/3\].*node1.*root@118\.196\.125\.15:22/s);
  assert.match(message, /\[2\/3\].*node2.*root@118\.196\.125\.168:2202/s);
  assert.match(message, /\[3\/3\].*node3.*root@118\.196\.125\.169:22/s);
  assert.equal((message.match(/全部 3 台服务器的 SSH 连接已准备完成/g) || []).length, 1);
  assert.equal((message.match(/请回到原来的 AI 任务并回复“已完成”/g) || []).length, 1);
});

test("cluster SSH prepare skips nodes that became reachable before the batch command runs", async () => {
  const { prepareClusterSshAccess } = require(modulePath);
  const prepared = [];
  const output = [];
  const result = await prepareClusterSshAccess(
    { clusterConfig: "/protected/cluster.yaml" },
    {
      interactive: true,
      loadTopology: () => ({ hosts: [
        { name: "ready", address: "10.0.0.1", user: "root", port: 22 },
        { name: "pending", address: "10.0.0.2", user: "root", port: 22 },
      ] }),
      probeAccess: ({ ssh }) => ssh.endsWith("10.0.0.1"),
      prepareAccess: async ({ ssh }) => { prepared.push(ssh); return { ok: true }; },
      write: (value) => output.push(value),
    }
  );
  assert.equal(result.ok, true);
  assert.deepEqual(prepared, ["root@10.0.0.2"]);
  assert.match(output.join(""), /ready.*已可免密连接，跳过/s);
});

test("cluster SSH prepare stops at the failing node and identifies it", async () => {
  const { prepareClusterSshAccess } = require(modulePath);
  const calls = [];
  await assert.rejects(
    prepareClusterSshAccess(
      { clusterConfig: "/protected/cluster.yaml" },
      {
        interactive: true,
        probeAccess: () => false,
        loadTopology: () => ({ hosts: [
          { name: "node1", address: "10.0.0.1", user: "root", port: 22 },
          { name: "node2", address: "10.0.0.2", user: "root", port: 22 },
          { name: "node3", address: "10.0.0.3", user: "root", port: 22 },
        ] }),
        prepareAccess: async ({ ssh }) => {
          calls.push(ssh);
          if (ssh.endsWith("10.0.0.2")) throw new Error("authentication failed");
          return { ok: true };
        },
        write: () => {},
      }
    ),
    /node2.*root@10\.0\.0\.2.*准备失败/i
  );
  assert.deepEqual(calls, ["root@10.0.0.1", "root@10.0.0.2"]);
});

test("SSH prepare requires a real terminal before creating keys or contacting a server", async () => {
  const { prepareSshAccess } = require(modulePath);
  let mutations = 0;
  await assert.rejects(
    prepareSshAccess(
      { ssh: "root@example.com", sshPort: 22 },
      {
        interactive: false,
        ensureIdentity: () => { mutations += 1; },
        attachedRunner: async () => { mutations += 1; },
      }
    ),
    /系统终端/
  );
  assert.equal(mutations, 0);
});

test("SSH prepare installs only a public key and verifies BatchMode access", async () => {
  const { prepareSshAccess } = require(modulePath);
  const calls = [];
  const output = [];
  const result = await prepareSshAccess(
    { ssh: "root@example.com", sshPort: 2202 },
    {
      interactive: true,
      ensureIdentity: () => ({
        privateKeyPath: path.join(os.tmpdir(), "rainskills-test-id"),
        publicKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITest rainskills",
      }),
      attachedRunner: async (command, args, options) => {
        calls.push({ command, args, options });
        return { code: 0, signal: null };
      },
      verifier: (command, args, options) => {
        calls.push({ command, args, options });
        return { status: 0, stdout: "", stderr: "" };
      },
      write: (value) => output.push(value),
    }
  );

  assert.equal(result.ok, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].command, "ssh");
  assert(calls[0].args.includes("BatchMode=no"));
  assert.equal(calls[0].options.interactive, true);
  assert.match(calls[0].options.input, /^ssh-ed25519 /);
  assert.match(calls[0].args.at(-1), /\[ -L \"\$HOME\/\.ssh\" \]/);
  assert.match(calls[0].args.at(-1), /\[ -L \"\$HOME\/\.ssh\/authorized_keys\" \]/);
  assert.equal(calls[1].command, "ssh");
  assert(calls[1].args.includes("BatchMode=yes"));
  assert.doesNotMatch(output.join(""), /AAAAC3Nza/);
  assert.match(output.join(""), /SSH 连接准备完成/);
});

test("SSH prepare never treats a failed verification as success", async () => {
  const { prepareSshAccess } = require(modulePath);
  await assert.rejects(
    prepareSshAccess(
      { ssh: "root@example.com", sshPort: 22 },
      {
        interactive: true,
        ensureIdentity: () => ({
          privateKeyPath: path.join(os.tmpdir(), "rainskills-test-id"),
          publicKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITest rainskills",
        }),
        attachedRunner: async () => ({ code: 0, signal: null }),
        verifier: () => ({ status: 255, stdout: "", stderr: "Permission denied" }),
        write: () => {},
      }
    ),
    /免密连接验证失败/
  );
});
