---
name: rainbond-project-init
description: Use when onboarding a local project into Rainbond for the first time, especially when the project is not yet linked and may not yet have a rainbond.app.json manifest.
---

# Rainbond Project Init

## Rainbond 传输

如果上游已初始化本次工作流的 RainSkills CLI，直接复用，不重新探测。否则在第一次 Rainbond 调用前读取 [../rainbond-app-assistant/references/transport-resolution.md](../rainbond-app-assistant/references/transport-resolution.md) 并初始化一次。CLI 锁定后，认证、网络、超时和业务错误均不得触发替代调用通道。

## Overview

Use this skill to perform the **first-time onboarding** of a local project into Rainbond.

This skill is the initialization phase before normal day-2 operations can use `rainbond-app-assistant`.

It should:
1. detect whether the project already has a Rainbond manifest
2. generate a first draft manifest if missing
3. infer a component topology and the most appropriate current delivery mode
4. determine whether the project is already linked
5. create or locate the target Rainbond app
6. write `.rainbond/local.json`
7. produce an execution summary for the current component sources
8. either stop after initialization or hand off to downstream Rainbond deployment flow

This skill is for **first-time setup**, not ongoing operations.

## Canonical Model Reference

Use [product object model](../rainbond-app-assistant/references/product-object-model.md) as the repository-level source of truth for:

- `Project` identity and topology baseline boundaries
- `Environment` selection and local config layering
- `ComponentSource` kinds, readiness semantics, and external projection rules

This skill should describe how onboarding produces or resolves those objects. It should not redefine their canonical boundaries independently.

## 用途速览

这是首次接入 Rainbond 的初始化 skill。

它负责：
- 判断当前项目是否已经有 manifest / local binding
- 在缺失时生成 `rainbond.app.json`
- 创建或定位 Rainbond app
- 写入 `.rainbond/local.json`

它不负责：
- 运行态排障
- 代码修复
- 深入交付验收

语言约定：
- 规则说明和流程说明优先中文
- `### Structured Output` 中的对象名、字段名、enum 保持英文 canonical 形式

## 硬规则

以下规则优先级最高。若后文示例或详细说明与这里冲突，以这里为准。

1. 只检查当前项目目录中的 `rainbond.app.json` 和 `.rainbond/local.json`。
   不允许扫描 `$HOME` 或其他仓库寻找绑定文件。
2. 如果 `rainbond.app.json` 已存在，默认复用它；不要无故重生成。
3. 如果没有 manifest，按仓库结构保守推断。
   对 Git 仓库里的业务代码组件，优先推成 `source`，不要轻易推成通用镜像。
4. 对 docs / Docusaurus / frontend Git 项目，默认优先 `source-backed`。
5. Docker 镜像代理、Git 代理只是 transport hint，不改变 `execution_mode`。
6. 如果源码 Git URL 是原始 `https://github.com/...`，且用户没有明确给出代理地址，优先先问一次是否改用代理地址，再继续。
7. **team 智能选择**：
   - 单个 team 可访问 → 直接用，不询问。
   - 多个 team 但 manifest 显式指定了 `team_name` 且该 team 在可访问列表里 → 直接用，在报告里说"已选 team = X（来自 manifest）"。
   - 多个 team 且无 manifest 提示 → 停下来询问；**禁止**静默选 `default` / 第一个 / 任意已有 team。
8. 如果这个 skill 是由 `rainbond-app-assistant` 的单入口主线调用的，init 成功后应该把 `next_action` 交给 bootstrap，而不是停在 init。
9. `team_name = default` 只有在用户明确给出或明确确认时才允许。
10. 不要把本地 Docker 构建、临时镜像仓库推送、启动 Docker Desktop/OrbStack 当成 init 的自动兜底；这些都是 delivery-mode 策略切换，必须先得到用户明确确认。
11. **bare Git URL + 无本地项目特征文件的默认路径**：当前 CWD 无任何项目特征文件（无 `rainbond.app.json`、`Dockerfile`、`package.json`、`go.mod`、`pom.xml`、`requirements.txt` 等）且用户仅给了一个 Git URL 时：
    - 默认 `subdirectories=""`（仓库根）传给 source 检测工具，由 Rainbond 后端判断仓库结构
    - 只生成**一个**组件；后端返回 `multiple services detected` 或等价多组件歧义 → 停下来按 Iron Law 10 让用户选子目录
    - **禁止**凭模型对该仓库的先验知识枚举或猜测子目录（由 app-assistant Iron Law 36 字面值 verbatim 约束强制 — `subdirectories` 是受保护的字段）
    - 仅当用户的需求文本本身明确说了某个子目录（"我要部署仓库下的 X 子目录"）才直接 verbatim 用用户给的子目录字面值，不需要再问

## 主线流程

### 固定只读与创建 Tool

Use known Tools directly: `rainbond_query_teams`, `rainbond_query_regions`, `rainbond_query_apps` or `rainbond_get_team_apps`, and `rainbond_create_app`. Do not use `list` or `describe` to rediscover them. At every Rainbond Tool boundary, normalize a decimal `app_id` session value to a positive integer and reject non-numeric IDs.

1. 读取当前项目目录里的 manifest / local binding。
2. 如果没有 manifest，就按仓库结构推断生成 `rainbond.app.json`。
3. 如果推断出的源码地址是原始 GitHub URL，且用户未显式给出代理地址，先询问是否改用 GitHub 代理。
4. 解析 `team_name / region_name / app_name`。
5. 通过已锁定的 Rainbond 传输查找或创建 Rainbond app。
6. 写入 `.rainbond/local.json`。
7. 输出 `ProjectInitResult`，并决定是 stop 还是 bootstrap。

## 停止条件

以下情况必须停住：

- 多个 team 但用户还没选
- region / app identity 仍不明确
- 已锁定的 Rainbond 传输不可用，无法完成 online verification
- 用户明确要求 stop-after-init

## Scope guardrails

This skill must not:

- guess destructive actions, delete existing resources, or rewrite an existing binding without explicit evidence and confirmation;
- expand initialization into bootstrap, troubleshooting, delivery verification, or template installation;
- invent unresolved team, region, app, source, image, or template identity.

## On-demand references

Load only the reference required for the active initialization stage:

- [references/manifest-rules.md](references/manifest-rules.md) — scope, manifest modes, inference, generation, and local binding rules.
- [references/workflow-and-verification.md](references/workflow-and-verification.md) — initialization sequence and completion checks.
- [references/output-contract.md](references/output-contract.md) — InitResult schema rendering and response sections.
- [references/operational-reference.md](references/operational-reference.md) — common mistakes and quick reference.
