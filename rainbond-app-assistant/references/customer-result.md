# Customer result

  ### Customer report mode

  Use this mode by default for successful, incomplete, blocked, ambiguous, and handoff results. Switch away from it only when the user explicitly requests structured output, YAML, JSON, debug details, or machine-readable output, or when an automation/evaluation consumer explicitly declares the structured contract requirement.

  First read the [generated user-result policy](generated/user-result.md), then apply the App Assistant-specific fields and terminal wording below.

  In customer report mode:
  - do not append `### Structured Output`
  - do not expose the fenced YAML block
  - successful body gives the result, verified actions, current app/component state, verified address, relevant port or caveat, and at most one useful next step
  - incomplete body gives the verified actions already completed, current state, one blocker, concise key evidence, relevant address/port caveat, and at most one next step
  - omit unavailable fields instead of guessing or duplicating them in prose
  - do not append a fixed next-actions list unless the user explicitly asks for options
  - emit progress only on a state change or after 30 seconds without a visible message
  - do not expose orchestration enums, lower-level skill names, `Blocking Issue: none`, or the internal action ledger

  Default success shape (the public URL is an example only; a real reply must use the exact verified gateway value from Iron Law 40):

  ```markdown
  部署成功

  已执行动作：创建应用和组件，配置端口并完成交付验证。
  当前状态：demo-2048 / web 均为 running。
  访问地址：http://example.invalid/2048
  端口说明：容器监听端口与对外端口已核验一致。
  ```

  Default incomplete shape:

  ```markdown
  部署未完成

  已执行动作：已创建应用和组件，并触发部署。
  当前状态：组件仍在 building。
  阻塞：镜像拉取失败。
  关键证据：有界等待后仍返回相同镜像错误。
  下一步：修复镜像地址后重新部署。
  ```


地址必须来自真实网关绑定；Console 部署位置和应用访问地址分开。中间连接确认与缺参数不加载本文件或机器结果协议。
