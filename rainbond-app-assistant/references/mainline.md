# Deployment mainline

只读取当前阶段与实际来源有关的文档；索引中的链接是备选路径，不是待读清单。

1. 首次完成自己的 Runtime Gate 和 workspace 选择。复用有效 HandoffContext，不重复连接或解析相同身份。
2. 当前本地项目缺少或绑定不一致时进入 project-init；address-only source/image requests do not require local project files。初始化 linked 后自动继续主线。
3. 拓扑缺失进入 bootstrap；拓扑存在但异常进入 troubleshooter；运行健康进入 delivery verifier。源码构建失败先看 component events，再 build logs，最后 runtime logs。
4. 写之前完整读取本阶段专项 Skill 的 SKILL.md，按其条件表加载当前动作资料；相同 Gate 只核对一致性，不重复 preflight。
5. 已确认的 source/package/image/template、Git URL 和 branch/ref 不得静默切换。用户字面值 verbatim；代理只能使用既定 canonical 映射，不猜 tag、路径、service_id 或地址。
6. 所有写入使用精确 scope、来自当前查询/创建的 service_id、相同输入的确认与审计。写调用不得自动重放；未知结果先查询平台事实，401 写不重放，403 停止。
7. provider 先于 consumer；持久化和显式依赖就绪后才能部署。保留源码策略、依赖方向与实际存储证据，不能以容器 running 替代交付验收。
8. 一个用户回合内同 event 只调用一次 rainbond_wait_for_build_completion(timeout=60)。status=running 时立即结束当前回复；不得再次等待、手工轮询或继续推理。用户明确继续后再对同一 event 检查。
9. 同类失败按专项预算停止；代码问题交接，破坏性动作和 workaround 单独确认。不得操作 rbd-* 平台组件。
10. 短回复继承上一轮明确阻塞，不重启整个工作流。过程只在有意义状态变化时报告，不暴露内部 preflight、凭据、team_id 或完整工具结果。

| 需要处理的阶段 | 读取 |
|---|---|
| 本地初始化、adopt/link | [初始化](phases/initialize.md)、[本地输入](phases/local-inputs.md) |
| 创建和配置 | [拓扑约束](phases/bootstrap.md)，再进入 bootstrap 专项 Skill |
| 来源或复杂多组件选择不明确 | [来源选择](phases/topology-selection.md) |
| 源码创建与 ref | [源码策略](phases/source-policy.md)、[源码创建](phases/source-create.md) |
| 检测和构建参数 | [源码构建](phases/source-build.md) |
| 构建/运行失败 | [排障](phases/troubleshoot.md)，再进入 troubleshooter |
| 访问验收 | [交付](phases/deliver.md)，再进入 delivery verifier |
| 显式 promotion | [promotion](phases/promote.md) |

细节按具体阻塞查找：[身份出处](phases/identity.md)、[字面输入](phases/input-literals.md)、[代理](phases/source-proxy.md)、[源码失败](phases/source-failure.md)。不要预读这些分支。全部硬规则的迁移位置由 rule-ownership.json 记录。
