-- Contract for 20261020181800_job_cost_allocation_rows (CFO-18, CFO-20).
--
-- Synthetic jobs and bills, no customer data. Everything rolls back.
--
--   CA-J1, CA-J2  finished fencing jobs; CA-HOLD a holding job.
--   B-SPLIT   installer bill on the holding card: 1,000 ex (1,100 inc), with
--             110 inc credit applied (share 0.1). Split 600 to J1 and 300 to
--             J2 as labour, 100 overhead.
--   B-CRED    materials bill on J2: 200 ex (220 inc), 22 inc credited.
--   B-VOID    voided bill in the queue (refused).
--   B-MIRROR  trade app mirror bill in the queue (refused).
--   S-INV     sales invoice on J1: 1,000 ex (1,100 inc), 110 inc credited.
--
-- Expected: J1 labour 600 - 60 = 540; J2 labour 300 - 30 = 270 and materials
-- 200 - 20 = 180; the holding job carries nothing from B-SPLIT; J1 invoiced
-- 900; the bill balances (600 + 300 + 100 = 1,000); a repeat is a no-op;
-- every refusal names its reason.
--
-- Review cycle 1 cases:
--   B-OWN    materials bill on J3 (its own Xero job): 500 ex. Split 400 to J3
--            with 100 overhead: J3 carries 400, not 500.
--   B-WHOLE  materials bill placed whole on J1 by the reference path: a split
--            is refused, and a second whole row is refused.
--   B-301    installer bill on account 301 placed whole on J3 by Xero: labour.
--   CA-DEAD  a cancelled job: a split onto it is refused.
--   Credit share counts credit notes applied, never prepayments.
--   A voided bill with allocation rows is never balanced.

\set ON_ERROR_STOP on

BEGIN;

INSERT INTO public.jobs (id, org_id, status, type, job_number, legacy, metadata, pricing_json, expected_costs, created_at) VALUES
  ('ca000000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000001', 'complete', 'fencing', 'CA-J1', false, '{}', '{}', NULL, '2026-07-01T00:00:00Z'),
  ('ca000000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000001', 'complete', 'fencing', 'CA-J2', false, '{}', '{}', NULL, '2026-07-01T00:00:00Z'),
  ('ca000000-0000-4000-8000-000000000009', '00000000-0000-0000-0000-000000000001', 'complete', 'fencing', 'CA-HOLD', false, '{"do_not_schedule": "true"}', '{}', NULL, '2026-07-01T00:00:00Z'),
  ('ca000000-0000-4000-8000-000000000003', '00000000-0000-0000-0000-000000000001', 'complete', 'fencing', 'CA-J3', false, '{}', '{}', NULL, '2026-07-01T00:00:00Z'),
  ('ca000000-0000-4000-8000-000000000008', '00000000-0000-0000-0000-000000000001', 'cancelled', 'fencing', 'CA-DEAD', false, '{}', '{}', NULL, '2026-07-01T00:00:00Z');

INSERT INTO public.xero_invoices (org_id, xero_invoice_id, invoice_number, invoice_type, status, contact_name, sub_total, total, invoice_date, line_items, raw_json, job_id) VALUES
  ('00000000-0000-0000-0000-000000000001', 'B-SPLIT', 'CA-31', 'ACCPAY', 'PAID', 'CA Installer', 1000, 1100, '2026-08-27',
   '[{"Description": "Installs", "AccountCode": "306", "LineAmount": 1000, "TaxAmount": 100}]',
   '{"LineAmountTypes": "Exclusive", "AmountCredited": 110}', 'ca000000-0000-4000-8000-000000000009'),
  ('00000000-0000-0000-0000-000000000001', 'B-CRED', 'CA-40', 'ACCPAY', 'AUTHORISED', 'CA Steel', 200, 220, '2026-08-28',
   '[{"Description": "Posts", "AccountCode": "310", "LineAmount": 200, "TaxAmount": 20}]',
   '{"LineAmountTypes": "Exclusive", "AmountCredited": 22}', 'ca000000-0000-4000-8000-000000000002'),
  ('00000000-0000-0000-0000-000000000001', 'B-VOID', 'CA-41', 'ACCPAY', 'VOIDED', 'CA Steel', 50, 55, '2026-08-28', '[]', '{}', NULL),
  ('00000000-0000-0000-0000-000000000001', 'B-MIRROR', 'CA-42', 'ACCPAY', 'PAID', 'CA Trade', 80, 88, '2026-08-28', '[]', '{}', NULL),
  ('00000000-0000-0000-0000-000000000001', 'S-INV', 'INV-CA-1', 'ACCREC', 'AUTHORISED', 'CA Customer', 1000, 1100, '2026-08-20',
   '[{"Description": "Fence", "AccountCode": "200", "LineAmount": 1000, "TaxAmount": 100}]',
   '{"LineAmountTypes": "Exclusive", "AmountCredited": 110}', 'ca000000-0000-4000-8000-000000000001'),
  ('00000000-0000-0000-0000-000000000001', 'B-OWN', 'CA-43', 'ACCPAY', 'AUTHORISED', 'CA Steel', 500, 550, '2026-08-28',
   '[{"Description": "Rails", "AccountCode": "310", "LineAmount": 500, "TaxAmount": 50}]',
   '{"LineAmountTypes": "Exclusive"}', 'ca000000-0000-4000-8000-000000000003'),
  ('00000000-0000-0000-0000-000000000001', 'B-WHOLE', 'CA-44', 'ACCPAY', 'AUTHORISED', 'CA Steel', 70, 77, '2026-08-28',
   '[{"Description": "Caps", "AccountCode": "310", "LineAmount": 70, "TaxAmount": 7}]',
   '{"LineAmountTypes": "Exclusive"}', NULL),
  ('00000000-0000-0000-0000-000000000001', 'B-301', 'CA-45', 'ACCPAY', 'AUTHORISED', 'CA Installer', 100, 110, '2026-08-28',
   '[{"Description": "Install", "AccountCode": "301", "LineAmount": 100, "TaxAmount": 10}]',
   '{"LineAmountTypes": "Exclusive"}', 'ca000000-0000-4000-8000-000000000003');

INSERT INTO public.users (id, org_id, name) VALUES
  ('ca200000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000001', 'CA Trade');
INSERT INTO public.trade_invoices (id, org_id, user_id, week_start, status, subtotal_ex, xero_bill_id, xero_bill_status, invoice_number,
                                   gst_on, gst, total_inc, super_rate, super_amount, gross_earned, net_pay) VALUES
  ('ca100000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000001', 'ca200000-0000-4000-8000-000000000001',
   '2026-08-24', 'paid', 80, 'B-MIRROR', 'PAID', 'TI-CA-1', false, 0, 80, 0.12, 9.6, 80, 70.4);

INSERT INTO public.materials_reconciliation_queue (xero_invoice_id, invoice_number, contact_name, sub_total, total, invoice_date, status) VALUES
  ('B-SPLIT', 'CA-31', 'CA Installer', 1000, 1100, '2026-08-27', 'open'),
  ('B-VOID', 'CA-41', 'CA Steel', 50, 55, '2026-08-28', 'open'),
  ('B-MIRROR', 'CA-42', 'CA Trade', 80, 88, '2026-08-28', 'open'),
  ('B-OWN', 'CA-43', 'CA Steel', 500, 550, '2026-08-28', 'open'),
  ('B-WHOLE', 'CA-44', 'CA Steel', 70, 77, '2026-08-28', 'open');

-- ── Refusals ────────────────────────────────────────────────────────────────
CREATE TEMP TABLE ca_refusals (label text, expect text, got text);
DO $$
DECLARE
  c record;
  v_msg text;
BEGIN
  FOR c IN SELECT * FROM (VALUES
    ('sum',      'B-SPLIT',  '[{"job_id": "ca000000-0000-4000-8000-000000000001", "amount_ex": 600}, {"job_id": "ca000000-0000-4000-8000-000000000002", "amount_ex": 300}]'::jsonb, 0::numeric, 'do not equal'),
    ('holding',  'B-SPLIT',  '[{"job_id": "ca000000-0000-4000-8000-000000000009", "amount_ex": 1000}]'::jsonb, 0::numeric, 'holding job'),
    ('twice',    'B-SPLIT',  '[{"job_id": "ca000000-0000-4000-8000-000000000001", "amount_ex": 500}, {"job_id": "ca000000-0000-4000-8000-000000000001", "amount_ex": 500}]'::jsonb, 0::numeric, 'appears twice'),
    ('zero',     'B-SPLIT',  '[{"job_id": "ca000000-0000-4000-8000-000000000001", "amount_ex": 0}, {"job_id": "ca000000-0000-4000-8000-000000000002", "amount_ex": 1000}]'::jsonb, 0::numeric, 'more than 0'),
    ('lane',     'B-SPLIT',  '[{"job_id": "ca000000-0000-4000-8000-000000000001", "amount_ex": 1000, "lane": "fuel"}]'::jsonb, 0::numeric, 'not materials, labour or other'),
    ('voided',   'B-VOID',   '[{"job_id": "ca000000-0000-4000-8000-000000000001", "amount_ex": 50}]'::jsonb, 0::numeric, 'VOIDED'),
    ('mirror',   'B-MIRROR', '[{"job_id": "ca000000-0000-4000-8000-000000000001", "amount_ex": 80}]'::jsonb, 0::numeric, 'trade app'),
    ('dead',     'B-SPLIT',  '[{"job_id": "ca000000-0000-4000-8000-000000000008", "amount_ex": 1000}]'::jsonb, 0::numeric, 'cancelled'),
    ('noamt',    'B-SPLIT',  '[{"job_id": "ca000000-0000-4000-8000-000000000001"}]'::jsonb, 0::numeric, 'needs an amount'),
    ('nojob',    'B-SPLIT',  '[{"job_id": "", "amount_ex": 1000}]'::jsonb, 0::numeric, 'needs a job'),
    ('notqueue', 'B-CRED',   '[{"job_id": "ca000000-0000-4000-8000-000000000001", "amount_ex": 200}]'::jsonb, 0::numeric, 'not in Bills to place')
  ) AS t(label, bill, parts, overhead, expect) LOOP
    v_msg := NULL;
    BEGIN
      PERFORM public.allocate_bill_split(c.bill, c.parts, c.overhead, NULL, 'contract@test');
    EXCEPTION WHEN OTHERS THEN
      v_msg := SQLERRM;
    END;
    INSERT INTO ca_refusals VALUES (c.label, c.expect, v_msg);
  END LOOP;
END $$;
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT * FROM ca_refusals LOOP
    IF r.got IS NULL OR position('split_refused' IN r.got) = 0 OR position(r.expect IN r.got) = 0 THEN
      RAISE EXCEPTION 'cfo18 refusal %: expected "%", got %', r.label, r.expect, COALESCE(r.got, 'no refusal');
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM public.job_materials_facts WHERE xero_invoice_id LIKE 'B-%') THEN
    RAISE EXCEPTION 'cfo18 refusal: a refused split wrote a row';
  END IF;
  -- An actor is required.
  BEGIN
    PERFORM public.allocate_bill_split('B-SPLIT', '[{"job_id": "ca000000-0000-4000-8000-000000000001", "amount_ex": 1000}]', 0, NULL, ' ');
    RAISE EXCEPTION 'cfo18 refusal: split without an actor was accepted';
  EXCEPTION WHEN OTHERS THEN
    IF position('actor required' IN SQLERRM) = 0 THEN RAISE; END IF;
  END;
END $$;

-- ── The split ───────────────────────────────────────────────────────────────
DO $$
DECLARE
  v jsonb;
  r record;
BEGIN
  v := public.allocate_bill_split('B-SPLIT',
    '[{"job_id": "ca000000-0000-4000-8000-000000000001", "amount_ex": 600, "lane": "labour"},
      {"job_id": "ca000000-0000-4000-8000-000000000002", "amount_ex": 300, "lane": "materials"}]',
    100, 'Yard tidy, no job', 'contract@test');
  IF (v ->> 'ok')::boolean IS NOT TRUE OR (v ->> 'idempotent')::boolean THEN
    RAISE EXCEPTION 'cfo18 split: %', v;
  END IF;

  SELECT count(*) AS n, sum(amount_ex_gst) AS ex, bool_and(automation_source = 'manual_split' AND confidence = 'high_manual'
         AND assigned_by = 'contract@test' AND lane = 'labour') AS stamped
    INTO r FROM public.job_materials_facts WHERE xero_invoice_id = 'B-SPLIT';
  IF r.n <> 2 OR r.ex <> 900 OR NOT r.stamped THEN
    RAISE EXCEPTION 'cfo18 split: % rows, % ex, stamped %', r.n, r.ex, r.stamped;
  END IF;

  SELECT * INTO r FROM public.materials_reconciliation_queue WHERE xero_invoice_id = 'B-SPLIT';
  IF r.status <> 'split' OR r.overhead_ex <> 100 OR r.overhead_note <> 'Yard tidy, no job' OR r.assigned_by <> 'contract@test' THEN
    RAISE EXCEPTION 'cfo18 split: queue row % % % %', r.status, r.overhead_ex, r.overhead_note, r.assigned_by;
  END IF;

  SELECT * INTO r FROM public.v_bill_allocation_balance WHERE xero_invoice_id = 'B-SPLIT';
  IF NOT r.balanced OR r.bill_ex <> 1000 OR r.allocated_ex <> 900 OR r.overhead_ex <> 100 OR r.remainder_ex <> 0 THEN
    RAISE EXCEPTION 'cfo18 balance: % % % % %', r.balanced, r.bill_ex, r.allocated_ex, r.overhead_ex, r.remainder_ex;
  END IF;

  -- Same parts again: no-op.
  v := public.allocate_bill_split('B-SPLIT',
    '[{"job_id": "ca000000-0000-4000-8000-000000000002", "amount_ex": 300, "lane": "labour"},
      {"job_id": "ca000000-0000-4000-8000-000000000001", "amount_ex": 600, "lane": "labour"}]',
    100, 'Yard tidy, no job', 'contract@test');
  IF (v ->> 'idempotent')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'cfo18 repeat: not idempotent %', v;
  END IF;
  IF (SELECT count(*) FROM public.job_materials_facts WHERE xero_invoice_id = 'B-SPLIT') <> 2 THEN
    RAISE EXCEPTION 'cfo18 repeat: a repeat added rows';
  END IF;
END $$;

-- ── Cost and revenue on the jobs ────────────────────────────────────────────
DO $$
DECLARE r record;
BEGIN
  SELECT
    sum(amount_ex) FILTER (WHERE is_actual AND lane = 'labour') AS labour,
    sum(amount_ex) FILTER (WHERE is_actual AND source = 'supplier_credit') AS credit,
    count(*) FILTER (WHERE source = 'supplier_bill' AND document_id = 'B-SPLIT') AS whole_bill_rows
    INTO r FROM public.v_job_cost_events WHERE job_id = 'ca000000-0000-4000-8000-000000000001';
  IF r.labour <> 540 OR r.credit <> -60 OR r.whole_bill_rows <> 0 THEN
    RAISE EXCEPTION 'cfo18 cost J1: labour %, credit %, whole-bill rows %; expected 540, -60, 0', r.labour, r.credit, r.whole_bill_rows;
  END IF;

  SELECT
    sum(amount_ex) FILTER (WHERE is_actual AND lane = 'labour') AS labour,
    sum(amount_ex) FILTER (WHERE is_actual AND lane = 'materials') AS materials
    INTO r FROM public.v_job_cost_events WHERE job_id = 'ca000000-0000-4000-8000-000000000002';
  IF r.labour <> 270 OR r.materials <> 180 THEN
    RAISE EXCEPTION 'cfo18 cost J2: labour %, materials %; expected 270, 180', r.labour, r.materials;
  END IF;

  IF EXISTS (SELECT 1 FROM public.v_job_cost_events
              WHERE job_id = 'ca000000-0000-4000-8000-000000000009' AND document_id = 'B-SPLIT') THEN
    RAISE EXCEPTION 'cfo18 cost: the split bill is still on the holding job';
  END IF;

  SELECT * INTO r FROM public.v_job_profit WHERE job_number = 'CA-J1';
  IF r.invoiced_ex <> 900 OR r.actual_labour_ex <> 540 THEN
    RAISE EXCEPTION 'cfo18 job J1: invoiced %, labour %; expected 900, 540', r.invoiced_ex, r.actual_labour_ex;
  END IF;
  IF r.invoice_count <> 1 THEN
    RAISE EXCEPTION 'cfo18 job J1: invoice_count %, a credit row counted as a second invoice', r.invoice_count;
  END IF;
END $$;

-- ── Review cycle 1: no mix, overhead on own job, 301, credit, void ──────────
DO $$
DECLARE
  r record;
  v_msg text;
BEGIN
  -- A whole-bill row beside a split is refused (23505).
  BEGIN
    INSERT INTO public.job_materials_facts (xero_invoice_id, job_id, job_number, lane, kind, amount_ex_gst, confidence, automation_source, fact_date)
    VALUES ('B-SPLIT', 'ca000000-0000-4000-8000-000000000003', 'CA-J3', 'materials', 'actual', 1000, 'high', 'xero_ref_link', '2026-08-27');
    RAISE EXCEPTION 'cfo18 mix: a whole-bill row was added to a split bill';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;

  -- A bill placed whole cannot then be split, and cannot get a second whole row.
  INSERT INTO public.job_materials_facts (xero_invoice_id, job_id, job_number, lane, kind, amount_ex_gst, confidence, automation_source, fact_date)
  VALUES ('B-WHOLE', 'ca000000-0000-4000-8000-000000000001', 'CA-J1', 'materials', 'actual', 70, 'high', 'xero_ref_link', '2026-08-28');
  v_msg := NULL;
  BEGIN
    PERFORM public.allocate_bill_split('B-WHOLE',
      '[{"job_id": "ca000000-0000-4000-8000-000000000001", "amount_ex": 35}, {"job_id": "ca000000-0000-4000-8000-000000000002", "amount_ex": 35}]',
      0, NULL, 'contract@test');
  EXCEPTION WHEN OTHERS THEN v_msg := SQLERRM;
  END;
  IF v_msg IS NULL OR position('already placed by another route' IN v_msg) = 0 THEN
    RAISE EXCEPTION 'cfo18 mix: split of a whole-placed bill not refused (%)', v_msg;
  END IF;
  BEGIN
    INSERT INTO public.job_materials_facts (xero_invoice_id, job_id, job_number, lane, kind, amount_ex_gst, confidence, automation_source, fact_date)
    VALUES ('B-WHOLE', 'ca000000-0000-4000-8000-000000000002', 'CA-J2', 'materials', 'actual', 70, 'high', 'po_deterministic', '2026-08-28');
    RAISE EXCEPTION 'cfo18 mix: a second whole-bill row was accepted';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;

  -- Split with overhead on the bill's own Xero job: the job carries the part.
  PERFORM public.allocate_bill_split('B-OWN',
    '[{"job_id": "ca000000-0000-4000-8000-000000000003", "amount_ex": 400}]', 100, 'Offcuts kept', 'contract@test');
  SELECT sum(amount_ex) FILTER (WHERE is_actual AND document_id = 'B-OWN') AS own,
         sum(amount_ex) FILTER (WHERE is_actual AND document_id = 'B-301' AND lane = 'labour') AS l301
    INTO r FROM public.v_job_cost_events WHERE job_id = 'ca000000-0000-4000-8000-000000000003';
  IF r.own IS DISTINCT FROM 400::numeric THEN
    RAISE EXCEPTION 'cfo18 own job: J3 carries % from B-OWN; expected 400 (overhead ignored)', r.own;
  END IF;
  IF r.l301 IS DISTINCT FROM 100::numeric THEN
    RAISE EXCEPTION 'cfo18 301: J3 labour from B-301 is %; expected 100', r.l301;
  END IF;

  -- Credit notes applied decide; prepayments and overpayments are not credit.
  IF public.job_cost_credit_share('{"AmountCredited": 110, "Prepayments": [{"AppliedAmount": 110}]}', 1100) <> 0
     OR public.job_cost_credit_share('{"AmountCredited": 44, "CreditNotes": [{"AppliedAmount": 22}], "Overpayments": [{"AppliedAmount": 22}]}', 220) <> 0.1
     OR public.job_cost_credit_share('{"AmountCredited": 22}', 220) <> 0.1
     OR public.job_cost_credit_share('{"CreditNotes": {}}', 220) <> 0
     OR public.job_cost_credit_share('{"AmountCredited": 220, "CreditNotes": [{"Total": 220}]}', 1100) <> 0.2 THEN
    RAISE EXCEPTION 'cfo18 credit share: prepayments or overpayments read as credit';
  END IF;

  -- A voided bill with allocation rows is never balanced.
  INSERT INTO public.job_materials_facts (xero_invoice_id, job_id, job_number, lane, kind, amount_ex_gst, confidence, automation_source, fact_date)
  VALUES ('B-VOID', 'ca000000-0000-4000-8000-000000000001', 'CA-J1', 'materials', 'actual', 50, 'high_manual', 'manual_queue', '2026-08-28');
  SELECT * INTO r FROM public.v_bill_allocation_balance WHERE xero_invoice_id = 'B-VOID';
  IF r.balanced IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'cfo18 balance: a voided bill reads balanced (%)', r.balanced;
  END IF;
END $$;

-- ── A different split replaces only its own rows ────────────────────────────
DO $$
DECLARE r record;
BEGIN
  PERFORM public.allocate_bill_split('B-SPLIT',
    '[{"job_id": "ca000000-0000-4000-8000-000000000001", "amount_ex": 1000, "lane": "labour"}]',
    0, NULL, 'contract@test');
  SELECT count(*) AS n, sum(amount_ex_gst) AS ex INTO r FROM public.job_materials_facts WHERE xero_invoice_id = 'B-SPLIT';
  IF r.n <> 1 OR r.ex <> 1000 THEN RAISE EXCEPTION 'cfo18 resplit: % rows, % ex', r.n, r.ex; END IF;
  SELECT overhead_ex, overhead_note INTO r FROM public.materials_reconciliation_queue WHERE xero_invoice_id = 'B-SPLIT';
  IF r.overhead_ex IS NOT NULL OR r.overhead_note IS NOT NULL THEN
    RAISE EXCEPTION 'cfo18 resplit: overhead kept % %', r.overhead_ex, r.overhead_note;
  END IF;
END $$;

-- ── Grants ──────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF has_function_privilege('anon', 'public.allocate_bill_split(text, jsonb, numeric, text, text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.allocate_bill_split(text, jsonb, numeric, text, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'cfo18 grants: a browser role can split bills';
  END IF;
  IF has_table_privilege('anon', 'public.v_bill_allocation_balance', 'SELECT')
     OR has_table_privilege('authenticated', 'public.v_job_cost_events', 'SELECT') THEN
    RAISE EXCEPTION 'cfo18 grants: a browser role can read allocations or the engine';
  END IF;
  IF NOT has_table_privilege('service_role', 'public.v_job_cost_events', 'SELECT')
     OR NOT has_function_privilege('service_role', 'public.allocate_bill_split(text, jsonb, numeric, text, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'cfo18 grants: service_role lost access';
  END IF;
END $$;

ROLLBACK;
