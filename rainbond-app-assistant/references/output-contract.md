# Output selection

默认遵循 [generated user-result policy](generated/user-result.md)。中间阻塞直接使用根入口短模板；终态读 [customer result](customer-result.md)。用户或自动化明确要求 JSON/YAML 时才读 [structured result](structured-result.md) 和 schema。
