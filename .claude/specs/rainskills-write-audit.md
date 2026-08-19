# RainSkills 写操作审计实施规格

本规格由已审核的设计文档生成，用于在以下四个本地分支中实施：

- `/Users/guox/Desktop/Project/rainbond-console`：权威审计和内部导出。
- `/Users/guox/Desktop/Project/rainskills`：Skill manifest、CLI confirmation 绑定和 `_meta`。
- `/Users/guox/Desktop/Project/rainbond-agent`：事件导入、企业隔离和详情快照代理。
- `/Users/guox/Desktop/Project/rainbond-agent-ui`：统一审计展示。

## 执行约束

- 当前分支统一为 `codex/rainskills-write-audit`。
- 按 Console → RainSkills → Agent → UI 顺序实现。
- Python/Node/TypeScript 后端均先写失败测试，再写最小实现。
- React 使用契约测试和 `npm run build` 作为门禁。
- 不修改 Agent `OperationLogProjector`，不改变旧 approval/projector 审计链路。
- 不执行 `git add`、`git commit` 或 `git push`。
- 不派发子 Agent，所有任务由当前主 Agent 本地完成。

## 逻辑变更组

1. Console：Tool policy、三张审计表、MCP fail-closed gate、企业绑定内部 API。
2. RainSkills：确定性 manifest、POSIX/Windows 安装、CLI Skill 归属和 metadata。
3. Agent：schema/Store/importer、外部数据企业隔离、现有 API 详情扩展。
4. Agent UI：RainSkills 来源、confirmation、Skill 版本/digest/正文。
5. 四仓库测试、构建、安全检查和 API 兼容核对。

完整任务、失败/通过命令、代码骨架和引用见同名 YAML。逻辑 commit 分组仅用于控制变更边界，本次明确不创建提交。
