# Open-source App Deploy runtime gate

Canonical progressive-loading contract: `rainskills.skill-runtime-contract.v1`.

<!-- rainskills-runtime-gate:start -->
## 单运行环境 CLI 门禁（最高优先级）

本机只允许连接一个 Rainbond 运行环境。当前 Skill 在本会话第一次调用 Rainbond 前，执行固定 launcher 的 `runtime status --json`。返回 `connected` 且 `usable=true` 后，所有查询和变更直接通过本地 `~/.rainbond/bin/rainskills-tools.js` 执行。不得配置或直接调用客户端 MCP，不得执行环境枚举或业务 operation 生命周期命令，也不得生成或传递运行环境 ID、业务 operation ID 或 intent JSON。

没有运行环境时，让用户选择 Rainbond Cloud 或一个已有/新建的私有 Rainbond，并执行对应的 `runtime connect`。连接和重新授权必须进入浏览器 Device Flow，不复用 Shell 中缓存的 JWT；新凭据通过 live probe 后才覆盖唯一运行环境。CLI 返回 401 时，只读调用可在 `runtime reconnect` 成功后重试一次；写调用不得自动重放，必须先查询平台真实状态。403 直接停止，不重新授权。

授权命令是同步门禁。执行工具返回“进程仍在运行”或会话 ID 时，必须只等待或轮询同一个命令会话；在该会话结束前，禁止读取专项 Skill、解析 context、调用业务 CLI 或执行任何后续业务步骤。浏览器页面显示成功不代表连接完成；只有原命令退出码为 0，并输出 `rainskills.runtime-connect-result.v1` 且 `state=connected`，才可继续。不得另起 `runtime status` 猜测完成，也不得重复提示用户授权。

Codex 中命令工具一旦返回 `session_id`，必须立即对该 `session_id` 反复调用 `write_stdin`（空输入轮询），直到工具返回 `exit_code`。连接器输出 `[RAINSKILLS_AGENT_WAIT_REQUIRED:runtime-connect]` 后进入上述轮询；看到 `[RAINSKILLS_AGENT_WAIT_COMPLETE:runtime-connect]` 后仍须继续轮询，直到取得退出码和最终 JSON。

Hermes Agent 中必须使用 `terminal` 以 `background=true` 启动授权命令；取得 `session_id` 后，只对同一会话按需调用 `process(action="poll")` 获取授权地址，再调用 `process(action="wait")` 等待退出。`wait` 超时时只能继续等待同一 `session_id`；不得把后台启动或浏览器成功页面当作授权完成，也不得另起 `runtime status`。

Hermes Agent 执行带 `--input -` 的一次性业务命令时，使用 `terminal` 前台执行，并用单引号 heredoc 将完整 JSON 只写入 stdin；不得用 `echo`、把 JSON 放入 argv、合并 stderr 或把该短命令后台化。

固定 contract 中的 `<target>` 必须替换为当前宿主：Codex=`codex`、Claude Code=`claude`、Pi Agent=`pi`、DeepSeek Harness=`dsh`、WorkBuddy=`workbuddy`、Hermes Agent=`hermes`。DeepSeek Harness 和 WorkBuddy 若返回持久终端或后台任务句柄，只轮询该原始句柄直到进程退出，不另起状态命令推测完成。

`context resolve` 是无状态调用：单一工作空间直接返回上下文，多个候选返回组合选项；用户选择后由当前任务直接携带 team/region 参数，不执行 `context select`，不写本地 operation。所有可变 `call` 仍需先取得 confirmation ID，再以完全相同的输入追加 `--confirm` 执行一次。

`required` 只声明要解析的维度，企业 ID 始终来自当前登录身份。用户明确给出的 team/region 必须放进 `hints` 做精确匹配；不得把企业名、team 名或选择对象作为顶层 `enterprise` / `workspace` 字段传入。多候选时只展示 CLI 返回的 label；用户选择后再次执行同一个无状态 `context resolve`，通过 `selection.option_id` 让 CLI 重新查询并验证当前候选，不写本地 context 状态。

```json
{
  "schema": "rainskills.single-runtime-contract.v1",
  "package_version": "rainskills@0.1.36",
  "runtime_status": [
    "node",
    "<home>/.rainbond/lib/rainskills/bin/rainskills.js",
    "runtime",
    "status",
    "--json"
  ],
  "runtime_connect": {
    "saas": [
      "node",
      "<home>/.rainbond/lib/rainskills/bin/rainskills.js",
      "runtime",
      "connect",
      "<target>",
      "--saas"
    ],
    "private_existing": [
      "node",
      "<home>/.rainbond/lib/rainskills/bin/rainskills.js",
      "runtime",
      "connect",
      "<target>",
      "--rainbond-url",
      "<console-origin>"
    ],
    "install_private": [
      "node",
      "<home>/.rainbond/lib/rainskills/bin/rainskills.js",
      "runtime",
      "connect",
      "<target>",
      "--install-private",
      "--location",
      "<local-or-server>"
    ],
    "reconnect": [
      "node",
      "<home>/.rainbond/lib/rainskills/bin/rainskills.js",
      "runtime",
      "reconnect",
      "<target>"
    ]
  },
  "input_commands": {
    "context_resolve": {
      "argv": [
        "node",
        "<home>/.rainbond/bin/rainskills-tools.js",
        "context",
        "resolve",
        "--input",
        "-",
        "--skill-id",
        "rainbond-opensource-app-deploy"
      ],
      "stdin": {
        "default": {"required": ["enterprise", "workspace"]},
        "with_hints": {"required": ["enterprise", "workspace"], "hints": {"team_name": "<team-name>"}},
        "with_selection": {"required": ["enterprise", "workspace"], "selection": {"option_id": "<option-id>"}}
      }
    },
    "read": {
      "argv": [
        "node",
        "<home>/.rainbond/bin/rainskills-tools.js",
        "read",
        "<tool>",
        "--input",
        "-",
        "--skill-id",
        "rainbond-opensource-app-deploy"
      ],
      "stdin_schema_source": "tool-catalog"
    },
    "call": {
      "argv": [
        "node",
        "<home>/.rainbond/bin/rainskills-tools.js",
        "call",
        "<tool>",
        "--input",
        "-",
        "--skill-id",
        "rainbond-opensource-app-deploy"
      ],
      "stdin_schema_source": "tool-catalog"
    },
    "call_confirm": {
      "argv": [
        "node",
        "<home>/.rainbond/bin/rainskills-tools.js",
        "call",
        "<tool>",
        "--input",
        "-",
        "--skill-id",
        "rainbond-opensource-app-deploy",
        "--confirm",
        "<confirmation-id>"
      ],
      "stdin_schema_source": "same-confirmed-input"
    }
  }
}
```
<!-- rainskills-runtime-gate:end -->

受限沙箱（包括 Codex）执行本地状态命令时，必须申请用户级受保护目录访问权限；在 Codex 中使用 `require_escalated`。不得修改 `~/.rainbond` 权限、复制受保护状态到工作区，或因沙箱权限错误建议重装。

`runtime connect` 的 Device Flow 不依赖 stdin TTY；Agent 必须执行固定 argv 并保持进程附着直到授权完成。能打开本机浏览器时由连接器自动跳转，SSH、容器等无浏览器场景原样展示授权地址并继续轮询。只有 Rainbond 不支持 Device Flow 且进入旧版 loopback 手动粘贴时才需要交互终端；不得要求用户在聊天中粘贴 JWT。

执行优化：同一会话内只检查一次 Node.js 和运行环境状态；仅在 Node.js、Rainskills、PATH 或唯一运行环境发生变化后失效。固定 launcher 和 argv 已在本 Skill 中，禁止读取、搜索或探测 `rainskills.js`，也禁止执行 `npm root -g`。

<!-- rainskills-runtime-routing:start -->
## 缺少运行环境时

先说：“可以，我会帮你部署未收录到应用市场的开源应用。不过目前还没有可用的应用运行环境。你刚安装的 Rainskills 是 AI 部署助手，它负责分析项目并执行部署；应用实际会运行在 Rainbond 上。Rainbond 是一套应用运行和管理平台，负责容器运行、域名访问、日志和存储等工作，你不需要了解 Kubernetes。”

#### 选择运行环境

请提示“请选择应用要运行的环境：”，并只显示：

1) 云端环境（免费体验）
2) 本机环境
3) 独立服务器
4) 已有 Rainbond

选择 1 时执行 `saas` route；选择 2 时执行 `install-private` 并使用 `["--location", "local"]`；选择 3 时执行 `install-private` 并使用 `["--location", "server"]`；选择 4 时执行本地 launcher + `["runtime", "message", "--id", "private-console-origin"]` 后执行 `private-existing`。不得显示“私有环境”或部署位置中间层，不得在运行环境准备完成前继续读取或修改部署描述文件。
<!-- rainskills-runtime-routing:end -->
