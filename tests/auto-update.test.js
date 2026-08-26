"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { PassThrough } = require("node:stream");

const repoRoot = path.resolve(__dirname, "..");
const workerPath = path.join(
  repoRoot,
  "rainbond-platform-installer",
  "scripts",
  "auto-update-worker.js"
);
const autoUpdatePath = path.join(
  repoRoot,
  "rainbond-platform-installer",
  "scripts",
  "auto-update.js"
);

const OFFICIAL_REGISTRY = "https://registry.npmjs.org/";
const MIRROR_REGISTRY = "https://registry.npmmirror.com/";

function updateDescriptor(version = "1.2.4", registry = OFFICIAL_REGISTRY) {
  const tarball = registry === MIRROR_REGISTRY
    ? `https://cdn.npmmirror.com/packages/rainskills/${version}/rainskills-${version}.tgz`
    : `${registry}rainskills/-/rainskills-${version}.tgz`;
  return {
    version,
    registry,
    tarball,
    integrity: `sha512-${Buffer.alloc(64, 1).toString("base64")}`,
  };
}

function descriptorForBytes(bytes, version = "1.2.4", registry = OFFICIAL_REGISTRY) {
  return {
    ...updateDescriptor(version, registry),
    integrity: `sha512-${crypto.createHash("sha512").update(bytes).digest("base64")}`,
  };
}

function fakeHttpsRequest(routes, calls = []) {
  return (url, options, callback) => {
    const request = new EventEmitter();
    request.setTimeout = () => {};
    request.destroy = (error) => process.nextTick(() => request.emit("error", error));
    calls.push({ url: String(url), options });
    process.nextTick(() => {
      const route = routes[String(url)];
      if (route instanceof Error) {
        request.emit("error", route);
        return;
      }
      const response = new PassThrough();
      response.statusCode = route?.statusCode ?? 200;
      response.headers = route?.headers || {};
      callback(response);
      if (Array.isArray(route?.chunks)) {
        for (const chunk of route.chunks) response.write(chunk);
        response.end();
      } else {
        response.end(route?.body || Buffer.alloc(0));
      }
    });
    return request;
  };
}

function temporaryHome() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rainskills-auto-update-")));
}

function writeSkill(root, name, body) {
  const directory = path.join(root, name);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(directory, "SKILL.md"),
    `---\nname: ${name}\ndescription: Test skill\n---\n\n${body}\n`,
    "utf8"
  );
  return directory;
}

test("prerelease builds never check npm and unsafe commands stay pinned", async () => {
  const { checkForStableUpdate } = require(autoUpdatePath);
  let fetches = 0;
  const fetchLatest = async () => {
    fetches += 1;
    return updateDescriptor();
  };

  assert.deepEqual(await checkForStableUpdate({
    args: ["runtime", "status", "--json"],
    currentVersion: "1.2.3-rc.1",
    fetchLatest,
  }), { action: "continue", reason: "current-prerelease" });
  assert.deepEqual(await checkForStableUpdate({
    args: ["resume", "--onboarding-id", "11111111-1111-4111-8111-111111111111"],
    currentVersion: "1.2.3",
    fetchLatest,
  }), { action: "continue", reason: "unsafe-entry" });
  assert.deepEqual(await checkForStableUpdate({
    args: ["platform", "install", "--onboarding-id", "11111111-1111-4111-8111-111111111111"],
    currentVersion: "1.2.3",
    fetchLatest,
  }), { action: "continue", reason: "unsafe-entry" });
  assert.equal(fetches, 0);
});

test("stable builds select only a newer stable npm latest version", async () => {
  const { checkForStableUpdate } = require(autoUpdatePath);
  const base = {
    args: ["runtime", "status", "--json"],
    currentVersion: "1.2.3",
    activeOperationDetector: () => false,
    updateState: {
      read: () => ({ checked_at: null }),
      recordCheck: () => {},
    },
  };

  assert.deepEqual(await checkForStableUpdate({
    ...base,
    fetchLatest: async () => updateDescriptor(),
  }), { action: "delegate", ...updateDescriptor() });
  assert.deepEqual(await checkForStableUpdate({
    ...base,
    fetchLatest: async () => ({ ...updateDescriptor(), version: "1.3.0-rc.1" }),
  }), { action: "continue", reason: "invalid-latest" });
  assert.deepEqual(await checkForStableUpdate({
    ...base,
    fetchLatest: async () => updateDescriptor("1.2.3"),
  }), { action: "continue", reason: "up-to-date" });
});

test("active operations, a one-hop delegate, and a fresh TTL skip update checks", async () => {
  const { checkForStableUpdate } = require(autoUpdatePath);
  let fetches = 0;
  const fetchLatest = async () => {
    fetches += 1;
    return updateDescriptor("9.0.0");
  };
  const common = {
    args: ["runtime", "status", "--json"],
    currentVersion: "1.2.3",
    fetchLatest,
  };

  assert.deepEqual(await checkForStableUpdate({
    ...common,
    env: { RAINSKILLS_AUTO_UPDATE_HOP: "1" },
  }), { action: "continue", reason: "delegated-hop" });
  assert.deepEqual(await checkForStableUpdate({
    ...common,
    activeOperationDetector: () => true,
  }), { action: "continue", reason: "active-operation" });
  assert.deepEqual(await checkForStableUpdate({
    ...common,
    activeOperationDetector: () => false,
    now: () => Date.parse("2026-08-17T12:00:00.000Z"),
    updateState: {
      read: () => ({ checked_at: "2026-08-17T11:30:00.000Z" }),
      recordCheck: () => {},
    },
  }), { action: "continue", reason: "fresh-check" });
  assert.equal(fetches, 0);
});

test("local runtime background update never waits for or exposes the npm child", async () => {
  const { runBackgroundAutoUpdate } = require(workerPath);
  const events = [];
  const result = await runBackgroundAutoUpdate({
    currentVersion: "1.2.3",
    env: { PATH: "/usr/bin" },
    updateState: {
      acquireLease: () => ({ release: () => events.push("release") }),
      recordFailure: () => events.push("failure"),
    },
    checkForUpdate: async () => ({ action: "delegate", ...updateDescriptor("1.2.4", MIRROR_REGISTRY) }),
    acquireArtifact: async () => ({ path: "/tmp/rainskills-1.2.4.tgz", cleanup() {} }),
    activeOperationDetector: () => false,
    runDelegated: async (invocation, environment) => {
      events.push({ invocation, environment });
      return { code: 0, signal: null };
    },
  });

  assert.equal(result.reason, "updated");
  assert.deepEqual(events[0].invocation, {
    executable: "npm",
    args: [
      "exec", "--yes", "--ignore-scripts", `--registry=${MIRROR_REGISTRY}`,
      "--package=/tmp/rainskills-1.2.4.tgz", "--", "rainskills",
      "runtime", "status", "--json",
    ],
  });
  assert.equal(events[0].environment.RAINSKILLS_AUTO_UPDATE_HOP, "1");
  assert.equal(events[0].environment.npm_config_registry, MIRROR_REGISTRY);
  assert.equal(events.at(-1), "release");
});

test("background update failure keeps the current version and active work prevents delegation", async () => {
  const { runBackgroundAutoUpdate } = require(workerPath);
  let delegates = 0;
  let failures = 0;
  const base = {
    currentVersion: "1.2.3",
    env: {},
    updateState: {
      acquireLease: () => ({ release() {} }),
      recordFailure: () => { failures += 1; },
    },
    checkForUpdate: async () => ({ action: "delegate", ...updateDescriptor() }),
    acquireArtifact: async () => ({ path: "/tmp/rainskills-1.2.4.tgz", cleanup() {} }),
  };

  assert.deepEqual(await runBackgroundAutoUpdate({
    ...base,
    activeOperationDetector: () => true,
    runDelegated: async () => { delegates += 1; },
  }), { action: "continue", reason: "active-operation" });
  assert.equal(delegates, 0);

  assert.deepEqual(await runBackgroundAutoUpdate({
    ...base,
    activeOperationDetector: () => false,
    runDelegated: async () => ({ code: 1, signal: null }),
  }), { action: "continue", reason: "delegated-update-failed" });
  assert.equal(failures, 1);
});

test("background update rechecks active work after download and cleans without spawning", async () => {
  const { runBackgroundAutoUpdate } = require(workerPath);
  let delegates = 0;
  let cleanups = 0;
  const result = await runBackgroundAutoUpdate({
    currentVersion: "1.2.3",
    env: {},
    updateState: { acquireLease: () => ({ release() {} }), recordFailure() {} },
    checkForUpdate: async () => ({ action: "delegate", ...updateDescriptor() }),
    acquireArtifact: async () => ({
      path: "/tmp/rainskills-1.2.4.tgz",
      cleanup: () => { cleanups += 1; },
    }),
    activeOperationDetector: () => true,
    runDelegated: async () => { delegates += 1; return { code: 0, signal: null }; },
  });
  assert.deepEqual(result, { action: "continue", reason: "active-operation" });
  assert.equal(delegates, 0);
  assert.equal(cleanups, 1);
});

test("the background updater never forwards credentials or TLS/npm overrides", () => {
  const { backgroundUpdateEnvironment } = require(workerPath);
  assert.deepEqual(backgroundUpdateEnvironment({
    HOME: "/home/test",
    PATH: "/usr/bin",
    HTTPS_PROXY: "http://proxy.internal",
    RAINBOND_JWT: "must-not-leak",
    RAINBOND_PASSWORD: "must-not-leak",
    NPM_TOKEN: "must-not-leak",
    npm_config_auth: "must-not-leak",
    npm_config_userconfig: "/tmp/untrusted-npmrc",
    npm_config_cafile: "/tmp/untrusted-ca",
    npm_config_strict_ssl: "false",
    NODE_TLS_REJECT_UNAUTHORIZED: "0",
    NODE_EXTRA_CA_CERTS: "/tmp/untrusted-ca",
    SSL_CERT_FILE: "/tmp/untrusted-ca",
    SSL_CERT_DIR: "/tmp/untrusted-ca-dir",
    NODE_OPTIONS: "--require=/tmp/untrusted.js",
  }), {
    HOME: "/home/test",
    PATH: "/usr/bin",
    HTTPS_PROXY: "http://proxy.internal",
  });
});

test("official npm metadata is pinned to the rainskills registry artifact", () => {
  const { validateOfficialLatestMetadata } = require(autoUpdatePath);
  assert.deepEqual(validateOfficialLatestMetadata({
    name: "rainskills",
    version: "2.1.0",
    dist: {
      integrity: `sha512-${Buffer.alloc(64, 1).toString("base64")}`,
      tarball: "https://registry.npmjs.org/rainskills/-/rainskills-2.1.0.tgz",
    },
  }), updateDescriptor("2.1.0"));
  assert.throws(() => validateOfficialLatestMetadata({
    name: "rainskills",
    version: "2.1.0",
    dist: {
      integrity: "sha512-YWJjZA==",
      tarball: "https://registry.npmjs.org/rainskills/-/rainskills-2.1.0.tgz",
    },
  }), /完整性|integrity/i);
  assert.throws(() => validateOfficialLatestMetadata({
    name: "rainskills",
    version: "2.1.0-rc.1",
    dist: {
      integrity: "sha512-YWJjZA==",
      tarball: "https://registry.npmjs.org/rainskills/-/rainskills-2.1.0-rc.1.tgz",
    },
  }), /stable|正式版/i);
  assert.throws(() => validateOfficialLatestMetadata({
    name: "rainskills",
    version: "2.1.0",
    dist: {
      integrity: "sha512-YWJjZA==",
      tarball: "https://example.com/rainskills-2.1.0.tgz",
    },
  }), /registry|来源/i);
});

test("the delegated command uses the protected local tarball and selected fixed registry", () => {
  const { buildStableUpdateInvocation, buildStableUpdateEnvironment } = require(autoUpdatePath);
  assert.deepEqual(buildStableUpdateInvocation(updateDescriptor("1.4.0", MIRROR_REGISTRY), ["runtime", "status", "--json"], {
    platform: "linux",
    artifactPath: "/protected/rainskills-1.4.0.tgz",
  }), {
    executable: "npm",
    args: [
      "exec", "--yes", "--ignore-scripts", `--registry=${MIRROR_REGISTRY}`,
      "--package=/protected/rainskills-1.4.0.tgz", "--", "rainskills",
      "runtime", "status", "--json",
    ],
  });
  assert.deepEqual(buildStableUpdateInvocation(updateDescriptor("1.4.0"), ["runtime", "status", "--json"], {
    platform: "win32",
    artifactPath: "C:\\Users\\test\\rainskills-1.4.0.tgz",
  }).executable, "npm.cmd");
  const environment = buildStableUpdateEnvironment({
    PATH: "/bin",
    RAINBOND_JWT: "header.payload.signature",
    npm_config_registry: "https://untrusted.invalid",
  }, { fromVersion: "1.3.0", targetVersion: "1.4.0", registry: MIRROR_REGISTRY });
  assert.equal(environment.RAINSKILLS_AUTO_UPDATE_HOP, "1");
  assert.equal(environment.RAINSKILLS_AUTO_UPDATE_FROM, "1.3.0");
  assert.equal(environment.RAINSKILLS_AUTO_UPDATE_TARGET, "1.4.0");
  assert.equal(environment.npm_config_registry, MIRROR_REGISTRY);
  assert.equal(environment.npm_config_ignore_scripts, "true");
  assert.equal(environment.RAINBOND_JWT, undefined);
});

test("metadata falls back to the fixed mirror only for allowlisted transport errors", async () => {
  const {
    METADATA_FALLBACK_ERROR_CODES,
    REGISTRY_SOURCES,
    fetchLatestWithFallback,
  } = require(autoUpdatePath);
  for (const code of [...METADATA_FALLBACK_ERROR_CODES, "RAINSKILLS_REQUEST_TIMEOUT"]) {
    const calls = [];
    const result = await fetchLatestWithFallback({
      fetchMetadata: async (source) => {
        calls.push(source.registry);
        if (source.registry === OFFICIAL_REGISTRY) {
          const error = new Error("transport failed");
          error.code = code;
          throw error;
        }
        return updateDescriptor("1.2.4", MIRROR_REGISTRY);
      },
    });
    assert.deepEqual(result, updateDescriptor("1.2.4", MIRROR_REGISTRY));
    assert.deepEqual(calls, [OFFICIAL_REGISTRY, MIRROR_REGISTRY]);
  }
  assert.equal(REGISTRY_SOURCES.mirror.registry, MIRROR_REGISTRY);
});

test("metadata protocol and TLS failures never fall back to the mirror", async () => {
  const { fetchLatestWithFallback } = require(autoUpdatePath);
  for (const code of ["CERT_HAS_EXPIRED", "ERR_TLS_CERT_ALTNAME_INVALID", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "RAINSKILLS_PROTOCOL_ERROR"]) {
    let mirrorRequests = 0;
    const error = new Error("fail closed");
    error.code = code;
    await assert.rejects(fetchLatestWithFallback({
      fetchMetadata: async (source) => {
        if (source.registry === MIRROR_REGISTRY) mirrorRequests += 1;
        throw error;
      },
    }), /fail closed/);
    assert.equal(mirrorRequests, 0);
  }
});

test("official metadata uses explicit TLS validation and never touches the mirror on success", async () => {
  const { REGISTRY_SOURCES, fetchLatestWithFallback } = require(autoUpdatePath);
  const metadata = {
    name: "rainskills",
    version: "1.2.4",
    dist: {
      tarball: updateDescriptor().tarball,
      integrity: updateDescriptor().integrity,
    },
  };
  const calls = [];
  const result = await fetchLatestWithFallback({ request: fakeHttpsRequest({
    [REGISTRY_SOURCES.official.latestUrl]: {
      headers: { "content-length": String(Buffer.byteLength(JSON.stringify(metadata))) },
      body: Buffer.from(JSON.stringify(metadata)),
    },
  }, calls) });
  assert.deepEqual(result, updateDescriptor());
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, REGISTRY_SOURCES.official.latestUrl);
  assert.equal(calls[0].options.rejectUnauthorized, true);
  assert.equal(typeof calls[0].options.checkServerIdentity, "function");
  assert.ok(Array.isArray(calls[0].options.ca));
});

test("mirror metadata is bound to its fixed registry URL and direct fixed CDN artifact", () => {
  const { REGISTRY_SOURCES, validateRegistryLatestMetadata } = require(autoUpdatePath);
  const version = "1.2.4";
  const result = validateRegistryLatestMetadata({
    name: "rainskills",
    version,
    dist: {
      tarball: `${MIRROR_REGISTRY}rainskills/-/rainskills-${version}.tgz`,
      integrity: updateDescriptor(version, MIRROR_REGISTRY).integrity,
    },
  }, REGISTRY_SOURCES.mirror);
  assert.deepEqual(result, updateDescriptor(version, MIRROR_REGISTRY));
  assert.equal(result.tarball, `https://cdn.npmmirror.com/packages/rainskills/${version}/rainskills-${version}.tgz`);
});

test("metadata enforces Content-Length and streaming limits without mirror fallback", async () => {
  const { REGISTRY_SOURCES, fetchLatestWithFallback } = require(autoUpdatePath);
  for (const route of [
    { headers: { "content-length": "65537" }, body: Buffer.alloc(0) },
    { chunks: [Buffer.alloc(40_000), Buffer.alloc(40_000)] },
    { statusCode: 302, headers: { location: MIRROR_REGISTRY } },
  ]) {
    const calls = [];
    await assert.rejects(fetchLatestWithFallback({ request: fakeHttpsRequest({
      [REGISTRY_SOURCES.official.latestUrl]: route,
    }, calls) }), /npm latest/);
    assert.equal(calls.length, 1);
  }
});

test("official metadata success followed by tarball failure never queries the mirror", async () => {
  const { prepareStableUpdate } = require(autoUpdatePath);
  const requests = [];
  await assert.rejects(prepareStableUpdate({
    fetchLatest: async () => updateDescriptor(),
    acquireArtifact: async (descriptor) => {
      requests.push(descriptor.registry);
      const error = new Error("official tarball timeout");
      error.code = "ETIMEDOUT";
      throw error;
    },
  }), /official tarball timeout/);
  assert.deepEqual(requests, [OFFICIAL_REGISTRY]);
});

test("a verified tarball is published as a protected local artifact and cleaned after use", async () => {
  const { acquireStableUpdateArtifact } = require(autoUpdatePath);
  const home = temporaryHome();
  const bytes = Buffer.from("verified rainskills package bytes");
  const descriptor = descriptorForBytes(bytes);
  const calls = [];
  const artifact = await acquireStableUpdateArtifact(descriptor, {
    home,
    platform: "linux",
    request: fakeHttpsRequest({
      [descriptor.tarball]: {
        headers: { "content-length": String(bytes.length) },
        chunks: [bytes.subarray(0, 10), bytes.subarray(10)],
      },
    }, calls),
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.rejectUnauthorized, true);
  assert.equal(fs.readFileSync(artifact.path, "utf8"), bytes.toString("utf8"));
  assert.equal(fs.lstatSync(path.dirname(artifact.path)).mode & 0o777, 0o700);
  assert.equal(fs.lstatSync(artifact.path).mode & 0o777, 0o600);
  assert.equal(fs.lstatSync(artifact.path).uid, process.getuid());
  assert.deepEqual(
    fs.readdirSync(path.dirname(artifact.path)).filter((name) => name.includes("candidate")),
    []
  );
  artifact.cleanup();
  assert.equal(fs.existsSync(artifact.path), false);
});

test("a protected matching artifact resumes without network and a mismatched artifact fails closed", async () => {
  const { acquireStableUpdateArtifact } = require(autoUpdatePath);
  const bytes = Buffer.from("resumable package bytes");
  const descriptor = descriptorForBytes(bytes);
  const home = temporaryHome();
  const first = await acquireStableUpdateArtifact(descriptor, {
    home,
    platform: "linux",
    request: fakeHttpsRequest({ [descriptor.tarball]: { body: bytes } }),
  });
  let requests = 0;
  const resumed = await acquireStableUpdateArtifact(descriptor, {
    home,
    platform: "linux",
    request: () => { requests += 1; throw new Error("must not request"); },
  });
  assert.equal(resumed.path, first.path);
  assert.equal(requests, 0);
  fs.writeFileSync(resumed.path, "tampered", { mode: 0o600 });
  await assert.rejects(acquireStableUpdateArtifact(descriptor, {
    home,
    platform: "linux",
    request: () => { requests += 1; throw new Error("must not request"); },
  }), /integrity/i);
  assert.equal(requests, 0);
  fs.unlinkSync(resumed.path);
});

test("tarball redirects, oversize bodies, digest mismatch, and unsafe parents fail before delegation", async () => {
  const { acquireStableUpdateArtifact } = require(autoUpdatePath);
  const bytes = Buffer.from("package bytes");
  const descriptor = descriptorForBytes(bytes);
  for (const route of [
    { statusCode: 302, headers: { location: `${OFFICIAL_REGISTRY}redirected.tgz` } },
    { headers: { "content-length": String((16 * 1024 * 1024) + 1) } },
    { body: Buffer.from("different bytes") },
  ]) {
    const home = temporaryHome();
    await assert.rejects(acquireStableUpdateArtifact(descriptor, {
      home,
      platform: "linux",
      request: fakeHttpsRequest({ [descriptor.tarball]: route }),
    }), /tarball|integrity|完整性|响应/i);
    const artifactDirectory = path.join(home, ".rainbond", "rainskills", "update-artifacts");
    if (fs.existsSync(artifactDirectory)) assert.deepEqual(fs.readdirSync(artifactDirectory), []);
  }

  const home = temporaryHome();
  const outside = temporaryHome();
  fs.mkdirSync(path.join(home, ".rainbond"), { mode: 0o700 });
  fs.symlinkSync(outside, path.join(home, ".rainbond", "rainskills"), "dir");
  await assert.rejects(acquireStableUpdateArtifact(descriptor, {
    home,
    platform: "linux",
    request: fakeHttpsRequest({ [descriptor.tarball]: { body: bytes } }),
  }), /符号链接|symbolic|reparse/i);
});

test("legacy v1 update state rewrites without persisting source details", () => {
  const { createAutoUpdateState } = require(autoUpdatePath);
  const home = temporaryHome();
  const directory = path.join(home, ".rainbond", "rainskills");
  const statePath = path.join(directory, "auto-update-v1.json");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.writeFileSync(statePath, `${JSON.stringify({
    schema: "rainskills.auto-update.v1",
    version: 1,
    checked_at: null,
    latest_version: null,
    applied_version: null,
    last_error_at: null,
    destinations: [],
  })}\n`, { mode: 0o600 });
  const state = createAutoUpdateState({ home, platform: "linux", now: () => "2026-08-24T00:00:00.000Z" });
  state.recordFailure();
  state.recordApplied("1.2.4");
  assert.deepEqual(Object.keys(state.read()).sort(), [
    "applied_version", "checked_at", "destinations", "last_error_at",
    "latest_version", "schema", "version",
  ]);
});

test("protected update state and custom install destinations survive across runs", () => {
  const {
    createAutoUpdateState,
    recordSkillInstallDestinations,
    resolveInstallDestinations,
  } = require(autoUpdatePath);
  const home = temporaryHome();
  const custom = path.join(home, "custom-agent", "skills");
  const state = createAutoUpdateState({ home, platform: "linux" });

  assert.deepEqual(resolveInstallDestinations(["codex", "--force"], home), [
    path.join(home, ".codex", "skills"),
  ]);
  assert.deepEqual(resolveInstallDestinations(["pi", "--force"], home), [
    path.join(home, ".pi", "agent", "skills"),
  ]);
  assert.deepEqual(resolveInstallDestinations(["all", "--force"], home), [
    path.join(home, ".claude", "skills"),
    path.join(home, ".codex", "skills"),
    path.join(home, ".pi", "agent", "skills"),
  ]);
  assert.deepEqual(resolveInstallDestinations(["--dest", custom, "--force"], home), [custom]);
  assert.deepEqual(resolveInstallDestinations(["--help"], home), []);
  assert.deepEqual(resolveInstallDestinations(["refresh"], home), []);
  recordSkillInstallDestinations(["--dest", custom, "--force"], { home, platform: "linux", updateState: state });
  assert.deepEqual(state.readInstallations(), { destinations: [custom] });
  assert.equal(fs.lstatSync(path.join(home, ".rainbond", "rainskills")).mode & 0o777, 0o700);
  assert.equal(fs.lstatSync(path.join(home, ".rainbond", "rainskills", "auto-update-v1.json")).mode & 0o777, 0o600);
});

test("skill synchronization updates known agent roots without touching Rainbond state", () => {
  const { synchronizeInstalledSkills } = require(autoUpdatePath);
  const home = temporaryHome();
  const packageRoot = path.join(home, "package");
  const codexRoot = path.join(home, ".codex", "skills");
  const agentsRoot = path.join(home, ".agents", "skills");
  const rainbondRoot = path.join(home, ".rainbond");
  fs.mkdirSync(packageRoot);
  fs.mkdirSync(codexRoot, { recursive: true });
  fs.mkdirSync(agentsRoot, { recursive: true });
  fs.mkdirSync(rainbondRoot, { recursive: true });
  writeSkill(packageRoot, "rainbond-one", "new one");
  writeSkill(packageRoot, "rainbond-two", "new two");
  writeSkill(codexRoot, "rainbond-one", "old one");
  writeSkill(agentsRoot, "rainbond-two", "old two");
  writeSkill(codexRoot, "unrelated-skill", "keep me");
  fs.writeFileSync(path.join(rainbondRoot, "mcp.env"), "credential sentinel\n", { mode: 0o600 });
  fs.mkdirSync(path.join(rainbondRoot, "rainskills"));
  fs.writeFileSync(
    path.join(rainbondRoot, "rainskills", "runtime-connection-v1.json"),
    "runtime sentinel\n",
    { mode: 0o600 }
  );

  const result = synchronizeInstalledSkills({ packageRoot, home, platform: "linux" });

  assert.equal(result.destinations, 2);
  assert.match(fs.readFileSync(path.join(codexRoot, "rainbond-one", "SKILL.md"), "utf8"), /new one/);
  assert.match(fs.readFileSync(path.join(codexRoot, "rainbond-two", "SKILL.md"), "utf8"), /new two/);
  assert.match(fs.readFileSync(path.join(agentsRoot, "rainbond-one", "SKILL.md"), "utf8"), /new one/);
  assert.match(fs.readFileSync(path.join(codexRoot, "unrelated-skill", "SKILL.md"), "utf8"), /keep me/);
  assert.equal(fs.readFileSync(path.join(rainbondRoot, "mcp.env"), "utf8"), "credential sentinel\n");
  assert.equal(
    fs.readFileSync(path.join(rainbondRoot, "rainskills", "runtime-connection-v1.json"), "utf8"),
    "runtime sentinel\n"
  );
});

test("an unsafe skill destination aborts before any installed skill changes", () => {
  const { synchronizeInstalledSkills } = require(autoUpdatePath);
  const home = temporaryHome();
  const packageRoot = path.join(home, "package");
  const codexRoot = path.join(home, ".codex", "skills");
  const unsafeRoot = path.join(home, ".agents", "skills");
  fs.mkdirSync(packageRoot);
  fs.mkdirSync(codexRoot, { recursive: true });
  fs.mkdirSync(path.dirname(unsafeRoot), { recursive: true });
  writeSkill(packageRoot, "rainbond-one", "new one");
  writeSkill(codexRoot, "rainbond-one", "old one");
  fs.symlinkSync(codexRoot, unsafeRoot, "dir");

  assert.throws(() => synchronizeInstalledSkills({
    packageRoot,
    home,
    platform: "linux",
    destinations: [codexRoot, unsafeRoot],
  }), /symbolic|符号链接|reparse/i);
  assert.match(fs.readFileSync(path.join(codexRoot, "rainbond-one", "SKILL.md"), "utf8"), /old one/);
});

test("the public update contract is stable-only and never re-runs Rainbond onboarding", () => {
  const readme = fs.readFileSync(path.join(repoRoot, "README.md"), "utf8");
  assert.match(readme, /只(?:跟随|检查|自动升级到).{0,20}正式版/s);
  assert.match(readme, /RC.{0,20}(?:不会|不参与|不自动升级)/s);
  assert.match(readme, /升级.{0,40}(?:不会|不触发).{0,30}(?:Rainbond|运行环境).{0,30}(?:安装|授权|对接|连接)/s);
  assert.match(readme, /原(?:始)?(?:业务)?操作.{0,20}(?:继续|恢复)/s);
});
