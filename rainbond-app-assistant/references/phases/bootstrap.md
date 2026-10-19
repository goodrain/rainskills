# bootstrap

20. **组件依赖与连接变量管理**（合并自原 20-23 四条）：多组件拓扑里，provider/consumer 关系必须用显式依赖 + provider 侧连接变量管理，不要让 consumer 端硬编码或重复声明。

    **可执行工具（fact）**：
    - 显式依赖：`rainbond_manage_component_dependency` — 不要回答"没有依赖接口"；调用失败时按 Rainbond Tool / 控制面真实错误报告，不要描述为工具不存在
    - Provider 连接变量：`rainbond_manage_component_connection_envs(scope=outer)` — 这是 provider 暴露给 consumer 的接口面
    - Consumer 自身的本地 env：`rainbond_manage_component_envs` — 仅放该 consumer 真正本地的值

    **判断顺序（principle）**：
    - 拓扑里出现 provider/consumer 关系（`depends_on`、反向代理链路、运行时日志暴露的连接错误）→ 用 `rainbond_manage_component_dependency` 建显式依赖
    - 共享连接信息（数据库连接串、缓存地址、消息队列 broker 等任何"provider 拥有的连接 fact"）→ 配在 provider 的 connection envs 上，**不要**在每个 consumer 上重复写
    - 运行时报 `connection refused` / `ENOTFOUND <provider-name>` / 错 host / 错 port / 缺密码等连接类错误 → 先看 provider connection env / dependency alias / compatibility env，**不要**把 baseline 里的硬编码主机名当成事实
    - 多组件拓扑进入交付验收前 → 必须跑一遍依赖完整性 gate（列已接受边 → 查现有依赖 → 补齐缺失 → 再次验证依赖摘要）。手工创建镜像组件、Compose fallback 路径、组件能独立启动都**不能**跳过 gate
    - **配置覆盖 gate（backend 组件，设完 env 后、宣布健康/可交付前必跑）**：从 `rainbond_get_component_summary` 枚举该组件挂载的 config-file 卷。若有卷挂到已知配置路径（`config.yml` / `application.yml` / `application.properties` / `.env` / `nginx.conf` / `*.conf`），运行态有效配置由该文件决定而非 env（mounted config-file > env > 镜像默认值）。这时必须警告"env 可能被挂载的配置文件覆盖"，并先确认该文件反映了预期值，再宣布交付健康。比较配置值用于该 gate 是允许的，但**禁止**回显原始文件内容或密钥明文，只报结构化不一致。文件内容无法用当前 Rainbond Tool catalog 读取时，显式标注覆盖风险并停下来让用户确认，不要默默改 env 就当成功

    具体的 provider 命名约定、connection env 变量名（`DB_*` / `REDIS_*` / `KAFKA_*` 等是示例，按 provider 文档实际名字为准）、以及依赖 alias 细节，详见 bootstrap modules/30-creation-rules.md 的相关章节。
