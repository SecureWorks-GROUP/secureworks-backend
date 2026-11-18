\set ON_ERROR_STOP on
BEGIN;

-- Rule 17: protect prerequisites and re-apply our own migration twice.
CREATE INDEX IF NOT EXISTS idx_xero_invoices_date ON public.xero_invoices(invoice_date);
SELECT to_regprocedure('public.job_division_option(text,text,uuid)') IS NULL AS need_division_option \gset
\if :need_division_option
\ir ../../../migrations/20261117163100_xero_draft_standard.sql
\ir ../../../migrations/20261118080638_job_division_option.sql
\ir ../../../migrations/20261118120115_division_rulings.sql
\endif
\ir ../../../migrations/20261118153103_division_tieout_our_lines.sql
\ir ../../../migrations/20261118153103_division_tieout_our_lines.sql

CREATE TEMP TABLE checks(label text PRIMARY KEY);
CREATE FUNCTION pg_temp.prove(label text, ok boolean) RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF ok IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'P3-04.5 failed: %', label;
  END IF;
  INSERT INTO checks VALUES (label);
END $$;

-- 1. Signature, STABLE, SECURITY DEFINER, service_role only, and no v_job_profit read.
DO $$
DECLARE
  fn_oid oid := to_regprocedure('public.division_tieout_our_lines(uuid,date)');
  fn_src text;
BEGIN
  PERFORM pg_temp.prove('function exists, STABLE and SECURITY DEFINER',
    fn_oid IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM pg_proc WHERE oid = fn_oid AND provolatile = 's' AND prosecdef = true
    )
  );
  SELECT prosrc INTO fn_src FROM pg_proc WHERE oid = fn_oid;
  PERFORM pg_temp.prove('does not read v_job_profit', position('v_job_profit' IN lower(fn_src)) = 0);
  PERFORM pg_temp.prove('service_role execute only',
    has_function_privilege('service_role', fn_oid, 'EXECUTE')
    AND NOT has_function_privilege('anon', fn_oid, 'EXECUTE')
    AND NOT has_function_privilege('authenticated', fn_oid, 'EXECUTE')
  );
END $$;

SET LOCAL ROLE authenticated;
DO $$
BEGIN
  PERFORM * FROM public.division_tieout_our_lines('00000000-0000-0000-0000-000000000045', DATE '2026-10-01');
  RAISE EXCEPTION 'authenticated_call_accepted';
EXCEPTION WHEN insufficient_privilege THEN
  NULL;
END $$;
RESET ROLE;
SELECT pg_temp.prove('authenticated call refused', true);

-- Rule 15 / 21b: pre-image guard refuses an unexpected body on live (also covered by preexisting-failure.sql).
DO $$
BEGIN
  PERFORM pg_temp.prove('expected prosrc md5 matches guard',
    (SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('public.division_tieout_our_lines(uuid,date)'))
    = '8aff0b5bb7d30f80cfe3a3a4410fe02b'
  );
END $$;

-- 2. ZZTEST round-figure fixtures covering every rule in P3-04.5.
\set org '00000000-0000-4000-8000-000000000405'
\set other_org '00000000-0000-4000-8000-000000000406'
\set job_fence '40500000-0000-4000-8000-000000000001'
\set job_patio '40500000-0000-4000-8000-000000000002'
\set job_deck '40500000-0000-4000-8000-000000000003'

INSERT INTO public.organisations (id, name)
VALUES (:'org', 'ZZTEST Org'), (:'other_org', 'ZZTEST Other Org')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.jobs (id, org_id, job_number, type, status)
VALUES
  (:'job_fence', :'org', 'SWF-ZZTEST01', 'fencing', 'in_progress'),
  (:'job_patio', :'org', 'SWP-ZZTEST01', 'patio', 'in_progress'),
  (:'job_deck',  :'org', 'SWD-ZZTEST01', 'decking', 'in_progress');

-- Source A: supplier bills (ACCPAY)
INSERT INTO public.xero_invoices (
  org_id, xero_invoice_id, invoice_number, invoice_type, status, invoice_date, job_id, line_items, raw_json
)
VALUES
  -- 500.00 bill line on patio job tagged SW - FENCING in Xero
  (:'org', 'ZZTEST-BILL-WRONG-TAG', 'BILL-001', 'ACCPAY', 'AUTHORISED', DATE '2026-10-05', NULL,
   '[{"LineItemID":"L-WRONG","AccountCode":"306","LineAmount":500.00,"TaxAmount":50.00,"Tracking":[{"Name":"Region","Option":"Metro"},{"Name":"Business Unit","Option":"SW - FENCING"}]}]'::jsonb,
   '{"LineAmountTypes":"Exclusive"}'::jsonb),
  -- Inclusive 110.00 line with 10.00 tax (no LineItemID -> n:1) and no cost line
  (:'org', 'ZZTEST-BILL-INCLUSIVE', 'BILL-002', 'ACCPAY', 'PAID', DATE '2026-10-12', NULL,
   '[{"AccountCode":"400","LineAmount":110.00,"TaxAmount":10.00,"Tracking":[]}]'::jsonb,
   '{"LineAmountTypes":"Inclusive"}'::jsonb),
  -- Bill line split 300.00 fence and 200.00 patio
  (:'org', 'ZZTEST-BILL-SPLIT', 'BILL-003', 'ACCPAY', 'AUTHORISED', DATE '2026-10-15', NULL,
   '[{"LineItemID":"L-SPLIT","AccountCode":"306","LineAmount":500.00,"Tracking":[{"Name":"Business Unit","Option":"SW - FENCING"}]}]'::jsonb,
   '{"LineAmountTypes":"Exclusive"}'::jsonb),
  -- Bill line filed to fencing stock, overhead, and needs_person
  (:'org', 'ZZTEST-BILL-TARGETS', 'BILL-004', 'ACCPAY', 'PAID', DATE '2026-10-20', NULL,
   '[{"LineItemID":"L-STOCK","AccountCode":"306","LineAmount":250.00,"Tracking":[]},{"LineItemID":"L-OVH","AccountCode":"429","LineAmount":80.00,"Tracking":[{"Name":"Business Unit","Option":"SW - PATIOS"}]},{"LineItemID":"L-NEEDS","AccountCode":"306","LineAmount":90.00,"Tracking":[]}]'::jsonb,
   '{"LineAmountTypes":"Exclusive"}'::jsonb),
  -- Excluded bills: DRAFT, VOIDED, DELETED, outside month, other org
  (:'org', 'ZZTEST-BILL-DRAFT', 'BILL-DRAFT', 'ACCPAY', 'DRAFT', DATE '2026-10-10', NULL,
   '[{"LineItemID":"L-D","AccountCode":"306","LineAmount":999.00}]'::jsonb, '{}'::jsonb),
  (:'org', 'ZZTEST-BILL-VOID', 'BILL-VOID', 'ACCPAY', 'VOIDED', DATE '2026-10-10', NULL,
   '[{"LineItemID":"L-V","AccountCode":"306","LineAmount":999.00}]'::jsonb, '{}'::jsonb),
  (:'org', 'ZZTEST-BILL-DELETED', 'BILL-DEL', 'ACCPAY', 'DELETED', DATE '2026-10-10', NULL,
   '[{"LineItemID":"L-X","AccountCode":"306","LineAmount":999.00}]'::jsonb, '{}'::jsonb),
  (:'org', 'ZZTEST-BILL-PREV-MONTH', 'BILL-SEP', 'ACCPAY', 'AUTHORISED', DATE '2026-09-30', NULL,
   '[{"LineItemID":"L-SEP","AccountCode":"306","LineAmount":999.00}]'::jsonb, '{}'::jsonb),
  (:'org', 'ZZTEST-BILL-NEXT-MONTH', 'BILL-NOV', 'ACCPAY', 'PAID', DATE '2026-11-01', NULL,
   '[{"LineItemID":"L-NOV","AccountCode":"306","LineAmount":999.00}]'::jsonb, '{}'::jsonb),
  (:'other_org', 'ZZTEST-BILL-OTHER-ORG', 'BILL-OTH', 'ACCPAY', 'PAID', DATE '2026-10-10', NULL,
   '[{"LineItemID":"L-OTH","AccountCode":"306","LineAmount":999.00}]'::jsonb, '{}'::jsonb);

-- Source B: customer invoices (ACCREC)
INSERT INTO public.xero_invoices (
  org_id, xero_invoice_id, invoice_number, invoice_type, status, invoice_date, job_id, line_items, raw_json
)
VALUES
  -- Customer invoice on fence job, untagged in Xero
  (:'org', 'ZZTEST-INV-JOB', 'INV-001', 'ACCREC', 'AUTHORISED', DATE '2026-10-01', :'job_fence',
   '[{"LineItemID":"L-INV-JOB","AccountCode":"200","LineAmount":1000.00,"Tracking":[]}]'::jsonb,
   '{"LineAmountTypes":"Exclusive"}'::jsonb),
  -- Customer invoice on no job, tagged SW - PATIOS in Xero, plus untagged second line
  (:'org', 'ZZTEST-INV-NOJOB', 'INV-002', 'ACCREC', 'PAID', DATE '2026-10-31', NULL,
   '[{"LineItemID":"L-INV-TAG","AccountCode":"200","LineAmount":400.00,"Tracking":[{"Name":"Business Unit","Option":"SW - PATIOS"}]},{"AccountCode":"200","LineAmount":150.00,"Tracking":[]}]'::jsonb,
   '{"LineAmountTypes":"Exclusive"}'::jsonb),
  -- Excluded customer invoice: DRAFT
  (:'org', 'ZZTEST-INV-DRAFT', 'INV-DRAFT', 'ACCREC', 'DRAFT', DATE '2026-10-15', :'job_patio',
   '[{"LineItemID":"L-INV-D","AccountCode":"200","LineAmount":700.00}]'::jsonb, '{}'::jsonb);

-- Source C: supplier credit notes (ACCPAYCREDIT)
INSERT INTO public.xero_supplier_credit_notes (
  org_id, xero_credit_note_id, credit_note_type, credit_note_number, credit_note_date,
  status, line_amount_types, sub_total, total_tax, total, remaining_credit, allocations_returned, raw_json
)
VALUES
  -- 100.00 credit split 60.00 fence and 40.00 patio via alloc:1
  (:'org', 'ZZTEST-CN-SPLIT', 'ACCPAYCREDIT', 'CN-001', DATE '2026-10-18',
   'AUTHORISED', 'Exclusive', 100.00, 10.00, 110.00, 0.00, true,
   '{"LineAmountTypes":"Exclusive","LineItems":[{"LineItemID":"L-CN-SPLIT","AccountCode":"306","LineAmount":100.00,"Tracking":[{"Name":"Business Unit","Option":"SW - FENCING"}]}]}'::jsonb),
  -- Unmatched Inclusive 110.00 credit (10.00 tax) -> -100.00 on Unassigned
  (:'org', 'ZZTEST-CN-UNMATCHED', 'ACCPAYCREDIT', 'CN-002', DATE '2026-10-22',
   'PAID', 'Inclusive', 100.00, 10.00, 110.00, 110.00, true,
   '{"LineAmountTypes":"Inclusive","LineItems":[{"AccountCode":"306","LineAmount":110.00,"TaxAmount":10.00,"Tracking":[]}]}'::jsonb),
  -- Remainder test: 10.00 credit across 3 divisions with shares 4/6, 1/6, 1/6 -> -6.66, -1.67, -1.67
  (:'org', 'ZZTEST-CN-REMAINDER', 'ACCPAYCREDIT', 'CN-003', DATE '2026-10-25',
   'AUTHORISED', 'Exclusive', 10.00, 1.00, 11.00, 0.00, true,
   '{"LineAmountTypes":"Exclusive","LineItems":[{"LineItemID":"L-CN-REM","AccountCode":"306","LineAmount":10.00,"Tracking":[]}]}'::jsonb),
  -- Excluded credit notes: DRAFT and outside month
  (:'org', 'ZZTEST-CN-DRAFT', 'ACCPAYCREDIT', 'CN-DRAFT', DATE '2026-10-25',
   'DRAFT', 'Exclusive', 50.00, 5.00, 55.00, 55.00, true,
   '{"LineItems":[{"LineItemID":"L-CND","AccountCode":"306","LineAmount":50.00}]}'::jsonb),
  (:'org', 'ZZTEST-CN-NOV', 'ACCPAYCREDIT', 'CN-NOV', DATE '2026-11-01',
   'PAID', 'Exclusive', 50.00, 5.00, 55.00, 0.00, true,
   '{"LineItems":[{"LineItemID":"L-CNN","AccountCode":"306","LineAmount":50.00}]}'::jsonb);

-- Phase 2 cost lines and conserved parts
\set cl_wrong '40510000-0000-4000-8000-000000000001'
\set cl_split '40510000-0000-4000-8000-000000000002'
\set cl_stock '40510000-0000-4000-8000-000000000003'
\set cl_ovh   '40510000-0000-4000-8000-000000000004'
\set cl_needs '40510000-0000-4000-8000-000000000005'
\set cl_cn1   '40510000-0000-4000-8000-000000000006'
\set cl_cnr1  '40510000-0000-4000-8000-000000000007'
\set cl_cnr2  '40510000-0000-4000-8000-000000000008'

INSERT INTO public.job_cost_lines (
  id, org_id, kind, document_kind, document_id, line_key, lane, amount_ex, state, needs_reason, source_hash
)
VALUES
  (:'cl_wrong', :'org', 'supplier_bill', 'xero_bill', 'ZZTEST-BILL-WRONG-TAG', 'L-WRONG', 'materials', 500.00, 'on_job', NULL, 'h1'),
  (:'cl_split', :'org', 'supplier_bill', 'xero_bill', 'ZZTEST-BILL-SPLIT', 'L-SPLIT', 'materials', 500.00, 'split', NULL, 'h2'),
  (:'cl_stock', :'org', 'supplier_bill', 'xero_bill', 'ZZTEST-BILL-TARGETS', 'L-STOCK', 'materials', 250.00, 'division_stock', NULL, 'h3'),
  (:'cl_ovh',   :'org', 'supplier_bill', 'xero_bill', 'ZZTEST-BILL-TARGETS', 'L-OVH', 'other', 80.00, 'overhead', NULL, 'h4'),
  (:'cl_needs', :'org', 'supplier_bill', 'xero_bill', 'ZZTEST-BILL-TARGETS', 'L-NEEDS', 'materials', 90.00, 'needs_person', 'new', 'h5'),
  (:'cl_cn1',   :'org', 'supplier_credit', 'xero_credit_note', 'ZZTEST-CN-SPLIT', 'alloc:1', 'materials', -100.00, 'split', NULL, 'h6'),
  (:'cl_cnr1',  :'org', 'supplier_credit', 'xero_credit_note', 'ZZTEST-CN-REMAINDER', 'alloc:1', 'materials', -4.00, 'on_job', NULL, 'h7'),
  (:'cl_cnr2',  :'org', 'supplier_credit', 'xero_credit_note', 'ZZTEST-CN-REMAINDER', 'alloc:2', 'materials', -2.00, 'split', NULL, 'h8');

INSERT INTO public.job_cost_line_parts (line_id, part_no, target, job_id, division, lane, amount_ex)
VALUES
  (:'cl_wrong', 1, 'job', :'job_patio', NULL, 'materials', 500.00),
  (:'cl_split', 1, 'job', :'job_fence', NULL, 'materials', 300.00),
  (:'cl_split', 2, 'job', :'job_patio', NULL, 'materials', 200.00),
  (:'cl_stock', 1, 'division_stock', NULL, 'fencing', 'materials', 250.00),
  (:'cl_ovh',   1, 'overhead', NULL, NULL, 'other', 80.00),
  (:'cl_cn1',   1, 'job', :'job_fence', NULL, 'materials', -60.00),
  (:'cl_cn1',   2, 'job', :'job_patio', NULL, 'materials', -40.00),
  (:'cl_cnr1',  1, 'job', :'job_fence', NULL, 'materials', -4.00),
  (:'cl_cnr2',  1, 'job', :'job_deck',  NULL, 'materials', -1.00),
  (:'cl_cnr2',  2, 'job', :'job_patio', NULL, 'materials', -1.00);

-- Validate all deferred phase-2 conservation triggers right now.
SET CONSTRAINTS ALL IMMEDIATE;

SET LOCAL ROLE service_role;
CREATE TEMP TABLE result AS
SELECT * FROM public.division_tieout_our_lines(:'org', DATE '2026-10-01');
RESET ROLE;

SELECT pg_temp.prove('500.00 bill on patio job tagged SW - FENCING returns both options and on_job true',
  EXISTS (
    SELECT 1 FROM result
    WHERE document_type = 'ACCPAY'
      AND document_id = 'ZZTEST-BILL-WRONG-TAG'
      AND document_number = 'BILL-001'
      AND line_id = 'L-WRONG'
      AND account_code = '306'
      AND xero_option = 'SW - FENCING'
      AND our_option = 'SW - PATIOS'
      AND amount_ex = 500.00
      AND on_job = true
  )
);

SELECT pg_temp.prove('inclusive 110.00 line with 10.00 tax returns 100.00, position line_id and empty xero_option',
  EXISTS (
    SELECT 1 FROM result
    WHERE document_type = 'ACCPAY'
      AND document_id = 'ZZTEST-BILL-INCLUSIVE'
      AND line_id = 'n:1'
      AND account_code = '400'
      AND xero_option = ''
      AND our_option = 'Unassigned'
      AND amount_ex = 100.00
      AND on_job = false
  )
);

SELECT pg_temp.prove('split bill line 300.00 fence and 200.00 patio returns two rows',
  (
    SELECT array_agg(our_option || ':' || amount_ex::text || ':' || on_job::text ORDER BY amount_ex DESC)
    FROM result
    WHERE document_id = 'ZZTEST-BILL-SPLIT' AND line_id = 'L-SPLIT'
  ) = ARRAY['SW - FENCING:300.00:true', 'SW - PATIOS:200.00:true']
);

SELECT pg_temp.prove('fencing stock returns SW - FENCING with on_job true',
  EXISTS (
    SELECT 1 FROM result
    WHERE document_id = 'ZZTEST-BILL-TARGETS'
      AND line_id = 'L-STOCK'
      AND xero_option = ''
      AND our_option = 'SW - FENCING'
      AND amount_ex = 250.00
      AND on_job = true
  )
);

SELECT pg_temp.prove('overhead and needs_person bill lines use xero_option or Unassigned with on_job false',
  EXISTS (
    SELECT 1 FROM result
    WHERE document_id = 'ZZTEST-BILL-TARGETS'
      AND line_id = 'L-OVH'
      AND xero_option = 'SW - PATIOS'
      AND our_option = 'SW - PATIOS'
      AND amount_ex = 80.00
      AND on_job = false
  )
  AND EXISTS (
    SELECT 1 FROM result
    WHERE document_id = 'ZZTEST-BILL-TARGETS'
      AND line_id = 'L-NEEDS'
      AND xero_option = ''
      AND our_option = 'Unassigned'
      AND amount_ex = 90.00
      AND on_job = false
  )
);

SELECT pg_temp.prove('customer invoice lines resolve job division, else xero_option, else Unassigned',
  EXISTS (
    SELECT 1 FROM result
    WHERE document_type = 'ACCREC'
      AND document_id = 'ZZTEST-INV-JOB'
      AND line_id = 'L-INV-JOB'
      AND xero_option = ''
      AND our_option = 'SW - FENCING'
      AND amount_ex = 1000.00
      AND on_job = true
  )
  AND EXISTS (
    SELECT 1 FROM result
    WHERE document_type = 'ACCREC'
      AND document_id = 'ZZTEST-INV-NOJOB'
      AND line_id = 'L-INV-TAG'
      AND xero_option = 'SW - PATIOS'
      AND our_option = 'SW - PATIOS'
      AND amount_ex = 400.00
      AND on_job = false
  )
  AND EXISTS (
    SELECT 1 FROM result
    WHERE document_type = 'ACCREC'
      AND document_id = 'ZZTEST-INV-NOJOB'
      AND line_id = 'n:2'
      AND xero_option = ''
      AND our_option = 'Unassigned'
      AND amount_ex = 150.00
      AND on_job = false
  )
);

SELECT pg_temp.prove('100.00 credit split 60.00 fence and 40.00 patio returns -60.00 and -40.00',
  (
    SELECT array_agg(our_option || ':' || amount_ex::text || ':' || on_job::text ORDER BY amount_ex ASC)
    FROM result
    WHERE document_type = 'ACCPAYCREDIT' AND document_id = 'ZZTEST-CN-SPLIT' AND line_id = 'L-CN-SPLIT'
  ) = ARRAY['SW - FENCING:-60.00:true', 'SW - PATIOS:-40.00:true']
);

SELECT pg_temp.prove('unmatched inclusive credit returns negative ex-GST amount on Unassigned',
  EXISTS (
    SELECT 1 FROM result
    WHERE document_type = 'ACCPAYCREDIT'
      AND document_id = 'ZZTEST-CN-UNMATCHED'
      AND line_id = 'n:1'
      AND xero_option = ''
      AND our_option = 'Unassigned'
      AND amount_ex = -100.00
      AND on_job = false
  )
);

SELECT pg_temp.prove('credit share rounding gives remainder to largest share and conserves exact total',
  (
    SELECT array_agg(our_option || ':' || amount_ex::text ORDER BY amount_ex ASC, our_option COLLATE "C" ASC)
    FROM result
    WHERE document_id = 'ZZTEST-CN-REMAINDER' AND line_id = 'L-CN-REM'
  ) = ARRAY['SW - FENCING:-6.66', 'SW - DECKING:-1.67', 'SW - PATIOS:-1.67']
  AND (
    SELECT sum(amount_ex) FROM result WHERE document_id = 'ZZTEST-CN-REMAINDER'
  ) = -10.00
);

SELECT pg_temp.prove('draft, voided, deleted, other-month and other-org documents return nothing',
  NOT EXISTS (
    SELECT 1 FROM result
    WHERE document_id IN (
      'ZZTEST-BILL-DRAFT', 'ZZTEST-BILL-VOID', 'ZZTEST-BILL-DELETED',
      'ZZTEST-BILL-PREV-MONTH', 'ZZTEST-BILL-NEXT-MONTH', 'ZZTEST-BILL-OTHER-ORG',
      'ZZTEST-INV-DRAFT', 'ZZTEST-CN-DRAFT', 'ZZTEST-CN-NOV'
    )
  )
  AND (SELECT count(*) FROM result) = 16
);

-- 3. Bad paths, office edits, and retry after refusal (Merge Safety 14 & Rule 21c/d).
SET LOCAL ROLE service_role;
DO $$
BEGIN
  PERFORM * FROM public.division_tieout_our_lines(NULL, DATE '2026-10-01');
  RAISE EXCEPTION 'null_org_accepted';
EXCEPTION WHEN invalid_parameter_value THEN
  PERFORM pg_temp.prove('null org refused rather than returning empty', SQLERRM = 'division_tieout_org_required');
END $$;

DO $$
BEGIN
  PERFORM * FROM public.division_tieout_our_lines('00000000-0000-4000-8000-000000000405', NULL);
  RAISE EXCEPTION 'null_month_accepted';
EXCEPTION WHEN invalid_parameter_value THEN
  PERFORM pg_temp.prove('null month refused rather than returning empty', SQLERRM = 'division_tieout_month_required');
END $$;
RESET ROLE;

-- Missing LineAmount on a coded line refuses with ids only (never amounts or customer text) and retry after fix succeeds.
SAVEPOINT before_bad_line;
INSERT INTO public.xero_invoices (
  org_id, xero_invoice_id, invoice_number, invoice_type, status, invoice_date, line_items, raw_json
)
VALUES (
  :'org', 'ZZTEST-BILL-BAD-AMT', 'BILL-BAD', 'ACCPAY', 'AUTHORISED', DATE '2026-10-28',
  '[{"LineItemID":"L-BAD","AccountCode":"306","Description":"Customer private words","LineAmount":null}]'::jsonb,
  '{}'::jsonb
);
SET LOCAL ROLE service_role;
DO $$
DECLARE
  err_detail text;
BEGIN
  PERFORM * FROM public.division_tieout_our_lines('00000000-0000-4000-8000-000000000405', DATE '2026-10-01');
  RAISE EXCEPTION 'missing_line_amount_accepted';
EXCEPTION WHEN invalid_parameter_value THEN
  GET STACKED DIAGNOSTICS err_detail = PG_EXCEPTION_DETAIL;
  PERFORM pg_temp.prove('missing line amount refuses with code and ids only',
    SQLERRM = 'division_tieout_line_amount_missing'
    AND err_detail = 'ACCPAY:ZZTEST-BILL-BAD-AMT:L-BAD'
    AND position('Customer' IN err_detail) = 0
  );
END $$;
RESET ROLE;

-- Office fixes the record in Xero copy and places the customer invoice on a job; retry succeeds with updated division.
UPDATE public.xero_invoices
SET line_items = '[{"LineItemID":"L-BAD","AccountCode":"306","LineAmount":75.00,"Tracking":[{"Name":"Business Unit","Option":"SW - FENCING"}]}]'::jsonb
WHERE org_id = :'org' AND xero_invoice_id = 'ZZTEST-BILL-BAD-AMT';

UPDATE public.xero_invoices
SET job_id = :'job_patio'
WHERE org_id = :'org' AND xero_invoice_id = 'ZZTEST-INV-NOJOB';

SET LOCAL ROLE service_role;
SELECT pg_temp.prove('office change and retry after refusal return updated rows',
  EXISTS (
    SELECT 1 FROM public.division_tieout_our_lines(:'org', DATE '2026-10-01')
    WHERE document_id = 'ZZTEST-BILL-BAD-AMT' AND amount_ex = 75.00 AND our_option = 'SW - FENCING'
  )
  AND (
    SELECT count(*) FROM public.division_tieout_our_lines(:'org', DATE '2026-10-01')
    WHERE document_id = 'ZZTEST-INV-NOJOB' AND our_option = 'SW - PATIOS' AND on_job = true
  ) = 2
);
RESET ROLE;
ROLLBACK TO before_bad_line;

-- Unreadable dependent table raises rather than silently dropping job placements.
SAVEPOINT before_read_fault;
ALTER TABLE public.job_cost_line_parts RENAME COLUMN amount_ex TO zztest_unreadable_amount;
SET LOCAL ROLE service_role;
DO $$
BEGIN
  PERFORM * FROM public.division_tieout_our_lines('00000000-0000-4000-8000-000000000405', DATE '2026-10-01');
  RAISE EXCEPTION 'unreadable_parts_accepted';
EXCEPTION WHEN undefined_column THEN
  NULL;
END $$;
RESET ROLE;
ROLLBACK TO before_read_fault;
SET LOCAL ROLE service_role;
SELECT pg_temp.prove('failed read raises and retry after restore returns exact 16 rows',
  (SELECT count(*) FROM public.division_tieout_our_lines(:'org', DATE '2026-10-01')) = 16
);
RESET ROLE;

-- 4. Rule 16: prove index-bound plans (no Seq Scan, index scan on each table).
SAVEPOINT plan_fixture;
INSERT INTO public.jobs (id, org_id, job_number, type, status)
SELECT ('40520000-0000-4000-8000-' || lpad(to_hex(g), 12, '0'))::uuid,
       :'org', 'SWF-PLAN-' || g, 'fencing', 'in_progress'
FROM generate_series(1, 2000) AS g;

INSERT INTO public.xero_invoices (
  org_id, xero_invoice_id, invoice_number, invoice_type, status, invoice_date, line_items, raw_json
)
SELECT :'org', 'ZZTEST-PLAN-INV-' || g, 'PINV-' || g, 'ACCPAY', 'PAID',
       (DATE '2024-01-01' + ((g % 700) || ' days')::interval)::date,
       '[{"LineItemID":"1","AccountCode":"306","LineAmount":10.00}]'::jsonb, '{}'::jsonb
FROM generate_series(1, 4000) AS g;

INSERT INTO public.job_cost_lines (
  org_id, kind, document_kind, document_id, line_key, lane, amount_ex, state, needs_reason, source_hash
)
SELECT :'org', 'supplier_bill', 'xero_bill', 'ZZTEST-PLAN-INV-' || g, '1',
       'materials', 10.00, 'needs_person', 'new', 'plan'
FROM generate_series(1, 4000) AS g;

INSERT INTO public.xero_supplier_credit_notes (
  org_id, xero_credit_note_id, credit_note_type, credit_note_number, credit_note_date,
  status, sub_total, total, remaining_credit, allocations_returned, raw_json
)
SELECT CASE WHEN g % 20 = 0 THEN :'org'::uuid ELSE :'other_org'::uuid END,
       'ZZTEST-PLAN-CN-' || g, 'ACCPAYCREDIT', 'PCN-' || g, DATE '2025-05-01',
       'PAID', 10.00, 11.00, 0.00, true, '{"LineItems":[]}'::jsonb
FROM generate_series(1, 2000) AS g;

ANALYZE public.xero_invoices, public.xero_supplier_credit_notes, public.job_cost_lines, public.job_cost_line_parts, public.jobs;

DO $plan$
DECLARE
  plan jsonb;
  rel text;
  q text;
BEGIN
  FOR rel, q IN VALUES
    ('xero_invoices', $q$
      SELECT x.xero_invoice_id FROM public.xero_invoices x
      WHERE x.org_id = '00000000-0000-4000-8000-000000000405'::uuid
        AND x.invoice_type IN ('ACCPAY', 'ACCREC')
        AND x.status IN ('AUTHORISED', 'PAID')
        AND x.invoice_date >= DATE '2026-10-01'
        AND x.invoice_date < DATE '2026-11-01'
    $q$),
    ('xero_supplier_credit_notes', $q$
      SELECT n.xero_credit_note_id FROM public.xero_supplier_credit_notes n
      WHERE n.org_id = '00000000-0000-4000-8000-000000000405'::uuid
        AND n.credit_note_type = 'ACCPAYCREDIT'
        AND n.status IN ('AUTHORISED', 'PAID')
        AND n.credit_note_date >= DATE '2026-10-01'
        AND n.credit_note_date < DATE '2026-11-01'
    $q$),
    ('job_cost_lines', $q$
      SELECT jcl.id FROM public.job_cost_lines jcl
      WHERE jcl.org_id = '00000000-0000-4000-8000-000000000405'::uuid
        AND jcl.document_kind = 'xero_bill'
        AND jcl.document_id = 'ZZTEST-BILL-SPLIT'
        AND jcl.line_key = 'L-SPLIT'
    $q$),
    ('job_cost_line_parts', $q$
      SELECT p.amount_ex FROM public.job_cost_line_parts p
      WHERE p.line_id = '40510000-0000-4000-8000-000000000002'::uuid
    $q$),
    ('jobs', $q$
      SELECT j.job_number, j.type FROM public.jobs j
      WHERE j.id = '40500000-0000-4000-8000-000000000001'::uuid
    $q$)
  LOOP
    IF rel = 'job_cost_line_parts' THEN
      -- Few part rows exist in the fixture; discourage seqscan so the planner proves an index serves line_id.
      SET LOCAL enable_seqscan = off;
    END IF;
    EXECUTE 'EXPLAIN (ANALYZE, FORMAT JSON) ' || q INTO plan;
    RESET enable_seqscan;
    IF EXISTS (
      SELECT 1 FROM jsonb_path_query(plan, 'strict $.**') AS node
      WHERE node ->> 'Relation Name' = rel AND node ->> 'Node Type' = 'Seq Scan'
    )
    OR NOT EXISTS (
      SELECT 1 FROM jsonb_path_query(plan, 'strict $.**') AS node
      WHERE node ->> 'Relation Name' = rel
        AND node ->> 'Node Type' IN ('Index Scan', 'Index Only Scan', 'Bitmap Heap Scan')
    ) THEN
      RAISE EXCEPTION 'P3-04.5 % read is not index-bound: %', rel, plan;
    END IF;
  END LOOP;
END $plan$;
SELECT pg_temp.prove('every table read is index-bound with no Seq Scan', true);
ROLLBACK TO plan_fixture;

SELECT count(*) AS checks_passed FROM checks;
ROLLBACK;
\echo PASS P3-04.5 our monthly Xero lines, cost-line splits, credit shares, bad-path refusals and index plans
