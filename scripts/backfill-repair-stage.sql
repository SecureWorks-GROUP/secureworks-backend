-- Repair intake pipeline — deterministic Repairs-board stage backfill
--
-- WHAT THIS DOES
--   Stamps jobs.metadata.repair_stage on the jobs that ALREADY carry a
--   deterministic repair marker, so the existing repair cards keep their column
--   the day a persisted stage becomes authoritative.
--
-- WHAT THIS DELIBERATELY DOES NOT DO
--   * It never changes jobs.type. No card is retyped from 'makesafe' to
--     'repair'. Retyping is unguarded in the database (both make-safe triggers
--     fire on the CHILD table only, never on jobs.type) and production already
--     contains four jobs — SWMS-26931/26932/26936/26978 — that are
--     type='insurance' with live makesafe_job_details rows, i.e. proof that a
--     type flip passes silently and desyncs the MakeSafe board.
--   * It never changes job_number. No renumbering, no SWR- rewrite.
--   * It never touches the SES money seal. Every marked repair job is sealed
--     (532/532 make-safes are), the seal is write-once, and this script does not
--     go near those columns.
--   * It never CLAIMS a job. Only rows that already carry one of the three
--     deterministic markers are touched. The ~35 text-sweep candidates are
--     human-gated in docs/repair-backfill-review-2026-08-26.md and are
--     deliberately absent from every statement below.
--   * It leaves NOTHING behind. There is no view, no helper function and no
--     table in the public schema at any point, not even mid-run. The candidate
--     set is a pg_temp table created inside the transaction with ON COMMIT DROP,
--     so it is gone whether the run commits, rolls back, or dies in the middle.
--     An earlier draft created a `public.` view for this and dropped it in a
--     final statement — which meant the documented "stop after the dry run and
--     read it" path, and any mid-run error, left a standing owner-rights read
--     path onto public.jobs behind in the production schema.
--
-- SCOPE
--   Every statement is scoped to the SecureWorks org, matching every sibling
--   read (loadInsuranceRepairJobIds scopes all four of its queries by org_id).
--
-- STAGE DERIVATION
--   The stage is derived from jobs.status using the SAME mapping the board
--   read-model already applies (supabase/functions/ops-api/insurance_repairs_board.ts,
--   insuranceRepairStage). That is the whole point: today the column is computed
--   from status at read time, so stamping the computed value changes NOTHING a
--   user can see. It simply moves the same answer from a derivation to a fact,
--   so that the first operator drag has something to overwrite.
--
-- IDEMPOTENCE
--   Rows that already carry metadata.repair_stage are skipped, always. Re-running
--   this script can never move a card an operator has already moved by hand.
--
-- HOW TO RUN
--   See scripts/README-backfill-repair-stage.md. The file ends on ROLLBACK, so
--   running it as shipped IS the dry run: it prints exactly what it would do and
--   then undoes all of it. Applying means changing that one word. Nothing here
--   is executed by CI or by any deploy workflow.

\set ON_ERROR_STOP on

BEGIN;

-- The whole run is one transaction. A failure at any point below leaves the
-- database exactly as it was found, and the temp table dies with the session.
CREATE TEMPORARY TABLE repair_stage_backfill_candidates ON COMMIT DROP AS
WITH marked AS (
  SELECT id
    FROM public.jobs
   WHERE org_id = '00000000-0000-0000-0000-000000000001'
     AND (metadata->>'makesafe_job_family' = 'repair'
       OR metadata->>'ses_family' = 'repair')
  UNION
  SELECT d.job_id
    FROM public.makesafe_job_details d
    JOIN public.jobs j ON j.id = d.job_id
   WHERE j.org_id = '00000000-0000-0000-0000-000000000001'
     AND d.report_type = 'repair'
)
SELECT
  j.id,
  j.job_number,
  j.type,
  j.status,
  j.site_suburb,
  j.created_at,
  (j.ses_money_sealed_at IS NOT NULL) AS money_sealed,
  j.metadata->>'repair_stage' AS existing_repair_stage,
  CASE lower(COALESCE(j.status, ''))
    WHEN 'scoping'           THEN 'scoping'
    WHEN 'scope'             THEN 'scoping'
    WHEN 'assessing'         THEN 'scoping'
    WHEN 'quoted'            THEN 'quoted'
    WHEN 'quote_sent'        THEN 'quoted'
    WHEN 'quote'             THEN 'quoted'
    WHEN 'variation'         THEN 'variation'
    WHEN 'variation_pending' THEN 'variation'
    WHEN 'accepted'          THEN 'approved'
    WHEN 'approved'          THEN 'approved'
    WHEN 'approvals'         THEN 'approved'
    WHEN 'awaiting_deposit'  THEN 'approved'
    WHEN 'deposit'           THEN 'approved'
    WHEN 'order_materials'   THEN 'materials'
    WHEN 'materials'         THEN 'materials'
    WHEN 'ordering'          THEN 'materials'
    WHEN 'awaiting_supplier' THEN 'materials'
    WHEN 'order_confirmed'   THEN 'materials'
    WHEN 'schedule_install'  THEN 'scheduled'
    WHEN 'scheduled'         THEN 'scheduled'
    WHEN 'processing'        THEN 'on_site'
    WHEN 'in_progress'       THEN 'on_site'
    WHEN 'on_site'           THEN 'on_site'
    WHEN 'rectification'     THEN 'on_site'
    WHEN 'complete'          THEN 'complete'
    WHEN 'completed'         THEN 'complete'
    WHEN 'final_payment'     THEN 'complete'
    WHEN 'invoiced'          THEN 'complete'
    WHEN 'archived'          THEN 'complete'
    ELSE 'wo_in'
  END AS derived_repair_stage
FROM public.jobs j
WHERE j.org_id = '00000000-0000-0000-0000-000000000001'
  AND j.id IN (SELECT id FROM marked);

-- ─────────────────────────────────────────────────────────────────────────────
-- STEP 1 — what this run is looking at. Nothing is written yet.
-- Expected on 2026-08-26 production: 3 rows, all status 'processing', all
-- deriving 'on_site', all with existing_repair_stage NULL
-- (SWMS-261029 Midland, SWMS-261163 Falcon, SWMS-261192 Boddington).
-- Every one of them ALREADY shows in On Site, because the board derives that
-- same answer from status today. A correct run moves no card at all.
-- ─────────────────────────────────────────────────────────────────────────────
SELECT
  job_number,
  type,
  status,
  site_suburb,
  money_sealed,
  existing_repair_stage,
  derived_repair_stage,
  CASE
    WHEN existing_repair_stage IS NOT NULL THEN 'SKIP (already stamped)'
    ELSE 'STAMP'
  END AS action
FROM repair_stage_backfill_candidates
ORDER BY created_at;

-- Sanity counters for the run record.
SELECT
  count(*)                                                  AS candidates,
  count(*) FILTER (WHERE existing_repair_stage IS NOT NULL) AS already_stamped,
  count(*) FILTER (WHERE existing_repair_stage IS NULL)     AS to_stamp,
  count(*) FILTER (WHERE type <> 'makesafe')                AS non_makesafe_type,
  count(*) FILTER (WHERE NOT money_sealed)                  AS unsealed
FROM repair_stage_backfill_candidates;

-- ─────────────────────────────────────────────────────────────────────────────
-- STEP 2 — the write, still inside the same transaction as the read above, so
-- the rows reported are exactly the rows stamped.
-- ─────────────────────────────────────────────────────────────────────────────
WITH stamped AS (
  UPDATE public.jobs j
  SET metadata = j.metadata || jsonb_build_object(
        'repair_stage', c.derived_repair_stage,
        'repair_stage_source', 'backfill_2026_08_26_status_derived'
      )
  FROM repair_stage_backfill_candidates c
  WHERE c.id = j.id
    AND j.org_id = '00000000-0000-0000-0000-000000000001'
    AND c.existing_repair_stage IS NULL
  RETURNING j.id, j.job_number, j.metadata->>'repair_stage' AS repair_stage
)
SELECT job_number, repair_stage FROM stamped ORDER BY job_number;

-- ─────────────────────────────────────────────────────────────────────────────
-- STEP 3 — post-conditions. A surprise aborts the transaction rather than
-- leaving a half-stamped board behind.
-- ─────────────────────────────────────────────────────────────────────────────
DO $repair_backfill_assertions$
DECLARE
  unlawful int;
  escaped int;
BEGIN
  SELECT count(*) INTO unlawful
  FROM public.jobs
  WHERE org_id = '00000000-0000-0000-0000-000000000001'
    AND metadata ? 'repair_stage'
    AND metadata->>'repair_stage' NOT IN (
      'wo_in', 'scoping', 'quoted', 'variation', 'approved',
      'materials', 'scheduled', 'on_site', 'complete'
    );
  IF unlawful > 0 THEN
    RAISE EXCEPTION
      'backfill produced % job(s) with a stage outside the nine-stage board vocabulary',
      unlawful;
  END IF;

  -- Nothing outside the candidate set may have been touched by this run.
  SELECT count(*) INTO escaped
  FROM public.jobs j
  WHERE j.org_id = '00000000-0000-0000-0000-000000000001'
    AND j.metadata->>'repair_stage_source' = 'backfill_2026_08_26_status_derived'
    AND j.id NOT IN (SELECT id FROM repair_stage_backfill_candidates);
  IF escaped > 0 THEN
    RAISE EXCEPTION
      'backfill stamped % job(s) outside the deterministic marker set', escaped;
  END IF;
END;
$repair_backfill_assertions$;

-- ─────────────────────────────────────────────────────────────────────────────
-- As shipped this is a DRY RUN: everything above is undone here, and the temp
-- table goes with the session. Read the output, then change ROLLBACK to COMMIT
-- and run it again to apply. That edit is the approval.
-- ─────────────────────────────────────────────────────────────────────────────
ROLLBACK;
