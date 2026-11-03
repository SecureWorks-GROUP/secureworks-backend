-- Contract for 20261104063000_job_cost_bill_line_job_number (finish-line row A4, variable V8).
--
-- Synthetic jobs and bills, no customer or staff data. Everything rolls back.
--
--   V8-J1 SWF-38801, V8-J2 SWF-38802, V8-J3 SWF-38803 (Cora Crew has crew-app labour here), V8-L SW3881 (an old
--   job number), V8-H the holding job (do_not_schedule).
--   BILL-I1  installer (306), on the holding job, the shape of Emeka Henry's bill 23:
--            1 'Fence installation SWF-38801' 1,617.00   -> J1
--            2 'Retaining Wall SWF38801'      2,160.00   -> J1
--            3 'Labour Jean SWF 38801'       -1,172.50   -> J1
--            4 'Labour Kim'                    -180.00   stays on H (no job number)
--            5 'Fence SWF-38801 and gate SWF-38802' 300  stays on H (two jobs)
--            6 'Fence SWF-38899'                  50.00  stays on H (no such job)
--            7 'Fence installation SWF-388011'    70.00  stays on H (a longer number is not SWF-38801)
--            8 'Gate SW 3881'                    120.00  -> L
--   BILL-M1  materials (310), on no job: 'Posts for SWF-38802' 400.00 -> J2; 'Freight' 20.00 on no job, not read.
--   BILL-M2  holding job, 'Mesh for SWF-38801' 300.00, Bookkeeping's ledger says overhead: stays on H.
--   BILL-M3  holding job, 'Rails for SWF-38801' 250.00, Bookkeeping's ledger places it on J2: J2 (ledger wins).
--   BILL-M4  no job, 'Sleepers SWF-38801' 90.00, a person marked the bill not job related: on no job.
--   BILL-M5  holding job, 'Week 42 SWF-38803 | SW - Fencing' 500.00: a crew-app mirror bill, never read.
--   BILL-I2  installer, holding job, from 'Cora Crew Pty', 'Install SWF-38803' 600.00: Cora Crew has crew-app
--            labour on J3, so it stays on H (the same work would count twice).
--   BILL-M6  holding job, 'Caps SWF-38802' 80.00 -> J2, with an allocation row on the holding job: that row
--            must not come back on H once the line has moved.
--   BILL-M7  on J1, 'Paint for SWF-38802' 33.00: a bill on a real job keeps its job.
--
-- Switch job_cost_installer_line_job_number_v1 off (as created): BILL-I1 lines 1 to 3 and 8 sit on their jobs as
-- installer bills waiting for a person (JP-12), not actual. On: they count as labour, J1 2,604.50 and L 120.00.

\set ON_ERROR_STOP on

BEGIN;

INSERT INTO public.organisations (id, name) VALUES ('00000000-0000-0000-0000-000000000001', 'Synthetic org')
ON CONFLICT (id) DO NOTHING;
INSERT INTO public.jobs (id, org_id, status, type, job_number, metadata, created_at) VALUES
  ('b8000000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000001', 'complete', 'fencing', 'SWF-38801', '{}', '2026-06-01T00:00:00Z'),
  ('b8000000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000001', 'complete', 'fencing', 'SWF-38802', '{}', '2026-06-01T00:00:00Z'),
  ('b8000000-0000-4000-8000-000000000003', '00000000-0000-0000-0000-000000000001', 'complete', 'fencing', 'SWF-38803', '{}', '2026-06-01T00:00:00Z'),
  ('b8000000-0000-4000-8000-000000000004', '00000000-0000-0000-0000-000000000001', 'complete', 'fencing', 'SW3881', '{}', '2026-01-01T00:00:00Z'),
  ('b8000000-0000-4000-8000-000000000009', '00000000-0000-0000-0000-000000000001', 'archived', 'fencing', 'SWF-PDF-BUCKET-V8',
   '{"do_not_schedule": "true"}', '2026-01-01T00:00:00Z');

-- Cora Crew's crew-app labour on J3 (loaded as a replica write, like 20261030170000's July invoice).
INSERT INTO public.users (id, org_id, name) VALUES
  ('b8200000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000001', 'Cora Crew');
SET LOCAL session_replication_role = replica;
INSERT INTO public.trade_invoices (id, org_id, user_id, week_start, status, subtotal_ex, gst, total_inc, invoice_number) VALUES
  ('b8100000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000001', 'b8200000-0000-4000-8000-000000000001',
   '2026-06-08', 'paid', 600, 0, 600, 'TI-V8-CORA');
INSERT INTO public.trade_invoice_lines (trade_invoice_id, job_id, job_number, line_type, description, total_hours, line_total_ex, line_date) VALUES
  ('b8100000-0000-4000-8000-000000000001', 'b8000000-0000-4000-8000-000000000003', 'SWF-38803', 'labour', 'Install', 10, 600, '2026-06-09');
SET LOCAL session_replication_role = origin;

INSERT INTO public.xero_invoices (org_id, xero_invoice_id, invoice_number, invoice_type, status, contact_name, sub_total, total,
                                  invoice_date, line_items, raw_json, job_id) VALUES
  ('00000000-0000-0000-0000-000000000001', 'b8300000-0000-4000-8000-000000000001', 'BILL-I1', 'ACCPAY', 'PAID', 'Eke Installer', 4564.50, 4564.50,
   '2026-06-12', '[{"LineItemID": "i1-1", "Description": "Fence installation SWF-38801", "AccountCode": "306", "LineAmount": 1617},
                   {"LineItemID": "i1-2", "Description": "Retaining Wall SWF38801", "AccountCode": "306", "LineAmount": 2160},
                   {"LineItemID": "i1-3", "Description": "Labour Jean SWF 38801", "AccountCode": "306", "LineAmount": -1172.5},
                   {"LineItemID": "i1-4", "Description": "Labour Kim", "AccountCode": "306", "LineAmount": -180},
                   {"LineItemID": "i1-5", "Description": "Fence SWF-38801 and gate SWF-38802", "AccountCode": "306", "LineAmount": 300},
                   {"LineItemID": "i1-6", "Description": "Fence SWF-38899", "AccountCode": "306", "LineAmount": 50},
                   {"LineItemID": "i1-7", "Description": "Fence installation SWF-388011", "AccountCode": "306", "LineAmount": 70},
                   {"LineItemID": "i1-8", "Description": "Gate SW 3881", "AccountCode": "306", "LineAmount": 120}]',
   '{"LineAmountTypes": "NoTax", "Total": 2964.50}', 'b8000000-0000-4000-8000-000000000009'),
  ('00000000-0000-0000-0000-000000000001', 'b8300000-0000-4000-8000-000000000002', 'BILL-M1', 'ACCPAY', 'AUTHORISED', 'Posts Supply', 420, 462,
   '2026-06-15', '[{"LineItemID": "m1-1", "Description": "Posts for SWF-38802", "AccountCode": "310", "LineAmount": 400},
                   {"LineItemID": "m1-2", "Description": "Freight", "AccountCode": "310", "LineAmount": 20}]',
   '{"LineAmountTypes": "Exclusive", "Total": 462}', NULL),
  ('00000000-0000-0000-0000-000000000001', 'b8300000-0000-4000-8000-000000000003', 'BILL-M2', 'ACCPAY', 'PAID', 'Posts Supply', 300, 330,
   '2026-07-15', '[{"LineItemID": "m2-1", "Description": "Mesh for SWF-38801", "AccountCode": "310", "LineAmount": 300}]',
   '{"LineAmountTypes": "Exclusive", "Total": 330}', 'b8000000-0000-4000-8000-000000000009'),
  ('00000000-0000-0000-0000-000000000001', 'b8300000-0000-4000-8000-000000000004', 'BILL-M3', 'ACCPAY', 'PAID', 'Posts Supply', 250, 275,
   '2026-07-16', '[{"LineItemID": "m3-1", "Description": "Rails for SWF-38801", "AccountCode": "310", "LineAmount": 250}]',
   '{"LineAmountTypes": "Exclusive", "Total": 275}', 'b8000000-0000-4000-8000-000000000009'),
  ('00000000-0000-0000-0000-000000000001', 'b8300000-0000-4000-8000-000000000005', 'BILL-M4', 'ACCPAY', 'PAID', 'Posts Supply', 90, 99,
   '2026-06-16', '[{"LineItemID": "m4-1", "Description": "Sleepers SWF-38801", "AccountCode": "310", "LineAmount": 90}]',
   '{"LineAmountTypes": "Exclusive", "Total": 99}', NULL),
  ('00000000-0000-0000-0000-000000000001', 'b8300000-0000-4000-8000-000000000006', 'BILL-M5', 'ACCPAY', 'PAID', 'Cora Crew Pty', 500, 500,
   '2026-06-17', '[{"LineItemID": "m5-1", "Description": "Week 42 SWF-38803 | SW - Fencing", "AccountCode": "306", "LineAmount": 500}]',
   '{"LineAmountTypes": "NoTax", "Total": 500}', 'b8000000-0000-4000-8000-000000000009'),
  ('00000000-0000-0000-0000-000000000001', 'b8300000-0000-4000-8000-000000000007', 'BILL-I2', 'ACCPAY', 'PAID', 'Cora Crew Pty', 600, 600,
   '2026-06-18', '[{"LineItemID": "i2-1", "Description": "Install SWF-38803", "AccountCode": "306", "LineAmount": 600}]',
   '{"LineAmountTypes": "NoTax", "Total": 600}', 'b8000000-0000-4000-8000-000000000009'),
  ('00000000-0000-0000-0000-000000000001', 'b8300000-0000-4000-8000-000000000008', 'BILL-M6', 'ACCPAY', 'PAID', 'Posts Supply', 80, 88,
   '2026-06-19', '[{"LineItemID": "m6-1", "Description": "Caps SWF-38802", "AccountCode": "310", "LineAmount": 80}]',
   '{"LineAmountTypes": "Exclusive", "Total": 88}', 'b8000000-0000-4000-8000-000000000009'),
  ('00000000-0000-0000-0000-000000000001', 'b8300000-0000-4000-8000-000000000009', 'BILL-M7', 'ACCPAY', 'PAID', 'Posts Supply', 33, 36.30,
   '2026-06-20', '[{"LineItemID": "m7-1", "Description": "Paint for SWF-38802", "AccountCode": "310", "LineAmount": 33}]',
   '{"LineAmountTypes": "Exclusive", "Total": 36.30}', 'b8000000-0000-4000-8000-000000000001');

INSERT INTO public.v_bookkeeping_line_evidence_current (xero_invoice_id, xero_line_item_id, amount_ex_gst, allocation, job_number, job_id, evidenced, revision) VALUES
  ('b8300000-0000-4000-8000-000000000003', 'm2-1', 300, 'overhead', NULL, NULL, true, 'ledger-cost-v8'),
  ('b8300000-0000-4000-8000-000000000004', 'm3-1', 250, 'job', 'SWF-38802', 'b8000000-0000-4000-8000-000000000002', true, 'ledger-cost-v8');
INSERT INTO public.materials_reconciliation_queue (org_id, xero_invoice_id, invoice_number, status, contact_name) VALUES
  ('00000000-0000-0000-0000-000000000001', 'b8300000-0000-4000-8000-000000000005', 'BILL-M4', 'not_job_related', 'Posts Supply');
INSERT INTO public.job_materials_facts (xero_invoice_id, invoice_number, contact_name, job_id, lane, kind, amount_ex_gst, confidence, automation_source, fact_date, org_id) VALUES
  ('b8300000-0000-4000-8000-000000000008', 'BILL-M6', 'Posts Supply', 'b8000000-0000-4000-8000-000000000009', 'materials', 'actual', 80, 'high', 'agent_prematch', '2026-06-19',
   '00000000-0000-0000-0000-000000000001');

CREATE TEMP TABLE v8_ev ON COMMIT DROP AS
SELECT j.job_number, e.document_number, split_part(e.source_id, ':', 2) AS n, e.source, e.is_actual, e.confidence, e.lane,
       e.amount_ex, e.match_method, e.source_id
FROM public.v_job_cost_events e
LEFT JOIN public.jobs j ON j.id = e.job_id
WHERE e.document_id LIKE 'b8300000-%';

DO $$
DECLARE
  got text;
BEGIN
  -- Switch off (as the migration creates it).
  IF (SELECT enabled FROM public.feature_flags WHERE flag_name = 'job_cost_installer_line_job_number_v1') IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'bill line job number: the installer switch is not created off';
  END IF;
  SELECT string_agg(format('%s/%s/%s/%s/%s/%s', document_number, n, source, is_actual, amount_ex::numeric(12,2), match_method), ' | '
                    ORDER BY document_number, n::int)
    INTO got FROM v8_ev WHERE job_number = 'SWF-38801';
  IF got IS DISTINCT FROM 'BILL-I1/1/installer_bill_unconfirmed/f/1617.00/bill_line_job_number'
       || ' | BILL-I1/2/installer_bill_unconfirmed/f/2160.00/bill_line_job_number'
       || ' | BILL-I1/3/installer_bill_unconfirmed/f/-1172.50/bill_line_job_number'
       || ' | BILL-M7/1/supplier_bill/t/33.00/xero_invoices.job_id' THEN
    RAISE EXCEPTION 'bill line job number: SWF-38801 carries %', got;
  END IF;
  SELECT string_agg(format('%s/%s/%s/%s/%s', document_number, n, source, is_actual, amount_ex::numeric(12,2)), ' | ' ORDER BY document_number, n::int)
    INTO got FROM v8_ev WHERE job_number = 'SW3881';
  IF got IS DISTINCT FROM 'BILL-I1/8/installer_bill_unconfirmed/f/120.00' THEN
    RAISE EXCEPTION 'bill line job number: SW3881 carries %', got;
  END IF;
  SELECT string_agg(format('%s/%s/%s/%s/%s/%s', document_number, n, source, is_actual, amount_ex::numeric(12,2), match_method), ' | '
                    ORDER BY document_number, n::int)
    INTO got FROM v8_ev WHERE job_number = 'SWF-38802';
  IF got IS DISTINCT FROM 'BILL-M1/1/supplier_bill/t/400.00/bill_line_job_number'
       || ' | BILL-M3/1/supplier_bill/t/250.00/bookkeeping_evidence'
       || ' | BILL-M6/1/supplier_bill/t/80.00/bill_line_job_number' THEN
    RAISE EXCEPTION 'bill line job number: SWF-38802 carries %', got;
  END IF;
  IF EXISTS (SELECT 1 FROM v8_ev WHERE job_number = 'SWF-38803') THEN
    RAISE EXCEPTION 'bill line job number: a line reached SWF-38803, where the same person has crew-app labour';
  END IF;
  SELECT string_agg(format('%s/%s/%s', document_number, n, source), ' | ' ORDER BY document_number, n::int)
    INTO got FROM v8_ev WHERE job_number = 'SWF-PDF-BUCKET-V8';
  IF got IS DISTINCT FROM 'BILL-I1/4/installer_bill_unconfirmed | BILL-I1/5/installer_bill_unconfirmed'
       || ' | BILL-I1/6/installer_bill_unconfirmed | BILL-I1/7/installer_bill_unconfirmed'
       || ' | BILL-I2/1/installer_bill_unconfirmed | BILL-M2/1/supplier_bill' THEN
    RAISE EXCEPTION 'bill line job number: the holding job carries %', got;
  END IF;
  IF EXISTS (SELECT 1 FROM v8_ev WHERE document_number IN ('BILL-M4', 'BILL-M5')) THEN
    RAISE EXCEPTION 'bill line job number: a bill a person marked not job related, or a crew-app mirror bill, was read';
  END IF;
  IF EXISTS (SELECT 1 FROM v8_ev WHERE source = 'materials_fact') THEN
    RAISE EXCEPTION 'bill line job number: the allocation row on the holding job came back beside its moved line';
  END IF;
  IF EXISTS (SELECT 1 FROM v8_ev GROUP BY source_id HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'bill line job number: a line counts twice';
  END IF;
  -- The bill outcome (company read) reads a line placed by its job number as a Xero line.
  SELECT string_agg(format('%s/%s/%s', invoice_number, counts, reason), ' | ' ORDER BY invoice_number) INTO got
    FROM public.cfo_bill_cost_outcomes_scoped(NULL) o
   WHERE o.job_id = 'b8000000-0000-4000-8000-000000000002';
  IF got IS DISTINCT FROM 'BILL-M1/counted/engine_reads_xero_lines | BILL-M3/counted/engine_reads_xero_lines | BILL-M6/counted/engine_reads_xero_lines' THEN
    RAISE EXCEPTION 'bill line job number: the bill outcomes on SWF-38802 read %', got;
  END IF;
END $$;

-- Switch on: installer lines that name their job count as confirmed labour there; nothing else moves.
UPDATE public.feature_flags SET enabled = true WHERE flag_name = 'job_cost_installer_line_job_number_v1';
DO $$
DECLARE
  got text;
BEGIN
  SELECT string_agg(format('%s/%s/%s/%s/%s', s.job_number, s.source, s.confidence, s.lane, s.ex), ' | ' ORDER BY s.job_number, s.source)
    INTO got
    FROM (SELECT j.job_number, e.source, e.confidence, e.lane, sum(e.amount_ex)::numeric(12,2) AS ex
            FROM public.v_job_cost_events e JOIN public.jobs j ON j.id = e.job_id
           WHERE e.document_id = 'b8300000-0000-4000-8000-000000000001' AND e.is_actual
           GROUP BY j.job_number, e.source, e.confidence, e.lane) s;
  IF got IS DISTINCT FROM 'SW3881/supplier_bill/high/labour/120.00 | SWF-38801/supplier_bill/high/labour/2604.50' THEN
    RAISE EXCEPTION 'bill line job number (switch on): BILL-I1 counts %', got;
  END IF;
  IF (SELECT count(*) FROM public.v_job_cost_events e JOIN public.jobs j ON j.id = e.job_id
       WHERE j.job_number = 'SWF-PDF-BUCKET-V8' AND e.document_id LIKE 'b8300000-%') <> 6 THEN
    RAISE EXCEPTION 'bill line job number (switch on): the holding job lost or gained a line';
  END IF;
END $$;
UPDATE public.feature_flags SET enabled = false WHERE flag_name = 'job_cost_installer_line_job_number_v1';

-- The text reader alone.
DO $$
BEGIN
  IF public.job_cost_bill_line_job_id('swf38801 retaining wall') IS DISTINCT FROM 'b8000000-0000-4000-8000-000000000001'
     OR public.job_cost_bill_line_job_id('SWF=38801, again SWF-38801') IS DISTINCT FROM 'b8000000-0000-4000-8000-000000000001'
     OR public.job_cost_bill_line_job_id('SWF-38801/SWF-38802') IS NOT NULL
     OR public.job_cost_bill_line_job_id('SWF-PDF-BUCKET-V8') IS NOT NULL
     OR public.job_cost_bill_line_job_id('XSWF-38801') IS NOT NULL
     OR public.job_cost_bill_line_job_id(NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'bill line job number: job_cost_bill_line_job_id reads the wrong job';
  END IF;
  IF has_function_privilege('anon', 'public.job_cost_bill_line_job_id(text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.job_cost_bill_line_job_id(text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'bill line job number: job_cost_bill_line_job_id is open to signed-out or ordinary signed-in callers';
  END IF;
END $$;

-- 20261104070000 to 20261104072000 (A6 cost rules) sit on this migration; the checks above hold with them in. Unwind
-- them inside this transaction (the ROLLBACK at the end puts them back) so the second run meets its own definition.
-- 20261104090000 and 20261104091000 (A3 division) sit on the A6 cost rules: unwind them first.
-- 20261104123000 (C3 one-job speed-up) sits on the A3 division definitions: unwind it first.
SELECT md5(pg_get_viewdef('public.v_job_cost_events'::regclass, true))='b48997c55913ce3c90e3a3c947533fd3' AS test_has_c3_fast \gset
\if :test_has_c3_fast
\ir ../../../rollbacks/20261104123000_job_cost_events_faster_same_rows_down.sql
\endif
SELECT md5(pg_get_viewdef('public.v_job_cost_events'::regclass, true))='abdc05a69d139d79aebbb8a3cebfae03' AS test_has_a3_division \gset
\if :test_has_a3_division
\ir ../../../rollbacks/20261104091000_job_revenue_credit_division_down.sql
\ir ../../../rollbacks/20261104090000_job_cost_crew_and_placement_division_down.sql
\endif
SELECT md5(pg_get_viewdef('public.v_job_cost_events'::regclass, true))='366599ce55b0e0430d45ee9e6e04c315' AS test_has_a6_cost_rules \gset
\if :test_has_a6_cost_rules
\ir ../../../rollbacks/20261104072000_job_cost_credit_at_note_ex_gst_down.sql
\ir ../../../rollbacks/20261104071000_job_cost_xero_crew_bill_super_down.sql
\ir ../../../rollbacks/20261104070000_job_cost_follows_ledger_split_lines_down.sql
\endif
-- A second run changes nothing.
\ir ../../../migrations/20261104063000_job_cost_bill_line_job_number.sql
DO $$
BEGIN
  IF md5(pg_get_viewdef('public.v_job_cost_events'::regclass, true)) <> '33d1c54d5a288fe496b5b863a1ec1d4c'
     OR md5(pg_get_functiondef('public.cfo_bill_cost_outcomes_scoped(uuid)'::regprocedure)) <> '05654c5a54724306a0fcc611c64cf09b'
     OR (SELECT count(*) FROM public.feature_flags WHERE flag_name = 'job_cost_installer_line_job_number_v1') <> 1 THEN
    RAISE EXCEPTION 'bill line job number: a second run changed the view, the bill outcomes or the switch';
  END IF;
END $$;

ROLLBACK;
