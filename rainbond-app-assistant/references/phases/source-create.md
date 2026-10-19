# source-create

9. `check_uuid` / `event_id` 默认不是标准 source create 的前置条件。
   除非后端明确返回它们必需，否则不能把它们当 blocker。

10. 如果 source create 返回 `multiple services detected` 或等价的多组件源码歧义，必须停住，要求用户明确选择策略。
   不允许自动切到 local package、手工上传、模板安装或其他 workaround。

29. **仅给 bare Git URL 时默认 root + 空 `subdirectories`**：当用户给的只是一个 Git URL（无本地 manifest、无明确子目录提示），默认 `subdirectories=""`（仓库根）进入 source 检测，让后端判断这个仓库结构。**不要**先问用户"根目录还是子目录"。
    - 单项目仓库（一个 buildable root）→ 后端检测通过，正常 build
    - 多组件 / 多 example 仓库 → 后端返回 `multiple services detected` 或等价歧义信号 → 按 Iron Law 10 停下问用户选哪个子目录
    - 模型**禁止**凭训练知识枚举子目录或猜测路径（由 Iron Law 36 强制 — `subdirectories` 是受 verbatim 保护的字段之一）
    - 把"是否需要选子目录"这个判断**外包给后端检测**，不要前置询问；前置询问只在用户的需求文本本身就说了"我只要这个仓库的 X 子目录"这类显式信号时才有意义（这时直接 verbatim 用用户给的子目录字面值）
