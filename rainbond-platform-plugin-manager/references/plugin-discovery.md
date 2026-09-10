# 平台插件发现

进入查询、选择或安装前检查阶段时读取本文件。

1. 调用 `rainbond_list_platform_plugins`，使用已解析的 `region_name`，按目标 `plugin_id` 精确匹配。
2. `installed_state`、市场或 Region 状态不可用时停止，保留 `unavailable_reason`；不得把空集合或异常解释为未安装。
3. `installed=true && status=RUNNING` 表示已就绪，不调用 install。
4. `installed=true` 但非 RUNNING 时进入生命周期轮询；不要依据低层工作负载或静态资源自行判定。
5. 只有明确 `installed=false`/absent 才准备安装。版本、架构、License 和可安装性以 Console 返回事实为准，不在 Skill 复制市场规则。

通用平台插件的发现逻辑不能硬编码 AI Engine。只在用户的原始模型任务需要时，把 `rainbond-ai-engine` 作为目标插件 ID。

