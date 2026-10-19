# CLI / Skills 部署流程优化：实现与验证

基线：0.1.45，`93eaf32`。实施日期：2026-10-19。修改限于 rainskills 仓库。

## 已完成的实现

1. **完整运行时入口。** 安装后的兼容 bridge 转发到完整 bundle；新增本地完整性检测和发布后冒烟检查。安装损坏、输入错误、平台错误和写结果未知有稳定错误码，不再统一报 API bridge error。事件 request_body 从工具结果中移除，避免字符串内嵌 JSON 凭据泄漏。
2. **阶段性加载。** 根 Skill 读取 mainline，再选初始化、创建、源码、排障或交付分支。旧 workflow/output/object 路径保留小索引。37 条原硬规则的位置记录在 rule-ownership.json；根入口和全部 references 有大小检查。中间连接确认不读取完整结果协议，普通终态使用 customer-result，结构化输出才读 schema 和详细规则。
3. **精确只读分类与等待。** 已验证的 summary 和 build-completion wait 免写确认。snapshot、poll、bridge 共用分类；未知操作保持保守。poll 的取消和总截止时间传入在途 RPC，同 event 仍只允许一个 60 秒等待回合。
4. **受保护批量配置。** 新 batch 命令先验证完整输入、实时 schema 和当前配置，再给出精简计划。确认绑定输入、scope、身份、Skill/bundle 和有效期；实际每一步仍使用既有确认 claim 和审计。无变化配置跳过，按序写入后刷新状态，防止旧快照导致后续步骤被错误跳过。首次失败即停，成功项保留，unknown 不重放。
5. **固定创建配方。** 新 recipe 命令覆盖 image/source/package；不更换来源、URL/ref，不提前部署。必须先验证同名组件与上传事件；状态型组件需要明确持久化参数。只把真实创建响应中的 service_id 绑定给后续配置。软件包继续使用既有保护上传和本地清理流程，recipe 只消费已上传的 event。
6. **契约与评测。** batch/recipe 的输入 schema 随 Skill 生成，CLI-only 命令不会出现在 embedded gate。宿主评测识别新组合命令；有逐响应 usage 时按 response_id 去重汇总，不能把底层命令数当成模型调用数。

## 使用入口

具体 argv 来自当前 Skill 的 generated Runtime Gate。两个命令都先预检，再以相同 stdin 加 `--confirm <confirmation-id>` 执行。

```text
node <home>/.rainbond/bin/rainskills-tools.js batch --input - --skill-id rainbond-fullstack-bootstrap
node <home>/.rainbond/bin/rainskills-tools.js recipe --input - --skill-id rainbond-fullstack-bootstrap
```

完整输入见 `contracts/confirmed-batch.schema.yaml`、`contracts/component-recipe.schema.yaml`；操作约束见 bootstrap 的 `modules/52-cli-batching.md`。batch 限同一 app、32 步、128 KiB 输入和 8 KiB 结果摘要，step key 最多 64 UTF-8 字节。删除、替换数据库、模板安装和来源切换不混入普通配置批次。

预检只在当前真实状态足以证明时跳过。敏感值被脱敏时不猜测是否相等；已有端口别名还必须核对请求中的 k8s_service_name。前面的写可能影响后续步骤时，后续步骤保持 planned，执行时重新读取；不能把一个已确认 skipped 的步骤偷偷扩展成写操作。

recipe 完成只代表创建/配置完成，`deploy_and_verify` 不是部署成功或已交付。继续通过既有部署操作取得真实 event，再做有界等待和实际访问验证。平台返回 running 时结束当前回复，用户明确继续后再检查。

## 可复核的静态读取变化

对比同一入口阶段：根 Skill、Runtime Gate、routing、workspace 后执行主线。包含新增命令使 Gate 变大的成本。

| 指标 | 基线 | 当前 |
|---|---:|---:|
| 进入执行主线的文档读取路径 | 91,637 字节 | 21,541 字节 |
| workflow / mainline | 74,517 字节 | 2,994 字节 |
| 完整输出协议 / 默认客户结果 | 26,119 字节 | 2,243 字节 |
| 顶层最大 reference | 74,517 字节 | 13,939 字节 |

入口阶段读取字节减少 **76.49%**。这是选定读取路径的静态测量，不是整次部署 token 降幅，也不代表全部部署分支只需读取这些文件。

## 验证

- `npm test`：完整 36 组检查通过，包含 Node/Python 测试、fixture eval、embedded、Windows 适配测试、npm 包安装、信号与 TTY 检查。
- 新增本地 CLI fixture 覆盖批量确认、scope 变更、一次性 claim、未知写、续跑、实时差异、顺序变更与敏感结果。
- 四组件配方覆盖数据库持久化、源码 ref、上传事件和 consumer → provider 依赖方向；只使用本地 mock 服务。
- 执行器、创建配方、轮询、风险分类及错误模块的定向单元覆盖：行 **93.44%**、分支 **81.79%**。这是列出的模块的覆盖，不是整个历史仓库覆盖率。
- 实际执行 `npm pack`，从生成 tgz 在临时 home 安装；安装后的 handoff、snapshot、poll 冒烟执行成功，不依赖开发目录。
- runtime/shared/marketplace 生成内容的 `--check` 与 `git diff --check` 通过。
- 独立前向验证检查了中断续跑、取消、unknown、依赖方向、CLI/embedded 资料加载和快照失效；发现的问题均有回归用例。

没有修改真实 Rainbond 资源，也没有运行付费模型的真实部署 token 配对实验。受控 live 评测入口和逐响应 usage 统计已准备，但实际节省比例需在相同模型、初始上下文与部署条件下测量。

## 设计依据

安装布局和既有确认机制直接复用本仓库实现；只读分类、原生数组参数和创建参数依据本机 Console 源码核对，并在运行时继续校验 live schema。不能假设所有连接平台已部署相同版本。

外部对照固定到 agent-browser 的 `dac13bb87468fe9d74a040d862720f6cc17a9565`：[薄 Skill 入口](https://github.com/vercel-labs/agent-browser/blob/dac13bb87468fe9d74a040d862720f6cc17a9565/skills/agent-browser/SKILL.md)、[按需文档](https://github.com/vercel-labs/agent-browser/blob/dac13bb87468fe9d74a040d862720f6cc17a9565/cli/src/skills.rs#L315)、[顺序批量执行与失败停止](https://github.com/vercel-labs/agent-browser/blob/dac13bb87468fe9d74a040d862720f6cc17a9565/cli/src/main.rs#L2258)。本实现保留 RainSkills 的确认、审计、来源与 60 秒等待边界，没有照搬浏览器 daemon 或通用工作流引擎。
