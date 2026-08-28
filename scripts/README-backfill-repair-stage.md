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
| Scope | every statement is filtered to `org_id = '00000000-0000-0000-0000-000000000001'`, matching every sibling read |
| Leaves behind | **nothing.** The candidate set is a `pg_temp` table created inside the transaction with `ON COMMIT DROP`. There is no view, function or table in `public` at any point, not even mid-run — so the dry-run path, and any mid-run error, leave zero artifacts |

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

The script is a single transaction that ends on `ROLLBACK`, so **running it as
shipped IS the dry run**. It does the real read, performs the real update, prints
exactly which cards it stamped and with what, runs its post-conditions, and then
undoes all of it.

```sh
# DRY RUN. Real read, real write, all rolled back. Nothing persists.
psql "$DATABASE_URL" -f scripts/backfill-repair-stage.sql
```

That is deliberately stronger than a preview: a preview can disagree with the
write it is previewing, whereas this reports the rows the `UPDATE ... RETURNING`
actually produced.

Applying means editing the final `ROLLBACK;` to `COMMIT;` and running it again.
That one-word edit is the approval, and it shows up in whoever's shell history
and in `git diff`.

There is no separate cleanup step to forget: the temp table carries
`ON COMMIT DROP` and dies with the session either way.

Keep the dry-run output and the applied output with the PR. The house pattern
for this is `scripts/ses-c3-wo-backfill-v1.dry-run.json` /
`.apply-ledger.json` / `.verify.json`.

## Verification after applying

```sql
SELECT job_number, status, metadata->>'repair_stage', metadata->>'repair_stage_source'
FROM public.jobs
WHERE org_id = '00000000-0000-0000-0000-000000000001'
  AND metadata ? 'repair_stage'
ORDER BY job_number;
```

Every value must be one of the nine board stages. Step 3 asserts this itself and
aborts the transaction if it is not true, but check it anyway.

And confirm nothing was left in `public`:

```sql
SELECT c.relname, c.relkind
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relname LIKE '%repair_stage_backfill%';
-- expected: 0 rows, on every path
```

## One sentence for the PR

This backfill delivers **zero observable change**. All three cards already show
in On Site because the board derives that from `processing` today; the script
converts three live derivations into three identical facts so the first operator
drag has something to overwrite. It is not the answer to "past repair jobs get a
place on the board" — the read-time derivation already was. The answer to the
wider ask is the human review list in
`docs/repair-backfill-review-2026-08-26.md`.
