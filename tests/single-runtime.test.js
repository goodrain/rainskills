"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createPortableSecureStateStore } = require("./helpers/portable-secure-state.js");

const modulePath = path.resolve(
  __dirname,
  "..",
  "rainbond-platform-installer",
  "scripts",
  "single-runtime.js"
);

const TOKEN = "header.payload.signature";

function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "rainskills-single-runtime-"));
  const stateStore = createPortableSecureStateStore(home);
  const { createSingleRuntimeStore } = require(modulePath);
  return {
    home,
    store: createSingleRuntimeStore({
      home,
      stateStore,
      now: () => "2026-08-26T00:00:00.000Z",
    }),
  };
}

test("single runtime stores exactly one protected Console credential", () => {
  const { store } = fixture();

  const written = store.write({
    consoleOrigin: "https://rainbond.example.com/",
    kind: "private",
    token: TOKEN,
    allowInsecureHttp: false,
  });

  assert.deepEqual(written, {
    schema: "rainskills.single-runtime.v1",
    version: 1,
    console_origin: "https://rainbond.example.com",
    kind: "private",
    token: TOKEN,
    allow_insecure_http: false,
    created_at: "2026-08-26T00:00:00.000Z",
    updated_at: "2026-08-26T00:00:00.000Z",
  });
  assert.deepEqual(store.read(), written);
  assert.equal(fs.statSync(path.dirname(store.path)).mode & 0o777, 0o700);
  assert.equal(fs.statSync(store.path).mode & 0o777, 0o600);
});

test("single runtime replacement preserves creation time and replaces the only origin", () => {
  const { store } = fixture();
  store.write({
    consoleOrigin: "https://old.example.com",
    kind: "private",
    token: TOKEN,
  });

  const replaced = store.write({
    consoleOrigin: "https://run.rainbond.com",
    kind: "saas",
    token: "renewed.payload.signature",
  });

  assert.equal(replaced.console_origin, "https://run.rainbond.com");
  assert.equal(replaced.kind, "saas");
  assert.equal(replaced.created_at, "2026-08-26T00:00:00.000Z");
  assert.equal(store.read().token, "renewed.payload.signature");
});

test("single runtime fails closed for invalid records and symlinks", {
  skip: process.platform === "win32",
}, () => {
  const { home, store } = fixture();
  assert.throws(() => store.write({
    consoleOrigin: "https://rainbond.example.com/path",
    kind: "private",
    token: TOKEN,
  }), /origin|地址/i);

  fs.mkdirSync(path.dirname(store.path), { recursive: true, mode: 0o700 });
  const outside = path.join(home, "outside.json");
  fs.writeFileSync(outside, "{}\n", { mode: 0o600 });
  fs.symlinkSync(outside, store.path);
  assert.throws(() => store.write({
    consoleOrigin: "https://rainbond.example.com",
    kind: "private",
    token: TOKEN,
  }), /符号链接|symlink/i);
});

test("single runtime remove is idempotent", () => {
  const { store } = fixture();
  assert.equal(store.remove(), false);
  store.write({
    consoleOrigin: "https://rainbond.example.com",
    kind: "private",
    token: TOKEN,
  });
  assert.equal(store.remove(), true);
  assert.equal(store.remove(), false);
  assert.equal(store.read(), null);
});
