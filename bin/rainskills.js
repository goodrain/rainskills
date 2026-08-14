#!/usr/bin/env node

const path = require("node:path");
const { spawn } = require("node:child_process");
const {
  detectControlEnvironment,
} = require("../rainbond-platform-installer/scripts/control-environment.js");

async function runBuiltin(args, {
  runtimeStateManager,
  write = (value) => process.stdout.write(value),
} = {}) {
  if (args[0] === "runtime" && args[1] === "status") {
    if (args.length !== 3 || args[2] !== "--json") {
      throw new Error("runtime status 只支持固定参数 --json");
    }
    const manager = runtimeStateManager || require(
      "../rainbond-platform-installer/scripts/runtime-state.js"
    ).createRuntimeStateManager();
    write(`${JSON.stringify(await manager.status())}\n`);
    return true;
  }
  if (args[0] === "intent" && args[1] === "resume") {
    if (args.length !== 4 || args[2] !== "--onboarding-id" || !args[3]) {
      throw new Error("intent resume 需要固定参数 --onboarding-id <uuid>");
    }
    const manager = runtimeStateManager || require(
      "../rainbond-platform-installer/scripts/runtime-state.js"
    ).createRuntimeStateManager();
    const status = await manager.status();
    if (status.state !== "connected" || status.usable !== true) {
      throw new Error("runtime 尚未 connected 且通过 live probe，不能恢复 intent");
    }
    const runtime = manager.read();
    if (runtime.state !== "connected") throw new Error("runtime 状态已变化，不能恢复 intent");
    if (runtime.operation_id !== args[3]) throw new Error("runtime operation_id 与参数不匹配");
    if (!runtime.intent) throw new Error("runtime state 缺少 validated intent");
    const { createIntentContinuation } = require(
      "../rainbond-platform-installer/scripts/runtime-intents.js"
    );
    write(`${JSON.stringify(createIntentContinuation(runtime.intent, runtime.failed_step || undefined))}\n`);
    return true;
  }
  return false;
}

function classifyNodeMajor(major) {
  if (major < 18) {
    return "unsupported";
  }
  if (major === 18 || major === 20) {
    return "eol";
  }
  return "supported";
}

function resolveInvocation(args, {
  control = detectControlEnvironment(),
  execPath = process.execPath,
} = {}) {
  const installerPath = path.resolve(__dirname, "..", "install.sh");
  const platformInstallerPath = path.resolve(
    __dirname,
    "..",
    "rainbond-platform-installer",
    "scripts",
    "platform-installer.js"
  );
  const windowsOnboardingPath = path.resolve(
    __dirname,
    "..",
    "rainbond-platform-installer",
    "scripts",
    "windows-onboarding.js"
  );

  if (args[0] === "platform" && args[1] === "install") {
    return {
      executable: execPath,
      args: [platformInstallerPath, "install", ...args.slice(2)],
    };
  }
  if (args[0] === "resume") {
    return {
      executable: execPath,
      args: [platformInstallerPath, "resume", ...args.slice(1)],
    };
  }
  if (control.mode === "windows-native") {
    return {
      executable: execPath,
      args: [windowsOnboardingPath, ...args],
    };
  }
  return {
    executable: "bash",
    args: [installerPath, ...args],
  };
}

async function run() {
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

  const args = process.argv.slice(2);
  if (await runBuiltin(args)) return;
  const invocation = resolveInvocation(args);
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

module.exports = { classifyNodeMajor, resolveInvocation, runBuiltin };

if (require.main === module) {
  run().catch((error) => {
    console.error(`错误：${error.message}`);
    process.exitCode = 1;
  });
}
