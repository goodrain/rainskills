<!-- generated-by: scripts/sync-runtime-contracts.mjs -->
<!-- source-sha256: 9852cc2ebca3db288d065f6f7bd50cfc9f4b2d378657105266e1b002d2cef5fa -->
<!-- profile: cli -->
<!-- rainskills-runtime-routing:start -->
# 缺少运行环境时（生成文件）

- `skill_id`: `rainbond-ai-assistant`
- `missing_runtime_mode`: `ai_workload`
- `resume_target`: `ai-engine-intent`

只让用户选择 `Rainbond Cloud` 或 `已有私有 Rainbond`。已有私有 Rainbond 使用固定 launcher 的 `runtime message --id private-console-origin` 获取 Console origin；不得安装新平台，也不得用新平台代替目标资源。

连接和 live probe 成功后恢复到 `ai-engine-intent`；不得提前询问无关业务字段，也不得保存环境 ID、operation ID 或 intent JSON。

<!-- rainskills-runtime-routing:end -->
