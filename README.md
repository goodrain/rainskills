# RainSkills

> 让你的 AI Agent 把当前项目部署上线，并验证页面和 API。

RainSkills 是一组开源 Agent Skills，让 Codex、Claude Code、Pi Agent、
DeepSeek Harness、WorkBuddy 和 Hermes Agent 能够继续完成应用部署、
故障排查、交付验证、版本管理和回滚。

它从 Agent 已经理解的当前项目出发，把前端、后端、数据库、缓存、
端口和存储组织成 Rainbond 应用。应用可以运行在 Rainbond Cloud、
你自己的服务器或 Kubernetes 中。

**AI 负责生成，RainSkills 负责交付，Rainbond 负责持续运行。**

[产品介绍](https://www.rainbond.com/rainskills) ·
[安装与使用](https://www.rainbond.com/docs/ai/rainskills) ·
[视频教程](https://www.rainbond.com/videos/rainskills-ai-deploy) ·
[Rainbond Cloud](https://run.rainbond.com)

## 为什么使用 RainSkills

AI Agent 已经理解了代码、依赖和项目结构。进入部署阶段后，如果改用临时脚本或直接 SSH，
这些上下文通常需要重新整理，部署结果也很难沉淀为可以持续维护的应用。

| 对比维度 | Agent 直接 SSH / 临时脚本 | RainSkills + Rainbond |
| --- | --- | --- |
| 工作起点 | 重新整理服务器、端口、依赖和命令 | 直接复用当前项目上下文 |
| 应用结构 | 人工拼装进程、数据库、网络和存储 | 用应用拓扑管理组件与依赖 |
| 失败排查 | 手工寻找构建、容器和网关日志 | Agent 读取构建日志、运行日志、Pod 和平台事件 |
| 完成标准 | 命令成功或进程已经启动 | 页面和 API 完成实际访问验证 |
| 权限边界 | Agent 通常直接持有 SSH 或生产凭据 | 浏览器授权、受控工具调用和高风险操作确认 |
| 后续维护 | 继续维护脚本和服务器差异 | 在同一应用上升级、快照、发布和回滚 |

RainSkills 更适合多组件应用、自托管环境、私有化交付，以及需要持续排障和版本管理的项目。

## RainSkills 如何工作

```text
当前项目或部署目标
  → Codex、Claude Code 等 AI Agent
  → RainSkills 选择对应的部署、排障或验证 Skill
  → 首次需要时选择并连接一个 Rainbond 运行环境
  → Rainbond 构建并运行应用
  → RainSkills 验证页面、API 和最终访问地址
```

RainSkills 安装与运行环境连接是两个阶段。安装完成后可以直接提出部署任务；
第一次需要 Rainbond 时，Agent 再引导你选择 Cloud、已有私有环境、本机或服务器。

![RainSkills 在 AI Agent 中完成应用部署并返回访问地址](https://grstatic.tos-cn-beijing.volces.com/wechat/rainskills/rainskills-deploy.png)

## 快速开始

使用 Skill 市场安装：

```bash
npx skills add goodrain/rainskills
```

或者直接运行官方安装器：

```bash
npx --yes rainskills
```

DeepSeek Harness 用户也可以把 RainSkills bootstrap 作为 profile bundle 安装：

```bash
dsh plugin --profile web add rainskills
```

安装后调用 `/rainskills`，或直接告诉 Agent“安装 RainSkills”。该 bundle 只注册
bootstrap Skill；完整的 `rainbond-*` Skills 仍由官方安装器统一安装和更新。

`npx` 安装方式需要 Node.js 18 或更高版本。建议使用仍在维护的 Node.js 22 或 24。

安装完成后，在项目目录告诉 Agent：

```text
帮我部署当前项目，并验证页面和 API。
```

如果还没有可用的 Rainbond，Agent 会在第一次需要运行环境时让你选择 Cloud、
已有私有环境、本机或服务器，不会在安装 Skill 时替你决定目标环境。

## 可以直接告诉 Agent 什么

- `帮我部署当前项目`
- `帮我部署这个 Git 仓库`
- `帮我通过镜像或安装包部署应用`
- `帮我安装一个应用模板`
- `帮我部署 Dify、n8n 或 Harbor`
- `帮我检查 backend 为什么构建失败`
- `确认当前应用是否已经交付成功，并给我访问地址`
- `给当前应用创建快照`
- `把当前应用回滚到上一个快照`

## 支持范围

### AI Agent

- Codex
- Claude Code
- Pi Agent
- DeepSeek Harness
- WorkBuddy
- Hermes Agent

### 项目来源

- 当前本地项目
- 普通 Git 仓库
- 本地软件包
- 私有容器镜像或单镜像组件
- Compose、Helm 或多镜像描述
- Dify、n8n、Harbor 等第三方开源应用
- Rainbond 应用模板

Compose、Helm 和第三方应用中的特权容器、Operator、CRD、Job、主机网络或主机目录等语义，
需要根据当前 Rainbond 能力单独判断，不承诺原样转换所有 Kubernetes 配置。

### 运行环境

- Rainbond Cloud
- 已经运行的私有 Rainbond
- 本机 Rainbond
- 独立服务器上的 Rainbond
- 已有 Kubernetes 集群中的 Rainbond

## 安全和权限边界

- 通过浏览器完成 Rainbond 授权，不要求在聊天中粘贴 JWT、密码或私钥。
- 创建、更新和删除资源前核对目标企业、团队、应用和组件。
- 删除资源、平台安装、数据变更和其他高风险操作需要明确确认。
- Rainbond 授权凭据保存在受保护的本地状态中，不写入项目文件。
- 部署完成后继续验证组件、页面和 API，不把命令成功当作交付完成。

用户明确选择在独立服务器安装 Rainbond 时，受控安装流程可能使用 SSH。
应用部署和后续管理仍通过 Rainbond 应用模型完成，而不是依赖散落的服务器命令。

## 适合哪些场景

- AI Agent 已经写完或修改了项目，需要继续部署。
- 项目包含前端、后端、数据库、缓存或异步任务。
- 应用需要运行在自己的服务器、私有云或 Kubernetes 中。
- 部署完成后仍需日志、升级、快照、发布和回滚。
- 团队需要复用私有化或客户现场的交付流程。

## 哪些场景可能不需要 RainSkills

- 只发布一个接受完全托管的纯静态页面。
- 团队已经有成熟的内部开发平台和 GitOps 流程。
- 只是一次性的本地实验，不需要持续运行、排障或回滚。

## 文档与支持

- [RainSkills 产品介绍](https://www.rainbond.com/rainskills)
- [安装与使用文档](https://www.rainbond.com/docs/ai/rainskills)
- [安装与连接视频教程](https://www.rainbond.com/videos/rainskills-ai-deploy)
- [市场上架 Runbook](https://github.com/goodrain/rainskills/blob/main/docs/marketplace-publishing.md)
- [Rainbond 安装文档](https://www.rainbond.com/docs/installation)
- [提交问题](https://github.com/goodrain/rainskills/issues)

## License

Apache-2.0
