# 平台插件生命周期

## 长任务监测方式

在发起安装或升级写操作前，先让用户选择：

1. **持续监测**：受理后按服务端建议间隔轮询到真实终态，只在状态/阶段变化时向用户更新。宿主硬超时或可操作 blocker 仍可停止，但必须保留当前真实状态和标识符。
2. **受理后结束**：写请求返回 accepted 和 `plugin_id/app_id` 后不启动周期轮询，立即报告仍未 ready，然后结束当前回合。用户下次唤醒或要求查询时，按原 `plugin_id/app_id` 只读真实状态，不重放 install/upgrade；仍在运行时报告本次查询结果并再次结束，除非用户改选持续监测。

可将监测方式与安全摘要/审批同一次询问。用户已说“一直看到完成”或“发起后就行”等可确定意图时不再重复询问。只有写入返回未知结果时，可在“受理后结束”模式下做一次精确状态读取以确认是否已受理；这不是周期轮询。

## 安装

1. 先按 [plugin discovery](plugin-discovery.md) 精确确认 absent。
2. 展示安全摘要：目标插件 ID、区域、风险和影响；经当前宿主原生审批后调用一次 `rainbond_install_platform_plugin`。
3. 结果中的 accepted/team/app 仅是受理事实。持续监测模式按服务端建议或 3～5 秒间隔调用 `rainbond_list_platform_plugins`；受理后结束模式不启动周期轮询。
4. 只有 `installed=true && status=RUNNING` 才报告 ready。到达失败/不可用或轮询上限时停止并报告当前事实。

## 升级

从列表取得目标的可信 `team_name` 和 `app_id`，经审批后复用 `rainbond_upgrade_app`。升级后仍以平台插件列表中的应用整体 RUNNING 为终态。

## 卸载

从列表取得可信 `team_name/app_id`，经 destructive 审批后复用 `rainbond_delete_app`。调用后轮询平台插件列表直到 `installed=false`。若结果未知，只查询列表，不重放删除。不得调用不存在的 `rainbond_delete_platform_plugin`。
