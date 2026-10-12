-- Trade invoice time entries (20261012180000): the four fields on a time
-- line, the stamping persist, the per-job list and the flag, off.
-- Everything below, including the second run of the migration, is rolled back.
BEGIN;

-- 1. Nothing saved before the migration was given a time. No backfill.
DO $$
DECLARE
  invented integer;
BEGIN
  SELECT count(*) INTO invented
  FROM public.trade_invoice_lines
  WHERE work_date IS NOT NULL OR start_time IS NOT NULL
     OR finish_time IS NOT NULL OR break_minutes IS NOT NULL;
  IF invented <> 0 THEN
    RAISE EXCEPTION 'the migration invented a time entry on % existing line(s)', invented;
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.job_trade_time_entries
    WHERE trade_invoice_line_id = 'f5000000-0000-4000-8000-000000000001'
  ) THEN
    RAISE EXCEPTION 'a line saved before the migration is listed against its job';
  END IF;
END;
$$;

-- 2. The flag is seeded off, once.
DO $$
DECLARE
  flag_rows integer;
  flag_on boolean;
BEGIN
  SELECT count(*), bool_or(enabled) INTO flag_rows, flag_on
  FROM public.feature_flags
  WHERE flag_name = 'trade_invoice_time_entry_required_v1';
  IF flag_rows <> 1 OR flag_on IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'the enforcement flag must exist once and be off (rows %, on %)', flag_rows, flag_on;
  END IF;
END;
$$;

-- 3. The table holds a time to HH:MM, a break to 0 or more, and a finish
--    after its start. A half-filled draft entry is allowed.
CREATE FUNCTION pg_temp.line_refused(
  p_start text, p_finish text, p_break integer
) RETURNS boolean
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO public.trade_invoice_lines (
    trade_invoice_id, job_id, line_type, line_total_ex,
    work_date, start_time, finish_time, break_minutes
  ) VALUES (
    'f4000000-0000-4000-8000-000000000001', 'f2000000-0000-4000-8000-000000000001',
    'labour', 0, '2026-09-22', p_start, p_finish, p_break
  );
  RETURN false;
EXCEPTION WHEN check_violation THEN
  RETURN true;
END;
$$;

DO $$
BEGIN
  IF NOT pg_temp.line_refused('7:00', '15:00', 0) THEN
    RAISE EXCEPTION 'a start time that is not HH:MM was stored';
  END IF;
  IF NOT pg_temp.line_refused('07:00', '24:00', 0) THEN
    RAISE EXCEPTION 'a finish time past 23:59 was stored';
  END IF;
  IF NOT pg_temp.line_refused('07:00:00', '15:00', 0) THEN
    RAISE EXCEPTION 'a time with seconds was stored';
  END IF;
  IF NOT pg_temp.line_refused('15:00', '07:00', 0) THEN
    RAISE EXCEPTION 'a finish before its start was stored';
  END IF;
  IF NOT pg_temp.line_refused('07:00', '07:00', 0) THEN
    RAISE EXCEPTION 'a finish equal to its start was stored';
  END IF;
  IF NOT pg_temp.line_refused('07:00', '15:00', -1) THEN
    RAISE EXCEPTION 'a negative break was stored';
  END IF;
  -- allowed: a whole entry, a start with no finish yet, and no entry at all
  IF pg_temp.line_refused('07:00', '15:00', 30)
     OR pg_temp.line_refused('09:59', '10:00', NULL)
     OR pg_temp.line_refused('07:00', NULL, NULL)
     OR pg_temp.line_refused(NULL, NULL, NULL) THEN
    RAISE EXCEPTION 'a valid or half-filled time entry was refused';
  END IF;
END;
$$;
DELETE FROM public.trade_invoice_lines
WHERE trade_invoice_id = 'f4000000-0000-4000-8000-000000000001'
  AND id <> 'f5000000-0000-4000-8000-000000000001';

-- 4. A job's list: who, which day, start, finish, hours, which invoice.
INSERT INTO public.trade_invoices (
  id, org_id, user_id, week_start, week_end, status, invoice_source, invoice_number,
  submitted_at, subtotal_ex, gst, total_inc, gst_on, super_rate, super_amount,
  gross_earned, net_pay
) VALUES
  ('f4000000-0000-4000-8000-000000000002', 'f0000000-0000-4000-8000-0000000000aa',
   'f1000000-0000-4000-8000-000000000001', '2026-09-28', '2026-10-04', 'approved', 'hourly',
   'SW-INV-TIME-LIVE', '2026-10-04T10:00:00Z', 100, 0, 100, false, 0.12, 12, 100, 88),
  ('f4000000-0000-4000-8000-000000000003', 'f0000000-0000-4000-8000-0000000000aa',
   'f1000000-0000-4000-8000-000000000001', '2026-10-12', '2026-10-18', 'draft', 'hourly',
   NULL, NULL, 100, 0, 100, false, 0.12, 12, 100, 88);

INSERT INTO public.trade_invoice_lines (
  id, trade_invoice_id, job_id, job_number, line_type, total_hours, hourly_rate,
  line_total_ex, work_date, start_time, finish_time, break_minutes
) VALUES
  -- two days on one job, entered out of order: the list is by day
  ('f5000000-0000-4000-8000-000000000011', 'f4000000-0000-4000-8000-000000000002',
   'f2000000-0000-4000-8000-000000000001', 'SWF-TIME-1', 'labour', 4, 40, 160,
   '2026-09-30', '07:00', '11:00', NULL),
  ('f5000000-0000-4000-8000-000000000012', 'f4000000-0000-4000-8000-000000000002',
   'f2000000-0000-4000-8000-000000000001', 'SWF-TIME-1', 'labour', 8, 40, 320,
   '2026-09-29', '07:00', '15:30', 30),
  -- materials on the same invoice: not a time line, no entry, not listed
  ('f5000000-0000-4000-8000-000000000013', 'f4000000-0000-4000-8000-000000000002',
   'f2000000-0000-4000-8000-000000000001', 'SWF-TIME-1', 'materials', NULL, NULL, 20,
   NULL, NULL, NULL, NULL),
  -- a draft is a working copy, never a record against the job
  ('f5000000-0000-4000-8000-000000000014', 'f4000000-0000-4000-8000-000000000003',
   'f2000000-0000-4000-8000-000000000001', 'SWF-TIME-1', 'labour', 8, 40, 320,
   '2026-10-13', '07:00', '15:00', 0),
  -- half-filled entries never reach the list
  ('f5000000-0000-4000-8000-000000000015', 'f4000000-0000-4000-8000-000000000002',
   'f2000000-0000-4000-8000-000000000001', 'SWF-TIME-1', 'labour', 1, 40, 40,
   '2026-10-01', '07:00', NULL, NULL);

DO $$
DECLARE
  listed text;
  first_row record;
BEGIN
  SELECT string_agg(trade_invoice_line_id::text, ',' ORDER BY work_date, start_time COLLATE "C")
  INTO listed
  FROM public.job_trade_time_entries
  WHERE job_id = 'f2000000-0000-4000-8000-000000000001';
  IF listed IS DISTINCT FROM
     'f5000000-0000-4000-8000-000000000012,f5000000-0000-4000-8000-000000000011' THEN
    RAISE EXCEPTION 'the job list is not its two submitted time entries in day order: %', listed;
  END IF;

  SELECT * INTO first_row
  FROM public.job_trade_time_entries
  WHERE trade_invoice_line_id = 'f5000000-0000-4000-8000-000000000012';
  IF first_row.user_id IS DISTINCT FROM 'f1000000-0000-4000-8000-000000000001'::uuid
     OR first_row.user_name IS NULL
     OR first_row.user_name IS DISTINCT FROM (
       SELECT name FROM public.users WHERE id = 'f1000000-0000-4000-8000-000000000001'
     )
     OR first_row.work_date <> DATE '2026-09-29'
     OR first_row.start_time <> '07:00'
     OR first_row.finish_time <> '15:30'
     OR first_row.break_minutes <> 30
     OR first_row.hours <> 8
     OR first_row.trade_invoice_id <> 'f4000000-0000-4000-8000-000000000002'::uuid
     OR first_row.invoice_number <> 'SW-INV-TIME-LIVE'
     OR first_row.invoice_status <> 'approved'
     OR first_row.job_number <> 'SWF-TIME-1' THEN
    RAISE EXCEPTION 'the job list row does not say who, which day, start, finish, hours and which invoice: %', row_to_json(first_row);
  END IF;
  -- the two instants are Perth local time (UTC+8, no daylight saving)
  IF first_row.started_at <> TIMESTAMPTZ '2026-09-28 23:00:00+00'
     OR first_row.finished_at <> TIMESTAMPTZ '2026-09-29 07:30:00+00' THEN
    RAISE EXCEPTION 'the entry instants are not Perth time: % to %', first_row.started_at, first_row.finished_at;
  END IF;
  -- a break that was never sent reads as 0, not unknown
  IF (SELECT break_minutes FROM public.job_trade_time_entries
      WHERE trade_invoice_line_id = 'f5000000-0000-4000-8000-000000000011') <> 0 THEN
    RAISE EXCEPTION 'a missing break did not read as 0';
  END IF;
END;
$$;

-- 5. The list and the stamping persist are the service role's only.
DO $$
BEGIN
  IF has_table_privilege('anon', 'public.job_trade_time_entries', 'SELECT')
     OR has_table_privilege('authenticated', 'public.job_trade_time_entries', 'SELECT')
     OR NOT has_table_privilege('service_role', 'public.job_trade_time_entries', 'SELECT') THEN
    RAISE EXCEPTION 'job_trade_time_entries must be readable by service_role only';
  END IF;
  IF has_function_privilege('anon', 'public.persist_weekly_trade_invoice_v2(jsonb, jsonb, uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.persist_weekly_trade_invoice_v2(jsonb, jsonb, uuid)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.persist_weekly_trade_invoice_v2(jsonb, jsonb, uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'persist_weekly_trade_invoice_v2 must be callable by service_role only';
  END IF;
  IF NOT (
    SELECT COALESCE(c.reloptions, ARRAY[]::text[]) @> ARRAY['security_invoker=true']
    FROM pg_class c
    WHERE c.oid = 'public.job_trade_time_entries'::regclass
  ) THEN
    RAISE EXCEPTION 'job_trade_time_entries must read as its caller (security_invoker)';
  END IF;
END;
$$;

-- 6. The dated draft persist stores the entry on the lines that carry one,
--    through the unchanged v1 persist, and leaves the others alone.
DO $$
DECLARE
  v_header jsonb;
  v_lines jsonb;
  v_draft uuid;
  v_replacement uuid;
  v_stamped text;
BEGIN
  v_header := jsonb_build_object(
    'org_id', 'f0000000-0000-4000-8000-0000000000aa',
    'user_id', 'f1000000-0000-4000-8000-000000000001',
    'week_start', '2026-10-05',
    'week_end', '2026-10-11',
    'total_hours', 8,
    'total_breaks_minutes', 0,
    'subtotal_ex', 360,
    'gst', 0,
    'total_inc', 360,
    'gst_on', false,
    'super_rate', 0.12,
    'super_amount', 43.2,
    'gross_earned', 360,
    'net_pay', 338.4,
    'invoice_source', 'hourly',
    'status', 'draft'
  );
  v_lines := jsonb_build_array(
    jsonb_build_object(
      'job_id', 'f2000000-0000-4000-8000-000000000001', 'job_number', 'SWF-TIME-1',
      'line_type', 'labour', 'total_hours', 8, 'hourly_rate', 40, 'line_total_ex', 320,
      'work_date', '2026-10-06', 'start_time', '07:00', 'finish_time', '15:30',
      'break_minutes', 30
    ),
    -- no line_position sent on any line: v1 numbers them 0, 1, 2 and v2 must
    -- stamp by that same numbering
    jsonb_build_object(
      'line_type', 'materials', 'description', 'Screws', 'quantity', 2,
      'unit', 'ea', 'unit_rate', 10, 'line_total_ex', 20,
      'work_date', NULL, 'start_time', NULL, 'finish_time', NULL, 'break_minutes', NULL
    ),
    jsonb_build_object(
      'job_id', 'f2000000-0000-4000-8000-000000000001', 'job_number', 'SWF-TIME-1',
      'line_type', 'labour', 'total_hours', 0, 'hourly_rate', 40, 'line_total_ex', 20,
      'work_date', '2026-10-07', 'start_time', '07:00'
    )
  );
  v_draft := public.persist_weekly_trade_invoice_v2(v_header, v_lines, NULL);

  SELECT string_agg(
    concat_ws('|', line_position, line_type, COALESCE(work_date::text, '-'),
      COALESCE(start_time, '-'), COALESCE(finish_time, '-'), COALESCE(break_minutes::text, '-')),
    ' ; ' ORDER BY line_position
  ) INTO v_stamped
  FROM public.trade_invoice_lines
  WHERE trade_invoice_id = v_draft;
  IF v_stamped IS DISTINCT FROM
     '0|labour|2026-10-06|07:00|15:30|30 ; 1|materials|-|-|-|- ; 2|labour|2026-10-07|07:00|-|-' THEN
    RAISE EXCEPTION 'the dated draft persist did not stamp the time entries line by line: %', v_stamped;
  END IF;
  -- still a draft: nothing is recorded against the job yet
  IF EXISTS (
    SELECT 1 FROM public.job_trade_time_entries WHERE trade_invoice_id = v_draft
  ) THEN
    RAISE EXCEPTION 'a draft time entry was listed against its job';
  END IF;

  -- v1's own guard still runs inside v2: a replacement removes the old draft
  v_replacement := public.persist_weekly_trade_invoice_v2(v_header, v_lines, v_draft);
  IF v_replacement = v_draft
     OR EXISTS (SELECT 1 FROM public.trade_invoices WHERE id = v_draft)
     OR (SELECT count(*) FROM public.trade_invoice_lines
         WHERE trade_invoice_id = v_replacement AND start_time = '07:00') <> 2 THEN
    RAISE EXCEPTION 'replacing a dated draft through v2 did not keep one stamped draft';
  END IF;
END;
$$;

-- 7. A second run changes nothing, and never turns an ON flag back off.
UPDATE public.feature_flags
SET enabled = true
WHERE flag_name = 'trade_invoice_time_entry_required_v1';

\ir ../../../migrations/20261012180000_trade_invoice_time_entries.sql

DO $$
BEGIN
  IF (SELECT count(*) FROM public.feature_flags
      WHERE flag_name = 'trade_invoice_time_entry_required_v1' AND enabled) <> 1 THEN
    RAISE EXCEPTION 'a second run of the migration reset or duplicated the flag';
  END IF;
  IF (SELECT count(*) FROM pg_constraint
      WHERE conname = 'trade_invoice_lines_time_entry_check') <> 1 THEN
    RAISE EXCEPTION 'a second run of the migration duplicated the time entry check';
  END IF;
  IF (SELECT count(*) FROM public.job_trade_time_entries
      WHERE job_id = 'f2000000-0000-4000-8000-000000000001') <> 2 THEN
    RAISE EXCEPTION 'a second run of the migration changed the job list';
  END IF;
END;
$$;

ROLLBACK;
