# ModelScope 下载

只接受目录模型 ID、`owner/repo` 或 canonical `https://modelscope.cn/models/owner/repo`；后二者规范化为同一身份。拒绝本地路径、文件、上传内容、Git、Hugging Face、任意 URL 和 URL credentials。

Tool 路由：`rainbond_list_ai_engine_team_models`、`rainbond_get_ai_engine_team_model`、`rainbond_get_ai_engine_model_download` 与 `rainbond_get_ai_engine_model_download_logs` 是 read；`rainbond_create_ai_engine_model_download` 是 write。已知字段直接调用，不复制 Tool Schema。

## 标识映射

各 Tool 的模型标识不可互换：

- `model_key=modelscope:owner/repo` 只用于团队模型和下载状态查询。
- Catalog detail 使用 `owner=<owner>` 与 `repo_name=<repo>`；不得传 `model_key`。
- 内置目录精确命中后，下载创建使用 `catalog_model_id=<catalog detail 返回的 model_id>`；不得从名称猜造。
- 官方 ModelScope OpenAPI 补查得到的非目录模型，下载创建使用 `modelscope_model=owner/repo`；不得伪装成 `catalog_model_id`。
- `rainbond_create_ai_engine_model_download` 不接受 `model_key`。字段不确定时必须 describe 单个 Tool，并在首次调用前确定输入；禁止用写调用试探 Schema 或字段组合。

`display_name` 是可选字段，默认省略并沿用目录/模型名称。当前链路对非 ASCII `display_name` 存在 Latin-1 编码失败风险，因此非 ASCII 值不提交；用户明确要求自定义名称时，仅在值为安全 ASCII 后传递，否则说明本次沿用模型默认名称。

1. 创建前用团队模型与下载查询检查相同 model key 的 `downloading/ready/deleting/failed`。`team_model_not_found` 是正常的未下载证据；`model_download_not_found` 是正常的没有活动下载任务证据。两者不是平台故障，也不需要重复 list 全部团队模型确认。
2. downloading 返回原任务；ready 且 verified 返回已存在；deleting 停止；failed 只有用户明确确认 retry 才重新创建。
3. 写入前确认长任务监测方式：“持续监测”或“受理后结束，待下次唤醒再查询”。可与审批同一次询问；用户已表达可确定偏好时不重复询问。
4. 审批后只调用一次 `rainbond_create_ai_engine_model_download`。
5. 持续监测时，按 `poll_after_seconds` 或 5～10 秒查询到业务终态，只在 progress/stage 变化时更新用户。活动 download 404/消失时立即按 model key 查询 `rainbond_get_ai_engine_team_model`。
6. 受理后结束时，取得 `job_name/model_key` 后不启动周期轮询，报告当前仍未 ready 并结束当前回合。下次唤醒时按原标识符只读状态，不重放 create；仍在下载时报告本次结果并结束，除非用户改选持续监测。只有 create 结果未知时可做一次精确读取确认是否受理。
7. 只有团队模型 `status=ready`、registry/metadata verified 且 SHA256 一致才完成。99%/100% 或 Job complete 仍不是完成；持续监测模式继续等待。
8. failed 时读取有界下载日志，仅摘要最新 progress/metadata/error；未经新确认不重试。

## 输入失败处理

- CLI 在生成 confirmation ID 前返回 `$input must match exactly one allowed schema`，表示写操作尚未执行。describe 单个 Tool 后只纠正一次输入，不查询资源残留，也不枚举 Catalog。
- 已取得 confirmation ID 并执行后返回 Latin-1 或其他明确 4xx 时，先按 canonical `model_key` 查询下载任务和团队模型真实状态；确认未创建后，移除可选 `display_name` 或改用安全 ASCII，再作为新输入取得新的 confirmation ID 后重试。不得复用旧 confirmation ID。
