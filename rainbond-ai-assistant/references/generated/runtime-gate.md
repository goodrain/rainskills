<!-- generated-by: scripts/sync-runtime-contracts.mjs -->
<!-- source-sha256: 5bb372cf8c519d9f15f81c7d893ca2b09ac0968bbc7eacf9ad771b53520cee5a -->
<!-- profile: cli -->
<!-- rainskills-runtime-gate:start -->
# 单运行环境 CLI 门禁（生成文件）

本机只允许连接一个 Rainbond 运行环境。当前 Skill 在本会话第一次调用 Rainbond 前，执行固定 launcher 的 `runtime status --json`。只有命令退出码为 0、`state=connected` 且 `usable=true` 时才继续。不得配置或直接调用客户端 MCP，不得枚举环境、读取凭据、创建自定义业务 operation，或生成运行环境 ID、业务 operation ID 与 intent JSON。固定 batch/recipe 请求和 CLI 返回的 confirmation_id 属于受保护调用协议，不是模型自建业务工作流。

运行状态必须来自固定 launcher；不得使用未验证的替代 CLI 或传输。

如果 integrity.status=failed 或 repair_required=true，停止业务调用并修复相同版本的本地安装；不得将缺模块当作 API 参数错误排查或绕过兼容入口。

没有可用运行环境时，严格按下方 overlay 的 `missing_runtime_mode` 进入对应的 Runtime Routing；不得扩大可选环境范围。连接和重新授权必须使用浏览器 Device Flow，不复用 Shell 中缓存的 JWT；Device Flow 不依赖 stdin TTY，必须保持进程附着直到完成。新凭据只有通过 live probe 后才可覆盖唯一运行环境。CLI 返回 401 时，只读调用可在 `runtime reconnect` 成功后重试一次；写调用不得自动重放，必须先查询平台真实状态。403 直接停止，不重新授权。

授权命令是同步门禁。命令返回“进程仍在运行”或会话 ID 时，只等待或轮询同一个命令会话；在该会话结束前禁止任何后续业务步骤。浏览器页面显示成功不代表完成；只有原命令退出码为 0，并输出 `rainskills.runtime-connect-result.v1` 且 `state=connected`，才可继续。不得另起 `runtime status` 猜测完成。

Codex 中取得 `session_id` 后，对该会话反复调用 `write_stdin`（空输入轮询），直到返回 `exit_code`。`RAINSKILLS_AGENT_WAIT_REQUIRED:runtime-connect` 与 `RAINSKILLS_AGENT_WAIT_COMPLETE:runtime-connect` 都不替代最终退出码。

Hermes Agent 使用 `terminal` 且 `background=true` 启动授权，随后只对原会话调用 `process(action="poll")` 和 `process(action="wait")`。带 `--input -` 的短业务命令使用前台 `terminal` 和单引号 heredoc 写入完整 JSON；不得用 `echo`、把 JSON 放入 argv、合并 stderr 或后台化短命令。

固定 `<target>`：Codex=`codex`、Claude Code=`claude`、Pi Agent=`pi`、DeepSeek Harness=`dsh`、WorkBuddy=`workbuddy`、Hermes Agent=`hermes`。DeepSeek Harness 和 WorkBuddy 返回持久终端或后台句柄时，只轮询原句柄直到退出。

构建、镜像拉取或部署使用 `rainbond_wait_for_build_completion(timeout=60)` 进行单次有界只读等待；60 秒是一次请求的服务端等待窗口，不是整个任务或用户回合的期限。用户已授权完整部署或持续监测时，返回 `status=running` 就在同一回合围绕同一 event 继续等待，直到终态、用户取消或真实阻塞；不要要求用户反复说“继续”，也不要用定时任务替代正常等待。用户明确要求单次查询或指定等待预算时遵守该范围。正常 running 和只读等待不消耗配置修复重试预算，也不受通用八分钟执行预算截断。

只读等待发生传输超时时保留原 event，短暂退避后仍按同一 event 回查，不重发部署或构建写请求；连续三次传输失败时报告连接阻塞、最后证据和原 event，禁止重放未知结果的写入。401/403 仍按上方鉴权门禁处理。工具返回宿主持久会话句柄时先等待该原句柄结束，再开始下一次只读等待；不得并发等待同一事件、无限 shell 忙循环或无锚点轮询。每次出现实质状态变化或需要用户行动时更新进度，终态成功后继续应用健康、业务与交付验证，不能仅凭构建成功宣布交付。

受限沙箱执行本地状态命令时必须申请用户级受保护目录访问权限；不得修改 `~/.rainbond` 权限或复制受保护状态。固定 launcher 与 argv 已在本文件声明，禁止搜索或探测 `rainskills.js`，也禁止执行 `npm root -g`。

`context resolve` 是无状态调用。首次 stdin 固定为 `{"required":["enterprise","workspace"]}` 字面请求体；显式 team/region 放入 `hints`，多候选选择通过 `selection.option_id` 重新查询验证。不得执行 `context select` 或写本地 context。所有可变 `call` 必须先取得 confirmation ID，再以完全相同输入追加 `--confirm` 执行一次。

## Skill overlay

- `skill_id`: `rainbond-ai-assistant`
- `supported_profiles`: `cli, embedded`
- `command_set`: `context_resolve, read, poll, call, call_confirm`
- `version_guard`: `none`
- `missing_runtime_mode`: `ai_workload`
- `scope_discriminator`: `workspace`
- `resume_target`: `ai-engine-intent`

不可弱化的不变量：

- AI Engine context must use the literal enterprise/workspace resolve request; do not probe with list or describe.
- context resolve 禁止使用 --help 或空对象 {}；required 声明维度，并不是要求模型填写维度值。
- CPU and model-management work may continue when GPU is unavailable; never infer GPU readiness from an empty result.
- Unknown write results are queried by exact model or instance identity before any retry.

## 固定 CLI contract

```json
{
  "schema": "rainskills.single-runtime-contract.v1",
  "package_version": "rainskills@0.1.50",
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
        "rainbond-ai-assistant"
      ],
      "stdin": {
        "default": {
          "required": [
            "enterprise",
            "workspace"
          ]
        },
        "with_hints": {
          "required": [
            "enterprise",
            "workspace"
          ],
          "hints": {
            "team_name": "<team-name>"
          }
        },
        "with_selection": {
          "required": [
            "enterprise",
            "workspace"
          ],
          "selection": {
            "option_id": "<option-id>"
          }
        }
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
        "rainbond-ai-assistant"
      ],
      "stdin_schema_source": "tool-catalog"
    },
    "poll": {
      "argv": [
        "node",
        "<home>/.rainbond/bin/rainskills-tools.js",
        "poll",
        "<read-tool>",
        "--input",
        "-",
        "--skill-id",
        "rainbond-ai-assistant"
      ],
      "stdin_schema_source": "rainskills.protected-poll.v1.request"
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
        "rainbond-ai-assistant"
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
        "rainbond-ai-assistant",
        "--confirm",
        "<confirmation-id>"
      ],
      "stdin_schema_source": "same-confirmed-input"
    }
  }
}
```
<!-- rainskills-runtime-gate:end -->
