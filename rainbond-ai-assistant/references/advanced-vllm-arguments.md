# 高级 vLLM 参数

- 优先使用结构化 `dynamic_params`；助手根据场景主动选择表单未覆盖、非平台保留且当前运行时支持的参数进入 `extra_argv[]`。
- 不要求用户逐项批准普通技术参数；在已有部署授权范围内自动决策。改变模型、预算、业务能力或涉及远程代码执行时保留相应业务取舍和授权边界。后端格式/冲突校验通过不代表运行时支持该参数；能力接口未给出支持证据时核对对应版本文档。
- 不发送 deprecated `extra_args`，不拼 `sh -c` 或完整命令，不建议当前版本未支持的 `--swap-space`。
- 不在本文件复制完整参数白名单。冲突、互斥、保留和长度限制以 AI Engine 的 `vllm_extra_argv_*` 稳定错误为准。
- 确认、审计、trace 和日志只保留规范化参数名；token/password/secret/authorization/api-key/private-key 等值必须脱敏。
- 错误时按 `vllm_extra_argv_invalid|parse_failed|conflict|mutually_exclusive|reserved|too_large` 解释，不删除平台基础参数绕过。
- 成功后可读取脱敏 resolved argv；需要验证运行时接收时只摘要启动日志的安全 non-default 参数名。

