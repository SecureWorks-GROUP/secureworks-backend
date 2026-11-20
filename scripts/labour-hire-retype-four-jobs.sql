-- Move the four existing labour hire jobs onto the labour_hire job type.
--
-- Owner, 20 Nov 2026: "they should be labour hire jobs basically. may be a new
-- job classification but do that please". These four were made as
-- miscellaneous jobs on 6 Nov 2026, before the type existed.
--
-- NOT a migration and NOT run by any deploy, cron or agent on its own. A person
-- runs it by hand, once, AFTER 20261120101500_labour_hire_job_type is applied.
--
-- DRY RUN BY DEFAULT: the last statement is ROLLBACK, so running this file as it
-- stands changes nothing and shows the before and after rows. To apply, change
-- that one last word to COMMIT and run it again.
--
-- What it does: sets jobs.type = 'labour_hire' on exactly SWM-261677,
-- SWM-261678, SWM-261679 and SWM-261680. The job numbers are kept (never
-- renumbered). Nothing else on the job, no invoice, no Xero record, no work
-- order, no assignment and no message is written.
--
-- It refuses, changing nothing, unless ALL of these hold:
--   - the labour_hire type is admitted (the migration is applied);
--   - exactly those four jobs exist, each still type 'miscellaneous';
--   - none is SES money sealed, legacy, or in a status where the job work order
--     trigger opens a work order (see below).
--
-- Triggers on public.jobs that fire on this update (read from production
-- 20 Nov 2026), and what each does here:
--   - trg_jobs_ses_money_seal_v1 (BEFORE, on type): seals only a 'makesafe'
--     type or an SWMS- number. Neither applies, so no seal is written.
--   - trg_jobs_open_job_work_order (AFTER, on status or type): opens a draft
--     job work order only when the status is one of
--     job_work_order_open_statuses() (accepted ... rectification). All four are
--     'invoiced', which is not one, and this script refuses a job that is. So
--     it opens nothing.
--   - job_profit_changed (AFTER, on type): marks the job for a Job Profit
--     re-read (job_profit_refresh_v1 is on). The figures do not change; the
--     job's work type reads 'labour_hire' on the next refresh.
--   - trg_jobs_record_status_changed (AFTER, statement): records only a status
--     or repair stage change. Neither changes, so no row is written.
--   - trg_jobs_updated (BEFORE): moves updated_at to now.
--   - trg_jobs_expected_costs_write_once: fires only when expected costs are
--     frozen; none of the four has any.
--
-- To undo: run the same block with the two type names swapped (labour_hire ->
-- miscellaneous) before rolling the migration back; the rollback refuses while
-- any labour_hire job exists.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

SELECT 'before' AS at, job_number, type, status, updated_at
FROM public.jobs
WHERE job_number IN ('SWM-261677', 'SWM-261678', 'SWM-261679', 'SWM-261680')
ORDER BY job_number;

DO $retype$
DECLARE
  v_numbers constant text[] := ARRAY['SWM-261677', 'SWM-261678', 'SWM-261679', 'SWM-261680'];
  v_found integer;
  v_ready integer;
  v_changed integer;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.jobs'::regclass AND conname = 'jobs_type_check'
      AND pg_get_constraintdef(oid) LIKE '%''labour_hire''::text%'
  ) THEN
    RAISE EXCEPTION 'labour_hire is not an admitted job type yet: apply 20261120101500_labour_hire_job_type first';
  END IF;

  -- Lock the four rows, then judge them as they stand under the lock.
  PERFORM 1 FROM public.jobs WHERE job_number = ANY (v_numbers) FOR UPDATE;

  SELECT count(*),
         count(*) FILTER (
           WHERE type = 'miscellaneous'
             AND ses_money_sealed_at IS NULL
             AND legacy IS NOT TRUE
             AND NOT (status = ANY (public.job_work_order_open_statuses()))
         )
    INTO v_found, v_ready
  FROM public.jobs
  WHERE job_number = ANY (v_numbers);

  IF v_found <> 4 THEN
    RAISE EXCEPTION 'expected exactly 4 jobs, found %', v_found;
  END IF;
  IF v_ready <> 4 THEN
    RAISE EXCEPTION 'only % of the 4 jobs are miscellaneous, unsealed, not legacy and outside the work order statuses; nothing changed', v_ready;
  END IF;

  UPDATE public.jobs
     SET type = 'labour_hire'
   WHERE job_number = ANY (v_numbers)
     AND type = 'miscellaneous';
  GET DIAGNOSTICS v_changed = ROW_COUNT;
  IF v_changed <> 4 THEN
    RAISE EXCEPTION 'expected to change exactly 4 jobs, changed %', v_changed;
  END IF;

  -- The update must not have opened a work order or sealed a job.
  IF EXISTS (
    SELECT 1 FROM public.work_orders wo
    JOIN public.jobs j ON j.id = wo.job_id
    WHERE j.job_number = ANY (v_numbers) AND wo.created_at >= transaction_timestamp()
  ) OR EXISTS (
    SELECT 1 FROM public.jobs
    WHERE job_number = ANY (v_numbers) AND ses_money_sealed_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'the retype opened a work order or sealed a job; nothing changed';
  END IF;
END;
$retype$;

SELECT 'after' AS at, job_number, type, status, updated_at
FROM public.jobs
WHERE job_number IN ('SWM-261677', 'SWM-261678', 'SWM-261679', 'SWM-261680')
ORDER BY job_number;

-- Dry run. Change ROLLBACK to COMMIT to apply.
ROLLBACK;
