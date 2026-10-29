-- Contract for 20261030010000 (supplier credit notes, TP-07 slice 1).
-- Synthetic data only, inside one rolled-back transaction.
--
-- Jobs:   CN-J1 (SWF-39101), CN-J2 (SWF-39102)
-- Bills (ACCPAY, our copy of Xero):
--   BILL-A  AUTHORISED, 1000 ex / 1100 inc, on CN-J1 by its Xero job; its own
--           copy lists CN1 applied 55 (so CFO-20 already credits CN-J1)
--   BILL-B  AUTHORISED, 2000 ex / 2200 inc, split by a person: CN-J1 1200, CN-J2 800
--   BILL-V  VOIDED, on CN-J1
--   BILL-U  AUTHORISED, on no job and in no allocation row (not placed)
-- Credit notes (written through xero_supplier_credit_note_copy):
--   CN1  AUTHORISED 110, 55 allocated to BILL-A, 55 left on the note
--   CN2  PAID 220, all allocated to BILL-B (split)
--   CN3  VOIDED, allocated to BILL-A          (never placed)
--   CN4  AUTHORISED 33, nothing allocated     (unallocated 33, never $0)
--   CN5  AUTHORISED, allocations to a bill not in our copy, a deleted one, one
--        with no amount, one to the voided bill and one to the unplaced bill
--   CN6  AUTHORISED, first copied with a list, then a record with no list
--   CN7  AUTHORISED, no RemainingCredit sent
--   CN8  DRAFT, allocated to BILL-A          (never placed)
--   CN9  no status sent, allocated to BILL-A (never placed)
BEGIN;

INSERT INTO public.organisations (id, name) VALUES ('00000000-0000-0000-0000-000000000001', 'Synthetic org')
ON CONFLICT (id) DO NOTHING;
INSERT INTO public.jobs (id, org_id, status, type, job_number) VALUES
  ('e7000000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000001', 'accepted', 'fencing', 'SWF-39101'),
  ('e7000000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000001', 'accepted', 'fencing', 'SWF-39102');
INSERT INTO public.xero_invoices (org_id, xero_invoice_id, invoice_number, invoice_type, status, contact_name, sub_total, total,
                                  invoice_date, line_items, raw_json, job_id) VALUES
  ('00000000-0000-0000-0000-000000000001', 'bbbbbbbb-0000-4000-8000-00000000000a', 'CNB-A', 'ACCPAY', 'AUTHORISED', 'Cn Steel', 1000, 1100,
   '2026-09-01', '[{"Description": "Posts", "AccountCode": "310", "LineAmount": 1000}]',
   '{"Total": 1100, "CreditNotes": [{"CreditNoteID": "cccccccc-0000-4000-8000-000000000001", "AppliedAmount": 55}]}',
   'e7000000-0000-4000-8000-000000000001'),
  ('00000000-0000-0000-0000-000000000001', 'bbbbbbbb-0000-4000-8000-00000000000b', 'CNB-B', 'ACCPAY', 'AUTHORISED', 'Cn Steel', 2000, 2200,
   '2026-09-02', '[{"Description": "Mesh", "AccountCode": "310", "LineAmount": 2000}]', '{"Total": 2200}', NULL),
  ('00000000-0000-0000-0000-000000000001', 'bbbbbbbb-0000-4000-8000-00000000000c', 'CNB-V', 'ACCPAY', 'VOIDED', 'Cn Steel', 100, 110,
   '2026-09-03', '[{"Description": "Wire", "AccountCode": "310", "LineAmount": 100}]', '{"Total": 110}',
   'e7000000-0000-4000-8000-000000000001'),
  ('00000000-0000-0000-0000-000000000001', 'bbbbbbbb-0000-4000-8000-00000000000d', 'CNB-U', 'ACCPAY', 'AUTHORISED', 'Cn Steel', 500, 550,
   '2026-09-04', '[{"Description": "Sand", "AccountCode": "310", "LineAmount": 500}]', '{"Total": 550}', NULL);
INSERT INTO public.job_materials_facts (xero_invoice_id, invoice_number, job_id, job_number, lane, kind, amount_ex_gst, confidence, automation_source, fact_date) VALUES
  ('bbbbbbbb-0000-4000-8000-00000000000b', 'CNB-B', 'e7000000-0000-4000-8000-000000000001', 'SWF-39101', 'materials', 'actual', 1200, 'high_manual', 'manual_split', '2026-09-02'),
  ('bbbbbbbb-0000-4000-8000-00000000000b', 'CNB-B', 'e7000000-0000-4000-8000-000000000002', 'SWF-39102', 'materials', 'actual', 800, 'high_manual', 'manual_split', '2026-09-02');

-- Job Profit's cost rows for both jobs before any credit note exists.
CREATE TEMP TABLE cn_cost_before ON COMMIT DROP AS
SELECT md5(string_agg(row(e.*)::text, '|' ORDER BY row(e.*)::text COLLATE "C")) AS rows_md5,
       sum(e.amount_ex) AS total
  FROM public.v_job_cost_events e
 WHERE e.job_id IN ('e7000000-0000-4000-8000-000000000001', 'e7000000-0000-4000-8000-000000000002');

CREATE FUNCTION pg_temp.cn_note(id text, status text, total numeric, remaining numeric, updated text DEFAULT '2026-10-01T00:00:00Z')
RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_strip_nulls(jsonb_build_object(
    'xero_credit_note_id', id, 'credit_note_type', 'ACCPAYCREDIT', 'credit_note_number', 'CN-' || right(id, 2),
    'xero_contact_id', 'dddddddd-0000-4000-8000-000000000001', 'contact_name', 'Cn Steel',
    'credit_note_date', '2026-10-01', 'status', status, 'currency_code', 'AUD',
    'sub_total', round(total / 1.1, 2), 'total_tax', total - round(total / 1.1, 2), 'total', total,
    'remaining_credit', remaining, 'xero_updated_at', updated,
    'raw_json', jsonb_build_object('CreditNoteID', id, 'Type', 'ACCPAYCREDIT')))
$$;
CREATE FUNCTION pg_temp.cn_alloc(bill text, amount numeric, deleted boolean DEFAULT false)
RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_strip_nulls(jsonb_build_object('xero_invoice_id', bill, 'amount', amount, 'allocation_date', '2026-10-02',
                                               'is_deleted', deleted, 'raw_json', jsonb_build_object('Amount', amount)))
$$;

DO $$
DECLARE
  org uuid := '00000000-0000-0000-0000-000000000001';
  a text := 'bbbbbbbb-0000-4000-8000-00000000000a';
  b text := 'bbbbbbbb-0000-4000-8000-00000000000b';
  v text := 'bbbbbbbb-0000-4000-8000-00000000000c';
  u text := 'bbbbbbbb-0000-4000-8000-00000000000d';
  r text;
BEGIN
  -- 1. The writer.
  r := public.xero_supplier_credit_note_copy(org, pg_temp.cn_note('cccccccc-0000-4000-8000-000000000001', 'AUTHORISED', 110, 55),
         jsonb_build_array(pg_temp.cn_alloc(a, 55)));
  IF r <> 'written' THEN RAISE EXCEPTION 'supplier credit notes: CN1 write answered %', r; END IF;
  PERFORM public.xero_supplier_credit_note_copy(org, pg_temp.cn_note('cccccccc-0000-4000-8000-000000000002', 'PAID', 220, 0),
         jsonb_build_array(pg_temp.cn_alloc(b, 220)));
  PERFORM public.xero_supplier_credit_note_copy(org, pg_temp.cn_note('cccccccc-0000-4000-8000-000000000003', 'VOIDED', 110, 0),
         jsonb_build_array(pg_temp.cn_alloc(a, 110)));
  PERFORM public.xero_supplier_credit_note_copy(org, pg_temp.cn_note('cccccccc-0000-4000-8000-000000000004', 'AUTHORISED', 33, 33), '[]');
  PERFORM public.xero_supplier_credit_note_copy(org, pg_temp.cn_note('cccccccc-0000-4000-8000-000000000005', 'AUTHORISED', 44, 0),
         jsonb_build_array(pg_temp.cn_alloc('bbbbbbbb-0000-4000-8000-0000000000ff', 11), pg_temp.cn_alloc(a, 10, true),
                           pg_temp.cn_alloc(a, NULL), pg_temp.cn_alloc(v, 5), pg_temp.cn_alloc(u, 6)));
  PERFORM public.xero_supplier_credit_note_copy(org, pg_temp.cn_note('cccccccc-0000-4000-8000-000000000006', 'AUTHORISED', 7, 0, '2026-10-01T00:00:00Z'),
         jsonb_build_array(pg_temp.cn_alloc(a, 7)));
  PERFORM public.xero_supplier_credit_note_copy(org, pg_temp.cn_note('cccccccc-0000-4000-8000-000000000006', 'AUTHORISED', 7, 0, '2026-10-02T00:00:00Z'), NULL);
  PERFORM public.xero_supplier_credit_note_copy(org, pg_temp.cn_note('cccccccc-0000-4000-8000-000000000007', 'AUTHORISED', 70, NULL), '[]');
  PERFORM public.xero_supplier_credit_note_copy(org, pg_temp.cn_note('cccccccc-0000-4000-8000-000000000008', 'DRAFT', 80, 80),
         jsonb_build_array(pg_temp.cn_alloc(a, 8)));
  PERFORM public.xero_supplier_credit_note_copy(org, pg_temp.cn_note('cccccccc-0000-4000-8000-000000000009', NULL, 90, 90),
         jsonb_build_array(pg_temp.cn_alloc(a, 9)));

  IF (SELECT allocations_returned FROM public.xero_supplier_credit_notes WHERE xero_credit_note_id = 'cccccccc-0000-4000-8000-000000000006')
     OR (SELECT count(*) FROM public.xero_supplier_credit_note_allocations WHERE xero_credit_note_id = 'cccccccc-0000-4000-8000-000000000006') <> 1 THEN
    RAISE EXCEPTION 'supplier credit notes: a record with no list changed the stored allocations or the flag';
  END IF;
  IF (SELECT status FROM public.xero_supplier_credit_notes WHERE xero_credit_note_id = 'cccccccc-0000-4000-8000-000000000009') IS NOT NULL
     OR (SELECT remaining_credit FROM public.xero_supplier_credit_notes WHERE xero_credit_note_id = 'cccccccc-0000-4000-8000-000000000007') IS NOT NULL THEN
    RAISE EXCEPTION 'supplier credit notes: a status or amount Xero did not send was filled in';
  END IF;

  -- An older record changes nothing; a newer one replaces the list whole.
  r := public.xero_supplier_credit_note_copy(org, pg_temp.cn_note('cccccccc-0000-4000-8000-000000000001', 'VOIDED', 110, 0, '2026-09-01T00:00:00Z'), '[]');
  IF r <> 'stale' OR (SELECT status FROM public.xero_supplier_credit_notes WHERE xero_credit_note_id = 'cccccccc-0000-4000-8000-000000000001') <> 'AUTHORISED'
     OR (SELECT count(*) FROM public.xero_supplier_credit_note_allocations WHERE xero_credit_note_id = 'cccccccc-0000-4000-8000-000000000001') <> 1 THEN
    RAISE EXCEPTION 'supplier credit notes: an older Xero record overwrote a newer one (%)', r;
  END IF;
  PERFORM public.xero_supplier_credit_note_copy(org, pg_temp.cn_note('cccccccc-0000-4000-8000-000000000004', 'AUTHORISED', 33, 33, '2026-10-03T00:00:00Z'),
         jsonb_build_array(pg_temp.cn_alloc(u, 1), pg_temp.cn_alloc(u, 2)));
  PERFORM public.xero_supplier_credit_note_copy(org, pg_temp.cn_note('cccccccc-0000-4000-8000-000000000004', 'AUTHORISED', 33, 33, '2026-10-04T00:00:00Z'), '[]');
  IF EXISTS (SELECT 1 FROM public.xero_supplier_credit_note_allocations WHERE xero_credit_note_id = 'cccccccc-0000-4000-8000-000000000004') THEN
    RAISE EXCEPTION 'supplier credit notes: a newer empty list left old allocations behind';
  END IF;

  -- Refusals.
  BEGIN
    PERFORM public.xero_supplier_credit_note_copy(org, pg_temp.cn_note('cccccccc-0000-4000-8000-0000000000aa', 'AUTHORISED', 1, 1)
                                                        || '{"credit_note_type": "ACCRECCREDIT"}', '[]');
    RAISE EXCEPTION 'supplier credit notes: a customer credit note was copied';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE 'supplier_credit_note_refused:%' THEN RAISE; END IF;
  END;
  BEGIN
    PERFORM public.xero_supplier_credit_note_copy(org, pg_temp.cn_note(' ', 'AUTHORISED', 1, 1), '[]');
    RAISE EXCEPTION 'supplier credit notes: a note with no id was copied';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE 'supplier_credit_note_refused:%' THEN RAISE; END IF;
  END;
  BEGIN
    PERFORM public.xero_supplier_credit_note_copy(org, pg_temp.cn_note('cccccccc-0000-4000-8000-0000000000ab', 'AUTHORISED', 1, 1) - 'raw_json', '[]');
    RAISE EXCEPTION 'supplier credit notes: a note with no Xero record was copied';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE 'supplier_credit_note_refused:%' THEN RAISE; END IF;
  END;
END $$;

-- 2. Where each allocation lands.
CREATE TEMP TABLE cn_place ON COMMIT DROP AS
SELECT right(p.xero_credit_note_id, 1) AS cn, p.state, p.job_id, p.amount, p.credit_ex, p.bill_part_ex, p.bill_side_applied, p.xero_invoice_id
  FROM public.v_supplier_credit_placement p
 WHERE p.org_id = '00000000-0000-0000-0000-000000000001';

DO $$
DECLARE
  j1 uuid := 'e7000000-0000-4000-8000-000000000001';
  j2 uuid := 'e7000000-0000-4000-8000-000000000002';
  got text;
BEGIN
  -- An allocated credit lands on its bill's job, at CFO-20's rule, and says the bill already lists it.
  SELECT string_agg(concat_ws(':', state, job_id, amount, credit_ex, bill_side_applied), ' ' ORDER BY state, amount) INTO got
    FROM cn_place WHERE cn = '1';
  IF got IS DISTINCT FROM 'placed:' || j1 || ':55.00:50.00:55 unallocated:55.00' THEN
    RAISE EXCEPTION 'supplier credit notes: CN1 %', got;
  END IF;
  -- A split bill's credit lands on each job in proportion.
  SELECT string_agg(concat_ws(':', state, job_id, bill_part_ex, credit_ex), ' ' ORDER BY credit_ex) INTO got FROM cn_place WHERE cn = '2';
  IF got IS DISTINCT FROM 'placed:' || j2 || ':800:80.00 placed:' || j1 || ':1200:120.00' THEN
    RAISE EXCEPTION 'supplier credit notes: CN2 split %', got;
  END IF;
  -- Voided, draft and status-less notes never land on a job.
  IF EXISTS (SELECT 1 FROM cn_place WHERE cn IN ('3', '8', '9') AND (job_id IS NOT NULL OR state <> 'credit_note_not_live')) THEN
    RAISE EXCEPTION 'supplier credit notes: a note that is not live was placed: %',
      (SELECT string_agg(cn || ':' || state, ' ') FROM cn_place WHERE cn IN ('3', '8', '9'));
  END IF;
  IF (SELECT count(*) FROM cn_place WHERE cn IN ('3', '8', '9')) <> 3 THEN
    RAISE EXCEPTION 'supplier credit notes: a note that is not live was hidden instead of shown unplaced';
  END IF;
  -- An unallocated note is unplaced, with its amount, never $0.
  SELECT string_agg(concat_ws(':', state, COALESCE(job_id::text, 'no job'), amount), ' ') INTO got FROM cn_place WHERE cn = '4';
  IF got IS DISTINCT FROM 'unallocated:no job:33.00' THEN RAISE EXCEPTION 'supplier credit notes: CN4 %', got; END IF;
  SELECT string_agg(state, ' ' ORDER BY state) INTO got FROM cn_place WHERE cn = '5';
  IF got IS DISTINCT FROM 'allocation_deleted amount_unknown bill_not_in_copy bill_not_live bill_not_placed' THEN
    RAISE EXCEPTION 'supplier credit notes: CN5 %', got;
  END IF;
  IF EXISTS (SELECT 1 FROM cn_place WHERE cn = '5' AND job_id IS NOT NULL)
     OR (SELECT amount FROM cn_place WHERE cn = '5' AND state = 'amount_unknown') IS NOT NULL THEN
    RAISE EXCEPTION 'supplier credit notes: an unplaced allocation got a job, or an unknown amount a figure';
  END IF;
  SELECT string_agg(concat_ws(':', state, COALESCE(amount::text, 'unknown')), ' ') INTO got FROM cn_place WHERE cn = '6';
  IF got IS DISTINCT FROM 'allocations_not_read:unknown' THEN RAISE EXCEPTION 'supplier credit notes: CN6 %', got; END IF;
  SELECT string_agg(concat_ws(':', state, COALESCE(amount::text, 'unknown')), ' ') INTO got FROM cn_place WHERE cn = '7';
  IF got IS DISTINCT FROM 'remaining_unknown:unknown' THEN RAISE EXCEPTION 'supplier credit notes: CN7 %', got; END IF;
  IF EXISTS (SELECT 1 FROM cn_place WHERE state = 'unallocated' AND (amount IS NULL OR amount <= 0)) THEN
    RAISE EXCEPTION 'supplier credit notes: an unallocated row shows $0 or nothing';
  END IF;
  IF EXISTS (SELECT 1 FROM cn_place WHERE (state = 'placed') <> (job_id IS NOT NULL)) THEN
    RAISE EXCEPTION 'supplier credit notes: only a placed row has a job';
  END IF;
END $$;

-- 3. Job Profit's numbers did not move.
DO $$
BEGIN
  IF (SELECT rows_md5 FROM cn_cost_before) IS DISTINCT FROM
     (SELECT md5(string_agg(row(e.*)::text, '|' ORDER BY row(e.*)::text COLLATE "C")) FROM public.v_job_cost_events e
       WHERE e.job_id IN ('e7000000-0000-4000-8000-000000000001', 'e7000000-0000-4000-8000-000000000002')) THEN
    RAISE EXCEPTION 'supplier credit notes: Job Profit cost rows changed';
  END IF;
  -- The bill-side credit CFO-20 already took was there before (55 of 1100 on BILL-A's 1000).
  IF NOT EXISTS (SELECT 1 FROM public.v_job_cost_events e
                  WHERE e.document_id = 'bbbbbbbb-0000-4000-8000-00000000000a' AND e.source = 'supplier_credit' AND e.amount_ex = -50) THEN
    RAISE EXCEPTION 'supplier credit notes: fixture lost CFO-20''s bill-side credit';
  END IF;
END $$;

-- 4. API roles refused; service role only; RLS on, no policy.
DO $$
DECLARE
  rel text;
  role text;
BEGIN
  FOREACH rel IN ARRAY ARRAY['public.xero_supplier_credit_notes', 'public.xero_supplier_credit_note_allocations', 'public.v_supplier_credit_placement'] LOOP
    FOREACH role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      IF has_table_privilege(role, rel, 'SELECT') OR has_table_privilege(role, rel, 'INSERT')
         OR has_table_privilege(role, rel, 'UPDATE') OR has_table_privilege(role, rel, 'DELETE')
         OR has_table_privilege(role, rel, 'TRUNCATE') THEN
        RAISE EXCEPTION 'supplier credit notes: % can touch %', role, rel;
      END IF;
    END LOOP;
    IF NOT has_table_privilege('service_role', rel, 'SELECT') THEN
      RAISE EXCEPTION 'supplier credit notes: service_role cannot read %', rel;
    END IF;
  END LOOP;
  FOREACH role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF has_function_privilege(role, 'public.xero_supplier_credit_note_copy(uuid,jsonb,jsonb)', 'EXECUTE') THEN
      RAISE EXCEPTION 'supplier credit notes: % can run the writer', role;
    END IF;
  END LOOP;
  IF NOT has_function_privilege('service_role', 'public.xero_supplier_credit_note_copy(uuid,jsonb,jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION 'supplier credit notes: service_role cannot run the writer';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_class WHERE oid IN ('public.xero_supplier_credit_notes'::regclass, 'public.xero_supplier_credit_note_allocations'::regclass)
              AND NOT relrowsecurity)
     OR EXISTS (SELECT 1 FROM pg_policies WHERE tablename IN ('xero_supplier_credit_notes', 'xero_supplier_credit_note_allocations')) THEN
    RAISE EXCEPTION 'supplier credit notes: RLS off or a policy present';
  END IF;
  IF COALESCE((SELECT reloptions::text FROM pg_class WHERE oid = 'public.v_supplier_credit_placement'::regclass), '') NOT LIKE '%security_invoker=true%' THEN
    RAISE EXCEPTION 'supplier credit notes: the view does not run as its caller';
  END IF;
  IF (SELECT enabled FROM public.feature_flags WHERE flag_name = 'xero_supplier_credit_notes_v1') IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'supplier credit notes: the flag is not seeded off';
  END IF;
END $$;

-- 5. A re-apply changes nothing: copied rows and the flag stay as they are.
UPDATE public.feature_flags SET enabled = true WHERE flag_name = 'xero_supplier_credit_notes_v1';
\ir ../../../migrations/20261030010000_xero_supplier_credit_notes.sql
DO $$
BEGIN
  IF (SELECT count(*) FROM public.xero_supplier_credit_notes WHERE org_id = '00000000-0000-0000-0000-000000000001') <> 9
     OR (SELECT enabled FROM public.feature_flags WHERE flag_name = 'xero_supplier_credit_notes_v1') IS DISTINCT FROM true
     OR (SELECT count(*) FROM public.v_supplier_credit_placement WHERE org_id = '00000000-0000-0000-0000-000000000001')
        <> (SELECT count(*) FROM cn_place) THEN
    RAISE EXCEPTION 'supplier credit notes: a re-apply changed the copy, the view or the flag';
  END IF;
END $$;

ROLLBACK;
