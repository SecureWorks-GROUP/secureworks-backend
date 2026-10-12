-- Runs after supabase/rollbacks/20261012180000_trade_invoice_time_entries_down.sql
-- against the exact forward stack it reverses.
--
-- The down takes back the surface (the list, the stamping persist, the flag)
-- and must keep the record: the four columns stay, and v1 is untouched.
BEGIN;

DO $$
DECLARE
  kept integer;
BEGIN
  IF to_regclass('public.job_trade_time_entries') IS NOT NULL THEN
    RAISE EXCEPTION 'the down migration left the job list view';
  END IF;
  IF to_regprocedure('public.persist_weekly_trade_invoice_v2(jsonb, jsonb, uuid)') IS NOT NULL THEN
    RAISE EXCEPTION 'the down migration left the stamping persist';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.feature_flags
    WHERE flag_name = 'trade_invoice_time_entry_required_v1'
  ) THEN
    RAISE EXCEPTION 'the down migration left the enforcement flag';
  END IF;
  IF to_regprocedure('public.persist_weekly_trade_invoice_v1(jsonb, jsonb, uuid)') IS NULL THEN
    RAISE EXCEPTION 'the down migration removed the v1 persist it never owned';
  END IF;

  SELECT count(*) INTO kept
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name = 'trade_invoice_lines'
    AND column_name IN ('work_date', 'start_time', 'finish_time', 'break_minutes');
  IF kept <> 4 THEN
    RAISE EXCEPTION 'the down migration dropped recorded time entry columns (% of 4 kept)', kept;
  END IF;

  IF to_regclass('public.job_assignment_logged_times') IS NULL THEN
    RAISE EXCEPTION 'the down migration dropped the times saved on the job view';
  END IF;

  -- a recorded entry is still stored, and still held to its shape
  INSERT INTO public.trade_invoice_lines (
    trade_invoice_id, job_id, line_type, line_total_ex,
    work_date, start_time, finish_time, break_minutes
  ) VALUES (
    'f4000000-0000-4000-8000-000000000001', 'f2000000-0000-4000-8000-000000000001',
    'labour', 0, '2026-09-22', '07:00', '15:00', 0
  );
  BEGIN
    INSERT INTO public.trade_invoice_lines (
      trade_invoice_id, job_id, line_type, line_total_ex,
      work_date, start_time, finish_time
    ) VALUES (
      'f4000000-0000-4000-8000-000000000001', 'f2000000-0000-4000-8000-000000000001',
      'labour', 0, '2026-09-22', '15:00', '07:00'
    );
    RAISE EXCEPTION 'the down migration dropped the time entry check';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;
END;
$$;

ROLLBACK;
