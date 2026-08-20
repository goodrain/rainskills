# Windows 本地安装验收

Windows 本地安装当前标记为 preview。只有 Windows 10 和 Windows 11 真机用例全部通过并留下版本、时间和结果记录后，才能改为正式支持。

## 自动检查

- GitHub-hosted `windows-latest` 使用 Windows PowerShell 5.1 解析 `windows-platform.ps1` 和 `windows-browser.ps1`。
- 浏览器桥接必须原样传递包含 `&` 的授权 URL，并拒绝非 HTTP(S)、带凭据或控制字符的 URL。
- Node 专项测试只检查固定 action、请求/结果 schema、阶段事实、摘要、恢复任务、网络和敏感信息脱敏，不调用 DISM、WSL、计划任务、portproxy 或安装脚本。

## 现有平台续接验收（rc.43）

使用现有 onboarding、WSL 发行版、Rainbond 容器和数据执行：

```cmd
npx --yes rainskills@0.1.0-rc.43 resume --onboarding-id <onboarding-id>
```

- [ ] 授权前不出现平台收敛 UAC；不重新下载 Ubuntu、不重新导入发行版、不重新运行 Rainbond 安装脚本。
- [ ] RainSkills 启动并在本次授权期间保持现有 `Rainbond` WSL 运行，只等待已安装 Console 可以访问。
- [ ] Console 就绪后立即进入浏览器授权，不再执行 `ConvergeInstalledPlatform`、三轮 Pod 稳定性采样或安装修复。
- [ ] Device Flow 请求由授权客户端执行；返回的 device code 和 user code 不写入状态或日志。
- [ ] Windows `PATH` 中没有 Codex CLI 时，直接更新并备份 `%USERPROFILE%\.codex\config.toml`，不把客户端命令缺失误报为授权失败。
- [ ] 授权成功后才清理一次性恢复任务；授权失败保留恢复任务，可再次执行同一条 `resume` 命令。
- [ ] WSL 保持进程提前退出时报告 `WINDOWS_WSL_UNAVAILABLE`；Console 超时未就绪时报告 `WINDOWS_CONSOLE_UNAVAILABLE`。

## 真机矩阵

每次验收记录 Windows 版本/build、CPU 架构、WSL 版本、Rainskills 版本、开始/结束时间和最终 Console 地址。不得在生产工作站执行。

- [ ] 全新 Windows 10 x64 build 19041+，无 WSL。
- [ ] 全新 Windows 11 x64，无 WSL。
- [ ] 已安装 WSL2、默认 NAT、已有其他用户发行版。
- [ ] Codex/Node 运行在原生 Windows PowerShell。
- [ ] Codex/Node 运行在 WSL 控制发行版。

## 成功路径

- [ ] 显示“安装到本地 / 安装到 Linux 服务器”，回车默认本地，没有“推荐”字样。
- [ ] 预检只读；确认前不下载、不提权、不启用功能、不创建任务和网络。
- [ ] UAC 拒绝后安全停止，原始命令可继续；接受后不要求在聊天中提供凭据。
- [ ] Ubuntu rootfs 和 Rainbond 安装脚本显示真实字节/百分比进度，断网后可续传并重新校验 SHA-256。
- [ ] 需要重启时先保存断点；登录后固定任务恢复到同一 operation/installation id。
- [ ] 创建独立 `Rainbond` WSL2 发行版，PID 1 为 systemd，Docker 正常。
- [ ] 固定 `/30` NAT、guest 地址和 `127.0.0.1` portproxy 在重启、DHCP 变化和 VPN 重连后仍一致。
- [ ] 外层容器运行、K3s 节点 Ready、`rbd-system` 组件就绪、端口 `80/443/7070` 监听。
- [ ] WSL 内和 Windows `http://127.0.0.1:7070` 都能访问 Console。
- [ ] 原生 Windows 和 WSL 控制端都能打开 Windows 浏览器、完成授权和 RainSkills CLI 验证。
- [ ] 成功输出只包含部署成功、部署位置、运行状态、Console 地址和授权交接。
- [ ] 成功后一次性恢复/收尾任务和全局 lease 已清理，登录维护任务保留且权限正确。

## 安全停止路径

- [ ] Windows Server、低于 build 19041、非 x64、资源不足、虚拟化关闭分别给出明确 blocker。
- [ ] WSL mirrored/未知网络模式停止且不修改 `.wslconfig`。
- [ ] 端口冲突、未知同名发行版、未知 `RainSkills-*` 任务或机器目录停止且不删除对象。
- [ ] rootfs、内核包或安装脚本摘要不匹配时隔离文件，绝不执行。
- [ ] 并发安装只允许当前 lease owner 修改机器对象；另一进程只显示进度/恢复入口。
- [ ] 从每个持久阶段重复执行都以事实恢复，不重复破坏性创建。
- [ ] Ctrl+C、下载中断、安装失败和 Console 暂时不可达都保留受保护日志与断点。
- [ ] 日志、事件、helper 结果和终端不出现 JWT、Authorization header、device code 或密码。

## 发布门槛

当前自动契约不等于真机验收。上述 Windows 10/11 成功路径与安全停止路径未完成前，README 必须保留 preview 标识，npm 稳定标签不得宣称 Windows 正式支持。
