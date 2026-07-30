### 部署结果

部署成功。

应用：`spring-postgres-dev`
环境：`preview`

- 部署位置：[打开 Rainbond 应用](https://run.rainbond.com/#/team/kz5igqh4/region/rainbond/apps/180/overview)
- 访问地址：[打开应用](http://gr0c90d0-8080-kz5igqh4.203.0.113.10.nip.io)

### 运行状态

- `db`：运行中
- `backend`：运行中
- HTTP 检查：200 OK，已返回预期的 Spring 页面

### 处理记录

- 使用镜像代理拉取 PostgreSQL，并使用 Git 代理拉取后端源码
- 后端内存已调整为 1024Mi
- 数据库地址已改为 Rainbond 内部服务地址
