# RainSkills 安装与平台生命周期诊断设计

## 一、项目背景

RainSkills 当前已经有两类局部记录：

- `install.sh` 向 `https://log.rainbond.com/api/rainskills/installations` 异步上报 `started`、`authorized`、`configured` 和 `failed` 摘要；
- 平台安装器在本机的操作目录保存 `state.json`、`events.jsonl` 和安装日志。

但两套记录没有统一的事件格式，平台安装的中间阶段、阻塞原因、退出码、耗时和 Windows/WSL/远程 SSH 细节无法稳定汇总到日志服务。

Rainbond Console 已经通过 MCP 侧的 `RainSkillsDeploymentService` 独立记录应用部署，因此本设计不修改应用部署统计，也不复制 Console 的部署事件。

## 二、目标与非目标

### 2.1 目标

统一记录 RainSkills 自己控制的完整安装生命周期：

- macOS、Linux、Windows；
- 本地 Linux/macOS/Windows 和远程 Linux；
- 目标选择、预检、确认、下载、WSL、Docker、Rainbond 部署、网络配置、Console 验证、授权、MCP 配置；
- 每个步骤的 `started`、`completed`、`blocked`、`failed`、`interrupted`、`skipped` 状态；
- 阻塞阶段、标准化错误分类、退出码、HTTP 状态码、耗时和是否可重试；
- 所有事件最终尽力发送到 `log.rainbond.com`；服务不可用不得改变安装结果。

### 2.2 非目标

- 不修改 Rainbond Console 的应用部署统计；
- 不上传 Token、JWT、密码、用户名、邮箱、完整 Console URL、源码、原始命令行或完整原始日志；
- 不把远程上报变成安装前置条件；
- 不改变现有安装阶段顺序、重试策略、权限模型和成功判定。

## 三、用户旅程

用户执行安装器后，安装器为本次运行生成 `install_attempt_id`，并在每个阶段写入本地受保护事件文件。阶段失败或用户中断时，事件包含最后阶段和脱敏原因；阶段完成时写入耗时和结果。每个事件异步发送到日志服务，日志服务不可用时终端仍按原逻辑继续或失败，不显示额外阻塞错误。

Windows 的管理员 PowerShell/WSL 动作只返回固定结构化事实和错误；生命周期事件由外层 Node 安装器记录，避免把凭据或原始管理员输出写入遥测。

## 四、事件模型

事件使用 `rainskills.lifecycle-event.v1`：

```json
{
  "schema": "rainskills.lifecycle-event.v1",
  "event_id": "uuid",
  "install_attempt_id": "uuid",
  "operation_id": "uuid-or-null",
  "installation_id": "uuid-or-null",
  "parent_event_id": "uuid-or-null",
  "sequence": 7,
  "attempt": 1,
  "resumed_from": "uuid-or-null",
  "package_version": "1.0.0",
  "platform": "darwin|linux|win32",
  "control_mode": "posix|wsl|windows-native",
  "target": "local-linux|local-macos|local-windows|remote-linux",
  "client": "codex|claude_code|pi|unknown",
  "phase": "preflight",
  "step": "resource_check",
  "action": "install|refresh|null",
  "lifecycle_action": "preflight",
  "status": "started|completed|blocked|failed|interrupted|skipped",
  "duration_ms": 1234,
  "error_code": "containerd_not_ready",
  "error_stage": "verify_console",
  "reason_code": "containerd_not_ready",
  "blocked_reason": "awaiting_user_confirmation-or-null",
  "interrupt_signal": "SIGINT-or-null",
  "transport": "direct|ssh|wsl|powershell-or-null",
  "auth_method": "device_flow|browser_loopback|browser_manual|jwt_flag|legacy_password|null",
  "retryable": true,
  "exit_code": 1,
  "http_status": 502,
  "created_at": "2026-08-06T00:00:00.000Z"
}
```

所有字段均为固定白名单；未适用字段显式使用 `null`，没有 `metadata` 或任意自由文本字段。错误代码、阶段、步骤、动作、传输方式和认证方式使用稳定的小写枚举；失败“原因”只通过 `error_code`/`reason_code` 表达，不上传原始错误文本。

阶段枚举至少包含：`bootstrap`、`target_selection`、`preflight`、`confirmation`、`prepare_wsl`、`rootfs_download`、`import_distro`、`prepare_runtime`、`prepare_docker`、`install_rainbond`、`configure_network`、`verify_console`、`authorize_device_flow`、`authorize_legacy`、`configure_mcp`、`resume`、`completed`。

步骤枚举至少包含：`select_target`、`inspect_host`、`resource_check`、`port_check`、`confirm_install`、`enable_wsl`、`request_reboot`、`download_rootfs`、`import_distro`、`prepare_runtime`、`prepare_docker`、`install_rainbond`、`configure_network`、`verify_console`、`device_code`、`browser_callback`、`legacy_callback`、`verify_mcp`、`configure_mcp`、`resume`、`finalize`。

`lifecycle_action` 枚举为固定小写值：`preflight`、`prepare_wsl`、`request_reboot`、`update_wsl`、`verify_wsl`、`import_distro`、`prepare_runtime`、`configure_network`、`verify_network`、`prepare_docker`、`install_rainbond`、`verify_deployment`、`converge_platform`、`authorize`、`configure_mcp`、`resume`、`finalize` 或 `null`。顶层 `action` 始终保留旧安装摘要值 `install`、`refresh` 或 `null`。Windows PowerShell action 写入 `lifecycle_action` 前统一转小写。

`error_stage` 只允许阶段枚举值或 `null`；`error_code`/`reason_code` 只允许错误分类枚举值或 `null`；`auth_method` 只允许 `device_flow`、`browser_loopback`、`browser_manual`、`jwt_flag`、`legacy_password` 或 `null`。

阻塞原因枚举至少包含：`awaiting_user_confirmation`、`awaiting_reboot`、`awaiting_device_authorization`、`device_authorization_pending`、`device_authorization_denied`、`device_authorization_expired`、`ssh_password_prompt`、`manual_console_input`、`resource_below_floor`、`unknown`。中断信号只允许 `SIGINT`、`SIGTERM`、`CTRL_C`、`reboot` 或 `null`。

## 五、整体架构

### 5.1 本地记录

- POSIX：`~/.rainbond/rainskills/telemetry/`；
- Windows：通过现有 Windows 安全状态存储定位用户目录并使用同等 ACL；
- 每次运行一个受保护 JSONL 文件，事件先落盘再尝试上传；
- 文件写入使用追加 + `0600`/Windows ACL，拒绝符号链接和目录越界；
- 仅保留固定大小和固定天数的诊断记录，避免磁盘无限增长。

平台现有的 `platform-installer/<operation_id>/events.jsonl` 保持兼容，生命周期事件使用独立文件或明确的 schema，不破坏现有 Windows 进度解析器。

### 5.2 远程上报

- 目标固定为 `https://log.rainbond.com` 下的 RainSkills 安装统计接口；默认沿用现有 `/api/rainskills/installations` 接口，保留旧摘要字段并增加事件白名单字段；
- 使用短连接、短超时和有限重试；单事件请求总预算不超过 5 秒，发送在后台执行，不等待服务响应，也不向 stdout/stderr 注入网络错误；
- DNS 失败、连接失败、超时、4xx、5xx、TLS 错误和服务返回非法响应都归类为 `telemetry_delivery_failed`，只保留本地待发送事件，不改变安装、授权、配置或子进程的退出码；
- 本地目录不可写、磁盘空间不足、队列损坏或后台 sender 启动失败也只产生本地 best-effort 诊断，不能覆盖原始业务错误或把成功改成失败；
- SIGINT、SIGTERM、Windows 终止和重启前只做非阻塞落盘，禁止等待网络发送；
- 后续 RainSkills 执行时尽力补发未发送事件，使用 `event_id` 幂等；过期（7 天）或超过 10 MB/1000 条上限的事件自动丢弃并写入本地丢弃计数；
- 发送器不继承 Token、密码或完整环境变量，且不把请求内容写入错误日志。

每次请求发送单个 JSON 事件，事件包含 `schema`、`event_id`、`install_attempt_id`、阶段字段以及现有兼容摘要字段。顶层 `action` 始终是旧的 `install/refresh` 值，新的生命周期动作只放在 `lifecycle_action`；旧服务即使忽略未知字段，也不会把 `preflight` 误读为旧 action。服务端 rollout 必须为 `event_id` 建立唯一约束或幂等键：同一事件重复 POST 必须返回 2xx 且只计数一次。客户端不能依赖响应正文。

兼容 rollout 分两步：新服务先接受事件 schema 并按 `event_id` 去重；若服务明确返回 schema 不兼容的 400/415/422（带固定错误码或响应头），客户端才把事件投影为旧字段集合（`install_attempt_id`、`eid`、`install_client`、`action`、`phase`、`status`、`failure_stage`、`failure_category`）发送一次 legacy 请求。映射固定为：`status=started` → `phase=started,status=started`；`phase=authorize_device_flow|authorize_legacy` 且 `status=completed` → `phase=authorized,status=success`；`phase=configure_mcp` 且 `status=completed` → `phase=configured,status=success`；`status=failed|blocked|interrupted` → `phase=failed,status=failure`，`failure_stage=error_stage`，`failure_category=error_code|blocked_reason|interrupted`；其他完成阶段保留 `phase=started,status=started`，不伪造授权或配置成功。`eid`、`install_client` 和顶层 `action` 沿用本次安装上下文；直接平台安装默认 `action=install`，`refresh` 仅来自 `install.sh refresh`。

DNS 失败、连接超时、TLS 错误、5xx 或响应丢失属于不确定投递结果，只允许重试相同 JSON 和相同 `event_id`，禁止切换到 legacy 请求；旧服务必须通过 `Idempotency-Key: event_id` 或已部署的唯一键避免重复。若明确 schema 不兼容后 legacy 请求也失败，只保留本地队列。固定 JSON golden/contract 测试覆盖新服务、旧服务忽略未知字段、旧服务明确拒绝未知字段、每个阶段到旧四类摘要的映射、网络重试和重复 `event_id`。

`install_attempt_id` 在首次 `install.sh` 启动时生成并写入 onboarding 状态；`platform install`、`resume`、重启后继续和 SIGINT 后恢复都沿用该 ID。直接执行没有 onboarding 状态的 `platform install` 时生成新的 ID。每个操作目录另有 `operation_id`，事件通过 `operation_id`、`installation_id`、`parent_event_id` 和单调递增 `sequence` 还原阶段顺序；恢复运行使用 `resumed_from` 指向上一次未完成操作的最后事件，不重新创建 install attempt。

### 5.3 入口覆盖

- `install.sh`：启动、目标选择、授权、MCP 配置和终止信号；
- `platform-installer.js`：本地/远程目标选择、预检、确认、下载、安装、验证、恢复；
- `windows-platform.js` 与 PowerShell action：由 Node 外层围绕每个固定 action 记录结果，不改变 helper 合约；
- `windows-onboarding.js`：记录 Windows 原生授权流程的阶段结果；
- 应用部署继续由 Rainbond Console 的现有部署服务负责，本仓库不新增第二套应用部署上报。

### 5.4 覆盖矩阵

| 控制端 | 目标 | 关键事件 | 传输标识 |
| --- | --- | --- | --- |
| macOS | local-macos（OrbStack） | 预检、确认、下载、Docker/Rainbond、Console、设备授权/兼容授权 | `direct` |
| Linux | local-linux | 预检、确认、Docker/Rainbond、Console、设备授权/无浏览器授权 | `direct` |
| Windows 原生 | local-windows | UAC、WSL 准备、重启等待/恢复、rootfs、WSL/Docker、网络、Rainbond、双侧验证、授权 | `powershell` / `wsl` |
| WSL 控制端 | local-windows | Windows WSL 本地安装、管理员动作、重启等待/恢复、rootfs、WSL/Docker、网络、Rainbond、双侧验证、授权 | `wsl` / `powershell` |
| Windows/WSL 控制端 | remote-linux | SSH 预检、认证等待/超时、远程目录/脚本、安装、远程验证、授权 | `ssh` |
| macOS/Linux | remote-linux | SSH 预检、认证等待/超时、远程目录/脚本、安装、远程验证、授权 | `ssh` |

合法组合固定为：`posix+local-linux+direct`、`posix+local-macos+direct`、`windows-native+local-windows+powershell|wsl`、`wsl+local-windows+wsl|powershell`、以及任意控制端的 `remote-linux+ssh`。组合不匹配时上报 `invalid_arguments` 后沿用原业务错误。`control_distro`、SSH 主机和 Console 地址不写入事件；仅记录 `transport`、`auth_method` 和目标枚举。Windows action 名称进入 `lifecycle_action` 白名单，WSL 发行版版本只记录受限版本号事实，不记录路径或命令输出。重启等待写 `status=blocked, blocked_reason=awaiting_reboot`；设备码轮询写 `status=blocked, blocked_reason=device_authorization_pending`；用户取消/进程信号分别写 `user_cancelled`/`interrupted`。

## 六、错误与隐私

标准错误分类至少覆盖：`invalid_arguments`、`preflight_blocked`、`user_cancelled`、`network_unreachable`、`download_failed`、`ssh_auth_failed`、`ssh_timeout`、`wsl_not_ready`、`docker_not_ready`、`containerd_not_ready`、`rainbond_deploy_failed`、`console_unreachable`、`authorization_failed`、`device_authorization_pending`、`device_authorization_denied`、`device_authorization_expired`、`mcp_verification_failed`、`configuration_failed`、`interrupted` 和 `unknown`。

本地生命周期事件和远程上传都只使用上述枚举 allowlist；不保存任何原始错误文本，因此无需依赖“先正则过滤再上传”的安全假设。测试仍必须向事件构造器注入恶意 URL、URL userinfo/query/fragment、JWT/Bearer/Basic、`--token`/`--password`、PowerShell/WSL 输出和 SSH 参数，并证明这些输入只能得到固定 `error_code`/`reason_code`，不会出现在 JSONL 或 HTTP body。现有 `install.log` 的原始安装器输出仍只保留本地、从不上传；它沿用现有日志脱敏规则。`eid`、旧安装摘要字段仍可按现有接口契约发送，但不得把它们拼接进 URL 或日志文本。

## 七、实施计划

### 跨层覆盖检查

- [ ] Rainbond Go：不涉及；
- [ ] Rainbond Console/Python：不涉及应用部署统计，复用其已有 `/api/rainskills/deployments`；
- [ ] Rainbond UI：不涉及；
- [x] RainSkills Shell/Node/PowerShell：实现统一安装与平台生命周期事件。

应用部署回归边界：平台阶段的 `install_rainbond` 只表示 Rainbond 平台本身，不表示应用/组件部署；RainSkills 不调用 `/api/rainskills/deployments`，不生成 `deploy_attempt_id`，不复制或覆盖 Console 的 `RainSkillsDeploymentService`。

### Sprint 1：事件基础设施

1. 新增共享事件规范、枚举、脱敏和本地安全 JSONL 写入器；
2. 新增 best-effort 远程发送和失败留存；
3. 为 POSIX 与 Windows 分别补充单元测试和安全路径测试。

### Sprint 2：安装与平台接入

1. 接入 `install.sh` 的启动、授权、配置、失败和中断路径；
2. 接入平台安装器的目标选择、预检、远程 SSH、下载、部署、验证和恢复路径；
3. 接入 Windows 固定 action 的开始/完成/阻塞/失败事件；
4. 更新 README 和故障排查文档，说明本地诊断文件位置和隐私边界。

### 验收标准

- 当本地遥测目录可写时，任意支持平台的每次安装都能在本地找到完整阶段链；目录不可写、磁盘已满、队列损坏或进程被强制终止时，遥测链允许缺失，但业务流程、原始错误和退出码必须与关闭遥测时一致；
- 在任意阶段失败、阻塞、中断或恢复时，最后一条事件包含阶段、步骤、稳定错误分类/阻塞原因、可重试性、序号和关联 ID；
- 日志服务 DNS 失败、连接超时、TLS 错误、4xx/5xx、非法响应、本地目录不可写或磁盘已满时，安装业务结果与无遥测版本一致；
- `event_id` 重试和进程重启不会导致服务端重复计数；旧 `/api/rainskills/installations` 接口忽略未知字段时，旧四类摘要仍可解析；
- Windows CI 的 PowerShell 合约、macOS/Linux 测试和完整 npm 测试通过；测试覆盖 WSL/SSH/授权/中断/恢复、schema golden、脱敏、安全路径和遥测发送失败矩阵；
- 明确验证平台安装事件不会调用或复制应用部署上报接口；
- tarball 不包含两个禁止提交的旧计划文件，也不包含 Token、密码或原始命令输出。
