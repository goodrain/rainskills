# Rainbond Skills

一组面向 Rainbond 日常交付、排障和初始化流程的独立技能，支持 Codex、Claude Code 和 Pi。

## 快速安装

从 Skill 市场安装完整的 Rainskills 产品：

```bash
npx skills add goodrain/rainskills
```

Skill 市场命令当前要求 Node.js 22.20.0 或更高版本。无法升级时，可以直接运行下面的 Rainskills 安装器（最低支持 Node.js 18），或使用 CDN 入口。

市场只展示一个 `rainskills` 入口。首次使用时，该入口会启动随包携带的交互式安装器，继续完成客户端选择、Rainbond 环境选择、浏览器授权和本机 CLI 配置；内部 `rainbond-*` Skill 不需要单独安装。

安装完成后，10 个 `rainbond-*` Skill 仍各自独立加载、独立触发和独立维护。统一的是安装、授权和升级入口，不会把业务 Skill 合并成一个大 Skill。

也可以使用客户端自己的 Plugin 市场。无论使用哪种入口，都只会看到一个 `Rainskills`，第一次使用时仍然进入同一套初始化和授权流程。

Codex Plugin：

```bash
codex plugin marketplace add goodrain/rainskills
codex plugin add rainskills@goodrain
```

Claude Code Plugin（在 Claude Code 会话中执行）：

```text
/plugin marketplace add goodrain/rainskills
/plugin install rainskills@goodrain
/reload-plugins
```

Pi：

```bash
pi install npm:rainskills
```

也可以直接运行安装器：

```bash
npx --yes rainskills
```

安装器会识别或引导选择 Codex / Claude Code / Pi、填写 Rainbond 地址、打开浏览器授权、安装并验证本机 CLI，然后安装全部独立 Skill。没有 Node.js 或 Node 版本低于 18 时，使用保留的 CDN 安装方式：

```bash
bash <(curl -fsSL https://get.rainbond.com/rainskills/install.sh)
```

> **给 AI 助手的指引**：
> - 如果用户的请求是"帮我把这个 repo 装上 / 让我用上这套 Rainbond skills"，优先让用户执行 `npx --yes rainskills`。
> - 如果用户没有 Node.js、Node.js 低于 18，或 npm registry 不可用，改用上面的 CDN `curl` 命令。
> - AI 应识别自己运行在 Codex、Claude Code 或 Pi，并把对应 target 传给安装器，不要再询问用户客户端类型。macOS、Linux 和 WSL 不支持 OpenClaw 安装。
> - 不要 `git clone` 后手工把目录复制到任一客户端的 Skills 目录。
> - 不要手工拼 `~/.rainbond/credentials.env`、猜 JWT 或手改客户端配置。
> - 不要建议 `npm install -g`、`pip install` 或 `make`。`npx` 只是启动包内的 `install.sh`，两种入口使用同一套安装流程。
> - 如果用户机器上需要更换 Rainbond 地址或默认安装路径，把对应 flag 直接追加到 `npx --yes rainskills` 或 `install.sh` 后面。

## 包含的 Skill

- `rainbond-app-assistant`
- `rainbond-app-version-assistant`
- `rainbond-delivery-verifier`
- `rainbond-env-sync`
- `rainbond-fullstack-bootstrap`
- `rainbond-fullstack-troubleshooter`
- `rainbond-platform-installer`（内部安装流程，不作为独立产品使用）
- `rainbond-platform-query`（当前用户、企业、团队、集群、应用和组件的轻量只读查询）
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
- 选择私有化但尚无平台时，在当前 Linux、当前 macOS、当前 Windows（预览）或远程 Linux 服务器部署 Rainbond 单机版

## 安装方式

### 0. 前置条件

- 已安装 `Codex`、`Claude Code` 或 `Pi`
- Skill 市场的 `npx skills add` 当前要求 Node.js 22.20.0 或更高版本
- 直接运行 `npx rainskills` 推荐 Node.js 22 或 24，最低支持 Node.js 18
- Node.js 18/20 已结束维护，安装器会警告但仍继续；Node.js 低于 18 请使用 CDN 安装方式
- macOS/Linux 本机可执行 `bash`、`curl`、`python3`；CDN 入口还需要 `tar`。远程 Linux 安装还需要系统 `ssh` 和 `scp`
- 使用 Rainbond Cloud 时需要可登录账号；私有化新安装会先创建平台，再在浏览器完成初始化和授权

### 1. 一行命令安装（推荐）

支持 macOS、Linux 和 Windows。Windows 本地安装目前是 preview，也可以改选 Linux 服务器：

```bash
npx --yes rainskills
```

npm 包已经携带完整安装器和所有 skill，不会再次下载仓库 tarball。`npx` 保留终端交互，因此选择客户端、填写私有化地址和浏览器授权流程与原安装脚本完全一致。

Windows 本地预览要求 Windows 10 build 19041+ 或 Windows 11 x64、已开启 CPU 虚拟化，并使用 Administrators 用户和 UAC。推荐 4 核 CPU、8 GB 内存、50 GB 可用磁盘；2 核、4 GB 内存、30 GB 可用磁盘是预检最低门槛，低于推荐配置时安装器会提示风险但继续尝试。安装器会创建独立的 Rainbond WSL2 环境，首次下载可能较久且可能重启一次；下载会显示进度，重启后从已保存断点继续。Windows 登录后通过 `http://127.0.0.1:7070` 访问 Console。Windows 10/11 真机验收完成前不视为正式支持。

常用参数可以直接追加：

```bash
npx --yes rainskills codex --saas
npx --yes rainskills claude --self-hosted --rainbond-url <url>
npx --yes rainskills pi --self-hosted --rainbond-url <url>
npx --yes rainskills all --force
```

### 2. CDN 安装（保留的兜底方式）

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

### 3. 已有本地仓库

如果你已经 `git clone` 了 rainbond-skills 仓库，直接进入仓库根目录执行：

```bash
./install.sh
```

如果只是让 Codex 或 CI 在非交互模式下覆盖本地 skill，直接执行 `./install.sh --force` 即可；未提供 Rainbond 参数时，脚本会自动跳过 CLI 授权。

### 安装脚本会做的事

不论使用 npx、CDN 还是本地仓库，安装器都会引导你完成这些动作：

- AI 安装时自动识别当前客户端；直接运行命令时可选择 `Codex`、`Claude Code`、`Pi` 或 Codex/Claude Code
- Skill 文件安装完成后，选择要连接的 Rainbond：
  - **Rainbond Cloud（SaaS）**：无需自行安装 Rainbond，地址固定为 `https://run.rainbond.com`
  - **私有化部署**：已有平台时填写 Console 地址；尚无平台时进入内置单机安装向导
- 浏览器中完成登录并授权（无需在终端输入用户名/密码）
- 自动接收 RainSkills CLI 使用的 JWT，并以 `0600` 权限写入 `~/.rainbond/credentials.env`
- 安装固定位置的本机 CLI：`~/.rainbond/bin/rainskills-tools.js`
- 自动验证固定的 Console 入口：`/console/mcp/rainskills/api/query`
- 不修改客户端既有配置，也不为 Pi 安装 Extension

#### AI 代为安装时的用户选择

如果用户尚未明确要连接的 Rainbond 环境，AI 不得在安装命令中自行添加 `--saas`、`--self-hosted` 或 `--rainbond-url`，也不得根据已有缓存替用户做决定。安装器会在 Skill 文件安装完成后进入用户选择阶段并输出：

```text
[RAINSKILLS_USER_INPUT_REQUIRED:rainbond_connection]
```

AI 看到该标记后必须暂停安装，把 Rainbond Cloud / 私有化部署的选择交给最终用户，不得代替用户选择，也不得通过空回车采用默认项。用户回答后，AI 应把选择写回仍在等待的安装进程。如果用户在发起安装时已经明确指定 Rainbond Cloud 或给出了私有化地址，AI 可以直接采用该选择，不必重复询问。

用户选择私有化部署后，还需要明确选择“已经有平台”或“还没有，帮我安装”。已有平台时，安装器输出：

```text
[RAINSKILLS_USER_INPUT_REQUIRED:rainbond_console_url]
```

AI 看到该标记后，让用户发送浏览器中访问 Rainbond Console 的完整地址，然后把地址写回仍在等待的安装进程。

选择“还没有，帮我安装”时，当前阶段会保存 `0600` 权限的非敏感断点并输出一行固定 JSON：

```json
{"schema":"rainskills.next-action.v1","action":"install-platform","onboarding_id":"<id>","argv":["platform","install","--onboarding-id","<id>"]}
```

AI 必须把 `argv` 数组作为参数传回同一个 `rainskills` 命令，不得把输出拼成任意 shell 字符串。平台安装器会：

- 检查系统、架构、推荐资源（4 核 CPU、8 GB 内存、50 GB 磁盘）、最低资源门槛（2 核 CPU、4 GB 内存、30 GB 磁盘）、权限和端口；低于推荐配置时只提示风险
- 展示官方脚本实际可能修改的主机项目，并等待用户一次明确确认
- 从固定 HTTPS 官方来源下载脚本，限制同源跳转和文件大小，检查 Bash 结构与语法，并用本次 SHA-256 保证远程/WSL 执行内容一致
- 展示下载和启动阶段，保留受保护的本地日志
- 独立验证 Rainbond 容器、K3s、`rbd-system` 组件和 Console
- 自动执行 `npx rainskills resume --onboarding-id <id>`，继续浏览器授权

平台安装器会先识别当前设备，并统一提供“安装到本地”和“安装到 Linux 服务器”。回车默认安装到本地；Windows 本地路径由固定安装器自动准备 WSL2，用户不需要输入 WSL 命令。远程连接优先使用已有的 SSH Key；需要密码时由系统 SSH 在终端读取，Linux/macOS 会复用临时连接，Windows 自带 OpenSSH 可能在后续步骤再次请求密码，Rainskills 不会保存密码或私钥。

当前支持单机版，包括本机和远程 Linux 安装，以及 Windows 本地预览；不支持多节点、高可用、离线安装或自动清理已有容器和端口冲突。

当前版本默认从 `https://get.rainbond.com/` 下载并校验 Rainbond 官方安装脚本；Linux、macOS 和 Windows 的安装流程保持一致，不需要额外设置环境变量。

验证自定义 Rainbond 整体镜像时，可以在 `platform install` 命令后追加完整镜像名。安装器会在校验安装脚本后，仅替换 Rainbond 主镜像并继续执行原有安装、就绪检查和授权流程：

```bash
npx --yes rainskills platform install --onboarding-id <id> \\
  --rainbond-image registry.cn-hangzhou.aliyuncs.com/goodrain/rainbond:v6.9.7-devs
```

镜像覆盖会记录在 onboarding 状态中，后续继续或恢复时无需重复填写；默认不指定时使用官方安装脚本当前配置的镜像。

如需使用包内固定的 `rainbond-console/script/install-rainbond.sh` 做本地回归测试，可显式设置 `RAINSKILLS_USE_BUNDLED_RAINBOND_INSTALLER=1`；正常安装不需要设置它。

远程部署完成后，Rainskills 会从当前设备验证 SSH 地址、Rainbond 上报地址和远端主网卡地址，自动选择实际可访问的 Console。云服务器的内网地址不可达时会优先使用 SSH 公网地址；只有全部候选都失败时才询问公网 IP 或域名。

如果 AI 使用的执行工具不能保持交互终端，平台预检后会输出：

```text
[RAINSKILLS_USER_INPUT_REQUIRED:platform_install_confirmation]
```

AI 应先把检测结果和系统变更展示给用户；用户明确同意后，再用相同参数追加 `--yes`，不得自行确认。

`Ctrl+C` 会停止当前下载或安装子进程并保留断点。重新执行安装器输出的固定 `platform install` 命令即可从真实机器状态继续；Rainbond 已部署但授权未完成时，执行固定 `resume` 命令即可，不需要重新部署平台。

#### 安装效果统计

安装脚本会把安装流程状态异步上报到固定地址 `https://log.rainbond.com/api/rainskills/installations`，用于统计脚本执行、授权和配置成功率。每次执行使用一个随机的 `install_attempt_id` 串联以下阶段：

- `started`：脚本开始执行
- `authorized`：完成 Rainbond 授权，并取得当前企业的 `eid`
- `configured`：RainSkills CLI 授权与验证完成
- `failed`：流程失败，仅记录固定的失败阶段和分类

上报字段只包含安装尝试 ID、`eid`、客户端类型、安装或刷新动作、阶段和状态。不会上报 JWT、账号、密码、用户名、邮箱、Rainbond 地址、原始错误信息或本地代码。统计请求在后台执行；统计服务不可用、超时或企业信息读取失败都不会改变原安装结果。

#### 浏览器登录是怎么发生的

安装器默认使用设备授权流程。终端显示八位授权码和 Rainbond 授权地址，并在
后台等待结果：

- **本地 macOS / Linux 桌面**：自动打开当前 Rainbond 的 `/device` 页面。登录
  后核对终端中的授权码，点击允许，终端自动继续。
- **Windows / WSL**：使用固定 PowerShell 浏览器桥接打开 Windows 浏览器；授权
  结果仍由原安装进程接收，不需要复制 Token。
- **SSH、容器或无桌面 Linux**：不会尝试打开远程浏览器。使用任意能够访问该
  Rainbond 平台的电脑或手机打开终端中的地址，登录并允许访问；远程终端会自动
  检测结果，不需要复制回调 URL、JWT 或在终端按回车。

设备码有效期为 10 分钟，只能成功交换一次。最终签发的 JWT 默认有效期为一年，
并带有 `token_use=mcp`、`scope=mcp` 和 `aud=rainbond-mcp` 限制，不能用于普通
Console API。安装器仅在确认旧版 Console 没有 Device Flow 路由时，才回退到
原来的本机回调/复制回调兼容流程。

`--no-browser` 只禁止自动打开浏览器，设备授权地址仍会输出：

```bash
npx --yes rainskills all --no-browser

# AI 包装器或脚本也可以使用环境变量
RAINSKILLS_NO_BROWSER=1 npx --yes rainskills all
```

Device Flow 默认要求 HTTPS。Windows 本地安装使用的 loopback 或受管私网 Console
地址会自动允许 HTTP，不再要求额外参数；其他私有环境只有显式使用
`--allow-insecure-http` 才能继续，终端和浏览器授权页都会提示长期凭证可能被截获。
CI 或完全非交互环境仍应通过 `--token` / `RAINBOND_JWT` 提供已有凭证。

私有化平台升级时，应先发布包含 `/#/device` 的 Rainbond UI，再执行 Console 数据库
迁移，最后设置 `RAINBOND_MCP_DEVICE_FLOW_ENABLED=true`。平台有固定外部地址时同时
设置 `RAINBOND_MCP_DEVICE_PUBLIC_ORIGIN=https://你的平台地址`，避免代理请求头影响
浏览器授权地址。未开启功能开关时，Rainskills 会自动使用旧版授权兼容流程。

默认技能安装目录：

- `~/.claude/skills`
- `~/.codex/skills`
- `~/.pi/agent/skills`

#### 显式指定部署形态

```bash
# npx 模式
npx --yes rainskills all --saas
npx --yes rainskills all --self-hosted --rainbond-url <url>

# CDN 模式：参数追加在脚本之后
bash <(curl -fsSL https://get.rainbond.com/rainskills/install.sh) all --saas
bash <(curl -fsSL https://get.rainbond.com/rainskills/install.sh) all --self-hosted --rainbond-url <url>

# 本地仓库模式
./install.sh all --saas                                 # Rainbond Cloud
./install.sh all --self-hosted --rainbond-url <url>     # 私有化
```

### 4. 只安装到单个平台

只装并配置 Claude Code：

```bash
npx --yes rainskills claude
```

只装并配置 Codex：

```bash
npx --yes rainskills codex
```

只装并配置 Pi：

```bash
npx --yes rainskills pi
```

同时装并配置全部平台：

```bash
npx --yes rainskills all
```

### 5. SSH、容器与 CI 授权

SSH、容器和有交互终端的无桌面 Linux 会自动进入跨设备授权模式，不需要提前
准备 Token。终端会持续轮询授权状态，在另一台电脑完成浏览器授权后自动
继续。仅连接旧版 Console 时才会显示粘贴提示；此时把浏览器地址栏中的完整回调
URL 粘贴进去即可。

CI 等没有可交互 TTY 的环境不能粘贴回调地址，可以使用下面两条兼容路径：

1. **预先在浏览器拿到 JWT 再传进来**（推荐）：

   ```bash
   ./install.sh all --non-interactive \
     --self-hosted --rainbond-url https://your-rainbond.example.com \
     --token "$RAINBOND_JWT"
   ```

   建议通过 CI Secret 注入 `RAINBOND_JWT`，不要把 JWT 写入仓库或命令日志。

2. **私有化兼容用户名/密码（已不推荐，未来移除）**：

   ```bash
   ./install.sh all --non-interactive \
     --self-hosted --rainbond-url http://your-rainbond.example.com:7070 \
     --username admin \
     --allow-insecure-http
   ```

   仅当部署没有开 `USE_SAAS`、确实是用户名/密码模式时可用；SaaS 模式下没有这个登录入口。

如果你的 Rainbond 还是 `http://`，安装脚本会明确提示风险，并要求你确认（交互模式）或要求显式 `--allow-insecure-http`（非交互模式）。

### 6. 当前终端的环境变量说明

脚本会把 JWT 保存到：

```bash
~/.rainbond/credentials.env
```

注意：

- 凭据文件权限为 `0600`，目录权限为 `0700`
- CLI 读取该文件；安装器不会把 JWT 写入 shell rc 或命令行
- HTTP 地址默认拒绝；仅在明确传入 `--allow-insecure-http` 后才允许可信内网明文连接

### 7. 覆盖已安装版本

如果目标目录里已经存在同名 skill，默认会跳过，避免覆盖本地修改。

需要强制覆盖时：

```bash
npx --yes rainskills --force
npx --yes rainskills codex --force
```

### 8. 安装到自定义目录

```bash
npx --yes rainskills --dest ~/.claude/skills
npx --yes rainskills --dest ~/.codex/skills --force
```

`--dest` 适合：

- 调试安装过程
- 安装到非标准目录
- 在 CI 或临时目录中做验证

注意：`--dest` 复制 Skill 和 CLI 文件，但不会自动完成 Rainbond 授权。

## 更新方式

从市场安装时，只更新一个 Rainskills 入口；更新后的入口会运行对应版本的安装器，再同步完整的内部 Skill：

```bash
# 通用 Skill 市场
npx skills update rainskills

# Codex Plugin 市场
codex plugin marketplace upgrade goodrain
```

Claude Code 在会话中执行：

```text
/plugin marketplace update goodrain
/plugin update rainskills@goodrain
/reload-plugins
```

npx 模式：显式使用 `latest` 并覆盖已有 skill：

```bash
npx --yes rainskills@latest --force
```

CDN 模式：再跑一次同一行命令即可。脚本会重新下载最新 tarball 解压到 `~/.rainbond/skills`，然后继续安装流程：

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
  package.json
  bin/rainskills.js
  .gitignore
  rainbond-app-assistant/
    SKILL.md
  rainbond-delivery-verifier/
    SKILL.md
  ...
```

## 产品对象模型

`rainbond-app-assistant/references/product-object-model.md` 是可安装的 canonical 文档，描述 skills 之间共享的产品对象（project、app、component、environment、delivery 等）和跨-skill 边界；`docs/product-object-model.md` 只保留仓库索引。如果你要扩展某个 skill 的输入/输出，或新增一个 skill，先看 canonical reference。

## 仓库维护约定

- 每个 skill 使用单独目录，目录名和 skill 名保持一致
- 每个 skill 至少包含一个 `SKILL.md`
- 如果后续需要补充 `scripts/`、`references/`、`assets/`，请放在对应 skill 目录下
- 安装脚本默认复制所有 `rainbond-*` 目录

## 常见问题

### 1. 安装后没有生效

Codex / Claude Code 请按安装器提示重启。

### 2. 为什么安装后不需要额外客户端配置

这是预期行为。已安装的 Skill 通过 `~/.rainbond/bin/rainskills-tools.js` 调用受控 Console API，无需注册客户端工具或安装 Pi Extension。

### 3. 为什么默认不覆盖已有 skill

因为有些使用者会在本地做二次调整。默认跳过更安全，`--force` 才会覆盖。

### 4. JWT 会保存在哪里

保存在：

```bash
~/.rainbond/credentials.env
```

脚本不会保存你的 Rainbond 用户名和密码。

### 5. CLI 返回 401 / 403 怎么办

通常是 `~/.rainbond/credentials.env` 里的 JWT 到期了。无需重装 skills，也不要手工改文件，直接用下面任一命令刷新：

```bash
npx --yes rainskills refresh
# 或：bash <(curl -fsSL https://get.rainbond.com/rainskills/install.sh) refresh
# 或：bash ~/.rainbond/skills/install.sh refresh
```

`refresh` 不会改动 skill 文件。它会刷新 `~/.rainbond/credentials.env` 并验证固定的 CLI API 入口；不会修改任何客户端配置。

### 客户端适配范围

不需要额外适配。只要客户端能发现 Skill、执行本机命令、且本机有 Node.js 18+，它就会使用同一 RainSkills CLI。`--api-only` 和 `--skip-mcp` 仅为兼容旧脚本保留，已不再改变安装行为。

### 6. 如何确认安装到了哪里

脚本会输出每个目标目录和每个 skill 的安装结果。

## 开发者说明

如果你要新增或修改 skill，建议流程如下：

1. 在仓库里直接修改对应 skill 目录
2. 先查看 `rainbond-app-assistant/references/product-object-model.md`，它是安装包内的产品对象模型和跨-skill 边界主文档
3. 在虚拟环境中执行 `python3 -m pip install -r requirements-test.txt`，再执行 `npm test` 跑 helper、评测、安装器、包内容和 PTY 信号测试；测试在隔离临时目录中运行，无需输入，也不应打开真实浏览器
4. 执行 `./install.sh --dest /tmp/rainbond-skills-test --force` 做一次本地验证
5. 确认无误后再提交到 Git 仓库
