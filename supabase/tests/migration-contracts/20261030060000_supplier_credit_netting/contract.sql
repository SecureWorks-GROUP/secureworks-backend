-- Contract for 20261030060000 (supplier credit netting, TP-07 slice 2).
-- Synthetic data only, inside one rolled-back transaction. The figures without
-- netting are read by running this migration's down inside a savepoint, so
-- "before" and "after" are the same rows on the same database.
--
-- Jobs: CNN-J0 (control, no credit), CNN-J1 .. CNN-J4.
-- Bills (ACCPAY, our copy of Xero, March 2032):
--   B0  300 ex / 330 inc on J0; no credit anywhere            (control)
--   B1  1000 / 1100 on J1; its copy shows no credit           (bill_side none)
--   B2  2000 / 2200 on J2; its CreditNotes list names CN-B 220 (counts_it)
--   B3  1000 / 1100 split by a person: J3 600, J4 400; its list names
--       another note (CN-X, not in our copy) 55                (not_this_one)
--   B4  500 / 550 on J1; no list, AmountCredited 55            (amount_credited)
--   B5  100 / 110 on J1; no credit on the bill
--   B6  installer bill (306) 300 / 330 on J2, nobody confirmed it (held)
--   B7  crew bill (a trade-app mirror line) 500 / 550 on J1
--   B8  200 / 220 on no job and in no allocation row          (not placed)
--   B9  org two, 100 / 110, so a read of every org needs org two's read too
-- Credit notes (through xero_supplier_credit_note_copy):
--   CN-A 110 -> B1      counted from the note: J1 -100.00
--   CN-B 220 -> B2      counted by the bill only (CFO-20 -200.00), once
--   CN-C 110 -> B3      counted from the note: J3 -60.00, J4 -40.00
--   CN-D  55 -> B4      counted by the bill's AmountCredited only
--   CN-E 110, CN-F 11 -> B5   together above B5's total: not counted
--   CN-G  33 -> B6      held with the bill (not actual)
--   CN-H  55 -> B7      crew_bill, unplaced
--   CN-I  22 -> B8      bill_not_placed
--   CN-J  44 left on the note                  unallocated
--   CN-K  66 refunded in cash (Payments)       cash_refund
--   CN-L  11 -> a bill not in our copy         bill_not_in_copy
--   CN-M  VOIDED 99 -> B1                      never counted
--   CN-N  33, its allocation deleted, 33 left  unallocated
--   CN-P  Feb 2032, 77 with 22 -> B8 and nothing else (does not add up)
--   CN-Q  Jan 2032, 88, Xero sent no RemainingCredit (unknown)
--   CN-U  no date, 22 left on the note
BEGIN;

INSERT INTO public.organisations (id, name) VALUES
  ('00000000-0000-0000-0000-000000000001', 'Synthetic org'),
  ('00000000-0000-0000-0000-0000000000c2', 'Synthetic org two')
ON CONFLICT (id) DO NOTHING;
INSERT INTO public.jobs (id, org_id, status, type, job_number) VALUES
  ('e7100000-0000-4000-8000-000000000000', '00000000-0000-0000-0000-000000000001', 'accepted', 'fencing', 'CNN-J0'),
  ('e7100000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000001', 'accepted', 'fencing', 'CNN-J1'),
  ('e7100000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000001', 'accepted', 'fencing', 'CNN-J2'),
  ('e7100000-0000-4000-8000-000000000003', '00000000-0000-0000-0000-000000000001', 'accepted', 'fencing', 'CNN-J3'),
  ('e7100000-0000-4000-8000-000000000004', '00000000-0000-0000-0000-000000000001', 'accepted', 'fencing', 'CNN-J4');
INSERT INTO public.xero_invoices (org_id, xero_invoice_id, invoice_number, invoice_type, status, contact_name, sub_total, total,
                                  invoice_date, line_items, raw_json, job_id) VALUES
  ('00000000-0000-0000-0000-000000000001', 'b7100000-0000-4000-8000-000000000000', 'CNN-B0', 'ACCPAY', 'AUTHORISED', 'Cnn Steel', 300, 330,
   '2032-03-02', '[{"Description": "Caps", "AccountCode": "310", "LineAmount": 300}]', '{"Total": 330}',
   'e7100000-0000-4000-8000-000000000000'),
  ('00000000-0000-0000-0000-000000000001', 'b7100000-0000-4000-8000-000000000001', 'CNN-B1', 'ACCPAY', 'AUTHORISED', 'Cnn Steel', 1000, 1100,
   '2032-03-03', '[{"Description": "Posts", "AccountCode": "310", "LineAmount": 1000}]', '{"Total": 1100}',
   'e7100000-0000-4000-8000-000000000001'),
  ('00000000-0000-0000-0000-000000000001', 'b7100000-0000-4000-8000-000000000002', 'CNN-B2', 'ACCPAY', 'PAID', 'Cnn Steel', 2000, 2200,
   '2032-03-04', '[{"Description": "Mesh", "AccountCode": "310", "LineAmount": 2000}]',
   '{"Total": 2200, "AmountCredited": 220, "CreditNotes": [{"CreditNoteID": "c7100000-0000-4000-8000-00000000000b", "AppliedAmount": 220}]}',
   'e7100000-0000-4000-8000-000000000002'),
  ('00000000-0000-0000-0000-000000000001', 'b7100000-0000-4000-8000-000000000003', 'CNN-B3', 'ACCPAY', 'AUTHORISED', 'Cnn Steel', 1000, 1100,
   '2032-03-05', '[{"Description": "Rails", "AccountCode": "310", "LineAmount": 1000}]',
   '{"Total": 1100, "CreditNotes": [{"CreditNoteID": "c7100000-0000-4000-8000-000000000099", "AppliedAmount": 55}]}', NULL),
  ('00000000-0000-0000-0000-000000000001', 'b7100000-0000-4000-8000-000000000004', 'CNN-B4', 'ACCPAY', 'AUTHORISED', 'Cnn Steel', 500, 550,
   '2032-03-06', '[{"Description": "Wire", "AccountCode": "310", "LineAmount": 500}]', '{"Total": 550, "AmountCredited": 55}',
   'e7100000-0000-4000-8000-000000000001'),
  ('00000000-0000-0000-0000-000000000001', 'b7100000-0000-4000-8000-000000000005', 'CNN-B5', 'ACCPAY', 'AUTHORISED', 'Cnn Steel', 100, 110,
   '2032-03-07', '[{"Description": "Clips", "AccountCode": "310", "LineAmount": 100}]', '{"Total": 110}',
   'e7100000-0000-4000-8000-000000000001'),
  ('00000000-0000-0000-0000-000000000001', 'b7100000-0000-4000-8000-000000000006', 'CNN-B6', 'ACCPAY', 'AUTHORISED', 'Cnn Installs', 300, 330,
   '2032-03-08', '[{"Description": "Install", "AccountCode": "306", "LineAmount": 300}]', '{"Total": 330}',
   'e7100000-0000-4000-8000-000000000002'),
  ('00000000-0000-0000-0000-000000000001', 'b7100000-0000-4000-8000-000000000007', 'CNN-B7', 'ACCPAY', 'AUTHORISED', 'Cnn Crew', 500, 550,
   '2032-03-09', '[{"Description": "Week pay | SW - FENCING", "AccountCode": "306", "LineAmount": 500}]', '{"Total": 550}',
   'e7100000-0000-4000-8000-000000000001'),
  ('00000000-0000-0000-0000-000000000001', 'b7100000-0000-4000-8000-000000000008', 'CNN-B8', 'ACCPAY', 'AUTHORISED', 'Cnn Steel', 200, 220,
   '2032-03-10', '[{"Description": "Sand", "AccountCode": "310", "LineAmount": 200}]', '{"Total": 220}', NULL),
  ('00000000-0000-0000-0000-0000000000c2', 'b7100000-0000-4000-8000-0000000000c2', 'CNN-B9', 'ACCPAY', 'AUTHORISED', 'Cnn Steel', 100, 110,
   '2032-03-11', '[{"Description": "Bolts", "AccountCode": "310", "LineAmount": 100}]', '{"Total": 110}', NULL);
INSERT INTO public.job_materials_facts (xero_invoice_id, invoice_number, job_id, job_number, lane, kind, amount_ex_gst, confidence, automation_source, fact_date) VALUES
  ('b7100000-0000-4000-8000-000000000003', 'CNN-B3', 'e7100000-0000-4000-8000-000000000003', 'CNN-J3', 'materials', 'actual', 600, 'high_manual', 'manual_split', '2032-03-05'),
  ('b7100000-0000-4000-8000-000000000003', 'CNN-B3', 'e7100000-0000-4000-8000-000000000004', 'CNN-J4', 'materials', 'actual', 400, 'high_manual', 'manual_split', '2032-03-05');

CREATE FUNCTION pg_temp.nn(label text, status text, total numeric, remaining numeric, day text DEFAULT '2032-03-12', extra jsonb DEFAULT '{}')
RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_strip_nulls(jsonb_build_object(
    'xero_credit_note_id', 'c7100000-0000-4000-8000-0000000000' || CASE label
        WHEN 'A' THEN '0a' WHEN 'B' THEN '0b' WHEN 'C' THEN '0c' WHEN 'D' THEN '0d' WHEN 'E' THEN '0e' WHEN 'F' THEN '0f'
        WHEN 'G' THEN '10' WHEN 'H' THEN '11' WHEN 'I' THEN '12' WHEN 'J' THEN '13' WHEN 'K' THEN '14' WHEN 'L' THEN '15'
        WHEN 'M' THEN '16' WHEN 'N' THEN '17' WHEN 'P' THEN '18' WHEN 'Q' THEN '19' WHEN 'U' THEN '1a' END,
    'credit_note_type', 'ACCPAYCREDIT', 'credit_note_number', 'CNN-' || label,
    'xero_contact_id', 'dddddddd-0000-4000-8000-000000000071', 'contact_name', 'Cnn Steel',
    'credit_note_date', day, 'status', status, 'currency_code', 'AUD',
    'sub_total', round(total / 1.1, 2), 'total_tax', total - round(total / 1.1, 2), 'total', total,
    'remaining_credit', remaining, 'xero_updated_at', '2032-03-12T00:00:00Z',
    'raw_json', jsonb_build_object('Type', 'ACCPAYCREDIT') || extra))
$$;
CREATE FUNCTION pg_temp.na(bill text, amount numeric, deleted boolean DEFAULT false)
RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_strip_nulls(jsonb_build_object('xero_invoice_id', 'b7100000-0000-4000-8000-0000000000' || bill, 'amount', amount,
                                               'allocation_date', '2032-03-12', 'is_deleted', deleted,
                                               'raw_json', jsonb_build_object('Amount', amount)))
$$;

DO $$
DECLARE
  org uuid := '00000000-0000-0000-0000-000000000001';
BEGIN
  PERFORM public.xero_supplier_credit_note_copy(org, pg_temp.nn('A', 'AUTHORISED', 110, 0), jsonb_build_array(pg_temp.na('01', 110)));
  PERFORM public.xero_supplier_credit_note_copy(org, pg_temp.nn('B', 'PAID', 220, 0), jsonb_build_array(pg_temp.na('02', 220)));
  PERFORM public.xero_supplier_credit_note_copy(org, pg_temp.nn('C', 'PAID', 110, 0), jsonb_build_array(pg_temp.na('03', 110)));
  PERFORM public.xero_supplier_credit_note_copy(org, pg_temp.nn('D', 'PAID', 55, 0), jsonb_build_array(pg_temp.na('04', 55)));
  PERFORM public.xero_supplier_credit_note_copy(org, pg_temp.nn('E', 'PAID', 110, 0), jsonb_build_array(pg_temp.na('05', 110)));
  PERFORM public.xero_supplier_credit_note_copy(org, pg_temp.nn('F', 'PAID', 11, 0), jsonb_build_array(pg_temp.na('05', 11)));
  PERFORM public.xero_supplier_credit_note_copy(org, pg_temp.nn('G', 'PAID', 33, 0), jsonb_build_array(pg_temp.na('06', 33)));
  PERFORM public.xero_supplier_credit_note_copy(org, pg_temp.nn('H', 'PAID', 55, 0), jsonb_build_array(pg_temp.na('07', 55)));
  PERFORM public.xero_supplier_credit_note_copy(org, pg_temp.nn('I', 'PAID', 22, 0), jsonb_build_array(pg_temp.na('08', 22)));
  PERFORM public.xero_supplier_credit_note_copy(org, pg_temp.nn('J', 'AUTHORISED', 44, 44), '[]');
  PERFORM public.xero_supplier_credit_note_copy(org, pg_temp.nn('K', 'PAID', 66, 0, '2032-03-12',
            '{"Payments": [{"PaymentID": "eeeeeeee-0000-4000-8000-000000000071", "Amount": 66, "Date": "/Date(1962489600000+0000)/"}]}'), '[]');
  PERFORM public.xero_supplier_credit_note_copy(org, pg_temp.nn('L', 'PAID', 11, 0), jsonb_build_array(pg_temp.na('ff', 11)));
  PERFORM public.xero_supplier_credit_note_copy(org, pg_temp.nn('M', 'VOIDED', 99, 0), jsonb_build_array(pg_temp.na('01', 99)));
  PERFORM public.xero_supplier_credit_note_copy(org, pg_temp.nn('N', 'AUTHORISED', 33, 33), jsonb_build_array(pg_temp.na('01', 33, true)));
  PERFORM public.xero_supplier_credit_note_copy(org, pg_temp.nn('P', 'PAID', 77, 0, '2032-02-12'), jsonb_build_array(pg_temp.na('08', 22)));
  PERFORM public.xero_supplier_credit_note_copy(org, pg_temp.nn('Q', 'AUTHORISED', 88, NULL, '2032-01-12'), '[]');
  PERFORM public.xero_supplier_credit_note_copy(org, pg_temp.nn('U', 'AUTHORISED', 22, 22, NULL), '[]');
END $$;

-- 1. One allocation, counted once. CN-B is listed on B2's own copy, so CFO-20
--    already takes it off J2 (-200.00); the credit note side adds nothing.
DO $$
DECLARE got text;
BEGIN
  SELECT string_agg(concat_ws(':', e.job_id, e.amount_ex, e.source, e.match_method), ' ' ORDER BY e.source_id) INTO got
    FROM public.v_job_cost_events e
   WHERE e.document_id = 'b7100000-0000-4000-8000-000000000002' AND e.amount_ex < 0;
  IF got IS DISTINCT FROM 'e7100000-0000-4000-8000-000000000002:-200.00:supplier_credit:xero_amount_credited' THEN
    RAISE EXCEPTION 'supplier credit netting: CN-B on B2 is not counted exactly once (by the bill): %', got;
  END IF;
  -- The same for B4: its AmountCredited counts every note on it together.
  SELECT string_agg(concat_ws(':', e.amount_ex, e.match_method), ' ') INTO got
    FROM public.v_job_cost_events e
   WHERE e.document_id = 'b7100000-0000-4000-8000-000000000004' AND e.amount_ex < 0;
  IF got IS DISTINCT FROM '-50.00:xero_amount_credited' THEN
    RAISE EXCEPTION 'supplier credit netting: CN-D on B4 is not counted exactly once (by the bill): %', got;
  END IF;
END $$;

-- What Job Profit shows with netting, for the comparisons in section 4.
CREATE TEMP TABLE nn_jobs ON COMMIT DROP AS
SELECT j.id AS job_id, j.job_number FROM public.jobs j WHERE j.job_number LIKE 'CNN-J%';
CREATE TEMP TABLE nn_with ON COMMIT DROP AS
SELECT j.job_number,
       (SELECT md5(COALESCE(string_agg(row(e.*)::text, '|' ORDER BY row(e.*)::text COLLATE "C"), ''))
          FROM public.v_job_cost_events e WHERE e.job_id = j.job_id) AS events_md5,
       (SELECT md5(COALESCE(string_agg(row(e.*)::text, '|' ORDER BY row(e.*)::text COLLATE "C"), ''))
          FROM public.v_job_cost_events e WHERE e.job_id = j.job_id AND e.match_method IS DISTINCT FROM 'xero_credit_note') AS events_less_note_md5,
       (SELECT count(*) FROM public.v_job_cost_events e WHERE e.job_id = j.job_id AND e.match_method = 'xero_credit_note') AS note_rows,
       (SELECT md5(row(p.*)::text) FROM public.v_job_profit p WHERE p.job_id = j.job_id) AS profit_md5,
       (SELECT p.actual_materials_ex FROM public.v_job_profit p WHERE p.job_id = j.job_id) AS materials_ex,
       (SELECT p.actual_cost_ex FROM public.v_job_profit p WHERE p.job_id = j.job_id) AS cost_ex
  FROM nn_jobs j;
CREATE TEMP TABLE nn_tieout ON COMMIT DROP AS
SELECT public.xero_tieout_monthly('2032-03-15', 3, '00000000-0000-0000-0000-000000000001')::text AS org_doc,
       public.xero_tieout_monthly('2032-03-15', 3, NULL)::text AS all_doc;

-- 2. Where each part lands, and who counts it.
CREATE TEMP TABLE nn_place ON COMMIT DROP AS
SELECT p.credit_note_number AS cn, p.state, j.job_number AS job, p.amount, p.credit_ex, p.counted_ex, p.job_profit, p.bill_side,
       p.part_is_actual, p.part_key, p.allocation_date, p.allocation_id
  FROM public.v_supplier_credit_placement p
  LEFT JOIN public.jobs j ON j.id = p.job_id
 WHERE p.org_id = '00000000-0000-0000-0000-000000000001' AND p.credit_note_number LIKE 'CNN-%';

DO $$
DECLARE got text;
BEGIN
  SELECT string_agg(concat_ws(':', cn, state, job, job_profit, bill_side, credit_ex, COALESCE(counted_ex::text, '-')), ' ' ORDER BY cn, job) INTO got
    FROM nn_place WHERE job IS NOT NULL;
  IF got IS DISTINCT FROM
     'CNN-A:placed:CNN-J1:counted_from_credit_note:none:100.00:100.00'
     || ' CNN-B:placed:CNN-J2:counted_by_bill:counts_it:200.00:-'
     || ' CNN-C:placed:CNN-J3:counted_from_credit_note:not_this_one:60.00:60.00'
     || ' CNN-C:placed:CNN-J4:counted_from_credit_note:not_this_one:40.00:40.00'
     || ' CNN-D:placed:CNN-J1:bill_amount_credited:amount_credited:50.00:-'
     || ' CNN-E:placed:CNN-J1:exceeds_bill:none:100.00:-'
     || ' CNN-F:placed:CNN-J1:exceeds_bill:none:10.00:-'
     || ' CNN-G:placed:CNN-J2:counted_from_credit_note:none:30.00:0' THEN
    RAISE EXCEPTION 'supplier credit netting: placed rows %', got;
  END IF;
  IF (SELECT part_is_actual FROM nn_place WHERE cn = 'CNN-G') IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'supplier credit netting: CN-G is not shown held with its installer bill';
  END IF;
  -- Unplaced parts: no job, not counted, each with its reason and amount.
  SELECT string_agg(concat_ws(':', cn, state, job_profit, COALESCE(amount::text, 'unknown'), part_key), ' ' ORDER BY cn, part_key) INTO got
    FROM nn_place WHERE job IS NULL;
  IF got IS DISTINCT FROM
     'CNN-H:crew_bill:not_counted:55.00:allocation:1'
     || ' CNN-I:bill_not_placed:not_counted:22.00:allocation:1'
     || ' CNN-J:unallocated:not_counted:44.00:remaining'
     || ' CNN-K:cash_refund:not_counted:66:refund:1'
     || ' CNN-L:bill_not_in_copy:not_counted:11.00:allocation:1'
     || ' CNN-M:credit_note_not_live:not_counted:99.00:allocation:1'
     || ' CNN-N:allocation_deleted:not_counted:33.00:allocation:1'
     || ' CNN-N:unallocated:not_counted:33.00:remaining'
     || ' CNN-P:bill_not_placed:not_counted:22.00:allocation:1'
     || ' CNN-Q:remaining_unknown:not_counted:unknown:remaining'
     || ' CNN-U:unallocated:not_counted:22.00:remaining' THEN
    RAISE EXCEPTION 'supplier credit netting: unplaced rows %', got;
  END IF;
  IF (SELECT concat_ws(':', allocation_date, allocation_id) FROM nn_place WHERE cn = 'CNN-K')
     IS DISTINCT FROM '2032-03-10:eeeeeeee-0000-4000-8000-000000000071' THEN
    RAISE EXCEPTION 'supplier credit netting: the refund''s day or Xero id was not read';
  END IF;
  IF EXISTS (SELECT 1 FROM nn_place WHERE (job_profit = 'not_counted') <> (job IS NULL)
                                       OR (job IS NULL AND counted_ex IS NOT NULL)
                                       OR (state IN ('unallocated', 'cash_refund') AND amount IS NOT NULL AND amount <= 0)) THEN
    RAISE EXCEPTION 'supplier credit netting: an unplaced part got a job or a counted figure, or shows $0';
  END IF;
END $$;

-- 3. The engine's credit note rows: exactly the allocations counted from the
--    note, on the bill's own rows, never an unplaced one.
DO $$
DECLARE got text;
BEGIN
  SELECT string_agg(concat_ws(':', j.job_number, e.amount_ex, e.source, e.is_actual, e.event_date, e.lane, e.document_id, e.description),
                    ' | ' ORDER BY j.job_number, e.source_id) INTO got
    FROM public.v_job_cost_events e
    JOIN nn_jobs j ON j.job_id = e.job_id
   WHERE e.match_method = 'xero_credit_note';
  IF got IS DISTINCT FROM
     'CNN-J1:-100.00:supplier_credit:t:2032-03-03:materials:b7100000-0000-4000-8000-000000000001:Supplier credit note CNN-A applied in Xero'
     || ' | CNN-J2:-30.00:installer_bill_unconfirmed:f:2032-03-08:labour:b7100000-0000-4000-8000-000000000006:Supplier credit note CNN-G applied in Xero'
     || ' | CNN-J3:-60.00:supplier_credit:t:2032-03-05:materials:b7100000-0000-4000-8000-000000000003:Supplier credit note CNN-C applied in Xero'
     || ' | CNN-J4:-40.00:supplier_credit:t:2032-03-05:materials:b7100000-0000-4000-8000-000000000003:Supplier credit note CNN-C applied in Xero' THEN
    RAISE EXCEPTION 'supplier credit netting: credit note rows %', got;
  END IF;
  IF EXISTS (SELECT 1 FROM public.v_job_cost_events e
              WHERE e.match_method = 'xero_credit_note'
                AND e.document_id IN ('b7100000-0000-4000-8000-000000000002', 'b7100000-0000-4000-8000-000000000004',
                                      'b7100000-0000-4000-8000-000000000005', 'b7100000-0000-4000-8000-000000000007',
                                      'b7100000-0000-4000-8000-000000000008')) THEN
    RAISE EXCEPTION 'supplier credit netting: a credit counted by the bill, above the bill, on a crew bill or on an unplaced bill came from the note';
  END IF;
  -- The placement view's figure is the engine's, row for row.
  IF (SELECT sum(counted_ex) FROM nn_place WHERE job_profit = 'counted_from_credit_note')
     IS DISTINCT FROM -(SELECT sum(e.amount_ex) FROM public.v_job_cost_events e JOIN nn_jobs j ON j.job_id = e.job_id
                         WHERE e.match_method = 'xero_credit_note' AND e.is_actual) THEN
    RAISE EXCEPTION 'supplier credit netting: counted_ex is not what Job Profit takes off';
  END IF;
END $$;

-- 4. Without netting (this migration's down, inside a savepoint).
SAVEPOINT nn_without;
\ir ../../../rollbacks/20261030060000_supplier_credit_netting_down.sql
DO $$
DECLARE
  r record;
  w record;
BEGIN
  IF to_regclass('public.v_supplier_credit_allocations') IS NOT NULL THEN
    RAISE EXCEPTION 'supplier credit netting: the down left the side rule behind';
  END IF;
  IF (SELECT count(*) FROM nn_with) <> 5 THEN
    RAISE EXCEPTION 'supplier credit netting: fixture jobs missing from the comparison';
  END IF;
  FOR r IN SELECT n.*, j.job_id FROM nn_with n JOIN nn_jobs j ON j.job_number = n.job_number LOOP
    SELECT (SELECT md5(COALESCE(string_agg(row(e.*)::text, '|' ORDER BY row(e.*)::text COLLATE "C"), ''))
              FROM public.v_job_cost_events e WHERE e.job_id = r.job_id) AS events_md5,
           (SELECT md5(row(p.*)::text) FROM public.v_job_profit p WHERE p.job_id = r.job_id) AS profit_md5,
           (SELECT p.actual_materials_ex FROM public.v_job_profit p WHERE p.job_id = r.job_id) AS materials_ex,
           (SELECT p.actual_cost_ex FROM public.v_job_profit p WHERE p.job_id = r.job_id) AS cost_ex
      INTO w;
    -- Every other row is exactly as it was: netting only adds credit note rows.
    IF r.events_less_note_md5 IS DISTINCT FROM w.events_md5 THEN
      RAISE EXCEPTION 'supplier credit netting: % rows other than credit note rows changed', r.job_number;
    END IF;
    -- A job with no credit note row is the same, row for row, in both views.
    IF r.note_rows = 0 AND (r.events_md5 IS DISTINCT FROM w.events_md5 OR r.profit_md5 IS DISTINCT FROM w.profit_md5) THEN
      RAISE EXCEPTION 'supplier credit netting: % has no credit note row and still changed', r.job_number;
    END IF;
    -- Exactly the credit counted from the note comes off actual cost.
    IF (r.materials_ex - w.materials_ex, r.cost_ex - w.cost_ex) IS DISTINCT FROM
       (CASE r.job_number WHEN 'CNN-J1' THEN -100.00 WHEN 'CNN-J3' THEN -60.00 WHEN 'CNN-J4' THEN -40.00 ELSE 0 END,
        CASE r.job_number WHEN 'CNN-J1' THEN -100.00 WHEN 'CNN-J3' THEN -60.00 WHEN 'CNN-J4' THEN -40.00 ELSE 0 END) THEN
      RAISE EXCEPTION 'supplier credit netting: % cost moved by % (materials) and % (total)', r.job_number,
        r.materials_ex - w.materials_ex, r.cost_ex - w.cost_ex;
    END IF;
  END LOOP;
  -- J2's held credit (an installer bill nobody confirmed) moves no figure.
  IF (SELECT profit_md5 FROM nn_with WHERE job_number = 'CNN-J2')
     IS DISTINCT FROM (SELECT md5(row(p.*)::text) FROM public.v_job_profit p JOIN nn_jobs j ON j.job_id = p.job_id WHERE j.job_number = 'CNN-J2') THEN
    RAISE EXCEPTION 'supplier credit netting: a credit held with its bill moved Job Profit';
  END IF;
  -- Until a full credit note read, the tie-out is TP-01's, byte for byte.
  IF (SELECT org_doc FROM nn_tieout) IS DISTINCT FROM public.xero_tieout_monthly('2032-03-15', 3, '00000000-0000-0000-0000-000000000001')::text
     OR (SELECT all_doc FROM nn_tieout) IS DISTINCT FROM public.xero_tieout_monthly('2032-03-15', 3, NULL)::text THEN
    RAISE EXCEPTION 'supplier credit netting: the tie-out changed before credit notes were read';
  END IF;
END $$;
ROLLBACK TO SAVEPOINT nn_without;

-- 5. The tie-out once xero-sync has read every credit note of org one.
INSERT INTO public.xero_sync_state (key, cursor_at, note)
VALUES ('supplier_credit_notes_full:00000000-0000-0000-0000-000000000001:aaaaaaaa-0000-4000-8000-000000000071', '2032-03-20T00:00:00Z', 'synthetic');
DO $$
DECLARE
  v jsonb := public.xero_tieout_monthly('2032-03-15', 3, '00000000-0000-0000-0000-000000000001');
  before jsonb := (SELECT org_doc::jsonb FROM nn_tieout);
  m jsonb;
  c jsonb;
  i integer;
BEGIN
  IF v -> 'not_yet_read' @> '[{"part": "supplier_credit_notes"}]' OR NOT (v -> 'not_yet_read' @> '[{"part": "spend_money"}]')
     OR (v ->> 'complete')::boolean OR v ->> 'credit_notes_read_at' IS NULL OR v ->> 'covers' = 'bills only' THEN
    RAISE EXCEPTION 'supplier credit netting: tie-out top level %', v - 'months';
  END IF;
  IF v -> 'undated_credit_notes' IS DISTINCT FROM '{"count": 1, "inc": 22.00}'::jsonb THEN
    RAISE EXCEPTION 'supplier credit netting: undated notes %', v -> 'undated_credit_notes';
  END IF;
  -- The bills tie-out is unchanged and still reconciles.
  FOR i IN 0 .. jsonb_array_length(v -> 'months') - 1 LOOP
    IF (v -> 'months' -> i) - 'credit_notes' IS DISTINCT FROM (before -> 'months' -> i) - 'credit_notes' THEN
      RAISE EXCEPTION 'supplier credit netting: the bills tie-out of % moved', v -> 'months' -> i ->> 'month';
    END IF;
  END LOOP;
  SELECT x INTO m FROM jsonb_array_elements(v -> 'months') x WHERE x ->> 'month' = '2032-03';
  IF NOT (m -> 'bills' ->> 'parts_add_up')::boolean THEN
    RAISE EXCEPTION 'supplier credit netting: March bills do not add up';
  END IF;
  c := m -> 'credit_notes';
  IF c - 'basis' - 'parts_check' IS DISTINCT FROM jsonb_build_object(
       'status', 'read', 'ticket', 'TP-07', 'counted', false,
       'notes', 13, 'amount_unknown_count', 0, 'total_inc', 880.00, 'total_ex', 800.00, 'amount_ex', 800.00,
       'placed_inc', 649.00,
       'placed_by_job_profit', jsonb_build_object('counted_from_credit_note_inc', 253.00, 'counted_by_bill_inc', 220.00,
                                                  'bill_amount_credited_inc', 55.00, 'exceeds_bill_inc', 121.00),
       'on_job_ex', jsonb_build_object('counted_from_credit_note_ex', 200.00),
       'not_placed_inc', 88.00,
       'not_placed_by_reason', jsonb_build_object('bill_not_in_copy', 11.00, 'bill_not_live', 0, 'bill_total_unknown', 0,
                                                  'crew_bill', 55.00, 'bill_not_placed', 22.00, 'amount_not_positive', 0),
       'unallocated_inc', 77.00, 'cash_refund_inc', 66, 'unknown_parts', 0, 'unknown_notes', 0,
       'not_accounted_inc', 0.00, 'parts_add_up', true,
       'not_live', jsonb_build_object('notes', 1, 'inc', 99.00, 'counted', false)) THEN
    RAISE EXCEPTION 'supplier credit netting: March credit notes %', c;
  END IF;
  -- February: a note whose parts do not reach its total.
  SELECT x -> 'credit_notes' INTO c FROM jsonb_array_elements(v -> 'months') x WHERE x ->> 'month' = '2032-02';
  IF (c ->> 'parts_add_up')::boolean IS DISTINCT FROM false OR (c ->> 'not_accounted_inc')::numeric <> 55
     OR (c -> 'not_placed_by_reason' ->> 'bill_not_placed')::numeric <> 22 THEN
    RAISE EXCEPTION 'supplier credit netting: February credit notes %', c;
  END IF;
  -- January: a note Xero sent no remaining credit for: unknown, never 0.
  SELECT x -> 'credit_notes' INTO c FROM jsonb_array_elements(v -> 'months') x WHERE x ->> 'month' = '2032-01';
  IF jsonb_typeof(c -> 'parts_add_up') <> 'null' OR (c ->> 'unknown_notes')::integer <> 1 OR (c ->> 'unknown_parts')::integer <> 1 THEN
    RAISE EXCEPTION 'supplier credit netting: January credit notes %', c;
  END IF;
  -- Aggregates only: no note, bill, supplier or job is named.
  IF v::text ~ '(CNN-|Cnn )' THEN RAISE EXCEPTION 'supplier credit netting: the tie-out names a note, bill, supplier or job'; END IF;
  -- Every org: org two's credit notes are not read, so nothing is shown read.
  v := public.xero_tieout_monthly('2032-03-15', 3, NULL);
  IF v::text IS DISTINCT FROM (SELECT all_doc FROM nn_tieout) THEN
    RAISE EXCEPTION 'supplier credit netting: a read of every org showed credit notes one org has not read';
  END IF;
END $$;

-- 6. API roles refused; service role only.
DO $$
DECLARE
  rel text;
  role text;
BEGIN
  FOREACH rel IN ARRAY ARRAY['public.v_supplier_credit_allocations', 'public.v_supplier_credit_placement', 'public.v_job_cost_events'] LOOP
    FOREACH role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      IF has_table_privilege(role, rel, 'SELECT') THEN
        RAISE EXCEPTION 'supplier credit netting: % can read %', role, rel;
      END IF;
    END LOOP;
    IF NOT has_table_privilege('service_role', rel, 'SELECT') THEN
      RAISE EXCEPTION 'supplier credit netting: service_role cannot read %', rel;
    END IF;
  END LOOP;
  FOREACH rel IN ARRAY ARRAY['public.job_cost_credit_note_part(numeric,numeric,numeric)', 'public.xero_tieout_monthly(date,integer,uuid)'] LOOP
    FOREACH role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      IF has_function_privilege(role, rel, 'EXECUTE') THEN
        RAISE EXCEPTION 'supplier credit netting: % can run %', role, rel;
      END IF;
    END LOOP;
    IF NOT has_function_privilege('service_role', rel, 'EXECUTE') THEN
      RAISE EXCEPTION 'supplier credit netting: service_role cannot run %', rel;
    END IF;
  END LOOP;
  IF COALESCE((SELECT reloptions::text FROM pg_class WHERE oid = 'public.v_supplier_credit_placement'::regclass), '') NOT LIKE '%security_invoker=true%' THEN
    RAISE EXCEPTION 'supplier credit netting: the placement view does not run as its caller';
  END IF;
  IF (SELECT proconfig FROM pg_proc WHERE oid = 'public.job_cost_credit_note_part(numeric,numeric,numeric)'::regprocedure) IS NOT NULL THEN
    RAISE EXCEPTION 'supplier credit netting: the per-row part carries a SET clause and will not inline';
  END IF;
END $$;

-- 7. A re-apply changes nothing.
CREATE TEMP TABLE nn_again ON COMMIT DROP AS
SELECT public.xero_tieout_monthly('2032-03-15', 3, '00000000-0000-0000-0000-000000000001')::text AS doc,
       (SELECT md5(string_agg(row(p.*)::text, '|' ORDER BY row(p.*)::text COLLATE "C")) FROM public.v_supplier_credit_placement p) AS place_md5,
       (SELECT md5(string_agg(row(e.*)::text, '|' ORDER BY row(e.*)::text COLLATE "C"))
          FROM public.v_job_cost_events e JOIN nn_jobs j ON j.job_id = e.job_id) AS events_md5;
\ir ../../../migrations/20261030060000_supplier_credit_netting.sql
DO $$
BEGIN
  IF (SELECT doc FROM nn_again) IS DISTINCT FROM public.xero_tieout_monthly('2032-03-15', 3, '00000000-0000-0000-0000-000000000001')::text
     OR (SELECT place_md5 FROM nn_again) IS DISTINCT FROM
        (SELECT md5(string_agg(row(p.*)::text, '|' ORDER BY row(p.*)::text COLLATE "C")) FROM public.v_supplier_credit_placement p)
     OR (SELECT events_md5 FROM nn_again) IS DISTINCT FROM
        (SELECT md5(string_agg(row(e.*)::text, '|' ORDER BY row(e.*)::text COLLATE "C"))
           FROM public.v_job_cost_events e JOIN nn_jobs j ON j.job_id = e.job_id) THEN
    RAISE EXCEPTION 'supplier credit netting: a re-apply changed the engine, the placement or the tie-out';
  END IF;
END $$;

ROLLBACK;
