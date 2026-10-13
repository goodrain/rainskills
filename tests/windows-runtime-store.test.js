"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const repoRoot = path.resolve(__dirname, "..");
const probe = path.join(__dirname, "helpers", "windows-runtime-probe.js");

for (const installed of [false, true]) {
  for (const scenario of ["existing", "connect"]) {
    test(`Windows default runtime store: ${installed ? "installed CLI" : "source"} ${scenario}`, (t) => {
      const probeHome = fs.mkdtempSync(path.join(os.tmpdir(), "rainskills-win-runtime-"));
      t.after(() => fs.rmSync(probeHome, { recursive: true, force: true }));
      let packageRoot = repoRoot;
      let bridgePath = path.join(repoRoot, "bin", "rainskills-tools.js");
      if (installed) {
        const install = spawnSync(process.execPath, [
          path.join(repoRoot, "scripts", "install-local-cli.mjs"),
          "--source-root", repoRoot, "--home", probeHome,
        ], { encoding: "utf8", timeout: 30000 });
        assert.equal(install.status, 0, install.error?.message || install.stderr);
        packageRoot = path.join(probeHome, ".rainbond", "lib", "rainskills");
        bridgePath = path.join(probeHome, ".rainbond", "bin", "rainskills-tools.js");
      }
      // On Windows this invokes real whoami/PowerShell/ACLs inside the temporary home.
      // Other hosts simulate only OS responses, keeping the production JS chain intact.
      const result = spawnSync(process.execPath, [
        probe, packageRoot, probeHome, scenario, bridgePath,
      ], {
        encoding: "utf8",
        timeout: 180000,
        env: { ...process.env, RAINSKILLS_TELEMETRY_DISABLED: "1" },
      });
      assert.equal(result.status, 0, result.error?.message || result.stderr || result.stdout);
    });
  }
}
