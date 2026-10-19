# initialize

2. **team / app 智能选择**：
     - 单个 team 可访问 → 直接用，不询问。
     - 多个 team 但 manifest（`rainbond.app.json` / `.rainbond/local.json`）显式指定了 `team_name` 且该 team 在可访问列表里 → 直接用，在报告里明确说"已选 team = X（来自 manifest）"。
     - 多个 team 且无 manifest 提示 → 停下来询问用户，**禁止**静默选 `default` / 第一个 / 任意已有 team。
     - app 选择同上逻辑：manifest 指定且可解析 → 直接用；无提示且多候选 → 询问。
     - 任何自动选择的结果都必须在最终报告里以"已选 X（理由：来自 manifest / 单一可选）"形式告知，邀请用户覆盖。
     - 每个 Rainbond Tool 边界都要把十进制字符串 `app_id` 规范化为正整数；非数字 ID 必须拒绝。

4. `project-init` 成功 linked 后，如果当前 run 是单入口部署/开发到测试主线，必须自动继续到 `bootstrap`。
