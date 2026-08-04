# Rainbond 单机安装策略

本 Skill 只支持 Rainbond 官方单机快速安装流程。机器可执行策略以同目录下的 `installation-policy.json` 为准，更新官方来源、允许域名或资源基线时必须发布新的 Rainskills 版本。官方安装脚本内容可以在固定 HTTPS 来源上独立优化，不与 Rainskills 版本绑定。

## 支持范围

- 控制端支持 Linux、macOS 和 Windows；Rainbond 目标支持 Linux、macOS，以及 Windows 本地预览路径中的专用 WSL2 环境。
- Linux `x64` / `arm64`：可安装到当前设备，也可通过 SSH 安装到其他 Linux 服务器，回车默认当前设备。
- macOS `x64` / `arm64`：优先推荐远程 Linux，也可安装到当前 Mac；本机安装依赖 OrbStack，准备时间通常更长。
- Windows：可选择“安装到本地”或“安装到 Linux 服务器”。本地路径目前为 preview，只支持 Windows 10 build 19041+ / Windows 11 x64 工作站。
- 最低资源：4 核 CPU、8 GB 内存、50 GB 可用磁盘。
- 安装前端口 `80`、`443`、`6060`、`7070` 必须空闲。

远程 Linux 只接受 `user@host` 或 `~/.ssh/config` 主机别名，使用系统 `ssh` / `scp`。安装器先尝试已有的非交互认证；需要时由 OpenSSH 在附着终端中确认主机指纹并读取一次 SSH 密码，然后通过临时控制连接复用认证。Rainskills 不接收或保存密码、私钥，也不支持多节点、高可用、离线安装、已有 Kubernetes 或自动清理冲突环境。

远程安装使用 `ssh -G` 解析的实际主机作为新平台 EIP，不再优先使用 `hostname -I` 的首个内网地址。完成后从控制端依次验证显式 Console 主机、SSH 实际主机、SSH 字面主机、Rainbond 上报 EIP 和远端主网卡地址，保存第一个可访问的 `http://<host>:7070`。手动补充只接受 IP 或 DNS 域名。

## Windows 本地预览策略

- 当前用户必须属于 Administrators，UAC 必须开启，CPU 虚拟化必须可用；普通预检不查询需要提权的 Windows 可选功能，安装器只在用户确认后请求提权并检查、启用 WSL。
- WSL 必须使用 NAT 网络模式。安装器不会改写用户的 `.wslconfig`，检测到 mirrored 或其他模式时直接停止。
- Rainbond 安装到独立的 Ubuntu 22.04 `Rainbond` WSL2 发行版，不修改用户已有发行版。发现同名未知发行版、未知计划任务或未知机器目录时停止。
- Ubuntu rootfs 使用版本策略中的 HTTPS 镜像列表；优先使用国内同步镜像，下载失败时逐源切换并以 Ubuntu 官方源兜底。下载限制为 512 MB，只要求结果为非空普通文件，格式和可用性完全由 `wsl --import` 和发行版启动检查验证，不再固定文件大小、SHA-256 或文件头。旧版 WSL 内核包仍固定来源与摘要。Rainbond 安装脚本仍使用固定 HTTPS 官方来源，限制同源跳转和文件大小，并在 WSL 内执行前再次检查 Bash 语法与本次下载摘要。
- 网络预检检查 Rainbond 官方安装脚本实际使用的 `registry.cn-hangzhou.aliyuncs.com` 镜像仓库，不把无关的 Docker Hub 地址作为安装前置条件。
- Windows 侧只管理 `80`、`443`、`6060`、`7070` 的 loopback portproxy 和一个不冲突的 `/30` NAT 网段。任一端口已占用时停止，不关闭现有服务。
- 首次安装可能启用 WSL/VirtualMachinePlatform 并需要重启。恢复入口固定到受保护的机器包；WSL 控制端通过原发行版和固定参数恢复。
- 成功必须同时满足：外层容器运行、K3s 节点 Ready、`rbd-system` 组件就绪、WSL 内 Console 可访问、Windows `127.0.0.1:7070` 可访问。
- 平台在 Windows 用户登录后可用，不承诺 Windows 尚未登录时自动启动。正式支持状态需要完成 Windows 10 和 Windows 11 真机验收。

## 安全边界

预检只读取目标机系统状态。执行官方脚本前必须向用户展示目标机实际会发生的系统变更并取得一次明确确认。安装器不接收聊天中的密码、私钥、JWT 或 Token，不自动删除已有容器和 `/opt/rainbond` 数据。

官方脚本必须先下载到控制端受保护的操作目录。下载只允许固定 HTTPS 官方来源及同源跳转，响应和实际文件都受大小上限约束；脚本必须是普通文件、使用 Bash shebang、没有 NUL 字节并通过 `bash -n`。控制端为本次下载计算 SHA-256，远程 Linux 和 Windows/WSL 在执行前必须再次匹配同一摘要并复查 Bash 语法。该摘要用于发现传输或缓存篡改，不用于把官方脚本内容固定到某个 Rainskills 版本。
