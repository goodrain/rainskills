# RainSkills 市场上架 Runbook

本文记录 RainSkills 在 SkillsMP、DSH Market 和 ClawHub 的分发边界与人工操作。
代码改造不能替代账号授权、GitHub Topics、npm 发布或第三方 registry 审核。

## SkillsMP

SkillsMP 从公开 GitHub 仓库收集 `SKILL.md`，当前没有需要维护者上传压缩包或发布版本的流程。

人工操作：

1. 保持 `goodrain/rainskills` 为公开、未归档仓库。
2. 将准备上架的改动合并到默认分支。
3. 在 SkillsMP 搜索 `rainskills` 和 `rainbond`，确认根 Skill 与所有 `rainbond-*` Skills 已刷新。
4. 若条目长期未刷新、分类错误或需要处理重复条目，联系 `support@skillsmp.com`。

参考：

- https://skillsmp.com/about
- https://skillsmp.com/docs
- https://skillsmp.com/docs/api

## DSH Market

DSH Market 的目录来自 `awesome-dsh-plugin` registry。RainSkills 通过 npm 包中的
`dsh.bundle` 注册一个只读 bootstrap Skill；插件激活不会执行安装、连接 Rainbond 或修改
用户 Skill 目录。

### 1. 发布包含 DSH bundle 的 npm 版本

按照 [npm 发布 Runbook](npm-release-runbook.md) 发布一个新版本。发布前至少执行：

```bash
npm ci --ignore-scripts
npm test
npm audit --audit-level=high
npm publish --dry-run
```

发布后验证 npm 包和 DSH 安装：

```bash
npm run verify:published -- <version>
dsh plugin --profile web add rainskills@<version>
dsh --profile web --dump-config
```

确认 profile 中存在 `rainskills` patch row，并在新会话中确认 `/rainskills` 可用。

### 2. 设置 GitHub Topic

在仓库 About 设置中添加：

```text
dsh-plugin
```

也可以由有仓库管理权限的人执行：

```bash
gh repo edit goodrain/rainskills --add-topic dsh-plugin
```

`deepseek-harness` topic 可同时添加用于生态发现，但 registry 的硬性要求是 `dsh-plugin`。

### 3. 向 awesome-dsh-plugin 提交 PR

Fork `awesome-dsh-plugin/awesome-dsh-plugin`，新增：

```text
data/plugins/goodrain__rainskills.yml
```

建议内容：

```yaml
url: https://github.com/goodrain/rainskills
name: goodrain/rainskills
category: skill
description:
  en: Installs the RainSkills bootstrap for deploying, troubleshooting, and verifying applications on Rainbond from DeepSeek Harness.
  zh: 为 DeepSeek Harness 注册 RainSkills 引导技能，用于通过 Rainbond 部署、排障和验证应用。
```

只提交这个 YAML 数据文件；registry 的 README 会在合并后自动生成。不要在条目中手写
`npm:` 字段，registry 会从 npm 自动识别 `rainskills` 包。

PR 合并后，`dshmarket.com` 与 DSH 内的市场通常会在下一次目录刷新后出现条目。最终验证：

```bash
dsh plugin --profile web add rainskills
```

参考：

- https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.md
- https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/contributing.md
- https://dshmarket.com/p/dsh-market/dsh-market/

## ClawHub

当前 RainSkills 明确不支持 OpenClaw，因此不发布到 ClawHub，也不创建 ClawHub 账号、Token
或发布流水线。

如果未来决定支持 OpenClaw，需要先完成宿主安装路径、运行环境 target、更新行为和端到端测试，
再进行以下人工操作：

1. 使用符合上传门槛的 GitHub 账号登录 ClawHub。
2. 确认个人或 Goodrain 组织 owner namespace 的发布权限。
3. 接受 ClawHub 对已发布 Skill 使用 MIT-0 的许可要求；不得在 `SKILL.md` 中声明冲突许可证。
4. 安装并登录 CLI：`clawhub login`。
5. 先执行 dry run，再正式发布并设置 categories/topics。
6. 等待自动安全扫描和可能的人工审核完成。

参考：

- https://github.com/openclaw/clawhub/blob/main/docs/publishing.md
- https://github.com/openclaw/clawhub/blob/main/docs/skill-format.md
