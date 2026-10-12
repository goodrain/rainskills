<!-- rainskills-runtime-gate:start -->
# Embedded Runtime Gate（生成文件）

本 Skill 在 rainbond-agent 的 embedded profile 中只使用当前会话提供的 `rainbond_*` Tool。服务端负责身份委托、审批、审计、超时与轮询保护；不得运行 shell、Node、curl 或本机 CLI，不读取客户端项目、`.rainbond/`、用户主目录、凭据或环境变量。

配置与上下文只来自用户明确输入、当前 UI/会话上下文或同一会话 Tool 返回的平台事实。Tool 不可用、认证失败、网络错误或结果未知时停止并报告；写操作不得重放，必须先使用同一会话的查询 Tool 核实平台事实。

本地目录打包、客户端上传和本地 helper 在 embedded profile 中不可用。需要本地工作区能力时，停止并明确交由支持客户端工作区的 CLI profile 完成，不得切换传输绕过服务端边界。

## Skill overlay

- `skill_id`: `{{SKILL_ID}}`
- `supported_profiles`: `{{SUPPORTED_PROFILES}}`
- `scope_discriminator`: `{{SCOPE_DISCRIMINATOR}}`
- `resume_target`: `{{RESUME_TARGET}}`

不可弱化的不变量：

{{INVARIANTS}}
<!-- rainskills-runtime-gate:end -->
