# Make-safe PR 349 deployed-loop evidence

**Requested:** deploy merged PR 349 and run `fresh mail -> cron -> rerun -> resend -> rerun` against the deployed function while production remains `legacy`.  
**Result:** deployment passed; the full write/resume loop is blocked by the deployed action contract while mode remains `legacy`.

## Deployment

The canonical release worktree was fast-forwarded to merged main commit `c283b6a6241828e915fe0538be36fb00ed7f85f9` and deployed through `scripts/deploy-edge-function.sh`.

- deployed `ops-api` version: 842
- `ops_api_version.commit_sha`: `c283b6a6241828e915fe0538be36fb00ed7f85f9`
- `verify_jwt`: false
- guarded smoke: 9 passed, 0 failed
- deployed at: `2026-07-21T08:14:36Z`

## Why the full loop cannot run under `legacy`

The production `scan_ses_makesafes` action reads `makesafe_cron_settings.intake_mode` and enters exactly one branch. With `intake_mode=legacy`, calling it runs the legacy/model scanner, not the deterministic runtime.

The only deployed deterministic actions available while the switch remains `legacy` are:

- `makesafe_deterministic_intake_replay`, always dry-run
- `makesafe_deterministic_intake_dark_observe`, exact and sanitized but always dry-run

Neither action creates the first canonical case/source row. The persisted-source authority fixed by PR 347 and PR 349 only exists after that first live persistence. Therefore a dry observation cannot execute or prove the required production lifecycle of first write, immediate inert rerun, later source enrichment, and final inert rerun.

There is no deployed isolated-loop action, staging database, request-scoped mode override, or transaction-scoped test namespace. Flipping the global switch, bypassing `scan_ses_makesafes` with local service-role code, or writing synthetic production email/case rows would violate the instruction that production remain on `legacy`.

## Safe deployed proof completed

The prior real source that triggered `lineage_parent_unselected` was observed twice through the deployed PR 349 function.

Pass 1:

- one selected review-exception case, four correlated sources
- `adapter_parse_failure`, missing `client_name`
- `parent_relation=null`, proving fresh sibling normalisation is deployed
- zero AI calls and zero write failures
- case hash `380560e9...dea5118`

Immediate dry rerun:

- same outcome, source count and root relation
- zero AI calls and zero write failures
- case hash changed to `cd261c3d...d09ec` as the observe cursor moved

The hash change is expected without first-pass persistence: dark observe has no canonical row to provide persisted-source authority. It demonstrates why this two-pass dry proof cannot be represented as the requested convergence result. A resend stage would not repair that missing persistence and was not fabricated.

## Production safety state

Production remained `legacy` throughout. Post-probe counts remain unchanged:

- canonical cases: 1
- canonical source rows: 4
- artifacts: 2
- deterministic drafts: 1, pre-existing
- canonical cases with jobs: 0

No activation, case/source/draft/job write, backfill, communication, invoice or money action occurred.

## Required decision

The full deployed loop needs one of these separately authorised test surfaces:

1. an isolated deployed probe backed by dedicated test tables/database, or
2. a controlled exact-source deterministic window that permits the first canonical persistence.

Until firstmate selects one, the deployed-loop gate is **not proved** and activation must remain blocked.

## Evidence files

- `docs/evidence/makesafe-pr349-deployed-loop-deploy-2026-07-21.json`
- `docs/evidence/makesafe-pr349-deployed-loop-observe-1-2026-07-21.json`
- `docs/evidence/makesafe-pr349-deployed-loop-observe-2-2026-07-21.json`
- `docs/evidence/makesafe-pr349-deployed-loop-post-probe-state-2026-07-21.json`
