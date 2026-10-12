# Skill performance benchmarks

Phase 0 separates repository diagnostics from real Codex host telemetry. Bytes are never reported as Token counts, and fixture-only host runs are never presented as controlled deployment evidence.

## Effect corpus

`tests/effect-evals/cases/` is the only source for the 28 global smoke cases. Validate it with:

```bash
node scripts/validate-effect-evals.mjs
```

Each case pins its prompt, fixture, and complete content with SHA-256 and declares initial ownership, allowed/forbidden handoffs, behavior expectations, and safety assertions. The corpus is excluded from the npm package.

## Repository layer

Run the eight deterministic scenarios without a model or live Rainbond environment:

```bash
node scripts/run-skill-performance-benchmark.mjs \
  --output /tmp/rainskills-repository-benchmark.json
```

This layer records UTF-8 Markdown bytes and fixture-backed mock trace counts for CLI invocations, backend requests, retries, polls, stdout, stderr, and transport. Its Token and model-timing fields are always `unavailable`.

## Codex host layer

The host runner uses async `codex exec --json --ephemeral`, a fresh temporary workspace, an isolated `.codex/skills` candidate bundle, stdin disabled, a fixed model/reasoning pair, monotonic event-arrival timestamps, and restricted 0600 artifacts.

Without an explicitly controlled Rainbond environment, reset, and cleanup mechanism, write scenarios remain `unavailable`. A safe fixture-only smoke run is available for validating the measurement pipeline, but is marked `control_status=uncontrolled`:

```bash
node scripts/run-codex-host-evals.mjs \
  --fixture-only \
  --model gpt-5.6-sol \
  --reasoning-effort high \
  --repetitions 1 \
  --primary-repetitions 3 \
  --artifact-root /tmp/rainskills-host-artifacts \
  --output /tmp/rainskills-host-baseline.json
```

The runner records raw JSONL structure with local monotonic timestamps and redacts credential-shaped text before saving stdout/stderr. `turn.completed.usage` is the only Codex Token source. Missing usage, compaction, tool spans, platform version, or external-wait attribution stays `unavailable`.

## Paired AB/BA host comparison

`run-codex-host-abba.mjs` compares two clean, detached source worktrees with the same provider-aware host runner. It uses a deterministic seed, incrementally checkpoints every run, resumes only a matching experiment, and reports pairwise relative changes plus separate AB and BA medians. The default protocol runs 20 primary pairs (10 AB and 10 BA) and one exploratory pair for each remaining scenario.

Every session receives an isolated `HOME` and `CODEX_HOME`, only the protected Codex auth file, disabled plugins, and one repository-scoped `.codex/skills` bundle. This prevents user-scoped Skills from contaminating the base/candidate comparison.

Fixture-only paired runs remain uncontrolled observations: they do not call Rainbond or exercise protected tool aggregation. Controlled live runs additionally require an explicitly disposable Rainbond team/app namespace, exact-name reset and cleanup, environment-only credentials, and successful post-run absence checks. Do not present a one-pair live pilot as a formal 20-pair performance claim.

## Result storage

Write benchmark output and raw host artifacts outside the repository, for example under `/tmp/rainskills-benchmarks/`. Commit only a concise release-candidate report when a result must be reviewed or published; do not commit per-run JSONL, stderr, normalized records, or historical score artifacts.

## Interpretation boundary

- Cached input is already included in input tokens.
- Reasoning output is already included in output tokens.
- Fresh Codex tasks do not imply an empty provider cache.
- Fixture-only host runs do not prove real Rainbond delivery behavior.
- Formal Performance Track decisions require a clean frozen base SHA, controlled fresh-session A/B data, preregistered treatment and minimum effect, deterministic guardrails, and the required human checkpoint.
