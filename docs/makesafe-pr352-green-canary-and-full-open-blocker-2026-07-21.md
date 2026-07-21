# PR 352 green N=1 canary and full-open blocker

## Deployment

- canonical commit: `99d80345ceec94026c5f3d4f3bfa54048cea686b`
- production `ops-api`: version 851
- active-key guarded smoke: 9/9
- deterministic preflight: 4/4
- alarm readiness: true

## N=1 result

The existing exact source was run through two manual and two scheduled deterministic scans.

Every observed scan produced:

- zero case rows
- zero source rows
- zero artifacts
- zero drafts
- zero jobs
- zero write failures
- zero model calls

The target remained a cycle-1 root `adapter_parse_failure` exception with null canonical client identity. Global counts remained exactly stable at 2 cases, 8 sources, 4 artifacts, 2 deterministic drafts and zero canonical jobs.

The persist-before-validation remediation is therefore green against the production shape that failed PR 351.

## Why widening stopped

The deployed contract has no full-open deterministic selection mode:

- live deterministic mode requires a non-empty exact source/instruction allowlist
- both allowlists are capped at 50 entries
- empty allowlists fail closed
- no production process rotates future incoming mail into the allowlists

Leaving the settled N=1 source configured would silently prevent all future mail from entering intake. Emptying the lists would intentionally fail every deterministic scan. A finite current-source batch is not full live.

The switch was therefore returned to `legacy` at `2026-07-21 11:04:03.812191 UTC`. No widening was attempted.

## Evidence

- `docs/evidence/makesafe-pr352-canary-baseline-2026-07-21.json`
- `docs/evidence/makesafe-pr352-canary-switch-2026-07-21.json`
- `docs/evidence/makesafe-pr352-canary-manual-2026-07-21.json`
- `docs/evidence/makesafe-pr352-canary-final-rerun-2026-07-21.json`
- `docs/evidence/makesafe-pr352-canary-comparison-2026-07-21.json`
- `docs/evidence/makesafe-pr352-full-live-contract-blocker-2026-07-21.json`
- `docs/evidence/makesafe-pr352-canary-rollback-2026-07-21.json`
- `docs/evidence/makesafe-pr352-canary-post-rollback-2026-07-21.json`
