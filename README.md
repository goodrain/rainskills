# Rainskills

> 让你的 AI Agent 把应用真正跑起来。

Rainskills 是一组开源 Agent Skills，让 Codex、Claude Code、Pi Agent、
DeepSeek Harness、WorkBuddy 和 Hermes Agent 能够完成应用识别、部署、
排错、交付验证、版本管理和回滚。

安装后，你只需要告诉 Agent：

> 帮我把当前项目部署上线，并验证页面和 API。

Rainskills 会分析项目结构、组件和依赖，连接 Rainbond Cloud、已有 Rainbond，
或者在本机和服务器上安装 Rainbond，然后继续完成部署与验证。

**AI 负责生成，Rainskills 负责部署，Rainbond 负责持续运行。**

[快速安装](https://www.rainbond.com) ·
[使用文档](https://www.rainbond.com/docs/ai/rainskills) · [Rainbond Cloud](https://run.rainbond.com)

## 快速安装

从 Skill 市场安装：

```bash
npx skills add goodrain/rainskills
```

或者直接运行：

```bash
npx --yes rainskills
```

安装后，在项目目录告诉 Agent：

> 帮我部署当前项目，并验证页面和 API。

## Rainskills 可以做什么

- 识别本地项目、Git 仓库、镜像和开源软件
- 分析前端、后端、数据库及组件依赖
- 自动完成应用构建和部署
- 根据事件和日志排查部署故障
- 验证组件状态、访问地址、页面和 API
- 管理应用版本、升级、快照和回滚

## License

Apache-2.0
