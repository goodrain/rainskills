#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const REQUEST_SCHEMA = "rainskills.windows-request.v1";
const RESULT_SCHEMA = "rainskills.windows-result.v1";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FIXED_ACTIONS = Object.freeze(["Preflight"]);
const RESULT_KEYS = new Set([
  "schema",
  "action",
  "operation_id",
  "installation_id",
  "nonce",
  "status",
  "facts",
]);

function defaultRunner(command, args) {
  return spawnSync(command, args, {
    encoding: "utf8",
    windowsHide: true,
    timeout: 120000,
  });
}

function assertUuid(value, label) {
  if (!UUID_PATTERN.test(String(value || ""))) {
    throw new Error(`${label} 不是有效的 UUID`);
  }
}

function gibibytes(bytes) {
  return Number(bytes || 0) / 1024 ** 3;
}

function normalizedOrigin(value) {
  try {
    return new URL(value).origin;
  } catch {
    return "";
  }
}

function evaluateWindowsPreflight(facts, policy, expectedUserSid) {
  if (!facts || typeof facts !== "object" || Array.isArray(facts)) {
    throw new Error("Windows 预检事实无效");
  }
  const windowsPolicy = policy?.windows;
  if (!windowsPolicy) throw new Error("缺少 Windows 安装策略");

  const blockers = [];
  const minimums = policy.minimums;
  if (!windowsPolicy.supported_product_types.includes(facts.productType)) {
    blockers.push("仅支持 Windows 工作站版本，当前系统不是受支持的 Windows 工作站");
  }
  if (Number(facts.buildNumber) < windowsPolicy.minimum_build) {
    blockers.push(`Windows 系统版本过低，内部版本至少需要 ${windowsPolicy.minimum_build}`);
  }
  if (!windowsPolicy.supported_architectures.includes(facts.architecture)) {
    blockers.push(`仅支持 ${windowsPolicy.supported_architectures.join("、")} 架构，当前为 ${facts.architecture || "未知"}`);
  }
  if (!expectedUserSid || String(facts.currentUserSid || "").toUpperCase() !== String(expectedUserSid).toUpperCase()) {
    blockers.push("当前用户 SID 与启动安装的用户不一致");
  }
  if (!facts.isAdministrator) blockers.push("当前用户必须属于本机 Administrators 组，后续操作仍会显示 UAC 确认");
  if (!facts.uacEnabled) blockers.push("必须启用 Windows UAC，才能安全执行需要管理员权限的固定操作");
  if (Number(facts.cpuCores) < minimums.cpu_cores) {
    blockers.push(`CPU 至少需要 ${minimums.cpu_cores} 核，当前 ${Number(facts.cpuCores) || 0} 核`);
  }
  if (Number(facts.memoryBytes) < minimums.memory_bytes) {
    blockers.push(`内存至少需要 8 GB，当前 ${gibibytes(facts.memoryBytes).toFixed(1)} GB`);
  }
  if (Number(facts.diskBytes) < minimums.disk_bytes) {
    blockers.push(`可用磁盘至少需要 50 GB，当前 ${gibibytes(facts.diskBytes).toFixed(1)} GB`);
  }
  if (!facts.virtualizationEnabled) blockers.push("未检测到可用的固件虚拟化，请先在 BIOS/UEFI 中启用虚拟化");
  if (facts.wslInstalled && !windowsPolicy.networking_modes.includes(String(facts.wslNetworkingMode || "").toLowerCase())) {
    blockers.push(`WSL 必须使用 NAT 网络模式，当前为 ${facts.wslNetworkingMode || "未知"}`);
  }
  if (Array.isArray(facts.occupiedPorts) && facts.occupiedPorts.length > 0) {
    blockers.push(`本机端口 ${facts.occupiedPorts.join("、")} 已被占用`);
  }
  if (Array.isArray(facts.unknownManagedObjects) && facts.unknownManagedObjects.length > 0) {
    blockers.push(`检测到未知的 RainSkills 管理对象：${facts.unknownManagedObjects.join("、")}`);
  }
  if (!facts.availableSubnet || !/^(?:\d{1,3}\.){3}\d{1,3}\/30$/.test(facts.availableSubnet)) {
    blockers.push("没有找到不与现有网络重叠的可用 /30 子网");
  }

  const allowedOrigins = new Set(windowsPolicy.preflight_allowed_origins.map(normalizedOrigin));
  const checks = new Map((facts.originChecks || []).map((check) => [normalizedOrigin(check.origin), check]));
  for (const origin of allowedOrigins) {
    const check = checks.get(origin);
    if (!check || check.reachable !== true) blockers.push(`无法访问安装所需地址 ${origin}`);
    for (const redirect of check?.redirectOrigins || []) {
      const redirectOrigin = normalizedOrigin(redirect);
      if (!allowedOrigins.has(redirectOrigin)) blockers.push(`检测到未获准的跳转来源 ${redirectOrigin || redirect}`);
    }
  }

  return {
    ok: blockers.length === 0,
    blockers,
    effects: [
      "启用 WSL 2 和虚拟机平台组件（可能需要重启 Windows）",
      "安装或更新经过验证的 WSL 运行时",
      "下载并校验 Ubuntu 22.04 根文件系统",
      "创建专用的 Rainbond WSL 发行版",
      "配置本机 NAT 网络和 127.0.0.1 端口转发",
      "在专用 WSL 环境中安装并验证 Rainbond",
    ],
  };
}

function validateResult(result, expected) {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new Error("Windows helper 结果不是对象");
  }
  const unknown = Object.keys(result).filter((key) => !RESULT_KEYS.has(key));
  if (unknown.length > 0) throw new Error(`Windows helper 结果包含未允许字段：${unknown.join("、")}`);
  function rejectExecutableFields(value) {
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (["command", "script"].includes(key.toLowerCase())) {
        throw new Error(`Windows helper 结果包含未允许字段：${key}`);
      }
      rejectExecutableFields(child);
    }
  }
  rejectExecutableFields(result);
  if (result.schema !== RESULT_SCHEMA || result.action !== expected.action) {
    throw new Error("Windows helper 结果 schema 或 action 不匹配");
  }
  if (result.operation_id !== expected.operationId || result.installation_id !== expected.installationId) {
    throw new Error("Windows helper 结果与当前安装标识不匹配");
  }
  if (result.nonce !== expected.nonce) throw new Error("Windows helper 结果 nonce 不匹配");
  if (!new Set(["ok", "blocked", "error"]).has(result.status)) {
    throw new Error("Windows helper 结果 status 无效");
  }
  if (!result.facts || typeof result.facts !== "object" || Array.isArray(result.facts)) {
    throw new Error("Windows helper 结果缺少结构化 facts");
  }
  return result;
}

function createWindowsPlatformAdapter({
  runner = defaultRunner,
  stateStore,
  policy,
  userSid,
  home = os.homedir(),
  powershell = "powershell.exe",
  helperPath = path.join(__dirname, "windows-platform.ps1"),
} = {}) {
  if (!stateStore) throw new Error("Windows platform adapter 需要安全状态存储");
  if (!policy?.windows) throw new Error("Windows platform adapter 缺少版本化策略");
  if (!/^S-\d-(?:\d+-)+\d+$/i.test(String(userSid || ""))) {
    throw new Error("Windows platform adapter 需要有效的当前用户 SID");
  }

  async function invoke(action, { operationId, installationId }) {
    if (!FIXED_ACTIONS.includes(action)) throw new Error(`不允许的 Windows helper action：${action}`);
    assertUuid(operationId, "operation id");
    assertUuid(installationId, "installation id");
    const nonce = crypto.randomBytes(32).toString("hex");
    const root = path.join(home, ".rainbond", "platform-installer", operationId, "windows");
    stateStore.ensurePrivateDirectory(root);
    const requestPath = path.join(root, `request-${nonce}.json`);
    const resultPath = path.join(root, `result-${nonce}.json`);
    const request = {
      schema: REQUEST_SCHEMA,
      action,
      operation_id: operationId,
      installation_id: installationId,
      nonce,
      user_sid: userSid,
      policy: {
        minimums: policy.minimums,
        windows: policy.windows,
      },
    };
    stateStore.atomicWriteJson(requestPath, request);
    const args = [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      helperPath,
      "-Action",
      action,
      "-RequestPath",
      requestPath,
      "-ResultPath",
      resultPath,
    ];
    const execution = await Promise.resolve(runner(powershell, args));
    if (execution?.error) throw new Error(`无法启动 Windows helper：${execution.error.message}`);
    const status = execution?.status ?? execution?.code ?? 0;
    if (status !== 0) {
      throw new Error(`Windows helper 执行失败（退出码 ${status}）：${String(execution?.stderr || "").trim()}`);
    }
    const result = stateStore.readProtectedJson(resultPath);
    return validateResult(result, { action, operationId, installationId, nonce });
  }

  return {
    async preflight({ operationId, installationId }) {
      const result = await invoke("Preflight", { operationId, installationId });
      if (result.status === "error") throw new Error("Windows helper 无法完成预检");
      return {
        ...result,
        assessment: evaluateWindowsPreflight(result.facts, policy, userSid),
      };
    },
  };
}

module.exports = {
  FIXED_ACTIONS,
  REQUEST_SCHEMA,
  RESULT_SCHEMA,
  createWindowsPlatformAdapter,
  evaluateWindowsPreflight,
};
