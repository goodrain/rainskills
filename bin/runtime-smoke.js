#!/usr/bin/env node
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { spawn } = require("node:child_process");
const { checkRuntimeIntegrity } = require("./runtime-integrity.js");

async function smokeInstalledRuntime(home) {
  if (checkRuntimeIntegrity().status !== "ok") throw new Error("installed runtime integrity failed");
  const probeHome = fs.mkdtempSync(path.join(os.tmpdir(), "rainskills-smoke-"));
  const sockets = new Set();
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const message = JSON.parse(body);
      const result = message.method === "tools/list"
        ? { tools: [{ name: "rainbond_get_smoke_status", inputSchema: { type: "object" } }] }
        : { structuredContent: { status: "Running" } };
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    });
  });
  server.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    require("../rainbond-platform-installer/scripts/single-runtime.js").createSingleRuntimeStore({ home: probeHome }).write({ kind: "private", consoleOrigin: `http://127.0.0.1:${server.address().port}`, token: "smoke.payload.signature", allowInsecureHttp: true });
    const bridge = path.join(home, ".rainbond/bin/rainskills-tools.js");
    const run = (args, input) => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [bridge, ...args, "--input", "-", "--skill-id", "rainbond-app-assistant"], {
        cwd: probeHome, env: { ...process.env, HOME: probeHome, USERPROFILE: probeHome, RAINSKILLS_TELEMETRY_DISABLED: "1", RAINSKILLS_CREDENTIAL_SOURCE: "", RAINBOND_URL: "", RAINBOND_JWT: "" }, stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.resume();
      child.on("error", (error) => { clearTimeout(timer); reject(error); });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code !== 0) return reject(new Error(`installed ${args[0]} smoke failed`));
        try { resolve(JSON.parse(stdout)); } catch { reject(new Error("invalid installed smoke output")); }
      });
      child.stdin.end(JSON.stringify(input));
    });
    const context = await run(["handoff", "create"], { producer: "rainbond-app-assistant", profile: "cli", observed_at: new Date().toISOString(), enterprise_id: "smoke", team_id: "smoke", team_name: "smoke", region_name: "smoke", app_id: null, app_name: "smoke", endpoint: "https://example.invalid", runtime_revision: "smoke", snapshot_revision: null, source_kind: "image", runtime_state: "topology_missing", next_phase: "init", invalidation_reason: null });
    const snapshot = await run(["snapshot", "app"], { scope: "app", requests: [{ name: "rainbond_get_smoke_status", arguments: {} }] });
    const poll = await run(["poll", "rainbond_get_smoke_status"], { arguments: {}, status_path: "status", terminal_values: ["Running", "Failed"], failure_values: ["Failed"], max_attempts: 1, interval_ms: 0, timeout_ms: 1000 });
    if (context.schema !== "rainskills.handoff-context.v1" || snapshot.evidence?.[0]?.available !== true || poll.completed !== true) throw new Error("installed runtime smoke contract failed");
    return { status: "ok", checked: ["handoff", "snapshot", "poll"] };
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(probeHome, { recursive: true, force: true });
  }
}
module.exports = { smokeInstalledRuntime };
if (require.main === module) {
  const home = process.argv[2];
  if (!home) { process.stderr.write("installed home is required\n"); process.exitCode = 2; }
  else smokeInstalledRuntime(path.resolve(home)).then((result) => process.stdout.write(`${JSON.stringify(result)}\n`)).catch(() => { process.stderr.write("installed runtime smoke failed\n"); process.exitCode = 1; });
}
