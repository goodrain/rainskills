# Platform Plugin Manager runtime gate

Canonical progressive-loading contract: `rainskills.skill-runtime-contract.v1`.

<!-- rainskills-runtime-gate:start -->
## 单运行环境 CLI 门禁（最高优先级）

本机只允许连接一个 Rainbond 运行环境。首次平台调用前执行固定 launcher 的 `runtime status --json`；只有退出码为 0、`state=connected` 且 `usable=true` 才继续。不得配置客户端 MCP、枚举环境或读取凭据。

无环境时只提供 Rainbond Cloud 或已有私有 Rainbond。连接与重新授权使用浏览器 Device Flow，不复用 Shell JWT。401 可完成 reconnect 后重试一次只读调用；写调用不得自动重放，必须先查询真实状态。403 直接停止。

授权是同步门禁：命令返回运行中或会话 ID 后，只等待同一个命令会话；完成前禁止任何后续业务步骤。浏览器成功不等于完成，必须等待 `rainskills.runtime-connect-result.v1`。Codex 取得 `session_id` 后反复调用 `write_stdin`，直到返回 `exit_code`；`RAINSKILLS_AGENT_WAIT_REQUIRED:runtime-connect` 与 `RAINSKILLS_AGENT_WAIT_COMPLETE:runtime-connect` 都不替代最终退出码。

Hermes Agent 使用 `terminal` 且 `background=true` 启动授权，随后 `process(action="wait")`；带 JSON stdin 的短业务命令使用单引号 heredoc。固定 target：Codex=`codex`、Claude Code=`claude`、Pi Agent=`pi`、DeepSeek Harness=`dsh`、WorkBuddy=`workbuddy`、Hermes Agent=`hermes`。

`context resolve` 无状态解析当前 team/region；用户选择通过 `selection.option_id` 重新验证，不写本地 context。所有可变 call 先取得 confirmation ID，再以完全相同输入确认并执行一次。

```json
{
  "schema": "rainskills.single-runtime-contract.v1",
  "package_version": "rainskills@0.1.41",
  "runtime_status": ["node", "<home>/.rainbond/lib/rainskills/bin/rainskills.js", "runtime", "status", "--json"],
  "runtime_connect": {
    "saas": ["node", "<home>/.rainbond/lib/rainskills/bin/rainskills.js", "runtime", "connect", "<target>", "--saas"],
    "private_existing": ["node", "<home>/.rainbond/lib/rainskills/bin/rainskills.js", "runtime", "connect", "<target>", "--rainbond-url", "<console-origin>"],
    "install_private": ["node", "<home>/.rainbond/lib/rainskills/bin/rainskills.js", "runtime", "connect", "<target>", "--install-private", "--location", "<local-or-server>"],
    "reconnect": ["node", "<home>/.rainbond/lib/rainskills/bin/rainskills.js", "runtime", "reconnect", "<target>"]
  },
  "input_commands": {
    "context_resolve": {
      "argv": ["node", "<home>/.rainbond/bin/rainskills-tools.js", "context", "resolve", "--input", "-", "--skill-id", "rainbond-platform-plugin-manager"],
      "stdin": {
        "default": {"required": ["enterprise", "workspace"]},
        "with_hints": {"required": ["enterprise", "workspace"], "hints": {"team_name": "<team-name>"}},
        "with_selection": {"required": ["enterprise", "workspace"], "selection": {"option_id": "<option-id>"}}
      }
    },
    "read": {
      "argv": ["node", "<home>/.rainbond/bin/rainskills-tools.js", "read", "<tool>", "--input", "-", "--skill-id", "rainbond-platform-plugin-manager"],
      "stdin_schema_source": "tool-catalog"
    },
    "call": {
      "argv": ["node", "<home>/.rainbond/bin/rainskills-tools.js", "call", "<tool>", "--input", "-", "--skill-id", "rainbond-platform-plugin-manager"],
      "stdin_schema_source": "tool-catalog"
    },
    "call_confirm": {
      "argv": ["node", "<home>/.rainbond/bin/rainskills-tools.js", "call", "<tool>", "--input", "-", "--skill-id", "rainbond-platform-plugin-manager", "--confirm", "<confirmation-id>"],
      "stdin_schema_source": "same-confirmed-input"
    }
  }
}
```
<!-- rainskills-runtime-gate:end -->

受限沙箱执行本地状态命令时申请用户级受保护目录访问；不得修改用户目录权限或复制状态。Device Flow 不依赖 stdin TTY，必须保持原进程附着。固定 launcher 已给出，禁止 `npm root -g` 探测。

<!-- rainskills-runtime-routing:start -->
## 缺少运行环境时

说明平台插件操作需要连接 Rainbond，只提供 Rainbond Cloud 或已有私有 Rainbond；不得为了插件管理安装新的 Rainbond 平台。连接完成后恢复原插件意图。
<!-- rainskills-runtime-routing:end -->

