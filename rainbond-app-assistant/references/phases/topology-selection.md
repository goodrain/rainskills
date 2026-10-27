# topology-selection

37. **组件创建方式智能推断（image vs source vs complex suite）**：本规则只处理已经由 App Assistant 静态归属的请求。若用户明确要求部署 Harbor、Dify、n8n 等第三方开源套件且没有当前/本地项目或普通源码仓库信号，必须在 Runtime Gate 前转到 `rainbond-opensource-app-deploy`，不得在本规则内继续。留在本 Skill 的请求根据用户消息自动推断创建方式，不要停下来问"用镜像还是源码？"。

    推断信号优先级（从强到弱）：
    - 用户提到 Git URL / 分支 / commit / `subdirectories` → **source 模式**
    - 用户提到 image tag / registry 路径（如 `<name>:<tag>`、`docker.io/...`、`harbor.../...`）→ **image 模式**
    - 用户只说组件名，且该名指向**简单单镜像基础设施软件**（数据库、消息队列、缓存、对象存储、Web 服务器、反向代理/负载均衡、注册中心、密钥管理等类别下被广泛使用、有官方/社区维护镜像，且通常一个主容器即可形成最小可运行服务的项目）→ **image 模式**，默认镜像名 `<name>:latest`（再经 Iron Law 6 代理改写）。这里用你自己的通用知识判断，**不要**等清单或穷举匹配。
    - 当前/本地项目或普通源码仓库被识别为**复杂现成软件套件 / 多服务发行版** → **local complex suite 模式**：读取项目画像中的 `docker-compose` / compose profile、`rainbond.app.json` 或用户仓库内描述符；证据缺失前禁止创建组件。不要把本地项目重新路由为上游开源套件，也不要静默改成市场模板。

      **证据仲裁（complex suite 门槛何时已满足）**：当 `rainbond_get_project_source_profile` 已经返回 compose / manifest 拓扑证据（`topologySource == "compose"`、含服务清单的 `rainbond.app.json` 或官方描述符）时，complex suite 的证据门槛**就已满足**——这份画像本身就是权威拓扑来源。此时**禁止**再以"去找更可靠的证据"为名跳去查 `rainbond_query_local_app_models` / `rainbond_query_cloud_markets` / `rainbond_query_cloud_app_models` 等模板库，更不允许把"找到了同名模板"升格成默认部署路径。尤其当用户消息里**显式给了 Git URL** 时，按 Iron Law 38 把本轮路径锁定为源码 / compose 画像路径，应用市场模板至多作为一句建议提及，不得安装。
    - 用户只说组件名，且该名是项目专属或来历不明（如 `my-api`、`order-service`、`payment-svc` 等业务命名风格） → 信号不足，**这时才**问"用镜像还是源码？"

    判断标准（principle 而非清单）：
    - 在你的知识里，这个名字是不是**一个有公开镜像、单主服务可运行的成熟基础设施软件**？是 → image。
    - 这个名字是不是**一个产品套件**，通常由多个互相依赖的组件组成，且 service list / depends_on / env / storage / external_url / TLS 这些字段需要官方描述符才能可靠？是 → complex suite，先要证据或用户确认。
    - 这个名字是不是**业务领域命名风格**（含动词、含组织名、含具体业务概念）？是 → 问。
    - 介于两者之间不确定？**优先按 image 默认**（更常见的部署方式）并在报告里告知推断理由，邀请用户覆盖。

    自动推断的结果必须在最终报告里说明，例如："已按 image 模式创建 clickhouse 组件（推断依据：该名为公认的列式分析数据库）。如需改用源码请告知。"
    对 local complex suite 的报告必须说明缺失的项目内拓扑证据；如果画像已返回 compose/manifest 证据，门槛即已满足，按该用户项目证据继续，不要查找或安装同名市场模板。

    **禁止行为**：
    - 用户给了 git_url 还问"用镜像还是源码？"（信号已经明确）
    - 用户给了 image tag 还问"用镜像还是源码？"（信号已经明确）
    - 对一个你的训练知识里明显是基础设施软件的名字（不管是否在某个示例清单里）问"用镜像还是源码？" —— Nginx、Redis、ClickHouse、Jaeger、Loki、OpenTelemetry Collector 都属于这一类，未来出现的新项目也会属于这一类，用判断不要用穷举
    - 把明确的第三方开源套件部署留在 App Assistant，而不是在 Runtime Gate 前转到 `rainbond-opensource-app-deploy`
    - 对当前/本地 complex suite 项目，在没有 compose profile、`rainbond.app.json` 或仓库内描述符时，凭通用知识创建多个组件、依赖、env、存储或端口
    - 已经拿到 compose / manifest 画像证据（门槛已满足）时，还以"找更可靠证据"为由去查模板库（`rainbond_query_local_app_models` / `rainbond_query_cloud_app_models`），或把找到的同名模板当默认路径——尤其用户已显式给了 Git URL 时（违反证据仲裁与 Iron Law 38）

    **stateful 服务的持久化要求**：当推断结果是 image 模式 **且** 该服务属于 stateful 范畴（数据库 / 持久化消息队列 / 搜索引擎 / 时序库 / 对象存储 / 向量库 / 图库等 — 数据必须跨重启存活的任何服务），**必须**在 deploy 之前配好持久化。

    **平台现实（fact）**：`rainbond_create_component_from_image` 和 `rainbond_create_component_from_source` 都不暴露 `extend_method` 参数，平台也没有 stateless→stateful 的转换工具。所以镜像/源码模式创建的组件**必然是 stateless**。不要尝试创建后再"改成 stateful"，做不到。

    **持久化方案**：
    1. 用 `rainbond_manage_component_storage(operation=create_volume, volume_type=share-file, volume_path=<官方数据目录>)` 在服务的数据目录挂 RWX 共享文件存储（stateless 组件能挂）
    2. 然后应用配置：**首次部署**用 `rainbond_operate_app(action=deploy)`；组件**已在运行时**只改存储/配置要用 `action=upgrade`（deploy 会重新构建，upgrade 只做滚动更新）— 顺序不能反
    3. **禁止**用 `volume_type=local`（local 强制要求 stateful，平台会 HTTP 400 拒绝）

    **需要 stateful + local volume（高 IOPS 数据库）的唯一路径**：通过 `rainbond_install_app_model` 从应用市场安装预配置的 stateful 模板。镜像/源码模式做不到这件事，不要假装能做。

    具体的官方数据目录清单、`volume_type` 兼容矩阵、识别 stateful 服务的范畴边界详见 bootstrap skill 的 `modules/30-creation-rules.md § 5`。stateful 服务用 image 模式部署却没配持久化是真实回归 bug（pod 重启数据丢失），禁止以"模型不知道这个 service 是 stateful"或"工具不支持 extend_method"为由跳过持久化步骤。
