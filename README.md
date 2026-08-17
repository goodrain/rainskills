# Rainskills

Rainskills 是一组面向应用识别、部署、排障和交付的 AI Skills，支持 Codex 和 Claude Code。用户在市场中只会看到一个 `Rainskills` 产品，安装后 9 个 `rainbond-*` Skill 仍会独立触发。

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

安装流程支持 Codex 和 Claude Code；macOS、Linux 和 WSL 不支持 OpenClaw 或 Pi Agent 安装。不要手工复制 Skill、拼接凭据或修改 MCP 配置。

## 安装完成时用户会看到什么

安装完成后只完成 Skills 安装并展示能力列表，不选择运行环境、不登录 Rainbond，也不配置业务 MCP：

```text
Rainskills 安装完成，下一条消息即可直接使用。

现在可以帮你：

- 分析项目的技术栈和部署结构
- 将当前项目或 Git 仓库部署上线
- 通过源码、镜像或安装包部署应用
- 分析项目结构
- 识别技术栈
- 从应用模板安装应用
- 给出部署结构建议

直接告诉我你想做什么即可。
```

用户第一次提出部署、查询、排障、验证、快照或模板安装等需要运行环境的动作时，Rainskills 才检查和连接运行环境。

## 按需连接应用运行环境

每个业务 Skill 都必须先通过相同门禁：

0. 第一步检查 Node.js 是否存在且主版本不低于 18。缺失或低于 18 时，只说明 Rainskills 执行组件需要 Node.js 18 或更高版本并停止；不选择运行环境、不调用 MCP、不猜测替代命令。只有用户或 agent 明确同意后才安装或升级 Node.js，再从同一原始 intent 继续。

固定 launcher 来自当前 `package.json` 版本：

```json
["npx", "--yes", "rainskills@0.1.0-rc.64"]
```

所有调用都把 launcher 与参数合并成 argv 数组后直接执行；不得使用 `rainskills@latest`，不得把参数拼成 shell 字符串。

1. 执行 launcher + `["environment", "list", "--json"]`，先于项目扫描和任何业务 MCP。未指定环境时只使用全局默认环境，默认不可用时停止，不自动回退。
2. 每个请求生成独立 operation UUID，并执行 `operation begin`；显式环境只写入这次 operation。每个 Rainbond MCP 调用都携带返回的 `rainskills_operation_id`。项目不保存环境、团队或应用绑定，同一项目可以部署到多个目标。
3. 将动作转换为 `runtime-intents.js` 中对应的受限 intent 并完成字段校验。target 只允许 `codex`、`claude`、`all`；按用户选择构造 launcher + `["runtime", "connect", "<target>", ...环境参数, "--intent-json", "<JSON.stringify(已校验 intent)>"]`。
4. 环境参数必须恰好选择一组且互斥：Cloud 用 `["--saas"]`，已有私有环境用 `["--rainbond-url", "<已验证 Console origin>"]`，新建私有环境用 `["--install-private", "--location", "local"]` 或 `["--install-private", "--location", "server"]`。
5. 安装私有环境时，只消费完成 schema、action、onboarding id 和参数边界校验的 `rainskills.next-action.v1.argv`；拒绝字符串命令和其他输出字段。
6. 探针失败进入 reconnect。连接或安装完成后执行 launcher + `["intent", "resume", "--onboarding-id", "<同一 onboarding-id>"]`，恢复受保护的原始 intent 和 `resume_step`，不重新猜测用户动作。

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
2) 私有环境（去对接）

选择私有环境后，直接显示：

请选择部署位置：

1、对接到本地
2、对接到独立服务器
3、对接已有私有环境

选择 1 时执行 `install-private` route 并传入 `--location local`；选择 2 时执行 `install-private` route 并传入 `--location server`；选择 3 时询问已有私有环境地址并执行 `private-existing` route。不会再显示额外的接入方式中间步骤。不得在进入平台安装器后重复询问部署位置，也不得在环境准备完成前询问应用来源。

## 多运行环境

- 第一个连接成功的环境自动成为全局默认环境；以后新增环境不修改默认值。
- 用户未指定环境时使用默认环境；用户明确指定时只覆盖本次 operation。
- 环境名称自动生成，可重命名；内部不可变 ID 不随重命名改变。
- 添加、重命名、重新授权或删除环境不改项目配置，也不需要为每个环境重新配置 Agent MCP。
- Agent 始终连接一个本地 Rainskills MCP。Rainskills 按 `operation_id` 从隔离凭据存储中选择目标 Rainbond。
- 明确说“团队”表示默认或指定运行环境中的 Rainbond 团队；明确说“运行环境/平台”表示环境。裸名称同时匹配两者时必须询问。

常用管理命令：

```bash
npx --yes rainskills@0.1.0-rc.64 environment list --json
npx --yes rainskills@0.1.0-rc.64 environment rename --environment-id <uuid> --name <name>
npx --yes rainskills@0.1.0-rc.64 environment set-default --environment-id <uuid>
npx --yes rainskills@0.1.0-rc.64 environment remove --environment-id <uuid>
```

### 已有应用环境选择

查询、排障、修改、交付验证、快照、发布和回滚属于已有应用操作，只让用户选择 Rainbond Cloud 或承载目标应用的已有私有 Rainbond，绝不执行 `install-private`，也不安装一个空的新平台代替目标应用。每个 Skill 的第一句话应匹配当前动作，例如“验证应用交付状态和访问地址”，不要全部写成“部署当前项目”。

### 认证与权限恢复

业务 MCP 返回 401 时，依次执行以下 argv 参数：

```json
["runtime", "record-failure", "--onboarding-id", "<同一 onboarding-id>", "--step", "<当前固定步骤>", "--reason", "credential-expired"]
["runtime", "reconnect", "--onboarding-id", "<同一 onboarding-id>"]
["intent", "resume", "--onboarding-id", "<同一 onboarding-id>"]
```

只允许重新授权一次，并只重试记录的步骤；第二次 401 停止。403 时执行 `["runtime", "record-failure", "--onboarding-id", "<同一 onboarding-id>", "--step", "<当前固定步骤>", "--reason", "permission-denied"]`，随后立即停止，不 reconnect、不重新授权、不自动重试。

凭据只由受保护的本地状态和客户端配置处理。不要在聊天、intent、日志或命令行参数中发送密码、JWT、Token 或私钥。

## 私有 Rainbond 安装

环境选择按渐进流程展示：

1. 用户选择“私有环境”后，直接选择对接到本地、独立服务器或已有私有环境。
2. 对接已有私有环境只询问环境地址，不执行平台安装。
3. 对接到本地直接进入单机版，不展示 ROI 或 Kubernetes；只有选择独立服务器后，再选单机版、主机集群或已有 Kubernetes。

主机集群支持 1、2 或 N 台 Linux 服务器，不要求固定三台；etcd 节点数必须是正奇数。已有 Kubernetes 分支使用指定 kubeconfig 和 context 安装，要求 Kubernetes 1.24 或更高版本。

Windows 本地安装是预览能力，也可以改选 Linux 服务器。它要求 Windows 10 build 19041+ 或 Windows 11 x64、已开启虚拟化并允许 UAC；安装器使用受管 WSL2 环境。macOS 本地路径使用 OrbStack。用户不需要理解这些底层实现。

常用固定参数：

```bash
# 本地单机
npx --yes rainskills@0.1.0-rc.64 platform install --onboarding-id <id> \
  --location local --mode single-node

# Linux 服务器单机
npx --yes rainskills@0.1.0-rc.64 platform install --onboarding-id <id> \
  --location server --mode single-node --ssh <user@host>

# 服务器主机集群（交互生成配置，或导入已有 ROI cluster.yaml）
npx --yes rainskills@0.1.0-rc.64 platform install --onboarding-id <id> \
  --location server --mode host-cluster --cluster-config <path>

# 已有 Kubernetes
npx --yes rainskills@0.1.0-rc.64 platform install --onboarding-id <id> \
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

Rainskills 会在用户下一次发起业务动作时静默检查更新，且只跟随 npm `latest` 指向的正式版。当前版本是 RC 或其他预发布版本时不会查询、不会自动升级；npm 上的新 RC 版本也不参与正式版自动升级。

发现更高的正式版后，当前 launcher 只委托到经过校验的精确版本，例如 `rainskills@1.2.3`，不会执行浮动的 `@latest` 业务代码。新版本先原子刷新已经安装的 Rainskills Skills，再继续原业务操作。版本检查失败、安装位置不安全或文件迁移失败时会保留旧版本继续，不要求用户处理。

升级只更新 Rainskills 自身，不触发 Rainbond 安装、运行环境选择、登录授权、MCP 配置或重新对接。原始业务操作会继续执行；只有该业务操作本身需要运行环境时，才按既有门禁检查当前连接。可用连接直接复用，401 只重新授权一次，403 立即停止，从未连接过运行环境时才进入环境选择。

正在执行或等待恢复的部署、私有平台安装和授权流程继续使用启动时锁定的旧版本，自动升级不会插入这些流程。操作结束后的下一次普通业务请求才会再次检查正式版。

如需手工恢复安装，可执行 `npx --yes rainskills@latest --force`；正常使用不需要主动运行更新命令。

## 包含的 Skill

- `rainbond-app-assistant`
- `rainbond-app-version-assistant`
- `rainbond-delivery-verifier`
- `rainbond-env-sync`
- `rainbond-fullstack-bootstrap`
- `rainbond-fullstack-troubleshooter`
- `rainbond-platform-installer`
- `rainbond-project-init`
- `rainbond-template-installer`

## License

Apache-2.0
