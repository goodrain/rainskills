# RainSkills npm 发布 Runbook

本文描述 `rainskills` 包的首次发布、Trusted Publishing 配置、正式发布和失败恢复。npm 包与 CDN 包使用同一个 `install.sh`，npm 包不使用 `postinstall`，也不保存长期发布 Token。

## 1. 发布前提

- npm 账号已启用双因素认证，并有权维护 `rainskills`
- 本机使用 Node.js 24
- `package.json.repository.url` 必须是 npm 规范形式 `git+https://github.com/goodrain/rainskills.git`
- GitHub 正式发布使用 GitHub-hosted runner
- 正式 tag 受保护，只允许维护者创建
- 所有命令都在仓库根目录执行

发布前统一验证：

```bash
npm ci --ignore-scripts
npm test
npm audit --audit-level=high
npm publish --dry-run --tag next
```

## 2. 首次 RC 人工发布

Trusted Publisher 只能配置给已经存在的 npm 包，因此 `0.1.0-rc.0` 必须先人工发布到 `next`，不能直接走 OIDC。

1. 确认 `package.json` 和 `package-lock.json` 的版本均为 `0.1.0-rc.0`。
2. 确认包名尚未被其他人占用：

   ```bash
   npm view rainskills
   ```

   首发前预期结果是 `E404`。如果返回了非本项目包，立即停止，不能覆盖或复用该名称。

3. 进行一次临时交互登录并发布 RC：

   ```bash
   npm login
   npm publish --access public --tag next
   ```

4. 验证 registry 与真实入口：

   ```bash
   npm view rainskills@next version dist.integrity
   npm run verify:published -- next
   ```

5. 保持当前临时登录，只用于下一节配置 Trusted Publisher；配置完成后立即退出。

不要把 npm 登录信息、一次性验证码或 Token 写入仓库、GitHub Secret、文档或终端记录文件。

## 3. 配置 Trusted Publisher

`npm trust` 要求 npm 11.15.0 或更高版本，且包必须已经存在：

```bash
npm install --global 'npm@^11.15.0'
npm trust github rainskills \
  --repo goodrain/rainskills \
  --file release.yml \
  --allow-publish \
  --yes
npm trust list rainskills
npm logout
```

也可以在 npm 网站的 `rainskills` 包设置中配置，字段必须是：

| 字段 | 值 |
| --- | --- |
| Provider | GitHub Actions |
| Organization | `goodrain` |
| Repository | `rainskills` |
| Workflow filename | `release.yml` |
| Environment | 留空 |
| Allowed action | `npm publish` |

文件名只填 `release.yml`，不要填 `.github/workflows/release.yml`。配置完成后，发布工作流依靠 OIDC 的短期凭证，不需要 `NPM_TOKEN`。

## 4. 正式稳定版发布

首次稳定版示例：

```bash
npm version 0.1.0 --no-git-tag-version
npm ci --ignore-scripts
npm test
npm publish --dry-run
git add package.json package-lock.json
git commit -m "chore: release 0.1.0"
git push origin main
```

等待 `main` 对应的 TOS canary 发布成功后，再创建严格匹配版本的 tag：

```bash
git tag stable-v0.1.0
git push origin stable-v0.1.0
```

`.github/workflows/release.yml` 会按以下顺序执行：

1. 校验 tag 必须严格等于 `stable-v${package.json.version}`，并拒绝预发布版本。
2. 使用 Node.js 24 和 npm 11.5.1 运行完整测试。
3. 只打包一次 npm tarball，并记录 integrity。
4. 若同版本已发布，比较远端与本地 integrity；相同则跳过发布，不同则立即失败。
5. 校验 tagged commit 对应的 CDN tarball 已存在。
6. 更新 TOS `stable.json`。
7. 使用 OIDC 发布步骤 3 生成的同一个 npm tarball，并再次校验远端 integrity。
8. 通知 vendor sync。

npm 上每个名称和版本组合只能发布一次。不要删除后尝试重发同一版本。

## 5. 失败恢复

| 失败位置 | 渠道状态 | 恢复方式 |
| --- | --- | --- |
| tag 校验、测试、打包、CDN 检查 | TOS 和 npm 均未变更 | 修复后创建新提交和正确 tag |
| TOS 上传失败 | npm 未发布 | 修复 TOS 配置或服务后重跑同一 workflow run |
| TOS 成功、npm 发布失败 | CDN 已切换，npm 仍是旧版或不存在 | 修复 Trusted Publisher/registry 后重跑；TOS 上传可重复执行，npm 未发布版本会继续发布 |
| npm 已成功，但校验或 vendor 通知失败 | 两个安装渠道已发布，后续步骤未完成 | 直接重跑；工作流会验证相同 integrity 并跳过不可重复的 `npm publish` |
| registry 已有同版本但 integrity 不同 | 工作流在渠道变更前停止 | 不要 unpublish；递增版本并创建新 tag |

若 `npm publish` 返回 `ENEEDAUTH`，依次检查：

- Trusted Publisher 的组织、仓库和 `release.yml` 是否完全匹配
- 允许动作是否包含 `npm publish`
- workflow 是否有 `id-token: write` 和 `contents: read`
- runner 是否为 GitHub-hosted
- Node 是否为 22.14.0+、npm 是否为 11.5.1+

## 6. 问题版本回滚

已经发布的 npm 版本不删除、不复用。先人工登录，再标记问题版本并把 `latest` 指回已验证版本：

```bash
npm login
npm deprecate rainskills@<bad-version> "Known issue; use <good-version>"
npm dist-tag add rainskills@<good-version> latest
npm logout
```

OIDC 只用于 `npm publish`，不能用于 `npm dist-tag`，因此这一步必须由维护者交互认证。CDN 渠道应同时恢复到对应的已验证 stable manifest；优先重跑该旧 `stable-v<good-version>` tag 的发布工作流。完成后分别验证：

```bash
npm view rainskills dist-tags versions
npm run verify:published -- latest
curl -fsSL https://get.rainbond.com/rainskills/channels/stable.json
```

任何发布前或发布后的安装烟测都必须通过 `npm run verify:published -- <version>` 执行，不得直接拼装 `npx rainskills ...`。验证脚本会显式选择 `all`、使用临时 HOME，并通过参数和环境变量双重关闭遥测；普通用户安装仍按默认策略发送匿名安装遥测。

官方参考：[Trusted Publishing](https://docs.npmjs.com/trusted-publishers/)、[`npm trust`](https://docs.npmjs.com/cli/v11/commands/npm-trust/)、[`npm publish`](https://docs.npmjs.com/cli/publish/)。
