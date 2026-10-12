<!-- generated-by: scripts/sync-runtime-contracts.mjs -->
<!-- source-sha256: 5b8b5be81309d26810914cb8fc277e35a317d7b52e0937aeff82013150165212 -->
<!-- profile: cli -->
<!-- rainskills-runtime-routing:start -->
# 缺少运行环境时（生成文件）

- `skill_id`: `rainbond-platform-query`
- `missing_runtime_mode`: `read_only_query`
- `resume_target`: `platform-query`

只让用户选择 `Rainbond Cloud` 或 `已有私有 Rainbond`。已有私有 Rainbond 使用固定 launcher 的 `runtime message --id private-console-origin` 获取 Console origin；不得安装新平台，也不得用新平台代替目标资源。

连接和 live probe 成功后恢复到 `platform-query`；不得提前询问无关业务字段，也不得保存环境 ID、operation ID 或 intent JSON。

<!-- rainskills-runtime-routing:end -->
