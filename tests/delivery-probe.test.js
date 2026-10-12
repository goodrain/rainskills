"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const YAML = require("yaml");

const { parseCommand } = require("../bin/rainskills-tools.js");
const {
  createDeliveryProbe,
  defaultRequestUrl,
  isPublicAddress,
  POLICY_VERSION,
} = require("../bin/delivery-probe.js");

const root = path.resolve(__dirname, "..");

test("delivery probe command has one fixed skill-bound contract", () => {
  assert.deepEqual(parseCommand([
    "delivery", "probe", "--input", "-",
    "--skill-id", "rainbond-delivery-verifier",
  ]), {
    command: "delivery",
    action: "probe",
    input: "-",
    skillId: "rainbond-delivery-verifier",
  });
  assert.throws(() => parseCommand([
    "delivery", "probe", "--input", "-",
    "--skill-id", "rainbond-app-assistant",
  ]), /delivery probe requires rainbond-delivery-verifier/i);
});

test("delivery probe blocks non-public IPv4 and IPv6 ranges", () => {
  for (const address of [
    "0.0.0.0", "10.0.0.1", "100.64.0.1", "127.0.0.1", "169.254.1.1",
    "172.16.0.1", "192.168.1.1", "192.0.2.1", "198.18.0.1", "198.51.100.1",
    "203.0.113.1", "224.0.0.1", "240.0.0.1", "::", "::1", "fc00::1",
    "fe80::1", "ff02::1", "2001:db8::1", "::ffff:127.0.0.1", "::ffff:7f00:1",
    "64:ff9b::7f00:1", "2002:7f00:1::", "2001::1", "100::1",
  ]) {
    assert.equal(isPublicAddress(address), false, address);
  }
  assert.equal(isPublicAddress("8.8.8.8"), true);
  assert.equal(isPublicAddress("2606:4700:4700::1111"), true);
});

test("delivery probe policy schema matches the executable safety limits", () => {
  const schema = YAML.parse(fs.readFileSync(
    path.join(root, "rainbond-delivery-verifier/schemas/delivery-probe-policy.schema.yaml"),
    "utf8",
  ));
  assert.equal(schema.properties.policy_version.const, POLICY_VERSION);
  assert.equal(schema.properties.max_redirects.const, 3);
  assert.equal(schema.properties.connect_timeout_ms.const, 5000);
  assert.equal(schema.properties.total_timeout_ms.const, 15000);
  assert.equal(schema.properties.max_body_bytes.const, 262144);
  assert.equal(schema.properties.credentials.const, "none");
});

test("delivery probe rejects unsafe URLs and DNS results without a request", async () => {
  let requests = 0;
  const probe = createDeliveryProbe({
    resolveHost: async () => ["127.0.0.1"],
    requestUrl: async () => { requests += 1; return { statusCode: 200 }; },
  });
  for (const input of [
    { policy_version: POLICY_VERSION, url: "file:///etc/passwd", method: "GET" },
    { policy_version: POLICY_VERSION, url: "https://user:pass@example.com/", method: "GET" },
    { policy_version: POLICY_VERSION, url: "https://example.com/", method: "POST" },
    { policy_version: POLICY_VERSION, url: "https://example.com/", method: "GET" },
  ]) {
    const result = await probe(input);
    assert.equal(result.status, "rejected");
  }
  assert.equal(requests, 0);

  const mixedProbe = createDeliveryProbe({
    resolveHost: async () => ["8.8.8.8", "127.0.0.1"],
    requestUrl: async () => { requests += 1; return { statusCode: 200 }; },
  });
  const mixed = await mixedProbe({
    policy_version: POLICY_VERSION,
    url: "https://example.com/",
    method: "GET",
  });
  assert.equal(mixed.status, "rejected");
  assert.equal(requests, 0);
});

test("same-host redirects are bounded and re-resolved without credentials", async () => {
  const resolutions = [];
  const requests = [];
  const queue = [
    { statusCode: 302, location: "/ready" },
    { statusCode: 200, contentType: "text/html", bodyBytes: 32 },
  ];
  const probe = createDeliveryProbe({
    resolveHost: async (hostname) => { resolutions.push(hostname); return ["8.8.8.8"]; },
    requestUrl: async (url, options) => {
      requests.push({ url: url.href, options });
      return queue.shift();
    },
  });
  const result = await probe({ policy_version: POLICY_VERSION, url: "http://example.com/", method: "GET" });
  assert.equal(result.status, "verified");
  assert.deepEqual(resolutions, ["example.com", "example.com"]);
  assert.equal(requests.length, 2);
  for (const request of requests) {
    const names = Object.keys(request.options.headers || {}).map((name) => name.toLowerCase());
    assert.equal(names.includes("authorization"), false);
    assert.equal(names.includes("cookie"), false);
  }
});

test("cross-host redirects stop for manual validation and unsafe targets are rejected", async () => {
  let requests = 0;
  const probe = createDeliveryProbe({
    resolveHost: async () => ["8.8.8.8"],
    requestUrl: async () => {
      requests += 1;
      return { statusCode: 302, location: "https://other.example/path" };
    },
  });
  const crossHost = await probe({ policy_version: POLICY_VERSION, url: "https://example.com/", method: "HEAD" });
  assert.equal(crossHost.status, "manual_validation_required");
  assert.equal(crossHost.redirect_target, "https://other.example/path");
  assert.equal(requests, 1);

  const unsafeProbe = createDeliveryProbe({
    resolveHost: async () => ["8.8.8.8"],
    requestUrl: async () => ({ statusCode: 302, location: "http://127.0.0.1/admin" }),
  });
  const unsafe = await unsafeProbe({ policy_version: POLICY_VERSION, url: "https://example.com/", method: "GET" });
  assert.equal(unsafe.status, "rejected");
});

test("timeouts and oversized bodies fail without being treated as verified", async () => {
  for (const error of ["timeout", "body_too_large"]) {
    const probe = createDeliveryProbe({
      resolveHost: async () => ["8.8.8.8"],
      requestUrl: async () => ({ error }),
    });
    const result = await probe({ policy_version: POLICY_VERSION, url: "https://example.com/", method: "GET" });
    assert.deepEqual(result, {
      policy_version: POLICY_VERSION,
      status: "failed",
      reason: error,
      candidate_url: "https://example.com/",
    });
  }
});

test("real probe transport enforces total timeout and response limits", async (t) => {
  const server = http.createServer((request, response) => {
    if (request.url === "/declared-large") {
      response.writeHead(200, { "Content-Length": "64" });
      response.end("x");
      return;
    }
    if (request.url === "/chunked-large") {
      response.writeHead(200);
      response.end("x".repeat(64));
      return;
    }
    // Leave /slow open so the independent wall-clock timer aborts it.
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const { port } = server.address();
  const options = {
    method: "GET",
    address: "127.0.0.1",
    headers: {},
    connectTimeoutMs: 100,
    totalTimeoutMs: 50,
    maxBodyBytes: 32,
  };
  const declared = await defaultRequestUrl(new URL(`http://localhost:${port}/declared-large`), options);
  assert.equal(declared.error, "body_too_large");
  const chunked = await defaultRequestUrl(new URL(`http://localhost:${port}/chunked-large`), options);
  assert.equal(chunked.error, "body_too_large");
  const slow = await defaultRequestUrl(new URL(`http://localhost:${port}/slow`), options);
  assert.equal(slow.error, "timeout");
});

test("redirect safety rejects DNS rebinding, port changes, missing locations, and malformed targets", async () => {
  const makeProbe = (location) => createDeliveryProbe({
    resolveHost: async (hostname) => hostname === "private.example" ? ["127.0.0.1"] : ["8.8.8.8"],
    requestUrl: async () => ({ statusCode: 302, location }),
  });
  const input = { policy_version: POLICY_VERSION, url: "https://example.com/", method: "GET" };

  assert.equal((await makeProbe("https://private.example/")(input)).status, "rejected");
  assert.equal((await makeProbe("https://example.com:2375/")(input)).status, "manual_validation_required");
  assert.equal((await makeProbe("http://example.com/")(input)).reason, "redirect_downgrade");
  assert.equal((await makeProbe(undefined)(input)).reason, "redirect_without_location");
  assert.equal((await makeProbe("http://[")(input)).status, "rejected");

  let redirectRequests = 0;
  const looping = createDeliveryProbe({
    resolveHost: async () => ["8.8.8.8"],
    requestUrl: async () => {
      redirectRequests += 1;
      return { statusCode: 302, location: `/loop-${redirectRequests}` };
    },
  });
  const loopResult = await looping(input);
  assert.equal(loopResult.reason, "too_many_redirects");
  assert.equal(redirectRequests, 4);
});

test("delivered fixture covers all mandatory acceptance checks", () => {
  const expected = fs.readFileSync(
    path.join(root, "rainbond-delivery-verifier/evals/01-delivered-verified.expected.yaml"),
    "utf8",
  );
  const response = fs.readFileSync(
    path.join(root, "rainbond-delivery-verifier/evals/01-delivered-verified.response.md"),
    "utf8",
  );
  for (const phrase of [
    "critical components",
    "same-host /api",
    "persistence verified",
    "static asset",
    "deep-link",
    "MIME",
  ]) {
    const pattern = new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    assert.match(expected, pattern);
    assert.match(response, pattern);
  }
});

test("delivered fixture validator rejects non-verified probe evidence", () => {
  const evalDir = fs.mkdtempSync(path.join(os.tmpdir(), "rainskills-delivery-evidence-"));
  const expected = fs.readFileSync(
    path.join(root, "rainbond-delivery-verifier/evals/01-delivered-verified.expected.yaml"),
    "utf8",
  );
  const response = fs.readFileSync(
    path.join(root, "rainbond-delivery-verifier/evals/01-delivered-verified.response.md"),
    "utf8",
  );
  const invalid = response.replace("    status: verified\n    checks:", "    status: failed\n    checks:");
  fs.writeFileSync(path.join(evalDir, "delivered.expected.yaml"), expected);
  fs.writeFileSync(path.join(evalDir, "delivered.response.md"), invalid);
  const result = spawnSync("python3", [
    path.join(root, "rainbond-delivery-verifier/scripts/run_delivery_verifier_evals.py"),
    "--eval-dir", evalDir,
    "--schema", path.join(root, "rainbond-delivery-verifier/schemas/delivery-verification-result.schema.yaml"),
  ], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /verified bounded probe_evidence|probe_evidence\.status/);
});
