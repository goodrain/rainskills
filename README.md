# Rainskills

Rainskills 是一组面向应用识别、部署、排障和交付的 AI Skills，支持 Codex、Claude Code、Pi Agent、DeepSeek Harness、WorkBuddy 和 Hermes Agent。用户在市场中只会看到一个 `Rainskills` 产品，安装后 11 个 `rainbond-*` Skill 仍会独立触发。

## 安装

从 Skill 市场安装：

```bash
npx skills add goodrain/rainskills
```

Skill 市场当前要求 Node.js 22.20.0 或更高版本。直接运行 npx 安装器最低支持 Node.js 18：

```bash
npx --yes rainskills
```

没有合适的 Node.js 时可使用 CDN 入口：

```bash
bash <(curl -fsSL https://get.rainbond.com/rainskills/install.sh)
```

仅安装 Skills 文件不需要 Node.js，CDN 入口在无 Node.js 时仍可完成这部分安装；这不代表应用部署、运行环境连接或私有平台安装已经可执行。用户首次提出需要运行环境的动作时，Rainskills 执行组件才要求 Node.js 18 或更高版本。

也可以使用客户端 Plugin 市场。

Codex：

```bash
codex plugin marketplace add goodrain/rainskills
codex plugin add rainskills@goodrain
```

Claude Code：

```text
/plugin marketplace add goodrain/rainskills
/plugin install rainskills@goodrain
/reload-plugins
```

DeepSeek Harness：

```bash
npx --yes rainskills dsh
```

默认安装到 `${DSH_HOME:-~/.dsh}/skills`。DeepSeek Harness 使用原生 Skill catalog 和 `skill` loader 加载，不配置客户端 MCP。

WorkBuddy：

```bash
npx --yes rainskills workbuddy
```

默认安装到 `${WORKBUDDY_CONFIG_DIR:-~/.workbuddy-ai}/skills`。如果安装发生在一个已经打开的 WorkBuddy 任务中，先刷新 Skill 列表或新建任务；部署时明确指定 Rainbond/Rainskills，或让项目保留 `rainbond.app.json`、`.rainbond/local.json` 标记，以避免被内置 Sites 路由抢占。

Hermes Agent：

```bash
npx --yes rainskills hermes
```

默认安装到 `${HERMES_HOME:-~/.hermes}/skills`，与其他宿主共用同一 CLI profile 和本地 Rainskills CLI，不配置客户端 MCP。如果安装发生在一个已经打开的 Hermes 会话中，执行 `/reset` 或新建会话后再使用新安装的 Skills。

安装流程支持 Codex、Claude Code、Pi Agent、DeepSeek Harness、WorkBuddy 和 Hermes Agent；所有 Agent 共用同一组 Skills、CLI profile 和本地 Rainskills CLI，不提供单独的客户端 MCP adapter。macOS、Linux 和 WSL 不支持 OpenClaw 安装。不要手工复制 Skill、拼接凭据或修改 Agent 配置。

## 安装完成时用户会看到什么

安装完成后只完成 Skills 和受保护本地 CLI 的安装并展示能力列表，不选择运行环境、不登录 Rainbond，也不配置 Agent MCP：

```text
Rainskills 安装完成，下一条消息即可直接使用。

下一步可以直接说：

- 帮我部署当前项目
- 帮我部署一个 Git 仓库
- 帮我通过镜像或安装包部署应用
- 帮我安装一个应用模板
- 帮我分析当前项目应该如何部署

也可以直接告诉我你想部署什么应用。
```

用户第一次提出部署、查询、排障、验证、快照或模板安装等需要运行环境的动作时，Rainskills 才检查和连接运行环境。

## 按需连接应用运行环境

每个业务 Skill 都必须先通过相同门禁：

0. 第一步检查 Node.js 是否存在且主版本不低于 18。缺失或低于 18 时，只说明 Rainskills 执行组件需要 Node.js 18 或更高版本并停止；不连接运行环境、不调用 CLI、不猜测替代命令。

固定 launcher 来自当前 `package.json` 版本：

```json
["node", "<home>/.rainbond/lib/rainskills/bin/rainskills.js"]
```

所有调用都把 launcher 与参数合并成 argv 数组后直接执行；不得使用 `rainskills@latest`，不得把参数拼成 shell 字符串。

1. 本会话首次使用时执行 launcher + `["runtime", "status", "--json"]`。只有返回 `connected` 且 `usable=true` 才进入业务流程。
2. 本机只保存一个 Rainbond 运行环境。没有环境时使用 `runtime connect` 连接 Cloud、已有私有 Rainbond，或安装一个私有 Rainbond；重新授权使用 `runtime reconnect <target>`。
3. 所有 Rainbond 查询和变更都直接通过 `~/.rainbond/bin/rainskills-tools.js`。不配置客户端 MCP，不创建业务 runtime operation，不传环境 ID、operation ID 或 intent JSON。
4. 写操作仍由 CLI 生成 confirmation ID；只有完全相同的输入追加 `--confirm` 后才执行一次。
5. 安装私有环境时，只消费完成 schema、action、onboarding id 和参数边界校验的 `rainskills.next-action.v1.argv`；onboarding id 只属于平台安装断点。

`deploy`/`create` 允许先只保存动作类型。选择私有环境后，先完整完成本地单机、服务器单机、主机集群或已有 Kubernetes 的平台安装和验收；此阶段不得询问本地项目路径、Git 仓库 URL、镜像地址或安装包路径。恢复到 `project-analysis` 后才识别当前项目或询问缺失的应用来源。

### 新应用环境选择

新应用场景使用以下说明：

> 可以，我会帮你完成应用识别、构建、部署和访问验证。
>
> 不过目前还没有可用的应用运行环境。
>
> 你刚安装的 Rainskills 是负责“部署”的 AI 助手，它会分析项目并执行部署流程；Rainbond 负责为应用提供稳定运行环境。
>
#### 选择运行环境

提示“请选择应用要运行的环境：”，并只显示：

1) 云端环境（免费体验）
2) 本机环境
3) 独立服务器
4) 已有 Rainbond

选择 1 时执行 `saas` route；选择 2 时执行 `install-private` route 并传入 `--location local`；选择 3 时执行 `install-private` route 并传入 `--location server`；选择 4 时询问已有 Rainbond 地址并执行 `private-existing` route。不得显示“私有环境”中间层，不得在进入平台安装器后重复询问部署位置，也不得在环境准备完成前询问应用来源。

选择“部署到独立服务器”后，只显示：

请选择服务器类型：

1、单台服务器（Linux）
2、三台及以上服务器（Linux）
3、已有 Kubernetes 集群

### 服务器 SSH 固定流程

部署到独立服务器或主机集群时，流程不再根据 Agent 是否提供可见终端而变化：

1. Rainskills 先使用 `BatchMode=yes` 检查 SSH 免密连接。
2. 已可连接时直接继续安装流程；不可连接时固定停止，不在 Agent 任务终端里等待密码。
3. 单台服务器时，用户在系统终端执行一条版本锁定的 `ssh prepare --ssh <user@host> --ssh-port <port>` 命令。
4. 主机集群时，Rainskills 先检查全部节点，一次列出所有待处理节点的名称、IP 和端口，再只给出一条版本锁定的 `ssh prepare-cluster --cluster-config <path>` 命令。该命令依次处理全部节点，已可免密连接的节点自动跳过；不得逐台显示命令或逐台等待用户回复。
5. 指纹和一次服务器密码均由系统 SSH 读取；两种命令都只准备公钥连接，不安装 Rainbond。全部节点处理完后，用户统一回复一次“已完成”。
6. Agent 使用同一版本、同一 `onboarding-id` 和原安装参数继续。不得重新询问环境、安装模式、节点或应用来源。
7. 后续传输、安装和验收全部使用免密 SSH；系统终端不会继续安装或授权。
8. Rainbond 验收通过后只进行一次浏览器授权；授权成功后由当前 Agent 会话继续应用任务。

主机密钥发生变化时直接阻断并要求人工核对，不自动替换 `known_hosts`。聊天中永远不接收密码、私钥或 Token。

## 单运行环境

- 本机只保存一个 Rainbond Console origin 和对应凭据。
- 更换环境时，新凭据通过 live probe 后才覆盖当前运行环境。
- 连接和重新授权始终进入浏览器 Device Flow，不复用 Shell 中缓存的 JWT。
- Agent 始终执行受保护的本地 Rainskills CLI，不配置或直接调用客户端 MCP。
- 项目的 preview/production 配置仍属于应用配置投影，与本机连接的 Rainbond 运行环境不是同一概念。

业务 CLI 默认忽略 Shell 中遗留的 `RAINBOND_URL` / `RAINBOND_JWT`。CI 需要使用环境变量凭据时，显式设置：

```bash
RAINSKILLS_CREDENTIAL_SOURCE=environment \
RAINBOND_URL=https://rainbond.example.com \
RAINBOND_JWT="$RAINBOND_JWT" \
node ~/.rainbond/bin/rainskills-tools.js status --skill-id rainbond-platform-query
```

常用命令：

```bash
node ~/.rainbond/lib/rainskills/bin/rainskills.js runtime status --json
node ~/.rainbond/lib/rainskills/bin/rainskills.js runtime reconnect codex
```

`runtime status` 会通过当前唯一环境执行 live probe。业务 Tool 继续通过 `~/.rainbond/bin/rainskills-tools.js` 调用。

### 已有应用环境选择

查询、排障、修改、交付验证、快照、发布和回滚属于已有应用操作，只让用户选择 Rainbond Cloud 或承载目标应用的已有私有 Rainbond，绝不执行 `install-private`，也不安装一个空的新平台代替目标应用。每个 Skill 的第一句话应匹配当前动作，例如“验证应用交付状态和访问地址”，不要全部写成“部署当前项目”。

### 认证与权限恢复

Rainbond CLI 返回 401 时执行：

```json
["runtime", "reconnect", "<target>"]
```

只读调用可在重新授权后重试一次。写调用不得自动重放，必须先查询平台真实状态。403 立即停止，不 reconnect。

凭据只由受保护的本地状态和客户端配置处理。不要在聊天、intent、日志或命令行参数中发送密码、JWT、Token 或私钥。

## 私有 Rainbond 安装

环境选择按渐进流程展示：

1. 用户选择“私有环境”后，直接选择部署到本机、独立服务器或已有 Rainbond。
2. 部署到已有 Rainbond 只询问环境地址，不执行平台安装。
3. 部署到本机直接进入单机版，不展示 ROI 或 Kubernetes；只有选择独立服务器后，再选择单台 Linux、三台及以上 Linux 或已有 Kubernetes。

主机集群支持 1、2 或 N 台 Linux 服务器，不要求固定三台；etcd 节点数必须是正奇数。首次进入该分支时，Rainskills 会生成一份受保护的 `cluster.yaml` 示例文件。用户一次性修改服务器地址、SSH 端口和节点角色后回复“已完成”，Rainskills 会一次列出全部可确定的配置问题；校验通过后只准备全部节点的 SSH 免密连接，再展示拓扑和安装变更供用户确认，不再执行额外的 CPU、内存、磁盘、端口、网络或已有安装检查。生成的文件中不得填写密码、私钥或 Token，SSH 密码仍只由系统 `ssh` 在终端中读取。确认后仅查询 bootstrap 节点架构以选择对应的 ROI 文件，实际安装条件由 ROI 判断。已有 Kubernetes 分支使用指定 kubeconfig 和 context 安装，要求 Kubernetes 1.24 或更高版本。

Windows 本地安装是预览能力，也可以改选 Linux 服务器。它要求 Windows 10 build 19041+ 或 Windows 11 x64、已开启虚拟化并允许 UAC；安装器使用受管 WSL2 环境。macOS 本地路径使用 OrbStack。用户不需要理解这些底层实现。

常用固定参数：

```bash
# 本地单机
node ~/.rainbond/lib/rainskills/bin/rainskills.js platform install --onboarding-id <id> \
  --location local --mode single-node

# Linux 服务器单机
node ~/.rainbond/lib/rainskills/bin/rainskills.js platform install --onboarding-id <id> \
  --location server --mode single-node --ssh <user@host>

# 服务器主机集群（自动生成受保护示例文件）
node ~/.rainbond/lib/rainskills/bin/rainskills.js platform install --onboarding-id <id> \
  --location server --mode host-cluster

# 已有高级 ROI cluster.yaml 才追加：--cluster-config <path>

# 已有 Kubernetes
node ~/.rainbond/lib/rainskills/bin/rainskills.js platform install --onboarding-id <id> \
  --location server --mode existing-kubernetes \
  --kubeconfig <path> --kube-context <name> --chart-version <version>
```

可以为已有 Kubernetes 追加 `--values <path>`。非交互流程只有在展示预检和系统变更、用户明确同意后才追加 `--yes`。

### 安全与恢复边界

- Console origin 会先规范化、探测并锁定。HTTPS 跨 origin 跳转必须重新确认；明文 HTTP 只允许用户明确确认的可信内网。
- ROI 和 Helm 制品只从固定官方 HTTPS 来源获取，限制跳转和大小，并锁定版本与摘要；恢复时复用已验证字节。
- kubeconfig、values、ROI 配置和断点使用受保护文件；所有 kubectl/Helm 调用都绑定固定 kubeconfig、context 和集群 identity。
- 执行安装前必须完成只读预检和 dry-run（适用时），并单独确认真实下载/安装效果。
- 取消会停止活动子进程但保留断点。失败或取消后只执行安装器输出的固定重试 argv；不要凭记忆改写命令。
- 检测到目标、配置、集群 identity、版本或摘要漂移时停止，不静默换目标。

平台安装成功必须验证节点/平台组件、`rbd-app-ui` 和 Console 可访问，再恢复原始应用动作。详细规则见 `rainbond-platform-installer/references/installation-policy.md`。

## 更新

Rainskills 会在用户下一次发起业务动作时，由本地运行时立即返回环境查询结果，并另行启动后台任务静默检查更新。更新只跟随 npm `latest` 指向的正式版。当前版本是 RC 或其他预发布版本时不会查询、不会自动升级；npm 上的新 RC 版本也不参与正式版自动升级。

发现更高的正式版后，后台任务只委托到经过校验的精确版本，例如 `rainskills@0.1.36`，不会执行浮动的 `@latest` 业务代码。新版本原子刷新已经安装的 Rainskills Skills；当前业务继续使用启动时已经加载的版本，最迟从下一条新任务开始使用新版。npm 超时、版本检查失败、安装位置不安全或文件迁移失败时会保留旧版本，且不会阻塞或改变当前操作。

升级只更新 Rainskills 自身，不触发 Rainbond 安装、运行环境选择、登录授权或重新对接，也不会新增 Agent MCP 配置。更新内容仅包括 Skills 和本地 CLI。原始业务操作会继续执行；只有该业务操作本身需要运行环境时，才按既有门禁检查当前连接。可用连接直接复用，401 只重新授权一次，403 立即停止，从未连接过运行环境时才进入环境选择。

正在执行的部署、私有平台安装和授权流程继续使用启动时锁定的旧版本，自动升级不会插入这些流程。操作完成后会再次静默调度更新检查；检查进程有固定超时且不向用户输出远程 npx 命令。

如需手工恢复安装，可执行 `npx --yes rainskills@latest --force`；正常使用不需要主动运行更新命令。

## 包含的 Skill

- `rainbond-app-assistant`
- `rainbond-app-version-assistant`
- `rainbond-delivery-verifier`
- `rainbond-env-sync`
- `rainbond-fullstack-bootstrap`
- `rainbond-fullstack-troubleshooter`
- `rainbond-opensource-app-deploy`
- `rainbond-platform-installer`
- `rainbond-platform-query`
- `rainbond-project-init`
- `rainbond-template-installer`

## 部署类 skill 怎么选

- 已确认的 Rainbond 市场模板 → `rainbond-template-installer`（一键安装商店模板）
- 只说“部署 Harbor / Dify / n8n”等第三方开源套件也可以 → `rainbond-opensource-app-deploy` 会自动联网获取官方仓库、文档和 Release 中的部署资料，固定版本并推导组件拓扑；用户已提供 Compose、Helm 或镜像集合时也走这里
- 部署当前项目、普通 Git 仓库或私有镜像项目 → `rainbond-app-assistant`

Open-source Deploy 将 Compose、Helm 和安装器生成结果作为建模证据，默认创建独立 Rainbond 镜像组件，不依赖 Helm 黑盒导入或用户手工上传 Compose。当前/本地项目线索优先于同名软件，避免把用户自己的 Harbor fork 误判为上游套件。

## License

Apache-2.0
