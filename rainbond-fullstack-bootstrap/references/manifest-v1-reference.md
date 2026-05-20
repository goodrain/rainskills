# Manifest v1 Reference

Use this reference only when you need the low-frequency baseline example or enum reminders for manifest-driven bootstrap.

## `rainbond.app.json` Baseline Example

```json
{
  "schema_version": 1,
  "project": {
    "team_name": "team-demo",
    "region_name": "rainbond",
    "app_name": "fullstack-demo"
  },
  "components": [
    {
      "name": "web",
      "role": "frontend",
      "image": "example.com/demo/web:latest",
      "port": 80,
      "env": {
        "VITE_API_URL": "/api"
      },
      "access_mode": "reverse-proxy",
      "depends_on": ["api"]
    },
    {
      "name": "api",
      "role": "service",
      "image": "example.com/demo/api:latest",
      "port": 8080,
      "depends_on": ["postgres"]
    },
    {
      "name": "postgres",
      "role": "database",
      "image": "example.com/demo/postgres:latest",
      "port": 5432,
      "port_alias": "DATABASE",
      "env": {
        "POSTGRES_DB": "demo",
        "POSTGRES_USER": "postgres",
        "POSTGRES_PASSWORD": "$DB_PASSWORD"
      },
      "connection_envs": {
        "DB_NAME": "demo",
        "DB_USER": "postgres",
        "DB_PASS": "$DB_PASSWORD"
      }
    }
  ],
  "registry": {
    "username": "registry-user"
  }
}
```

Notes:
- `rainbond.app.json` is the repo baseline, not the highest-priority source
- legacy `rainbond.json` may still be used as the same lowest-priority baseline tier
- secrets should come from explicit input or `.rainbond/secrets.<environment>.json`, not from committed manifest files
- database persistence intent may come from compose volumes or existing manifest extensions; if the current execution tooling cannot apply it, preserve it in the human-readable caveat instead of silently dropping it
- `connection_envs` defines provider-side connection information exposed to dependent components; configure it with `rainbond_manage_component_connection_envs`, not as per-consumer runtime envs

## Component Role Types

- `frontend`
  - user-facing web interface
- `service`
  - backend API or microservice
- `database`
  - stateful database component
- `cache`
  - cache layer such as Redis or Memcached
- `worker`
  - background worker

## Provider Connection Contract Fields

- `port_alias`
  - stable provider port alias used to generate dependency-derived `*_HOST` and `*_PORT` values
- `connection_envs`
  - provider-side values injected into dependent components when explicit dependencies are created
  - examples: `DB_USER`, `DB_PASS`, `DB_NAME`, `REDIS_PASSWORD`, `KAFKA_BROKERS`
  - secret values should use placeholders such as `$DB_PASSWORD` and come from explicit input or `.rainbond/secrets.<environment>.json`

## Frontend Access Modes

- `unspecified`
  - bootstrap must stop short of `setup complete`; frontend validation is still required
- `runtime-env`
  - frontend uses runtime env for API URL
- `build-time-env`
  - frontend uses build-time env for API URL; build-time wiring itself is outside bootstrap scope
- `reverse-proxy`
  - frontend nginx proxies `/api` to the backend service

## Delivery Source Mapping Summary

Baseline mapping rules:
- v1 top-level `image` -> image execution
- v2 `source.kind = image` -> image execution
- v2 `source.kind = source` -> source execution
- v2 `source.kind = package` -> local package upload execution
- v2 `source.kind = template` -> skip in bootstrap and hand off to `rainbond-template-installer`

## v2 `source.build` (optional, source-mode only)

For `source.kind = source` components, the optional `source.build` block declares **how** the source should be built. It is the persisted, manifest-level override for build-mode decisions that would otherwise rely on heuristic inference.

Schema:

```yaml
source:
  kind: source
  git: { … }
  subdirectories: <string>
  build:                              # optional; default: { strategy: auto }
    strategy: dockerfile | cnb | auto # dockerfile = force Dockerfile build;
                                      # cnb        = force language buildpack;
                                      # auto       = let the skill decide via heuristic
```

Example — a frontend component that ships a custom Dockerfile (with non-standard runtime config) where buildpack auto-detection would otherwise pick the language path and overwrite that config:

```json
{
  "name": "web",
  "role": "frontend",
  "port": 80,
  "source": {
    "kind": "source",
    "git": { "remote_url": "https://example.com/org/repo", "ref": "main" },
    "subdirectories": "frontend",
    "build": { "strategy": "dockerfile" }
  }
}
```

Resolution rules:
- `strategy: dockerfile` → maps to `prefer_dockerfile_when_detected = true` on `rainbond_create_component_from_source`. Skip heuristic.
- `strategy: cnb` → force the language buildpack path even if a Dockerfile is present. Skip heuristic.
- `strategy: auto` (or block omitted) → fall through to the heuristic in `source-build-parameter-guide.md § Build Mode Selection`.

The manifest-level choice is the user's persisted intent — honor it without re-deriving. See [source-build-parameter-guide.md](source-build-parameter-guide.md) for the full priority chain (manifest → heuristic → user prompt → record back to manifest).

Do not treat this reference as the execution-policy source of truth. The execution rules live in:
- [../modules/10-context-loading.md](../modules/10-context-loading.md)
- [../modules/20-scope-and-boundaries.md](../modules/20-scope-and-boundaries.md)
- [../modules/40-source-and-package-rules.md](../modules/40-source-and-package-rules.md)
