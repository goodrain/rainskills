"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createPortableSecureStateStore } = require("./helpers/portable-secure-state.js");
const { createEnvironmentRegistry } = require(
  "../rainbond-platform-installer/scripts/environment-registry.js"
);

const credentialsPath = path.resolve(
  __dirname,
  "..",
  "rainbond-platform-installer",
  "scripts",
  "environment-credentials.js"
);

const PROD_ID = "11111111-1111-4111-8111-111111111111";
const TEST_ID = "22222222-2222-4222-8222-222222222222";
const PROD_TOKEN = "prod.payload.signature";
const TEST_TOKEN = "test.payload.signature";

function createFixture({ platform = process.platform } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "rainskills-environment-credentials-"));
  const stateStore = createPortableSecureStateStore(home);
  const { createEnvironmentCredentialStore } = require(credentialsPath);
  return {
    home,
    stateStore,
    store: createEnvironmentCredentialStore({ home, platform, stateStore }),
  };
}

test("credentials are isolated by immutable environment id and exact origin", () => {
  const { store } = createFixture();
  store.write({
    environmentId: PROD_ID,
    origin: "https://prod.example.com/",
    token: PROD_TOKEN,
  });
  store.write({
    environmentId: TEST_ID,
    origin: "https://test.example.com",
    token: TEST_TOKEN,
  });

  assert.deepEqual(store.read({
    environmentId: PROD_ID,
    expectedOrigin: "https://prod.example.com",
  }), { origin: "https://prod.example.com", token: PROD_TOKEN });
  assert.deepEqual(store.read({
    environmentId: TEST_ID,
    expectedOrigin: "https://test.example.com",
  }), { origin: "https://test.example.com", token: TEST_TOKEN });
  assert.throws(() => store.read({
    environmentId: PROD_ID,
    expectedOrigin: "https://test.example.com",
  }), /origin 不匹配/);
});

test("rotating one credential does not alter another environment bytes", () => {
  const { store } = createFixture();
  store.write({ environmentId: PROD_ID, origin: "https://prod.example.com", token: PROD_TOKEN });
  store.write({ environmentId: TEST_ID, origin: "https://test.example.com", token: TEST_TOKEN });
  const otherBefore = fs.readFileSync(store.pathFor(TEST_ID));

  store.write({
    environmentId: PROD_ID,
    origin: "https://prod.example.com",
    token: "renewed.payload.signature",
  });

  assert.deepEqual(fs.readFileSync(store.pathFor(TEST_ID)), otherBefore);
  assert.equal(
    store.read({ environmentId: PROD_ID, expectedOrigin: "https://prod.example.com" }).token,
    "renewed.payload.signature"
  );
});

test("POSIX credential directory and files use exact protected modes", {
  skip: process.platform === "win32",
}, () => {
  const { store } = createFixture({ platform: "linux" });
  store.write({ environmentId: PROD_ID, origin: "https://prod.example.com", token: PROD_TOKEN });

  assert.equal(fs.statSync(store.directory).mode & 0o777, 0o700);
  assert.equal(fs.statSync(store.pathFor(PROD_ID)).mode & 0o777, 0o600);
});

test("credential store rejects unsafe ids, symlinks, and credential reflection", {
  skip: process.platform === "win32",
}, () => {
  const { home, store } = createFixture({ platform: "linux" });
  assert.throws(
    () => store.write({ environmentId: "../escape", origin: "https://prod.example.com", token: PROD_TOKEN }),
    /环境 ID 无效/
  );
  fs.mkdirSync(store.directory, { recursive: true, mode: 0o700 });
  const outside = path.join(home, "outside.json");
  fs.writeFileSync(outside, "{}\n", { mode: 0o600 });
  fs.symlinkSync(outside, store.pathFor(PROD_ID));

  let message = "";
  try {
    store.write({ environmentId: PROD_ID, origin: "https://prod.example.com", token: PROD_TOKEN });
  } catch (error) {
    message = error.message;
  }
  assert.match(message, /符号链接/);
  assert.doesNotMatch(message, new RegExp(PROD_TOKEN.replaceAll(".", "\\.")));
  assert.equal(fs.readFileSync(outside, "utf8"), "{}\n");
});

test("Windows-compatible secure store protects each credential without user environment variables", () => {
  const { store } = createFixture({ platform: "win32" });
  store.write({ environmentId: PROD_ID, origin: "https://prod.example.com", token: PROD_TOKEN });

  assert.equal(
    store.read({ environmentId: PROD_ID, expectedOrigin: "https://prod.example.com" }).token,
    PROD_TOKEN
  );
  assert.equal(process.env.RAINSKILLS_RAINBOND_JWT, undefined);
});

test("legacy mcp.env migrates once into the registry and leaves the source untouched", () => {
  const { home, stateStore, store } = createFixture();
  const legacyDirectory = path.join(home, ".rainbond");
  fs.mkdirSync(legacyDirectory, { recursive: true, mode: 0o700 });
  const legacyPath = path.join(legacyDirectory, "mcp.env");
  const legacyBytes = [
    `export RAINBOND_JWT='${PROD_TOKEN}'`,
    "export RAINBOND_URL='https://prod.example.com'",
    "",
  ].join("\n");
  fs.writeFileSync(legacyPath, legacyBytes, { mode: 0o600 });
  const registry = createEnvironmentRegistry({
    home,
    stateStore,
    randomUUID: () => PROD_ID,
    now: () => "2026-08-17T00:00:00.000Z",
  });
  const { migrateLegacyCredential } = require(credentialsPath);

  const first = migrateLegacyCredential({
    home,
    platform: process.platform,
    stateStore,
    registry,
    credentialStore: store,
  });
  const second = migrateLegacyCredential({
    home,
    platform: process.platform,
    stateStore,
    registry,
    credentialStore: store,
  });

  assert.equal(first.migrated, true);
  assert.equal(second.migrated, false);
  assert.equal(second.environment.id, first.environment.id);
  assert.equal(registry.read().default_environment_id, first.environment.id);
  assert.equal(registry.list().length, 1);
  assert.equal(
    store.read({
      environmentId: first.environment.id,
      expectedOrigin: "https://prod.example.com",
    }).token,
    PROD_TOKEN
  );
  assert.equal(fs.readFileSync(legacyPath, "utf8"), legacyBytes);
});

test("a newly connected origin registers once and later authorization rotates only that environment", () => {
  const { home, stateStore, store } = createFixture();
  const registry = createEnvironmentRegistry({
    home,
    stateStore,
    randomUUID: () => PROD_ID,
    now: () => "2026-08-17T00:00:00.000Z",
  });
  const { registerConnectedEnvironment } = require(credentialsPath);

  const first = registerConnectedEnvironment({
    registry,
    credentialStore: store,
    origin: "https://prod.example.com",
    token: PROD_TOKEN,
    kind: "private",
  });
  const second = registerConnectedEnvironment({
    registry,
    credentialStore: store,
    origin: "https://prod.example.com/",
    token: "renewed.payload.signature",
    kind: "private",
  });

  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(second.environment.id, first.environment.id);
  assert.equal(registry.list().length, 1);
  assert.equal(
    store.read({
      environmentId: first.environment.id,
      expectedOrigin: "https://prod.example.com",
    }).token,
    "renewed.payload.signature"
  );
});

test("credential persistence failure never leaves a newly registered environment connected", () => {
  const { home, stateStore } = createFixture();
  const registry = createEnvironmentRegistry({
    home,
    stateStore,
    randomUUID: () => PROD_ID,
    now: () => "2026-08-17T00:00:00.000Z",
  });
  const { registerConnectedEnvironment } = require(credentialsPath);

  assert.throws(() => registerConnectedEnvironment({
    registry,
    credentialStore: { write() { throw new Error("fixture persistence failed"); } },
    origin: "https://prod.example.com",
    token: PROD_TOKEN,
    kind: "private",
  }), /persistence failed/);
  assert.equal(registry.list()[0].connection_state, "needs-reconnect");
});
