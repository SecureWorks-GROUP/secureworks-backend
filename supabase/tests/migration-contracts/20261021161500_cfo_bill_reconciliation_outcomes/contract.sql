-- Contract for 20261021161500_cfo_bill_reconciliation_outcomes (job profit H7).
--
-- Synthetic jobs and bills, no customer data. Everything rolls back.
--
--   H7-J1, H7-J2  finished fencing jobs.
--   H7-SPLIT  materials bill 1,000 ex on J1 by Xero, split by a person
--             600 J1 / 300 J2 / 100 overhead: confirmed, balanced, decided_by
--             the person. Paying it (AUTHORISED to PAID, amount_due 0) keeps
--             the hash; a changed total moves it and reads unbalanced.
--   H7-AUTO   materials bill on J1 by its Xero job link only: placed_unconfirmed,
--             one machine part xero_job_link; no credit shown, so credit null.
--   H7-REF    materials bill with a reference-path row on J2: placed_unconfirmed;
--             credit 7.70 inc of 77 inc shown, so 7.00 ex.
--   H7-INST   installer bill (306) on J2 by Xero, no person: installer_unconfirmed.
--   H7-INSTP  installer bill (301) a person placed on J2: confirmed.
--   H7-UNBAL  a person placed 250 of a 300 bill: unbalanced.
--   H7-NJR    a person marked not job related: confirmed_overhead.
--   H7-OPEN   waiting in Bills to place, no job: unplaced.
--   H7-VOID   voided in Xero: voided.
--   H7-DRAFT  a draft bill linked to a job: unknown.
--   H7-GONE   a queue row with no stored bill: unknown.
--   H7-MIRROR a trade-app mirror bill on J1: not in the view.
--   No recorded person (verifier A1-A3) and not job related over a Xero link (C8):
--   H7-NOACT  a person-source placement and queue row with no actor:
--             placed_unconfirmed, the part unrecorded.
--   H7-DASH   the same with the 'ops_dashboard' fallback actor: placed_unconfirmed.
--   H7-INSTNA an installer bill placed by a person source with no actor:
--             installer_unconfirmed.
--   H7-TWO    a split whose two parts name different people and whose queue row
--             names nobody: no single decider, so placed_unconfirmed.
--   H7-NJRX   an installer bill Xero-linked to J2, no rows, a person marked it not
--             job related: confirmed_overhead, no parts.
--   H7-NJRNA  marked not job related with no actor: placed_unconfirmed.

\set ON_ERROR_STOP on

BEGIN;

INSERT INTO public.jobs (id, org_id, status, type, job_number, legacy, metadata, pricing_json, expected_costs, created_at) VALUES
  ('c7000000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000001', 'complete', 'fencing', 'H7-J1', false, '{}', '{}', NULL, '2026-07-01T00:00:00Z'),
  ('c7000000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000001', 'complete', 'fencing', 'H7-J2', false, '{}', '{}', NULL, '2026-07-01T00:00:00Z');

INSERT INTO public.xero_invoices (org_id, xero_invoice_id, invoice_number, invoice_type, status, contact_name, sub_total, total, amount_due, invoice_date, line_items, raw_json, job_id) VALUES
  ('00000000-0000-0000-0000-000000000001', 'H7-SPLIT', 'H7-1', 'ACCPAY', 'AUTHORISED', 'H7 Steel', 1000, 1100, 1100, '2026-08-27',
   '[{"Description": "Posts", "AccountCode": "310", "LineAmount": 1000, "TaxAmount": 100}]',
   '{"LineAmountTypes": "Exclusive", "AmountCredited": 0}', 'c7000000-0000-4000-8000-000000000001'),
  ('00000000-0000-0000-0000-000000000001', 'H7-AUTO', 'H7-2', 'ACCPAY', 'AUTHORISED', 'H7 Steel', 200, 220, 220, '2026-08-27',
   '[{"Description": "Rails", "AccountCode": "310", "LineAmount": 200, "TaxAmount": 20}]',
   '{"LineAmountTypes": "Exclusive"}', 'c7000000-0000-4000-8000-000000000001'),
  ('00000000-0000-0000-0000-000000000001', 'H7-REF', 'H7-3', 'ACCPAY', 'AUTHORISED', 'H7 Steel', 70, 77, 69.3, '2026-08-27',
   '[{"Description": "Caps", "AccountCode": "310", "LineAmount": 70, "TaxAmount": 7}]',
   '{"LineAmountTypes": "Exclusive", "AmountCredited": 7.7}', NULL),
  ('00000000-0000-0000-0000-000000000001', 'H7-INST', 'H7-4', 'ACCPAY', 'AUTHORISED', 'H7 Installer', 500, 550, 550, '2026-08-27',
   '[{"Description": "Install", "AccountCode": "306", "LineAmount": 500, "TaxAmount": 50}]',
   '{"LineAmountTypes": "Exclusive"}', 'c7000000-0000-4000-8000-000000000002'),
  ('00000000-0000-0000-0000-000000000001', 'H7-INSTP', 'H7-5', 'ACCPAY', 'PAID', 'H7 Installer', 400, 440, 0, '2026-08-27',
   '[{"Description": "Install", "AccountCode": "301", "LineAmount": 400, "TaxAmount": 40}]',
   '{"LineAmountTypes": "Exclusive"}', NULL),
  ('00000000-0000-0000-0000-000000000001', 'H7-UNBAL', 'H7-6', 'ACCPAY', 'AUTHORISED', 'H7 Steel', 300, 330, 330, '2026-08-27',
   '[{"Description": "Mesh", "AccountCode": "310", "LineAmount": 300, "TaxAmount": 30}]',
   '{"LineAmountTypes": "Exclusive"}', NULL),
  ('00000000-0000-0000-0000-000000000001', 'H7-NJR', 'H7-7', 'ACCPAY', 'AUTHORISED', 'H7 Office', 90, 99, 99, '2026-08-27',
   '[{"Description": "Toner", "AccountCode": "400", "LineAmount": 90, "TaxAmount": 9}]',
   '{"LineAmountTypes": "Exclusive"}', NULL),
  ('00000000-0000-0000-0000-000000000001', 'H7-OPEN', 'H7-8', 'ACCPAY', 'AUTHORISED', 'H7 Steel', 60, 66, 66, '2026-08-27',
   '[{"Description": "Bolts", "AccountCode": "310", "LineAmount": 60, "TaxAmount": 6}]',
   '{"LineAmountTypes": "Exclusive"}', NULL),
  ('00000000-0000-0000-0000-000000000001', 'H7-VOID', 'H7-9', 'ACCPAY', 'VOIDED', 'H7 Steel', 50, 55, 0, '2026-08-27', '[]', '{}', 'c7000000-0000-4000-8000-000000000001'),
  ('00000000-0000-0000-0000-000000000001', 'H7-DRAFT', 'H7-10', 'ACCPAY', 'DRAFT', 'H7 Steel', 40, 44, 44, '2026-08-27',
   '[{"Description": "Gate", "AccountCode": "310", "LineAmount": 40, "TaxAmount": 4}]',
   '{"LineAmountTypes": "Exclusive"}', 'c7000000-0000-4000-8000-000000000001'),
  ('00000000-0000-0000-0000-000000000001', 'H7-MIRROR', 'H7-11', 'ACCPAY', 'PAID', 'H7 Trade', 80, 88, 0, '2026-08-27',
   '[{"Description": "Week | SW - FENCING", "AccountCode": "306", "LineAmount": 80, "TaxAmount": 8}]',
   '{"LineAmountTypes": "Exclusive"}', 'c7000000-0000-4000-8000-000000000001');

INSERT INTO public.materials_reconciliation_queue (xero_invoice_id, invoice_number, contact_name, sub_total, total, invoice_date, status, assigned_by, assigned_at) VALUES
  ('H7-SPLIT', 'H7-1', 'H7 Steel', 1000, 1100, '2026-08-27', 'open', NULL, NULL),
  ('H7-INSTP', 'H7-5', 'H7 Installer', 400, 440, '2026-08-27', 'assigned', 'person:h7-shaun', '2026-09-01T00:00:00Z'),
  ('H7-NJR', 'H7-7', 'H7 Office', 90, 99, '2026-08-27', 'not_job_related', 'person:h7-shaun', '2026-09-02T00:00:00Z'),
  ('H7-OPEN', 'H7-8', 'H7 Steel', 60, 66, '2026-08-27', 'open', NULL, NULL),
  ('H7-GONE', 'H7-12', 'H7 Steel', 30, 33, '2026-08-27', 'open', NULL, NULL);

INSERT INTO public.job_materials_facts (xero_invoice_id, job_id, job_number, lane, kind, amount_ex_gst, confidence, automation_source, fact_date, assigned_by) VALUES
  ('H7-REF', 'c7000000-0000-4000-8000-000000000002', 'H7-J2', 'materials', 'actual', 70, 'high', 'xero_ref_link', '2026-08-27', NULL),
  ('H7-INSTP', 'c7000000-0000-4000-8000-000000000002', 'H7-J2', 'labour', 'actual', 400, 'high_manual', 'manual_queue', '2026-08-27', 'person:h7-shaun'),
  ('H7-UNBAL', 'c7000000-0000-4000-8000-000000000001', 'H7-J1', 'materials', 'actual', 250, 'high_manual', 'manual_queue', '2026-08-27', 'person:h7-shaun');

DO $$
DECLARE v jsonb;
BEGIN
  v := public.allocate_bill_split('H7-SPLIT',
    '[{"job_id": "c7000000-0000-4000-8000-000000000001", "amount_ex": 600, "lane": "materials"},
      {"job_id": "c7000000-0000-4000-8000-000000000002", "amount_ex": 300, "lane": "materials"}]',
    100, 'Yard stock', 'person:h7-shaun');
  IF (v ->> 'ok')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'h7 setup split: %', v;
  END IF;
END $$;

CREATE TEMP TABLE h7_expect (bill text, state text, confirmed boolean, parts int, machine_parts int);
INSERT INTO h7_expect VALUES
  ('H7-SPLIT',  'confirmed',             true,  2, 0),
  ('H7-AUTO',   'placed_unconfirmed',    false, 1, 1),
  ('H7-REF',    'placed_unconfirmed',    false, 1, 1),
  ('H7-INST',   'installer_unconfirmed', false, 1, 1),
  ('H7-INSTP',  'confirmed',             true,  1, 0),
  ('H7-UNBAL',  'unbalanced',            false, 1, 0),
  ('H7-NJR',    'confirmed_overhead',    true,  0, 0),
  ('H7-OPEN',   'unplaced',              false, 0, 0),
  ('H7-VOID',   'voided',                false, 0, 0),
  ('H7-DRAFT',  'unknown',               false, 0, 0),
  ('H7-GONE',   'unknown',               false, 0, 0);

DO $$
DECLARE r record;
BEGIN
  -- Every expected bill, with its state, confirmed flag and parts.
  FOR r IN
    SELECT e.*, o.state AS got_state, o.confirmed AS got_confirmed,
           jsonb_array_length(o.parts) AS got_parts,
           (SELECT count(*) FROM jsonb_array_elements(o.parts) p WHERE p.value ->> 'placed_by' = 'machine') AS got_machine,
           o.contract_version, o.subject_kind, o.evidence_hash
    FROM h7_expect e
    LEFT JOIN public.cfo_bill_reconciliation_outcomes o ON o.xero_invoice_id = e.bill
  LOOP
    IF r.got_state IS NULL THEN
      RAISE EXCEPTION 'h7 contract: % missing from the view', r.bill;
    END IF;
    IF r.bill = 'H7-INST' AND r.got_state = 'confirmed' THEN
      RAISE EXCEPTION 'h7 contract: installer bill no person placed read as confirmed';
    END IF;
    IF r.got_state <> r.state OR r.got_confirmed <> r.confirmed OR r.got_parts <> r.parts OR r.got_machine <> r.machine_parts THEN
      RAISE EXCEPTION 'h7 contract: % read % (confirmed %, % parts, % machine), expected % (%, %, %)',
        r.bill, r.got_state, r.got_confirmed, r.got_parts, r.got_machine, r.state, r.confirmed, r.parts, r.machine_parts;
    END IF;
    IF r.contract_version <> 'cfo-recon-outcome-v1' OR r.subject_kind <> 'xero_accpay' OR r.evidence_hash !~ '^[0-9a-f]{32}$' THEN
      RAISE EXCEPTION 'h7 contract: % identity fields wrong', r.bill;
    END IF;
  END LOOP;

  IF EXISTS (SELECT 1 FROM public.cfo_bill_reconciliation_outcomes WHERE xero_invoice_id = 'H7-MIRROR') THEN
    RAISE EXCEPTION 'h7 contract: a trade-app mirror bill is in the view';
  END IF;
  IF EXISTS (SELECT 1 FROM public.cfo_bill_reconciliation_outcomes
              WHERE confirmed <> (state IN ('confirmed', 'confirmed_overhead'))) THEN
    RAISE EXCEPTION 'h7 contract: confirmed flag disagrees with state';
  END IF;
END $$;

-- The split: parts, overhead, remainder, decider, machine part source.
DO $$
DECLARE o record;
BEGIN
  SELECT * INTO o FROM public.cfo_bill_reconciliation_outcomes WHERE xero_invoice_id = 'H7-SPLIT';
  IF o.overhead_ex <> 100 OR o.remainder_ex <> 0 OR o.bill_ex <> 1000 OR o.credit_applied_ex <> 0
     OR o.decided_by <> 'person:h7-shaun' OR o.decided_at IS NULL THEN
    RAISE EXCEPTION 'h7 contract: split read overhead % remainder % credit % by % at %',
      o.overhead_ex, o.remainder_ex, o.credit_applied_ex, o.decided_by, o.decided_at;
  END IF;
  IF (SELECT sum((p.value ->> 'amount_ex_gst')::numeric) FROM jsonb_array_elements(o.parts) p) <> 900 THEN
    RAISE EXCEPTION 'h7 contract: split parts do not add to 900';
  END IF;

  SELECT * INTO o FROM public.cfo_bill_reconciliation_outcomes WHERE xero_invoice_id = 'H7-AUTO';
  IF o.parts -> 0 ->> 'automation_source' <> 'xero_job_link' OR o.credit_applied_ex IS NOT NULL
     OR o.decided_by IS NOT NULL OR o.decided_at IS NOT NULL THEN
    RAISE EXCEPTION 'h7 contract: Xero-linked bill read % credit % by %', o.parts, o.credit_applied_ex, o.decided_by;
  END IF;

  SELECT * INTO o FROM public.cfo_bill_reconciliation_outcomes WHERE xero_invoice_id = 'H7-REF';
  IF o.credit_applied_ex <> 7.00 THEN
    RAISE EXCEPTION 'h7 contract: shown credit read % not 7.00', o.credit_applied_ex;
  END IF;

  SELECT * INTO o FROM public.cfo_bill_reconciliation_outcomes WHERE xero_invoice_id = 'H7-UNBAL';
  IF o.remainder_ex <> 50 OR o.decided_by IS NOT NULL THEN
    RAISE EXCEPTION 'h7 contract: unbalanced bill remainder % by %', o.remainder_ex, o.decided_by;
  END IF;

  SELECT * INTO o FROM public.cfo_bill_reconciliation_outcomes WHERE xero_invoice_id = 'H7-NJR';
  IF o.decided_by <> 'person:h7-shaun' OR o.decided_at <> '2026-09-02T00:00:00Z'::timestamptz THEN
    RAISE EXCEPTION 'h7 contract: not-job-related decider % at %', o.decided_by, o.decided_at;
  END IF;

  SELECT * INTO o FROM public.cfo_bill_reconciliation_outcomes WHERE xero_invoice_id = 'H7-GONE';
  IF o.bill_ex IS NOT NULL OR o.remainder_ex IS NOT NULL THEN
    RAISE EXCEPTION 'h7 contract: a bill with no stored copy shows amounts';
  END IF;
END $$;

-- The hash: stable on re-read; a payment does not move it (CFO proposal); a
-- changed total, a changed line or a moved part does.
DO $$
DECLARE h0 text; h1 text; h2 text; h3 text; h4 text; s text;
BEGIN
  SELECT evidence_hash INTO h0 FROM public.cfo_bill_reconciliation_outcomes WHERE xero_invoice_id = 'H7-SPLIT';
  SELECT evidence_hash INTO h1 FROM public.cfo_bill_reconciliation_outcomes WHERE xero_invoice_id = 'H7-SPLIT';
  IF h0 <> h1 THEN RAISE EXCEPTION 'h7 contract: hash not stable on re-read'; END IF;

  UPDATE public.xero_invoices SET status = 'PAID', amount_due = 0 WHERE xero_invoice_id = 'H7-SPLIT';
  SELECT evidence_hash, state INTO h2, s FROM public.cfo_bill_reconciliation_outcomes WHERE xero_invoice_id = 'H7-SPLIT';
  IF h2 <> h0 OR s <> 'confirmed' THEN
    RAISE EXCEPTION 'h7 contract: paying the bill moved the hash or state (%)', s;
  END IF;

  UPDATE public.xero_invoices SET line_items = '[{"Description": "Posts, galv", "AccountCode": "310", "LineAmount": 1000, "TaxAmount": 100}]'
   WHERE xero_invoice_id = 'H7-SPLIT';
  SELECT evidence_hash INTO h3 FROM public.cfo_bill_reconciliation_outcomes WHERE xero_invoice_id = 'H7-SPLIT';
  IF h3 = h0 THEN RAISE EXCEPTION 'h7 contract: a changed line kept the hash'; END IF;

  UPDATE public.xero_invoices SET sub_total = 1001, total = 1101.1 WHERE xero_invoice_id = 'H7-SPLIT';
  SELECT evidence_hash, state INTO h4, s FROM public.cfo_bill_reconciliation_outcomes WHERE xero_invoice_id = 'H7-SPLIT';
  IF h4 = h3 OR s <> 'unbalanced' THEN
    RAISE EXCEPTION 'h7 contract: a changed total kept the hash or read % not unbalanced', s;
  END IF;

  SELECT evidence_hash INTO h0 FROM public.cfo_bill_reconciliation_outcomes WHERE xero_invoice_id = 'H7-UNBAL';
  UPDATE public.job_materials_facts SET amount_ex_gst = 300 WHERE xero_invoice_id = 'H7-UNBAL';
  SELECT evidence_hash, state INTO h1, s FROM public.cfo_bill_reconciliation_outcomes WHERE xero_invoice_id = 'H7-UNBAL';
  IF h1 = h0 OR s <> 'confirmed' THEN
    RAISE EXCEPTION 'h7 contract: a corrected part kept the hash or read % not confirmed', s;
  END IF;
END $$;

-- No recorded person never settles a bill; a not-job-related mark wins over a
-- Xero job link with no row.
INSERT INTO public.xero_invoices (org_id, xero_invoice_id, invoice_number, invoice_type, status, contact_name, sub_total, total, amount_due, invoice_date, line_items, raw_json, job_id) VALUES
  ('00000000-0000-0000-0000-000000000001', 'H7-NOACT', 'H7-21', 'ACCPAY', 'AUTHORISED', 'H7 Steel', 150, 165, 165, '2026-08-27',
   '[{"Description": "Sleepers", "AccountCode": "310", "LineAmount": 150, "TaxAmount": 15}]', '{"LineAmountTypes": "Exclusive"}', NULL),
  ('00000000-0000-0000-0000-000000000001', 'H7-DASH', 'H7-22', 'ACCPAY', 'AUTHORISED', 'H7 Steel', 120, 132, 132, '2026-08-27',
   '[{"Description": "Plinths", "AccountCode": "310", "LineAmount": 120, "TaxAmount": 12}]', '{"LineAmountTypes": "Exclusive"}', NULL),
  ('00000000-0000-0000-0000-000000000001', 'H7-INSTNA', 'H7-23', 'ACCPAY', 'AUTHORISED', 'H7 Installer', 350, 385, 385, '2026-08-27',
   '[{"Description": "Install", "AccountCode": "306", "LineAmount": 350, "TaxAmount": 35}]', '{"LineAmountTypes": "Exclusive"}', NULL),
  ('00000000-0000-0000-0000-000000000001', 'H7-TWO', 'H7-24', 'ACCPAY', 'AUTHORISED', 'H7 Steel', 200, 220, 220, '2026-08-27',
   '[{"Description": "Rails", "AccountCode": "310", "LineAmount": 200, "TaxAmount": 20}]', '{"LineAmountTypes": "Exclusive"}', NULL),
  ('00000000-0000-0000-0000-000000000001', 'H7-NJRX', 'H7-25', 'ACCPAY', 'AUTHORISED', 'H7 Installer', 310, 341, 341, '2026-08-27',
   '[{"Description": "Install", "AccountCode": "306", "LineAmount": 310, "TaxAmount": 31}]', '{"LineAmountTypes": "Exclusive"}', 'c7000000-0000-4000-8000-000000000002'),
  ('00000000-0000-0000-0000-000000000001', 'H7-NJRNA', 'H7-26', 'ACCPAY', 'AUTHORISED', 'H7 Office', 45, 49.5, 49.5, '2026-08-27',
   '[{"Description": "Paper", "AccountCode": "400", "LineAmount": 45, "TaxAmount": 4.5}]', '{"LineAmountTypes": "Exclusive"}', NULL);

INSERT INTO public.materials_reconciliation_queue (xero_invoice_id, invoice_number, contact_name, sub_total, total, invoice_date, status, assigned_by, assigned_at) VALUES
  ('H7-NOACT', 'H7-21', 'H7 Steel', 150, 165, '2026-08-27', 'assigned', NULL, '2026-09-03T00:00:00Z'),
  ('H7-DASH', 'H7-22', 'H7 Steel', 120, 132, '2026-08-27', 'assigned', 'ops_dashboard', '2026-09-03T00:00:00Z'),
  ('H7-INSTNA', 'H7-23', 'H7 Installer', 350, 385, '2026-08-27', 'assigned', '  ', '2026-09-03T00:00:00Z'),
  ('H7-TWO', 'H7-24', 'H7 Steel', 200, 220, '2026-08-27', 'split', NULL, '2026-09-03T00:00:00Z'),
  ('H7-NJRX', 'H7-25', 'H7 Installer', 310, 341, '2026-08-27', 'not_job_related', 'person:h7-shaun', '2026-09-04T00:00:00Z'),
  ('H7-NJRNA', 'H7-26', 'H7 Office', 45, 49.5, '2026-08-27', 'not_job_related', NULL, '2026-09-04T00:00:00Z');

INSERT INTO public.job_materials_facts (xero_invoice_id, job_id, job_number, lane, kind, amount_ex_gst, confidence, automation_source, fact_date, assigned_by) VALUES
  ('H7-NOACT', 'c7000000-0000-4000-8000-000000000001', 'H7-J1', 'materials', 'actual', 150, 'high_manual', 'manual_queue', '2026-08-27', NULL),
  ('H7-DASH', 'c7000000-0000-4000-8000-000000000001', 'H7-J1', 'materials', 'actual', 120, 'high_manual', 'manual_queue', '2026-08-27', 'ops_dashboard'),
  ('H7-INSTNA', 'c7000000-0000-4000-8000-000000000002', 'H7-J2', 'labour', 'actual', 350, 'high_manual', 'manual_queue', '2026-08-27', ''),
  ('H7-TWO', 'c7000000-0000-4000-8000-000000000001', 'H7-J1', 'materials', 'actual', 100, 'high_manual', 'manual_split', '2026-08-27', 'person:h7-a'),
  ('H7-TWO', 'c7000000-0000-4000-8000-000000000002', 'H7-J2', 'materials', 'actual', 100, 'high_manual', 'manual_split', '2026-08-27', 'person:h7-b');

DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT e.bill, e.state, e.parts, e.unrecorded, o.state AS got_state, o.confirmed AS got_confirmed,
           o.decided_by, jsonb_array_length(o.parts) AS got_parts,
           (SELECT count(*) FROM jsonb_array_elements(o.parts) p WHERE p.value ->> 'placed_by' = 'unrecorded') AS got_unrecorded
    FROM (VALUES ('H7-NOACT', 'placed_unconfirmed', 1, 1), ('H7-DASH', 'placed_unconfirmed', 1, 1),
                 ('H7-INSTNA', 'installer_unconfirmed', 1, 1), ('H7-TWO', 'placed_unconfirmed', 2, 0),
                 ('H7-NJRX', 'confirmed_overhead', 0, 0), ('H7-NJRNA', 'placed_unconfirmed', 0, 0))
         AS e(bill, state, parts, unrecorded)
    LEFT JOIN public.cfo_bill_reconciliation_outcomes o ON o.xero_invoice_id = e.bill
  LOOP
    IF r.got_state IS DISTINCT FROM r.state OR r.got_parts <> r.parts OR r.got_unrecorded <> r.unrecorded THEN
      RAISE EXCEPTION 'h7 contract: % read % (% parts, % unrecorded), expected % (%, %)',
        r.bill, r.got_state, r.got_parts, r.got_unrecorded, r.state, r.parts, r.unrecorded;
    END IF;
    IF r.bill <> 'H7-NJRX' AND (r.got_confirmed OR r.decided_by IS NOT NULL) THEN
      RAISE EXCEPTION 'h7 contract: % with no recorded person read settled (by %)', r.bill, r.decided_by;
    END IF;
    IF r.bill = 'H7-NJRX' AND (NOT r.got_confirmed OR r.decided_by IS DISTINCT FROM 'person:h7-shaun') THEN
      RAISE EXCEPTION 'h7 contract: not-job-related mark lost to the Xero job link (by %)', r.decided_by;
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM public.cfo_bill_reconciliation_outcomes WHERE confirmed AND decided_by IS NULL) THEN
    RAISE EXCEPTION 'h7 contract: a bill reads confirmed with no recorded decider';
  END IF;
END $$;

-- Access: service role reads; browser roles cannot.
DO $$
BEGIN
  IF has_table_privilege('anon', 'public.cfo_bill_reconciliation_outcomes', 'SELECT')
     OR has_table_privilege('authenticated', 'public.cfo_bill_reconciliation_outcomes', 'SELECT')
     OR NOT has_table_privilege('service_role', 'public.cfo_bill_reconciliation_outcomes', 'SELECT') THEN
    RAISE EXCEPTION 'h7 contract: view grants wrong';
  END IF;
END $$;

ROLLBACK;
