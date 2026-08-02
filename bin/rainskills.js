#!/usr/bin/env node

const path = require("node:path");
const { spawn } = require("node:child_process");

function classifyNodeMajor(major) {
  if (major < 18) {
    return "unsupported";
  }
  if (major === 18 || major === 20) {
    return "eol";
  }
  return "supported";
}

function resolveInvocation(args) {
  const installerPath = path.resolve(__dirname, "..", "install.sh");
  const platformInstallerPath = path.resolve(
    __dirname,
    "..",
    "rainbond-platform-installer",
    "scripts",
    "platform-installer.js"
  );

  if (args[0] === "platform" && args[1] === "install") {
    return {
      executable: process.execPath,
      args: [platformInstallerPath, "install", ...args.slice(2)],
    };
  }
  if (args[0] === "resume") {
    return {
      executable: process.execPath,
      args: [platformInstallerPath, "resume", ...args.slice(1)],
    };
  }
  return {
    executable: "bash",
    args: [installerPath, ...args],
  };
}

function run() {
  const major = Number.parseInt(process.versions.node.split(".", 1)[0], 10);
  const support = classifyNodeMajor(major);

  if (support === "unsupported") {
    console.error(
      `错误：RainSkills 的 npx 安装方式需要 Node.js 18 或更高版本，当前为 ${process.version}。`
    );
    console.error(
      "请升级到 Node.js 22/24，或改用：bash <(curl -fsSL https://get.rainbond.com/rainskills/install.sh)"
    );
    process.exitCode = 1;
    return;
  }

  if (support === "eol") {
    console.error(
      `警告：当前 ${process.version} 已结束维护；本次仍会继续，建议升级到 Node.js 22 或 24。`
    );
  }

  const invocation = resolveInvocation(process.argv.slice(2));
  const child = spawn(invocation.executable, invocation.args, {
    env: process.env,
    stdio: "inherit",
  });
  let spawnFailed = false;

  const forwardSigint = () => child.kill("SIGINT");
  const forwardSigterm = () => child.kill("SIGTERM");
  process.on("SIGINT", forwardSigint);
  process.on("SIGTERM", forwardSigterm);

  child.on("error", (error) => {
    spawnFailed = true;
    console.error(`错误：无法启动 RainSkills 安装器：${error.message}`);
    process.exitCode = 1;
  });

  child.on("close", (code, signal) => {
    process.removeListener("SIGINT", forwardSigint);
    process.removeListener("SIGTERM", forwardSigterm);

    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exitCode = spawnFailed ? 1 : code === null ? 1 : code;
  });
}

module.exports = { classifyNodeMajor, resolveInvocation };

if (require.main === module) {
  run();
}
