const os = require("node:os");
const readline = require("node:readline/promises");
const { writeUserMessage } = require("./user-message.js");

const LOCATIONS = new Set(["local", "server"]);
const SERVER_MODES = new Set(["single-node", "host-cluster", "existing-kubernetes"]);
const LEGACY_TARGETS = new Set(["local-linux", "local-macos", "local-windows", "remote-linux"]);
const LOCAL_TARGETS = new Set(["local-linux", "local-macos", "local-windows"]);
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u;
const CREDENTIAL_LIKE_VALUE = /^(?:gh[pousr]_|github_pat_|xox[baprs]-|sk-[A-Za-z0-9_-]{16,}|AKIA[A-Z0-9]{12,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$)/i;

function assertRawRouteString(value, { field, maximumLength, rejectCredential = false }) {
  if (value === undefined || value === null || value === "") return;
  if (typeof value !== "string"
      || value.length > maximumLength
      || CONTROL_CHARACTERS.test(value)
      || (rejectCredential && CREDENTIAL_LIKE_VALUE.test(value))) {
    throw new Error(`${field}输入无效`);
  }
}

function validateRawRoutingInputs(options = {}, savedRoute = null) {
  assertRawRouteString(options.target, { field: "安装目标", maximumLength: 64 });
  assertRawRouteString(options.ssh, { field: "SSH 地址", maximumLength: 320, rejectCredential: true });
  assertRawRouteString(savedRoute?.host, { field: "保存的 SSH 地址", maximumLength: 320, rejectCredential: true });
}

function localTargetForPlatform(platform) {
  if (platform === "linux") return "local-linux";
  if (platform === "darwin") return "local-macos";
  if (platform === "win32") return "local-windows";
  throw new Error("不支持当前控制端系统");
}

function routeForLegacyTarget(target, platform) {
  if (!target) return null;
  if (!LEGACY_TARGETS.has(target)) throw new Error("安装目标无效");
  if (target === "remote-linux") {
    return { location: "server", mode: "single-node", kind: target };
  }
  const expected = localTargetForPlatform(platform);
  if (target !== expected) {
    throw new Error("安装目标与当前控制端不匹配");
  }
  return { location: "local", mode: "single-node", kind: target };
}

function validatePersistedRouteTuple(state, { controlPlatform = null } = {}) {
  const hasNewRouteFields = Object.prototype.hasOwnProperty.call(state, "location")
    || Object.prototype.hasOwnProperty.call(state, "mode");
  validateRawRoutingInputs({}, { host: state.host });
  if (!hasNewRouteFields) {
    const kind = state.target_kind;
    const host = state.host;
    const sshPort = state.ssh_port;
    const isEmpty = (kind === null || kind === undefined)
      && (host === null || host === undefined || host === "")
      && (sshPort === null || sshPort === undefined);
    const isSafeLocalHost = typeof host === "string"
      && /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(host);
    const isLocal = LOCAL_TARGETS.has(kind)
      && isSafeLocalHost
      && (sshPort === null || sshPort === undefined)
      && (!controlPlatform || kind === localTargetForPlatform(controlPlatform));
    const isCanonicalSshHost = typeof host === "string"
      && /^(?:[A-Za-z0-9_.-]+@)?[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(host)
      && !host.startsWith("-");
    const isRemote = kind === "remote-linux"
      && isCanonicalSshHost
      && Number.isInteger(sshPort)
      && sshPort >= 1
      && sshPort <= 65535;
    if (!isEmpty && !isLocal && !isRemote) {
      throw new Error("旧版平台安装状态无效");
    }
    return state;
  }

  const { location, mode, target_kind: kind } = state;
  const isValid = (location === null && mode === null && kind === null)
    || (location === "server" && mode === null && kind === null)
    || (location === "local" && mode === "single-node" && LOCAL_TARGETS.has(kind))
    || (location === "server" && mode === "single-node" && kind === "remote-linux")
    || (location === "server" && mode === "host-cluster" && kind === "host-cluster")
    || (location === "server" && mode === "existing-kubernetes" && kind === "existing-kubernetes");
  if (!isValid) throw new Error("平台安装状态中的路由组合无效");
  if (location === "local" && controlPlatform && kind !== localTargetForPlatform(controlPlatform)) {
    throw new Error("保存的本地安装目标与当前控制端不匹配");
  }
  return state;
}

function validateRoutingRequest({ platform, options = {}, savedRoute = null }) {
  validateRawRoutingInputs(options, savedRoute);
  if (options.location && !LOCATIONS.has(options.location)) {
    throw new Error("--location 只支持 local 或 server");
  }
  if (options.mode && !SERVER_MODES.has(options.mode)) {
    throw new Error("--mode 只支持固定安装模式");
  }

  const legacy = routeForLegacyTarget(options.target || "", platform);
  if (options.location === "local" && options.mode && options.mode !== "single-node") {
    throw new Error("本地安装只能使用单机模式");
  }
  if (options.location === "local" && options.ssh) {
    throw new Error("--location local 与 --ssh 冲突");
  }
  if (legacy?.location === "local" && options.ssh) {
    throw new Error("本地安装目标与 --ssh 参数冲突");
  }
  if (options.ssh && options.mode && options.mode !== "single-node") {
    throw new Error("--ssh 与非单机服务器模式冲突");
  }
  if (legacy && options.location && legacy.location !== options.location) {
    throw new Error("--target 与 --location 冲突");
  }
  if (legacy && options.mode && options.mode !== "single-node") {
    throw new Error("--target 与非单机模式冲突");
  }

  if (savedRoute?.location && options.location && savedRoute.location !== options.location) {
    throw new Error("已保存的部署位置与 --location 冲突");
  }
  if (savedRoute?.mode && options.mode && savedRoute.mode !== options.mode) {
    throw new Error("已保存的安装模式与 --mode 冲突");
  }
  if (savedRoute?.kind && legacy?.kind && savedRoute.kind !== legacy.kind) {
    throw new Error("已保存的安装目标与 --target 冲突");
  }
  if (savedRoute && options.ssh) {
    if (savedRoute.location && savedRoute.location !== "server") {
      throw new Error("已保存的部署位置不能被 --ssh 改写");
    }
    if (savedRoute.mode && savedRoute.mode !== "single-node") {
      throw new Error("已保存的安装模式不能被 --ssh 改写");
    }
    if (savedRoute.kind && savedRoute.kind !== "remote-linux") {
      throw new Error("已保存的安装目标与 --ssh 冲突");
    }
    if (savedRoute.host && savedRoute.host !== options.ssh) {
      throw new Error("已保存的 SSH 目标与新的 --ssh 目标冲突");
    }
  }

  return legacy;
}

function waitingRoute(missing, values = {}) {
  return {
    waiting: true,
    missing,
    location: values.location || null,
    mode: values.mode || null,
    kind: values.kind || null,
    host: values.host || null,
    sshPort: values.sshPort || null,
  };
}

function writeMissingLocation(write) {
  write("\n[RAINSKILLS_USER_INPUT_REQUIRED:platform_install_location]\n");
  writeUserMessage(write, "platform.location", [
    "请选择应用运行环境的部署位置后重新执行：",
    "- 安装到本地：--location local",
    "- 安装到服务器：--location server",
  ].join("\n"));
}

function writeMissingServerMode(write) {
  write("\n[RAINSKILLS_USER_INPUT_REQUIRED:platform_install_server_mode]\n");
  writeUserMessage(write, "platform.server-mode", [
    "请选择服务器安装模式后重新执行：",
    "- 快速单机安装",
    "- 多节点主机集群",
    "- 已有 Kubernetes 集群",
  ].join("\n"));
}

function writeMissingSsh(write) {
  write("\n[RAINSKILLS_USER_INPUT_REQUIRED:platform_install_server_ssh]\n");
  writeUserMessage(
    write,
    "platform.server-ssh",
    "请提供单机服务器 SSH 地址后重新执行：--location server --mode single-node --ssh <user@host> [--ssh-port 22]",
  );
}

async function selectPlatformRoute({
  platform,
  options = {},
  savedRoute = null,
  interactive = process.stdin.isTTY && process.stdout.isTTY,
  ask,
  write = (value) => process.stdout.write(value),
  hostname = os.hostname,
}) {
  const legacy = validateRoutingRequest({ platform, options, savedRoute });
  let prompt;
  let ownsPrompt = false;
  if (!ask && interactive) {
    prompt = readline.createInterface({ input: process.stdin, output: process.stdout });
    ownsPrompt = true;
    ask = (question) => prompt.question(question);
  }

  try {
    let location = options.location
      || legacy?.location
      || (options.ssh ? "server" : "")
      || savedRoute?.location
      || "";
    if (!location) {
      if (!interactive) {
        writeMissingLocation(write);
        return waitingRoute("location");
      }
      write("\n请选择应用运行环境的部署位置：\n  1) 安装到本地\n  2) 安装到服务器\n");
      while (!location) {
        const answer = (await ask("请输入选项 [1-2，回车默认 1]: ")).trim();
        if (answer === "" || answer === "1") location = "local";
        else if (answer === "2") location = "server";
        else write("请输入 1 或 2。\n");
      }
    }

    if (location === "local") {
      if (options.mode && options.mode !== "single-node") {
        throw new Error("本地安装只能使用单机模式");
      }
      if (options.ssh) throw new Error("本地安装与 --ssh 参数冲突");
      const kind = localTargetForPlatform(platform);
      if (savedRoute?.kind && savedRoute.kind !== kind) {
        throw new Error("已保存的本地安装目标与当前控制端冲突");
      }
      return {
        waiting: false,
        location,
        mode: "single-node",
        kind,
        host: savedRoute?.host || hostname(),
        sshPort: null,
      };
    }

    let mode = options.mode
      || legacy?.mode
      || (options.ssh ? "single-node" : "")
      || savedRoute?.mode
      || "";
    if (!mode) {
      if (!interactive) {
        writeMissingServerMode(write);
        return waitingRoute("mode", { location });
      }
      write("\n请选择服务器安装模式：\n");
      write("  1) 快速单机安装\n  2) 多节点主机集群\n  3) 安装到已有 Kubernetes 集群\n");
      while (!mode) {
        const answer = (await ask("请输入选项 [1-3，回车默认 1]: ")).trim();
        if (answer === "" || answer === "1") mode = "single-node";
        else if (answer === "2") mode = "host-cluster";
        else if (answer === "3") mode = "existing-kubernetes";
        else write("请输入 1 到 3 之间的选项。\n");
      }
    }

    if (mode !== "single-node") {
      const kind = mode;
      if (savedRoute?.kind && savedRoute.kind !== kind) {
        throw new Error("已保存的安装目标与 --mode 冲突");
      }
      return {
        waiting: false,
        location,
        mode,
        kind,
        host: null,
        sshPort: null,
      };
    }

    let remoteHost = options.ssh || savedRoute?.host || "";
    if (!remoteHost) {
      if (!interactive) {
        writeMissingSsh(write);
        return waitingRoute("ssh", {
          location,
          mode,
          kind: "remote-linux",
          sshPort: options.sshPort ?? savedRoute?.sshPort ?? 22,
        });
      }
      while (!remoteHost) {
        remoteHost = (await ask("Linux SSH 地址（例如 root@192.168.1.20 或主机别名）: ")).trim();
        if (!remoteHost) write("SSH 地址不能为空。\n");
      }
    }
    let remotePort = options.sshPort ?? savedRoute?.sshPort ?? 22;
    if (!options.ssh && !savedRoute?.host && interactive) {
      const answer = (await ask("SSH 端口 [回车默认 22]: ")).trim();
      remotePort = answer || 22;
    }
    return {
      waiting: false,
      location,
      mode,
      kind: "remote-linux",
      host: remoteHost,
      sshPort: remotePort,
    };
  } finally {
    if (ownsPrompt) prompt.close();
  }
}

module.exports = {
  LEGACY_TARGETS,
  LOCATIONS,
  SERVER_MODES,
  localTargetForPlatform,
  routeForLegacyTarget,
  selectPlatformRoute,
  validatePersistedRouteTuple,
  validateRawRoutingInputs,
  validateRoutingRequest,
};
