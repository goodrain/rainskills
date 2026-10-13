"use strict";

// Runs in a child process so platform, HOME lookup, and OS mocks cannot leak.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const childProcess = require("node:child_process");

const [packageRoot, probeHome, scenario, bridgePath] = process.argv.slice(2);
const simulatedWindows = process.platform !== "win32";
const sid = "S-1-5-21-111-222-333-1001";
const actions = [];
let unsafeAcl = false;

if (simulatedWindows) {
  Object.defineProperty(process, "platform", { value: "win32" });
  childProcess.spawnSync = (command, args) => {
    if (path.win32.basename(command).toLowerCase() === "whoami.exe") {
      actions.push("whoami");
      return { status: 0, stdout: `"test\\user","${sid}"` };
    }
    assert.equal(command, "powershell.exe");
    const action = args[args.indexOf("-Action") + 1];
    assert(["InspectState", "ProtectState"].includes(action));
    assert.equal(args[args.indexOf("-UserSid") + 1], sid);
    assert.equal(args[args.indexOf("-UserHome") + 1], probeHome);
    actions.push(action);
    return { status: 0, stdout: JSON.stringify({
      ownerSid: sid,
      writableSids: [sid],
      readableSids: unsafeAcl ? [sid, "S-1-1-0"] : [sid],
      reparsePoint: false,
    }) };
  };
}
os.homedir = () => probeHome;
process.env.RAINSKILLS_TELEMETRY_DISABLED = "1";
globalThis.fetch = async () => { throw new Error("Unexpected network request"); };

const scripts = path.join(packageRoot, "rainbond-platform-installer", "scripts");
const { createSingleRuntimeStore } = require(path.join(scripts, "single-runtime.js"));
const { createWindowsSecureStateStore } = require(path.join(scripts, "windows-platform.js"));
const token = "fixture.payload.signature";
const credential = { consoleOrigin: "https://runtime.example.invalid", kind: "private", token };
let renewedToken = token;
require(path.join(scripts, "windows-client-config.js")).validateMcp = async () => ({ token: renewedToken });
const { runBuiltin } = require(path.join(packageRoot, "bin", "rainskills.js"));
const bridge = require(bridgePath || path.join(packageRoot, "bin", "rainskills-tools.js"));
const output = [];
const write = (value) => output.push(JSON.parse(value));

async function main() {
  if (scenario === "existing") {
    // Seed through the known-good Windows factory, then exercise default callers.
    createSingleRuntimeStore({ stateStore: createWindowsSecureStateStore() }).write(credential);
    const before = fs.readFileSync(createSingleRuntimeStore().path);
    await runBuiltin(["runtime", "status", "--json"], { write });
    assert.equal(output.at(-1).state, "connected");
    assert.equal(output.at(-1).usable, true);
    assert.equal(bridge.loadConfig({ env: {} }).jwt, token);
    assert.deepEqual(fs.readFileSync(createSingleRuntimeStore().path), before);
  } else {
    await runBuiltin(["runtime", "status", "--json"], { write });
    assert.equal(output.at(-1).state, "not_started");
    // Exercise the actual state manager and credential store; only remote auth is mocked.
    const dependencies = {
      write,
      control: { mode: "windows-native" },
      originInspector: async () => ({ origin: credential.consoleOrigin }),
      connectionRunner: async (_invocation, { completeWithCredential }) => {
        await completeWithCredential(renewedToken);
        return { code: 0, completesRuntimeState: true };
      },
    };
    await runBuiltin([
      "runtime", "connect", "codex", "--rainbond-url", credential.consoleOrigin,
    ], dependencies);
    assert.equal(output.at(-1).state, "connected");
    assert.equal(createSingleRuntimeStore().read().token, token);

    renewedToken = "renewed.payload.signature";
    await runBuiltin(["runtime", "status", "--json"], { write });
    assert.equal(output.at(-1).usable, true);
    assert.equal(bridge.loadConfig({ env: {} }).jwt, renewedToken);
    await runBuiltin(["runtime", "reconnect", "codex"], dependencies);
    assert.equal(output.at(-1).state, "connected");
    assert.equal(createSingleRuntimeStore().read().token, renewedToken);
  }

  for (const value of output) {
    assert(!JSON.stringify(value).includes(token));
    assert(!JSON.stringify(value).includes(renewedToken));
  }
  if (simulatedWindows) {
    assert(actions.includes("whoami"));
    assert(actions.includes("ProtectState"));
    assert(actions.includes("InspectState"));
    unsafeAcl = true;
    await assert.rejects(runBuiltin(["runtime", "status", "--json"], { write }), /其他普通用户读取/);
    assert.throws(() => bridge.loadConfig({ env: {} }), /其他普通用户读取/);
    unsafeAcl = false;
  }
  assert.equal(createSingleRuntimeStore().remove(), true);
  assert.equal(createSingleRuntimeStore().read(), null);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
