-- Trade recurring deductions (20261013143700): the rule as data, what an
-- invoice carries, once per invoice week, never above the amount payable, the
-- stamping persist, and the first deduction (Ute hire) seeded for one trade.
-- Everything below, including the second run of the migration, is rolled back.
BEGIN;

-- 1. The first deduction: $100 for the invoice week starting Monday
--    12 Oct 2026 only, $200 for every invoice week from Monday 19 Oct 2026,
--    for the one trade, on. Nobody else has a row.
DO $$
DECLARE
  seeded text;
  others integer;
BEGIN
  SELECT string_agg(
    concat_ws('|', label, amount, first_week_start, COALESCE(last_week_start::text, 'open'), active),
    ' ; ' ORDER BY first_week_start
  ) INTO seeded
  FROM public.trade_recurring_deductions
  WHERE user_id = '1de0c710-0000-4000-8000-000000000001';
  IF seeded IS DISTINCT FROM
     'Ute hire|100.00|2026-10-12|2026-10-12|t ; Ute hire|200.00|2026-10-19|open|t' THEN
    RAISE EXCEPTION 'the Ute hire rows are not $100 for the week of 12 Oct 2026 then $200 from 19 Oct 2026: %', seeded;
  END IF;
  SELECT count(*) INTO others
  FROM public.trade_recurring_deductions
  WHERE user_id <> '1de0c710-0000-4000-8000-000000000001';
  IF others <> 0 THEN
    RAISE EXCEPTION 'the migration gave % other trade(s) a deduction', others;
  END IF;
END;
$$;

-- 2. Nothing saved before the migration was given a deduction or a note.
DO $$
DECLARE
  touched integer;
BEGIN
  SELECT count(*) INTO touched
  FROM public.trade_invoices
  WHERE recurring_deduction_id IS NOT NULL OR recurring_deduction_label IS NOT NULL
     OR recurring_deduction_amount IS NOT NULL OR recurring_deduction_note IS NOT NULL;
  IF touched <> 0 THEN
    RAISE EXCEPTION 'the migration put a deduction on % existing invoice(s)', touched;
  END IF;
END;
$$;

-- 3. A rule is an amount above zero, a label, and Monday weeks in order.
CREATE FUNCTION pg_temp.rule_refused(
  p_label text, p_amount numeric, p_first date, p_last date
) RETURNS boolean
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO public.trade_recurring_deductions
    (user_id, label, amount, first_week_start, last_week_start)
  VALUES ('1de0c710-0000-4000-8000-000000000002', p_label, p_amount, p_first, p_last);
  RETURN false;
EXCEPTION WHEN check_violation THEN
  RETURN true;
END;
$$;

DO $$
BEGIN
  IF NOT pg_temp.rule_refused('Ute hire', 0, '2026-10-19', NULL) THEN
    RAISE EXCEPTION 'a deduction of zero was stored';
  END IF;
  IF NOT pg_temp.rule_refused('Ute hire', -200, '2026-10-19', NULL) THEN
    RAISE EXCEPTION 'a negative deduction was stored';
  END IF;
  IF NOT pg_temp.rule_refused('   ', 200, '2026-10-19', NULL) THEN
    RAISE EXCEPTION 'a deduction with no label was stored';
  END IF;
  IF NOT pg_temp.rule_refused('Ute hire', 200, '2026-10-20', NULL) THEN
    RAISE EXCEPTION 'a first week that is not a Monday was stored';
  END IF;
  IF NOT pg_temp.rule_refused('Ute hire', 200, '2026-10-19', '2026-10-28') THEN
    RAISE EXCEPTION 'a last week that is not a Monday was stored';
  END IF;
  IF NOT pg_temp.rule_refused('Ute hire', 200, '2026-10-19', '2026-10-12') THEN
    RAISE EXCEPTION 'a last week before the first week was stored';
  END IF;
  -- allowed: open ended, one week only, a run of weeks
  IF pg_temp.rule_refused('Tool hire', 50, '2026-10-19', NULL)
     OR pg_temp.rule_refused('Tool hire', 50, '2026-11-02', '2026-11-02')
     OR pg_temp.rule_refused('Tool hire', 50, '2026-11-09', '2026-12-07') THEN
    RAISE EXCEPTION 'a valid deduction row was refused';
  END IF;
END;
$$;
DELETE FROM public.trade_recurring_deductions
WHERE user_id = '1de0c710-0000-4000-8000-000000000002';

-- 4. The rule table is the office's: service role only, row security on.
DO $$
BEGIN
  IF has_table_privilege('anon', 'public.trade_recurring_deductions', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE')
     OR has_table_privilege('authenticated', 'public.trade_recurring_deductions', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE')
     OR NOT has_table_privilege('service_role', 'public.trade_recurring_deductions', 'SELECT, INSERT, UPDATE, DELETE') THEN
    RAISE EXCEPTION 'trade_recurring_deductions must be the service role''s only';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class
          WHERE oid = 'public.trade_recurring_deductions'::regclass) THEN
    RAISE EXCEPTION 'trade_recurring_deductions must have row level security on';
  END IF;
  IF has_function_privilege('anon', 'public.persist_weekly_trade_invoice_v3(jsonb, jsonb, uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.persist_weekly_trade_invoice_v3(jsonb, jsonb, uuid)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.persist_weekly_trade_invoice_v3(jsonb, jsonb, uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'persist_weekly_trade_invoice_v3 must be callable by service_role only';
  END IF;
END;
$$;

-- 5. What an invoice carries: all three or none, only with an invoice week,
--    never more than the amount payable (net pay + GST).
-- One invoice whose own money is consistent (super 12%, worker share 6%, GST
-- 10% when on), so a refusal below is this migration's check and no other:
-- the outcome names the constraint that refused.
CREATE FUNCTION pg_temp.invoice_outcome(
  p_id uuid, p_user uuid, p_week_start date, p_status text,
  p_rule uuid, p_label text, p_amount numeric,
  p_gross numeric DEFAULT 1000, p_gst_on boolean DEFAULT false
) RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  v_gst numeric := CASE WHEN p_gst_on THEN round(p_gross * 0.10, 2) ELSE 0 END;
  v_constraint text;
BEGIN
  INSERT INTO public.trade_invoices (
    id, org_id, user_id, week_start, week_end, status, invoice_source,
    subtotal_ex, gst, total_inc, gst_on, super_rate, super_amount, gross_earned, net_pay,
    recurring_deduction_id, recurring_deduction_label, recurring_deduction_amount
  ) VALUES (
    p_id, 'f0000000-0000-4000-8000-0000000000aa', p_user, p_week_start,
    p_week_start + 6, p_status, 'hourly',
    p_gross, v_gst, p_gross + v_gst, p_gst_on, 0.12, round(p_gross * 0.12, 2), p_gross,
    round(p_gross * 0.94, 2),
    p_rule, p_label, p_amount
  );
  RETURN 'stored';
EXCEPTION
  WHEN check_violation THEN
    GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
    RETURN 'check:' || v_constraint;
  WHEN unique_violation THEN
    GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
    RETURN 'unique:' || v_constraint;
END;
$$;

DO $$
DECLARE
  v_rule_100 uuid;
  v_rule_200 uuid;
  v_ute uuid := '1de0c710-0000-4000-8000-000000000001';
  v_other uuid := '1de0c710-0000-4000-8000-000000000002';
  v_out text;
BEGIN
  SELECT id INTO v_rule_100 FROM public.trade_recurring_deductions
  WHERE user_id = v_ute AND first_week_start = '2026-10-12';
  SELECT id INTO v_rule_200 FROM public.trade_recurring_deductions
  WHERE user_id = v_ute AND first_week_start = '2026-10-19';

  -- half-filled, weekless and above-the-payable are all refused
  v_out := pg_temp.invoice_outcome('2de0c710-0000-4000-8000-0000000000a1', v_ute, '2026-10-12', 'approved', v_rule_100, NULL, 100);
  IF v_out <> 'check:trade_invoices_recurring_deduction_check' THEN RAISE EXCEPTION 'a deduction with no label was stored (%)', v_out; END IF;
  v_out := pg_temp.invoice_outcome('2de0c710-0000-4000-8000-0000000000a2', v_ute, '2026-10-12', 'approved', v_rule_100, 'Ute hire', NULL);
  IF v_out <> 'check:trade_invoices_recurring_deduction_check' THEN RAISE EXCEPTION 'a deduction with no amount was stored (%)', v_out; END IF;
  v_out := pg_temp.invoice_outcome('2de0c710-0000-4000-8000-0000000000a3', v_ute, '2026-10-12', 'approved', NULL, 'Ute hire', 100);
  IF v_out <> 'check:trade_invoices_recurring_deduction_check' THEN RAISE EXCEPTION 'a deduction with no rule was stored (%)', v_out; END IF;
  v_out := pg_temp.invoice_outcome('2de0c710-0000-4000-8000-0000000000a4', v_ute, '2026-10-12', 'approved', v_rule_100, 'Ute hire', 0);
  IF v_out <> 'check:trade_invoices_recurring_deduction_check' THEN RAISE EXCEPTION 'a zero deduction was stored (%)', v_out; END IF;
  v_out := pg_temp.invoice_outcome('2de0c710-0000-4000-8000-0000000000a5', v_ute, NULL, 'approved', v_rule_100, 'Ute hire', 100);
  IF v_out <> 'check:trade_invoices_recurring_deduction_check' THEN RAISE EXCEPTION 'a deduction on an invoice with no week was stored (%)', v_out; END IF;
  -- $50 gross, GST on: net pay $47, GST $5. A $100 deduction would make a
  -- negative invoice, and so would one cent more than the $52 payable.
  v_out := pg_temp.invoice_outcome('2de0c710-0000-4000-8000-0000000000a6', v_ute, '2026-10-12', 'approved', v_rule_100, 'Ute hire', 100, 50, true);
  IF v_out <> 'check:trade_invoices_recurring_deduction_check' THEN RAISE EXCEPTION 'a deduction above the amount payable was stored (%)', v_out; END IF;
  v_out := pg_temp.invoice_outcome('2de0c710-0000-4000-8000-0000000000a7', v_ute, '2026-10-12', 'approved', v_rule_100, 'Ute hire', 52.01, 50, true);
  IF v_out <> 'check:trade_invoices_recurring_deduction_check' THEN RAISE EXCEPTION 'a deduction above the amount payable was stored (%)', v_out; END IF;

  -- 6. Once per invoice week.
  v_out := pg_temp.invoice_outcome('2de0c710-0000-4000-8000-0000000000b1', v_ute, '2026-10-12', 'approved', v_rule_100, 'Ute hire', 100);
  IF v_out <> 'stored' THEN RAISE EXCEPTION 'this week''s invoice could not carry the $100 (%)', v_out; END IF;
  v_out := pg_temp.invoice_outcome('2de0c710-0000-4000-8000-0000000000b2', v_ute, '2026-10-12', 'pushed_to_xero', v_rule_100, 'Ute hire', 100);
  IF v_out <> 'unique:trade_invoices_one_recurring_deduction_per_week' THEN
    RAISE EXCEPTION 'a second live invoice in the same week carried the deduction (%)', v_out;
  END IF;
  -- the same week without the deduction is an ordinary second invoice
  v_out := pg_temp.invoice_outcome('2de0c710-0000-4000-8000-0000000000b3', v_ute, '2026-10-12', 'pushed_to_xero', NULL, NULL, NULL);
  IF v_out <> 'stored' THEN RAISE EXCEPTION 'a second invoice without the deduction was refused (%)', v_out; END IF;
  -- a draft and a rejected copy are released: they never hold the week
  v_out := pg_temp.invoice_outcome('2de0c710-0000-4000-8000-0000000000b4', v_ute, '2026-10-12', 'draft', v_rule_100, 'Ute hire', 100);
  IF v_out <> 'stored' THEN RAISE EXCEPTION 'a draft of the same week could not show the deduction (%)', v_out; END IF;
  v_out := pg_temp.invoice_outcome('2de0c710-0000-4000-8000-0000000000b5', v_ute, '2026-10-12', 'ops-reject', v_rule_100, 'Ute hire', 100);
  IF v_out <> 'stored' THEN RAISE EXCEPTION 'a rejected copy of the same week was refused (%)', v_out; END IF;
  -- the next week carries its own $200; exactly the payable is allowed
  v_out := pg_temp.invoice_outcome('2de0c710-0000-4000-8000-0000000000b6', v_ute, '2026-10-19', 'approved', v_rule_200, 'Ute hire', 200);
  IF v_out <> 'stored' THEN RAISE EXCEPTION 'next week''s invoice could not carry the $200 (%)', v_out; END IF;
  -- $50 gross, GST on: payable $52.00, and a deduction of exactly that pays $0
  v_out := pg_temp.invoice_outcome('2de0c710-0000-4000-8000-0000000000b7', v_ute, '2026-10-26', 'approved', v_rule_200, 'Ute hire', 52, 50, true);
  IF v_out <> 'stored' THEN RAISE EXCEPTION 'a deduction equal to the amount payable was refused (%)', v_out; END IF;
  -- another trade's invoices are not in the index at all
  v_out := pg_temp.invoice_outcome('2de0c710-0000-4000-8000-0000000000c1', v_other, '2026-10-12', 'approved', NULL, NULL, NULL);
  IF v_out <> 'stored' THEN RAISE EXCEPTION 'another trade''s invoice was refused (%)', v_out; END IF;
  v_out := pg_temp.invoice_outcome('2de0c710-0000-4000-8000-0000000000c2', v_other, '2026-10-12', 'approved', NULL, NULL, NULL);
  IF v_out <> 'stored' THEN RAISE EXCEPTION 'another trade''s second invoice was refused (%)', v_out; END IF;

  -- a released copy cannot be made live again beside the invoice holding the week
  BEGIN
    UPDATE public.trade_invoices SET status = 'approved'
    WHERE id = '2de0c710-0000-4000-8000-0000000000b4';
    RAISE EXCEPTION 'a draft was made live beside the invoice already carrying the week''s deduction';
  EXCEPTION WHEN unique_violation THEN
    NULL;
  END;
  -- a rule an invoice carries cannot be deleted from under it
  BEGIN
    DELETE FROM public.trade_recurring_deductions WHERE id = v_rule_100;
    RAISE EXCEPTION 'a rule row was deleted while an invoice carries it';
  EXCEPTION WHEN foreign_key_violation THEN
    NULL;
  END;
END;
$$;

-- 7. The dated persist stamps what the invoice carries, through the unchanged
--    v2 and v1 persists, and leaves an invoice with none alone.
DO $$
DECLARE
  v_header jsonb;
  v_lines jsonb;
  v_rule_100 uuid;
  v_draft uuid;
  v_replacement uuid;
  v_plain uuid;
  v_noted uuid;
  v_row record;
BEGIN
  SELECT id INTO v_rule_100 FROM public.trade_recurring_deductions
  WHERE user_id = '1de0c710-0000-4000-8000-000000000001' AND first_week_start = '2026-10-12';
  -- clear the week's fixtures above: v1 allows one draft per trade and week
  DELETE FROM public.trade_invoices
  WHERE user_id = '1de0c710-0000-4000-8000-000000000001' AND week_start = '2026-10-12';

  v_header := jsonb_build_object(
    'org_id', 'f0000000-0000-4000-8000-0000000000aa',
    'user_id', '1de0c710-0000-4000-8000-000000000001',
    'week_start', '2026-10-12',
    'week_end', '2026-10-18',
    'total_hours', 8,
    'total_breaks_minutes', 0,
    'subtotal_ex', 400,
    'gst', 0,
    'total_inc', 400,
    'gst_on', false,
    'super_rate', 0.12,
    'super_amount', 48,
    'gross_earned', 400,
    'net_pay', 376,
    'invoice_source', 'hourly',
    'status', 'draft'
  );
  v_lines := jsonb_build_array(
    jsonb_build_object(
      'job_id', 'f2000000-0000-4000-8000-000000000001', 'job_number', 'SWF-TIME-1',
      'line_type', 'labour', 'total_hours', 8, 'hourly_rate', 50, 'line_total_ex', 400,
      'work_date', '2026-10-12', 'start_time', '07:00', 'finish_time', '15:00',
      'break_minutes', 0
    )
  );

  v_draft := public.persist_weekly_trade_invoice_v3(
    v_header || jsonb_build_object(
      'recurring_deduction_id', v_rule_100,
      'recurring_deduction_label', 'Ute hire',
      'recurring_deduction_amount', 100,
      'recurring_deduction_note', NULL
    ),
    v_lines, NULL
  );
  SELECT * INTO v_row FROM public.trade_invoices WHERE id = v_draft;
  IF v_row.recurring_deduction_id IS DISTINCT FROM v_rule_100
     OR v_row.recurring_deduction_label IS DISTINCT FROM 'Ute hire'
     OR v_row.recurring_deduction_amount IS DISTINCT FROM 100
     OR v_row.recurring_deduction_note IS NOT NULL THEN
    RAISE EXCEPTION 'the dated persist did not stamp the deduction: %',
      concat_ws('|', v_row.recurring_deduction_id, v_row.recurring_deduction_label, v_row.recurring_deduction_amount);
  END IF;
  -- the money columns and the line are v1's and v2's, untouched
  IF v_row.subtotal_ex <> 400 OR v_row.net_pay <> 376 OR v_row.gst <> 0 OR v_row.total_inc <> 400
     OR (SELECT count(*) FROM public.trade_invoice_lines
         WHERE trade_invoice_id = v_draft AND line_total_ex = 400 AND start_time = '07:00') <> 1 THEN
    RAISE EXCEPTION 'the deduction changed the invoice''s own money or lines';
  END IF;

  -- a redraft replaces the draft: one invoice, one deduction
  v_replacement := public.persist_weekly_trade_invoice_v3(
    v_header || jsonb_build_object(
      'recurring_deduction_id', v_rule_100,
      'recurring_deduction_label', 'Ute hire',
      'recurring_deduction_amount', 100
    ),
    v_lines, v_draft
  );
  IF v_replacement = v_draft
     OR EXISTS (SELECT 1 FROM public.trade_invoices WHERE id = v_draft)
     OR (SELECT count(*) FROM public.trade_invoices
         WHERE user_id = '1de0c710-0000-4000-8000-000000000001'
           AND week_start = '2026-10-12' AND recurring_deduction_amount = 100) <> 1 THEN
    RAISE EXCEPTION 'a redraft through v3 did not keep exactly one invoice carrying the deduction';
  END IF;

  -- not taken: only the reason is stored
  v_noted := public.persist_weekly_trade_invoice_v3(
    v_header || jsonb_build_object(
      'recurring_deduction_id', NULL,
      'recurring_deduction_label', NULL,
      'recurring_deduction_amount', NULL,
      'recurring_deduction_note', 'Ute hire $100.00 NOT taken: the amount payable is less than the deduction.'
    ),
    v_lines, v_replacement
  );
  SELECT * INTO v_row FROM public.trade_invoices WHERE id = v_noted;
  IF v_row.recurring_deduction_id IS NOT NULL OR v_row.recurring_deduction_amount IS NOT NULL
     OR v_row.recurring_deduction_note NOT LIKE 'Ute hire $100.00 NOT taken%' THEN
    RAISE EXCEPTION 'a deduction that was not taken did not store only its reason';
  END IF;

  -- another trade: no keys sent, nothing stamped
  v_plain := public.persist_weekly_trade_invoice_v3(
    v_header || jsonb_build_object('user_id', '1de0c710-0000-4000-8000-000000000002'),
    v_lines, NULL
  );
  SELECT * INTO v_row FROM public.trade_invoices WHERE id = v_plain;
  IF v_row.recurring_deduction_id IS NOT NULL OR v_row.recurring_deduction_label IS NOT NULL
     OR v_row.recurring_deduction_amount IS NOT NULL OR v_row.recurring_deduction_note IS NOT NULL
     OR v_row.net_pay <> 376 THEN
    RAISE EXCEPTION 'another trade''s invoice was changed by the stamping persist';
  END IF;

  -- the table's own check still runs inside v3: nothing above the payable
  BEGIN
    PERFORM public.persist_weekly_trade_invoice_v3(
      v_header || jsonb_build_object(
        'recurring_deduction_id', v_rule_100,
        'recurring_deduction_label', 'Ute hire',
        'recurring_deduction_amount', 500
      ),
      v_lines, v_noted
    );
    RAISE EXCEPTION 'the stamping persist stored a deduction above the amount payable';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;
END;
$$;

-- 8. A second run changes nothing, and never undoes what the office changed:
--    a row switched off stays off, a changed amount stays changed.
UPDATE public.trade_recurring_deductions
SET active = false
WHERE user_id = '1de0c710-0000-4000-8000-000000000001' AND first_week_start = '2026-10-19';
UPDATE public.trade_recurring_deductions
SET amount = 120
WHERE user_id = '1de0c710-0000-4000-8000-000000000001' AND first_week_start = '2026-10-12';

\ir ../../../migrations/20261013143700_trade_recurring_deductions.sql

DO $$
DECLARE
  seeded text;
BEGIN
  SELECT string_agg(
    concat_ws('|', amount, first_week_start, active), ' ; ' ORDER BY first_week_start
  ) INTO seeded
  FROM public.trade_recurring_deductions
  WHERE user_id = '1de0c710-0000-4000-8000-000000000001';
  IF seeded IS DISTINCT FROM '120.00|2026-10-12|t ; 200.00|2026-10-19|f' THEN
    RAISE EXCEPTION 'a second run of the migration duplicated or reset the Ute hire rows: %', seeded;
  END IF;
  IF (SELECT count(*) FROM pg_constraint
      WHERE conname IN ('trade_invoices_recurring_deduction_check', 'trade_invoices_recurring_deduction_fk')) <> 2 THEN
    RAISE EXCEPTION 'a second run of the migration duplicated or lost the invoice constraints';
  END IF;
  IF has_table_privilege('anon', 'public.trade_recurring_deductions', 'SELECT')
     OR has_table_privilege('authenticated', 'public.trade_recurring_deductions', 'SELECT') THEN
    RAISE EXCEPTION 'a second run of the migration opened the rule table';
  END IF;
END;
$$;

ROLLBACK;
