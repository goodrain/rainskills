# SQL Initialization Recipe

Use this reference when a project ships SQL initialization assets that the database container will not auto-load (the project is not a pre-baked image with `docker-entrypoint-initdb.d` already populated, or the SQL files live alongside application source rather than database image).

Detection signals:
- repository contains `sql/*.sql`, `db/init/*.sql`, `migrations/*.sql`, or similarly named bootstrap SQL files
- README mentions "导入 SQL"、"初始化数据库"、"import sql before first run"
- application fails at startup with `Table 'X' doesn't exist` or `relation "X" does not exist`

When these signals appear, choose ONE delivery path from the decision tree below and stick to it. Do not switch mid-flight.

## Decision Tree

### Q1: Is the project source code already in a remote git repository reachable by the Rainbond cluster?

- YES → use **Recipe A: Init-Job Component** (default, recommended)
- NO  → ask the user to push the repository to a reachable git host first. Do NOT attempt MCP local-package upload as a substitute for missing remote git. Local-package upload is allowed only when the user explicitly opts in after being told it is slow and lossy.

### Q2: Does the user already have a pre-baked database image with init data embedded?

- YES → use **Recipe B: Pre-baked Image**. The skill only needs to verify dependency wiring and connection envs.
- NO  → continue with Recipe A.

## Recipe A: Init-Job Component (default)

Create a one-shot component alongside the database component. It uses the same git repository as the application, points its source subdirectory at the SQL folder, runs a mysql/psql client image, and depends on the database component.

Required wiring:
- `source.kind = source`
- `git_url` = the same reachable git URL used by the application component
- `code_version` = the same ref as the application component
- `subdirectories` = the directory holding SQL files (e.g., `sql`, `db/init`)
- base image / build path = a client image matching the database engine, e.g.:
  - MySQL: `mysql:8` or `mysql:5.7`
  - PostgreSQL: `postgres:15`
- start command = a shell script that iterates SQL files and pipes them through the client. Example for MySQL:
  ```
  set -e
  for f in /app/*.sql; do
    echo "Importing $f"
    mysql -h "$DB_HOST" -P "${DB_PORT:-3306}" -u "$DB_USER" -p"$DB_PASS" "$DB_NAME" < "$f"
  done
  echo "init done"
  ```
- depends_on = [database component]
- replicas = 1
- restart policy = `Never` (run once and exit). If the platform does not expose a Job-style restart policy, scale the component to 0 after a successful run and document that decision in `actions_performed[].details`.

Connection envs (`DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASS`, `DB_NAME`) MUST come from the provider connection envs of the database component injected through the explicit dependency. Do NOT hand-type those values on the init component. See the connection-env routing rules in [40-source-and-package-rules.md](../modules/40-source-and-package-rules.md) and the dependency rules in [50-workflow-and-convergence.md](../modules/50-workflow-and-convergence.md).

Idempotence:
- the SQL files SHOULD be idempotent (`CREATE DATABASE IF NOT EXISTS`, `CREATE TABLE IF NOT EXISTS`, conditional inserts).
- if they are not, mark the init component as one-shot in `actions_performed[].details` and do not auto-restart it.

## Recipe B: Pre-baked Image

The user supplies a database image that already runs initialization on container start (typical pattern: `mysql:8` with `docker-entrypoint-initdb.d/*.sql` embedded in a custom image).

Skill responsibilities are limited to:
- creating the database component from the supplied image
- declaring the init image expects a one-time run; subsequent restarts should not re-import
- verifying that consumer components depend on the database and receive provider connection envs

No extra init component is needed.

## Forbidden Paths

These shortcuts have repeatedly failed in past runs and MUST NOT be attempted:

- public file-sharing services (file.io, transfer.sh, pastebin, anonymous S3 buckets) as a transport for SQL files
- manual `kubectl exec` / `docker exec` into the database pod to run import commands
- one-shot import containers WITHOUT a declared `depends_on` to the database component (race condition: the importer can start before the database is ready)
- MCP local-package upload as the default path; only allow it when the user has been informed it is slow and has explicitly opted in
- creating the init component as `image` with a hand-typed connection string instead of a dependency-injected provider connection env
- pushing a temporary database image to a registry just to embed the SQL files (this is a delivery-mode switch and requires explicit user confirmation)

## Stop Conditions

Stop and report to the user when:
- the project ships SQL init assets but the application source is only on a local disk (no reachable remote git) and the user has not opted into MCP local-package upload
- the SQL files are too large to fit in the chosen transport (single file > 100 MB) — request a different transport strategy explicitly
- the database engine is unsupported by the available client images (no matching `mysql` / `postgres` / `mongo` client image accessible to the cluster)
- Recipe A succeeds at creation but the init component fails repeatedly because the SQL files are not idempotent — the user must decide whether to make them idempotent or run a one-shot manual import
