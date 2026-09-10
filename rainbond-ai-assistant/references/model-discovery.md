# 模型发现与推荐

1. 先读 `rainbond_get_ai_engine_capabilities` 与 `rainbond_get_ai_engine_resource_capacity`。
   - 机器是否有 GPU、架构、CPU/内存容量由 Tool 获取；必要时补设备与 binding 查询。计算方式由资源、模型兼容性和用户用途共同决定，不把“是否有 GPU，还是用 CPU”作为开场问题。资源不可观测时保留原因，不把用户猜测作为容量依据。
   - 用途未知时先用开放式问题了解业务，不展开任务类型菜单。只有当前运行时、候选模型与创建接口均有支持证据时，才用具体任务作示例。远程目录出现 OCR、语音识别等标签不表示平台可创建相应实例；未经验证不能把这些能力作为可选项。用户明确提出时检查兼容链和接口缺口，而非直接承诺支持或永久判为不支持。
2. 用户明确模型时用 `rainbond_search_ai_engine_model_catalog` 精确搜索，命中后再用 `rainbond_get_ai_engine_model_catalog_detail` 读取结构化元数据，不加载 README。推荐或状态结果中的 `model_key=modelscope:owner/repo` 先确定性拆分；Catalog detail 的输入是 `owner` 与 `repo_name`，不是 `model_key`。若任一字段名仍不确定，在首次业务调用前只 describe 该 Tool；禁止先发错误 read/write 试探 Schema。
3. 内置目录没有与用户名称或 `owner/repo` 精确匹配的项时，必须继续使用官方 `https://modelscope.cn/openapi/v1` 公开只读 OpenAPI 补查，不得直接宣称模型不存在，也不得凭记忆改成其他模型：
   - 只有名称时，请求 `GET /models?search=<URL-encoded>&page_number=1&page_size=20`，最多读取两页；使用 `id`、`display_name` 和 repo 名做大小写不敏感的精确匹配。官方 owner 与同名社区镜像并存时优先官方 owner；仍有多个无法判定的精确候选时让用户选择。
   - 已得到 `owner/repo` 后，请求 `GET /models/<URL-encoded-owner>/<URL-encoded-repo>` 补齐 `params`、`file_size`、`tasks`、`tags`、`private`、`gated` 等对应参数。
   - 只允许官方 HTTPS origin 和无凭据 GET；不向用户索取 ModelScope Token，不跟随跨 origin 跳转，不加载 README 或仓库文件。`401/403`、private/gated、`429`、`5xx` 或超时时把该来源标记为 unavailable/unknown，不改用 HTML 抓取或估算补值。
   - OpenAPI 结果是“ModelScope 远程元数据”，不是 Rainbond 内置目录或已验证部署兼容性。说明来源与查询时间；下载时传 `modelscope_model=owner/repo`，不伪造 `catalog_model_id`。
4. 用户要求推荐时优先消费 `rainbond_list_ai_engine_model_recommendations`；必要时补设备/binding 事实。
5. 返回 1～3 个候选，说明 compute mode、资源依据、质量/速度/上下文取舍、风险与置信度。
6. `params/file_size` 是远程仓库声明，不等于实际显存占用。服务端资源或 metadata 缺失时标记 `caution`，不得在 Skill 中重建参数量到显存的权威算法或补造精确容量。

当前项目、本地目录、源码 Git URL 即使包含 AI 字样，也属于普通应用部署，不属于本 Skill。
