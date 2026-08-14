"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const { createPortableSecureStateStore } = require("./helpers/portable-secure-state.js");

const modulePath = path.resolve(
  __dirname,
  "..",
  "rainbond-platform-installer",
  "scripts",
  "runtime-credentials.js"
);
const fixtureJwt = "fixtureHeader.fixturePayload.fixtureSignature";

function createPosixCredential(home, origin, mode = 0o600) {
  const directory = path.join(home, ".rainbond");
  fs.mkdirSync(directory, { mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  const credentialPath = path.join(directory, "mcp.env");
  fs.writeFileSync(credentialPath, [
    `export RAINBOND_JWT='${fixtureJwt}'`,
    `export RAINBOND_URL='${origin}'`,
    "",
  ].join("\n"), { mode });
  fs.chmodSync(credentialPath, mode);
  return credentialPath;
}

test("POSIX credential reader accepts only protected fixed syntax for the exact origin", () => {
  const { readPosixRuntimeCredential } = require(modulePath);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "rainskills-credential-posix-"));
  const origin = "http://10.0.0.8:7070";
  createPosixCredential(home, origin);

  const credential = readPosixRuntimeCredential({ home, expectedOrigin: origin });
  assert.equal(credential.token === fixtureJwt, true);
  assert.equal(credential.origin, origin);

  assert.throws(
    () => readPosixRuntimeCredential({ home, expectedOrigin: "http://10.0.0.9:7070" }),
    /origin|匹配|凭据/i
  );
  fs.writeFileSync(path.join(home, ".rainbond", "mcp.env"), [
    `export RAINBOND_URL='${origin}'`,
    `export RAINBOND_JWT='${fixtureJwt}'`,
    "",
  ].join("\n"), { mode: 0o600 });
  assert.throws(
    () => readPosixRuntimeCredential({ home, expectedOrigin: origin }),
    /语法|凭据/i
  );
});

test("POSIX credential reader fails closed for mode and symlink changes", () => {
  const { readPosixRuntimeCredential } = require(modulePath);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "rainskills-credential-mode-"));
  const origin = "https://rainbond.example.com";
  const credentialPath = createPosixCredential(home, origin, 0o644);
  assert.throws(
    () => readPosixRuntimeCredential({ home, expectedOrigin: origin }),
    /0600|权限|凭据/i
  );

  fs.unlinkSync(credentialPath);
  const target = path.join(home, "outside.env");
  fs.writeFileSync(target, "fixture", { mode: 0o600 });
  fs.symlinkSync(target, credentialPath);
  assert.throws(
    () => readPosixRuntimeCredential({ home, expectedOrigin: origin }),
    /symlink|符号链接|凭据/i
  );
});

test("Windows credential reader captures user environment through a protected file, not stdout", () => {
  const { readWindowsRuntimeCredential } = require(modulePath);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "rainskills-credential-windows-"));
  const stateStore = createPortableSecureStateStore(home);
  const origin = "https://rainbond.example.com";
  const calls = [];
  const credential = readWindowsRuntimeCredential({
    home,
    expectedOrigin: origin,
    stateStore,
    spawnImpl(command, args, options) {
      calls.push({ command, args, stdout: options.stdio });
      return spawnSync(process.execPath, ["-e", [
        "const fs = require('node:fs');",
        "fs.writeFileSync(process.env.RAINSKILLS_CREDENTIAL_OUTPUT_PATH, JSON.stringify({",
        "  token: process.env.TEST_WINDOWS_TOKEN,",
        "  origin: process.env.TEST_WINDOWS_ORIGIN,",
        "}));",
      ].join("\n")], {
        env: {
          RAINSKILLS_CREDENTIAL_OUTPUT_PATH: options.env.RAINSKILLS_CREDENTIAL_OUTPUT_PATH,
          TEST_WINDOWS_TOKEN: fixtureJwt,
          TEST_WINDOWS_ORIGIN: origin,
        },
        encoding: "utf8",
      });
    },
  });

  assert.equal(credential.token === fixtureJwt, true);
  assert.equal(credential.origin, origin);
  assert.equal(calls[0].command, "powershell.exe");
  assert.deepEqual(calls[0].stdout, ["ignore", "ignore", "ignore"]);
  assert.equal(fs.readdirSync(path.join(home, ".rainbond", "rainskills")).length, 0);
  const helper = fs.readFileSync(path.join(
    path.dirname(modulePath), "windows-read-user-environment.ps1"
  ), "utf8");
  assert.match(helper, /GetEnvironmentVariable\("RAINBOND_JWT", "User"\)/);
  assert.match(helper, /WriteAllText\(\$outputPath/);
  assert.doesNotMatch(helper, /Write-Output|Write-Host|Console\]::Write|echo\s/i);
});

test("Windows credential reader fails closed on origin mismatch", () => {
  const { readWindowsRuntimeCredential } = require(modulePath);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "rainskills-credential-windows-mismatch-"));
  const stateStore = createPortableSecureStateStore(home);

  assert.throws(() => readWindowsRuntimeCredential({
    home,
    expectedOrigin: "https://rainbond.example.com",
    stateStore,
    spawnImpl(command, args, options) {
      fs.writeFileSync(options.env.RAINSKILLS_CREDENTIAL_OUTPUT_PATH, JSON.stringify({
        token: fixtureJwt,
        origin: "https://other.example.com",
      }));
      return { status: 0, signal: null, stdout: "", stderr: "" };
    },
  }), /origin|匹配|凭据/i);
});

test("Windows credential reader rejects helper symlink and permission tampering", () => {
  const { readWindowsRuntimeCredential } = require(modulePath);
  const origin = "https://rainbond.example.com";

  for (const tamper of ["symlink", "mode"]) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), `rainskills-credential-windows-${tamper}-`));
    const stateStore = createPortableSecureStateStore(home);
    assert.throws(() => readWindowsRuntimeCredential({
      home,
      expectedOrigin: origin,
      stateStore,
      spawnImpl(command, args, options) {
        const outputPath = options.env.RAINSKILLS_CREDENTIAL_OUTPUT_PATH;
        fs.writeFileSync(outputPath, JSON.stringify({ token: fixtureJwt, origin }));
        if (tamper === "mode") {
          fs.chmodSync(outputPath, 0o644);
        } else {
          const target = path.join(home, "outside.json");
          fs.writeFileSync(target, "{}", { mode: 0o600 });
          fs.unlinkSync(outputPath);
          fs.symlinkSync(target, outputPath);
        }
        return { status: 0, signal: null };
      },
    }), /symlink|符号链接|权限|0600|凭据/i);
  }
});
