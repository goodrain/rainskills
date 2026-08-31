"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const launcherPath = path.resolve(__dirname, "../bin/rainskills.js");
const {
  classifyNodeMajor,
  parseRuntimeConnectArgs,
  resolveInvocation,
  runtimeChildEnvironment,
  runtimeConnectionInvocation,
  runAttached,
  runAutoUpdatePhase,
  runBuiltin,
} = require(launcherPath);

test("launcher exposes the supported Node policy", () => {
  assert.equal(classifyNodeMajor(17), "unsupported");
  assert.equal(classifyNodeMajor(18), "eol");
  assert.equal(classifyNodeMajor(20), "eol");
  assert.equal(classifyNodeMajor(22), "supported");
});

test("launcher rejects the removed local MCP entry point", () => {
  assert.throws(
    () => resolveInvocation(["mcp", "serve", "--client", "codex"]),
    /不再提供本地 MCP 服务/
  );
});

test("launcher forwards package-upload to the protected tools CLI", () => {
  const args = [
    "package-upload", "--archive", "/tmp/package.zip", "--input", "-",
    "--skill-id", "rainbond-fullstack-bootstrap",
  ];
  const invocation = resolveInvocation(args, {
    execPath: "/usr/bin/node",
  });

  assert.deepEqual(invocation, {
    executable: "/usr/bin/node",
    args: [path.resolve(__dirname, "../bin/rainskills-tools.js"), ...args],
  });
});

test("delegated auto-update refreshes the local CLI before installed Skills", async () => {
  const events = [];
  const result = await runAutoUpdatePhase(["runtime", "status", "--json"], {
    currentVersion: "1.2.4",
    env: {
      RAINSKILLS_AUTO_UPDATE_HOP: "1",
      RAINSKILLS_AUTO_UPDATE_FROM: "1.2.3",
      RAINSKILLS_AUTO_UPDATE_TARGET: "1.2.4",
    },
    home: "/tmp/rainskills-home",
    packageRoot: "/tmp/rainskills-package",
    activeOperationDetector: () => false,
    installCli(input) {
      events.push(["cli", input]);
    },
    synchronizeSkills(input) {
      events.push(["skills", input]);
    },
    updateState: {
      recordApplied(version) { events.push(["applied", version]); },
      recordFailure() { events.push(["failed"]); },
    },
  });

  assert.deepEqual(result, { handled: false, reason: "delegated-sync-complete" });
  assert.deepEqual(events.map(([event]) => event), ["cli", "skills", "applied"]);
  assert.deepEqual(events[0][1], {
    sourceRoot: "/tmp/rainskills-package",
    home: "/tmp/rainskills-home",
  });
  assert.equal(events[1][1].packageRoot, "/tmp/rainskills-package");
  assert.equal(events[1][1].home, "/tmp/rainskills-home");
});

test("delegated auto-update never publishes new Skills when CLI refresh fails", async () => {
  let skillSynchronizations = 0;
  let failures = 0;
  const result = await runAutoUpdatePhase(["runtime", "status", "--json"], {
    currentVersion: "1.2.4",
    env: {
      RAINSKILLS_AUTO_UPDATE_HOP: "1",
      RAINSKILLS_AUTO_UPDATE_FROM: "1.2.3",
      RAINSKILLS_AUTO_UPDATE_TARGET: "1.2.4",
    },
    activeOperationDetector: () => false,
    installCli() { throw new Error("CLI refresh failed"); },
    synchronizeSkills() { skillSynchronizations += 1; },
    updateState: {
      recordApplied() { throw new Error("must not record a failed update"); },
      recordFailure() { failures += 1; },
    },
  });

  assert.deepEqual(result, {
    handled: true,
    code: 75,
    signal: null,
  });
  assert.equal(skillSynchronizations, 0);
  assert.equal(failures, 1);
});

test("delegated auto-update installs the real runtime bundle and package-upload bridge", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "rainskills-delegated-install-"));
  const packageRoot = path.resolve(__dirname, "..");
  const currentVersion = require("../package.json").version;
  const result = await runAutoUpdatePhase(["runtime", "status", "--json"], {
    currentVersion,
    env: {
      RAINSKILLS_AUTO_UPDATE_HOP: "1",
      RAINSKILLS_AUTO_UPDATE_FROM: "0.1.33",
      RAINSKILLS_AUTO_UPDATE_TARGET: currentVersion,
    },
    home,
    packageRoot,
    activeOperationDetector: () => false,
    synchronizeSkills() {},
    updateState: {
      recordApplied() {},
      recordFailure() { throw new Error("real CLI installation must succeed"); },
    },
  });

  assert.deepEqual(result, { handled: false, reason: "delegated-sync-complete" });
  const installedRoot = path.join(home, ".rainbond", "lib", "rainskills");
  assert.equal(require(path.join(installedRoot, "package.json")).version, currentVersion);
  const installedBridge = path.join(home, ".rainbond", "bin", "rainskills-tools.js");
  assert.equal(fs.existsSync(installedBridge), true);
  assert.equal(require(installedBridge).parseCommand([
    "package-upload", "--archive", "/tmp/package.zip", "--input", "-",
    "--skill-id", "rainbond-fullstack-bootstrap",
  ]).command, "package-upload");
});

test("runtime connect accepts one environment route without a business intent", () => {
  assert.deepEqual(parseRuntimeConnectArgs([
    "runtime", "connect", "codex", "--saas",
  ]), {
    targetClient: "codex",
    environmentChoice: "saas",
    rainbondUrl: "",
    allowInsecureHttp: false,
    privateLocation: undefined,
  });
  assert.deepEqual(parseRuntimeConnectArgs([
    "runtime", "connect", "claude", "--rainbond-url", "https://console.example.com",
  ]), {
    targetClient: "claude",
    environmentChoice: "private-existing",
    rainbondUrl: "https://console.example.com",
    allowInsecureHttp: false,
    privateLocation: undefined,
  });
  for (const targetClient of ["dsh", "workbuddy"]) {
    assert.equal(parseRuntimeConnectArgs([
      "runtime", "connect", targetClient, "--saas",
    ]).targetClient, targetClient);
  }
  assert.throws(() => parseRuntimeConnectArgs([
    "runtime", "connect", "codex", "--saas", "--rainbond-url", "https://other.example.com",
  ]), /互斥/);
});

test("runtime connector child never inherits a cached credential", () => {
  const token = "header.payload.signature";
  const forwarded = runtimeChildEnvironment({
    HOME: "/tmp/home",
    PATH: "/usr/bin",
    RAINBOND_URL: "https://console.example.com/",
    RAINBOND_JWT: token,
    UNRELATED_SECRET: "no",
  }, {}, "https://console.example.com");
  assert.equal(forwarded.RAINBOND_JWT, undefined);
  assert.equal(forwarded.RAINBOND_URL, undefined);
  assert.equal(forwarded.UNRELATED_SECRET, undefined);

  const rejected = runtimeChildEnvironment({
    RAINBOND_URL: "https://other.example.com",
    RAINBOND_JWT: token,
  }, {}, "https://console.example.com");
  assert.equal(rejected.RAINBOND_JWT, undefined);
});

test("runtime connector preserves only the browser routing environment needed by Device Flow", () => {
  const forwarded = runtimeChildEnvironment({
    HOME: "/tmp/home",
    PATH: "/usr/bin",
    DISPLAY: ":0",
    WAYLAND_DISPLAY: "wayland-0",
    XDG_RUNTIME_DIR: "/run/user/1000",
    DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
    WSL_INTEROP: "/run/WSL/1_interop",
    WSL_DISTRO_NAME: "Ubuntu",
    SSH_CONNECTION: "client 123 server 22",
    SSH_CLIENT: "client 123 22",
    SSH_TTY: "/dev/pts/1",
    container: "podman",
    UNRELATED_SECRET: "must-not-pass",
  });

  assert.deepEqual(forwarded, {
    HOME: "/tmp/home",
    PATH: "/usr/bin",
    DISPLAY: ":0",
    WAYLAND_DISPLAY: "wayland-0",
    XDG_RUNTIME_DIR: "/run/user/1000",
    DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
    WSL_INTEROP: "/run/WSL/1_interop",
    WSL_DISTRO_NAME: "Ubuntu",
    SSH_CONNECTION: "client 123 server 22",
    SSH_CLIENT: "client 123 22",
    SSH_TTY: "/dev/pts/1",
    container: "podman",
  });
});

test("POSIX runtime connection uses fixed installer argv", () => {
  const invocation = runtimeConnectionInvocation({
    targetClient: "codex",
    environmentChoice: "private-existing",
    allowInsecureHttp: true,
  }, "http://10.0.0.8:7070");
  assert.deepEqual(invocation, {
    executable: "bash",
    args: [
      path.resolve(__dirname, "../install.sh"),
      "connect", "codex", "--self-hosted", "--rainbond-url", "http://10.0.0.8:7070",
      "--allow-insecure-http", "--no-cached-token",
    ],
  });
});

test("attached runtime connector receives task interruption signals and releases listeners", async () => {
  const signals = new EventEmitter();
  const child = new EventEmitter();
  const killed = [];
  child.kill = (signal) => {
    killed.push(signal);
    return true;
  };

  const pending = runAttached("bash", ["install.sh", "connect"], {
    signalSource: signals,
    spawnImpl(executable, args, options) {
      assert.equal(executable, "bash");
      assert.deepEqual(args, ["install.sh", "connect"]);
      assert.equal(options.stdio, "inherit");
      return child;
    },
  });

  signals.emit("SIGTERM");
  assert.deepEqual(killed, ["SIGTERM"]);
  child.emit("close", 143, null);

  assert.deepEqual(await pending, { code: 143, signal: null });
  assert.equal(signals.listenerCount("SIGINT"), 0);
  assert.equal(signals.listenerCount("SIGTERM"), 0);
});

test("private platform installation returns one bounded next action", async () => {
  const output = [];
  const next = {
    schema: "rainskills.next-action.v1",
    action: "install-platform",
    onboarding_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    argv: ["platform", "install", "--onboarding-id", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"],
  };
  assert.equal(await runBuiltin([
    "runtime", "connect", "codex", "--install-private", "--location", "local",
  ], {
    privateInstallerScheduler(input) {
      assert.equal(input.intent, undefined);
      assert.equal(input.privateLocation, "local");
      return next;
    },
    write: (value) => output.push(value),
  }), true);
  assert.deepEqual(JSON.parse(output.join("")), next);
});

test("runtime status remains an in-process command", async () => {
  const output = [];
  assert.equal(await runBuiltin(["runtime", "status", "--json"], {
    runtimeStateManager: {
      status: async () => ({
        schema: "rainskills.runtime-status.v1",
        state: "connected",
        usable: true,
      }),
    },
    write: (value) => output.push(value),
  }), true);
  const status = JSON.parse(output.join(""));
  assert.equal(status.usable, true);
  assert.equal(status.package_version, require("../package.json").version);
});

test("failed runtime authorization clears only its own connecting state", async () => {
  const output = [];
  const started = [];
  const startOptions = [];
  const aborted = [];
  const telemetry = [];
  const manager = {
    startConnecting(value, options) { started.push(value); startOptions.push(options); },
    abortConnecting(value) { aborted.push(value); return true; },
  };

  await assert.rejects(() => runBuiltin([
    "runtime", "connect", "codex", "--saas",
  ], {
    runtimeStateManager: manager,
    singleRuntimeStore: { read: () => null },
    originInspector: async () => ({
      origin: "https://run.rainbond.com",
      httpConfirmationRequired: false,
      pendingRedirectOrigin: null,
    }),
    connectionRunner: async () => {
      throw new Error("authorization failed");
    },
    resultTelemetryFactory: () => ({
      recordRuntimeConnect(status, details) {
        telemetry.push({ status, details });
        return { recorded: true, delivery: Promise.resolve(true) };
      },
    }),
    write: (value) => output.push(value),
  }), /authorization failed/);

  assert.equal(started.length, 1);
  assert.deepEqual(startOptions, [{ replaceExisting: true }]);
  assert.equal(aborted.length, 1);
  assert.deepEqual(aborted[0], started[0]);
  assert.equal(JSON.parse(output.join("")).action, "retry-runtime-connect");
  assert.deepEqual(telemetry, [{
    status: "failed",
    details: {
      environment_kind: "saas",
      error_stage: "authorization",
      error_code: "authorization_failed",
    },
  }]);
});

test("successful runtime connection reports activation only after credential persistence and live probe", async () => {
  const output = [];
  const telemetry = [];
  let state = null;
  let storedRuntime = null;
  const manager = {
    startConnecting(value) { state = { ...value, state: "connecting" }; },
    async markConnected(value) { state = { ...value, state: "connected" }; },
    read: () => state,
  };
  const store = {
    read: () => storedRuntime,
    write(value) {
      storedRuntime = {
        console_origin: value.consoleOrigin,
        kind: value.kind,
        token: value.token,
      };
    },
  };

  assert.equal(await runBuiltin([
    "runtime", "connect", "codex", "--rainbond-url", "https://private.example.com",
  ], {
    runtimeStateManager: manager,
    singleRuntimeStore: store,
    originInspector: async () => ({
      origin: "https://private.example.com",
      httpConfirmationRequired: false,
      pendingRedirectOrigin: null,
    }),
    connectionRunner: async (_invocation, { completeWithCredential }) => {
      await completeWithCredential("header.payload.signature");
      return { code: 0, signal: null, completesRuntimeState: true };
    },
    resultTelemetryFactory(context) {
      assert.equal(context.agentType, "codex");
      assert.equal(context.packageVersion, require("../package.json").version);
      return {
        recordRuntimeConnect(status, details) {
          assert(storedRuntime, "credential must be stored before activation telemetry");
          assert.equal(state.state, "connected");
          telemetry.push({ status, details });
          return { recorded: true, delivery: Promise.resolve(true) };
        },
      };
    },
    write: (value) => output.push(value),
  }), true);

  assert.equal(JSON.parse(output.join("")).state, "connected");
  assert.deepEqual(telemetry, [{
    status: "success",
    details: { environment_kind: "private" },
  }]);
});
