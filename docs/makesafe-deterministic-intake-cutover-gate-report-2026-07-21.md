# Make-safe deterministic intake cutover gate report

**Observed:** 2026-07-21 AWST  
**Current main:** `d3377d1e0335010cb4e774495d224c1e52bd2b5d`  
**Production function:** `ops-api` v830, `verify_jwt=false`  
**Activation:** **NO-GO. Still `legacy`. No backfill performed.**

## Dark deploy completed

The four runbook migrations were applied in order through the Supabase Management API:

1. `20260717000001_jobs_quoted_value_generated.sql`
2. `20260720000001_makesafe_intake_cases.sql`
3. `20260720000002_makesafe_deterministic_intake_cutover.sql`
4. `20260721000001_makesafe_intake_production_controls.sql`

The SQL was applied directly because live migration history has substantial drift and `supabase db push --dry-run` refused to proceed. No migration-history repair was attempted.

`ops-api` was first deployed dark at intake commit `5967104`, then redeployed from current main `d3377d1` after the canonical Board/Hugo read model merged. The guarded production smoke passed 9/9. The live version endpoint reports `d3377d1` and `verify_jwt=false`.

The production switch remained untouched:

- `intake_mode = legacy`
- deterministic cap = 1
- source allowlist = empty
- instruction allowlist = empty
- `intake_mode_changed_at = null`

The SQL preflight returned true for all four checks. See `docs/evidence/makesafe-deterministic-intake-preflight-2026-07-21.json`.

## Board/Hugo seam

The separately validated read model is now merged and live from PR 344/current main.

Read-model smoke:

- contract `makesafe-board.v1`
- HTTP 200 for the privileged Ops projection
- 361 canonical cards
- parity true
- zero unmapped stages
- Trade projection correctly rejects a master-key call with HTTP 403 and requires a signed-in trade JWT

This proves the shared server feed is live. A Hugo-session UI acceptance remains a supervised human check.

## Dark replay result

### Complete 60-day cursor sweep

Runs 04 through 09 capture one full observe-cursor cycle from `cursor_at=null` back to `next_cursor_at=null`. Every 60-day run reported:

- `dry_run=true`
- `ai_calls=0`
- `totals.unaccounted=0`
- zero cases, case sources, drafts, jobs, or write failures
- `source_read.cap_reached=true`
- `source_read_capped` caveat
- `evidence.zero_unaccounted_proved=false`

These runs prove cursor movement and no business writes, but the runbook expressly disqualifies every one as clean acceptance evidence because each hit the cap.

Evidence: `docs/evidence/makesafe-deterministic-intake-replay-2026-07-21-run-04.json` through `run-09.json`.

### Narrow uncapped replay

The runbook permits narrowing the window when the fixed endpoint cap prevents a clean run. The 14-day run reported:

- `source_read.cap_reached=false`
- `evidence.caveats=[]`
- `evidence.zero_unaccounted_proved=true`
- zero unaccounted sources
- zero AI calls
- zero case, source, draft, job, or write-failure totals
- identity floor **0 / 89 = 0%**, below the required 95%

This is a stop result. No attempt was made to tune, widen, reinterpret, or suppress the shortfall.

Evidence: `docs/evidence/makesafe-deterministic-intake-replay-2026-07-21-clean-window-14d.json`.

### Evidence defects observed

Two response-contract defects must be resolved before replay evidence can support activation:

1. The API returns `source_read.cursor_post_id` and `next_cursor_post_id`, which are source identifiers despite the runbook promise that aggregate replay returns none. Filed JSON replaces those values with `<redacted-source-id>`.
2. The 14-day response claims complete accounting while `backlog_rows` equals its full 250-row backlog budget and `next_cursor_at` is non-null. Because recent/backlog overlap makes the combined raw count less than 500, `cap_reached=false` can be reported before the sweep reaches the end. The claimed clean proof is therefore structurally ambiguous even before considering the 0% identity floor.

## No-write verification

After observation:

- canonical cases: 0
- canonical case sources: 0
- canonical case events: 0
- deterministic artifacts: 0
- deterministic drafts: 0
- live scan cursor: null
- only the separately authorized observe cursor moved
- intake mode remains `legacy`

Evidence: `docs/evidence/makesafe-deterministic-intake-post-observe-db-state-2026-07-21.json`.

## SW_API_KEY rotation and client fallout

The Captain-authorized production key rotation completed. The new key is held only in the two authorized mode-600 files. New-key authentication passes and the old embedded key returns HTTP 401.

The old master key is embedded in active client code. Rotation therefore requires a separate remediation decision. Do not commit the new master key into these public/browser files.

Active source files containing the old value:

- current backend repo: `scripts/backfill-fencing-photos.html`, `tools/shared/cloud.js`
- `secureworks-ux`: `ops.html`, `ceo.html`, `trade.html`, `sale-preview.html`, `sale.html`, `shared/cloud.js`, `modules/ops-shared.js`
- `secureworks-ux-mc`: `ops.html`, `ceo.html`, `trade.html`, `sale-preview.html`, `sale.html`, `shared/cloud.js`, `modules/ops-shared.js`
- `secureworks-sale`: `cloud.js`, `sale.html`, `shared/cloud.js`
- `patio-tool`: `index.html`, `tools/shared/cloud.js`, `tools/shared/integration.js`
- `fence-designer`: `cloud.js` and test fixture `tests/cp3-cloud-sync-behavior-harness.js`
- `secureworks-agent`: `migrations/011_sql_bridge.sql`

Live database functions `_sw_api_key` and `send_outlook_email` also contain the old key. No cron command or Vault entry contained it.

Environment/secret consumers that need coordinated rotation include the GitHub Actions `SW_API_KEY` repository secret, Railway `secureworks-agent` `SW_API_KEY`, and local `secureworks-ops` tooling. No other repository or live DB function was edited under this task.

## Gates requiring Marnin

Activation remains blocked. Marnin must provide or supervise:

1. **Identity-floor gate:** reject or accept remediation for the measured 0% result. The runbook requires at least 95%, so activation cannot currently be approved.
2. **Replay completeness gate:** approve a code fix and fresh current-main replay after the cap/completeness and source-id response defects are corrected.
3. **N=1 human comparison:** nominate exactly one approved source ID or instruction key and review the sanitized old/new proposal comparison.
4. **Authenticated alarm drill:** supervise a real authenticated `makesafe_email_canary`, confirm the alarm is received, and verify fresh `alarm_readiness.ready=true`.
5. **G4, G5, G6, G9 and H4 approvals:** explicitly record each named approval. The runbook names these gates but does not define their individual acceptance text in this repository, so Marnin must confirm the authoritative mapping before any activation step.
6. **Hugo live-session acceptance:** sign in as Hugo and confirm the live Trade projection renders the expected all-make-safe board and allocation authority.
7. **Client credential remediation:** choose a secure JWT/scoped-key migration, or explicitly accept emergency re-embedding of the new master key. Re-embedding is not recommended because it immediately republishes the rotated credential.

No activation update, backfill, live-cursor movement, N=1 business processing, alarm drill, or rollback action was performed.
