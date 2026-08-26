# Repairs-board stage backfill — dry run first

`scripts/backfill-repair-stage.sql` gives the existing repair cards a persisted
`metadata.repair_stage` so they keep their column once a stamped stage becomes
authoritative. It is **additive metadata only**.

It is not wired into CI, not wired into any deploy workflow, and not applied by
`scripts/apply-pending-migrations.sh`. Somebody runs it by hand, on purpose,
after reading the dry run.

## What it will and will not touch

| | |
|---|---|
| Writes | `jobs.metadata.repair_stage`, `jobs.metadata.repair_stage_source` |
| Never writes | `jobs.type`, `jobs.job_number`, `jobs.status`, any `ses_money_seal_*` column, any `makesafe_job_details` column |
| Selects | only rows carrying `metadata.makesafe_job_family='repair'`, `metadata.ses_family='repair'`, or `makesafe_job_details.report_type='repair'` |
| Never selects | anything matched by prose. The text-sweep candidates are human-gated — see `docs/repair-backfill-review-2026-08-26.md` |
| Skips | any row that already has a `repair_stage`, so an operator's own drag can never be overwritten by a re-run |

## Expected scope

As at 2026-08-26 the deterministic marker set is **three jobs**, all
`status='processing'`, all SES-money-sealed:

| job_number | suburb | marker |
|---|---|---|
| SWMS-261029 | Midland | `metadata.makesafe_job_family='repair'` |
| SWMS-261163 | Falcon | `metadata.ses_family='repair'` + `report_type='repair'` |
| SWMS-261192 | Boddington | `metadata.ses_family='repair'` + `report_type='repair'` |

All three derive `on_site` (the board already shows them there, because
`processing` maps to `on_site`). So a correct run moves **no card at all** —
it converts three derivations into three facts. If the dry run shows a card
changing column, stop and ask why.

The selection is a live query, not a hard-coded id list, so any repair job minted
between now and the run is picked up automatically. A job minted through the new
repair route already carries `repair_stage='wo_in'` from birth and is therefore
skipped.

## Running it

```sh
# 1. DRY RUN. Read the two result sets. Nothing is written.
psql "$DATABASE_URL" -f scripts/backfill-repair-stage.sql
```

The file ends its APPLY block with `ROLLBACK;` on purpose. Reading the dry run
and then deciding to apply means editing the file to swap `ROLLBACK;` for
`COMMIT;` — a deliberate two-character act, recorded in the shell history of
whoever did it.

Keep the dry-run output and the applied output with the PR. The house pattern
for this is `scripts/ses-c3-wo-backfill-v1.dry-run.json` /
`.apply-ledger.json` / `.verify.json`.

## Verification after applying

```sql
SELECT job_number, status, metadata->>'repair_stage', metadata->>'repair_stage_source'
FROM public.jobs
WHERE metadata ? 'repair_stage'
ORDER BY job_number;
```

Every value must be one of the nine board stages. The APPLY block asserts this
itself and rolls back if it is not true, but check it anyway.
