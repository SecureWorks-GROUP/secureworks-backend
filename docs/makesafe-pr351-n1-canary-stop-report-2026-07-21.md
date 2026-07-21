# PR 351 exact N=1 canary stop report

## Authority and deployed source

The explained smoke-credential anomaly was closed by firstmate. All subsequent API calls used the active production client credential.

- deployed `ops-api`: version 848
- exact deployed commit: `5ce103e6aed938ad6139e23f750fefa438e049f8`
- guarded smoke: 9/9
- deterministic preflight: 4/4
- fresh authenticated alarm readiness: true
- starting mode: `legacy`
- exact source allowlist count: 1
- case cap: 1
- instruction allowlist count: 0

## Activation and first response

Exactly one settings row changed to deterministic at `2026-07-21 10:02:45.697835 UTC`.

The manually invoked first deterministic scan returned green at `10:02:53.621 UTC`:

- one selected case and four correlated sources
- 100% canonical instruction identity
- root persisted at cycle 1 with a matching `/cycle:1` instruction key
- parent key and relation null
- one case row and four source rows created
- zero response-reported drafts or jobs
- zero response-reported write failures
- zero AI calls
- `adapter_parse_failure`, missing `client_name`

The response remained sweep-capped, so it did not claim complete 60-day source accounting. This was known and could not support widening by itself.

## New anomaly

A second production invocation began about seven seconds after the first insert, consistent with the scheduled intake invocation overlapping the controlled manual canary window.

Production logs show that invocation:

1. found the persisted source authority
2. hit four expected source-junction uniqueness conflicts
3. created two target artifacts
4. created a target deterministic draft at `2026-07-21 10:03:05.319375 UTC`

The target case remained a suppressed `adapter_parse_failure` exception with no job, while the new draft was `needs_review`, had no approved job and reported no missing fields. This contradicted both the manually observed first response (`drafts_created=0`) and the required inert-rerun convergence shape.

This is a new canary anomaly. The second invocation's business writes are persisted append-only evidence:

- target artifacts: 2
- target deterministic drafts: 1
- jobs: 0
- communications/invoices/allocations: none initiated by the deterministic runtime

## Immediate reversal

The documented one-switch rollback changed exactly one row to `legacy` at `2026-07-21 10:03:51.077064 UTC`.

No controlled rerun, resend, final rerun or widening was attempted after the anomaly.

Current canonical counts are:

- cases: 2
- sources: 8
- artifacts: 4
- deterministic drafts: 2
- canonical cases with jobs: 0

The health row was subsequently overwritten by the resumed legacy cron at `10:05:11 UTC`; its one model call occurred after rollback in legacy mode, not in the captured deterministic first response. The authority switch itself remains `legacy`.

## Gate result

The cycle-1 insert fix is proved in production. Full convergence is not proved. The scheduled overlap exposed a new persisted-rerun divergence, so widening remains blocked.

Before any new attempt, diagnose why a subsequent deterministic invocation promoted recovery far enough to create artifacts and a draft while the canonical case remained an `adapter_parse_failure` exception, and ensure the canary window cannot overlap an uncontrolled cron invocation.

## Evidence

- `docs/evidence/makesafe-pr351-canary-switch-2026-07-21.json`
- `docs/evidence/makesafe-pr351-canary-first-cron-2026-07-21.json`
- `docs/evidence/makesafe-pr351-canary-write-timeline-2026-07-21.json`
- `docs/evidence/makesafe-pr351-canary-rollback-2026-07-21.json`
- `docs/evidence/makesafe-pr351-canary-post-rollback-state-2026-07-21.json`
