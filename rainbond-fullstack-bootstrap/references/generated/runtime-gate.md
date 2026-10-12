<!-- generated-by: scripts/sync-runtime-contracts.mjs -->
<!-- source-sha256: fc3f14ce4f151b9481f8d97429c105d0ac68c28643b5724c93552b234ab03dfd -->
<!-- profile: cli -->
<!-- rainskills-runtime-gate:start -->
# 单运行环境 CLI 门禁（生成文件）

本机只允许连接一个 Rainbond 运行环境。当前 Skill 在本会话第一次调用 Rainbond 前，执行固定 launcher 的 `runtime status --json`。只有命令退出码为 0、`state=connected` 且 `usable=true` 时才继续。不得配置或直接调用客户端 MCP，不得枚举环境、读取凭据、创建业务 operation，或生成运行环境 ID、业务 operation ID 与 intent JSON。

运行状态的 `package_version` 必须与下方 JSON contract 完全一致；缺失或不一致时先执行固定版本 `rainskills@0.1.42` 的更新/修复流程。不得在版本错配时继续业务调用。

没有可用运行环境时，严格按下方 overlay 的 `missing_runtime_mode` 进入对应的 Runtime Routing；不得扩大可选环境范围。连接和重新授权必须使用浏览器 Device Flow，不复用 Shell 中缓存的 JWT；Device Flow 不依赖 stdin TTY，必须保持进程附着直到完成。新凭据只有通过 live probe 后才可覆盖唯一运行环境。CLI 返回 401 时，只读调用可在 `runtime reconnect` 成功后重试一次；写调用不得自动重放，必须先查询平台真实状态。403 直接停止，不重新授权。

授权命令是同步门禁。命令返回“进程仍在运行”或会话 ID 时，只等待或轮询同一个命令会话；在该会话结束前禁止任何后续业务步骤。浏览器页面显示成功不代表完成；只有原命令退出码为 0，并输出 `rainskills.runtime-connect-result.v1` 且 `state=connected`，才可继续。不得另起 `runtime status` 猜测完成。

Codex 中取得 `session_id` 后，对该会话反复调用 `write_stdin`（空输入轮询），直到返回 `exit_code`。`RAINSKILLS_AGENT_WAIT_REQUIRED:runtime-connect` 与 `RAINSKILLS_AGENT_WAIT_COMPLETE:runtime-connect` 都不替代最终退出码。

Hermes Agent 使用 `terminal` 且 `background=true` 启动授权，随后只对原会话调用 `process(action="poll")` 和 `process(action="wait")`。带 `--input -` 的短业务命令使用前台 `terminal` 和单引号 heredoc 写入完整 JSON；不得用 `echo`、把 JSON 放入 argv、合并 stderr 或后台化短命令。

固定 `<target>`：Codex=`codex`、Claude Code=`claude`、Pi Agent=`pi`、DeepSeek Harness=`dsh`、WorkBuddy=`workbuddy`、Hermes Agent=`hermes`。DeepSeek Harness 和 WorkBuddy 返回持久终端或后台句柄时，只轮询原句柄直到退出。

构建、镜像拉取或部署收敛在一个用户回合内最多等待 60 秒：同一 event 只调用一次 `rainbond_wait_for_build_completion(timeout=60)`。返回 `status=running` 时立即结束当前回复，报告已完成动作、当前状态和 event；不得在同一回合再次等待、手工轮询或继续推理。用户之后明确说“继续”时，才对同一 event 开始新的 60 秒检查回合。

受限沙箱执行本地状态命令时必须申请用户级受保护目录访问权限；不得修改 `~/.rainbond` 权限或复制受保护状态。固定 launcher 与 argv 已在本文件声明，禁止搜索或探测 `rainskills.js`，也禁止执行 `npm root -g`。

`context resolve` 是无状态调用。首次 stdin 固定为 `{"required":["enterprise","workspace"]}` 字面请求体；显式 team/region 放入 `hints`，多候选选择通过 `selection.option_id` 重新查询验证。不得执行 `context select` 或写本地 context。所有可变 `call` 必须先取得 confirmation ID，再以完全相同输入追加 `--confirm` 执行一次。

## Skill overlay

- `skill_id`: `rainbond-fullstack-bootstrap`
- `supported_profiles`: `cli, embedded`
- `command_set`: `context_resolve, list, describe, read, snapshot, poll, package_upload, handoff_create, handoff_validate, call, call_confirm`
- `version_guard`: `required`
- `missing_runtime_mode`: `new_application`
- `scope_discriminator`: `workspace`
- `resume_target`: `component-topology`

不可弱化的不变量：

- Template components are never created by bootstrap.
- Local package upload is CLI-only and uses the protected package_upload command.
- Dependency, provider, persistence, and proxy order must remain derived from verified manifest facts.

## 固定 CLI contract

```json
{
  "schema": "rainskills.single-runtime-contract.v1",
  "package_version": "rainskills@0.1.42",
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
        "rainbond-fullstack-bootstrap"
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
    "list": {
      "argv": [
        "node",
        "<home>/.rainbond/bin/rainskills-tools.js",
        "list",
        "--prefix",
        "<tool-prefix>",
        "--skill-id",
        "rainbond-fullstack-bootstrap"
      ]
    },
    "describe": {
      "argv": [
        "node",
        "<home>/.rainbond/bin/rainskills-tools.js",
        "describe",
        "<tool-name>",
        "--skill-id",
        "rainbond-fullstack-bootstrap"
      ]
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
        "rainbond-fullstack-bootstrap"
      ],
      "stdin_schema_source": "tool-catalog"
    },
    "snapshot": {
      "argv": [
        "node",
        "<home>/.rainbond/bin/rainskills-tools.js",
        "snapshot",
        "<runtime|app|component|delivery>",
        "--input",
        "-",
        "--skill-id",
        "rainbond-fullstack-bootstrap"
      ],
      "stdin_schema_source": "rainskills.read-snapshot.v1.request"
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
        "rainbond-fullstack-bootstrap"
      ],
      "stdin_schema_source": "rainskills.protected-poll.v1.request"
    },
    "package_upload": {
      "argv": [
        "node",
        "<home>/.rainbond/bin/rainskills-tools.js",
        "package-upload",
        "--archive",
        "<archive-path>",
        "--input",
        "-",
        "--skill-id",
        "rainbond-fullstack-bootstrap"
      ],
      "stdin_schema_source": "rainbond_init_package_upload.upload_request"
    },
    "handoff_create": {
      "argv": [
        "node",
        "<home>/.rainbond/bin/rainskills-tools.js",
        "handoff",
        "create",
        "--input",
        "-",
        "--skill-id",
        "rainbond-fullstack-bootstrap"
      ],
      "stdin_schema_source": "contracts/handoff-context.schema.yaml#create-input"
    },
    "handoff_validate": {
      "argv": [
        "node",
        "<home>/.rainbond/bin/rainskills-tools.js",
        "handoff",
        "validate",
        "--input",
        "-",
        "--skill-id",
        "rainbond-fullstack-bootstrap"
      ],
      "stdin_schema_source": "contracts/handoff-context.schema.yaml#validation-input"
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
        "rainbond-fullstack-bootstrap"
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
        "rainbond-fullstack-bootstrap",
        "--confirm",
        "<confirmation-id>"
      ],
      "stdin_schema_source": "same-confirmed-input"
    }
  }
}
```
<!-- rainskills-runtime-gate:end -->
