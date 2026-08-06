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
  "package_version": "1.0.0",
  "platform": "darwin|linux|win32",
  "control_mode": "posix|wsl|windows-native",
  "target": "local-linux|local-macos|local-windows|remote-linux",
  "client": "codex|claude_code|pi|unknown",
  "phase": "preflight",
  "status": "started|completed|blocked|failed|interrupted|skipped",
  "duration_ms": 1234,
  "error_code": "containerd_not_ready",
  "error_stage": "verify_deployment",
  "retryable": true,
  "exit_code": 1,
  "http_status": 502,
  "created_at": "2026-08-06T00:00:00.000Z"
}
```

字段采用白名单；错误代码和阶段使用稳定的小写枚举。错误摘要只保留脱敏、截断后的分类信息，所有可能包含凭据的字段先过滤。

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
- 使用短连接、短超时和有限重试；发送在后台执行，不等待服务响应；
- 上传失败只保留本地待发送事件并记录 `telemetry_delivery_failed`，不改变安装、授权或配置的退出码；
- 后续 RainSkills 执行时尽力补发未发送事件，过期或超过大小上限的事件自动丢弃并写入本地丢弃计数。

### 5.3 入口覆盖

- `install.sh`：启动、目标选择、授权、MCP 配置和终止信号；
- `platform-installer.js`：本地/远程目标选择、预检、确认、下载、安装、验证、恢复；
- `windows-platform.js` 与 PowerShell action：由 Node 外层围绕每个固定 action 记录结果，不改变 helper 合约；
- `windows-onboarding.js`：记录 Windows 原生授权流程的阶段结果；
- 应用部署继续由 Rainbond Console 的现有部署服务负责，本仓库不新增第二套应用部署上报。

## 六、错误与隐私

标准错误分类至少覆盖：`invalid_arguments`、`preflight_blocked`、`user_cancelled`、`network_unreachable`、`download_failed`、`ssh_auth_failed`、`ssh_timeout`、`wsl_not_ready`、`docker_not_ready`、`containerd_not_ready`、`rainbond_deploy_failed`、`console_unreachable`、`authorization_failed`、`mcp_verification_failed`、`configuration_failed`、`interrupted` 和 `unknown`。

遥测过滤以下内容：JWT、Bearer/Basic 认证头、密码/Token/Secret/API Key 赋值、SSH 用户凭据、完整 URL 查询参数和原始命令输出。错误文本长度固定上限，退出码和 HTTP 状态码单独存储。

## 七、实施计划

### 跨层覆盖检查

- [ ] Rainbond Go：不涉及；
- [ ] Rainbond Console/Python：不涉及应用部署统计，复用其已有 `/api/rainskills/deployments`；
- [ ] Rainbond UI：不涉及；
- [x] RainSkills Shell/Node/PowerShell：实现统一安装与平台生命周期事件。

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

- 任意支持平台的每次安装都能在本地找到完整阶段链；
- 在任意阶段失败时，最后一条事件包含阶段、状态、标准错误分类和可重试性；
- 日志服务 DNS 失败、连接超时、5xx 或拒绝请求时，安装业务结果与无遥测版本一致；
- Windows CI 的 PowerShell 合约、macOS/Linux 测试和完整 npm 测试通过；
- tarball 不包含两个禁止提交的旧计划文件，也不包含 Token、密码或原始命令输出。

