# RainSkills Windows 平台状态收敛设计

## 一、项目背景

### 1.1 项目架构

RainSkills 在 Windows 上管理一个专用的 `Rainbond` WSL2 发行版。Windows 侧负责受保护的机器 helper、计划任务、固定 `/30` 网络和 `127.0.0.1` 端口转发；WSL 内负责 Docker、Rainbond 外层容器、K3s 和 Console。授权流程由 Windows 用户进程访问 `http://127.0.0.1:7070`。

当前访问链保持不变：

```text
Windows 127.0.0.1:7070
  -> netsh portproxy
  -> RainSkills 固定 guest 地址 172.31.X.2:7070
  -> WSL 固定 /30 地址和 DOCKER 链转发
  -> Rainbond 外层容器
  -> K3s rbd-app-ui / Console
```

### 1.2 现有基础

现有实现已经具备专用 WSL2 发行版、固定子网选择、受保护机器 bundle、Windows 网络与 keepalive 计划任务、WSL systemd 网络恢复、Docker/Rainbond 安装和续接授权。rc.39 修复了一个显式的网络 service 重启入口，rc.40 修复了授权续接前机器 helper 未升级的问题。

现场证据表明，授权期间 `rainbond` 外层容器的 `StartedAt` 仍发生变化，旧版本计划任务或恢复 bundle 仍可能执行会重启 Docker 的脚本。现有 checkpoint 可以让流程直接进入授权，但不能证明网络、Docker、K3s 和 Console 在当前时刻稳定。

### 1.3 核心需求

1. Windows 的 WSL 安装、管理、网络维护、Rainbond 启动和授权必须自动完成。
2. 保留现有专用 WSL2 与固定网络架构，不推翻已有工作。
3. 每次 `platform install` 和 `resume` 都依据真实系统事实决定复用、修复、阻塞或要求重装，不能只依赖 checkpoint。
4. 健康的旧安装必须原地迁移，不重新下载 Ubuntu、不删除 Rainbond、不重新执行 onboarding。
5. 运行期网络修复不得停止或重启正在运行的 Docker、`rainbond` 容器或 K3s。
6. 授权前必须证明 Console 与 Device Flow 接口可用，并证明 Rainbond 运行时没有继续重启。
7. macOS、Linux 和远程 Linux 安装逻辑不发生行为变化。

## 二、用户旅程

### 2.1 用户操作流程

用户继续使用现有命令：

```text
npx --yes rainskills@<version> platform install --onboarding-id <id>
npx --yes rainskills@<version> resume --onboarding-id <id>
```

Windows 本地流程统一为：

```text
读取 onboarding 与 installation_id
  -> 检查并升级当前版本的恢复 bundle
  -> 检查 Windows / WSL / 网络 / Docker / Rainbond 事实
  -> 只修复缺失或错误的受管对象
  -> 验证运行时稳定和 Device Flow 能力
  -> 打开浏览器并继续授权
```

健康旧环境直接复用。网络地址、端口转发、计划任务或 helper 版本不一致时自动原地修复。Docker 或 Rainbond 原本停止时允许自动启动；已经运行时不允许为修复网络而重启。

用户只在确实需要写入受保护机器状态时看到一次 UAC。失败时输出具体层级、动作和原因，不再只显示 `fetch failed`。

### 2.2 页面原型

不新增 UI 页面。现有浏览器授权页面继续使用。终端增加两类简洁状态：

- `正在检查并修复 Windows 本地 Rainbond 环境`
- `Windows 本地 Rainbond 已稳定，正在继续授权`

发生阻塞时显示稳定错误码和可操作原因，例如 `WINDOWS_TASK_CONTRACT_MISMATCH`、`WSL_NETWORK_UNREACHABLE`、`K3S_NOT_READY`、`CONSOLE_DEVICE_FLOW_UNAVAILABLE`，同时保留脱敏日志位置。

### 2.3 外部系统交互

不新增 webhook、回调或第三方系统。继续使用 Rainbond Console 的 Device Flow 接口：

```text
POST /console/mcp/device/code
Content-Type: application/x-www-form-urlencoded
client_id=rainskills&scope=mcp
```

接口必须返回 `2xx`，响应 JSON 必须包含现有 Windows Device Flow 授权逻辑要求的字段：非空 `device_code`、符合现有格式的 `user_code`、正整数 `expires_in` 和正整数 `interval`。`404`、其他非 `2xx`、无效 JSON、字段不完整、连接重置、超时和无 HTTP 响应都视为 Device Flow 尚不可用，不进入授权。探测产生的 device code 不写入状态或日志，也不用于后续授权；正式授权仍重新申请一次 code。

## 三、整体架构设计

### 3.1 系统架构图

```text
platform install / resume
        |
        v
Windows-only convergence controller
  Inspect -> Plan -> Reconcile -> Stabilize -> Verify
        |                                  |
        |                                  v
        |                          Browser authorization
        v
Protected Windows helper
  machine bundle / tasks / host network / portproxy
        |
        v
Dedicated Rainbond WSL2
  guest address / iptables / Docker / Rainbond / K3s / Console
```

`local-macos`、`local-linux` 和 `remote-linux` 不进入该控制器，继续执行现有分支。

### 3.2 核心流程

1. **Inspect**：读取受保护机器 bundle、计划任务、发行版身份、固定网络、Docker 服务、Rainbond 容器启动时间、K3s 和 Console 事实。
2. **Plan**：将状态分类为 `reused`、`repair_required`、`blocked` 或 `reinstall_required`。
3. **Reconcile**：只修复 RainSkills 拥有的对象。运行时网络修复直接调用幂等 helper，不重启 systemd network unit，也不传播停止 Docker。
4. **Stabilize**：若 Docker/Rainbond 原本停止则启动并建立新基线；若原本运行则保持不变。每轮连续三次探测必须成功，探测间隔为 5 秒，并且 `rainbond` 容器 `StartedAt` 保持一致。`StartedAt` 变化时重新建立基线，最多执行三轮，整体预算为 120 秒；仍不稳定时返回 `RAINBOND_RUNTIME_UNSTABLE`。
5. **Verify**：验证 Windows loopback Console 可用，并验证 Device Flow endpoint 返回 `2xx` 和符合既有授权契约的 JSON。
6. **Authorize**：只有最新事实通过后才写入 `authorizing` 并启动浏览器授权。

收敛动作使用 installation 级全局互斥，防止安装、登录计划任务、keepalive 与 `resume` 同时修改同一个本地平台。锁过期后可以回收，但必须验证持有者进程或租约时间。

## 四、数据模型设计

### 4.1 新增数据库表

不新增数据库。继续使用现有受保护 onboarding/platform JSON 状态和 `%ProgramData%` 机器 manifest。

Windows platform 状态补充以下事实：

```json
{
  "convergence_status": "reused|repaired|blocked|reinstall_required",
  "machine_bundle_version": "0.1.0-rc.N",
  "machine_bundle_manifest_sha256": "<sha256>",
  "rainbond_started_at": "<docker timestamp>",
  "stable_probe_count": 3,
  "device_flow_http_reachable": true,
  "last_repair_actions": [],
  "last_converged_at": "<iso8601>"
}
```

这些字段是最近一次检查的上下文，不是跳过检查的依据。

### 4.2 数据关系

`operation_id` 标识一次 onboarding 操作；`installation_id` 标识当前设备上的受管 Rainbond 安装。机器 bundle、网络 manifest、计划任务和全局租约都必须绑定同一个 `installation_id`。发现同名对象属于其他 installation 时不得覆盖，返回明确冲突。

恢复 bundle 采用当前 npm 包生成的 manifest 和哈希。机器 manifest 必须同时记录 helper、bootstrap、恢复入口和恢复 manifest 哈希，任一不一致都触发原子升级。

## 五、API 设计

### 5.1 接口列表

不新增公共 HTTP API。Windows PowerShell helper 增加固定 action：

| Action | 权限 | 用途 |
| --- | --- | --- |
| `InspectInstalledPlatform` | 只读，普通权限优先 | 返回机器 bundle、任务、WSL、网络和运行时事实 |
| `ConvergeInstalledPlatform` | 管理员 | 原子升级 bundle，并只修复缺失或错误的受管对象 |
| `VerifyInstalledPlatform` | 只读 | 返回容器启动时间、K3s、Console 和 Device Flow 连通事实 |

action 名必须加入现有固定 allowlist；request/result 继续使用既有 schema、nonce、operation/installation identity 和安全路径校验。

### 5.2 请求/响应结构

请求复用现有机器 bundle payload，并包含期望的 package version 与各文件哈希。响应只返回结构化事实，不允许返回可执行命令或脚本字段。

失败统一包含：

```json
{
  "failureCode": "CONSOLE_DEVICE_FLOW_UNAVAILABLE",
  "failureLayer": "console",
  "failureMessage": "device-code endpoint reset the connection"
}
```

敏感参数、Token、Device Code 和授权响应不得写入日志或状态。

## 六、核心实现设计

### 6.1 关键逻辑

#### Windows 入口统一收敛

`platform install` 遇到 `platform-ready`/`authorizing`，以及 `resume` 遇到 Windows 本地安装时，都先调用同一个 `ensureWindowsPlatformConverged`。checkpoint 不再直接绕过平台验证。

#### 旧环境原地迁移

现有 `installation_id`、Rainbond WSL 发行版、数据目录、固定子网和容器继续使用。收敛流程升级受保护 bundle 和登录/keepalive/恢复任务，使任务引用当前 package 版本。禁止因版本升级重新导入发行版或重新执行 Rainbond 安装脚本。

只有以下情况返回 `reinstall_required`：

- `Rainbond` 发行版或 `%ProgramData%` 机器根存在，但 installation identity 无法证明属于当前安装；
- 受管数据根存在不可安全恢复的路径类型或 ACL/owner 冲突；
- 固定网络对象与未知所有者冲突，且原地迁移会覆盖非 RainSkills 配置。

端口冲突、UAC 拒绝、VPN/企业策略、Docker/K3s 暂时未就绪属于 `blocked`，不要求重装。

#### Docker 生命周期隔离

启动时仍保证网络先于 Docker 准备，但 systemd 依赖不得使 network-ready unit 的停止或重启传播到 Docker。运行期只直接执行 guest network restore helper；helper 只恢复地址、路由和 iptables，不执行 `systemctl restart docker`、`systemctl stop docker` 或重启 `rainbond`。

#### 稳定性与授权门控

每轮验证记录外层容器 `StartedAt`，检查 K3s node/component readiness、WSL Console 和 Windows loopback Console。连续三次、每次间隔 5 秒成功且 `StartedAt` 不变后，再对 Device Flow 执行一次 `2xx` 与响应结构验证。若在窗口内变化则重新建立基线；最多三轮且整体不超过 120 秒，超限返回 `RAINBOND_RUNTIME_UNSTABLE`。Device Flow 非 `2xx` 或响应无效返回 `CONSOLE_DEVICE_FLOW_UNAVAILABLE`。

#### 任务最终清理

授权在后续单独执行 `resume` 成功时，也必须清理一次性 machine/user recovery task；永久 network/keepalive task 保留并验证为当前版本契约。

### 6.2 复用现有代码

- 复用 `windowsRecoveryBundle`、`buildWindowsMachineBundlePayload`、固定 action allowlist 和 PowerShell request/result schema。
- 复用 `Invoke-InstallMachineBundle` 的 identity、digest 和 ACL 校验。
- 复用现有 WSL bootstrap 的地址、路由和 DOCKER 链修复函数。
- 复用 `evaluateWindowsDeployment`，扩展为稳定性和 Device Flow 事实验证。
- 复用现有 `runResume` 与 `completePlatform`，只调整 Windows 本地的前置门控。

## 七、实施计划

### 跨层覆盖检查

- [ ] Go (rainbond): 不涉及 - 不修改 Rainbond Region API 或 Kubernetes 控制逻辑
- [ ] Python (console): 不涉及 - 当前问题先在安装/生命周期层解决；Device Flow endpoint 仅作为能力探测
- [ ] React (rainbond-ui): 不涉及 - 不新增页面或修改授权页面
- [ ] Plugin frontend (enterprise-base): 不涉及
- [ ] Plugin backend (plugin-template): 不涉及
- [x] RainSkills Node.js: 需要 - Windows 收敛控制器、状态门控、错误诊断与恢复任务版本升级
- [x] RainSkills PowerShell: 需要 - 固定 inspect/converge/verify action、全局租约与受管对象原地修复
- [x] RainSkills WSL shell: 需要 - 隔离启动门控与运行时网络修复，禁止传播 Docker 重启

### Sprint 1: 建立 Windows 收敛契约

#### Task 1.1: Windows 入口与稳定性门控

- 仓库：rainskills
- 文件：`rainbond-platform-installer/scripts/platform-installer.js`、`tests/platform-installer.test.js`
- 实现内容：统一 install/resume 的 Windows 收敛入口，验证三次稳定事实和 Device Flow 响应，提供分层错误。
- 验收标准：Windows cached stage 不再绕过收敛；macOS/Linux/remote 分支测试保持不变。

#### Task 1.2: 机器 bundle 和计划任务原地升级

- 仓库：rainskills
- 文件：`rainbond-platform-installer/scripts/windows-platform.js`、`rainbond-platform-installer/scripts/windows-platform.ps1`、`tests/windows-platform.test.js`、`tests/windows-contract.ps1`
- 实现内容：增加固定收敛 actions、installation 级租约、完整 bundle 哈希与当前版本任务契约；仅修复受管对象。
- 验收标准：rc.38/rc.39/rc.40 状态可原地迁移，旧任务不再执行旧 helper/package。

### Sprint 2: 隔离网络与 Docker 生命周期

#### Task 2.1: WSL 网络恢复不重启运行时

- 仓库：rainskills
- 文件：`rainbond-platform-installer/scripts/wsl-bootstrap.sh`、`tests/windows-platform.test.js`、`tests/windows-contract.ps1`
- 实现内容：调整 systemd 依赖和 runtime restore 契约，确保运行中的 Docker/Rainbond 不因网络维护被停止或重启。
- 验收标准：静态合同测试禁止运行期 Docker restart/stop；启动期仍保证固定地址与转发先就绪。

### Sprint 3: 集成验证和发布准备

#### Task 3.1: 迁移矩阵与完整验证

- 仓库：rainskills
- 文件：`tests/platform-installer.test.js`、`tests/windows-platform.test.js`、`tests/windows-contract.ps1`、`docs/windows-local-install-acceptance.md`
- 实现内容：覆盖健康复用、局部修复、停止后启动、持续重启、旧 bundle/task、Device Flow 不可用和非 Windows 回归。
- 验收标准：相关 Node 测试、完整 `npm test`、构建、npm tarball 和 Windows GitHub contracts 全部通过。

## 八、关键参考代码

| 功能 | 文件 | 说明 |
| --- | --- | --- |
| Windows 安装/续接编排 | `rainbond-platform-installer/scripts/platform-installer.js` | `runResume`、Windows provision、状态迁移和授权入口 |
| Windows Node adapter | `rainbond-platform-installer/scripts/windows-platform.js` | 固定 actions、schema 校验、部署事实评估 |
| Windows 高权限 helper | `rainbond-platform-installer/scripts/windows-platform.ps1` | bundle、任务、网络、WSL 和 Rainbond 固定动作 |
| WSL bootstrap | `rainbond-platform-installer/scripts/wsl-bootstrap.sh` | systemd、Docker、网络恢复和 Rainbond 安装 |
| Node 编排测试 | `tests/platform-installer.test.js` | install/resume 路径与非 Windows 回归 |
| Windows contract 测试 | `tests/windows-platform.test.js`、`tests/windows-contract.ps1` | PowerShell、WSL 和任务契约 |
