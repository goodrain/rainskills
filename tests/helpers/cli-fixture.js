"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { spawn } = require("node:child_process");
const { createHash } = require("node:crypto");
const root = path.resolve(__dirname, "../..");
async function cliFixture(t, handler, tools) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "rainskills-cli-e2e-"));
  const requests = [];
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", async () => {
      const message = JSON.parse(body); requests.push(message);
      const result = message.method === "tools/list" ? { tools } : await handler(message.params, res);
      if (res.destroyed || res.writableEnded || result === undefined) return;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    });
  });
  server.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise((resolve) => server.close(resolve)); fs.rmSync(home, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  require("../../rainbond-platform-installer/scripts/single-runtime.js").createSingleRuntimeStore({ home }).write({ kind: "private", consoleOrigin: origin, token: "test-jwt.payload.signature", allowInsecureHttp: true });
  const skills = ["rainbond-app-assistant", "rainbond-fullstack-bootstrap"].map((id) => {
    const content = `---\nname: ${id}\n---\n# Test skill\n`;
    return { id, profile: "cli", package_version: "test", source_revision: null, content, content_sha256: createHash("sha256").update(content).digest("hex"), bundle_sha256: "a".repeat(64) };
  });
  const manifest = path.join(home, ".rainbond/bin/rainskills-skill-manifest.json");
  fs.mkdirSync(path.dirname(manifest), { recursive: true, mode: 0o700 });
  fs.writeFileSync(manifest, JSON.stringify({ schema: "rainskills.skill-manifest.v1", profile: "cli", package_version: "test", skills }), { mode: 0o600 });
  const run = (args, input, bridge = path.join(root, "bin/rainskills-tools.js")) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bridge, ...args, "--skill-id", "rainbond-fullstack-bootstrap"], {
      env: { ...process.env, HOME: home, RAINSKILLS_TELEMETRY_DISABLED: "1", RAINSKILLS_PACKAGE_VERSION: "test" }, stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", (s) => { stdout += s; }); child.stderr.on("data", (s) => { stderr += s; });
    child.on("error", reject); child.on("close", (code) => resolve({ code, stdout, stderr, value: stdout.trim() ? JSON.parse(stdout) : null }));
    child.stdin.end(JSON.stringify(input));
  });
  return { home, origin, requests, run };
}
module.exports = { cliFixture };
