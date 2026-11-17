-- P1-05.6: made-up send totals, legacy inserts, hold guards and private notes.
BEGIN;
CREATE FUNCTION pg_temp.zztest_assert(ok boolean, words text) RETURNS void
LANGUAGE plpgsql AS $$ BEGIN
  IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'ZZTEST %', words; END IF;
END $$;
CREATE FUNCTION pg_temp.zztest_refuses(command text, state text) RETURNS void
LANGUAGE plpgsql AS $$ BEGIN
  BEGIN
    EXECUTE command;
  EXCEPTION WHEN OTHERS THEN
    IF SQLSTATE = state THEN RETURN; END IF;
    RAISE;
  END;
  RAISE EXCEPTION 'ZZTEST expected refusal %: %', state, command;
END $$;
DO $$
DECLARE
  org uuid := 'f1173901-0000-4000-8000-000000000001';
  crew uuid := 'f1173901-0000-4000-8000-000000000002';
  send uuid := 'f1173901-0000-4000-8000-000000000003';
  standard uuid;
  held uuid;
  follow_on uuid;
  waiting_line uuid;
  rejected_line uuid;
  note_id uuid;
  kind text;
BEGIN
  INSERT INTO public.users (id, org_id, name, role)
    VALUES (crew, org, 'ZZTEST crew', 'crew');
  -- An old caller omits every new field.
  INSERT INTO public.trade_invoices (org_id, user_id, invoice_number, status,
    subtotal_ex, gst, total_inc)
    VALUES (org, crew, 'ZZTEST-HOLD-STANDARD', 'draft', 0, 0, 0)
    RETURNING id, invoice_kind INTO standard, kind;
  PERFORM pg_temp.zztest_assert(kind = 'standard', 'old insert lost standard default');
  UPDATE public.trade_invoices SET send_id = send WHERE id = standard;
  INSERT INTO public.trade_invoices (org_id, user_id, invoice_number, status,
    subtotal_ex, gst, total_inc, invoice_kind, send_id)
    VALUES (org, crew, 'ZZTEST-HOLD-HELD', 'draft', 0, 0, 0, 'held', send)
    RETURNING id INTO held;
  INSERT INTO public.trade_invoices (org_id, user_id, invoice_number, status,
    subtotal_ex, gst, total_inc, invoice_kind, send_id, follows_invoice_id)
    VALUES (org, crew, 'ZZTEST-HOLD-FOLLOW', 'draft', 0, 0, 0,
      'follow_on', send, standard) RETURNING id INTO follow_on;
  PERFORM pg_temp.zztest_refuses(format(
    'UPDATE public.trade_invoices SET invoice_kind = %L WHERE id = %L',
    'ZZTEST-unknown', standard), '23514');
  PERFORM pg_temp.zztest_refuses(format(
    'UPDATE public.trade_invoices SET subtotal_ex = 1 WHERE id = %L', held), '23514');
  PERFORM pg_temp.zztest_refuses(format(
    'UPDATE public.trade_invoices SET xero_bill_id = %L WHERE id = %L',
    'ZZTEST-bill', held), '23514');

  INSERT INTO public.trade_invoice_lines (trade_invoice_id, line_type,
    line_total_ex, sent_amount_ex, sent_values)
    VALUES (standard, 'other', 700, 700, '{"source":"ZZTEST sent"}');
  INSERT INTO public.trade_invoice_lines (trade_invoice_id, line_type,
    line_total_ex, sent_amount_ex, office_review_status, hold_reason, held_at)
    VALUES (held, 'other', 200, 200, 'awaiting', 'no_work_order', now())
    RETURNING id INTO waiting_line;
  INSERT INTO public.trade_invoice_lines (trade_invoice_id, line_type,
    line_total_ex, sent_amount_ex, office_review_status, hold_reason, held_at)
    VALUES (held, 'other', 100, 100, 'rejected', 'over_amount', now())
    RETURNING id INTO rejected_line;
  PERFORM pg_temp.zztest_refuses(format(
    'UPDATE public.trade_invoice_lines SET office_review_status = NULL WHERE id = %L',
    waiting_line), '23514');
  PERFORM pg_temp.zztest_refuses(format(
    'UPDATE public.trade_invoice_lines SET hold_reason = %L WHERE id = %L',
    'ZZTEST-unknown', waiting_line), '23514');
  PERFORM pg_temp.zztest_assert(public.trade_send_totals(send) =
    '{"sent_ex":1000,"in_pay_ex":700,"held_ex":200,"declined_ex":100,"balanced":true}'::jsonb,
    'initial send does not balance');
  -- A query stays held. A decision moves the same row, preserving sent money.
  UPDATE public.trade_invoice_lines SET office_review_status = 'queried'
    WHERE id = waiting_line;
  PERFORM pg_temp.zztest_assert((public.trade_send_totals(send)->>'held_ex')::numeric = 200,
    'queried money left held totals');
  UPDATE public.trade_invoice_lines
    SET trade_invoice_id = follow_on, line_total_ex = 150,
        office_review_status = 'approved', decided_at = now(),
        office_change_reason = 'ZZTEST office reduction'
    WHERE id = waiting_line;
  PERFORM pg_temp.zztest_assert(public.trade_send_totals(send) =
    '{"sent_ex":1000,"in_pay_ex":850,"held_ex":0,"declined_ex":150,"balanced":true}'::jsonb,
    'reduced follow-on does not balance');
  UPDATE public.trade_invoice_lines SET line_total_ex = 101 WHERE id = rejected_line;
  PERFORM pg_temp.zztest_assert((public.trade_send_totals(send)->>'declined_ex')::numeric = 150,
    'rejected amount stopped reading sent money');
  UPDATE public.trade_invoice_lines SET office_review_status = 'approved'
    WHERE id = rejected_line;
  PERFORM pg_temp.zztest_assert(public.trade_send_totals(send)->'balanced' = 'false'::jsonb,
    'unexplained money reads balanced');

  PERFORM pg_temp.zztest_refuses(format(
    'INSERT INTO public.trade_held_line_notes(line_id,user_id) VALUES (%L,%L)',
    waiting_line, crew), '23514');
  INSERT INTO public.trade_held_line_notes (line_id, user_id, note)
    VALUES (waiting_line, crew, 'ZZTEST office question') RETURNING id INTO note_id;
  PERFORM pg_temp.zztest_assert(NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.trade_held_line_notes'::regclass
      AND NOT tgisinternal), 'note trigger was installed by merge');
  PERFORM public.install_trade_line_hold();
  PERFORM public.install_trade_line_hold();
  PERFORM pg_temp.zztest_refuses(format(
    'UPDATE public.trade_held_line_notes SET note = %L WHERE id = %L',
    'ZZTEST overwritten', note_id), '55000');
  PERFORM pg_temp.zztest_refuses(format(
    'DELETE FROM public.trade_held_line_notes WHERE id = %L', note_id), '55000');
  PERFORM public.remove_trade_line_hold();
  PERFORM pg_temp.zztest_assert(NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.trade_held_line_notes'::regclass
      AND NOT tgisinternal), 'remove left the note trigger installed');
  INSERT INTO public.not_job_work_types (org_id, label, division)
    VALUES (org, 'ZZTEST not job work', 'ZZTEST');
  PERFORM pg_temp.zztest_assert(EXISTS (
    SELECT 1 FROM public.feature_flags WHERE flag_name = 'trade_line_hold_v1' AND NOT enabled),
    'hold switch not seeded off');
END $$;
DO $$
DECLARE
  tab text;
BEGIN
  FOREACH tab IN ARRAY ARRAY['not_job_work_types','trade_held_line_notes'] LOOP
    PERFORM pg_temp.zztest_assert((SELECT relrowsecurity FROM pg_class
      WHERE oid = ('public.' || tab)::regclass), tab || ' has no RLS');
    PERFORM pg_temp.zztest_assert(
      NOT has_table_privilege('anon', 'public.' || tab, 'SELECT') AND
      NOT has_table_privilege('authenticated', 'public.' || tab, 'INSERT') AND
      NOT has_table_privilege('service_role', 'public.' || tab, 'DELETE') AND
      has_table_privilege('service_role', 'public.' || tab, 'SELECT') AND
      has_table_privilege('service_role', 'public.' || tab, 'INSERT'), tab || ' grants');
  END LOOP;
  PERFORM pg_temp.zztest_assert(
    has_column_privilege('service_role','public.not_job_work_types','active','UPDATE') AND
    has_column_privilege('service_role','public.not_job_work_types','label','UPDATE') AND
    NOT has_column_privilege('service_role','public.not_job_work_types','division','UPDATE') AND
    NOT has_table_privilege('service_role','public.trade_held_line_notes','UPDATE'),
    'service update privileges exceed the ticket');
  PERFORM pg_temp.zztest_assert(
    NOT has_function_privilege('anon','public.trade_send_totals(uuid)','EXECUTE') AND
    NOT has_function_privilege('authenticated','public.trade_send_totals(uuid)','EXECUTE') AND
    has_function_privilege('service_role','public.trade_send_totals(uuid)','EXECUTE'),
    'send totals execute grants');
END $$;
SELECT 'ZZTEST P1-05.6 contract passed' AS result;
ROLLBACK;
