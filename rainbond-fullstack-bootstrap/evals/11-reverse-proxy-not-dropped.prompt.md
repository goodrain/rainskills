Compose 画像里有 `nginx`（按路径把 `/console/api`、`/api`、`/v1` 分发到多个 upstream）、`web`（前端，API env 是相对路径 `CONSOLE_API_URL=/api`）和 `api`。请部署整套拓扑并配好对外访问。
