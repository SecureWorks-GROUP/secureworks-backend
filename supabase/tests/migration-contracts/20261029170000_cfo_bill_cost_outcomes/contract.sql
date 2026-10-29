-- Contract for 20261029170000_cfo_bill_cost_outcomes (job profit H7, INT-12):
-- where each supplier bill's cost counts, and never a placement the engine
-- (v_job_cost_events, summed by v_job_profit) does not count.
--
-- Synthetic jobs and bills (h7_fixtures.sql), no customer data. Everything
-- rolls back.

\set ON_ERROR_STOP on

BEGIN;

\ir h7_fixtures.sql

-- ── 1. Agreement with the engine (first, so a break of it is named as such): never claims a placement it does not count ─
DO $$
DECLARE bad record; r record;
BEGIN
  -- counted exactly when the engine has an actual row of the bill on the job
  -- and Job Profit reads that job.
  SELECT o.xero_invoice_id, o.job_number, o.counts INTO bad
    FROM public.cfo_bill_cost_outcomes o
   WHERE o.xero_invoice_id LIKE 'H7-%'
     AND (o.counts = 'counted') IS DISTINCT FROM (
           EXISTS (SELECT 1 FROM public.v_job_cost_events e
                    WHERE e.document_id = o.xero_invoice_id AND e.job_id = o.job_id AND e.is_actual)
           AND EXISTS (SELECT 1 FROM public.v_job_profit p WHERE p.job_id = o.job_id))
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'outcome %/% claims a placement the engine does not count (or hides one it does): %',
      bad.xero_invoice_id, bad.job_number, bad.counts;
  END IF;

  -- Every bill and job the engine counts is listed.
  SELECT e.document_id, e.job_id INTO bad
    FROM public.v_job_cost_events e
   WHERE e.document_id LIKE 'H7-%' AND e.is_actual
     AND NOT EXISTS (SELECT 1 FROM public.cfo_bill_cost_outcomes o
                      WHERE o.xero_invoice_id = e.document_id AND o.job_id = e.job_id)
   LIMIT 1;
  IF FOUND THEN RAISE EXCEPTION 'engine counts %/% and the outcome does not list it', bad.document_id, bad.job_id; END IF;

  -- Per job, what the outcome says counts equals the profit engine's actual cost.
  FOR r IN
    SELECT p.job_number, p.actual_cost_ex,
           (SELECT COALESCE(sum(o.counted_ex), 0) FROM public.cfo_bill_cost_outcomes o
             WHERE o.job_id = p.job_id AND o.counts = 'counted') AS outcome_ex
      FROM public.v_job_profit p WHERE p.job_number LIKE 'H7-%'
  LOOP
    IF r.actual_cost_ex IS DISTINCT FROM r.outcome_ex THEN
      RAISE EXCEPTION 'job % profit actual cost % but outcome counts %', r.job_number, r.actual_cost_ex, r.outcome_ex;
    END IF;
  END LOOP;
  SELECT actual_cost_ex INTO r FROM public.v_job_profit WHERE job_number = 'H7-J1';
  IF r.actual_cost_ex <> 5350 THEN RAISE EXCEPTION 'H7-J1 actual cost %', r.actual_cost_ex; END IF;
END $$;

-- ── 2. Every bill and job, as expected ──────────────────────────────────────
DO $$
DECLARE c record; o record; n integer;
BEGIN
  FOR c IN SELECT * FROM (VALUES
    ('H7-PLAIN',   'H7-J1',   'counted',     'engine_reads_xero_lines',          'counted_in_full', 'xero_link'),
    ('H7-SAME',    'H7-J1',   'counted',     'engine_reads_xero_lines',          'counted_in_full', 'person'),
    ('H7-MOVE',    'H7-J1',   'not_counted', 'xero_link_read_through_rows',      'counted_in_full', 'xero_link'),
    ('H7-MOVE',    'H7-J2',   'counted',     'engine_reads_allocation_rows',     'counted_in_full', 'person'),
    ('H7-SPLIT',   'H7-J1',   'counted',     'engine_reads_allocation_rows',     'counted_in_full', 'person'),
    ('H7-SPLIT',   'H7-J2',   'counted',     'engine_reads_allocation_rows',     'counted_in_full', 'person'),
    ('H7-SPLITOH', 'H7-J1',   'counted',     'engine_reads_allocation_rows',     'counted_in_full', 'person'),
    ('H7-UNBAL',   'H7-J1',   'counted',     'engine_reads_allocation_rows',     'counted_in_part', 'person'),
    ('H7-OH',      'H7-J1',   'not_counted', 'xero_link_read_through_overhead',  'overhead',        'xero_link'),
    ('H7-OH2',     'H7-J1',   'not_counted', 'xero_link_read_through_overhead',  'not_counted',     'xero_link'),
    ('H7-NJR',     'H7-J1',   'counted',     'engine_reads_xero_lines',          'held',            'xero_link'),
    ('H7-INST',    'H7-J1',   'not_counted', 'installer_unconfirmed',            'not_counted',     'xero_link'),
    ('H7-INSTAI',  'H7-J1',   'counted',     'engine_reads_allocation_rows',     'counted_in_full', 'ai_reader'),
    ('H7-INSTNJR', 'H7-J1',   'not_counted', 'installer_not_job_related',        'not_job_related', 'xero_link'),
    ('H7-LAB',     'H7-J2',   'not_counted', 'labour_part_unconfirmed',          'not_counted',     'rule'),
    ('H7-UNREC',   'H7-J2',   'counted',     'engine_reads_allocation_rows',     'counted_in_full', 'unrecorded'),
    ('H7-VOID',    'H7-J1',   'not_counted', 'bill_voided',                      'voided',          'xero_link'),
    ('H7-VOID',    'H7-J2',   'not_counted', 'bill_voided',                      'voided',          'person'),
    ('H7-DRAFT',   'H7-J1',   'not_counted', 'bill_not_approved',                'not_counted',     'xero_link'),
    ('H7-XL',      'H7-J1',   'not_counted', 'xero_link_hidden_by_other_row',    'not_counted',     'xero_link'),
    ('H7-LEGB',    'H7-LEG',  'not_counted', 'job_outside_job_profit',           'not_counted',     'person'),
    ('H7-MISS',    'H7-J1',   'counted',     'engine_reads_allocation_rows',     'unknown',         'person'),
    ('H7-NULLAMT', 'H7-J2',   'unknown',     'amount_unreadable',                'unknown',         'person'),
    ('H7-CRED',    'H7-J1',   'counted',     'engine_reads_xero_lines',          'counted_in_full', 'xero_link'),
    ('H7-HOLDB',   'H7-HOLD', 'counted',     'engine_reads_allocation_rows',     'counted_in_full', 'person')
  ) AS t(bill, job, counts, reason, bill_state, placed_by) LOOP
    SELECT * INTO o FROM public.cfo_bill_cost_outcomes v
     WHERE v.xero_invoice_id = c.bill AND v.job_number = c.job;
    IF NOT FOUND THEN RAISE EXCEPTION 'outcome %/% missing', c.bill, c.job; END IF;
    IF o.counts IS DISTINCT FROM c.counts OR o.reason IS DISTINCT FROM c.reason
       OR o.bill_state IS DISTINCT FROM c.bill_state OR o.placed_by IS DISTINCT FROM c.placed_by THEN
      RAISE EXCEPTION 'outcome %/%: counts % reason % state % placed_by % (expected % % % %)',
        c.bill, c.job, o.counts, o.reason, o.bill_state, o.placed_by, c.counts, c.reason, c.bill_state, c.placed_by;
    END IF;
    IF o.contract_version <> 'cfo-bill-cost-outcome-v1' OR o.subject_kind <> 'xero_accpay' THEN
      RAISE EXCEPTION 'outcome %/%: version % kind %', c.bill, c.job, o.contract_version, o.subject_kind;
    END IF;
  END LOOP;

  -- No other rows: the mirror and the expected-kind row on J2 have none.
  SELECT count(*) INTO n FROM public.cfo_bill_cost_outcomes WHERE xero_invoice_id LIKE 'H7-%';
  IF n <> 25 THEN RAISE EXCEPTION 'outcome rows: % (expected 25)', n; END IF;
  IF EXISTS (SELECT 1 FROM public.cfo_bill_cost_outcomes WHERE xero_invoice_id = 'H7-MIR') THEN
    RAISE EXCEPTION 'a trade-app mirror bill is listed';
  END IF;
  IF EXISTS (SELECT 1 FROM public.cfo_bill_cost_outcomes WHERE xero_invoice_id = 'H7-XL' AND job_number = 'H7-J2') THEN
    RAISE EXCEPTION 'an expected-kind row is listed as a placement';
  END IF;

  -- held: the F1 mark, named; nothing else is held.
  SELECT * INTO o FROM public.cfo_bill_cost_outcomes WHERE xero_invoice_id = 'H7-NJR';
  IF o.held_reason IS DISTINCT FROM 'not_job_related_mark_on_counted_bill' OR NOT o.not_job_related_mark THEN
    RAISE EXCEPTION 'H7-NJR held: % %', o.held_reason, o.not_job_related_mark;
  END IF;
  IF EXISTS (SELECT 1 FROM public.cfo_bill_cost_outcomes
              WHERE xero_invoice_id LIKE 'H7-%' AND xero_invoice_id <> 'H7-NJR' AND held_reason IS NOT NULL) THEN
    RAISE EXCEPTION 'a held_reason on a bill that is not held';
  END IF;

  -- Amounts are CFO's and exact: a credit comes off in proportion, unknown is
  -- never 0, and an uncounted placement carries no counted amount.
  SELECT * INTO o FROM public.cfo_bill_cost_outcomes WHERE xero_invoice_id = 'H7-CRED';
  IF o.counted_ex <> 900 OR o.credit_applied_ex <> 100 OR o.bill_ex <> 1000 THEN
    RAISE EXCEPTION 'H7-CRED amounts: counted % credit % bill %', o.counted_ex, o.credit_applied_ex, o.bill_ex;
  END IF;
  SELECT * INTO o FROM public.cfo_bill_cost_outcomes WHERE xero_invoice_id = 'H7-PLAIN';
  IF o.credit_applied_ex IS NOT NULL THEN RAISE EXCEPTION 'H7-PLAIN credit assumed: %', o.credit_applied_ex; END IF;
  SELECT * INTO o FROM public.cfo_bill_cost_outcomes WHERE xero_invoice_id = 'H7-NULLAMT';
  IF o.counted_ex IS NOT NULL OR o.placed_ex IS NOT NULL THEN
    RAISE EXCEPTION 'H7-NULLAMT unknown read as a figure: % %', o.counted_ex, o.placed_ex;
  END IF;
  IF EXISTS (SELECT 1 FROM public.cfo_bill_cost_outcomes
              WHERE xero_invoice_id LIKE 'H7-%' AND counts <> 'counted' AND counted_ex IS NOT NULL) THEN
    RAISE EXCEPTION 'an uncounted placement carries a counted amount';
  END IF;
  SELECT * INTO o FROM public.cfo_bill_cost_outcomes WHERE xero_invoice_id = 'H7-SPLITOH';
  IF NOT o.overhead_part OR o.overhead_ex <> 400 THEN RAISE EXCEPTION 'H7-SPLITOH overhead: % %', o.overhead_part, o.overhead_ex; END IF;
  SELECT * INTO o FROM public.cfo_bill_cost_outcomes WHERE xero_invoice_id = 'H7-HOLDB';
  IF NOT o.holding_job THEN RAISE EXCEPTION 'H7-HOLDB holding job not named'; END IF;
  SELECT * INTO o FROM public.cfo_bill_cost_outcomes WHERE xero_invoice_id = 'H7-SPLIT' AND job_number = 'H7-J1';
  IF o.bill_counted_jobs <> 2 THEN RAISE EXCEPTION 'H7-SPLIT counted jobs: %', o.bill_counted_jobs; END IF;
END $$;

-- ── 3. The change hash (D22: CFO's recommendation, a payment never moves it) ─
DO $$
DECLARE h0 text; h1 text; c0 text; c1 text; def text;
BEGIN
  def := pg_get_viewdef('public.cfo_bill_cost_outcomes'::regclass, true);
  IF def !~ 'md5\(\(?jsonb_build_array\(''cfo-bill-cost-outcome-v1''' THEN
    RAISE EXCEPTION 'the contract version does not lead the change hash';
  END IF;

  SELECT evidence_hash, counts INTO h0, c0 FROM public.cfo_bill_cost_outcomes WHERE xero_invoice_id = 'H7-PLAIN';
  UPDATE public.xero_invoices SET status = 'PAID', amount_paid = 1100, fully_paid_on = '2026-09-30'
   WHERE xero_invoice_id = 'H7-PLAIN';
  SELECT evidence_hash, counts INTO h1, c1 FROM public.cfo_bill_cost_outcomes WHERE xero_invoice_id = 'H7-PLAIN';
  IF h1 IS DISTINCT FROM h0 OR c1 IS DISTINCT FROM c0 THEN
    RAISE EXCEPTION 'a payment moved the outcome: hash % -> %, counts % -> %', h0, h1, c0, c1;
  END IF;
  -- A prepayment applied is a payment too.
  UPDATE public.xero_invoices SET raw_json = raw_json || '{"AmountCredited": 50, "Prepayments": [{"AppliedAmount": 50}]}'
   WHERE xero_invoice_id = 'H7-PLAIN';
  SELECT evidence_hash INTO h1 FROM public.cfo_bill_cost_outcomes WHERE xero_invoice_id = 'H7-PLAIN';
  IF h1 IS DISTINCT FROM h0 THEN RAISE EXCEPTION 'a prepayment moved the hash'; END IF;
  IF (SELECT credit_applied_ex FROM public.cfo_bill_cost_outcomes WHERE xero_invoice_id = 'H7-PLAIN') <> 0 THEN
    RAISE EXCEPTION 'a prepayment read as credit';
  END IF;
  -- A real credit moves it.
  UPDATE public.xero_invoices SET raw_json = raw_json || '{"AmountCredited": 160}' WHERE xero_invoice_id = 'H7-PLAIN';
  SELECT evidence_hash INTO h1 FROM public.cfo_bill_cost_outcomes WHERE xero_invoice_id = 'H7-PLAIN';
  IF h1 = h0 THEN RAISE EXCEPTION 'a credit did not move the hash'; END IF;

  -- A changed line moves it.
  SELECT evidence_hash INTO h0 FROM public.cfo_bill_cost_outcomes WHERE xero_invoice_id = 'H7-SAME';
  UPDATE public.xero_invoices SET line_items = '[{"Description": "Supply, amended", "AccountCode": "310", "LineAmount": 500, "TaxAmount": 50}]'
   WHERE xero_invoice_id = 'H7-SAME';
  SELECT evidence_hash INTO h1 FROM public.cfo_bill_cost_outcomes WHERE xero_invoice_id = 'H7-SAME';
  IF h1 = h0 THEN RAISE EXCEPTION 'a changed line did not move the hash'; END IF;

  -- A changed overhead part moves it.
  SELECT evidence_hash INTO h0 FROM public.cfo_bill_cost_outcomes WHERE xero_invoice_id = 'H7-OH2';
  UPDATE public.materials_reconciliation_queue SET overhead_ex = 350 WHERE xero_invoice_id = 'H7-OH2';
  SELECT evidence_hash INTO h1 FROM public.cfo_bill_cost_outcomes WHERE xero_invoice_id = 'H7-OH2';
  IF h1 = h0 THEN RAISE EXCEPTION 'a changed overhead did not move the hash'; END IF;

  -- A row moved to another job moves it, and the outcome follows the engine.
  SELECT evidence_hash INTO h0 FROM public.cfo_bill_cost_outcomes WHERE xero_invoice_id = 'H7-SAME' LIMIT 1;
  UPDATE public.job_materials_facts SET job_id = 'c7000000-0000-4000-8000-000000000002', job_number = 'H7-J2'
   WHERE xero_invoice_id = 'H7-SAME';
  SELECT evidence_hash INTO h1 FROM public.cfo_bill_cost_outcomes WHERE xero_invoice_id = 'H7-SAME' LIMIT 1;
  IF h1 = h0 THEN RAISE EXCEPTION 'a moved row did not move the hash'; END IF;
  IF (SELECT counts FROM public.cfo_bill_cost_outcomes WHERE xero_invoice_id = 'H7-SAME' AND job_number = 'H7-J1') <> 'not_counted'
     OR (SELECT counts FROM public.cfo_bill_cost_outcomes WHERE xero_invoice_id = 'H7-SAME' AND job_number = 'H7-J2') <> 'counted' THEN
    RAISE EXCEPTION 'H7-SAME did not follow its moved row';
  END IF;
END $$;

-- ── 4. Read only, service role only ─────────────────────────────────────────
DO $$
BEGIN
  IF NOT has_table_privilege('service_role', 'public.cfo_bill_cost_outcomes', 'SELECT') THEN
    RAISE EXCEPTION 'service role cannot read the outcome';
  END IF;
  IF has_table_privilege('anon', 'public.cfo_bill_cost_outcomes', 'SELECT')
     OR has_table_privilege('authenticated', 'public.cfo_bill_cost_outcomes', 'SELECT') THEN
    RAISE EXCEPTION 'a browser role can read the outcome';
  END IF;
END $$;

ROLLBACK;
