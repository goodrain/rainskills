# RainSkills 全量 Skill 审核与 Console 交叉验证优化计划

> 状态：待实施
>
> 基线日期：2026-08-17
>
> 基线版本：RainSkills `ef85cb2`；rainbond-console `ebae71d7c`（`agent-dev-8.17`）；rainbond-agent `e04b814`（`main-7.9`）
>
> 核心原则：**不改变现有部署主流程，只修正文档与真实 Tool 契约的偏差、缩短简单请求的决策链，并建立 RainSkills → rainbond-agent 的可验证生成链。任何 Skill 修改必须同时给出权威实现依据、契约测试和生成产物验证。**

## 1. 背景与目标

用户在 Codex CLI 中提出“帮我查询当前企业的信息”后，执行链出现了以下不必要步骤：加载部署主 Skill、枚举工具、尝试错误的 CLI 调用格式、在网络失败后切换思路，并继续考虑与企业信息无关的团队和集群查询。该现象不是单一提示词问题，而是以下因素共同造成：

1. 当前没有专门承接平台只读查询的轻量 Skill，模型容易误选 1300 行以上的 `rainbond-app-assistant`。
2. 部分 Skill 未直接声明稳定 Tool 契约，促使模型执行 `list`、`describe` 或猜测工具名。
3. 少量现有 Skill 文本已与 rainbond-console 的真实工具名、参数可选性和状态转换逻辑发生偏移。
4. RainSkills 源仓库与 rainbond-agent 的 embedded vendor 副本通过生成同步，但 Agent 当前记录的 source revision 落后于 RainSkills HEAD；直接手改 Agent 副本会在下次同步时丢失。
5. 多个 Skill 引用仓库级 `docs/product-object-model.md`，但 npm 包没有包含 `docs/`，安装后的相对引用不可靠。

本计划目标：

- 审核仓库中全部顶层 Skill，给出保留、修正、拆分或新增建议。
- 每个业务语义修改都与 rainbond-console 的实现、Tool Schema 和测试相互印证。
- 不改变 `rainbond-app-assistant → project-init → bootstrap → troubleshooter → delivery` 主流程及既有停止条件。
- 为简单只读查询提供固定、短路径，避免无意义的 Tool 探索。
- 明确 RainSkills 是 Skill 业务文本的源，rainbond-agent 的 `skills-src/rainbond` 是生成产物。
- 建立可自动执行的静态契约、路由、打包、行为评估和 Agent 同步验证。

非目标：

- 不在本计划中新增或重命名 rainbond-console MCP Tool。
- 不改变 Console RBAC、企业管理员可见性或认证机制。
- 不把 rainbond-agent 改为本机 CLI 调用模式。
- 不在缺乏 Console 或运行环境证据时修改镜像/Git 代理规则。
- 不直接清理用户本机遗留的 `rainbond-app-upgrade-assistant`、`rainbond-docker-compose-assistant`。

## 2. 仓库责任与验证基线

### 2.1 代码位置约定

| 标识 | 仓库根目录 | 责任 |
|---|---|---|
| `rainskills/` | `/Users/guox/Desktop/Project/rainskills` | Skill 唯一业务源、CLI profile、评估、安装和打包 |
| `rainbond-console/` | `/Users/guox/Desktop/Project/rainbond-console` | Tool 名称、参数 Schema、权限、返回结构和业务实现的权威来源 |
| `rainbond-agent/` | `/Users/guox/Desktop/Project/rainbond-agent` | embedded profile 的生成副本、会话 Tool 执行与服务端发布 |

本文行号基于上方基线提交。实施前必须用 `rg -n` 重新定位符号；符号和测试名是稳定锚点，行号仅用于快速审阅。

### 2.2 每项修改的四联验证

每个工作项必须同时填写并通过以下证据，缺一不可：

| 证据 | 要求 |
|---|---|
| RainSkills 修改点 | 明确到 `SKILL.md`、module、schema、eval 或测试文件 |
| Console 权威依据 | 指向 Tool dispatcher、输入 Schema、业务实现和对应测试；若 Console 不负责，明确标记 `N/A` |
| Agent 影响范围 | 指向生成副本或 runtime normalization；禁止直接手改 vendor 文本 |
| 自动验证 | 至少一个失败前可复现、修改后通过的契约测试或行为评估 |

决策门：

1. Console 实现、Schema、测试三者一致时，Skill 向 Console 对齐。
2. 三者不一致时，先在 Console 仓库补充回归测试并确定权威行为，再修改 Skill。
3. 仅涉及 Skill 路由、文档体积或 npm 打包时，Console 标记 `N/A`，使用安装产物和路由评估验证。
4. Agent 中只修改同步器、运行时边界测试或由构建器生成的 vendor；业务文本先改 RainSkills。

## 3. 全量 Skill 审核结论

| Skill | 当前判断 | 本轮动作 | Console 辅助验证 |
|---|---|---|---|
| 根 `SKILL.md` | 安装/入门入口，职责合理 | 保留；补充新查询 Skill 的套件说明和完整安装校验 | N/A，验证 npm/安装产物 |
| `rainbond-app-assistant` | 主路由正确，但 1309 行、简单查询易误触发 | 不改主体阶段流；收窄描述，补只读查询分流；拆出详细示例和映射 | Tool 可见性、健康概览、失败上下文 |
| `rainbond-app-version-assistant` | 流程正确，示例中有错误 Tool 名 | 修正发布工具名及 `app_id` 示例 | submit share dispatcher/schema/test |
| `rainbond-delivery-verifier` | 最终验证职责合理，但缺少固定工具表 | 增加健康概览快速路径和精确 Tool 契约 | app health overview/schema/test |
| `rainbond-env-sync` | 同步边界合理，但缺少固定工具表 | 增加 env summary 与冲突分析快速路径 | env/connection env/conflict analyzer |
| `rainbond-fullstack-bootstrap` | 主文件较短，module 中存在依赖工具和构建策略偏差 | 修正工具名；按状态区分 CNB/Dockerfile 恢复；模块按需读取 | dependency、check result、build source |
| `rainbond-fullstack-troubleshooter` | 861 行；storage 参数与分类 schema 漂移 | 修正参数；统一分类；拆出详细诊断规则；接入聚合诊断 | storage、failure classifier、failure context |
| `rainbond-platform-installer` | 42 行，触发边界清晰 | 保留，仅参与安装完整性回归 | N/A |
| `rainbond-project-init` | 992 行，工具选择不够直接 | 保留初始化语义；补固定只读/创建工具表；拆分示例 | teams/regions/apps/create app schemas |
| `rainbond-template-installer` | 流程基本一致，示例 ID 类型偏移 | 仅修正 ID 契约和共享模型引用 | app/tool schema |
| 新增 `rainbond-platform-query` | 当前缺失 | 新建轻量只读查询 Skill，不接管部署主线 | current user、enterprise 和管理员可见性 |

## 4. 实施顺序与工作包

工作包必须按 `WP0 → WP1/WP2/WP3 → WP4/WP5 → WP6/WP7 → WP8` 执行。WP1、WP2、WP3 在契约测试框架完成后可以独立开发；WP8 只能在全部源仓库验证通过后执行。

### WP0：建立 Console 契约清单与失败优先的测试护栏

目标：在改 Skill 文本前，让当前已知偏差能够由测试稳定检出。

RainSkills 修改位置：

- 新增 `tests/skill-console-contract.test.js`：维护本计划涉及的固定 Tool 名、禁用旧名、必需参数和可选参数断言。
- 扩展 `tests/transport-resolution.test.js:237`：已知意图必须直接调用固定 Tool，不得建议先 `list`/`describe`。
- 扩展 `tests/skill-routing-fixtures.yaml:1`：增加企业、当前用户、团队、集群、应用和组件查询意图。
- 扩展 `tests/skill-profile-builder.test.js:1`：所有 embedded Skill 的正文契约与源一致，且不含 CLI-only 标记。
- 新增 `tests/markdown-link-integrity.test.js`：分别验证源码树、npm pack 清单和 embedded profile 中的相对链接。

Console 权威位置：

- 工具目录与 dispatch：`rainbond-console/console/services/mcp_query_service.py:300-600`
- 当前用户与工具可见性测试：`rainbond-console/console/tests/mcp_query_service_test.py:92`、`:210`、`:328`
- 各具体工具位置见 WP1-WP5。

Agent 影响位置：

- `rainbond-agent/scripts/sync-rainbond-skills.mjs`
- `rainbond-agent/skills-src/rainbond/rainskills-profile.json`
- `rainbond-agent/skills-src/rainbond/**`（生成物）

辅助验证：

```bash
node --test tests/skill-console-contract.test.js
node --test tests/transport-resolution.test.js
node --test tests/skill-profile-builder.test.js
node --test tests/markdown-link-integrity.test.js
```

验收标准：当前错误工具名、不可安装链接和查询错误路由至少各有一个先失败的断言；测试不能依赖实时 255 环境。

### WP1：修正三个已确认的 Console 契约偏差

#### WP1.1 应用版本发布工具名

| 类型 | 代码位置 |
|---|---|
| RainSkills 修改 | `rainbond-app-version-assistant/SKILL.md:340`、`:354`、`:384`，将不存在的 `rainbond_submit_app_share` 统一为 `rainbond_submit_app_share_info` |
| 同文件正确依据 | `rainbond-app-version-assistant/SKILL.md:88`、`:210` 已使用正确名称 |
| Console dispatch/schema | `rainbond-console/console/services/mcp_query_service.py:350-600`；`_tool_submit_app_share_info` 位于 `:7073`，参数为 `team_name`、`region_name`、`share_id`、`app_version_info` |
| Console 测试 | `rainbond-console/console/tests/mcp_query_service_test.py:4428` 的 `test_submit_app_share_info_calls_share_service` |
| Agent 生成副本 | `rainbond-agent/skills-src/rainbond/rainbond-app-version-assistant/SKILL.md:354`、`:368`、`:398` |

验证：契约测试必须断言全部源文件和 embedded 产物中不存在完整词 `rainbond_submit_app_share`，并断言正确工具所需参数均被发布步骤覆盖。

#### WP1.2 组件依赖查询工具

| 类型 | 代码位置 |
|---|---|
| RainSkills 修改 | `rainbond-fullstack-bootstrap/modules/40-source-and-package-rules.md:164`，将 `rainbond_query_component_dependencies` 改为 `rainbond_manage_component_dependency(operation=summary)` |
| Console 实现/schema | `rainbond-console/console/services/mcp_query_service.py:2572`；`_tool_manage_component_dependency` 位于 `:8278`，`summary` 返回正向、反向和可选依赖 |
| Console 测试 | `rainbond-console/console/tests/mcp_query_service_test.py:2069` |
| Agent 生成副本 | `rainbond-agent/skills-src/rainbond/rainbond-fullstack-bootstrap/modules/40-source-and-package-rules.md:164` |

验证：新增依赖 diff 评估，给定已连接边时只能调用一次 `summary`，不能调用不存在的 query 工具，也不能重复创建已有边。

#### WP1.3 存储更新参数可选性

| 类型 | 代码位置 |
|---|---|
| RainSkills 修改 | `rainbond-fullstack-troubleshooter/SKILL.md:538`，将“路径不变也必须传 `new_volume_path`”改为“路径不变时省略；重存配置文件内容必须传 `new_file_content`” |
| Console 实现/schema | `rainbond-console/console/services/mcp_query_service.py:2330`；`_tool_manage_component_storage` 位于 `:8109`，`:8145-8150` 明确路径可选并复用旧值 |
| Console 测试 | `rainbond-console/console/tests/mcp_query_service_test.py:1893` 起的 storage 用例 |
| Agent 生成副本 | `rainbond-agent/skills-src/rainbond/rainbond-fullstack-troubleshooter/SKILL.md:552` |

验证：增加两个 fixture：路径不变时不发送 `new_volume_path`；配置文件修复必须发送 `new_file_content`。若 Console 测试发现省略内容会写成 `None`，先修 Console 并补测试，再启用 Skill 规则。

### WP2：按 Console 状态机修正 CNB/Dockerfile 恢复规则

目标：保持“默认不删除重建”的安全原则，同时承认 Console 对未完成组件和已完成组件的能力边界不同。

RainSkills 修改位置：

- `rainbond-fullstack-bootstrap/modules/40-source-and-package-rules.md:88`：保留删除重建仅用于无法原地切换且用户明确确认的最终分支。
- `rainbond-fullstack-bootstrap/modules/40-source-and-package-rules.md:193-195`：删除“check result 不能重新应用策略”的绝对表述。
- `rainbond-app-assistant/SKILL.md:178-195`：将绝对禁止重建改为分状态决策，不改变其他 Iron Law。
- `rainbond-fullstack-bootstrap/evals/`：新增未完成组件原地选择 Dockerfile、已完成 CNB 组件需确认后重建两组评估。
- `rainbond-app-assistant/evals/`：新增主路由与 bootstrap 恢复规则一致性评估。

Console 辅助验证：

- `rainbond-console/console/services/mcp_query_service.py:4067`：`get_component_check_result`。
- 同文件 `:4075-4080`：读取并复用策略偏好。
- 同文件 `:4097-4113`：`create_status != complete` 时 `_select_service_info` 可持久化所选 Dockerfile。
- `_tool_update_component_build_source` 位于 `:6489`：当前没有通用 `build_strategy/prefer` 参数，不能据此宣称已完成组件可原地切换。
- `rainbond-console/console/services/app_check_service.py:104`：重新检测入口；`:204-205` 说明 `is_again=true` 不重置为 checking。
- 测试：`rainbond-console/console/tests/mcp_query_service_test.py:6380`、`:6438`、`:6495`；`rainbond-console/console/tests/source_component_service_test.py:523`、`:612`、`:751`、`:879`、`:950`。

目标规则：

1. `checking/checked/未完成`：不删除，传入明确构建偏好获取 check result，确认返回的 Dockerfile 证据后继续创建。
2. `complete + CNB`：当前 Tool 无通用原地切换能力；先快照拓扑和配置，向用户说明会重建，再经明确确认执行删除/重建和配置回放。
3. 任何状态证据不完整：停止在只读检查，不猜测、不自动删除。

验收：两种状态 fixture 均通过；所有 destructive 路径必须包含 `create_status=complete` 证据、用户确认和配置快照，未满足时测试必须失败。

### WP3：统一故障分类文本、结构化 Schema 与 Console 分类器

当前偏差：`config_file_configmap_missing` 已出现在排障正文和映射中，但遗漏于结构化示例与 schema 枚举。

RainSkills 修改位置：

- `rainbond-fullstack-troubleshooter/SKILL.md:51`、`:543`、`:600-620`、`:860`
- `rainbond-fullstack-troubleshooter/schemas/troubleshoot-result.schema.yaml:40-54`、`:71-87`
- `rainbond-fullstack-troubleshooter/evals/`：为每个 Console classified reason 增加映射断言，至少新增 ConfigMap 丢失回归。
- `docs/product-object-model.md` 对应 blocker/stop reason 定义；若 WP6 已拆分，则修改拆分后的 canonical reference。

Console 权威位置：

- `rainbond-console/console/services/mcp_failure_classifier.py:16-22`：
  `config_file_configmap_missing`、`volume_mount_failed`、`image_pull_failed`、`crash_loop`、`probe_failed`、`unschedulable`、`k8s_api_rejected`、`unknown`。
- `rainbond-console/console/services/mcp_query_service.py:6410-6424`：失败上下文 Tool 描述。
- `rainbond-console/console/tests/mcp_query_failure_context_test.py`
- `rainbond-console/console/tests/mcp_query_health_overview_test.py`

实现要求：先建立一张显式映射表 `Console classified_reason → Troubleshoot blocker_bucket → stop_reason`。不能只向枚举追加一个值，因为部分 Console 原因需要归并为现有用户态 bucket。

Agent 影响：由 profile builder 同步 schema 和 Skill；Agent 必须保留未知分类的 fallback，不因新增枚举中断执行。

验收：Console 分类器列出的每个值都有唯一映射；`unknown` 始终回退到既有证据链；输出 schema、正文、示例三者枚举一致。

### WP4：新增轻量只读查询 Skill，缩短简单问题链路

新建位置：

- `rainbond-platform-query/SKILL.md`，目标少于 150 行。
- `rainbond-platform-query/agents/openai.yaml`。
- `rainbond-platform-query/evals/`：企业、用户、团队、集群、应用、组件、非管理员六类请求。
- `package.json:24-40` 的 `files`。
- `scripts/build-skill-profile.mjs:8-15` 的 `EMBEDDED_SKILLS`。
- `tests/skill-routing-fixtures.yaml`、`tests/npm-package.test.js:1`、`tests/marketplace-entry.test.js`、`tests/skill-profile-builder.test.js:1`。

固定执行契约：

1. 只承接用户明确提出的 Rainbond 平台只读查询；部署、修改、发布、排障仍路由到现有专项 Skill。
2. 优先使用当前 session 已有 identity；缺失时调用 `rainbond_get_current_user`。
3. 管理员查询当前企业时直接调用 `rainbond_query_enterprises {}`，通过 session `enterprise_id` 匹配当前企业。
4. 非管理员看不到企业/集群管理 Tool 时，返回当前权限范围，不执行 `list`/`describe` 猜测工具。
5. 只有用户明确问团队、集群、应用或组件时，才调用对应查询；查询企业后不自动扩展到团队和集群。
6. CLI profile 继续使用 `rainbond-app-assistant/references/transport-resolution.md:37-54` 的固定 stdin 调用格式，并保持 stdout/stderr 分离。

Console 辅助验证：

- `rainbond-console/console/services/mcp_query_service.py:300-331`：管理员工具可见性。
- 同文件 `:4392`：企业查询实现；`:4771`：管理员校验；`:5693`：企业序列化。
- `_tool_query_enterprises` 位于 `:8361`。
- 企业/集群查询 schemas 位于 `:8361-8400`，团队/应用/组件查询 schemas 位于 `:8566-8612`。
- 测试：`rainbond-console/console/tests/mcp_query_service_test.py:92`、`:210`、`:328`。

Agent 影响：`rainbond-agent/scripts/sync-rainbond-skills.mjs` 从已提交的 RainSkills revision 生成新目录；embedded profile 只调用 session Tool，不包含 `rainskills-tools.js`。

验收：输入“帮我查询当前企业的信息”时，路由只选该 Skill；已知管理员上下文最多执行 identity/enterprise 两个业务 Tool，禁止查询 teams/regions；CLI 调用格式不得再尝试 `call ... '{}'` 或 `read`。

### WP5：使用 Console 已有聚合 Tool 降低排障和交付调用数量

该工作包不改主流程，只把“先逐组件拉取大量明细”改为“聚合摘要优先、异常时再钻取”。

#### WP5.1 应用健康概览

- RainSkills：`rainbond-app-assistant/SKILL.md`、`rainbond-delivery-verifier/SKILL.md`、`rainbond-fullstack-troubleshooter/SKILL.md`。
- Console：`rainbond-console/console/services/mcp_query_service.py:638-687`，schema `:6101`。
- 测试：`rainbond-console/console/tests/mcp_query_health_overview_test.py:66`，catalog 断言 `:133`。
- 规则：先调用 `rainbond_get_app_health_overview`；仅对 abnormal/unknown 组件调用 component summary、日志或事件明细。

#### WP5.2 环境变量冲突分析

- RainSkills：`rainbond-env-sync/SKILL.md`，在实际写入前增加 conflict gate。
- Console：`rainbond-console/console/services/mcp_query_service.py:1011-1068`，schema `:6240`。
- 测试：`rainbond-console/console/tests/mcp_query_env_conflicts_test.py:59`，catalog 断言 `:129`。
- 规则：先 `rainbond_analyze_env_conflicts`；有冲突时停止并展示非敏感键名，不自动覆盖。

#### WP5.3 操作失败上下文

- RainSkills：`rainbond-app-assistant/SKILL.md`、`rainbond-fullstack-troubleshooter/SKILL.md`。
- Console：`rainbond-console/console/services/mcp_query_service.py:1169-1218`，schema `:6412`。
- 测试：`rainbond-console/console/tests/mcp_query_failure_context_test.py:76`，catalog 断言 `:251`。
- 规则：写操作失败后先调用 `rainbond_get_operation_failure_context`，再决定查询、停止或低风险修复；`unknown` 回退现有证据链。
- 安全门：Console 当前脱敏回归覆盖 password/token，但对带业务前缀的秘密键覆盖不足。先在 `mcp_query_failure_context_test.py:198`、`:217` 附近补 `db_password` 等测试并确认脱敏，再允许 Skill 摘要事件尾部；无该验证时 Skill 不得复述 `event_log_tail` 原文。

#### WP5.4 构建等待

- RainSkills：bootstrap/troubleshooter 在触发 build/deploy 后优先使用有界等待，保留现有轮询 fallback。
- Console：`rainbond-console/console/services/mcp_query_service.py:1317`，schema `:6598`。
- 测试：`rainbond-console/console/tests/mcp_query_wait_build_test.py:72`，catalog 断言 `:178`。
- 规则：调用 `rainbond_wait_for_build_completion` 时设置最大调用次数；超时只查询一次最终事实，不盲目重放 build。

固定 Tool 表补充位置：

- `rainbond-delivery-verifier/SKILL.md`：`get_app_detail`、`get_app_health_overview`、`query_components`、异常时 component/storage summary。
- `rainbond-env-sync/SKILL.md`：`query_components`、`manage_component_envs(operation=summary)`、`manage_component_connection_envs(operation=summary)`、`analyze_env_conflicts`。
- `rainbond-project-init/SKILL.md`：`query_teams`、`query_regions`、`query_apps/get_team_apps`、`create_app`。
- Console schemas：`mcp_query_service.py:6084`、`:6101`、`:6119`、`:6145`、`:6258`、`:6313`、`:8361-8400`、`:8566-8612`。

验收：每个常见意图都有“不执行 list/describe”的 fixture；聚合结果正常时调用数下降，异常时仍能进入原有深度排障路径。

### WP6：渐进式拆分长 Skill，并修复共享模型的安装可达性

当前体积：

- `rainbond-app-assistant/SKILL.md`：1309 行。
- `rainbond-project-init/SKILL.md`：992 行。
- `rainbond-fullstack-troubleshooter/SKILL.md`：861 行。
- `docs/product-object-model.md`：1539 行。

拆分原则：顶层 `SKILL.md` 只保留触发边界、硬规则、主流程、停止条件、Tool 快速表和 reference 路由；详细 schema、示例、故障规则移到一层 `references/`。超过 100 行的 reference 增加目录。bootstrap 的 module 从“启动时全部读取”改为按当前阶段读取，但不改变阶段顺序。

共享模型引用当前位于：

- `rainbond-app-assistant/SKILL.md:432`
- `rainbond-app-version-assistant/SKILL.md:28`
- `rainbond-delivery-verifier/SKILL.md:27`
- `rainbond-env-sync/SKILL.md:28`
- `rainbond-fullstack-bootstrap/SKILL.md:32`
- `rainbond-fullstack-troubleshooter/SKILL.md:27`
- `rainbond-project-init/SKILL.md:32`
- `rainbond-template-installer/SKILL.md:30`

打包事实与目标修改：

- `package.json:24-40` 的 `files` 不包含 `docs/`。
- `install.sh:579-615` 的 `copy_skill` 和 `:2385-2406` 的顶层 Skill 发现只复制各 Skill 目录。
- 因此将运行时需要的 canonical 内容拆到可安装目录，例如 `rainbond-app-assistant/references/product-object-model.md` 及按域拆分的 references；仓库 `docs/product-object-model.md` 可保留为设计说明或生成索引，但不能继续作为安装时唯一依赖。
- `scripts/build-skill-profile.mjs` 必须将共享 reference 放入 embedded profile。

Console 辅助验证：N/A。此项只改变信息组织，不改变业务语义。实施前先保存现有 eval 输出，拆分后必须完全等价。

验收：

```bash
npm pack --dry-run
node --test tests/npm-package.test.js tests/markdown-link-integrity.test.js
python3 rainbond-app-assistant/scripts/run_app_assistant_evals.py
python3 rainbond-fullstack-bootstrap/scripts/run_bootstrap_evals.py
```

同时运行 troubleshooter、delivery、project-init 仓库内已有 eval runner（若尚无 runner，先在 WP0 补统一入口）。源码、npm 包、`install.sh --dest` 结果和 embedded profile 中所有 Markdown 链接都必须可解析。

### WP7：统一 `app_id` 的工具边界，避免非数字示例误导调用

已确认事实：Console Tool schema 中 `app_id` 是 integer，但 Agent 的 session/持久化上下文可能把 ID 保存为十进制字符串。不能把所有内部状态字段盲目改成整数，只能约束 Tool 调用边界。

RainSkills 修改位置：

- `rainbond-app-version-assistant/SKILL.md:325`、`:369`
- `rainbond-template-installer/SKILL.md:281`、`:301`、`:321`
- `rainbond-project-init/SKILL.md:763`、`:823`
- `rainbond-app-assistant/SKILL.md:1083`、`:1124`、`:1146` 及相关 evals
- `rainbond-env-sync/SKILL.md:302`
- `docs/product-object-model.md:864`、`:1393`、`:1411` 及拆分后的 canonical reference
- bootstrap/app-assistant 评估中全部 `app-*`、`app-demo-*`、`app-compose-*` 假 ID。

Console 辅助验证：

- `rainbond-console/console/services/mcp_query_service.py:6084-6096`：get app detail。
- 同文件 `:6119-6142`：create app。
- 同文件 `:6145-6159`：component summary。
- 同文件 `:8566-8612`：查询类 schema。

Agent 边界：

- `rainbond-agent/src/server/workflows/loop-runner.ts:189` 使用数字 `app_id`。
- `rainbond-agent/src/server/workflows/compiled-executor.ts:137` 可持有字符串上下文，`:232` 在 Tool 值处解析。

目标规则：持久化/session contract 可接受正整数字符串，但每个 Rainbond Tool call 的 `app_id` 必须为正整数；示例中不再使用 `app-4fd2` 等无法归一化的值。新增 Agent 边界测试证明字符串 `"123"` 可归一化为 `123`，`"app-123"` 必须被拒绝而不是透传。

验收：RainSkills schema/示例/评估与 Console Tool 输入一致；Agent 已有状态兼容；没有为了文档一致性破坏数据库或 session 序列化。

### WP8：生成、同步与线上更新 rainbond-agent

RainSkills 是源，rainbond-agent vendor 不接受手写业务修改。当前同步链：

1. 在 RainSkills 完成并提交全部源修改。
2. 在 rainbond-agent 运行 `npm run skills:sync`。
3. `rainbond-agent/scripts/sync-rainbond-skills.mjs` 校验上游干净且已提交，调用 RainSkills `scripts/build-skill-profile.mjs --profile embedded`，再整体替换 `skills-src/rainbond`。
4. `rainbond-agent/skills-src/rainbond/rainskills-profile.json` 写入 `source_revision`；必须等于刚提交的 RainSkills SHA。
5. Agent build 将 embedded profile 进入镜像/发布物；线上组件更新 Agent/Console 镜像后生效。

相关位置：

- `rainskills/scripts/build-skill-profile.mjs:8-15`：embedded Skill 白名单。
- `rainskills/tests/skill-profile-builder.test.js:1`：profile 生成约束。
- `rainbond-agent/scripts/sync-rainbond-skills.mjs`：唯一同步入口。
- `rainbond-agent/skills-src/rainbond/rainskills-profile.json`：源 revision 和 runtime contract。
- `rainbond-agent/docs/env-vars.md:127` 起：`RAINBOND_SKILLS_SOURCE`、channel/version/cache/vendor fallback；默认本地 vendor，CDN 模式才从远端更新。

线上更新分支：

- 默认 vendor 模式：同步并构建新版 rainbond-agent 镜像，升级 AI 助手 API 组件；仅合并 RainSkills 仓库不会让已运行的 Agent 自动更新。
- CDN 模式：先发布匹配版本的 profile 包，再更新 `RAINBOND_SKILLS_SOURCE=cdn` 及 channel/version 配置并滚动 API 组件；必须保留 vendor fallback。
- 无论哪种模式，rainbond-console Tool 契约变化都必须先部署并验证 Console，再发布依赖该契约的 Skill。

Agent 验证：

```bash
npm run skills:sync
npm test
npm run build
```

额外断言：

- `source_revision` 等于 RainSkills 目标提交。
- embedded 文件不存在 `rainskills-tools.js`、`~/.rainbond/credentials.env`、`--api-only` 等 CLI-only 标记。
- WP1 的旧 Tool 名在 vendor 中为零。
- 新查询 Skill 已进入 Agent profile 且只能调用 session tools。
- staging 环境分别验证管理员与非管理员查询、一次健康概览、一次失败上下文 fallback；之后才能滚动生产 API 组件。

## 5. 测试与提交门禁

### 5.1 RainSkills

每个工作包先运行定向测试，全部完成后执行：

```bash
npm test
npm pack --dry-run
python3 /Users/guox/.codex/skills/.system/skill-creator/scripts/quick_validate.py rainbond-platform-query
python3 /Users/guox/.codex/skills/.system/skill-creator/scripts/quick_validate.py rainbond-app-assistant
python3 /Users/guox/.codex/skills/.system/skill-creator/scripts/quick_validate.py rainbond-app-version-assistant
python3 /Users/guox/.codex/skills/.system/skill-creator/scripts/quick_validate.py rainbond-delivery-verifier
python3 /Users/guox/.codex/skills/.system/skill-creator/scripts/quick_validate.py rainbond-env-sync
python3 /Users/guox/.codex/skills/.system/skill-creator/scripts/quick_validate.py rainbond-fullstack-bootstrap
python3 /Users/guox/.codex/skills/.system/skill-creator/scripts/quick_validate.py rainbond-fullstack-troubleshooter
python3 /Users/guox/.codex/skills/.system/skill-creator/scripts/quick_validate.py rainbond-platform-installer
python3 /Users/guox/.codex/skills/.system/skill-creator/scripts/quick_validate.py rainbond-project-init
python3 /Users/guox/.codex/skills/.system/skill-creator/scripts/quick_validate.py rainbond-template-installer
```

### 5.2 rainbond-console

本次审计环境可静态读取 Console 实现和测试，但本机 Python 环境缺少 Django，尚未实际执行 Console 测试。实施时必须在 rainbond-console 的正式开发环境运行：

```bash
python3 -m pytest -q \
  console/tests/mcp_query_service_test.py \
  console/tests/source_component_service_test.py \
  console/tests/mcp_query_health_overview_test.py \
  console/tests/mcp_query_env_conflicts_test.py \
  console/tests/mcp_query_failure_context_test.py \
  console/tests/mcp_query_wait_build_test.py
```

如果仅修改 RainSkills 而不修改 Console，也必须执行这些测试，以证明引用的既有契约未漂移。涉及失败上下文脱敏时，先补 Console 回归测试并按 Console 仓库规范完成验证。

### 5.3 rainbond-agent

```bash
npm run skills:sync
npm test
npm run build
```

同步前 RainSkills 必须干净且已提交；同步后只接受构建器产生的 vendor diff。若 vendor diff 出现本计划之外的业务变化，停止发布并检查 profile builder。

### 5.4 提交分组

建议按以下 Conventional Commits 分组，避免把契约修正、重构和生成物混成一个不可审阅提交：

1. `test: add console-backed skill contract checks`
2. `fix: align skill tool contracts with console`
3. `fix: align source recovery and failure classification`
4. `feat: add lightweight platform query skill`
5. `refactor: add aggregate tool fast paths`
6. `refactor: split skill references and fix packaging`
7. `fix: normalize app ids at tool boundaries`
8. Agent 仓库：`chore: sync embedded rainbond skills`

每个提交前运行相关定向测试；RainSkills 全套 `npm test`、Console 定向 pytest、Agent `npm test && npm run build` 全部通过后才允许发布。

## 6. 发布、观察与回滚

发布顺序：

1. 若需要 Console 修改，先发布 Console 并确认旧 Skill 仍兼容。
2. 发布 RainSkills 包/CDN profile，验证本地 CLI 安装和升级。
3. 从确定的 RainSkills commit 生成 Agent embedded profile。
4. 在 255/staging 环境升级 AI 助手 API 组件，执行管理员/非管理员查询和部署主线 smoke test。
5. 观察工具调用数、`list/describe` 次数、unknown fallback、schema validation failure 和失败上下文脱敏指标。
6. 通过后再滚动线上 Agent API 组件。

回滚策略：

- RainSkills 本地/CDN：回退到上一 profile version/channel。
- Agent vendor：回退 Agent 镜像即可，`source_revision` 可定位对应 RainSkills 提交。
- Console：新增兼容行为应保持旧 Tool 可用；若契约变更必须先恢复兼容层，再回滚 Skill。
- 新查询 Skill：路由异常时可先从 marketplace/profile 清单移除，不影响原部署主线。

## 7. 延后事项与完成定义

延后事项：

- Git/镜像代理映射：Console 只透传地址，代理规则属于构建环境/provider 集成；需单独用真实构建验证，不能仅凭 Console 文本修改 Skill。
- 用户本机遗留 Skill：`rainbond-app-upgrade-assistant` 在 Console 有对应能力，不能判定为废弃；docker-compose 遗留 Skill 是否保留需单独核对产品入口和实际工具目录。
- Console 新增 Tool：本计划优先复用现有聚合 Tool，不新增后端 API。

完成定义：

- [ ] 全部十个现有顶层 Skill 和一个新增查询 Skill 均有明确审核结论。
- [ ] WP1-WP5 的每处业务修改都有 Console 实现、schema、测试三重依据。
- [ ] 错误工具名、错误参数必选性、分类漂移和非法 `app_id` 均由自动测试阻止回归。
- [ ] “查询当前企业”不再进入部署主流程，不枚举工具，不扩展查询无关资源。
- [ ] app-assistant、project-init、troubleshooter 的主体逻辑和既有行为评估保持不变。
- [ ] npm 包、安装目录和 embedded profile 中所有运行时引用可解析。
- [ ] rainbond-agent vendor 完全由 RainSkills 已提交 revision 生成，manifest SHA 一致。
- [ ] RainSkills、Console、Agent 三方测试和构建全部通过。
- [ ] 255/staging 验证通过并具备明确镜像/profile 回滚点后，才进行线上滚动更新。
