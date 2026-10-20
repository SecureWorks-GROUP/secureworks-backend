-- Contract for 20261020140000_job_cost_allocation_rows (CFO-18, CFO-20).
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

\set ON_ERROR_STOP on

BEGIN;

INSERT INTO public.jobs (id, org_id, status, type, job_number, legacy, metadata, pricing_json, expected_costs, created_at) VALUES
  ('ca000000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000001', 'complete', 'fencing', 'CA-J1', false, '{}', '{}', NULL, '2026-07-01T00:00:00Z'),
  ('ca000000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000001', 'complete', 'fencing', 'CA-J2', false, '{}', '{}', NULL, '2026-07-01T00:00:00Z'),
  ('ca000000-0000-4000-8000-000000000009', '00000000-0000-0000-0000-000000000001', 'complete', 'fencing', 'CA-HOLD', false, '{"do_not_schedule": "true"}', '{}', NULL, '2026-07-01T00:00:00Z');

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
   '{"LineAmountTypes": "Exclusive", "AmountCredited": 110}', 'ca000000-0000-4000-8000-000000000001');

INSERT INTO public.users (id, org_id, name) VALUES
  ('ca200000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000001', 'CA Trade');
INSERT INTO public.trade_invoices (id, org_id, user_id, week_start, status, subtotal_ex, xero_bill_id, xero_bill_status, invoice_number,
                                   gst_on, gst, total_inc, super_rate, super_amount, gross_earned, net_pay) VALUES
  ('ca100000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000001', 'ca200000-0000-4000-8000-000000000001',
   '2026-08-24', 'paid', 80, 'B-MIRROR', 'PAID', 'TI-CA-1', false, 0, 80, 0.12, 9.6, 80, 70.4);

INSERT INTO public.materials_reconciliation_queue (xero_invoice_id, invoice_number, contact_name, sub_total, total, invoice_date, status) VALUES
  ('B-SPLIT', 'CA-31', 'CA Installer', 1000, 1100, '2026-08-27', 'open'),
  ('B-VOID', 'CA-41', 'CA Steel', 50, 55, '2026-08-28', 'open'),
  ('B-MIRROR', 'CA-42', 'CA Trade', 80, 88, '2026-08-28', 'open');

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
      {"job_id": "ca000000-0000-4000-8000-000000000002", "amount_ex": 300, "lane": "labour"}]',
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
