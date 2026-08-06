# Rainbond 资源预检分层设计

## 一、背景

RainSkills 当前把 `4 核 CPU / 8 GB 内存 / 50 GB 可用磁盘` 同时作为推荐配置和预检硬性门槛，导致资源略低于推荐值的用户在真正尝试部署前就被阻止。Rainbond 单机体验安装可以在更小的资源上运行，但性能和可部署规模会下降。

## 二、目标

- 保留现有资源标准作为用户可见的推荐配置。
- 只有低于实际安装脚本能够处理的最低资源时才阻止安装。
- 资源低于推荐值但达到最低值时，明确提示降级风险并继续执行。
- Linux、macOS、Windows 本地，以及 Windows 控制端安装远程 Linux 使用一致的资源判断。
- 端口、权限、网络、WSL/虚拟化和已有平台等非资源 blocker 保持原有硬性校验。

## 三、策略

策略文件升级为 `rainskills.platform-installation-policy.v2`，并拆分为（内存和磁盘均使用字节表示，换算基于 1024³；比较使用严格的 `<`，刚好达到门槛即可通过）：

- `recommended`：4 核、8 GB、50 GB，仅用于展示和 warning。
- `minimums`：2 核、4 GB、10 GB，用于真正的预检 blocker。

资源低于推荐值时，assessment 返回字符串数组 `warnings`；资源 warning 本身不影响 `ok`，只有不存在其他 blocker 时才允许继续安装。打印预检结果时告知用户安装会继续，但运行性能和可用磁盘余量可能受限。资源低于最低值时仍返回 blocker，避免在明显无法运行的环境中启动安装。资源 warning 不会覆盖或改变端口、权限、网络、虚拟化等非资源 blocker。

## 四、实现范围

- 更新 `installation-policy.json` 与策略说明。
- 更新本地 Linux/macOS、远程 Linux 和 Windows 预检评估函数，统一返回资源 warning。
- 更新预检输出，展示 warning 后继续等待用户确认；README 和策略说明同步标记推荐值与最低值。
- 保持安装脚本和最终 Rainbond deployment verification 作为实际运行能力的最终判断。
- 更新 Node 测试，覆盖推荐配置、低于推荐但通过最低配置、低于最低配置三种情况。

## 五、验收标准

1. 4/8/50 及以上资源预检无资源 warning 并通过。
2. 2 核、4 GB、10 GB 资源预检通过但展示 warning，并进入安装确认流程；Windows 控制端安装远程 Linux 同样适用。
3. 低于 2 核、4 GB 或 10 GB 时只因对应资源项阻止安装。
4. Windows 与 Linux/macOS 使用相同阈值语义，其他系统安全检查不变。
5. 完整 `npm test`、构建、打包和 GitHub Windows CI 通过。
