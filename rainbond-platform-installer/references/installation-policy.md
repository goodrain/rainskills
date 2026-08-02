# Rainbond 单机安装策略

本 Skill 只支持 Rainbond 官方单机快速安装流程。机器可执行策略以同目录下的 `installation-policy.json` 为准，更新安装脚本地址、摘要或资源基线时必须发布新的 Rainskills 版本。

## 支持范围

- 控制端支持 Linux、macOS 和 Windows；Rainbond 目标机只支持 Linux 或 macOS。
- Linux `x64` / `arm64`：可安装到当前设备，也可通过 SSH 安装到其他 Linux 服务器，回车默认当前设备。
- macOS `x64` / `arm64`：优先推荐远程 Linux，也可安装到当前 Mac；本机安装依赖 OrbStack，准备时间通常更长。
- Windows：不支持本机安装，仅允许通过 SSH 安装到 Linux 服务器。
- 最低资源：4 核 CPU、8 GB 内存、50 GB 可用磁盘。
- 安装前端口 `80`、`443`、`6060`、`7070` 必须空闲。

远程 Linux 只接受已经可用的 `user@host` 或 `~/.ssh/config` 主机别名，使用系统 `ssh` / `scp` 和 `BatchMode=yes`。不支持在流程中输入 SSH 密码或私钥，也不支持多节点、高可用、离线安装、已有 Kubernetes 或自动清理冲突环境。

## 安全边界

预检只读取目标机系统状态。执行官方脚本前必须向用户展示目标机实际会发生的系统变更并取得一次明确确认。安装器不接收聊天中的密码、私钥、JWT 或 Token，不自动删除已有容器和 `/opt/rainbond` 数据。

官方脚本必须先下载到控制端受保护的操作目录，来源和 SHA-256 摘要验证通过后才能执行。远程 Linux 会将已校验脚本传到受保护的远端操作目录，并在执行前再次校验摘要。摘要变化时停止安装并提示升级 Rainskills，不允许临时跳过校验。
