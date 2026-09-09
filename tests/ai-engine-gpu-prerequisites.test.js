"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");
const gpu = read("rainbond-ai-assistant/references/gpu-provider-and-capacity.md");
const deployment = read("rainbond-ai-assistant/references/instance-deployment.md");
const output = read("rainbond-ai-assistant/references/output-contract.md");

test("GPU readiness guidance distinguishes every provider state without guessing driver failure", () => {
  for (const state of [
    "no_gpu",
    "standard_pending",
    "standard_ready",
    "hami_ready",
    "hami_degraded",
    "device_plugin_conflict",
  ]) {
    assert.match(gpu, new RegExp(`\\b${state}\\b`), state);
  }

  assert.match(gpu, /`no_gpu`[^\n]*(?:不能|不得)[^\n]*(?:驱动缺失|没有驱动)/);
  assert.match(gpu, /`standard_pending`[^\n]*(?:驱动|Container Toolkit|Runtime|Device Plugin)/);
  assert.match(gpu, /监控[^\n]*(?:unavailable|不可用)[^\n]*(?:不能|不得)[^\n]*(?:驱动缺失|没有驱动)/i);
});

test("GPU preflight blocks unsafe writes while preserving compatible CPU and management paths", () => {
  assert.match(deployment, /GPU[^\n]*前置检查/);
  assert.match(deployment, /(?:pending|degraded|conflict)[^\n]*(?:阻止|禁止)[^\n]*GPU/);
  assert.match(gpu, /GPU 不可用[^\n]*(?:不等于|并不代表)[^\n]*(?:整个插件|全部功能)/);
  assert.match(gpu, /模型[^\n]*(?:搜索|下载)[^\n]*(?:仍可用|不受影响)/);
  assert.match(gpu, /CPU[^\n]*(?:兼容|支持)[^\n]*(?:回退|候选|部署)/);
  assert.match(gpu, /(?:FP8|CPU 不兼容)[^\n]*(?:不能|不得)[^\n]*(?:回退|CPU)/);
});

test("GPU infrastructure remediation remains evidence-based and administrator-controlled", () => {
  assert.match(gpu, /hardware_detected[\s\S]*driver_state[\s\S]*device_plugin_state[\s\S]*observer_state/);
  assert.match(gpu, /(?:unknown|unavailable)[^\n]*(?:保留|原样|不得猜测)/);
  assert.match(gpu, /不得自动安装 GPU Operator/);
  assert.match(gpu, /GPU Operator[^\n]*(?:管理员|明确确认)/);
  assert.match(output, /GPU[^\n]*(?:影响范围|可用范围)[^\n]*(?:下一步|处理建议)/);
});

