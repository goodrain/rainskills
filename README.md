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
Rainskills 安装完成。

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
["npx", "--yes", "rainskills@0.1.0-rc.60"]
```

所有调用都把 launcher 与参数合并成 argv 数组后直接执行；不得使用 `rainskills@latest`，不得把参数拼成 shell 字符串。

1. 执行 launcher + `["runtime", "status", "--json"]`，先于项目扫描和任何业务 MCP。
2. `not_started` 不能因为历史上调用过 MCP 而跳过；只有 `connected`、`usable = true` 且本次 live probe 成功才能继续。
3. 将动作转换为 `runtime-intents.js` 中对应的受限 intent 并完成字段校验。target 只允许 `codex`、`claude`、`all`；按用户选择构造 launcher + `["runtime", "connect", "<target>", ...环境参数, "--intent-json", "<JSON.stringify(已校验 intent)>"]`。
4. 环境参数必须恰好选择一组且互斥：Cloud 用 `["--saas"]`，已有私有环境用 `["--rainbond-url", "<已验证 Console origin>"]`，新建私有环境用 `["--install-private"]`。
5. 安装私有环境时，只消费完成 schema、action、onboarding id 和参数边界校验的 `rainskills.next-action.v1.argv`；拒绝字符串命令和其他输出字段。
6. 探针失败进入 reconnect。连接或安装完成后执行 launcher + `["intent", "resume", "--onboarding-id", "<同一 onboarding-id>"]`，恢复受保护的原始 intent 和 `resume_step`，不重新猜测用户动作。

### 新应用环境选择

新应用场景使用以下说明：

> 可以，我会帮你完成应用识别、构建、部署和访问验证。
>
> 不过目前还没有可用的应用运行环境。
>
> 你刚安装的 Rainskills 是 AI 部署助手，它负责分析项目并执行部署；应用实际会运行在 Rainbond 上。Rainbond 是一套应用运行和管理平台，负责源码构建、容器运行、域名访问、日志和存储等工作，你不需要了解 Kubernetes。
>
#### 第一次选择

第一问提示“请选择应用要运行的环境：”，并只显示：

1) Rainbond Cloud（在线，无需安装）
2) 私有 Rainbond（自己的环境）

#### 选择私有 Rainbond 后

只有用户选择私有 Rainbond 后，才继续显示：

a) 连接已有私有 Rainbond
b) 帮我安装私有 Rainbond

不得把第二问的两项提前到第一问。选择 a 时执行 `private-existing` route；选择 b 时执行 `install-private` route。内部 runtime contract 仍保留 `saas`、`private-existing`、`install-private` 三条可执行 route。

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

1. 先选`安装到本地`或`安装到 Linux 服务器`。
2. 本地直接进入单机版，不展示 ROI 或 Kubernetes。
3. 只有选择服务器后，再选单机版、主机集群或已有 Kubernetes。

主机集群支持 1、2 或 N 台 Linux 服务器，不要求固定三台；etcd 节点数必须是正奇数。已有 Kubernetes 分支使用指定 kubeconfig 和 context 安装，要求 Kubernetes 1.24 或更高版本。

Windows 本地安装是预览能力，也可以改选 Linux 服务器。它要求 Windows 10 build 19041+ 或 Windows 11 x64、已开启虚拟化并允许 UAC；安装器使用受管 WSL2 环境。macOS 本地路径使用 OrbStack。用户不需要理解这些底层实现。

常用固定参数：

```bash
# 本地单机
npx --yes rainskills@0.1.0-rc.60 platform install --onboarding-id <id> \
  --location local --mode single-node

# Linux 服务器单机
npx --yes rainskills@0.1.0-rc.60 platform install --onboarding-id <id> \
  --location server --mode single-node --ssh <user@host>

# 服务器主机集群（交互生成配置，或导入已有 ROI cluster.yaml）
npx --yes rainskills@0.1.0-rc.60 platform install --onboarding-id <id> \
  --location server --mode host-cluster --cluster-config <path>

# 已有 Kubernetes
npx --yes rainskills@0.1.0-rc.60 platform install --onboarding-id <id> \
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

```bash
npx skills update rainskills
codex plugin marketplace upgrade goodrain
```

Claude Code：

```text
/plugin update rainskills@goodrain
/reload-plugins
```

直接安装方式可执行 `npx --yes rainskills@latest --force`。更新同样只更新 Skills；运行环境在下一次实际业务动作时按需检查。

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
