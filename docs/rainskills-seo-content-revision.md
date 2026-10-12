# RainSkills SEO 与内容一致性改造说明

## 1. 文档目的

本文档定义 RainSkills 在 GitHub、npm 和 Rainbond 官方文档站中的内容改造范围，解决以下问题：

- Rainbond 文档站仍将 RainSkills 描述为需要配置客户端 MCP，已经与当前实现不一致。
- RainSkills 安装与运行环境连接被混写成一个步骤，容易让用户误解安装完成的含义。
- `/rainskills` 产品专题页与 `/docs/ai/rainskills` 使用文档覆盖相近搜索意图，页面定位不够清楚。
- `rainskills` 仓库 README 只说明了安装和功能，没有充分解释 RainSkills 相对直接 SSH、临时脚本和手工部署的价值。
- npm 元数据仍将产品主要描述为 installer，没有完整表达部署、排障和交付验证能力。

本文档是实施规格，不直接改变 RainSkills 的运行逻辑、Skill 路由、Rainbond API 或安装行为。

## 2. 适用仓库

| 仓库 | 路径 | 本次作用 |
| --- | --- | --- |
| rainskills | `/Users/guox/Desktop/Project/rainskills` | 产品 README、npm 元数据和事实来源 |
| rainbond-docs | `/Users/guox/Desktop/Project/rainbond-docs` | 产品专题页、使用文档、SEO 元数据和内容测试 |

## 3. 事实来源与内容原则

### 3.1 事实来源优先级

内容出现冲突时，按以下顺序判断：

1. 当前 `rainskills/SKILL.md` 中的公开产品行为与运行边界。
2. 当前 `rainskills/package.json`、安装器和运行时实现。
3. 各独立 `rainbond-*` Skill 的职责和路由规则。
4. Rainbond 官方文档站现有页面。
5. 历史博客、视频和第三方文章。

官方文档和历史内容不得覆盖当前代码已经明确改变的行为。

### 3.2 当前需要统一的产品事实

- RainSkills 是一组安装在 AI Agent 中的开源 Agent Skills。
- 当前支持 Codex、Claude Code、Pi Agent、DeepSeek Harness、WorkBuddy 和 Hermes Agent。
- 六类 Agent 使用同一套 Skills、受保护的本地 CLI 和单运行环境模型。
- 用户安装 RainSkills 时，只安装完整的独立 Skill 集合。
- 安装阶段不选择、不连接、也不配置应用运行环境。
- 用户首次提出部署、查询或其他需要 Rainbond 的任务时，才进入运行环境选择和连接。
- RainSkills 不要求为每个 Agent 配置独立的客户端 MCP adapter。
- Rainbond 查询和变更通过受保护的本地运行时及固定工具契约执行。
- RainSkills 只保存一个全局运行环境，不向用户展示环境列表、默认环境或环境 ID。
- 浏览器授权完成不代表连接流程已经结束；原连接命令完成 live probe 后才算连接成功。
- RainSkills 不把资源创建、命令退出码或组件显示运行中直接视为交付完成。
- 交付验证需要继续检查页面、API、组件状态和访问入口。

### 3.3 文案原则

- 展示名称统一写作 `RainSkills`。
- npm 包名、命令、GitHub 仓库名和 URL 使用小写 `rainskills`。
- 优先使用“当前项目”“部署到自己的服务器”“页面和 API 验证”“可访问地址”等用户语言。
- 不以 PaaS、Kubernetes、MCP 等实现名词作为首屏开场。
- 不使用“全自动”“零风险”“一键生产级”等无法验证的承诺。
- 不把 RainSkills 描述为适合所有项目和所有部署方式。
- 不编造部署时长、成功率、客户数量或用户评价。
- 对真实能力使用具体事实，避免“强大”“无缝”“领先”等空泛形容词。

## 4. 改造目标

### 4.1 产品准确性目标

- RainSkills 公开页面不再声称安装器会配置客户端 MCP。
- 安装和运行环境连接在所有核心入口中保持为两个阶段。
- 支持的 Agent、运行目标、权限边界和交付完成标准与当前仓库一致。

### 4.2 SEO 目标

- 产品专题页承接“AI 生成代码如何上线”“部署到自己的服务器”等非品牌搜索。
- 使用文档承接“RainSkills 安装”“RainSkills 使用”“RainSkills 支持哪些 Agent”等品牌和操作搜索。
- Claude Code、Codex、部署失败和 Vibe Coding 页面分别承接独立问题意图。
- GitHub README 和 npm 页面能够说明产品差异、适用场景和下一步行动。
- 每个页面的 title、H1、description、OG 和结构化数据保持一致。

### 4.3 转化目标

用户阅读 README 或专题页后，应当能够回答：

1. RainSkills 是什么。
2. 它与 Agent 直接 SSH 或临时脚本有什么区别。
3. 它支持哪些 Agent、项目来源和运行环境。
4. 安装后应该向 Agent 说什么。
5. 第一次连接 Rainbond 时会发生什么。
6. 哪些高风险决策仍由用户确认。
7. 如何判断应用已经真正交付。

## 5. 不在本次范围内的工作

- 不修改 RainSkills 安装器、运行时、Skill 路由或 Rainbond API。
- 不创建新的专题 URL。
- 不调整 sitemap、robots.txt、站点部署和国际化架构。
- 不添加未经验证的客户案例、评价或性能数据。
- 不修改 Rainbond 英文站。
- 不删除所有出现的 MCP 字样。只有将 RainSkills 描述为需要客户端 MCP 配置的内容必须改正；讨论真实服务端接口或其他产品能力时应保留准确术语。
- 不提交 Git commit，除非另有明确要求。

## 6. 第一部分：修正过时的 MCP 与安装流程表述

### 6.1 统一用户可见工作流

公开页面统一使用以下流程：

```text
当前项目或部署目标
  → AI Agent 理解用户意图
  → RainSkills 选择对应 Skill 和工作流
  → 首次需要时选择并连接一个 Rainbond 运行环境
  → Rainbond 构建和运行应用
  → RainSkills 持续排障并验证页面和 API
```

不再使用以下用户可见流程节点：

```text
RainSkills
  → Rainbond MCP
  → Rainbond 应用运行平台
```

建议替换为：

```text
RainSkills
  → 受保护的本地运行时
  → Rainbond 应用运行平台
```

### 6.2 统一安装流程

#### 第一步：安装 RainSkills

推荐提示词：

```text
帮我安装 RainSkills。
```

推荐命令：

```bash
npx --yes rainskills
```

安装完成只表示独立 Skills 和受保护的本地运行组件已经准备好，不表示：

- 已经选择 Rainbond Cloud 或私有环境。
- 已经完成浏览器授权。
- 已经连接运行环境。
- 已经创建或部署应用。

#### 第二步：提出业务任务

推荐提示词：

```text
帮我部署当前项目，并验证页面和 API。
```

如果尚未连接运行环境，对应业务 Skill 再引导用户选择：

- Rainbond Cloud。
- 已经运行的私有 Rainbond。
- 在本机准备私有 Rainbond。
- 在独立服务器或现有 Kubernetes 中准备私有 Rainbond。

#### 只连接运行环境

如果用户暂时不部署应用，可以使用：

```text
帮我连接应用运行环境。
```

### 6.3 统一授权失效表述

删除以下旧式说明：

- “刷新 Rainbond MCP”。
- “重新配置 MCP 环境变量”。
- “授权后重启 MCP 客户端”。
- 将 `npx --yes rainskills refresh` 作为首选公开恢复路径。

建议改成：

> 如果运行环境返回 401、403、unauthorized 或 token expired，让当前 Agent 重新连接 Rainbond。RainSkills 会重新进入浏览器授权，并在原连接流程完成 live probe 后恢复使用。

面向普通用户的主文档优先提供自然语言提示词：

```text
帮我重新连接 Rainbond。
```

内部固定 launcher、目标参数、状态 JSON 和凭据文件路径不进入营销页和入门 README。

### 6.4 术语替换表

| 旧表述 | 新表述 |
| --- | --- |
| 通过 Rainbond MCP 完成部署 | 通过受保护的本地运行时连接 Rainbond 并完成部署 |
| Rainbond MCP 返回的平台状态 | Rainbond 返回的真实平台状态 |
| 配置当前 Agent 对应的 Rainbond MCP | 安装完整 Skill 集合和受保护的本地运行组件 |
| 验证 MCP 是否可以访问 | 首次需要时完成授权和 live probe |
| MCP 客户端在启动时读取环境变量 | RainSkills 将唯一运行环境凭据保存在受保护的本地状态中 |
| 通过 MCP、平台权限和确认执行 | 通过受控工具调用、平台权限和确认执行 |
| Agent Skills 与 MCP 接口 | Agent Skills 与受保护的本地运行时 |

## 7. 第二部分：页面搜索意图与元数据

### 7.1 URL 与关键词分工

| URL | 页面角色 | 主搜索意图 | 避免争夺的意图 |
| --- | --- | --- | --- |
| `/rainskills` | 产品专题页 | AI 生成代码如何上线、部署到自己的服务器 | 具体安装命令和完整操作手册 |
| `/docs/ai/rainskills` | 使用文档 | RainSkills 安装、连接和使用 | 泛化的 AI 项目上线问题 |
| `/rainskills/claude-code-deploy-app` | 工具场景页 | Claude Code 部署应用 | Codex 部署和通用产品介绍 |
| `/rainskills/codex-deploy-app` | 工具场景页 | Codex 部署应用 | Claude Code 部署和通用产品介绍 |
| `/rainskills/ai-deployment-troubleshooting` | 问题解决页 | AI 项目部署失败排查 | 产品安装和一般项目上线 |
| `/rainskills/vibe-coding-go-live` | 教育内容页 | Vibe Coding 项目上线生产 | RainSkills 品牌导航搜索 |

### 7.2 产品专题页 `/rainskills`

建议 title：

```text
AI 生成代码如何部署到自己的服务器 | RainSkills
```

建议 H1：

```text
AI 生成代码如何部署到自己的服务器
```

建议 description：

```text
RainSkills 让 Codex、Claude Code 等 AI Agent 读取当前项目，通过 Rainbond 部署到自己的服务器或 Kubernetes，继续排查构建与运行问题，并验证页面和 API。
```

首屏副标题建议：

> 把 RainSkills 安装到你正在使用的 AI Agent。Agent 可以带着当前项目上下文继续完成部署、排障、访问验证和后续版本管理。

页面主体仍保留：

- 部署上下文不会在代码完成时中断。
- 应用以组件和依赖关系持续管理。
- 页面和 API 验证是交付完成条件。
- 用户可以选择自己的服务器或 Kubernetes。

减少以下内容在该页面中的比重：

- 详细安装命令变体。
- 更新、重连和内部运行时命令。
- RainAgent 的长篇比较。

这些内容交给使用文档承接。

### 7.3 使用文档 `/docs/ai/rainskills`

建议 title：

```text
RainSkills 安装与使用：支持的 Agent、运行环境与部署流程
```

建议 H1：

```text
RainSkills 安装与使用
```

建议 description：

```text
了解如何在 Codex、Claude Code、Pi Agent、DeepSeek Harness、WorkBuddy 和 Hermes Agent 中安装 RainSkills，连接 Rainbond，并部署、排障和验证应用。
```

该页面重点回答：

- RainSkills 是什么。
- 支持哪些 Agent。
- 如何安装。
- 安装完成后该做什么。
- 如何选择和连接运行环境。
- 如何重新授权。
- 常用提示词。
- 安全和权限边界。

文档结构建议调整为：

1. RainSkills 是什么。
2. 支持的 Agent 和系统。
3. 安装 RainSkills。
4. 安装后的第一条任务。
5. 连接应用运行环境。
6. RainSkills 能做什么。
7. 常用提示词。
8. 更新、重新连接和故障处理。
9. 安全、权限和数据边界。
10. 常见问题。

### 7.4 Claude Code 页面

建议 title 与 H1：

```text
Claude Code 部署应用到自己的服务器 | RainSkills
```

建议 description：

```text
使用 Claude Code 和 RainSkills 识别当前项目，通过 Rainbond 部署到自己的服务器或 Kubernetes，持续排查构建与运行问题并验证最终访问地址。
```

保留核心内容：

- 从当前目录识别项目。
- 前端、后端、数据库和缓存的组件边界。
- 部署前本地构建验证。
- 部署失败分层排查。
- 页面和 API 交付验证。

### 7.5 Codex 页面

建议 title 与 H1：

```text
Codex 部署应用到自己的服务器 | RainSkills
```

建议 description：

```text
使用 Codex 和 RainSkills 将当前项目部署到 Rainbond，在代码修改后继续跟踪构建、启动和访问状态，并验证页面、API 和最终访问地址。
```

保留核心内容：

- 代码修改后运行测试和构建。
- 明确仓库边界和目标应用。
- 更新已有组件或创建应用拓扑。
- 验证最终访问结果。
- 发布失败时保留回滚路径。

### 7.6 部署失败排查页面

建议 title 与 H1：

```text
AI 项目部署失败怎么排查：构建、启动与访问问题
```

建议 description：

```text
按项目识别、源码构建、镜像调度、进程启动、组件依赖和对外访问六个层级排查 AI 项目部署失败，并根据日志和平台事件定位根因。
```

该页面不承担 RainSkills 安装意图，产品只作为解决方案和执行工具自然出现。

### 7.7 Vibe Coding 上线页面

建议 title 与 H1：

```text
Vibe Coding 项目如何上线到生产环境
```

建议 description：

```text
将 Vibe Coding 生成的前端、后端和数据库项目部署到自己的服务器，补齐生产构建、敏感配置、持久化、域名、访问验证和回滚能力。
```

该页面重点承接“原型如何变成长期运行应用”，RainSkills 作为实现路径出现，不把品牌词放在每个标题中。

### 7.8 元数据一致性要求

每个页面同时检查：

- front matter `title`。
- 页面 `<title>`。
- H1。
- meta description。
- `og:title`。
- `og:description`。
- TechArticle `headline` 和 `description`。
- 页面内相关链接的锚文本。

canonical URL 保持不变，不新增重定向。

删除使用文档中固定的过期 `dateModified`。如果不能从 Git 或构建过程得到可信日期，则暂不输出该字段。

## 8. 第三部分：README 改造规格

### 8.1 README 的主要读者

- 正在使用 AI 编码工具的个人开发者和小团队。
- 已经有一个项目，希望部署到自己的服务器或 Kubernetes 的用户。
- 希望保留基础设施控制权，但不想手工拼装部署流程的用户。
- 需要把一次部署沉淀为可排障、可升级和可回滚应用的团队。

README 首屏优先服务“我刚写完项目，下一步如何上线”的读者，不从 Rainbond 平台概念开始解释。

### 8.2 README 推荐目录

```text
# RainSkills
一句话定位
安装命令和主要文档入口

## 为什么使用 RainSkills
## RainSkills 如何工作
## 快速开始
## 可以直接告诉 Agent 什么
## 支持的 Agent、项目来源和运行环境
## 安全和权限边界
## 适合哪些场景
## 哪些场景可能不需要 RainSkills
## 文档与支持
## License
```

README 建议控制在 150 至 220 行。内容应可扫描，不复制完整使用文档和内部 Skill 契约。

### 8.3 README 首屏建议文案

```markdown
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
```

### 8.4 “为什么使用 RainSkills”建议内容

建议使用精确的比较对象“Agent 直接 SSH / 临时脚本”，避免将所有传统部署方式笼统描述为落后方案。

```markdown
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
```

比较表下方增加限定说明：

> RainSkills 更适合多组件应用、自托管环境、私有化交付，以及需要持续排障和版本管理的项目。

### 8.5 “RainSkills 如何工作”建议内容

````markdown
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
````

实现 README 时需要正确嵌套 Markdown 代码块，可以使用四个反引号包裹包含三反引号的示例，或取消最外层示例代码块。

### 8.6 “快速开始”建议内容

````markdown
## 快速开始

使用 Skill 市场安装：

```bash
npx skills add goodrain/rainskills
```

或者直接运行官方安装器：

```bash
npx --yes rainskills
```

`npx` 安装方式需要 Node.js 18 或更高版本。建议使用仍在维护的 Node.js 22 或 24。

安装完成后，在项目目录告诉 Agent：

```text
帮我部署当前项目，并验证页面和 API。
```
````

不在快速开始中要求用户提前选择 Cloud、自托管或 Kubernetes。对应选择由第一次业务任务在需要时触发。

### 8.7 “可以直接告诉 Agent 什么”建议内容

```markdown
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
```

这些示例覆盖真实 Skill 路由，不加入当前尚未实现的提示词。

### 8.8 支持范围建议内容

```markdown
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

### 运行环境

- Rainbond Cloud
- 已经运行的私有 Rainbond
- 本机 Rainbond
- 独立服务器上的 Rainbond
- 已有 Kubernetes 集群中的 Rainbond
```

对于 Compose、Helm 和第三方开源应用，不应承诺原样支持所有 Kubernetes 语义。README 可以链接详细文档说明兼容性边界。

### 8.9 安全和权限边界建议内容

```markdown
## 安全和权限边界

- 通过浏览器完成 Rainbond 授权，不要求在聊天中粘贴 JWT、密码或私钥。
- 创建、更新和删除资源前核对目标企业、团队、应用和组件。
- 删除资源、平台安装、数据变更和其他高风险操作需要明确确认。
- 敏感配置保存在受保护的运行环境中，不写入公开文档或项目清单。
- 部署完成后继续验证组件、页面和 API，不把命令成功当作交付完成。
```

不要承诺 RainSkills 永远不会使用 SSH。平台安装流程在用户明确选择服务器后可能使用受控 SSH；核心差异是不会把散落的直接 SSH 命令当作长期应用交付模型。

### 8.10 适合与不适合场景

```markdown
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
```

### 8.11 真实证据与截图

README 可以复用现有的真实部署截图：

```text
https://grstatic.tos-cn-beijing.volces.com/wechat/rainskills/rainskills-deploy.png
```

建议 alt：

```text
RainSkills 在 AI Agent 中完成应用部署并返回访问地址
```

截图前后只描述可从图片和当前产品行为验证的事实，不添加无法核实的耗时、成功率或生产等级结论。

### 8.12 README 中避免出现的内容

- 过长的内部 Skill 列表和路由规则。
- 受保护目录、固定 launcher 路径和运行时 JSON schema。
- 客户端 MCP 配置说明。
- 已过期的 `refresh` 命令作为主要用户流程。
- 旧版多环境列表、默认环境或环境 ID 概念。
- 未经验证的客户案例和指标。
- “无须任何配置”“一次命令即可生产上线”等绝对表述。

## 9. 第四部分：npm 与 GitHub 元数据

### 9.1 `package.json` description

当前 description 主要强调安装器，建议调整为：

```text
Agent Skills for deploying, troubleshooting, and verifying applications on Rainbond from Codex, Claude Code, and other AI coding agents
```

该描述同时覆盖产品类别、核心动作和主要入口，不使用无法验证的营销词。

### 9.2 `package.json` homepage

建议从 GitHub README 调整为：

```text
https://www.rainbond.com/rainskills
```

`repository` 和 `bugs` 继续指向 GitHub。

### 9.3 `package.json` keywords

建议保留并扩充为：

```json
[
  "rainbond",
  "ai-agent",
  "agent-skills",
  "deployment",
  "application-delivery",
  "self-hosted",
  "kubernetes",
  "devops",
  "vibe-coding",
  "codex",
  "claude-code",
  "pi-agent",
  "deepseek-harness",
  "workbuddy",
  "hermes-agent"
]
```

避免加入产品不直接提供的关键词，例如通用 hosting、serverless、CI/CD platform 或 client MCP server。

## 10. 逐文件修改清单

### 10.1 rainskills

#### `README.md`

- 统一品牌写法为 RainSkills。
- 重写首屏定位。
- 修正“快速安装”链接，使其指向产品专题页。
- 新增优势对比、工作流程、提示词、支持范围、安全边界和适用场景。
- 明确安装与运行环境连接分离。
- 复用真实部署截图。

#### `package.json`

- 更新 description。
- 更新 homepage。
- 扩充并校准 keywords。

#### 可能受影响的测试

- 检查 `tests/npm-package.test.js` 是否对 description、homepage 或 keywords 有固定断言。
- 检查发布包验证脚本是否对元数据有白名单。
- 只更新与本次公开元数据变化直接相关的断言。

### 10.2 rainbond-docs

#### `docs/ai/rainskills/index.md`

- 改为安装与使用意图。
- 移除客户端 MCP 配置和旧刷新说明。
- 将安装与连接拆成两个阶段。
- 完整列出六类 Agent。
- 更新工作流、FAQ、OG 和 JSON-LD。
- 删除不可信的固定 `dateModified`。

#### `docs/ai/index.md`

- 将 RainSkills 依赖 Rainbond MCP 的表述改为受保护的本地运行时和真实平台状态。
- 保持该页作为 AI 能力总览，不增加过多安装细节。

#### `src/components/Solutions/RainSkillsDeployment.tsx`

- 更新产品专题页 title、description、H1 和首屏副标题。
- 将“更多 AI Agent”中的 MCP 表述改为六类 Agent 共用 Skill 和本地运行时。
- 更新对比表中的安全边界表述。
- 保持 SoftwareApplication、FAQ 和 Breadcrumb JSON-LD，但确保描述一致。

#### `rainskills/index.mdx`

- 更新 front matter title、description 和关键词方向。
- 与组件中的 title、description 保持一致。

#### `rainskills/claude-code-deploy-app.mdx`

- 更新 title、H1、description、OG 和 TechArticle headline。
- 统一“Claude Code 部署应用”的空格和写法。
- 将安装与连接说明拆开。

#### `rainskills/codex-deploy-app.mdx`

- 更新 title、H1、description、OG 和 TechArticle headline。
- 将重点放在代码修改后的测试、发布和交付验证。
- 将安装与连接说明拆开。

#### `rainskills/ai-deployment-troubleshooting.mdx`

- 更新 title、H1、description、OG 和 TechArticle headline。
- 保持六层排查结构。
- 减少品牌关键词占比，强化问题搜索意图。

#### `rainskills/vibe-coding-go-live.mdx`

- 更新 title、H1、description、OG 和 TechArticle headline。
- 强化生产构建、敏感配置、持久化、域名、验证和回滚。

#### `rainskillsSidebar.js`

- 更新可见标签中的空格和自然语言。
- 保持现有页面顺序和 URL。

#### `tests/rainskills-seo-geo.test.cjs`

- 删除对 Rainbond MCP 节点和客户端配置的要求。
- 增加安装与连接分离的断言。
- 更新使用文档 title、H1、description 和结构化数据断言。
- 删除对固定过期 `dateModified` 的要求。

#### `tests/rainskills-topic-page.test.cjs`

- 更新六个页面的 title 和关键词意图断言。
- 保持 canonical、TechArticle、内部链接、响应式和可访问性断言。
- 增加公开专题页不得宣称客户端 MCP adapter 的断言。

## 11. 测试与验证

### 11.1 rainskills

执行：

```bash
npm test
git diff --check
```

额外检查：

- `npm pack --dry-run` 或项目已有发布包验证流程仍能读取正确元数据。
- README 中所有站内外链接可访问。
- Markdown 表格和嵌套代码块在 GitHub 正常渲染。
- README 没有引用本机路径或内部受保护状态。

### 11.2 rainbond-docs

执行：

```bash
node tests/rainskills-seo-geo.test.cjs
node tests/rainskills-topic-page.test.cjs
yarn build
git diff --check
```

构建后检查：

- `/rainskills` 只有一个 H1。
- `/docs/ai/rainskills` 只有一个 H1。
- 六个页面均生成独立 title 和 description。
- canonical URL 与当前 URL 一致。
- 旧 `/solutions/rainskills` 重定向保持有效。
- sitemap 继续包含五个专题 URL。
- JSON-LD 可以被浏览器渲染，并通过结构化数据验证工具检查。
- 页面不包含意外的 `noindex`。

## 12. 验收标准

### 12.1 内容准确性

- [ ] RainSkills 公开核心页面不再声称安装器配置客户端 MCP。
- [ ] 安装完成与运行环境连接成功被明确区分。
- [ ] 所有核心页面列出的 Agent 与当前代码一致。
- [ ] 运行环境说明符合单运行环境模型。
- [ ] 重新授权说明符合当前 reconnect 行为。
- [ ] README 不暴露内部 launcher、凭据路径或 JSON contract。

### 12.2 SEO

- [ ] 产品专题页和使用文档拥有不同主搜索意图。
- [ ] 六个页面的 title、H1 和 description 唯一。
- [ ] Claude Code 与 Codex 页面不互相复制标题和首段。
- [ ] 部署失败页以问题解决为主，不以品牌介绍为主。
- [ ] Vibe Coding 页以从原型到生产为主。
- [ ] canonical、URL 和重定向保持不变。
- [ ] 不依赖 meta keywords 作为主要优化手段。

### 12.3 README 与 npm

- [ ] README 在首屏说明产品、目标用户和下一步。
- [ ] README 包含 RainSkills 与直接 SSH / 临时脚本的准确比较。
- [ ] README 说明适合和不适合的场景。
- [ ] README 明确安装和连接是两个阶段。
- [ ] README 使用 RainSkills 作为展示品牌。
- [ ] npm description 表达部署、排障和验证能力。
- [ ] npm homepage 指向产品专题页。
- [ ] npm keywords 与实际产品能力一致。

### 12.4 工程质量

- [ ] `rainskills` 全部相关测试通过。
- [ ] `rainbond-docs` 两个 RainSkills 专项测试通过。
- [ ] `rainbond-docs` 完整构建通过。
- [ ] 两个仓库的 `git diff --check` 通过。
- [ ] 不修改 `rainskills/.agents/product-marketing.md`。
- [ ] 不覆盖用户已有的无关改动。

## 13. 实施时的风险控制

### 13.1 不要把“移除客户端 MCP”写成“Rainbond 完全没有 MCP”

本次修正针对用户端安装方式和产品工作流。Rainbond 服务端、其他产品能力或历史接口仍可能使用 MCP 术语。修改时必须结合上下文，不做全仓机械替换。

### 13.2 不要承诺所有 Helm 和 Compose 应用都能无损迁移

RainSkills 可以分析 Compose、Helm 和镜像集合，但特权容器、Operator、CRD、Job、host network 和 host path 等语义仍可能需要兼容性判断。README 只能描述支持的输入方式，不承诺所有上游语义都能直接转换。

### 13.3 不要把平台安装描述成完全无 SSH

应用部署不会依赖散落的直接 SSH 脚本，但用户选择在独立服务器安装 Rainbond 时，受控安装流程可能使用 SSH。比较内容需要描述权限和应用模型差异，不使用绝对表述。

### 13.4 不要为了关键词重复制造近似页面

现有六个页面已经覆盖主要意图。本次只调整定位和内容，不新增 Pi Agent、WorkBuddy、Hermes Agent 等薄内容页面。只有出现明确搜索需求和足够独特内容时再单独评估。

### 13.5 不要在没有数据时声称 SEO 效果

修改完成后只能确认页面结构、内容准确性和搜索意图得到改善。自然流量、排名和转化变化需要 Search Console 与站点分析数据验证。

## 14. 完成后的预期状态

改造完成后，用户从不同入口进入时会获得一致但不重复的信息：

- GitHub README 解释 RainSkills 的价值、差异、支持范围和快速开始。
- npm 页面准确描述这是部署、排障和验证应用的 Agent Skills 套件。
- `/rainskills` 面向正在搜索“AI 生成代码如何上线”的新用户。
- `/docs/ai/rainskills` 面向已经决定使用 RainSkills、需要安装和操作说明的用户。
- 四篇专题文章分别解决 Claude Code、Codex、部署失败和 Vibe Coding 上线问题。
- 所有入口都遵循同一条产品事实：先安装 Skills，第一次业务任务需要时再连接一个 Rainbond 运行环境，最终以页面和 API 的真实验证作为交付依据。
