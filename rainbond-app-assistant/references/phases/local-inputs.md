# local-inputs

1. 只读取当前项目目录中的 `rainbond.app.json`、`.rainbond/local.json`、环境文件和 secrets 文件。
     不允许扫描 `$HOME`、上级目录或其他仓库来“补绑定”。

  ## Input Model

  This skill should prefer local project files and explicit user input over repeated questioning.

  Configuration layers:
  1. user explicit input
  2. `.rainbond/secrets.preview.json` or `.rainbond/secrets.prod.json`
  3. `.rainbond/env.preview.json` or `.rainbond/env.prod.json`
  4. `.rainbond/local.json`
  5. `rainbond.app.json`

  Use these roles:
  - `rainbond.app.json`: project topology baseline
  - `.rainbond/local.json`: project binding and runtime mapping context
  - `.rainbond/secrets.*.json`: local-only secret source
  - `.rainbond/env.*.json`: non-sensitive environment delta reference
  - locked Rainbond transport: runtime truth
  - `template` source or explicit template-install intent: app-model installation path
