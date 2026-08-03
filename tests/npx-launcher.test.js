const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const repoRoot = path.resolve(__dirname, "..");
const launcherPath = path.join(repoRoot, "bin", "rainskills.js");
const controlEnvironmentPath = path.join(
  repoRoot,
  "rainbond-platform-installer",
  "scripts",
  "control-environment.js"
);
const windowsOnboardingPath = path.join(
  repoRoot,
  "rainbond-platform-installer",
  "scripts",
  "windows-onboarding.js"
);

test("control environment distinguishes native Windows, WSL, and POSIX", () => {
  const { detectControlEnvironment } = require(controlEnvironmentPath);

  assert.deepEqual(detectControlEnvironment({
    platform: "win32",
    env: {},
    kernelRelease: "10.0.26100",
  }), {
    mode: "windows-native",
    hostPlatform: "win32",
    controlPlatform: "win32",
  });

  assert.deepEqual(detectControlEnvironment({
    platform: "linux",
    env: {
      WSL_INTEROP: "/run/WSL/1_interop",
      WSL_DISTRO_NAME: "Ubuntu",
    },
    kernelRelease: "6.6.87.2-microsoft-standard-WSL2",
  }), {
    mode: "wsl",
    hostPlatform: "win32",
    controlPlatform: "linux",
    controlDistro: "Ubuntu",
  });

  assert.deepEqual(detectControlEnvironment({
    platform: "linux",
    env: { WSL_DISTRO_NAME: "Ubuntu" },
    kernelRelease: "6.8.0-generic",
  }), {
    mode: "posix",
    hostPlatform: "linux",
    controlPlatform: "linux",
  });
});

test("WSL classification fails closed when the control distro is invalid", () => {
  const { detectControlEnvironment } = require(controlEnvironmentPath);

  assert.deepEqual(detectControlEnvironment({
    platform: "linux",
    env: {
      WSL_INTEROP: "/run/WSL/1_interop",
      WSL_DISTRO_NAME: "Ubuntu\nmalicious",
    },
    kernelRelease: "5.15.153.1-microsoft-standard-WSL2",
  }), {
    mode: "wsl",
    hostPlatform: "win32",
    controlPlatform: "linux",
  });
});

test("launcher has the Node shebang and classifies supported runtimes", () => {
  const source = fs.readFileSync(launcherPath, "utf8");
  assert.equal(source.split("\n", 1)[0], "#!/usr/bin/env node");

  const { classifyNodeMajor, resolveInvocation } = require(launcherPath);
  assert.equal(classifyNodeMajor(16), "unsupported");
  assert.equal(classifyNodeMajor(18), "eol");
  assert.equal(classifyNodeMajor(20), "eol");
  assert.equal(classifyNodeMajor(22), "supported");
  assert.equal(classifyNodeMajor(24), "supported");
  assert.deepEqual(resolveInvocation(["codex", "--skip-mcp"]), {
    executable: "bash",
    args: [path.join(repoRoot, "install.sh"), "codex", "--skip-mcp"],
  });
});

test("launcher preserves arguments and environment and returns the Bash exit code", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rainskills-launcher-"));
  const fakeBash = path.join(tempDir, "bash");
  const logPath = path.join(tempDir, "args.log");

  fs.writeFileSync(
    fakeBash,
    [
      "#!/bin/sh",
      ': > "$RAINSKILLS_TEST_LOG"',
      'for argument in "$@"; do',
      '  printf "%s\\n" "$argument" >> "$RAINSKILLS_TEST_LOG"',
      "done",
      'printf "marker=%s\\n" "$RAINSKILLS_TEST_MARKER" >> "$RAINSKILLS_TEST_LOG"',
      'exit "$RAINSKILLS_TEST_EXIT_CODE"',
      "",
    ].join("\n"),
    { mode: 0o755 }
  );

  const result = spawnSync(
    process.execPath,
    [launcherPath, "codex", "--rainbond-url", "https://example.com/path with space"],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${tempDir}${path.delimiter}${process.env.PATH || ""}`,
        RAINSKILLS_TEST_EXIT_CODE: "23",
        RAINSKILLS_TEST_LOG: logPath,
        RAINSKILLS_TEST_MARKER: "preserved",
      },
    }
  );

  assert.equal(result.status, 23, result.stderr);
  assert.deepEqual(fs.readFileSync(logPath, "utf8").trim().split("\n"), [
    path.join(repoRoot, "install.sh"),
    "codex",
    "--rainbond-url",
    "https://example.com/path with space",
    "marker=preserved",
  ]);
});

test("launcher routes native Windows onboarding to Node and keeps WSL on Bash", () => {
  const { resolveInvocation } = require(launcherPath);
  const fakeNode = path.join(repoRoot, "fake-node");

  assert.deepEqual(resolveInvocation(["codex", "--skip-mcp"], {
    control: {
      mode: "windows-native",
      hostPlatform: "win32",
      controlPlatform: "win32",
    },
    execPath: fakeNode,
  }), {
    executable: fakeNode,
    args: [windowsOnboardingPath, "codex", "--skip-mcp"],
  });

  assert.deepEqual(resolveInvocation(["codex", "--skip-mcp"], {
    control: {
      mode: "wsl",
      hostPlatform: "win32",
      controlPlatform: "linux",
      controlDistro: "Ubuntu",
    },
    execPath: fakeNode,
  }), {
    executable: "bash",
    args: [path.join(repoRoot, "install.sh"), "codex", "--skip-mcp"],
  });
});
