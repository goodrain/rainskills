# Rainbond 私有平台安装策略

本 Skill 支持 Rainbond 官方单机快速安装、ROI 主机集群安装和已有 Kubernetes 集群的 Helm 安装流程。机器可执行策略以同目录下的 `installation-policy.json` 为准，更新官方来源、允许域名或资源基线时必须发布新的 Rainskills 版本。官方安装脚本、ROI 和 Helm Chart 内容可以在固定 HTTPS 来源上独立优化，不与 Rainskills 版本绑定。

## 支持范围

- 控制端支持 Linux、macOS 和 Windows；Rainbond 目标支持 Linux、macOS，以及 Windows 本地预览路径中的专用 WSL2 环境。
- Linux `x64` / `arm64`：选择“部署到本机”时安装到当前设备；选择“部署到独立服务器”时通过 SSH 安装到其他 Linux 服务器。不提供回车默认项。
- macOS `x64` / `arm64`：优先推荐远程 Linux，也可安装到当前 Mac；本机安装依赖 OrbStack，准备时间通常更长。
- Windows：与其他控制端使用同一份“部署到本机 / 部署到独立服务器 / 部署到已有 Rainbond”选择；本机路径目前为 preview，只支持 Windows 10 build 19041+ / Windows 11 x64 工作站。
- 推荐资源：4 核 CPU、8 GB 内存、50 GB 可用磁盘；预检最低门槛为 2 核 CPU、4 GB 内存、30 GB 可用磁盘。低于推荐值时会提示风险但继续安装，最终以 Rainbond 实际部署验证为准。
- 安装前端口 `80`、`443`、`7070` 必须空闲。

远程单机只接受 `user@host` 或 `~/.ssh/config` 主机别名；ROI 主机集群逐节点使用配置中的 root 地址和端口。两种方式都先用 `BatchMode=yes` 检查现有免密连接。远程单机检查失败时固定输出一条版本锁定的 `ssh prepare`；主机集群先检查全部节点，再一次列出所有未就绪节点并输出一条版本锁定的 `ssh prepare-cluster --cluster-config`。用户只在自己电脑的系统终端执行，OpenSSH 读取每台服务器的指纹确认和一次密码；命令只准备公钥连接，不安装 Rainbond。全部完成后只统一回复一次“已完成”。恢复后所有 `ssh` / `scp` 均为免密非交互调用。Rainskills 不接收聊天中的 SSH 密码或私钥，也不支持离线安装或自动清理冲突环境。

远程单机安装使用 `ssh -G` 解析的实际主机作为新平台 EIP，不再优先使用 `hostname -I` 的首个内网地址。完成后从控制端依次验证显式 Console 主机、SSH 实际主机、SSH 字面主机、Rainbond 上报 EIP 和远端主网卡地址，保存第一个可访问的 `http://<host>:7070`。手动补充只接受 IP 或 DNS 域名。

## ROI 主机集群策略

- 普通入口支持 `3-100` 台 Linux 节点。首次进入时只创建受保护的 `servers.txt` 并停止等待，不生成 `cluster.yaml`、不发起 SSH，也不下载或执行 ROI。固定消息提供可点击链接、macOS/Linux/Windows 对应打开命令、四字段说明和“编辑完成后回复‘已完成’”；普通用户不编辑 `cluster.yaml`、YAML 或节点角色。
- `servers.txt` 使用 UTF-8 文本，包含中文标题、中文注释和三个连续的 `[server-N]` 区块。每个区块只允许 `public_ip`（公网 IP）、`private_ip`（内网 IP）、`ssh_port`（逐节点 SSH 端口）和 `password`（root 密码）；超过三台时复制完整区块并连续编号。每台服务器可使用不同端口，SSH 端口范围为 1-65535，不要求为 22。文件最大 1 MiB，最多 100 个节点；一次汇总全部格式、字段、地址、端口、重复 endpoint 和节点数量问题。
- `servers.txt` 必须是当前用户拥有的普通文件；POSIX 权限精确为 `0600`，Windows 使用仅当前用户可读写的 ACL。通过受保护 descriptor 读取并拒绝符号链接、替换、读取期间变化、非法 UTF-8、NUL/控制字符和超限内容。校验失败时保留同一文件供修改，不创建 YAML 或产生 SSH/下载副作用。
- 校验成功后自动生成受保护的 `cluster.yaml`：节点依次命名为 node1...nodeN，node1 为 bootstrap；前三台自动承担 etcd/master，全部节点承担 worker/rbd-chaos，前两台承担 rbd-gateway，node1 承担 nfs-server。使用内置 NFS、内置数据库和内置镜像仓库的最小配置。用户不选择或修改节点角色。
- SSH 前先展示不含凭据的完整逐节点角色拓扑摘要，包括节点数、每节点角色、bootstrap、存储模式和受保护配置路径。密码只保存在受保护的本地 `servers.txt`、自动生成的 `cluster.yaml` 和 ROI 安装/恢复所需的受保护远端配置中。允许内部 `parseHostServerInput` 返回的 host 对象携带 `password`，仅供生成受保护的 `cluster.yaml` 和后续 ROI 安装。对外用户消息、状态、遥测、日志、错误和对外返回值不得反射密码或原始输入，所有对外摘要都不含凭据；日志仍对 password、database、registry、token、secret 等字段脱敏。
- 状态只保存 `servers.txt` 和自动生成 `cluster.yaml` 的受保护路径及 SHA-256。恢复时两者必须保持字节不变；若崩溃发生在 YAML 已创建但摘要尚未持久化，只采用与当前 `servers.txt` 自动生成结果逐字节相同的 crash residue。来源不明、符号链接、不匹配或锁定后漂移的 `cluster.yaml` 均停止，不覆盖或猜测来源。
- 保留旧 `config_source=generated-template` 断点，继续原有 YAML 校验和恢复流程。显式 `--cluster-config <path>` 是高级导入入口，继续支持有效的 1、2 或 N 节点 ROI YAML；导入时只解析配置用于校验和摘要，受保护副本保留原始字节，不重新序列化未知 ROI 字段。拒绝符号链接、非普通文件、非当前用户文件，以及权限宽于 `0600` 的敏感配置。
- 高级/旧 YAML 仍要求 etcd 至少一个且数量为奇数、恰好一个属于 master 的 bootstrap，并满足 master、worker、rbd-gateway、rbd-chaos 和存储角色约束；少于三个控制面或 etcd 节点时明确提示不具备高可用。普通 `servers.txt` 入口固定生成三控制面/etcd 拓扑。
- Rainskills 只检查并准备全部节点的 SSH 免密连接，不在 ROI 前自行检查 CPU、内存、磁盘容量、端口、安装源、网络或已有 RKE2/Rainbond，也不根据这些项目阻断安装。SSH 就绪并确认安装后，只对 bootstrap 节点执行固定的 `uname -m`，用于选择 `roi-amd64` 或 `roi-arm64`；实际安装条件由 ROI 判断。
- 非交互执行必须显式提供 `--yes`。确认前不下载 ROI，也不传输配置或启动远端命令。
- ROI 只允许 `https://get.rainbond.com/roi/roi-amd64` 和 `roi-arm64`，最多三次 `get.rainbond.com/roi/` 同源跳转，下载上限 128 MiB。校验 ELF 类型和架构，并运行固定的 `roi version`。
- 安装器会主动探测策略中的官方 checksum 地址；发布 checksum 时必须匹配。官方明确未发布 checksum 时记录该事实，并锁定本次下载的最终 URL、版本和 SHA-256。
- 恢复时必须复用字节完全相同的受保护 cluster.yaml 和 ROI。bootstrap 上再次校验两份文件的 SHA-256，然后通过已准备的免密 SSH 执行固定的 `roi up -f <protected-cluster.yaml>`。
- 状态、事件和遥测不保存原始 TXT/YAML、SSH/ROI 原始输出或凭据。
- ROI 正常退出后仍需验证所有预期节点 Ready、rbd-api/rbd-gateway/rbd-app-ui 等关键组件就绪，以及 Console 从当前控制端可访问；全部通过后才能进入授权。

## 已有 Kubernetes 集群策略

- kubeconfig 使用显式路径或当前用户的 `~/.kube/config`，context 必须显式指定。kubeconfig 和可选 values 在受保护操作目录中保留原始字节；拒绝符号链接、非普通文件、非当前用户文件和不安全权限/ACL。
- 状态只记录受保护文件路径和 SHA-256、context、脱敏后的 HTTPS API origin、kube-system UID，以及 Chart 的名称、精确版本和摘要；不保存 kubeconfig/values 内容、凭据或命令原始输出。
- 每个 `kubectl` 都固定传入同一 `--kubeconfig` 和 `--context`，每个 Helm 命令都固定传入同一 `--kubeconfig` 和 `--kube-context`。预检、下载、lint、template、dry-run、install 和验收阶段均复核 API origin、集群 UID 和受保护文件摘要，漂移时立即停止。
- 只读预检要求 Kubernetes 1.24+、Helm 3、节点 Ready 且使用 containerd、至少一个 StorageClass、入口和运行时路径可用、Chart/镜像来源可达。已有 `rbd-system`、`rainbond` release、Rainbond CRD、Ingress/controller 或 hostPort 冲突均阻断；安装器不覆盖、不卸载，也不静默修改或重启 containerd。
- Chart 只从 `https://chart.rainbond.com` 获取 `rainbond/rainbond`，解析并锁定一个精确版本，最多三次同源跳转，下载上限 128 MiB。index 发布 digest 时必须匹配；本地受保护 `.tgz` 在状态发布前写入 crash-safe partial 并锁定 SHA-256，恢复只允许复用相同字节。
- lint、template 和 dry-run 全部使用同一受保护 Chart、values、kubeconfig 和 context。dry-run 后再次展示 context、集群 UID、Chart 版本/摘要、values 摘要、namespace/release、资源和手动处理项，并要求明确确认；非交互模式缺少 `--yes` 时不会调用 `helm install`。
- 安装命令固定为 `helm install rainbond <protected.tgz> --kubeconfig ... --kube-context ... --create-namespace -n rbd-system`（可选受保护 values）。完成后必须验证 release、operator、rbd-system 核心 Pod、`rbd-app-ui` 和 Console 可访问，才能进入授权。

## Windows 本地预览策略

- 当前用户必须属于 Administrators，UAC 必须开启，CPU 虚拟化必须可用；普通预检不查询需要提权的 Windows 可选功能，安装器只在用户确认后请求提权并检查、启用 WSL。
- WSL 必须使用 NAT 网络模式。安装器不会改写用户的 `.wslconfig`，检测到 mirrored 或其他模式时直接停止。
- Rainbond 安装到独立的 Ubuntu 22.04 `Rainbond` WSL2 发行版，不修改用户已有发行版。发现同名未知发行版、未知计划任务或未知机器目录时停止。
- Ubuntu rootfs 使用版本策略中的 HTTPS 镜像列表；优先使用国内同步镜像，下载失败时逐源切换并以 Ubuntu 官方源兜底。下载限制为 512 MB，只要求结果为非空普通文件，格式和可用性完全由 `wsl --import` 和发行版启动检查验证，不再固定文件大小、SHA-256 或文件头。旧版 WSL 内核包仍固定来源与摘要。Rainbond 安装脚本仍使用固定 HTTPS 官方来源，限制同源跳转和文件大小，并在 WSL 内执行前再次检查 Bash 语法与本次下载摘要。
- 网络预检检查 Rainbond 官方安装脚本实际使用的 `registry.cn-hangzhou.aliyuncs.com` 镜像仓库，不把无关的 Docker Hub 地址作为安装前置条件。
- Windows 侧只管理 `80`、`443`、`7070` 的 loopback portproxy 和一个不冲突的 `/30` NAT 网段。任一端口已占用时停止，不关闭现有服务。`6060` 是 Rainbond 容器内部 WebSocket 服务，不对宿主机发布。
- 首次安装可能启用 WSL/VirtualMachinePlatform 并需要重启。恢复入口固定到受保护的机器包；WSL 控制端通过原发行版和固定参数恢复。
- 成功必须同时满足：外层容器运行、K3s 节点 Ready、`rbd-system` 组件就绪、WSL 内 Console 可访问、Windows `127.0.0.1:7070` 可访问。
- 平台在 Windows 用户登录后可用，不承诺 Windows 尚未登录时自动启动。正式支持状态需要完成 Windows 10 和 Windows 11 真机验收。

## 安全边界

预检只读取目标机系统状态。执行官方脚本前必须向用户展示目标机实际会发生的系统变更并取得一次明确确认。安装器不接收聊天中的密码、私钥、JWT 或 Token，不自动删除已有容器和 `/opt/rainbond` 数据。

官方脚本必须先下载到控制端受保护的操作目录。下载只允许固定 HTTPS 官方来源及同源跳转，响应和实际文件都受大小上限约束；脚本必须是普通文件、使用 Bash shebang、没有 NUL 字节并通过 `bash -n`。控制端为本次下载计算 SHA-256，远程 Linux 和 Windows/WSL 在执行前必须再次匹配同一摘要并复查 Bash 语法。该摘要用于发现传输或缓存篡改，不用于把官方脚本内容固定到某个 Rainskills 版本。
