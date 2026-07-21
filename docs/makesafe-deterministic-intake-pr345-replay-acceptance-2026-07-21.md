# Make-safe deterministic intake PR 345 replay acceptance

**Run date:** 2026-07-21  
**Current main and deployed commit:** `c5fef319092ab5fc7c2f2fdde4fa523f3caf154e`  
**Production function:** `ops-api` v835, `verify_jwt=false`  
**Activation:** unchanged at `legacy`

## Dark redeploy

The authorized release worktree was updated to current `origin/main`. The deterministic intake suite passed 116 tests with zero failures. `ops-api` was deployed through `scripts/deploy-edge-function.sh`, including `--no-verify-jwt`, and the guarded post-deploy smoke passed 9/9.

## Clean replay acceptance

The clean acceptance run used the runbook's bounded option:

```text
GET /ops-api?action=makesafe_deterministic_intake_replay&days=30&only_unscanned=true&max_sources=2000
```

Result:

| Gate | Result |
|---|---:|
| Identity floor | **97.53%** |
| Identity reached | 158 / 162 known-builder candidates |
| MLB identity | 143 / 147 |
| AJS/AJBR identity | 15 / 15 |
| Sources | 789 |
| Planned canonical cases | 502 |
| Unaccounted | **0** |
| Zero-unaccounted proved | **true** |
| Source accounting complete | **true** |
| Cap reached | **false** |
| Cursor at / next cursor | `null` / `null` |
| Caveats | none |
| AI calls | **0** |
| Case/source/draft/job writes | **0 / 0 / 0 / 0** |
| Write failures | **0** |

This passes the runbook acceptance bar of identity floor at or above 95%, zero unaccounted sources, no cap caveat, complete accounting in one response, zero model calls, and zero business writes.

The 60-day bounded attempt also measured 97.69% identity and zero unaccounted across 1,313 represented sources, but started from an existing observe cursor and correctly reported `source_sweep_partial`. A 45-day head run contained 1,024 sources, filled the 1,000-row sweep half of the 2,000-row budget, and correctly reported `source_read_capped`. The window was narrowed to 30 days only to satisfy the runbook's one-response completeness requirement, not to tune the identity result.

## Post-observe state

Fresh DB verification confirms:

- `intake_mode = legacy`
- deterministic cap remains 1
- both exact allowlists remain empty
- mode change timestamp remains null
- canonical cases, sources, events, artifacts, and deterministic drafts remain zero
- live scan cursor remains null
- observe cursor returned to null after the clean complete sweep
- all four SQL preflight checks pass

No activation, backfill, live scan, alarm drill, N=1 business processing, or rollback action was performed.

## Evidence

- Clean acceptance: `docs/evidence/makesafe-deterministic-intake-replay-2026-07-21-pr345-clean-30d.json`
- 60-day partial attempt: `docs/evidence/makesafe-deterministic-intake-replay-2026-07-21-pr345-60d-attempt.json`
- 45-day capped attempt: `docs/evidence/makesafe-deterministic-intake-replay-2026-07-21-pr345-45d-capped.json`
- 30-day cursor reset: `docs/evidence/makesafe-deterministic-intake-replay-2026-07-21-pr345-30d-reset.json`
- Post-observe DB state: `docs/evidence/makesafe-deterministic-intake-pr345-post-observe-db-state-2026-07-21.json`
- Fresh preflight: `docs/evidence/makesafe-deterministic-intake-pr345-preflight-2026-07-21.json`

This closes the replay identity, source-accounting completeness, cap-caveat, and source-identifier response defects recorded in the earlier gate report. All separately Marnin-gated activation approvals remain open.
