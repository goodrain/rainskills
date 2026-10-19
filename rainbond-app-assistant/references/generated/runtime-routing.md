<!-- generated-by: scripts/sync-runtime-contracts.mjs -->
<!-- source-sha256: 4fd42b6dcd68b5f6911a42451bdd528f62f435f9889a2518a7b93ec6f9c8a820 -->
<!-- profile: cli -->
<!-- rainskills-runtime-routing:start -->
# 缺少运行环境时（生成文件）

- `skill_id`: `rainbond-app-assistant`
- `missing_runtime_mode`: `new_application`
- `resume_target`: `project-deployment`

意图不明确时，只问用户是在部署新应用还是管理已有应用；确认前不连接运行环境，也不展示选项。

仅当 `runtime status --json` 明确返回 `state=not_started` 且 `usable=false` 时进入本路由。只有当前本地项目且目录可读取时才读取 [local project analysis](../local-project-analysis.md)，完成只读分析并输出“已识别”和“预计交付结果”；不得写项目文件、联网或调用 Rainbond。
裸 Git URL、镜像引用、软件包或归档文件必须跳过本地预分析，直接进入后续环境选择；市场模板和第三方开源套件由各自所属 Skill 处理，也不得在此触发预分析。

`state=connected` 且 `usable=true` 时直接恢复 `project-deployment`，不得执行本地预分析，也不得展示环境菜单。版本错配、状态命令失败、连接中或已有环境但 live probe 失败时按 Runtime Gate 修复或停止，不得当作没有运行环境。

完成上述可选分析后，执行固定 launcher 的 `runtime message --id new-application-environment`，只原样转发消息 marker 之间的正文。然后只显示：

1) Rainbond Cloud云端环境（推荐）——最快体验，不需要准备服务器
2) 独立服务器——适合长期运行，在你的服务器上安装开源 Rainbond
3) 本机环境——适合本地验证，在当前电脑上准备运行环境
4) 已有 Rainbond——连接现有 Rainbond 环境并继续部署

选择 Rainbond Cloud 云端环境时连接 Rainbond Cloud；选择独立服务器时使用 `--install-private --location server`；选择本机环境时使用 `--install-private --location local`；选择已有 Rainbond 时先执行 `runtime message --id private-console-origin`，再连接用户给出的 Console origin。不得增加私有环境子菜单。

连接和 live probe 成功后恢复到 `project-deployment`；不得提前询问无关业务字段，也不得保存环境 ID、operation ID 或 intent JSON。

<!-- rainskills-runtime-routing:end -->
