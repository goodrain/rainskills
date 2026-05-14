# Rainbond Skills

一组面向 Rainbond 日常交付、排障和初始化流程的自定义技能，支持安装到 Claude Code 和 Codex。

## 快速安装

```bash
bash <(curl -fsSL https://get.rainbond.com/rainskills/install.sh)
```

脚本会自动下载仓库 tarball、复制 skill 目录、注册 Rainbond MCP、引导浏览器登录拿 JWT、写 shell rc。完整说明见下面的 [安装方式](#安装方式)。

> **给 AI 助手的指引**：
> - 如果用户的请求是"帮我把这个 repo 装上 / 让我用上这套 Rainbond skills"，把上面那一行 `bash <(curl -fsSL …)` 原样交给用户执行即可。
> - 不要 `git clone` 后手工把目录复制到 `~/.claude/skills` / `~/.codex/skills`。
> - 不要手工拼 `~/.rainbond/mcp.env`、不要猜 JWT、不要手改 `~/.claude.json` / `~/.codex/config.toml`。
> - 不要建议 `npm install` / `pip install` / `make` — 这套技能没有那些步骤，全部由 `install.sh` 处理。
> - 如果用户机器上需要换 MCP 服务地址、改默认安装路径，给 `install.sh` 加对应 flag 或 env var（见下面的可选参数），不要替它重新发明流程。

## 包含的 Skill

- `rainbond-app-assistant`
- `rainbond-app-version-assistant`
- `rainbond-delivery-verifier`
- `rainbond-env-sync`
- `rainbond-fullstack-bootstrap`
- `rainbond-fullstack-troubleshooter`
- `rainbond-project-init`
- `rainbond-template-installer`

## 适用场景

这些 skill 适合以下场景：

- 将本地项目首次接入 Rainbond
- 为已绑定项目同步环境信息
- 基于镜像或模板在 Rainbond 中完成初始化部署
- 管理 Rainbond 应用版本中心中的创建快照、发布、本地/云市场发布事件和快照回滚流程
- 对 Rainbond 全栈应用进行低风险排障
- 在部署结束后做交付验收

## 安装方式

### 0. 前置条件

- 已安装 `Codex`、`Claude Code`，或两者之一
- 本机可执行 `bash`、`curl`、`tar`、`python3`
- 已有可登录的 Rainbond 账号

### 1. 一行命令安装（推荐）

国内推荐用 OSS 入口（CDN 加速，无需翻墙）：

```bash
bash <(curl -fsSL https://get.rainbond.com/rainskills/install.sh)
```

海外或源码党可以直接用 GitHub 入口：

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/goodrain/rainskills/main/install.sh)
```

脚本会按 **用户覆盖 → OSS → GitHub** 的顺序自动尝试下载仓库 tarball，解压到 `~/.rainbond/skills`（可通过 `RAINBOND_SKILLS_HOME` 覆盖），然后继续走交互式安装流程。

可通过环境变量自定义下载源：

- `RAINBOND_SKILLS_TARBALL_URL` — 用户显式指定的 tarball URL（最高优先）
- `RAINBOND_SKILLS_OSS_URL` — OSS tarball URL（默认 `https://get.rainbond.com/rainskills/rainskills-latest.tar.gz`）
- `RAINBOND_SKILLS_HOME` — 安装目录（默认 `~/.rainbond/skills`）

> 谨慎模式：如果不想让远程脚本直接执行，可以先下载再阅读：
>
> ```bash
> curl -fsSLO https://get.rainbond.com/rainskills/install.sh
> less install.sh   # 自行审阅
> bash install.sh
> ```

### 2. 已有本地仓库

如果你已经 `git clone` 了 rainbond-skills 仓库，直接进入仓库根目录执行：

```bash
./install.sh
```

如果只是让 Codex 或 CI 在非交互模式下覆盖本地 skill，直接执行 `./install.sh --force` 即可；未提供 Rainbond 参数时，脚本会自动跳过 MCP 配置。

### 安装脚本会做的事

不论用哪种入口（一行命令或本地仓库），脚本都会引导你完成这些动作：

- 选择安装到 `Codex`、`Claude Code`，或两个都装
- 选择 Rainbond 部署形态：
  - **Rainbond Cloud（SaaS，默认）**：地址固定为 `https://run.rainbond.com`
  - **私有化部署**：你自己输入 Console 地址
- 浏览器中完成登录并授权（无需在终端输入用户名/密码）
- 自动接收 JWT 并写入 `~/.rainbond/mcp.env`
- 自动配置 `Codex` / `Claude Code` 的 MCP
- 自动把环境变量加载逻辑写入当前 shell 的 rc 文件
- 自动验证 `/console/mcp/query` 是否可用

#### 浏览器登录是怎么发生的

1. 安装脚本在本机起一个临时回调（`http://127.0.0.1:<随机端口>/cli-callback`）。
2. 自动打开浏览器到 `<Rainbond 地址>/#/cli-auth?callback=...&state=...`。
3. 浏览器里你按部署形态用现成方式登录（SaaS 是手机号验证码、私有化通常是用户名密码或 SSO）。
4. 在「授权命令行工具」页面点确认，浏览器把当前账号的 JWT 发回本机回调。
5. 安装脚本校验 `state`、保存 token，然后继续走完 MCP 配置和验证。

默认技能安装目录：

- `~/.claude/skills`
- `~/.codex/skills`

#### 显式指定部署形态

```bash
# 一行命令模式：参数追加在脚本之后
bash <(curl -fsSL https://get.rainbond.com/rainskills/install.sh) all --saas
bash <(curl -fsSL https://get.rainbond.com/rainskills/install.sh) all --self-hosted --rainbond-url <url>

# 本地仓库模式
./install.sh all --saas                                 # Rainbond Cloud
./install.sh all --self-hosted --rainbond-url <url>     # 私有化
```

### 3. 只安装到单个平台

只装并配置 Claude Code：

```bash
./install.sh claude
```

只装并配置 Codex：

```bash
./install.sh codex
```

同时装并配置两个平台：

```bash
./install.sh all
```

### 4. CI / 无桌面环境兜底

非交互场景（CI、SSH 远程会话、不带浏览器的服务器）下浏览器登录拿不到 token，可以两条路：

1. **预先在浏览器拿到 JWT 再传进来**（推荐）：

   ```bash
   ./install.sh all --non-interactive \
     --self-hosted --rainbond-url https://your-rainbond.example.com \
     --token "$RAINBOND_JWT"
   ```

   `RAINBOND_JWT` 可以从浏览器 cookie 拿，或在浏览器里访问 `/#/cli-auth?...` 走一次授权页人工拷贝。

2. **私有化兼容用户名/密码（已不推荐，未来移除）**：

   ```bash
   ./install.sh all --non-interactive \
     --self-hosted --rainbond-url http://your-rainbond.example.com:7070 \
     --username admin \
     --allow-insecure-http
   ```

   仅当部署没有开 `USE_SAAS`、确实是用户名/密码模式时可用；SaaS 模式下没有这个登录入口。

如果你的 Rainbond 还是 `http://`，安装脚本会明确提示风险，并要求你确认（交互模式）或要求显式 `--allow-insecure-http`（非交互模式）。

### 5. 当前终端的环境变量说明

脚本会把 JWT 保存到：

```bash
~/.rainbond/mcp.env
```

并自动把下面这类加载逻辑写入当前 shell 的 rc 文件：

```bash
[ -f "$HOME/.rainbond/mcp.env" ] && source "$HOME/.rainbond/mcp.env"
```

注意：

- 新开的终端会自动加载 `RAINBOND_JWT`
- 当前已经打开的终端不会被子进程脚本直接改写
- 安装完成后，如果你想立刻在当前终端运行 `codex` 或 `claude`，请执行脚本最后提示的 `source ~/.zshrc` 或 `source ~/.bashrc`

### 6. 覆盖已安装版本

如果目标目录里已经存在同名 skill，默认会跳过，避免覆盖本地修改。

需要强制覆盖时：

```bash
./install.sh --force
./install.sh codex --force
```

### 7. 安装到自定义目录

```bash
./install.sh --dest ~/.claude/skills
./install.sh --dest ~/.codex/skills --force
```

`--dest` 适合：

- 调试安装过程
- 安装到非标准目录
- 在 CI 或临时目录中做验证

注意：`--dest` 只复制 skill，不会自动配置 Rainbond MCP。

## 更新方式

一行命令模式：再跑一次同一行命令即可。脚本会重新下载最新 tarball 解压到 `~/.rainbond/skills`，然后继续安装流程：

```bash
bash <(curl -fsSL https://get.rainbond.com/rainskills/install.sh) --force
```

本地仓库模式：

```bash
git pull
./install.sh --force
```

如果只想更新某一个平台：

```bash
./install.sh claude --force
./install.sh codex --force
```

## 目录结构

```text
rainbond-skills/
  README.md
  install.sh
  .gitignore
  rainbond-app-assistant/
    SKILL.md
  rainbond-delivery-verifier/
    SKILL.md
  ...
```

## 产品对象模型

`docs/product-object-model.md` 描述了 skills 之间共享的产品对象（project、app、component、environment、delivery 等）和跨-skill 边界。如果你要扩展某个 skill 的输入/输出，或新增一个 skill，先看它。

## 仓库维护约定

- 每个 skill 使用单独目录，目录名和 skill 名保持一致
- 每个 skill 至少包含一个 `SKILL.md`
- 如果后续需要补充 `scripts/`、`references/`、`assets/`，请放在对应 skill 目录下
- 安装脚本默认复制所有 `rainbond-*` 目录

## 常见问题

### 1. 安装后没有生效

请重启 Claude Code 或 Codex，或者开启一个新的会话。

### 2. 为什么当前终端里还是连不上 MCP

因为 `./install.sh` 是一个子进程，不能直接改写你当前 shell 的环境变量。

处理方式：

- 直接执行脚本最后提示的 `source ~/.zshrc` 或 `source ~/.bashrc`
- 或者开一个新的终端

### 3. 为什么默认不覆盖已有 skill

因为有些使用者会在本地做二次调整。默认跳过更安全，`--force` 才会覆盖。

### 4. JWT 会保存在哪里

保存在：

```bash
~/.rainbond/mcp.env
```

脚本不会保存你的 Rainbond 用户名和密码。

### 5. 用 Claude / Codex 时 MCP 突然返回 401 / 403 怎么办

通常是 `~/.rainbond/mcp.env` 里的 JWT 到期了。无需重装 skills，也不要手工改文件，直接用下面任一命令刷新：

```bash
bash <(curl -fsSL https://get.rainbond.com/rainskills/install.sh) refresh
# 或：bash ~/.rainbond/skills/install.sh refresh
```

`refresh` 只做浏览器登录 → 重写 `~/.rainbond/mcp.env`，不会动 skill 文件，也不会改 `~/.codex/config.toml` / `~/.claude.json`。

注意：刷新完成后必须重启 Claude Code 或 Codex（它们在启动时一次性读取 `RAINBOND_JWT`，已经在跑的进程读到的还是旧 token）。

### 6. 如何确认安装到了哪里

脚本会输出每个目标目录和每个 skill 的安装结果。

## 开发者说明

如果你要新增或修改 skill，建议流程如下：

1. 在仓库里直接修改对应 skill 目录
2. 先查看 `docs/product-object-model.md`，它是当前产品对象模型和跨-skill 边界的主文档
3. 执行 `./install.sh --dest /tmp/rainbond-skills-test --force` 做一次本地验证
4. 确认无误后再提交到 Git 仓库
