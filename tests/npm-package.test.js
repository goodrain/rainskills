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
  "rainbond-opensource-app-deploy",
  "rainbond-platform-installer",
  "rainbond-platform-query",
  "rainbond-project-init",
  "rainbond-template-installer",
];
const approvedCapabilitySummary = `Rainskills 安装完成，下一条消息即可直接使用。

下一步可以直接说：

- 帮我部署当前项目
- 帮我部署一个 Git 仓库
- 帮我通过镜像或安装包部署应用
- 帮我安装一个应用模板
- 帮我分析当前项目应该如何部署

也可以直接告诉我你想部署什么应用。`;
const agentSummaryRequirement = "[RAINSKILLS_AGENT_SUMMARY_REQUIRED:include-next-actions]";

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

test("package metadata defines a public npx command with pinned runtime dependencies", () => {
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
  assert.deepEqual(manifest.dependencies, {
    yaml: "2.9.0",
  });
  assert.equal(manifest.devDependencies, undefined);
  assert.equal(manifest.pi, undefined);
  assert(!manifest.files.includes("pi/"));
  assert.equal(manifest.scripts["build:pi"], undefined);
  assert.equal(manifest.scripts["check:pi"], undefined);
  assert.equal(manifest.scripts["test:pi"], undefined);
  assert.equal(manifest.scripts.postinstall, undefined);
  assert.equal(
    manifest.scripts["sync:runtime-version"],
    "node scripts/sync-runtime-version.mjs"
  );
  assert.equal(
    manifest.scripts["check:runtime-version"],
    "node scripts/sync-runtime-version.mjs --check"
  );
  assert.equal(
    manifest.scripts.version,
    "npm run sync:runtime-version && npm run sync:runtime-contracts && npm run build:marketplace"
  );
  assert.equal(
    manifest.scripts.prepack,
    "node scripts/sync-runtime-version.mjs --check && node scripts/sync-runtime-contracts.mjs --check && node scripts/build-marketplace-package.mjs --check --quiet"
  );
  assert.equal(
    manifest.scripts["test:package-upload"],
    "python3 tests/package_upload_helper_test.py && python3 tests/package_upload_workflow_contract_test.py && python3 rainbond-fullstack-bootstrap/scripts/run_bootstrap_evals.py"
  );
  assert.equal(
    manifest.scripts.test,
    "npm run test:runtime-version && npm run test:runtime-contracts && npm run test:auto-update && npm run test:launcher && npm run test:api-bridge && npm run test:console-contract && npm run test:skill-profile && npm run test:marketplace && npm run test:runtime-routing && npm run test:telemetry && npm run test:platform && npm run test:windows && npm run test:package-upload && npm run test:package && npm run test:installer && npm run test:signal && npm run test:npx-pty"
  );
  assert.equal(
    manifest.scripts["test:console-contract"],
    "python3 tests/console_tool_contract_test.py"
  );
  assert.equal(
    manifest.scripts["test:runtime-version"],
    "node --test tests/runtime-version-sync.test.js"
  );
  assert.equal(manifest.scripts["test:auto-update"], "node --test tests/auto-update.test.js");
  assert.equal(
    manifest.scripts["test:platform"],
    "node --test tests/platform-installer.test.js tests/host-cluster-installer.test.js tests/existing-kubernetes-installer.test.js tests/ssh-key-setup.test.js"
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
  assert(filePaths.has("scripts/build-skill-manifest.mjs"));
  assert(filePaths.has("scripts/install-local-cli.mjs"));
  assert(filePaths.has("install.sh"));
  assert(![...filePaths].some((filePath) => filePath.startsWith("pi/")));
  assert(filePaths.has("rainbond-platform-installer/scripts/platform-installer.js"));
  assert(filePaths.has("rainbond-platform-installer/scripts/auto-update.js"));
  assert(filePaths.has("rainbond-platform-installer/scripts/host-cluster-installer.js"));
  assert(filePaths.has("rainbond-platform-installer/scripts/existing-kubernetes-installer.js"));
  assert(filePaths.has("rainbond-platform-installer/scripts/ssh-key-setup.js"));
  assert(filePaths.has("rainbond-platform-installer/agents/openai.yaml"));
  assert(filePaths.has("rainbond-platform-installer/references/installation-policy.json"));
  assert(filePaths.has("rainbond-platform-installer/references/installation-policy.md"));
  for (const runtimeFile of [
    "browser-callback.py",
    "windows-onboarding.js",
    "windows-auth.js",
    "windows-browser.ps1",
    "windows-client-config.js",
    "windows-platform.js",
    "windows-platform.ps1",
    "single-runtime.js",
    "auto-update-worker.js",
    "installed-version.js",
    "ssh-key-setup.js",
    "user-message.js",
    "wsl-bootstrap.sh",
  ]) {
    assert(filePaths.has(`rainbond-platform-installer/scripts/${runtimeFile}`), `${runtimeFile} is missing`);
  }
  assert.equal(filePaths.has("rainbond-platform-installer/scripts/mcp-router.js"), false);
  assert.equal(filePaths.has("rainbond-platform-installer/scripts/mcp-server.js"), false);
  assert.equal(
    require("../rainbond-platform-installer/scripts/installed-version.js").version,
    require("../package.json").version,
    "the installed local updater version must match package.json"
  );
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
        npm_config_offline: "true",
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

test("the packed default installer installs only Skills and prints the approved capabilities", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rainskills-skills-only-"));
  const packDir = path.join(tempDir, "pack");
  const home = path.join(tempDir, "home");
  const fakeBin = path.join(tempDir, "bin");
  const curlLog = path.join(tempDir, "curl.log");
  fs.mkdirSync(packDir);
  fs.mkdirSync(home);
  fs.mkdirSync(fakeBin);
  fs.writeFileSync(
    path.join(fakeBin, "curl"),
    '#!/bin/sh\nprintf "%s\\n" "$*" >> "$RAINSKILLS_CURL_LOG"\nexit 1\n',
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
      "codex",
      "--force",
      "--saas",
    ],
    {
      cwd: tempDir,
      encoding: "utf8",
      env: {
        ...process.env,
        npm_config_offline: "true",
        npm_config_cache: path.join(os.homedir(), ".npm"),
        HOME: home,
        PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ""}`,
        RAINBOND_JWT: "",
        RAINBOND_PASSWORD: "",
        RAINBOND_URL: "",
        RAINBOND_USERNAME: "",
        RAINSKILLS_CURL_LOG: curlLog,
      },
    }
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const output = `${result.stdout}\n${result.stderr}`.replace(/\r\n/g, "\n");
  assert.equal(output.split(approvedCapabilitySummary).length - 1, 1);
  assert.equal(output.split(agentSummaryRequirement).length - 1, 1);
  assert(
    output.indexOf(approvedCapabilitySummary) < output.indexOf(agentSummaryRequirement),
    "the next-action summary requirement must follow the user-facing message"
  );
  assert.match(output, /\[RAINSKILLS_USER_MESSAGE_BEGIN:install\.completed\]/);
  assert.match(output, /\[RAINSKILLS_USER_MESSAGE_END:install\.completed\]/);
  for (const forbidden of [
    "Rainbond Cloud",
    "私有",
    "MCP",
    "登录",
    "授权",
    "Rainbond Console",
    "rainskills.next-action.v1",
  ]) {
    assert.equal(output.includes(forbidden), false, `default install output contains ${forbidden}`);
  }
  assert.equal(fs.existsSync(path.join(home, ".codex", "skills", "rainbond-app-assistant", "SKILL.md")), true);
  const installedRootSkill = path.join(home, ".codex", "skills", "rainskills", "SKILL.md");
  assert.equal(fs.existsSync(installedRootSkill), true);
  assert.match(fs.readFileSync(installedRootSkill, "utf8"), /只保存一个全局运行环境/);
  assert.equal(fs.existsSync(path.join(home, ".rainbond", "bin", "rainskills-tools.js")), true);
  assert.equal(fs.existsSync(path.join(home, ".rainbond", "bin", "rainskills-skill-manifest.json")), true);
  assert.equal(fs.existsSync(path.join(home, ".rainbond", "lib", "rainbond-platform-installer", "scripts", "single-runtime.js")), true);
  const installedRuntimeRoot = path.join(home, ".rainbond", "lib", "rainskills");
  assert.equal(fs.existsSync(path.join(installedRuntimeRoot, "bin", "rainskills.js")), true);
  assert.equal(fs.existsSync(path.join(installedRuntimeRoot, "install.sh")), true);
  assert.equal(fs.existsSync(path.join(installedRuntimeRoot, "node_modules", "yaml", "package.json")), true);
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(installedRuntimeRoot, "package.json"), "utf8")).version,
    require("../package.json").version
  );
  assert.equal(fs.existsSync(path.join(home, ".rainbond", "mcp.env")), false);
  assert.equal(fs.existsSync(path.join(home, ".rainbond", "rainskills-onboarding-v1.json")), false);
  assert.equal(fs.existsSync(path.join(home, ".rainbond", "platform-installer")), false);
  const autoUpdateState = JSON.parse(fs.readFileSync(
    path.join(home, ".rainbond", "rainskills", "auto-update-v1.json"),
    "utf8"
  ));
  assert.deepEqual(autoUpdateState.destinations, [path.join(home, ".codex", "skills")]);
  assert.equal(fs.existsSync(path.join(home, ".codex", "config.toml")), false);
  assert.equal(fs.existsSync(path.join(home, ".claude.json")), false);
  assert.equal(fs.existsSync(path.join(home, ".zshrc")), false);
  const curlCalls = fs.existsSync(curlLog) ? fs.readFileSync(curlLog, "utf8") : "";
  assert.equal(curlCalls.includes("/console/"), false);
});

test("the packed artifact exposes a real npx command", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rainskills-npx-"));
  const packed = packPackage(tempDir);
  const result = spawnSync(
    npxCommand,
    ["--yes", `--package=${packed.tarballPath}`, "rainskills", "--help"],
    { cwd: tempDir, encoding: "utf8", env: { ...process.env, npm_config_offline: "true" } }
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
      { cwd: tempDir, encoding: "utf8", env: { ...process.env, npm_config_offline: "true" } }
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /--onboarding-id ID/);
  }
});
