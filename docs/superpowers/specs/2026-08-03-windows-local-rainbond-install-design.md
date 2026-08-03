# Windows 本地 Rainbond 自动安装设计

## 文档关系

本文是 [2026-08-02-rainbond-platform-installer-design.md](./2026-08-02-rainbond-platform-installer-design.md) 的增量设计，只扩展 Rainbond 单机平台安装能力。

本文生效后，旧设计中以下约束被替代：

- Windows 不再只作为远程 Linux 的控制端；Windows 10/11 x64 可以选择“安装到本地”。
- Linux、macOS、Windows 的交互入口统一为“安装到本地”或“安装到 Linux 服务器”，不再显示按操作系统区分的推荐项。
- 平台状态机增加 Windows WSL2 准备、重启等待、发行版导入和 Windows 侧网络维护阶段。

旧设计中的 RainSkills onboarding、Linux/macOS 安装、远程 SSH、安全确认、进度事件、Rainbond 健康验证和授权续接规则继续有效。发生冲突时，仅 Windows 本地安装相关内容以本文为准。

## 一、目标与范围

### 1.1 目标

让不熟悉 Windows、WSL、Docker 或 Rainbond 的用户，在 AI 或终端引导下完成 Windows 本地单机 Rainbond 安装。正常流程只要求用户：

1. 选择“安装到本地”；
2. 查看预检结果和系统变更后确认一次；
3. Windows 必须重启时，再明确确认是否现在重启。

其余可确定的工作由安装器自动完成，包括启用 WSL2、准备专用 Linux 环境、下载并校验文件、安装运行时和 Rainbond、恢复中断流程、验证 Console、把 Console 地址写回 RainSkills 并继续浏览器授权。

### 1.2 首版支持范围

- Windows 10 版本 2004、内部版本 19041 及以上的 x64 桌面系统；
- Windows 11 x64 桌面系统；
- 当前 Windows 设备上的 Rainbond 单机版；
- 从原生 Windows PowerShell、Command Prompt 或 Windows Terminal 运行 `npx rainskills`；
- 从 WSL2 内的 Codex、Claude Code、OpenClaw 或终端运行 `npx rainskills`，由安装器桥接到 Windows 宿主完成平台准备；
- 专用且由 Rainskills 管理的 WSL2 发行版；
- Windows 当前用户可打开浏览器并访问本地 Console 的场景；
- 既有“安装到 Linux 服务器”的 SSH 路径；
- 安装中断、终端关闭和必要重启后的幂等续装。

### 1.3 首版不支持

- Windows Server；
- Windows on ARM；
- Windows 7、8、8.1 或低于要求的 Windows 10；
- 多节点、高可用、离线或已有 Kubernetes 安装；
- 把 Rainbond 安装进用户已有的 Ubuntu、Docker Desktop 或其他 WSL 发行版；
- 自动修改 BIOS/UEFI 虚拟化设置；
- 当前登录用户不是本机 Administrators 成员，或 UAC 使用了另一个管理员账户凭据的场景；
- 绕过企业策略、安全软件、代理或下载限制；
- 自动停止占用端口的服务、删除已有 WSL 发行版、删除 Rainbond 数据或覆盖未知网络转发规则；
- 无浏览器控制端的授权方案。该场景继续使用 RainSkills 已定义的 Device Flow 或人工续接能力。

## 二、用户旅程

### 2.1 统一选择入口

当用户选择私有化部署且当前没有 Rainbond 平台时，安装器先识别当前操作系统，再统一展示：

```text
请选择 Rainbond 安装位置：

1) 安装到本地
2) 安装到 Linux 服务器
请输入选项 [1-2，回车默认 1]:
```

交互中不显示“推荐”文字。选择结果按控制端系统解析：

| 控制端 | 安装到本地 | 安装到 Linux 服务器 |
| --- | --- | --- |
| Linux | 当前 Linux 设备 | 通过 SSH 安装 |
| macOS | 当前 Mac，通过 OrbStack | 通过 SSH 安装 |
| Windows | 当前 Windows，通过专用 WSL2 | 通过 SSH 安装 |

命令行内部继续保留 `local-linux`、`local-macos` 和 `remote-linux` 以兼容已发布调用，并新增 `local-windows`。交互标签不暴露这些内部名称。

### 2.2 Windows 预检与一次确认

选择本地后，先执行只读预检。通过时只展示用户需要判断的信息：

```text
检测到 Windows 11 x64，环境检查已通过：

8 核 CPU / 16GB 内存 / 126GB 可用磁盘
WSL2 可以自动准备
端口和网络检查正常

安装将创建专用的 Rainbond WSL2 环境，并配置开机后自动启动。
首次准备需要下载系统和 Rainbond 文件，是否继续？ [Y/n]:
```

若 WSL2 已可用，“WSL2 可以自动准备”改为“WSL2 已就绪”。确认内容必须按实际情况列出以下变更：

- 启用 `Microsoft-Windows-Subsystem-Linux` 和 `VirtualMachinePlatform` 可选功能；
- 安装或更新 Microsoft WSL2 运行组件；
- 创建名为 `Rainbond` 的专用 WSL2 发行版及其数据目录；
- 在专用发行版中安装 Docker Engine 和 Rainbond；
- 创建 Rainskills 管理的 Windows 端口转发和登录启动任务；
- 可能需要 Windows 重启。

未确认前不得执行任何改变系统状态的命令。资源不足、端口冲突或已有同名但不受 Rainskills 管理的发行版时，只展示失败项和处理方向，不展示一长串成功项。

### 2.3 重启体验

只有 Windows 返回“必须重启”时才进入重启步骤：

```text
WSL2 组件已准备完成，需要重启 Windows 后继续。
安装进度已经保存，登录后会自动继续，不需要重新选择。

是否现在重启？ [y/N]:
```

- 默认不重启；必须由用户明确输入确认。
- 用户同意后，安装器先验证续装任务和本地恢复包均可用，再调用系统重启。
- 用户不同意或当前是非交互终端时，保留状态并输出一条固定参数的续装命令。
- 重启登录后，Windows 任务计划打开一个可见终端，使用固定版本的本地恢复包继续，不依赖已经消失的 npx 临时缓存，也不要求 AI 会话跨重启存活。
- 续装进程完成或被用户取消后，删除一次性重启续装任务；安装成功后仅保留维持本地 Rainbond 运行所需的登录启动任务。

### 2.4 进度展示

下载显示真实字节、速度和百分比；没有总大小时不伪造百分比。非下载操作按阶段展示：

```text
[1/6] WSL2 运行环境已就绪
[2/6] 专用 Rainbond 环境已创建
[3/6] Docker Engine 已启动
[4/6] Rainbond 文件已准备
[5/6] Rainbond 组件 7/9 Ready
[6/6] Console 健康检查中
```

超过 10 秒没有新的可识别进度时，沿用既有心跳事件，显示当前阶段和已用时间。原始 PowerShell、WSL、Docker 和 Rainbond 日志只写入受保护的安装日志；正常界面只展示阶段，失败时展示简短原因和日志位置。

### 2.5 成功输出与授权续接

Windows 本地安装成功时输出：

```text
Rainbond 部署成功

部署位置：本地（Windows / WSL2）
运行状态：正常
Console 地址：http://127.0.0.1:7070

接下来将连接该平台并完成授权。
```

原生 Windows 控制端将经过 Windows 侧验证的 `http://127.0.0.1:7070` 写入 onboarding 状态。WSL 控制端使用安装器分配并从 WSL 内实测可达的固定 Rainbond 私网地址。随后调用 `rainskills resume --onboarding-id <id>`：原生 Windows 使用新增的 Node onboarding adapter，POSIX 和 WSL 继续使用现有 shell 流程。浏览器登录、创建首个管理员、回调授权、MCP 配置和客户端生效提示遵循同一状态协议，用户不需要重新输入地址或重复前面的选择。

## 三、整体架构

### 3.1 组件边界

```text
bin/rainskills.js
  -> install.sh                    Linux/macOS/WSL 的既有 onboarding
  -> windows-onboarding.js         原生 Windows skill 安装、选择、授权和 MCP 配置
  -> platform-installer.js         跨平台编排、状态机、进度和 RainSkills 续接
       -> windows-platform.ps1     Windows 预检、提权、WSL、任务计划和端口转发
            -> wsl-bootstrap.sh    专用发行版内的 Docker/Rainbond 安装和验证
       -> onboarding adapter       按控制模式恢复授权、MCP 配置和最终完成
```

职责固定如下：

- Node 编排器是操作状态的唯一写入者，校验所有来自 PowerShell 和 WSL 的结构化结果；
- `bin/rainskills.js` 在原生 `win32` 默认调用 `windows-onboarding.js`，不得再尝试启动 Bash 或 Python；
- `windows-onboarding.js` 用 Node 文件 API 安装 skill，用 Node HTTP server 完成 loopback 回调，并通过固定参数的本机命令打开浏览器和配置受支持客户端；它与 `install.sh` 读写同一 onboarding schema；
- PowerShell helper 只执行白名单 Windows 操作，以 JSONL 输出结果，不修改 onboarding 字段；
- WSL bootstrap 只在名为 `Rainbond` 且身份标记匹配的专用发行版中运行；
- helper 不接受任意 shell 字符串，只接受固定命令和经过校验的独立参数；
- Skill 负责对话规则、确认边界和失败解释，确定性操作全部由脚本完成。

### 3.2 专用 WSL2 环境

首版固定使用名为 `Rainbond` 的专用发行版，避免修改用户现有 Linux 环境。发行版根文件系统使用 Canonical 官方 Ubuntu 22.04 LTS amd64 WSL rootfs。npm 包中的安装策略固定其版本化 HTTPS 地址、允许来源和 SHA-256；不得在运行时跟随 `current` 地址而不校验内容。

安装流程：

1. 验证 Windows 版本、架构、硬件虚拟化、资源、管理员能力和待重启状态；
2. 启用或更新 WSL2；
3. 下载并校验 rootfs，支持断点续传和有限重试；
4. 用 `wsl --import Rainbond <managed-path> <rootfs> --version 2` 创建发行版；
5. 写入发行版身份标记和 `/etc/wsl.conf`，启用 systemd；
6. 重启该发行版并确认 systemd 可用；
7. 在发行版中调用已下载并校验的 Rainbond 官方 Linux 安装器；
8. 配置 Docker 和 Rainbond 随发行版启动；
9. 从 WSL 内部和 Windows 控制端分别完成健康验证。

同名发行版只有在身份标记包含 schema、installation id 和 Rainskills 管理标识，并与受保护机器清单一致时才允许续用。未知的同名发行版必须停止并提示用户处理，绝不自动注销或覆盖。

### 3.3 Windows 10 兼容路径

优先使用当前 `wsl.exe` 支持的 `--install --no-distribution`、`--update --web-download` 和 `--import` 能力。Windows 10 缺少新版命令时，PowerShell helper 使用 DISM 启用两个必需功能，并安装安装策略中固定来源和摘要的 Microsoft WSL2 x64 运行组件。两条路径最终都必须通过以下事实验证，而不是仅相信命令退出码：

- `wsl --status` 可用；
- 默认版本为 2；
- `Rainbond` 发行版实际为 WSL2；
- 发行版内 systemd 和 Docker 服务可启动。

无法启用虚拟化、企业策略禁止功能或系统版本过低时停止，不尝试绕过。

Rainskills 直接下载的 Ubuntu rootfs、Microsoft 离线组件和 Rainbond 安装器必须同时验证策略允许来源和固定 SHA-256，Windows 可执行制品还要验证 Microsoft Authenticode 签名。`wsl --update --web-download` 属于 Windows 自己管理的系统更新：此路径信任 Windows 的签名安装链，Rainskills 不宣称获得下载包摘要；更新后改为验证 `wsl.exe` 路径、Microsoft 签名、命令状态和实际 WSL 版本。安装策略为每个制品显式标记 `sha256-pinned` 或 `os-signed-update`，两种信任模式不能混用。

### 3.4 原生 Windows 与 WSL 控制模式

启动器在任何 Linux 控制端先检查 `WSL_INTEROP`、`WSL_DISTRO_NAME` 和内核 release 中的 Microsoft 标记。检测到 WSL 时不得按普通 Linux 执行本机安装，而是记录 `control_mode=wsl` 和控制发行版名称，通过 `powershell.exe` 调用 Windows helper。普通 Linux 保持 `control_mode=posix`，原生 Windows 使用 `control_mode=windows-native`。

WSL 控制模式的 skill 和 MCP 配置仍写入发起命令的 WSL 用户目录，不写入 Windows 用户的 Codex/Claude 配置。Windows helper 路径通过 `wslpath -w` 转换并作为独立参数传递。浏览器由 `powershell.exe Start-Process` 打开；回调服务仍由发起 onboarding 的 WSL Node/Bash 进程拥有，并且必须从 Windows 浏览器对 loopback 回调做真实验证。

需要重启时，恢复状态额外保存控制发行版的固定名称和 Linux 恢复包绝对路径。一次性 Windows 登录任务调用 `wsl.exe -d <validated-distro> --exec <fixed-resume-entry> <operation-id>`，不得使用默认发行版或 shell 命令字符串。控制发行版不存在、被重命名或恢复入口身份不匹配时停止并输出原生 Windows 续装入口。原生 Windows 则完全使用 Node/PowerShell，不要求用户安装 Git Bash、WSL 中的 Node 或 Python。

## 四、状态、恢复与并发

### 4.1 Windows 扩展状态机

Windows 本地路径使用以下阶段：

```text
target-selection
preflight
awaiting-confirmation
enabling-wsl
reboot-required
downloading-rootfs
importing-distro
preparing-runtime
installing-rainbond
configuring-windows-access
verifying
platform-ready
authorizing
configured
```

`status` 继续使用 `pending`、`running`、`waiting_user`、`completed`、`failed` 和 `interrupted`。每次重新进入都先检查真实系统状态，从最早未被事实验证的阶段继续。状态文件不能让安装器跳过系统验证。

### 4.2 Windows 状态存储

Windows 操作目录固定为：

```text
%USERPROFILE%\.rainbond\platform-installer\<operation-id>\
```

其中保存 `state.json`、`events.jsonl`、`install.log`、下载元数据和用户态恢复入口。Windows 不以 POSIX `0600` 作为安全依据；创建目录和文件后必须用 Windows ACL 限制为当前用户、`SYSTEM` 和本机 Administrators，拒绝继承后仍可被其他普通用户写入的路径，拒绝 reparse point、符号链接和所有者不匹配的状态文件。

长期机器对象使用与 onboarding operation id 分离的 `installation_id`，并把提权 helper、WSL bootstrap、网络清单和任务定义安装到：

```text
%ProgramData%\Rainskills\Rainbond\<installation-id>\
```

该目录由 `SYSTEM` 和 Administrators 写入，原始安装用户只读，普通用户无权访问。一次 onboarding 可以引用已有 `installation_id`，但不能用新的 operation id 接管长期对象。

恢复包不保存 JWT、密码、SSH 私钥或浏览器凭据，只包含固定版本的必要脚本、非秘密策略、operation id 和固定参数入口。状态更新继续使用同目录临时文件、flush 和原子替换。

### 4.3 提权身份与任务主体

首版要求发起安装的 Windows 用户本身是本机 Administrators 成员。Node 记录其 SID，UAC 提权后的 PowerShell helper 必须验证进程 SID 与原始 SID 相同；如果用户在 UAC 中输入了另一个管理员账户，立即停止，不把状态切换到该账户的 `%USERPROFILE%`。

未提权 Node 与提权 helper 通过用户操作目录中的版本化 request/result JSON 交换结果。每个请求包含 operation id、installation id、随机 nonce 和白名单 action，路径与参数逐项校验；helper 不接受脚本文本。提权 helper 只写 `%ProgramData%` 机器状态和原 SID 可读取的原子结果文件。

WSL 发行版按 Windows 用户注册，因此一次性重启续装任务和持久启动/网络维护任务都使用原用户 SID、`InteractiveToken` 和 highest run level，只在该用户登录时运行。任务动作是 `%ProgramData%` 中普通权限无法修改的固定绝对路径；持久任务不读取用户 token 或 onboarding 文件。不得改用 `SYSTEM`，因为它不能可靠访问该用户注册的 `Rainbond` 发行版。任务创建后，安装器必须回读 principal、logon type、run level、action、arguments 和 ACL，全部匹配才允许重启或宣告安装完成。

### 4.4 锁和重复执行

每个 operation id 持有一个排他锁；同一设备还持有一个 Windows 本地平台全局锁。第二个进程检测到正在运行的安装时只显示已有进度和续接方式，不并行修改 WSL、任务计划或网络规则。

重复执行必须幂等：

- 已校验下载复用，摘要不符则隔离并重新下载；
- 已启用 Windows 功能不重复启用；
- 已导入且身份匹配的发行版通过实况检查续用；
- 已安装 Docker 或 Rainbond 时先验证版本和健康，不盲目重装；
- 已存在的长期任务和网络规则按 installation id 更新，一次性恢复任务按 operation id 更新；
- 未知或不受管对象视为冲突，不接管。

## 五、网络与稳定访问地址

### 5.1 安装级固定私网地址

Rainbond Linux 安装器不接受 `127.0.0.1` 作为 EIP，而 DHCP、Wi-Fi、VPN 和 WSL2 NAT 地址都可能变化，因此不得把 Windows 主网卡地址或 WSL 动态地址持久化为 EIP。

确认安装后，helper 从策略声明的 RFC1918 地址池中选择一个不与 Windows 路由、VPN、WSL、Docker 或局域网重叠的 `/30` 子网，并持久化到 `installation_id`。该子网提供：

- Windows WSL 虚拟接口上的 host address；
- `Rainbond` 发行版由 systemd 恢复的固定 guest address；
- Rainbond 安装器使用的固定 guest address，也就是 `rainbond_eip`。

地址选择、Windows 路由和 WSL 地址配置均写入受保护机器清单。启动任务先恢复该受管地址，再启动 Docker/Rainbond。地址与后来新增的路由冲突时不换用 DHCP 地址，也不静默选择新 EIP；首版停止平台启动并报告精确冲突，避免在没有 Rainbond 官方地址迁移契约的情况下改写既有平台。首版正式发布前，Windows 10/11 实机验收必须证明系统重启、Wi-Fi DHCP 变化和常见 VPN 开关不会改变该 EIP。

状态中分离：

- `rainbond_eip`：Rainbond 使用的安装级固定 guest address；
- `wsl_nat_address`：WSL 自动分配的动态地址，只用于诊断，不参与 EIP 或转发配置；
- `windows_console_url`：Windows 浏览器使用的稳定地址，固定为 `http://127.0.0.1:7070`；
- `control_console_url`：写入当前 onboarding/MCP 的地址；原生 Windows 等于 `windows_console_url`，WSL 控制端等于固定 guest address 的 7070 端口。

原生 Windows MCP 和浏览器使用 loopback Console URL。WSL 控制模式使用固定 guest address 作为 MCP Console URL，并分别从发起命令的 WSL 发行版和 Windows 浏览器验证可达。固定私网地址只面向本机，不宣称可从局域网访问。

### 5.2 受管端口转发

安装器为策略中声明的 `80`、`443`、`6060` 和 `7070` 创建只监听 `127.0.0.1` 的 Windows portproxy，目标是固定 Rainbond guest address。`netsh interface portproxy` 本身没有所有者标签，因此归属依据不是规则名称，而是 `%ProgramData%` 中受保护的 `managed-network.json`：它保存 `installation_id`、精确 listen/connect 四元组、创建前不存在的证据和最后一次应用后的规则快照。

每次修改前必须同时满足：清单 ACL/owner/hash 有效、当前规则与上次受管快照完全一致、目标 installation id 匹配。规则缺失时可以按清单重建；规则存在但与快照不符时视为外部修改并停止。安装器不保存、恢复或改写任何不在清单中的 portproxy 规则。

成功后保留一个最小化登录启动任务：恢复安装级固定 host/guest 地址，启动 `Rainbond` 发行版，等待 Docker/Rainbond 就绪并核对受管转发快照。任务脚本位于受 ACL 保护的固定目录。它不重新安装系统、不下载文件、不执行授权，只维护已安装平台的启动、固定地址和既有转发。

Windows 防火墙规则不在首版自动修改范围内。portproxy 只监听 loopback，不向局域网暴露服务。本机 `127.0.0.1` 和 WSL 控制端到固定 guest address 的访问必须通过；其他设备访问不属于本地 RainSkills 完成标准。

## 六、预检、自动修复与停止条件

### 6.1 只读预检

Windows 预检至少验证：

- Windows 产品类型、版本、build 和 x64 架构；
- CPU、内存和目标数据盘可用空间满足 4 核、8GB、50GB 基线；
- BIOS/UEFI 硬件虚拟化可用；
- 当前用户可触发一次 Windows UAC 提权；
- WSL、Virtual Machine Platform、WSL2 kernel 和待重启状态；
- 端口 `80`、`443`、`6060`、`7070` 的监听进程，以及 portproxy 精确规则与受保护清单的一致性；
- `Rainbond` 同名发行版、受管目录、计划任务和历史状态；
- 到 Microsoft、Canonical、Rainbond 官方下载源和镜像仓库的网络；
- 可分配且不与现有路由重叠的安装级 `/30` 私网。

### 6.2 自动处理矩阵

| 条件 | 自动处理 |
| --- | --- |
| WSL 功能未启用 | 确认后启用，必要时进入重启恢复 |
| WSL 组件缺失或可支持更新 | 从策略允许的 Microsoft 来源安装或更新并校验 |
| 专用发行版不存在 | 下载校验 rootfs 后导入 |
| Docker 不存在 | 在专用发行版内安装并启动 |
| 下载临时失败 | 指数退避有限重试，保留断点 |
| 终端关闭或 Ctrl+C | 标记 interrupted，终止子进程，保留可复用文件和固定续装命令 |
| Console 尚未就绪 | 在限定时间内按健康证据重试，不重跑安装 |
| WSL 动态地址或 Windows DHCP/VPN 变化 | 恢复安装级固定地址；portproxy 目标不随 DHCP 变化 |
| 已有匹配的部分安装 | 验证真实状态后从最早未完成阶段继续 |

### 6.3 必须停止并由用户处理

- Windows 版本、产品类型或架构不支持；
- 硬件虚拟化未开启；
- 资源不足；
- UAC 被拒绝或企业策略禁止 WSL；
- 必需端口被其他服务或未知转发占用；
- `Rainbond` 同名发行版或目录不受 Rainskills 管理；
- 下载来源、重定向或 SHA-256 与策略不符；
- 没有可安全分配的安装级私网，或受管网络清单与系统规则不一致；
- 安装后关键组件持续不健康。

安装器不得用停止服务、删除发行版、清理数据、关闭安全软件、放宽执行策略或跳过摘要校验来自动“修复”这些问题。

## 七、安全与权限

- 预检保持只读；系统变更只发生在一次安装确认之后。
- UAC 提权只授予固定 PowerShell helper 的固定子命令，不拼接用户输入为 PowerShell 源码。
- UAC 前后 Windows 用户 SID 必须一致，不支持用另一管理员账户代为提权。
- 发行版名称、目录、端口、任务名和允许命令由程序常量或版本化策略确定。
- Rainskills 直接下载的制品要求 HTTPS、允许来源、受控重定向和 SHA-256 校验；Windows 系统管理的 WSL 更新按 `os-signed-update` 规则验证签名链和安装结果。
- Windows helper 和 WSL bootstrap 的结构化输出不能包含 Token、密码或浏览器凭据。
- 日志落盘前对环境变量、授权头和 URL 参数做脱敏。
- 一次性重启续装任务必须在完成、取消或不可恢复失败后清理。
- 永久登录启动任务只执行启动、健康检查和受管转发刷新，不以此运行任意 npx 包。
- 对 WSL 注销、数据删除、卸载系统功能和未知规则修改不提供自动路径。

## 八、代码改动范围

预计修改：

- `rainbond-platform-installer/scripts/platform-installer.js`
  - 统一目标选择标签，新增 WSL 检测、`local-windows` 分支、Windows 状态和 helper 编排；
- `rainbond-platform-installer/scripts/windows-onboarding.js`
  - 新增原生 Windows skill 安装、平台选择、Node loopback 授权和 MCP 配置，移除 Bash/Python 前置条件；
- `rainbond-platform-installer/scripts/windows-platform.ps1`
  - 新增 Windows 预检、WSL2 准备、UAC、重启恢复、发行版和任务计划管理；
- `rainbond-platform-installer/scripts/wsl-bootstrap.sh`
  - 新增专用发行版内的 systemd、Docker、Rainbond 安装与验证；
- `rainbond-platform-installer/references/installation-policy.json`
  - 增加 Windows build、WSL rootfs、Microsoft 组件、发行版名称、受管端口和摘要策略；
- `rainbond-platform-installer/references/installation-policy.md`
  - 更新支持矩阵、系统变更和 Windows 停止条件；
- `rainbond-platform-installer/references/troubleshooting.md`
  - 增加面向用户的 Windows 阻塞处理；
- `rainbond-platform-installer/SKILL.md`
  - 更新本地/远程对话和 Windows 自动安装约束；
- `README.md`
  - 更新 Windows 支持范围和统一入口；
- `tests/platform-installer.test.js` 及新增 Windows helper 契约测试
  - 覆盖交互、状态、恢复、安全和失败行为；
- `tests/npx-launcher.test.js` 及新增 native onboarding 测试
  - 覆盖原生 Windows 不启动 Bash、WSL 控制模式识别和两种 resume adapter；
- npm 包内容测试
  - 确保 PowerShell、WSL bootstrap 和策略被打包。

不修改 Rainbond、rainbond-console 或 rainbond-ui 仓库。首版复用 Rainbond 官方 Linux 快速安装器，不新增平台 API。

## 九、测试与验收

### 9.1 自动化测试

CI 中不得真正启用 WSL、重启 Windows、安装 Docker/Rainbond 或修改端口转发。通过依赖注入和伪命令覆盖：

- 三种控制端统一展示“安装到本地 / 安装到 Linux 服务器”，不出现推荐标签；
- Windows 解析为 `local-windows`，Windows Server、ARM 和旧 build 被拒绝；
- 原生 Windows 默认安装和 resume 全程不依赖 Bash/Python，onboarding schema 与 POSIX 路径兼容；
- WSL 控制端不会误入 `local-linux`，Windows helper、浏览器和重启恢复均使用已验证的控制发行版；
- 所有系统变更都发生在明确确认之后；
- Windows 预检资源、虚拟化、UAC、功能、端口、网络、IPv4 和对象归属；
- 新版 WSL 命令路径和 Windows 10 DISM 兼容路径；
- rootfs、Microsoft 组件和 Rainbond 安装器的来源、重定向和摘要校验；
- WSL 导入、身份标记、systemd、Docker 和 Rainbond 阶段顺序；
- 重启前恢复包完整性验证、一次性任务注册、拒绝重启和登录后恢复；
- Windows ACL、reparse point、所有者和原子状态更新；
- operation 锁和设备全局锁；
- Ctrl+C、终端关闭、下载断点和每个持久阶段的幂等恢复；
- 未知同名发行版、端口转发、任务或数据目录不被接管；
- 安装级固定 EIP 在 DHCP、Wi-Fi、VPN 和 WSL 动态地址变化后保持不变；
- portproxy 归属只由受保护清单和精确规则快照确定，外部修改后停止；
- UAC 前后 SID、ProgramData 机器目录、原用户任务 principal/logon type/run level 和固定 action 校验；
- `sha256-pinned` 与 `os-signed-update` 两种下载信任路径分别验证；
- Windows 内部和控制端双重健康验证；
- 原生 Windows 把 `http://127.0.0.1:7070`、WSL 控制端把固定 guest Console URL 写回 onboarding 并续接授权；
- 成功输出只包含部署位置、健康状态、Console 地址和下一步；
- Linux、macOS、远程 SSH、SaaS 和显式 URL 流程无回归；
- npm tarball 包含全部 Windows 资源。

PowerShell helper 采用参数化 runner 和固定 JSONL 契约测试；Node 测试使用临时目录和伪系统命令。测试不能依赖开发机是否安装 WSL。

### 9.2 Windows 实机验收

GitHub 托管 Windows runner 不能可靠覆盖 WSL2 嵌套虚拟化和真实重启，正式发布前必须在可重置的 Windows 10 x64 与 Windows 11 x64 设备或虚拟机上分别完成实机验收：

1. 从未启用 WSL 的干净系统安装，确认一次重启后自动续装；
2. 已有 WSL 但没有 `Rainbond` 发行版的系统安装；
3. 下载中断、安装中断和 Windows 重启后的续装；
4. 端口冲突和未知同名发行版必须安全停止；
5. Windows 重启后 Rainbond 自动启动，Console 地址仍为 `http://127.0.0.1:7070`；
6. 浏览器授权后 RainSkills MCP 配置验证通过；
7. 卸载测试环境时只清理测试创建的受管对象，确认未影响用户已有 WSL 发行版。

实机验收记录 Windows build、WSL 版本、Rainbond 版本、各阶段耗时、下载量、重启次数和失败日志。两类系统均通过后才能在 README 中把 Windows 本地安装标记为正式支持。

### 9.3 完成标准

本功能完成时，一个不了解 WSL 和 Docker 的 Windows 10/11 x64 用户可以从 RainSkills 私有化流程选择“安装到本地”，只确认安装和必要重启，看到持续且真实的进度，在中断后继续，最终获得可验证的 `http://127.0.0.1:7070`，并自动进入 RainSkills 浏览器授权流程。任何未完成健康验证、网络转发或授权续接的状态都不能显示“Rainbond 部署成功”。

## 十、参考

- Microsoft WSL install: https://learn.microsoft.com/windows/wsl/install
- Microsoft WSL basic commands: https://learn.microsoft.com/windows/wsl/basic-commands
- Microsoft manual installation for older Windows: https://learn.microsoft.com/windows/wsl/install-manual
- Rainbond V6.5 Windows quick-install history: https://github.com/goodrain/rainbond-docs/blob/V6.5/docs/quick-start/quick-install.mdx
