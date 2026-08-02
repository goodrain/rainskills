# 安装问题处理

- **资源不足**：停止安装，只列出不满足的 CPU、内存或磁盘项目。
- **端口占用**：停止安装，提示用户处理占用 `80`、`443`、`6060`、`7070` 的服务，不主动停止服务。
- **已有 Rainbond**：停止新安装，建议返回 Rainskills 选择“已经有，填写平台地址”。
- **权限不足**：Linux 需要 root 或已经可用的 `sudo -n`，不得在聊天中索取密码。
- **远程连接失败**：确认控制端有 `ssh` 和 `scp`，并先在终端验证 `ssh user@host` 可连接。安装器使用 `BatchMode=yes`，不会打开密码输入。
- **Windows 控制端**：Rainbond 不能安装到 Windows 本机；准备一台满足资源要求的 Linux 服务器，并确保 Windows OpenSSH 客户端可用。
- **macOS 环境**：官方脚本需要 OrbStack。安装确认后可由官方脚本下载 OrbStack，但 macOS 权限弹窗仍需用户操作。
- **官方脚本摘要变化**：停止执行，升级到包含新安装策略的 Rainskills 版本。
- **启动失败**：保留 `~/.rainbond/platform-installer/<operation-id>/install.log`，不要自动删除容器或数据后重试。
- **授权失败**：Rainbond 已部署成功时保留 Console 地址，稍后执行输出中的 `npx rainskills resume` 命令继续，不重新部署平台。
