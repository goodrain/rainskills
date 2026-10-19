# input-literals

36. **用户给出的字面值（URL / 镜像地址 / 分支名 / 凭证）必须 verbatim 传给工具，禁止 LLM 凭训练知识"补全"、"修正"、"猜测"**。
    适用字段：`git_url` / `image`（用户所说的镜像地址映射到 Console Tool 的 `image` 字段）/ `code_version`（分支/tag/commit）/ `username` / `password` / `token` / `subdirectories` 等任何用户在消息里给出的字面值。
    **禁止行为**：
    - 看到 `service_cname=java-maven-demo` 就自创 `git_url=https://gitee.com/mirrors_123/java-maven-demo.git`（按训练数据里"常见仓库地址"补全）
    - 用户给的 URL 没 `.git` 后缀就自动加上
    - 用户给的 URL 是 `gitee.com/xxx/yyy`，你"知道这个仓库其实在 GitHub" 就改成 `github.com/...`
    - 用户给了主仓库 URL（`https://gitee.com/rainbond/sourcecode-examples`），你把它换成你以为的子项目独立仓库（`https://gitee.com/some-org/java-maven-demo.git`）—— 同一个仓库下的不同子项目应该用**同一个 URL + subdirectories 参数**区分，而不是换 URL
    - 用户没说分支，你自己写 `code_version=main` 或 `master` 当默认值（应该让后端/Tool 默认值生效，传 `master` 的前提是用户说过 master 或者你是 carrying over 从已有组件 build_source 拿到的字面值）

    **正确做法**：
    - 用户消息里出现的 URL/分支/凭证，**逐字符 copy** 传给工具
    - 用户消息**没有**给某个字段（如只说"部署 X 项目"没给 git_url）→ 必须**问用户**要这个字段，不允许自创
    - 如果你认为用户给的值有问题（域名错、路径不对），**让后端报错**而不是预先"修正"——后端的报错是把决定权交回用户的正确路径
    - 唯一允许"非用户消息字面"的 git_url 来源：本会话内 `rainbond_get_component_build_source` 的返回（即"维持已有组件的 git_url 不变"场景）；这种情况下你必须能在 priorTurnMessages 的 tool_result 里指出该值的来源

    **wire 层 gate（Iron Law 36 enforcement）**：server 会拦截 `rainbond_create_component_from_source` / `rainbond_update_component_build_source` 调用，验证 `git_url` 的 host+owner（如 `gitee.com/rainbond`）在本 run 的 conversation 文本（user/assistant/tool messages 全部 content）中 verbatim 出现。命不中直接 reject 并要求 LLM 停下来问用户。所以**自创 URL 不会过 wire**，只是浪费一次 LLM 轮次。

    反例（**禁止**）：用户说"帮我部署 https://gitee.com/rainbond/sourcecode-examples 的 java-maven-demo"，你调 `rainbond_create_component_from_source(git_url='https://gitee.com/mirrors_123/java-maven-demo.git', subdirectories='java-maven-demo')` —— 这是把用户给的主仓库 URL 整个替换成你训练数据里相关性高的某个独立仓库。
    正确做法：`rainbond_create_component_from_source(git_url='https://gitee.com/rainbond/sourcecode-examples', subdirectories='java-maven-demo')` —— URL 逐字用用户给的，子目录用用户说的子项目名。
