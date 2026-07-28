# Self-hosted Rainbond installation hint design

## Goal

When a user interactively selects a self-hosted Rainbond environment, make the Rainbond prerequisite visible before asking for the Console URL. Users who have not installed Rainbond should receive the official quick-install command without having to leave or restart the RainSkills installer.

## User flow

The existing target-client selection remains unchanged. In the deployment-mode menu:

1. Selecting Rainbond Cloud continues directly with `https://run.rainbond.com` and does not show the self-hosted hint.
2. Selecting self-hosted prints the following plain-text banner, then immediately continues to the existing Console URL prompt:

```text
============================================================
[重要] 私有化部署需要先准备一个可访问的 Rainbond 环境

如果尚未安装 Rainbond，请在目标机器执行快速安装命令：
  curl -o install.sh https://get.rainbond.com && bash ./install.sh

安装完成后，请使用安装脚本输出的 Console 地址继续下面的配置。
安装文档：https://www.rainbond.com/docs/quick-start/quick-install/
============================================================

Rainbond Console 地址:
```

The banner uses separators and an explicit `[重要]` marker instead of ANSI colors so it remains prominent and readable in all supported terminals and test environments.

## Scope and behavior

- Show the banner only after option `2` is chosen in the interactive deployment-mode menu.
- Do not ask whether Rainbond is installed.
- Do not execute the Rainbond installation command automatically.
- Do not pause, exit, or restart RainSkills.
- Do not show the banner for SaaS selection, `--self-hosted`, an explicit `--rainbond-url`, or other non-interactive flows.
- Keep the existing Console URL prompt, browser authorization, MCP validation, and client configuration behavior unchanged.

## Implementation

- Add a small output helper in `install.sh` for the self-hosted prerequisite banner.
- Invoke it only from the interactive `2)` branch of `resolve_deployment_mode` before returning to the existing URL prompt.
- Update `README.md` to document that the interactive self-hosted flow displays the official quick-install command.

## Testing

- Add a terminal-facing installer test that selects self-hosted and asserts:
  - the `[重要]` marker is present;
  - the official quick-install command is present;
  - the installation documentation URL is present;
  - the banner appears before the Console URL prompt;
  - the installer continues to request the Console URL.
- Add or extend a SaaS-path assertion that the self-hosted banner is absent.
- Run the focused installer test, then the full `npm test` suite.

## Non-goals

- Detecting whether Rainbond is already installed.
- Installing Rainbond from the RainSkills process.
- Opening the installation documentation automatically.
- Changing non-interactive output or flags.
