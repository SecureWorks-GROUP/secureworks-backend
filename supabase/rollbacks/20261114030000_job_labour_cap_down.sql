-- Rollback for 20261114030000_job_labour_cap.sql.
-- Refuses while any raise is recorded: dropping the table would lose who
-- raised a job's labour maximum, when, why and by how much. Switch
-- job_labour_budget_v1 off instead; that alone stops the guard and returns
-- invoicing and the work order fill to how they were. With no raise recorded,
-- takes every step 4 object away. The check and every drop are one
-- statement, so a refusal leaves nothing dropped. Safe to re-run.

DO $$
DECLARE
  v_kept boolean := false;
BEGIN
  IF to_regclass('public.job_labour_cap_raises') IS NOT NULL THEN
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM public.job_labour_cap_raises)' INTO v_kept;
  END IF;
  IF v_kept THEN
    RAISE EXCEPTION 'Labour cap raises are recorded; switch job_labour_budget_v1 off instead of rolling back 20261114030000';
  END IF;

  DROP TRIGGER IF EXISTS job_labour_cap_guard_line ON public.trade_invoice_lines;
  DROP TRIGGER IF EXISTS job_labour_cap_guard_invoice ON public.trade_invoices;
  DROP FUNCTION IF EXISTS public.job_labour_cap_guard_line();
  DROP FUNCTION IF EXISTS public.job_labour_cap_guard_invoice();
  DROP FUNCTION IF EXISTS public.raise_job_labour_cap(uuid, uuid, uuid, text, uuid, numeric, text);
  DROP FUNCTION IF EXISTS public.job_labour_cap_check_invoice(uuid);
  DROP FUNCTION IF EXISTS public.job_labour_cap_state(uuid);
  DROP FUNCTION IF EXISTS public.job_labour_budget_on();
  DROP TABLE IF EXISTS public.job_labour_cap_raises;
  DROP FUNCTION IF EXISTS public.job_labour_cap_raises_write_once();
  DELETE FROM public.feature_flags WHERE flag_name = 'job_labour_budget_v1';
END $$;
