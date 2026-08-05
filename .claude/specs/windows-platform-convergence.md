# Windows Platform Convergence Execution Spec

Design: `docs/superpowers/specs/2026-08-05-windows-platform-convergence-design.md`

## Commit 1: `fix: converge existing Windows platforms safely`

1. Version recovery bundles by npm package version and upgrade the complete protected machine manifest, not only helper/bootstrap hashes.
2. Add one fixed, idempotent `ConvergeInstalledPlatform` PowerShell action and matching Node adapter method.
3. During legacy migration, rewrite current network helper/systemd contracts, reconcile owned Windows network/tasks, start stopped Docker/Rainbond only when necessary, and never import/reinstall/remove existing Rainbond.
4. Replace Docker/containerd `Requires=rainskills-network-ready.service` with non-propagating `Wants` plus `After` ordering.

## Commit 2: `fix: verify Windows stability before authorization`

1. Route every local-Windows `platform-ready` and `authorizing` entry through convergence before browser authorization.
2. Require three successful readiness samples five seconds apart with unchanged outer-container `StartedAt`; retry at most three rounds within 120 seconds.
3. Require a final Device Flow `2xx` response with the existing JSON contract, without persisting or logging generated codes.
4. Surface deterministic layer/error codes, finalize one-time recovery tasks after later successful resume, update acceptance documentation, and bump rc.41 metadata.

## Mandatory Verification

```text
npm run test:platform
npm run test:windows
npm test
npm pack --dry-run
npm publish --dry-run --access public --tag next
```

GitHub Windows CI must pass PowerShell parsing and `tests/windows-contract.ps1` before the user publishes. Real `npm publish` is explicitly excluded.
