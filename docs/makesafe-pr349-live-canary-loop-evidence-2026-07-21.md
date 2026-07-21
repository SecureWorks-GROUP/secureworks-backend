# Make-safe PR 349 live allowlist-canary evidence

**Authority:** firstmate approved one exact-source deterministic canary with immediate reversal on any degradation.  
**Requested loop:** `fresh -> cron -> rerun -> resend -> rerun`  
**Outcome:** first cron degraded at canonical case insertion; reversal executed immediately.

## Preconditions

- deployed `ops-api`: version 842, merged commit `c283b6a6241828e915fe0538be36fb00ed7f85f9`
- guarded deploy smoke: 9 passed, 0 failed
- deterministic preflight: 4 passed, 0 failed
- authenticated alarm proof refreshed
- selected authority: one exact real source only
- case cap: 1
- instruction allowlist: empty
- starting mode: `legacy`

## Canary activation

At `2026-07-21 08:20:04 UTC`, exactly one settings row changed to:

- `intake_mode=deterministic`
- `deterministic_max_cases_per_run=1`
- source allowlist count: 1
- instruction allowlist count: 0

## First cron result

The deployed deterministic branch selected one review-exception case with four correlated sources and reached 100% instruction identity. It remained an `adapter_parse_failure` path, with no AI fallback.

The first persistence attempt failed:

- `write_failure_reasons.case_insert: 1`
- `cases_attempted: 1`
- `cases_failed: 1`
- case rows created: 0
- source rows created: 0
- drafts created: 0
- jobs created: 0
- AI calls: 0

Because the first cron degraded, the immediate rerun, resend and final rerun stages were not attempted. Continuing would have violated the approved reversal rule and could not produce valid convergence evidence.

## Immediate reversal

At `08:20:24 UTC`, the documented one-switch reversal changed exactly one row back to `legacy`.

After in-flight work settled, production matched the pre-canary baseline:

- effective mode: `legacy`
- canonical cases: 1
- canonical sources: 4
- artifacts: 2
- deterministic drafts: 1, pre-existing
- canonical cases with jobs: 0
- failed deterministic model calls: 0

Health truthfully records `deterministic_write_failure`. No case, source, artifact, draft, job, communication, invoice, allocation or money action was created by the canary.

## Gate result

The deployed live-shaped loop is **not proved**. Source widening and deterministic reactivation remain blocked pending diagnosis and remediation of the production `case_insert` failure.

## Evidence files

- `docs/evidence/makesafe-pr349-deployed-loop-deploy-2026-07-21.json`
- `docs/evidence/makesafe-pr349-canary-switch-2026-07-21.json`
- `docs/evidence/makesafe-pr349-canary-first-cron-2026-07-21.json`
- `docs/evidence/makesafe-pr349-canary-rollback-2026-07-21.json`
- `docs/evidence/makesafe-pr349-canary-post-rollback-state-2026-07-21.json`
