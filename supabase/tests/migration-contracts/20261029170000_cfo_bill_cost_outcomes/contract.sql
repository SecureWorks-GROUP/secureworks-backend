-- Contract for 20261029170000_cfo_bill_cost_outcomes (job profit H7, INT-12):
-- where each supplier bill's cost counts, and never a placement the engine
-- (v_job_cost_events, summed by v_job_profit) does not count.
--
-- Synthetic jobs and bills (h7_fixtures.sql), no customer data. Everything
-- rolls back.

\set ON_ERROR_STOP on

BEGIN;

\ir h7_fixtures.sql

-- The two load-bearing checks below record a failure here instead of stopping,
-- so the break proof can show that each one catches its own break; the block
-- after them raises them together.
CREATE TEMP TABLE h7_contract_failures (n serial, msg text) ON COMMIT DROP;

-- ── 1. Agreement with the engine (first, so a break of it is named as such): never claims a placement it does not count ─
DO $$
DECLARE bad record;
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
    INSERT INTO h7_contract_failures (msg) VALUES (format(
      'outcome %s/%s claims a placement the engine does not count (or hides one it does): %s',
      bad.xero_invoice_id, bad.job_number, bad.counts));
  END IF;
END $$;

-- ── 1b. Over-counting is its own state, never "in part" ─────────────────────
-- 1200 counted on a 1000 bill, two 700 placements on one 1000 bill, and a 700
-- part plus a 400 overhead part: each is more than the bill ex GST.
DO $$
DECLARE c record;
BEGIN
  FOR c IN
    SELECT o.xero_invoice_id, o.job_number, o.bill_state
      FROM public.cfo_bill_cost_outcomes o
     WHERE o.xero_invoice_id IN ('H7-OVER1', 'H7-OVER2', 'H7-OVER3')
     ORDER BY o.xero_invoice_id COLLATE "C", o.job_number COLLATE "C"
  LOOP
    IF c.bill_state = 'counted_in_part' THEN
      INSERT INTO h7_contract_failures (msg) VALUES (format(
        'over-counting read as counted_in_part: %s/%s', c.xero_invoice_id, c.job_number));
    ELSIF c.bill_state IS DISTINCT FROM 'over_counted' THEN
      INSERT INTO h7_contract_failures (msg) VALUES (format(
        'over-counted bill %s/%s reads %s', c.xero_invoice_id, c.job_number, c.bill_state));
    END IF;
  END LOOP;
  IF (SELECT count(*) FROM public.cfo_bill_cost_outcomes WHERE xero_invoice_id IN ('H7-OVER1', 'H7-OVER2', 'H7-OVER3')) <> 4 THEN
    INSERT INTO h7_contract_failures (msg) VALUES ('over-counted bills are not all listed');
  END IF;
  -- Below the bill is in part, equal is in full. On these fixtures every
  -- allocation row is counted at its own amount, so the states agree with
  -- v_bill_allocation_balance; they need not elsewhere (the read counts the
  -- engine's parts, the view sums every allocation row).
  IF EXISTS (SELECT 1 FROM public.cfo_bill_cost_outcomes o
               JOIN public.v_bill_allocation_balance a ON a.xero_invoice_id = o.xero_invoice_id
              WHERE o.xero_invoice_id LIKE 'H7-%' AND o.bill_counted_jobs > 0
                AND o.bill_state IN ('over_counted', 'counted_in_full', 'counted_in_part')
                AND o.bill_state IS DISTINCT FROM CASE
                      WHEN a.remainder_ex < -0.005 THEN 'over_counted'
                      WHEN abs(a.remainder_ex) <= 0.005 THEN 'counted_in_full'
                      ELSE 'counted_in_part' END) THEN
    INSERT INTO h7_contract_failures (msg) VALUES ('a bill state disagrees with the allocation balance');
  END IF;
END $$;

DO $$
DECLARE f text;
BEGIN
  SELECT string_agg(msg, '; ' ORDER BY n) INTO f FROM h7_contract_failures;
  IF f IS NOT NULL THEN RAISE EXCEPTION 'H7 contract: %', f; END IF;
END $$;

DO $$
DECLARE bad record; r record;
BEGIN
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
    ('H7-HOLDB',   'H7-HOLD', 'counted',     'engine_reads_allocation_rows',     'counted_in_full', 'person'),
    ('H7-OVER1',   'H7-J3',   'counted',     'engine_reads_allocation_rows',     'over_counted',    'person'),
    ('H7-OVER2',   'H7-J3',   'counted',     'engine_reads_allocation_rows',     'over_counted',    'person'),
    ('H7-OVER2',   'H7-J4',   'counted',     'engine_reads_allocation_rows',     'over_counted',    'person'),
    ('H7-OVER3',   'H7-J3',   'counted',     'engine_reads_allocation_rows',     'over_counted',    'person'),
    ('H7-MIRP',    'H7-J3',   'not_counted', 'mirror_bill_person_placed',        'trade_mirror',    'person')
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

  -- No other rows: the mirror no person placed and the expected-kind row on
  -- J2 have none.
  SELECT count(*) INTO n FROM public.cfo_bill_cost_outcomes WHERE xero_invoice_id LIKE 'H7-%';
  IF n <> 30 THEN RAISE EXCEPTION 'outcome rows: % (expected 30)', n; END IF;
  IF EXISTS (SELECT 1 FROM public.cfo_bill_cost_outcomes WHERE xero_invoice_id = 'H7-MIR') THEN
    RAISE EXCEPTION 'a trade-app mirror bill no person placed is listed';
  END IF;
  -- A mirror a person placed is shown, named, and carries no counted amount;
  -- only mirrors are mirror rows.
  SELECT * INTO o FROM public.cfo_bill_cost_outcomes WHERE xero_invoice_id = 'H7-MIRP';
  IF NOT o.mirror_bill OR o.counted_ex IS NOT NULL OR o.bill_counted_jobs <> 0 THEN
    RAISE EXCEPTION 'H7-MIRP: mirror % counted % jobs %', o.mirror_bill, o.counted_ex, o.bill_counted_jobs;
  END IF;
  IF EXISTS (SELECT 1 FROM public.cfo_bill_cost_outcomes
              WHERE xero_invoice_id LIKE 'H7-%' AND mirror_bill AND xero_invoice_id <> 'H7-MIRP') THEN
    RAISE EXCEPTION 'a bill that is not a trade-app mirror reads as one';
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

-- ── 2b. One rule, two scopes: a job's read is the estate's rows for its bills ─
DO $$
DECLARE j record; d1 bigint; d2 bigint; n bigint; def text;
BEGIN
  -- The view is exactly the rule with no job.
  def := pg_get_viewdef('public.cfo_bill_cost_outcomes'::regclass, true);
  IF def !~ 'cfo_bill_cost_outcomes_scoped\(NULL::uuid\)' THEN
    RAISE EXCEPTION 'the estate view is not the scoped rule with no job: %', def;
  END IF;
  -- The rule inlines: plain SQL, STABLE, not strict, no SET clause, invoker.
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang
                  WHERE p.oid = 'public.cfo_bill_cost_outcomes_scoped(uuid)'::regprocedure
                    AND l.lanname = 'sql' AND p.provolatile = 's' AND NOT p.proisstrict
                    AND p.proconfig IS NULL AND NOT p.prosecdef AND p.proretset) THEN
    RAISE EXCEPTION 'cfo_bill_cost_outcomes_scoped is not an inlinable SQL rule';
  END IF;
  -- Every fixture job, and a job with nothing on it: the scoped rows are the
  -- view's rows for the bills placed on that job, byte for byte, both ways.
  FOR j IN SELECT id, job_number FROM public.jobs WHERE job_number LIKE 'H7-%'
           UNION ALL SELECT 'c7000000-0000-4000-8000-0000000000ff'::uuid, 'none' LOOP
    WITH scope AS (
      SELECT x.xero_invoice_id FROM public.xero_invoices x
       WHERE x.invoice_type = 'ACCPAY' AND x.job_id = j.id AND x.xero_invoice_id IS NOT NULL
      UNION
      SELECT f.xero_invoice_id FROM public.job_materials_facts f
       WHERE f.kind = 'actual' AND f.job_id = j.id AND f.xero_invoice_id IS NOT NULL
    ), est AS (
      SELECT v.* FROM public.cfo_bill_cost_outcomes v WHERE v.xero_invoice_id IN (SELECT xero_invoice_id FROM scope)
    ), mine AS (
      SELECT o.* FROM public.cfo_bill_cost_outcomes_scoped(j.id) o
    )
    SELECT (SELECT count(*) FROM (SELECT * FROM est EXCEPT ALL SELECT * FROM mine) a),
           (SELECT count(*) FROM (SELECT * FROM mine EXCEPT ALL SELECT * FROM est) b),
           (SELECT count(*) FROM mine)
      INTO d1, d2, n;
    IF d1 <> 0 OR d2 <> 0 THEN
      RAISE EXCEPTION 'job % read differs from the estate: % estate rows missing, % extra', j.job_number, d1, d2;
    END IF;
    IF j.job_number = 'H7-J1' AND n = 0 THEN RAISE EXCEPTION 'H7-J1 scoped read is empty'; END IF;
    IF j.job_number = 'none' AND n <> 0 THEN RAISE EXCEPTION 'a job with nothing on it reads % rows', n; END IF;
  END LOOP;
END $$;

-- The service role, the rule's only caller, reads both scopes with the grants
-- the migrations give it (no grant is made in this contract).
SET LOCAL ROLE service_role;
SELECT count(*) AS service_role_estate_rows FROM public.cfo_bill_cost_outcomes WHERE xero_invoice_id LIKE 'H7-%';
SELECT count(*) AS service_role_job_rows FROM public.cfo_bill_cost_outcomes_scoped('c7000000-0000-4000-8000-000000000001');
RESET ROLE;

-- ── 3. The change hash (D22: CFO's recommendation, a payment never moves it) ─
DO $$
DECLARE h0 text; h1 text; c0 text; c1 text; def text;
BEGIN
  def := pg_get_functiondef('public.cfo_bill_cost_outcomes_scoped(uuid)'::regprocedure);
  IF def !~ 'md5\(\(?jsonb_build_array\(\s*''cfo-bill-cost-outcome-v1''' THEN
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

  -- Flipping the lines between tax exclusive and inclusive moves it, totals
  -- and lines unchanged: the engine reads an Inclusive line less its tax.
  SELECT evidence_hash INTO h0 FROM public.cfo_bill_cost_outcomes WHERE xero_invoice_id = 'H7-CRED';
  UPDATE public.xero_invoices SET raw_json = raw_json || '{"LineAmountTypes": "Inclusive"}' WHERE xero_invoice_id = 'H7-CRED';
  SELECT evidence_hash INTO h1 FROM public.cfo_bill_cost_outcomes WHERE xero_invoice_id = 'H7-CRED';
  IF h1 = h0 THEN RAISE EXCEPTION 'a LineAmountTypes flip did not move the hash'; END IF;
  UPDATE public.xero_invoices SET raw_json = raw_json || '{"LineAmountTypes": "Exclusive"}' WHERE xero_invoice_id = 'H7-CRED';
  SELECT evidence_hash INTO h1 FROM public.cfo_bill_cost_outcomes WHERE xero_invoice_id = 'H7-CRED';
  IF h1 IS DISTINCT FROM h0 THEN RAISE EXCEPTION 'flipping LineAmountTypes back did not restore the hash'; END IF;

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
  IF NOT has_function_privilege('service_role', 'public.cfo_bill_cost_outcomes_scoped(uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.cfo_bill_cost_outcomes_scoped(uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.cfo_bill_cost_outcomes_scoped(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'cfo_bill_cost_outcomes_scoped is not service role only';
  END IF;
END $$;

ROLLBACK;
