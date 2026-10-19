# source-failure

30. 源码创建一旦失败，**绝对禁止**第二次调用 `rainbond_create_component_from_source` 来"换参数重试"，也**绝对禁止**通过 `rainbond_delete_component` 删掉失败组件再 create 这种伪装手段绕过预算。
    `rainbond_create_component_from_source` 是"检测 + 创建 + 构建"三合一工具，**不是幂等重试工具**，每次调用都会写入一个新的 `service_id`。调用报错不代表组件没建出来——组件行、端口、env、依赖可能已经存在，错误只发生在下游检测或构建阶段；不能凭"上次 create 调用我没拿到 service_id 所以肯定没建出来"做臆测。
    本轮任何源码失败（包括"源码目录不存在 / 子目录识别不到 / 多组件歧义 / 仓库不可达 / 检测识别不到语言 / 构建失败"等）之后，第二个动作**必须**按以下纪律走：
    - 第一步永远先 `rainbond_query_components` 查目标 app，按 `service_cname` 或 `k8s_component_name` 匹配；只要查到一条同名/相近的组件，就视为已存在
    - 命中已存在：
      - 同 `git_url` 同 `code_version`，只想重跑构建 → `rainbond_build_component(service_id, build_info=...)`
      - 源码定义改了（`git_url` / `code_version` / `subdirectories` / `server_type` / 凭据） → `rainbond_update_component_build_source` 然后 `rainbond_build_component`
      - 只调构建参数 → `rainbond_manage_component_envs(operation=replace_build_envs, build_env_dict=...)` 然后 `rainbond_build_component`
    - 未命中（`rainbond_query_components` 确认目标 app 下不存在任何对应组件）才允许重新调 `rainbond_create_component_from_source`，且仍然受 Iron Law 14 的尝试预算约束。
    典型反例（**禁止**）：第一次报"源码目录不存在" → 第二次换个 `subdirectories` 再 create → 第三次又换大小写再 create。每次都会产出新的 service_id，留下多个垃圾组件需要用户清理。正确路径：先 `rainbond_query_components`，如果已经留下了某个 `java-maven-demo` 组件，就 `rainbond_update_component_build_source` 改 `subdirectories` 再 `rainbond_build_component`；只有确认 app 下完全没有同名组件，才可以重新 create，并且必须遵守"同一阶段最多 2 次"。
    **以 `service_cname` 为预算基本单位**：Iron Law 14 的"同一阶段最多尝试 2 次"按 `service_cname` 累计计数，**`rainbond_delete_component` 不重置这个计数**。换句话说，对同一个 `service_cname`（例如 `java-maven-demo`）在本轮 run 内 `create_from_source` 类工具的调用总次数最多 2 次，不管中间有没有 `delete_component` 把上一次的失败组件清掉；超过即必须停下来按下面"用户输入错误"流程走。
    **用户输入错误必须停下来问用户，不允许猜参数**：当源码检测明确报"源码目录不存在 / 语言识别失败 / 仓库不可达 / 凭证错误"等**用户输入相关**的错误时，根因是用户给的 `git_url` / `subdirectories` / `code_version` / 凭证本身有问题——这类错误**不能通过 AI 自己换参数**（去掉 subdirectories、改大小写、换分支名、换 case）来解决。必须**停下来**显式询问用户：
    - 列出已尝试的参数组合和对应的错误信息
    - 请用户确认仓库的真实子目录路径（建议用户在浏览器打开仓库或贴 tree 截图）
    - 或者请用户提供另一个分支 / 凭证 / 子路径
    - **不允许**根据"模型对该仓库的先验知识"猜常见名字（Java-maven-demo、java_maven_demo、demo/java-maven 等）
    - 这与 Iron Law 29 入口"必须问用户"配套：29 管入口、30 管中途用户输入验证失败的二次询问。
    猜测换参数 + 删-再-create 循环是典型 anti-pattern，server 端可能直接 reject 重复 create 调用。
30a. **软件包组件的后续发布必须原位替换**：先用 `rainbond_query_components` 建立目标 `service_id` 的来源，
    再执行客户端上传事务。初始化上传时传 `component_id=service_id`，上传状态非空后调用
    `rainbond_replace_component_package(service_id=原值, event_id=新上传事件)`；禁止再次调用
    `rainbond_create_component_from_package`，禁止通过 `v2` / `v3` 后缀绕过英文名冲突。替换返回构建
    `event_id` 后在当前回复中只调用一次 `rainbond_wait_for_build_completion(timeout=60)`。返回 `status=running` 时立即结束当前回复，报告已完成动作、当前状态和 event；不得再次等待、手工轮询或继续轮询。用户之后明确说“继续”时才开始新的检查回合。
30b. **镜像组件的后续发布也必须复用组件**：期望镜像与当前镜像相同但需要重新拉取时，直接调用
    `rainbond_build_component(service_id=原值)`；镜像地址或标签变化时，调用
    `rainbond_change_component_image(service_id=原值, image=新值)`，再调用 `rainbond_build_component`。
    禁止用 `rainbond_create_component_from_image` 生成替代组件。
