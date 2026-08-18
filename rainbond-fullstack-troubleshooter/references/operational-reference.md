# Troubleshooter operational reference

Load this reference only when reviewing a proposed diagnosis or a completed troubleshooting run.

## Common Mistakes

- fixing frontend first when the real issue is `api -> db`
- editing envs before checking dependency
- editing env to fix a connection/startup value without first checking for a mounted config-file volume that overrides the same key
- claiming recovery without re-reading logs
- treating component summary as Pod-level root-cause evidence
- assuming `rainbond_get_pod_detail` returns `data.bean`
- continuing to modify the app after it is already `runtime_healthy`
- using guessed db values instead of values derived from current component configuration
- pretending `runtime_healthy` means delivery is complete
- continuing application repair when the real blocker is cluster scheduling capacity or code/build failure
- repeating the same repair pattern more than once against the same blocker bucket in one run
- reading runtime logs first for a source build failure instead of checking component events and build logs
- skipping Pod detail for `ImagePullBackOff`, `ErrImagePull`, `ContainersNotInitialized`, init-container failures, or similar startup blockers
- stuffing source build parameters into `build_info` instead of `replace_build_envs`
- defaulting to Dockerfile or CNB based on file presence alone without applying the Build Mode Selection priority chain (manifest `source.build.strategy` → heuristic by Dockerfile classification + intent signals → ask only when ambiguous); see `rainbond-fullstack-bootstrap/references/source-build-parameter-guide.md`
- promising `dockerfile_path` support when the current Rainbond Tool surface only exposes `prefer_dockerfile_when_detected`

## Quick Reference

Source resolution summary:
- target app identity: explicit input > `.rainbond/local.json` > baseline project hints
- selected reference environment: explicit input > local default > `preview`
- expected secret and env intent: explicit input > secret file reference > env file reference > baseline env hints
- runtime truth: the locked Rainbond transport only
- if files disagree with platform responses, trust the locked Rainbond transport and report drift

Preferred diagnostic branches:

Runtime-unhealthy branch:
1. app detail
2. component list
3. target component summary
4. `rainbond_get_component_pods` when the component is not `running` or summary/logs do not explain startup failure
5. `rainbond_get_pod_detail` for the selected Pod
6. container logs only if Pod detail still lacks enough context

Source-build branch:
1. target component summary
2. component events
3. build logs for the failing `event_id`
4. runtime logs only if build evidence no longer explains the problem

Verification tail:
1. db summary
2. `api` summary again
3. build logs or runtime logs again, depending on the blocker class

Preferred repair order:
1. dependency
2. inner port
3. compatibility envs
4. wrong-value correction
5. restart or deploy

Primary stop conditions:
- source build still running
- source build failed
- external artifact unreachable
- cluster capacity blocked
- frontend access-path issue
- topology unexpectedly missing

Symptom-to-branch lookup:
- pod `FailedMount` with `configmap ... not found` → Rule J (`config_file_configmap_missing`)

