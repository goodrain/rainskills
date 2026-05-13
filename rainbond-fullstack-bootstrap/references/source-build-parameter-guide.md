# Source Build Parameter Guide

Use this reference when a source-backed component needs build parameter tuning through the updated Rainbond MCP workflow.

## Tool Routing

Route each concern through the correct MCP entry:

- build parameters: `rainbond_manage_component_envs(operation=replace_build_envs, build_env_dict=...)`
- runtime envs: `rainbond_manage_component_envs` with normal env operations
- provider connection envs: `rainbond_manage_component_connection_envs`
- dependencies: `rainbond_manage_component_dependency`
- source repo / branch / auth / detection preference: `rainbond_create_component_from_source` inputs plus `rainbond_build_component.build_info`

Do not move data across these boundaries just because a nearby field "accepts an object."
Do not use consumer runtime envs as a shortcut for middleware provider connection contracts.

## Decision Order

1. Read explicit user intent first.
2. Read source detection or current component build metadata.
3. Determine whether the user wants language build or Dockerfile build.
4. Apply the smallest viable `build_env_dict` for that language and symptom.

## Build Mode Selection (HARD RULES)

When source detection returns BOTH a language signature AND a Dockerfile:

- MUST keep the language build path by default. Treat the component as language-backed.
- MUST NOT generate a local Dockerfile, modify the user's Dockerfile, switch the component to `image` or `package` mode, or run local `mvn` / `npm` / `docker build` to produce upload artifacts. These count as delivery-mode switches and require explicit user confirmation.
- MUST NOT promise `dockerfile_path`; the current MCP surface does not expose it.

Escape conditions (any one allows Dockerfile mode):
- E1: the user explicitly says "use Dockerfile" / "走 Dockerfile" / "build with Dockerfile".
- E2: the Dockerfile passes the static check below as `self-contained` AND the language build path was attempted at least once and failed for a structural reason that is not a missing `build_env_dict` value.
- E3: source detection returned no buildpack-supported language at all.

### Dockerfile Static Check

Run this classification before considering escape E2.

- If the Dockerfile contains `COPY target/*.jar`, `COPY dist/`, `COPY build/`, `COPY out/`, or any `COPY` of a path that does not exist in the source repo, AND there is no preceding `FROM ... AS <stage>` builder stage that produces those paths:
  - classification = `needs-prebuilt`
  - this Dockerfile assumes a local build artifact; MUST stay on the language build path; never escape to Dockerfile mode for this component.
- If the Dockerfile is multi-stage with a builder stage (`FROM <lang>:* AS build` … `COPY --from=build …`):
  - classification = `self-contained`
  - eligible for escape E2.
- If the Dockerfile is single-stage, only installs runtime packages, and does not COPY build artifacts:
  - classification = `runtime-only`
  - language build still preferred; do not escape unless E1 or E3 also holds.

### Forbidden Short-Circuits (apply regardless of mode)

- generating local `Dockerfile` / `manifest` / `docker-compose.yml` to "preview" the deployment before the platform path has been tried.
- running `mvn package` / `npm run build` / `docker build` locally to produce artifacts for MCP package upload.
- switching to MCP package upload as the first response to a build failure.
- pushing a temporary image to a registry as a fallback for source build failure.

Any of the above is a delivery-mode switch and requires explicit user confirmation; otherwise stay on the language build path and report the structural failure.

## Monorepo Build Context

For monorepos, check whether the component build needs repository-root files before changing build parameters. If a subdirectory service depends on root-level lockfiles, parent POM, or project metadata, preserve the root build context intent and avoid child-directory-only source definitions that hide those files.

For Java multi-module projects (parent `pom.xml` with `<modules>`), the standard pattern is:
- source root = repository root (not the submodule directory)
- `BP_MAVEN_BUILD_ARGUMENTS` or `BP_MAVEN_ADDITIONAL_BUILD_ARGUMENTS` to scope the build (`-pl <module> -am`)
- `BP_MAVEN_BUILT_MODULE` / `BP_MAVEN_BUILT_ARTIFACT` to point at the produced jar inside the submodule's `target/`

## Minimal-Set Rule

Do not paste a full language template into `build_env_dict`.

Start with the smallest keys that explain the failure or satisfy the user's explicit requirement:
- version selection
- build command or build arguments
- output directory or project path
- Procfile / startup handoff
- mirror or private registry settings only when needed

If the language is uncertain, stop and read detection results before changing `build_env_dict`.

If the build log shows a timeout or connection failure while downloading an external artifact, first classify whether the issue is reachability rather than build configuration. Use `external artifact unreachable` when the dominant failing object is a registry layer, GitHub Release asset, native binary package, package tarball, or installer binary.

## Current MCP-Facing Build Keys

Use these as candidate keys for `build_env_dict`. They are not all mandatory.

Common:
- `BUILD_TYPE`
- `BUILD_NO_CACHE`
- `BUILD_PROCFILE`

Node.js / static frontend:
- `CNB_FRAMEWORK`
- `CNB_NODE_VERSION`
- `CNB_NODE_ENV`
- `CNB_BUILD_SCRIPT`
- `CNB_OUTPUT_DIR`
- `CNB_START_SCRIPT`
- `CNB_PACKAGE_TOOL`
- `CNB_MIRROR_SOURCE`
- `CNB_MIRROR_NPMRC`
- `CNB_MIRROR_YARNRC`
- `CNB_MIRROR_PNPMRC`

Java:
- `BP_JVM_VERSION`
- `BP_JVM_TYPE`
- `BP_MAVEN_SETTINGS_PATH`
- `BP_MAVEN_BUILD_ARGUMENTS`
- `BP_MAVEN_ADDITIONAL_BUILD_ARGUMENTS`
- `BP_MAVEN_BUILT_MODULE`
- `BP_MAVEN_BUILT_ARTIFACT`
- `BP_GRADLE_BUILD_ARGUMENTS`
- `BP_GRADLE_ADDITIONAL_BUILD_ARGUMENTS`
- `BUILD_MAVEN_SETTING_NAME`

Python:
- `BP_CPYTHON_VERSION`
- `BUILD_PIP_INDEX_URL`
- `BUILD_PIP_TRUSTED_HOST`
- `BUILD_CONDA_SOLVER`
- `BUILD_PROCFILE`
- `BUILD_DISABLE_COLLECTSTATIC`

Golang:
- `BP_GO_VERSION`
- `GOPROXY`
- `GOPRIVATE`
- `BP_GO_TARGETS`
- `BP_GO_BUILD_FLAGS`
- `BP_GO_BUILD_LDFLAGS`
- `BUILD_PROCFILE`
- `BUILD_GO_INSTALL_PACKAGE_SPEC`

PHP:
- `BP_PHP_VERSION`
- `BP_COMPOSER_INSTALL_OPTIONS`
- `BP_PHP_WEB_DIR`
- `BUILD_PROCFILE`

.NET:
- `BP_DOTNET_FRAMEWORK_VERSION`
- `BP_DOTNET_PROJECT_PATH`
- `BP_DOTNET_PUBLISH_FLAGS`
- `BUILD_NUGET_CONFIG_NAME`
- `BUILD_PROCFILE`

## Language Notes

Node.js / static frontend:
- start with version, build script, output directory, or startup script only when auto-detection is wrong or the build log points there

Java:
- prefer JVM version plus build-tool arguments only when the build log points to toolchain, module, or artifact selection problems

Python:
- prefer Python version, pip index, Procfile, or `BUILD_DISABLE_COLLECTSTATIC` when Django static collection is the blocker
- do **not** invent a Node-style `CNB_BUILD_SCRIPT` for Python

Golang:
- prefer Go version, proxy/private module settings, or explicit build target/module selection

PHP:
- prefer PHP version, Composer install options, or web root when build/runtime evidence points there

.NET:
- prefer framework version, project path, publish flags, or NuGet configuration when the build log points there

## Do Not Use As Default Build Parameters

These are not safe default recommendations for `build_env_dict`:

- `NODE_OPTIONS`
- `JAVA_TOOL_OPTIONS`
- `BPL_*`
- runtime db connection envs
- runtime port/env wiring such as `PORT`

Do not echo secrets in examples or prose. In particular, never print sample values for `COMPOSER_AUTH`.

## Official Docs To Check When Platform Version Is Uncertain

- `https://www.rainbond.com/docs/how-to-guides/app-deploy/source-code/nodejs`
- `https://www.rainbond.com/docs/how-to-guides/app-deploy/source-code/springboot`
- `https://www.rainbond.com/docs/how-to-guides/app-deploy/source-code/python`
- `https://www.rainbond.com/docs/how-to-guides/app-deploy/source-code/golang`
- `https://www.rainbond.com/docs/how-to-guides/app-deploy/source-code/php`
- `https://www.rainbond.com/docs/how-to-guides/app-deploy/source-code/dotnet`
- `https://www.rainbond.com/docs/how-to-guides/app-deploy/source-code/dockefile`
- `https://www.rainbond.com/docs/how-to-guides/app-deploy/source-code/html`
