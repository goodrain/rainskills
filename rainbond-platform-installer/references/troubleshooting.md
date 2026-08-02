# 安装问题处理

- **资源不足**：停止安装，只列出不满足的 CPU、内存或磁盘项目。
- **端口占用**：停止安装，提示用户处理占用 `80`、`443`、`6060`、`7070` 的服务，不主动停止服务。
- **已有 Rainbond**：停止新安装，建议返回 Rainskills 选择“已经有，填写平台地址”。
- **权限不足**：Linux 需要 root 或已经可用的 `sudo -n`，不得在聊天中索取密码。
- **远程连接失败**：确认控制端有 `ssh` 和 `scp`。安装器会先尝试已有的 SSH Key；需要密码时会打开一次系统 SSH 认证并自动复用连接。密码必须输入到终端的 OpenSSH 提示中，不要发送到聊天。如果提示主机密钥发生变化，先通过可信渠道核对服务器指纹并修复 `known_hosts`，安装器不会绕过该校验。
- **Windows 控制端**：Rainbond 不能安装到 Windows 本机；准备一台满足资源要求的 Linux 服务器，并确保 Windows OpenSSH 客户端可用。
- **macOS 环境**：官方脚本需要 OrbStack。安装确认后可由官方脚本下载 OrbStack，但 macOS 权限弹窗仍需用户操作。
- **官方脚本摘要变化**：停止执行，升级到包含新安装策略的 Rainskills 版本。
- **启动失败**：保留 `~/.rainbond/platform-installer/<operation-id>/install.log`，不要自动删除容器或数据后重试。
- **Console 健康检查失败**：区分 Rainbond 运行状态和控制端访问地址。安装器会尝试 SSH 实际主机、Rainbond 上报 EIP 和远端主网卡地址；全部失败时提供公网 IP 或域名，不要包含 `http://`、端口或路径。已有 Rainbond 只重新验证，不重新安装。
- **授权失败**：Rainbond 已部署成功时保留 Console 地址，稍后执行输出中的 `npx rainskills resume` 命令继续，不重新部署平台。
