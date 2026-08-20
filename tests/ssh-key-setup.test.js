const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

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
