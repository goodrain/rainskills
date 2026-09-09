"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const cpu = fs.readFileSync(
  path.join(root, "rainbond-ai-assistant", "references", "cpu-deployment.md"),
  "utf8"
);

test("CPU is a first-class deployment path with explicit resource and compatibility gates", () => {
  for (const marker of [
    "compute_mode=cpu",
    "gpu_count=0",
    "cpu_request_cores <= cpu_limit_cores",
    "memory_request_gib <= memory_limit_gib",
    "cpu_kvcache_space_gb",
    "FP8",
    "ARM64",
    "AWQ/GPTQ",
    "tokens/s",
    "served_model_registered",
  ]) {
    assert.match(cpu, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  for (const forbidden of [
    "gpu_memory_utilization",
    "kv_cache_memory_bytes",
    "tensor_parallel_size",
    "pipeline_parallel_size",
  ]) {
    assert.match(cpu, new RegExp(`禁止[^\n]*${forbidden}|${forbidden}[^\n]*禁止`));
  }
  assert.match(cpu, /GPU.*(?:不可用|未安装)[^\n]*(?:不阻止|不是.*门禁)/);
});

