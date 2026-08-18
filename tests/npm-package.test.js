const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const repoRoot = path.resolve(__dirname, "..");
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const npxCommand = process.platform === "win32" ? "npx.cmd" : "npx";
const uploadHelper =
  "rainbond-fullstack-bootstrap/scripts/upload_local_package.py";
const skillNames = [
  "rainbond-app-assistant",
  "rainbond-app-version-assistant",
  "rainbond-delivery-verifier",
  "rainbond-env-sync",
  "rainbond-fullstack-bootstrap",
  "rainbond-fullstack-troubleshooter",
  "rainbond-platform-installer",
  "rainbond-platform-query",
  "rainbond-project-init",
  "rainbond-template-installer",
];

function packPackage(destination) {
  const result = spawnSync(
    npmCommand,
    ["pack", "--json", "--pack-destination", destination],
    {
      cwd: repoRoot,
      encoding: "utf8",
      env: { ...process.env, npm_config_cache: path.join(destination, "npm-cache") },
    }
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const [packed] = JSON.parse(result.stdout);
  return {
    ...packed,
    tarballPath: path.join(destination, packed.filename),
  };
}

test("package metadata defines a public, runtime-dependency-free npx command", () => {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")
  );

  assert.equal(manifest.name, "rainskills");
  assert.equal(manifest.bin.rainskills, "bin/rainskills.js");
  assert.equal(manifest.engines.node, ">=18");
  assert.equal(manifest.license, "Apache-2.0");
  assert.equal(
    manifest.repository.url,
    "git+https://github.com/goodrain/rainskills.git"
  );
  assert.equal(manifest.publishConfig.registry, "https://registry.npmjs.org/");
  assert.equal(manifest.publishConfig.access, "public");
  assert.deepEqual(manifest.os, ["darwin", "linux", "win32"]);
  assert.equal(manifest.dependencies, undefined);
  assert.equal(manifest.devDependencies.esbuild, "0.25.8");
  assert.deepEqual(manifest.pi, { skills: ["./marketplace/rainskills/skills"] });
  assert.equal(manifest.scripts.postinstall, undefined);
  assert.equal(
    manifest.scripts["test:package-upload"],
    "python3 tests/package_upload_helper_test.py && python3 tests/package_upload_workflow_contract_test.py && python3 rainbond-fullstack-bootstrap/scripts/run_bootstrap_evals.py"
  );
  assert.equal(
    manifest.scripts.test,
    "npm run test:launcher && npm run test:api-bridge && npm run test:mcp-priority && npm run test:routing && npm run test:skill-profile && npm run test:marketplace && npm run test:platform && npm run test:windows && npm run test:package-upload && npm run test:package && npm run test:installer && npm run test:signal && npm run test:npx-pty"
  );
  assert.equal(
    manifest.scripts["test:mcp-priority"],
    "node --test tests/mcp-priority-cleanup.test.js tests/transport-resolution.test.js tests/skill-console-contract.test.js"
  );
  assert.equal(
    manifest.scripts["test:routing"],
    "python3 tests/run_skill_routing_evals.py"
  );
  assert.equal(
    manifest.scripts["test:platform"],
    "node --test tests/platform-installer.test.js"
  );
  assert.equal(
    manifest.scripts["test:windows"],
    "node --test tests/windows-onboarding.test.js tests/windows-platform.test.js"
  );
});

test("packed artifact contains the installer and all skills but no development files", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rainskills-pack-"));
  const packed = packPackage(tempDir);
  const filePaths = new Set(packed.files.map((entry) => entry.path));

  assert(filePaths.has("package.json"));
  assert(filePaths.has("SKILL.md"));
  assert(filePaths.has("agents/openai.yaml"));
  assert(filePaths.has("bin/rainskills.js"));
  assert(filePaths.has("bin/rainskills-tools.js"));
  assert(filePaths.has("install.sh"));
  assert(!filePaths.has("pi/rainskills-mcp.ts"));
  assert(filePaths.has("rainbond-platform-installer/scripts/platform-installer.js"));
  assert(filePaths.has("rainbond-platform-installer/agents/openai.yaml"));
  assert(filePaths.has("rainbond-platform-installer/references/installation-policy.json"));
  assert(filePaths.has("rainbond-platform-installer/references/installation-policy.md"));
  for (const runtimeFile of [
    "browser-callback.py",
    "windows-onboarding.js",
    "windows-auth.js",
    "windows-browser.ps1",
    "windows-platform.js",
    "windows-platform.ps1",
    "wsl-bootstrap.sh",
  ]) {
    assert(filePaths.has(`rainbond-platform-installer/scripts/${runtimeFile}`), `${runtimeFile} is missing`);
  }
  assert(filePaths.has("README.md"));
  assert(filePaths.has("LICENSE"));
  for (const skillName of skillNames) {
    assert(filePaths.has(`${skillName}/SKILL.md`), `${skillName} is missing`);
  }
  assert(filePaths.has(uploadHelper), `${uploadHelper} is missing`);

  for (const filePath of filePaths) {
    assert(!filePath.startsWith("tests/"), `${filePath} should not be published`);
    assert(!filePath.startsWith(".github/"), `${filePath} should not be published`);
    assert(!filePath.startsWith("docs/"), `${filePath} should not be published`);
    assert(!filePath.includes("/__pycache__/"), `${filePath} should not be published`);
    assert(!filePath.endsWith(".pyc"), `${filePath} should not be published`);
    assert.notEqual(filePath, ".npmrc");
  }
});

test("npm exec installs from the packed skills without downloading a repository tarball", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rainskills-exec-"));
  const packDir = path.join(tempDir, "pack");
  const destination = path.join(tempDir, "skills");
  const fakeBin = path.join(tempDir, "bin");
  const curlLog = path.join(tempDir, "curl.log");
  fs.mkdirSync(packDir);
  fs.mkdirSync(fakeBin);
  fs.writeFileSync(
    path.join(fakeBin, "curl"),
    '#!/bin/sh\nprintf "%s\\n" "$*" >> "$RAINSKILLS_CURL_LOG"\nexit 0\n',
    { mode: 0o755 }
  );

  const packed = packPackage(packDir);
  const result = spawnSync(
    npmCommand,
    [
      "exec",
      "--yes",
      `--package=${packed.tarballPath}`,
      "--",
      "rainskills",
      "--dest",
      destination,
      "--force",
    ],
    {
      cwd: tempDir,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ""}`,
        RAINSKILLS_CURL_LOG: curlLog,
      },
    }
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  for (const skillName of skillNames) {
    assert(fs.existsSync(path.join(destination, skillName, "SKILL.md")));
  }
  assert(fs.existsSync(path.join(destination, uploadHelper)));
  const curlCalls = fs.existsSync(curlLog) ? fs.readFileSync(curlLog, "utf8") : "";
  assert(!/rainskills-(latest|[a-f0-9]+)\.tar\.gz/.test(curlCalls), curlCalls);
});

test("the packed artifact exposes a real npx command", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rainskills-npx-"));
  const packed = packPackage(tempDir);
  const result = spawnSync(
    npxCommand,
    ["--yes", `--package=${packed.tarballPath}`, "rainskills", "--help"],
    { cwd: tempDir, encoding: "utf8" }
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Usage:/);
  assert.match(result.stdout, /--rainbond-url URL/);
});

test("the packed artifact exposes platform install and resume commands", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rainskills-platform-npx-"));
  const packed = packPackage(tempDir);
  for (const args of [
    ["platform", "install", "--help"],
    ["resume", "--help"],
  ]) {
    const result = spawnSync(
      npxCommand,
      ["--yes", `--package=${packed.tarballPath}`, "rainskills", ...args],
      { cwd: tempDir, encoding: "utf8" }
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /--onboarding-id ID/);
  }
});
