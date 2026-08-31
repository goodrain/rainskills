"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const modulePath = path.resolve(
  __dirname,
  "..",
  "rainbond-platform-installer",
  "scripts",
  "console-origin.js"
);

test("Console input accepts only a normalized HTTP or HTTPS origin", () => {
  const { normalizeConsoleOrigin } = require(modulePath);

  assert.equal(normalizeConsoleOrigin("https://rainbond.example.com:7443"), "https://rainbond.example.com:7443");
  assert.equal(normalizeConsoleOrigin("http://127.0.0.1:7070/"), "http://127.0.0.1:7070");
  for (const unsafe of [
    "https://user:password@rainbond.example.com",
    "https://rainbond.example.com/console",
    "https://rainbond.example.com/?token=secret",
    "https://rainbond.example.com/#/login",
    "ftp://rainbond.example.com",
    " https://rainbond.example.com",
  ]) {
    assert.throws(() => normalizeConsoleOrigin(unsafe), /origin|地址/i);
  }
});

test("Console probe follows only bounded same-origin redirects", async () => {
  const { inspectConsoleOrigin } = require(modulePath);
  const calls = [];
  const responses = [
    new Response(null, { status: 302, headers: { location: "/console/" } }),
    new Response(null, { status: 200 }),
  ];

  const result = await inspectConsoleOrigin("https://rainbond.example.com", {
    async fetchImpl(url, options) {
      calls.push({ url, options });
      return responses.shift();
    },
  });

  assert.deepEqual(result, {
    origin: "https://rainbond.example.com",
    httpConfirmationRequired: false,
    pendingRedirectOrigin: null,
  });
  assert.deepEqual(calls.map((call) => call.url), [
    "https://rainbond.example.com/",
    "https://rainbond.example.com/console/",
  ]);
  assert.equal(calls.every((call) => call.options.redirect === "manual"), true);
});

test("Console probe never follows a cross-origin redirect and returns only its safe origin", async () => {
  const { inspectConsoleOrigin } = require(modulePath);
  const calls = [];

  const result = await inspectConsoleOrigin("https://old.example.com", {
    async fetchImpl(url, options) {
      calls.push({ url, options });
      return new Response(null, {
        status: 302,
        headers: { location: "https://new.example.com/console/?signed=secret#fragment" },
      });
    },
  });

  assert.deepEqual(result, {
    origin: "https://old.example.com",
    httpConfirmationRequired: false,
    pendingRedirectOrigin: "https://new.example.com",
  });
  assert.equal(calls.length, 1);
  assert.equal(JSON.stringify(result).includes("secret"), false);
});

test("Console probe rejects a fetch implementation that silently followed elsewhere", async () => {
  const { inspectConsoleOrigin } = require(modulePath);
  const response = new Response(null, { status: 200 });
  Object.defineProperty(response, "url", {
    configurable: true,
    value: "https://attacker.example/",
  });

  await assert.rejects(
    inspectConsoleOrigin("https://rainbond.example.com", {
      fetchImpl: async () => response,
    }),
    /重定向|响应地址|安全/i
  );
});

test("Console probe blocks invalid TLS without reflecting the submitted URL", async () => {
  const { inspectConsoleOrigin } = require(modulePath);
  const submitted = "https://private.example.com";

  await assert.rejects(
    inspectConsoleOrigin(submitted, {
      async fetchImpl() {
        const error = new Error(`certificate failure while requesting ${submitted}/?token=secret`);
        error.code = "CERT_HAS_EXPIRED";
        throw error;
      },
    }),
    (error) => /HTTPS|TLS|证书|安全/.test(error.message)
      && !error.message.includes("private.example.com")
      && !error.message.includes("secret")
  );
});

test("HTTP policy treats hostnames as public and requires confirmation outside loopback", () => {
  const { classifyHttpOrigin } = require(modulePath);

  assert.deepEqual(classifyHttpOrigin("http://127.0.0.1:7070"), {
    isHttp: true,
    isLoopback: true,
    isManagedPrivate: false,
    confirmationRequired: false,
  });
  assert.deepEqual(classifyHttpOrigin("http://10.0.0.8:7070"), {
    isHttp: true,
    isLoopback: false,
    isManagedPrivate: true,
    confirmationRequired: false,
  });
  assert.deepEqual(classifyHttpOrigin("http://[fd12:3456::8]:7070"), {
    isHttp: true,
    isLoopback: false,
    isManagedPrivate: true,
    confirmationRequired: false,
  });
  assert.deepEqual(classifyHttpOrigin("http://rainbond.internal:7070"), {
    isHttp: true,
    isLoopback: false,
    isManagedPrivate: false,
    confirmationRequired: true,
  });
});
