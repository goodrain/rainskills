Compose profile活跃 services: `db_postgres`、`redis`、`api`（api 的 depends_on 指向 db_postgres 和 redis）。请把 api 的数据库/缓存连接配好并把整套拓扑部署到 Rainbond。
