# source-proxy

6. **传输代理自动决策（Git URL + image 公网拉取统一处理）**：当组件源指向**已知有可工作代理的公网服务**时，**默认自动套用代理**，不打断流程问用户，在最终报告里明确告知"已用 X 代理拉取 Y"，邀请用户覆盖。其它情况按下面分类处理。

   **已知可工作的代理 pair（限定清单 — 这里必须用清单，不能用 principle，因为代理 URL 是事实，不能让模型推断）**：
   - `github.com` Git URL → `https://ghfast.top/<原完整 URL>`（含 `https://github.com/...`、`https://raw.githubusercontent.com/...`）
   - `docker.io` 容器镜像（含裸 `nginx:latest`、`library/...` 这种隐式解析为 `docker.io/library/...` 的引用）→ `docker.1ms.run/<dockerhub-path>`

   **其它公网 registry / Git 托管**（`quay.io`、`gcr.io`、`ghcr.io`、`k8s.gcr.io`、`registry.k8s.io`、`nvcr.io`、`mcr.microsoft.com`、`public.ecr.aws`、`gitlab.com`、`codeberg.org` 等及其它公网服务）：
   - **禁止瞎拼代理 URL**（如 `docker.1ms.run/quay.io/...`、`docker.1ms.run/nvcr.io/...` 都不是有效路径 — 这些公网代理只针对自己声明的源仓库工作）
   - 默认**先用原 URL 试**，不主动套代理
   - 如果用户在消息里明确给出了代理 URL（如 `请用 https://my-proxy/quay.io/calico/node`），照用
   - 如果出现拉取失败（`ImagePullBackOff`、`Manifest not found`、`connection refused`），**这时才**询问用户："`quay.io/...` 拉取失败，可能是网络问题。您是否有可用的代理？或者继续重试原 URL？"

   **私有 / 自建 registry**：直接用原 URL，**绝不代理**。判断特征（principle）：URL 包含 `.internal` / `.local` 后缀、企业自有域名（`harbor.<corp>.com`、`registry.<corp>.cn`）、IP+端口（`10.x.x.x:5000`、`<host>:443/...`）、云厂商私有仓库子域名（`registry.cn-*.aliyuncs.com`、`<aws-account>.dkr.ecr.<region>.amazonaws.com` 等用户专属路径）。模型用通用知识识别，不需要等清单。

   **已在镜像源的 URL**（前缀已是 `docker.1ms.run`、`m.daocloud.io`、`mirror.gcr.io`、`ghfast.top/...` 等）：直接通过，不重复代理。

   一次 run 内复用同一代理前缀，不并存多个。用户明确说"不用代理"或"用原始地址" → 当次 run 内对所有 in-scope URL 都跳过代理。

   > 编号说明：原 Iron Law 7（image 代理 ask once）已合并到本条；后续 Iron Law 编号保留原值（8、9、10…），不重编号以免破坏跨规则引用。
   > 措辞说明：代理 URL 是**事实信息**（哪个代理服务真的能 proxy 哪个源），必须写清单 — 这跟 Iron Law 37 把"基础设施软件"写成 principle 是不同性质。不要把这里的清单也"principle 化"，否则模型会瞎拼无效代理 URL。
