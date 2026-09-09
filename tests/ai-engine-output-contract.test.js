"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const YAML = require("yaml");

const root = path.resolve(__dirname, "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

test("AI Engine result schema preserves unavailable, evidence, and optimization semantics", () => {
  const schema = YAML.parse(read("rainbond-ai-assistant/schemas/ai-engine-result.schema.yaml"));
  assert.equal(schema.type, "object");
  assert.deepEqual(schema.required, [
    "action",
    "status",
    "facts",
    "blocker",
    "retryable",
    "next_action",
  ]);
  assert.deepEqual(schema.properties.status.enum, [
    "Running",
    "Stopped",
    "Failed",
    "Creating",
    "downloading",
    "installing",
    "unavailable",
  ]);
  assert.equal(schema.properties.facts.items.required.includes("source"), true);
  assert.deepEqual(schema.properties.progress_mode.enum, ["continuous", "deferred", null]);
  assert.equal(schema.properties.recommendation.required.includes("bottleneck"), true);
  assert.equal(schema.properties.recommendation.required.includes("changes"), true);
  assert.equal(schema.properties.recommendation.required.includes("rejected_options"), true);
  assert.equal(schema.properties.recommendation.required.includes("missing_evidence"), true);
  assert.equal(schema.properties.recommendation.properties.objective.enum.includes("ttft"), true);
  assert.equal(schema.properties.recommendation.properties.objective.enum.includes("decode_latency"), true);
  assert.equal(schema.properties.recommendation.properties.bottleneck.enum.includes("unknown"), true);

  const contract = read("rainbond-ai-assistant/references/output-contract.md");
  assert.match(contract, /默认.*简洁中文/);
  assert.match(contract, /unavailable.*(?:不能|不得).*0/i);
  assert.match(contract, /objective[\s\S]*confidence[\s\S]*validation_plan/);
  assert.match(contract, /bottleneck[\s\S]*missing_evidence/);
  assert.match(contract, /证据不足[\s\S]*不改参数/);
  assert.match(contract, /持续监测[\s\S]*受理后结束/);
  assert.doesNotMatch(contract, /namespace|Pod 名|完整 argv/);
});

test("parameter decisions are evidence-driven and include negative choices", () => {
  const guide = read("rainbond-ai-assistant/references/parameter-decision-guide.md");
  for (const marker of [
    "TTFT",
    "decode_compute",
    "queue_capacity",
    "cache_reuse",
    "max_num_seqs",
    "max_num_batched_tokens",
    "Chunked Prefill",
    "prefix_caching=enabled",
    "tensor_parallel_size",
    "pipeline_parallel_size",
    "kv_cache_dtype=fp8",
    "cpu_kvcache_space_gb",
    "missing_evidence",
    "不改参数",
  ]) {
    assert.match(guide, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.match(guide, /gpu_memory_utilization[\s\S]*kv_cache_memory_bytes[\s\S]*互斥/);
  assert.match(guide, /队列为空[\s\S]*(?:不改善|不是正确候选)/);
  assert.match(guide, /Prefix Cache[\s\S]*(?:重复前缀|稳定前缀)/);
  assert.match(guide, /CPU offload[\s\S]*不是 tokens\/s 优化/);
});

test("every new instance deployment performs startup-safety sizing before create", () => {
  const skill = read("rainbond-ai-assistant/SKILL.md");
  const deployment = read("rainbond-ai-assistant/references/instance-deployment.md");
  const guide = read("rainbond-ai-assistant/references/parameter-decision-guide.md");

  assert.match(skill, /实例创建[^\n]*parameter decision guide/);
  assert.match(deployment, /startup_safety[\s\S]*rainbond_create_ai_engine_instance/);
  assert.match(deployment, /dynamic_params[^\n]*(?:为空|empty)[^\n]*(?:禁止|不得)/i);
  assert.match(deployment, /模型已由用户指定[^\n]*参数规划[^\n]*(?:不能|不得)[^\n]*跳过/);
  assert.match(guide, /模型最大上下文[^\n]*(?:不能|不得)[^\n]*(?:直接|盲目)/);
  assert.match(guide, /权重[^\n]*显存[^\n]*(?:不能|不得)[^\n]*(?:充足|可部署)/);
});

test("startup-safety planning respects HAMi allocation and multimodal bounds", () => {
  const deployment = read("rainbond-ai-assistant/references/instance-deployment.md");

  assert.match(deployment, /hami_ready[^\n]*(?:不等于|不能证明)[^\n]*24\s*GB/i);
  assert.match(deployment, /hami_shared_auto[^\n]*memory_mib_per_gpu/);
  assert.match(deployment, /multimodal|多模态/);
  assert.match(deployment, /max_model_len/);
  assert.match(deployment, /missing_evidence/);
});

test("plugin result contract distinguishes accepted installation from RUNNING", () => {
  const contract = read("rainbond-platform-plugin-manager/references/output-contract.md");
  assert.match(contract, /accepted.*不等于.*RUNNING/i);
  assert.match(contract, /installed=true[\s\S]*status=RUNNING/i);
  assert.match(contract, /unavailable.*(?:不是|不等于).*未安装/i);
  assert.match(contract, /下次唤醒后查询/);
});

test("model discovery falls back to bounded official ModelScope OpenAPI metadata", () => {
  const discovery = read("rainbond-ai-assistant/references/model-discovery.md");
  assert.match(discovery, /https:\/\/modelscope\.cn\/openapi\/v1/);
  assert.match(discovery, /\/models\?search=/);
  assert.match(discovery, /params[\s\S]*file_size/);
  assert.match(discovery, /modelscope_model=owner\/repo/);
  assert.match(discovery, /不伪造 `catalog_model_id`/);
});

test("model download translates identifiers without schema-probing writes", () => {
  const discovery = read("rainbond-ai-assistant/references/model-discovery.md");
  const download = read("rainbond-ai-assistant/references/model-download.md");

  assert.match(discovery, /modelscope:owner\/repo[\s\S]*owner[\s\S]*repo_name/);
  assert.match(download, /model_key[^\n]*(?:只用于|仅用于)[^\n]*(?:团队模型|下载状态)/);
  assert.match(download, /catalog detail[^\n]*owner[^\n]*repo_name/i);
  assert.match(download, /内置目录[^\n]*catalog_model_id[^\n]*model_id/);
  assert.match(download, /OpenAPI[^\n]*modelscope_model[^\n]*owner\/repo/);
  assert.match(download, /字段不确定[^\n]*describe[^\n]*(?:首次调用|调用前)/);
  assert.match(download, /禁止[^\n]*(?:写调用|create)[^\n]*(?:探测|试探)[^\n]*(?:Schema|字段)/i);
});

test("model download omits unsafe optional display names and classifies expected 404s", () => {
  const download = read("rainbond-ai-assistant/references/model-download.md");

  assert.match(download, /display_name[^\n]*默认省略/);
  assert.match(download, /display_name[^\n]*(?:ASCII|非 ASCII)[^\n]*(?:不提交|禁止)/);
  assert.match(download, /team_model_not_found[^\n]*(?:正常|未下载)/);
  assert.match(download, /model_download_not_found[^\n]*(?:正常|没有活动下载|未下载)/);
  assert.match(download, /Latin-1[^\n]*查询[^\n]*真实状态[^\n]*重试/);
});
