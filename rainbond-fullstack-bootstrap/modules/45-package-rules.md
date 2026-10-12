# Package-backed component rules

## Package-backed Components

For v2-style package components:
- `source.kind = package` means the component should be created through the Rainbond package-upload flow
- map:
  - `source.local_path` -> input read by the local upload helper only
  - `source.archive_name` -> optional zip filename when `local_path` is a directory

### Client Upload Contract

Package bytes live on the client machine. The local helper is the only process allowed to resolve, read, archive, or upload the local source. Never pass `source.local_path` to a Rainbond Tool.

Follow this transaction in the exact order below. Before initialization, query the target app and decide whether the
logical component is missing or already exists. A package update must keep the same `service_id`; a new upload event is
not evidence that a new component is required.

1. Run `upload_local_package.py prepare` locally:
   - resolve `source.local_path` relative to the current project directory unless it is already absolute
   - use a workspace-local staging root such as `.rainbond/staging/<component>/`; never stage under `/tmp`
   - pass `source.archive_name` only when supplied
   - capture the helper's `archive_path`, `file_name`, `generated`, and `staging_root` result fields
   - a supported package file is reused directly; a directory is converted to a zip archive by the helper
2. Call `rainbond_init_package_upload` with Rainbond context only. For an existing component, pass its verified
   `service_id` as `component_id`; for a missing component, omit `component_id`. It must return a non-empty `event_id`
   and an `upload_request`. Do not continue when either is absent or malformed.
3. Run the exact `input_commands.package_upload.argv` from the active Skill Runtime Contract, passing the complete `upload_request` object through stdin as JSON. 不得替换为 runtime launcher，也不得省略或改写 argv：
   - the CLI resolves the Console origin from the protected single-runtime store; never ask the user for `RAINBOND_URL` and never take it from the current shell
   - do not add `RAINBOND_URL`, JWT, upload credentials, or a Console address to argv or stdin
   - do not invent or rewrite the URL, authorization mode, form field, HTTP method, content type, or timeout; the CLI validates the same-Console-origin upload contract before invoking the local helper
4. Run `upload_local_package.py cleanup` immediately after the HTTP attempt returns, whether upload succeeded, failed, or timed out. Pass the captured `archive_path`, `staging_root`, and `generated` flag. This cleanup must finish or be reported before any upload-status or component-create call.
5. If and only if the HTTP upload succeeded, call `rainbond_get_package_upload_status(event_id=...)`. The returned uploaded-file status must be non-empty and must identify at least one uploaded file.
6. If and only if status is non-empty, continue through exactly one of the two branches below. Package creation and
   replacement are event-based; no local filesystem path belongs in either call.

### First deployment

When no matching runtime component exists, call `rainbond_create_component_from_package(event_id=...)`. Record the
returned `service_id` in the local runtime binding and use it for every later mutation.

### Existing component update

When a matching package-backed component already exists:

1. Call `rainbond_init_package_upload` with the verified existing `service_id` as `component_id`.
2. Complete the same client upload and local cleanup steps above.
3. Require a non-empty result from `rainbond_get_package_upload_status`.
4. Call `rainbond_replace_component_package` with the same `service_id`, the new upload `event_id`, and the previously
   observed package event as `expected_current_event_id` when it is available.
5. Record the returned build `event_id`, then call `rainbond_wait_for_build_completion(timeout=60)` once in the current turn. If it returns `status=running`, end the current turn immediately with completed actions and current state；不得再次等待、手工轮询或继续轮询。A later explicit user “继续” starts a new bounded check.
6. Verify the component health overview after the build and rolling upgrade converge.

Do not call `rainbond_create_component_from_package` for an existing logical component, do not invent a versioned
`service_cname` or `k8s_component_name`, and do not use blue/green creation merely because a new package was uploaded.
If the current component is not package-backed, stop and ask for an explicit build-source migration decision instead of
silently replacing or recreating it.

The helper command is used directly only for `prepare` and `cleanup`: `python3 rainbond-fullstack-bootstrap/scripts/upload_local_package.py <prepare|cleanup> ...`. The HTTP upload must use the protected local CLI `package-upload` command. Preserve JSON result fields exactly between phases; do not reconstruct paths or upload parameters from memory.

### Cleanup and Stop Rules

- prepare failure -> stop before initialization; there is no upload event to delete
- initialization failure or a response without a complete `event_id` / `upload_request` -> run local helper cleanup using the prepare result, then stop
- HTTP upload failure or timeout -> run local helper cleanup first, then call `rainbond_delete_package_upload(event_id=...)`, then stop; never query status or create a component
- empty uploaded-file status -> call `rainbond_delete_package_upload(event_id=...)` and stop; never create a component from an empty event
- if remote deletion also fails, report both the original failure and the deletion failure; do not continue to create
- a create-by-event or replace-by-event failure does not justify exposing `source.local_path` to a platform Tool or switching delivery mode; stop with the event evidence and apply the normal attempt budget
- a `package source changed concurrently` response means the component changed after the last read; query it again and
  stop for reconciliation rather than overriding the newer event

### Compatibility Boundary

The legacy server-local tools `rainbond_upload_package_file` and `rainbond_create_component_from_local_package` remain compatibility-only server interfaces. They are not RainSkills execution options because their filesystem view is the platform server's, not the user's client workspace. RainSkills always uses the local helper plus the event-based Rainbond Tool sequence above.

If `source.local_path` cannot be resolved safely:
- mark the package component as `needs-confirmation`
- do not guess a different path

If the local helper reports that the path does not exist or is unsafe:
- resolve the path once from the current project process and correct only an objective relative-path resolution error
- otherwise classify the issue as a local package preparation blocker and stop
- do not pivot to local Docker, image push, or a server-local compatibility tool without explicit user confirmation
