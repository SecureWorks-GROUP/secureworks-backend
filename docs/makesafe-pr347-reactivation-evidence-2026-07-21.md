# Make-safe PR 347 reactivation evidence

**Captain order:** deploy merged PR 347, re-enable one-source deterministic intake, verify the next real mail and rerun convergence, and reverse immediately on degradation.  
**Outcome:** deployment passed; first live scan failed closed; documented reversal executed.

## Deployment

The canonical release worktree was fast-forwarded to merged `main` commit `e9652e24226f76685a5cea0c5374c5b389ceb757`. `ops-api` was deployed through `scripts/deploy-edge-function.sh` with `verify_jwt=false`.

- production function version: 838
- release commit: `e9652e24`
- guarded smoke: 9 passed, 0 failed
- preflight: 4 passed, 0 failed
- alarm authentication refreshed and `alarm_readiness.ready=true`

## Selected real mail

The newest eligible real SES candidate after the prior reversal was received at `2026-07-21 07:21:39 UTC` from `primeeco.tech`. It had one uploaded PDF with a work-order filename hint.

The exact-source dark observe resolved one canonical case with four correlated sources, 100% instruction identity and zero AI or business writes. It proposed an MLB `adapter_parse_failure` review exception missing `client_name`, with `parent_relation=sibling_of`.

## Activation and first scan

At `07:38:49 UTC`, exactly one settings row changed:

- mode: `legacy` to `deterministic`
- maximum cases per run: 1
- exact source allowlist: 1 selected real source
- instruction allowlist: empty

The first live scan selected the same one case and four correlated sources but the new pre-write dependency guard found that its computed sibling parent was neither persisted nor included in the exact authorised plan.

Result:

- `write_failure_reasons.lineage_parent_unselected: 1`
- `cases_attempted: 0`
- case rows created: 0
- source rows created: 0
- drafts created: 0
- jobs created: 0
- AI calls: 0
- outbound or financial effects: 0

This is the intended fail-closed behaviour of PR 347, but it means the selected mail did not process end to end and the activation gate degraded. The rerun convergence check was not attempted after a failed first run.

## Immediate reversal

The documented one-switch reversal changed exactly one row back to `legacy` at `07:39:12 UTC`.

After allowing in-flight work to settle, production counts exactly matched the pre-activation baseline:

- canonical cases: 1
- canonical source rows: 4
- case events: 1
- artifacts: 2
- deterministic drafts: 1, unapproved and pre-existing
- canonical cases with jobs: 0
- model calls in the failed deterministic scan: 0

Effective mode is `legacy`. Health truthfully retains `deterministic_write_failure` until a later health update. No backfill, allocation, invoice, client communication or money action occurred.

## Evidence files

- `docs/evidence/makesafe-reactivation-deploy-2026-07-21.json`
- `docs/evidence/makesafe-reactivation-preflight-state-2026-07-21.json`
- `docs/evidence/makesafe-reactivation-alarm-readiness-2026-07-21.json`
- `docs/evidence/makesafe-reactivation-selected-mail-2026-07-21.json`
- `docs/evidence/makesafe-reactivation-dark-observe-2026-07-21.json`
- `docs/evidence/makesafe-reactivation-switch-2026-07-21.json`
- `docs/evidence/makesafe-reactivation-first-scan-2026-07-21.json`
- `docs/evidence/makesafe-reactivation-rollback-2026-07-21.json`
- `docs/evidence/makesafe-reactivation-post-rollback-state-2026-07-21.json`
