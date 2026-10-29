-- Contract for 20261029170100_context_job_bill_outcomes (Context H7, INT-10):
-- the job card's read of CFO's outcome carries the producer's contract
-- version, no amount at all, holds F1, and keeps unknown unknown.
--
-- Synthetic jobs and bills (the CFO case's h7_fixtures.sql), no customer data.
-- Everything rolls back.

\set ON_ERROR_STOP on

BEGIN;

\ir ../20261029170000_cfo_bill_cost_outcomes/h7_fixtures.sql

-- One more bill on J2 whose number differs by case, for the C order.
INSERT INTO public.xero_invoices (org_id, xero_invoice_id, invoice_number, invoice_type, status, contact_name, sub_total, total, invoice_date, line_items, raw_json, job_id)
VALUES ('00000000-0000-0000-0000-000000000001', 'H7-LOWER', 'b-h7-a', 'ACCPAY', 'AUTHORISED', 'H7 Supplier', 80, 88, '2026-08-27',
        '[{"Description": "Supply", "AccountCode": "310", "LineAmount": 80, "TaxAmount": 8}]', '{"LineAmountTypes": "Exclusive"}',
        'c7000000-0000-4000-8000-000000000002');

DO $$
DECLARE
  v jsonb; b jsonb; c record; got text[]; want text[];
  j1 constant uuid := 'c7000000-0000-4000-8000-000000000001';
  j2 constant uuid := 'c7000000-0000-4000-8000-000000000002';
  j3 constant uuid := 'c7000000-0000-4000-8000-000000000005';
BEGIN
  -- ── the producer's version, on the consumer's answer ──
  v := public.context_job_bill_outcomes(j1);
  IF v ->> 'contract_version' IS DISTINCT FROM 'cfo-bill-cost-outcome-v1'
     OR v ->> 'contract_version' IS DISTINCT FROM (SELECT DISTINCT contract_version FROM public.cfo_bill_cost_outcomes WHERE xero_invoice_id LIKE 'H7-%')
     OR v ->> 'shape' <> 'context-job-bill-outcomes-v1'
     OR NOT (v ->> 'contract_versions_agree')::boolean
     OR (v ->> 'job_id')::uuid <> j1 THEN
    RAISE EXCEPTION 'J1 header: %', v - 'bills';
  END IF;

  -- ── no amount anywhere ──
  FOREACH v IN ARRAY ARRAY[public.context_job_bill_outcomes(j1), public.context_job_bill_outcomes(j2),
                           public.context_job_bill_outcomes(j3)] LOOP
    IF jsonb_path_exists(v, 'strict $.** ? (@.type() == "number")') THEN
      RAISE EXCEPTION 'the Context read carries an amount: a number in %', v;
    END IF;
    IF v::text ~* '"[a-z_]*(_ex|_inc|amount|total|price|cost|owing|paid)[a-z_]*":' THEN
      RAISE EXCEPTION 'the Context read carries an amount: a money key in %', v;
    END IF;
  END LOOP;

  -- ── where each bill counts, seen from J1 ──
  v := public.context_job_bill_outcomes(j1);
  IF jsonb_array_length(v -> 'bills') <> 17 THEN
    RAISE EXCEPTION 'J1 bills: % (expected 17)', jsonb_array_length(v -> 'bills');
  END IF;
  FOR c IN SELECT * FROM (VALUES
    ('H7-PLAIN', 'here'), ('H7-SAME', 'here'), ('H7-MOVE', 'elsewhere'), ('H7-SPLIT', 'here_and_elsewhere'),
    ('H7-SPLITOH', 'here'), ('H7-UNBAL', 'here'), ('H7-OH', 'no_job'), ('H7-OH2', 'no_job'),
    ('H7-NJR', 'held'), ('H7-INST', 'no_job'), ('H7-INSTAI', 'here'), ('H7-INSTNJR', 'no_job'),
    ('H7-VOID', 'no_job'), ('H7-DRAFT', 'no_job'), ('H7-XL', 'no_job'), ('H7-MISS', 'unknown'), ('H7-CRED', 'here')
  ) AS t(bill, where_counted) LOOP
    SELECT e INTO b FROM jsonb_array_elements(v -> 'bills') e WHERE e ->> 'xero_invoice_id' = c.bill;
    IF b IS NULL THEN RAISE EXCEPTION 'J1: % not listed', c.bill; END IF;
    IF b ->> 'where_counted' IS DISTINCT FROM c.where_counted THEN
      RAISE EXCEPTION 'J1: % where_counted % (expected %)', c.bill, b ->> 'where_counted', c.where_counted;
    END IF;
  END LOOP;

  -- A move: here not counted (named why), counted on J2.
  SELECT e INTO b FROM jsonb_array_elements(v -> 'bills') e WHERE e ->> 'xero_invoice_id' = 'H7-MOVE';
  IF b -> 'here' ->> 'counts' <> 'not_counted' OR b -> 'here' ->> 'reason' <> 'xero_link_read_through_rows'
     OR NOT (b -> 'here' ->> 'xero_linked')::boolean
     OR b -> 'other_jobs' -> 0 ->> 'job_number' <> 'H7-J2' OR b -> 'other_jobs' -> 0 ->> 'counts' <> 'counted'
     OR b -> 'other_jobs' -> 0 ->> 'placed_by' <> 'person' THEN
    RAISE EXCEPTION 'J1 H7-MOVE: %', b;
  END IF;
  -- A confirmed split is shares on both jobs, never a duplicate.
  SELECT e INTO b FROM jsonb_array_elements(v -> 'bills') e WHERE e ->> 'xero_invoice_id' = 'H7-SPLIT';
  IF b -> 'here' ->> 'counts' <> 'counted' OR b -> 'other_jobs' -> 0 ->> 'counts' <> 'counted'
     OR b ->> 'bill_state' <> 'counted_in_full' THEN
    RAISE EXCEPTION 'J1 H7-SPLIT: %', b;
  END IF;
  -- F1 is held on every job: no counts, no reason, never "counts here".
  SELECT e INTO b FROM jsonb_array_elements(v -> 'bills') e WHERE e ->> 'xero_invoice_id' = 'H7-NJR';
  IF b -> 'here' ->> 'counts' <> 'held' OR b -> 'here' -> 'reason' <> 'null'::jsonb
     OR b ->> 'held_reason' <> 'not_job_related_mark_on_counted_bill' OR NOT (b ->> 'not_job_related_mark')::boolean THEN
    RAISE EXCEPTION 'J1 H7-NJR: %', b;
  END IF;
  -- An overhead part is named, its amount is not.
  SELECT e INTO b FROM jsonb_array_elements(v -> 'bills') e WHERE e ->> 'xero_invoice_id' = 'H7-SPLITOH';
  IF NOT (b ->> 'overhead_part')::boolean THEN RAISE EXCEPTION 'J1 H7-SPLITOH: %', b; END IF;
  -- The change hash is CFO's.
  SELECT e INTO b FROM jsonb_array_elements(v -> 'bills') e WHERE e ->> 'xero_invoice_id' = 'H7-CRED';
  IF b ->> 'change_hash' IS DISTINCT FROM (SELECT evidence_hash FROM public.cfo_bill_cost_outcomes WHERE xero_invoice_id = 'H7-CRED') THEN
    RAISE EXCEPTION 'J1 H7-CRED change hash: %', b ->> 'change_hash';
  END IF;
  -- A trade-app mirror is not a supplier bill.
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(v -> 'bills') e WHERE e ->> 'xero_invoice_id' = 'H7-MIR') THEN
    RAISE EXCEPTION 'J1 lists the trade-app mirror';
  END IF;

  -- ── seen from J2, in C order ──
  v := public.context_job_bill_outcomes(j2);
  SELECT array_agg(e ->> 'xero_invoice_id' ORDER BY o) INTO got FROM jsonb_array_elements(v -> 'bills') WITH ORDINALITY t(e, o);
  want := ARRAY['H7-LAB', 'H7-MOVE', 'H7-NULLAMT', 'H7-SPLIT', 'H7-UNREC', 'H7-VOID', 'H7-LOWER'];
  IF got IS DISTINCT FROM want THEN RAISE EXCEPTION 'J2 bills (C order by invoice number): %', got; END IF;
  FOR c IN SELECT * FROM (VALUES
    ('H7-LAB', 'no_job', 'not_counted', 'labour_part_unconfirmed'), ('H7-MOVE', 'here', 'counted', 'engine_reads_allocation_rows'),
    ('H7-NULLAMT', 'unknown', 'unknown', 'amount_unreadable'), ('H7-SPLIT', 'here_and_elsewhere', 'counted', 'engine_reads_allocation_rows'),
    ('H7-UNREC', 'here', 'counted', 'engine_reads_allocation_rows'), ('H7-VOID', 'no_job', 'not_counted', 'bill_voided'),
    ('H7-LOWER', 'here', 'counted', 'engine_reads_xero_lines')
  ) AS t(bill, where_counted, counts, reason) LOOP
    SELECT e INTO b FROM jsonb_array_elements(v -> 'bills') e WHERE e ->> 'xero_invoice_id' = c.bill;
    IF b ->> 'where_counted' IS DISTINCT FROM c.where_counted OR b -> 'here' ->> 'counts' IS DISTINCT FROM c.counts
       OR b -> 'here' ->> 'reason' IS DISTINCT FROM c.reason THEN
      RAISE EXCEPTION 'J2: % reads % % % (expected % % %)', c.bill, b ->> 'where_counted', b -> 'here' ->> 'counts',
        b -> 'here' ->> 'reason', c.where_counted, c.counts, c.reason;
    END IF;
  END LOOP;
  SELECT e INTO b FROM jsonb_array_elements(v -> 'bills') e WHERE e ->> 'xero_invoice_id' = 'H7-UNREC';
  IF b -> 'here' ->> 'placed_by' <> 'unrecorded' THEN RAISE EXCEPTION 'J2 H7-UNREC placed_by: %', b; END IF;

  -- ── seen from J3: over-counting passed on by name, a placed mirror shown ──
  v := public.context_job_bill_outcomes(j3);
  SELECT array_agg(e ->> 'xero_invoice_id' ORDER BY o) INTO got FROM jsonb_array_elements(v -> 'bills') WITH ORDINALITY t(e, o);
  want := ARRAY['H7-MIRP', 'H7-OVER1', 'H7-OVER2', 'H7-OVER3'];
  IF got IS DISTINCT FROM want THEN RAISE EXCEPTION 'J3 bills: %', got; END IF;
  FOR c IN SELECT * FROM (VALUES
    ('H7-MIRP', 'trade_app', 'not_counted', 'mirror_bill_person_placed', 'trade_mirror'),
    ('H7-OVER1', 'here', 'counted', 'engine_reads_allocation_rows', 'over_counted'),
    ('H7-OVER2', 'here_and_elsewhere', 'counted', 'engine_reads_allocation_rows', 'over_counted'),
    ('H7-OVER3', 'here', 'counted', 'engine_reads_allocation_rows', 'over_counted')
  ) AS t(bill, where_counted, counts, reason, bill_state) LOOP
    SELECT e INTO b FROM jsonb_array_elements(v -> 'bills') e WHERE e ->> 'xero_invoice_id' = c.bill;
    IF b ->> 'where_counted' IS DISTINCT FROM c.where_counted OR b -> 'here' ->> 'counts' IS DISTINCT FROM c.counts
       OR b -> 'here' ->> 'reason' IS DISTINCT FROM c.reason OR b ->> 'bill_state' IS DISTINCT FROM c.bill_state THEN
      RAISE EXCEPTION 'J3: % reads % % % % (expected % % % %)', c.bill, b ->> 'where_counted', b -> 'here' ->> 'counts',
        b -> 'here' ->> 'reason', b ->> 'bill_state', c.where_counted, c.counts, c.reason, c.bill_state;
    END IF;
  END LOOP;
  -- mirror_bill is CFO's flag, passed on: true only on the placed mirror.
  IF (SELECT array_agg(e ->> 'xero_invoice_id' ORDER BY e ->> 'xero_invoice_id' COLLATE "C")
        FROM jsonb_array_elements(v -> 'bills') e WHERE (e ->> 'mirror_bill')::boolean) IS DISTINCT FROM ARRAY['H7-MIRP']
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(v -> 'bills') e WHERE jsonb_typeof(e -> 'mirror_bill') <> 'boolean') THEN
    RAISE EXCEPTION 'J3 mirror_bill: %', v -> 'bills';
  END IF;

  -- ── a job with no bills: an empty list, never a failure, the same version ──
  v := public.context_job_bill_outcomes('c7000000-0000-4000-8000-0000000000ff');
  IF v -> 'bills' <> '[]'::jsonb OR v ->> 'contract_version' <> 'cfo-bill-cost-outcome-v1' THEN
    RAISE EXCEPTION 'empty job: %', v;
  END IF;

  -- ── the consumer follows the producer: a payment changes nothing it shows ──
  b := public.context_job_bill_outcomes(j1);
  UPDATE public.xero_invoices SET status = 'PAID', amount_paid = 1100, fully_paid_on = '2026-09-30'
   WHERE xero_invoice_id IN ('H7-PLAIN', 'H7-MOVE', 'H7-SPLIT');
  v := public.context_job_bill_outcomes(j1);
  IF (SELECT jsonb_agg(e - 'bill_status') FROM jsonb_array_elements(v -> 'bills') e)
     IS DISTINCT FROM (SELECT jsonb_agg(e - 'bill_status') FROM jsonb_array_elements(b -> 'bills') e) THEN
    RAISE EXCEPTION 'a payment changed the card''s outcome';
  END IF;
END $$;

-- ── the service role runs it with the grants the migrations give (none made here) ──
SET LOCAL ROLE service_role;
DO $$
DECLARE v jsonb;
BEGIN
  v := public.context_job_bill_outcomes('c7000000-0000-4000-8000-000000000001');
  IF jsonb_array_length(v -> 'bills') = 0 THEN
    RAISE EXCEPTION 'the service role read no bills for H7-J1';
  END IF;
END $$;
RESET ROLE;

-- ── it reads CFO's scoped rule, and carries jit off ──
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = 'public.context_job_bill_outcomes(uuid)'::regprocedure
                    AND p.proconfig = ARRAY['jit=off'] AND NOT p.prosecdef
                    AND p.prosrc ~ 'cfo_bill_cost_outcomes_scoped\(p_job\)') THEN
    RAISE EXCEPTION 'context_job_bill_outcomes does not read the scoped rule with jit off';
  END IF;
END $$;

-- ── service role only ──
DO $$
BEGIN
  IF NOT has_function_privilege('service_role', 'public.context_job_bill_outcomes(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'service role cannot call context_job_bill_outcomes';
  END IF;
  IF has_function_privilege('anon', 'public.context_job_bill_outcomes(uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.context_job_bill_outcomes(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'a browser role can call context_job_bill_outcomes';
  END IF;
END $$;

ROLLBACK;
