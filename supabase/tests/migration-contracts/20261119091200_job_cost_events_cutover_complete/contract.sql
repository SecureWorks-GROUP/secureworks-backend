-- P2-01.8 (F2): the cutover check measures, the completion refuses until it
-- passes, stamps once, and never turns the switch. Everything is rolled back.
-- ZZTEST rows only, in an organisation no other case uses.
BEGIN;
SET LOCAL TimeZone = 'UTC';

-- 1. Who may run what: the check is the service role's, the completion the owner's.
DO $$
BEGIN
  IF NOT has_function_privilege('service_role', 'public.job_cost_events_cutover_check(uuid,date)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.job_cost_events_cutover_check(uuid,date)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.job_cost_events_cutover_check(uuid,date)', 'EXECUTE') THEN
    RAISE EXCEPTION 'F2 cutover: check grants wrong'; END IF;
  IF has_function_privilege('service_role', 'public.job_cost_events_cutover_complete(uuid,date,boolean)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.job_cost_events_cutover_complete(uuid,date,boolean)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.job_cost_events_cutover_complete(uuid,date,boolean)', 'EXECUTE') THEN
    RAISE EXCEPTION 'F2 cutover: complete is not owner only'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = 'public.job_cost_events_cutover_check(uuid,date)'::regprocedure
      AND prosecdef AND provolatile = 's' AND proconfig @> ARRAY['search_path=public, pg_temp'])
     OR NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = 'public.job_cost_events_cutover_complete(uuid,date,boolean)'::regprocedure
      AND prosecdef AND proconfig @> ARRAY['search_path=public, pg_temp']) THEN
    RAISE EXCEPTION 'F2 cutover: definer or search_path wrong'; END IF;
END $$;

-- Start from an unset marker, the switch off and no trade triggers.
UPDATE public.job_cost_events_cutover SET bills_backfilled_at = NULL, credits_backfilled_at = NULL,
  trade_backfilled_at = NULL, trade_triggers_installed_at = NULL, completed_at = NULL;
UPDATE public.feature_flags SET enabled = false
  WHERE flag_name IN ('job_cost_events_from_cost_lines_v1', 'job_cost_lines_sync_v1', 'job_cost_employer_super_v1');
SELECT public.job_cost_lines_remove_trade_triggers();
INSERT INTO public.organisations (id, name) VALUES
  ('00000000-0000-4000-8000-0000000f2c01', 'ZZTEST F2 org'), ('00000000-0000-4000-8000-0000000f2c02', 'ZZTEST F2 other org')
  ON CONFLICT (id) DO NOTHING;

-- The service role runs the check and is refused the completion.
SET LOCAL ROLE service_role;
DO $$
DECLARE c jsonb;
BEGIN
  c := public.job_cost_events_cutover_check('00000000-0000-4000-8000-0000000f2c01');
  IF (c->>'ready')::boolean IS DISTINCT FROM false OR (c->>'trade_triggers_installed')::boolean IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'F2 cutover: an empty org without triggers read ready: %', c; END IF;
  BEGIN
    PERFORM public.job_cost_events_cutover_complete('00000000-0000-4000-8000-0000000f2c01', DATE '2026-10-01', true);
    RAISE EXCEPTION 'F2 cutover: the service role ran the completion';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $$;
RESET ROLE;

-- 2. Nothing missing but the triggers: the completion refuses and stamps nothing.
DO $$
DECLARE c jsonb := public.job_cost_events_cutover_check('00000000-0000-4000-8000-0000000f2c01');
BEGIN
  IF c->>'bills_missing_cost_lines' <> '0' OR c->>'credits_missing_cost_lines' <> '0'
     OR c->>'trade_invoices_missing_cost_lines' <> '0' OR c->>'mirror_overlap_count' <> '0'
     OR c->'profit_diffs'->>'differing_jobs_count' <> '0' OR (c->>'ready_except_profit_diffs')::boolean THEN
    RAISE EXCEPTION 'F2 cutover: empty org measured wrong: %', c; END IF;
  BEGIN
    PERFORM public.job_cost_events_cutover_complete('00000000-0000-4000-8000-0000000f2c01', DATE '2026-10-01', true);
    RAISE EXCEPTION 'F2 cutover: complete did not refuse without the trade triggers';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'cutover_preconditions_not_met' THEN RAISE; END IF;
  END;
  IF EXISTS (SELECT 1 FROM public.job_cost_events_cutover WHERE completed_at IS NOT NULL
      OR bills_backfilled_at IS NOT NULL OR trade_triggers_installed_at IS NOT NULL) THEN
    RAISE EXCEPTION 'F2 cutover: a refusal stamped the marker'; END IF;
END $$;

-- 3. The triggers, checked by name, table, function and enabled.
SELECT public.job_cost_lines_install_trade_triggers();
DO $$
BEGIN
  IF NOT (public.job_cost_events_cutover_check('00000000-0000-4000-8000-0000000f2c01')->>'ready')::boolean THEN
    RAISE EXCEPTION 'F2 cutover: installed triggers on an empty org did not read ready'; END IF;
END $$;
ALTER TABLE public.trade_invoice_lines DISABLE TRIGGER job_cost_lines_trade_delete;
DO $$
BEGIN
  IF (public.job_cost_events_cutover_check('00000000-0000-4000-8000-0000000f2c01')->>'trade_triggers_installed')::boolean THEN
    RAISE EXCEPTION 'F2 cutover: a disabled trigger read installed'; END IF;
END $$;
ALTER TABLE public.trade_invoice_lines ENABLE TRIGGER job_cost_lines_trade_delete;

-- 4. Supplier bills: owed lines only when live, on or after the cutoff, not a
--    mirror, and with a non-zero line; a stopped bill is reported, not owed.
INSERT INTO public.xero_invoices (org_id, xero_invoice_id, invoice_number, invoice_type, status,
  xero_contact_id, contact_name, sub_total, invoice_date, line_items, raw_json) VALUES
  ('00000000-0000-4000-8000-0000000f2c01', 'ZZTEST-F2-BILL', 'ZZ-F2-1', 'ACCPAY', 'AUTHORISED', 'ZZTEST-sup', 'ZZTEST Supplier',
   100, DATE '2026-10-05', '[{"LineItemID":"zz-f2-1","AccountCode":"300","LineAmount":100,"TaxAmount":10}]', '{}'),
  ('00000000-0000-4000-8000-0000000f2c01', 'ZZTEST-F2-OLD', 'ZZ-F2-2', 'ACCPAY', 'AUTHORISED', 'ZZTEST-sup', 'ZZTEST Supplier',
   100, DATE '2026-09-30', '[{"LineItemID":"zz-f2-2","AccountCode":"300","LineAmount":100,"TaxAmount":10}]', '{}'),
  ('00000000-0000-4000-8000-0000000f2c01', 'ZZTEST-F2-DRAFT', 'ZZ-F2-3', 'ACCPAY', 'DRAFT', 'ZZTEST-sup', 'ZZTEST Supplier',
   100, DATE '2026-10-05', '[{"LineItemID":"zz-f2-3","AccountCode":"300","LineAmount":100,"TaxAmount":10}]', '{}'),
  ('00000000-0000-4000-8000-0000000f2c01', 'ZZTEST-F2-ZERO', 'ZZ-F2-4', 'ACCPAY', 'PAID', 'ZZTEST-sup', 'ZZTEST Supplier',
   0, DATE '2026-10-05', '[{"LineItemID":"zz-f2-4","AccountCode":"300","LineAmount":0,"TaxAmount":0}]', '{}'),
  ('00000000-0000-4000-8000-0000000f2c01', 'ZZTEST-F2-MIRROR', 'ZZ-F2-5', 'ACCPAY', 'AUTHORISED', 'ZZTEST-crew', 'ZZTEST Crew',
   500, DATE '2026-10-06', '[{"LineItemID":"zz-f2-5","AccountCode":"306","LineAmount":500,"TaxAmount":0}]', '{}'),
  ('00000000-0000-4000-8000-0000000f2c01', 'ZZTEST-F2-STOP', 'ZZ-F2-6', 'ACCPAY', 'AUTHORISED', 'ZZTEST-crew', 'ZZTEST Crew',
   300, DATE '2026-10-06', '[{"LineItemID":"zz-f2-6","AccountCode":"306","LineAmount":300,"TaxAmount":0}]', '{}'),
  -- Another organisation's bill is never this one's.
  ('00000000-0000-4000-8000-0000000f2c02', 'ZZTEST-F2-OTHER', 'ZZ-F2-7', 'ACCPAY', 'AUTHORISED', 'ZZTEST-sup', 'ZZTEST Supplier',
   100, DATE '2026-10-05', '[{"LineItemID":"zz-f2-7","AccountCode":"300","LineAmount":100,"TaxAmount":10}]', '{}');
INSERT INTO public.trade_invoices (id, org_id, xero_bill_id, status, subtotal_ex, gst, total_inc, net_pay, super_amount,
  gst_on, super_rate, gross_earned, super_basis) VALUES
  ('00000000-0000-4000-8000-0000000f2ca1', '00000000-0000-4000-8000-0000000f2c01', 'zztest-f2-mirror ', 'draft', 500, 0, 500, 500, 60, false, 0.12, 500, 'employer_12_v2'),
  ('00000000-0000-4000-8000-0000000f2ca2', NULL, 'ZZTEST-F2-STOP', 'draft', 300, 0, 300, 300, 36, false, 0.12, 300, 'employer_12_v2');
DO $$
DECLARE c jsonb := public.job_cost_events_cutover_check('00000000-0000-4000-8000-0000000f2c01');
BEGIN
  IF c->>'bills_missing_cost_lines' <> '1' OR c->>'bills_mirror_stopped' <> '1' OR (c->>'ready')::boolean THEN
    RAISE EXCEPTION 'F2 cutover: bills measured wrong: %', c; END IF;
  IF public.job_cost_events_cutover_check('00000000-0000-4000-8000-0000000f2c01', DATE '2026-09-01')->>'bills_missing_cost_lines' <> '2' THEN
    RAISE EXCEPTION 'F2 cutover: an earlier cutoff did not take the older bill'; END IF;
  BEGIN
    PERFORM public.job_cost_events_cutover_complete('00000000-0000-4000-8000-0000000f2c01', DATE '2026-10-01', true);
    RAISE EXCEPTION 'F2 cutover: complete did not refuse a bill with no cost line';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'cutover_preconditions_not_met' THEN RAISE; END IF;
  END;
END $$;
-- The bills backfill's writer writes it; the bill is no longer owed.
SELECT public.job_cost_lines_upsert_documents(jsonb_build_array(public.job_cost_lines_bill_document(
  '00000000-0000-4000-8000-0000000f2c01', jsonb_build_object('invoice_type', x.invoice_type,
  'xero_invoice_id', x.xero_invoice_id, 'status', x.status, 'invoice_number', x.invoice_number,
  'invoice_date', x.invoice_date, 'xero_contact_id', x.xero_contact_id, 'contact_name', x.contact_name,
  'line_items', x.line_items, 'sub_total', x.sub_total, 'raw_json', '{}'::jsonb), false)))
FROM public.xero_invoices x WHERE x.org_id = '00000000-0000-4000-8000-0000000f2c01' AND x.xero_invoice_id = 'ZZTEST-F2-BILL';
DO $$
BEGIN
  IF public.job_cost_events_cutover_check('00000000-0000-4000-8000-0000000f2c01')->>'bills_missing_cost_lines' <> '0' THEN
    RAISE EXCEPTION 'F2 cutover: a written bill still read missing'; END IF;
END $$;

-- 5. Mirror overlap: a cost line on a mirrored bill counts while a total reads it.
SELECT public.job_cost_lines_upsert_documents(jsonb_build_array(jsonb_build_object(
  'org_id', '00000000-0000-4000-8000-0000000f2c01', 'document_kind', 'xero_bill', 'document_id', 'ZZTEST-F2-MIRROR',
  'document_status', 'AUTHORISED', 'live', true, 'party_kind', 'supplier',
  'lines', jsonb_build_array(jsonb_build_object('line_key', 'zz-f2-5', 'line_no', 1, 'kind', 'installer_bill',
    'lane', 'labour', 'amount_ex', 500, 'is_actual', true)))));
DO $$
DECLARE c jsonb := public.job_cost_events_cutover_check('00000000-0000-4000-8000-0000000f2c01');
BEGIN
  IF c->>'mirror_overlap_count' <> '1' OR c->>'mirror_overlap_all_states' <> '1' THEN
    RAISE EXCEPTION 'F2 cutover: mirror overlap not counted: %', c; END IF;
END $$;
-- Set aside as the trade invoice's duplicate: no total reads it.
UPDATE public.job_cost_lines SET state = NULL, needs_reason = NULL, not_counted_reason = 'duplicate_of_trade_invoice'
WHERE org_id = '00000000-0000-4000-8000-0000000f2c01' AND document_id = 'ZZTEST-F2-MIRROR';
DO $$
DECLARE c jsonb := public.job_cost_events_cutover_check('00000000-0000-4000-8000-0000000f2c01');
BEGIN
  IF c->>'mirror_overlap_count' <> '0' OR c->>'mirror_overlap_all_states' <> '1' THEN
    RAISE EXCEPTION 'F2 cutover: a line set aside still gates: %', c; END IF;
END $$;

-- 6. Supplier credit notes: owed when live, on or after the cutoff, and allocated
--    or holding remaining credit.
INSERT INTO public.xero_supplier_credit_notes (org_id, xero_credit_note_id, credit_note_number, credit_note_date,
  status, sub_total, total, remaining_credit, credit_note_type, allocations_returned, raw_json) VALUES
  ('00000000-0000-4000-8000-0000000f2c01', 'ZZTEST-F2-CN1', 'ZZ-CN1', DATE '2026-10-07', 'AUTHORISED', 10, 11, 0, 'ACCPAYCREDIT', true, '{}'),
  ('00000000-0000-4000-8000-0000000f2c01', 'ZZTEST-F2-CN2', 'ZZ-CN2', DATE '2026-10-07', 'AUTHORISED', 10, 11, 0, 'ACCPAYCREDIT', true, '{}'),
  ('00000000-0000-4000-8000-0000000f2c01', 'ZZTEST-F2-CN3', 'ZZ-CN3', DATE '2026-09-07', 'PAID', 10, 11, 11, 'ACCPAYCREDIT', true, '{}'),
  ('00000000-0000-4000-8000-0000000f2c01', 'ZZTEST-F2-CN4', 'ZZ-CN4', DATE '2026-10-07', 'VOIDED', 10, 11, 11, 'ACCPAYCREDIT', true, '{}');
INSERT INTO public.xero_supplier_credit_note_allocations (org_id, xero_credit_note_id, n, xero_invoice_id, amount, is_deleted, raw_json) VALUES
  ('00000000-0000-4000-8000-0000000f2c01', 'ZZTEST-F2-CN1', 1, 'ZZTEST-F2-BILL', 11, false, '{}'),
  ('00000000-0000-4000-8000-0000000f2c01', 'ZZTEST-F2-CN2', 1, 'ZZTEST-F2-BILL', 11, true, '{}');
DO $$
DECLARE c jsonb := public.job_cost_events_cutover_check('00000000-0000-4000-8000-0000000f2c01');
BEGIN
  IF c->>'credits_missing_cost_lines' <> '1' THEN RAISE EXCEPTION 'F2 cutover: credits measured wrong: %', c; END IF;
END $$;
SELECT public.job_cost_lines_upsert_documents(jsonb_build_array(jsonb_build_object(
  'org_id', '00000000-0000-4000-8000-0000000f2c01', 'document_kind', 'xero_credit_note', 'document_id', 'ZZTEST-F2-CN1',
  'document_status', 'AUTHORISED', 'live', true, 'party_kind', 'supplier',
  'lines', jsonb_build_array(jsonb_build_object('line_key', 'alloc:1', 'line_no', 1, 'kind', 'supplier_credit',
    'lane', 'materials', 'amount_ex', -10, 'follows_document_kind', 'xero_bill', 'follows_document_id', 'ZZTEST-F2-BILL')))));
DO $$
BEGIN
  IF public.job_cost_events_cutover_check('00000000-0000-4000-8000-0000000f2c01')->>'credits_missing_cost_lines' <> '0' THEN
    RAISE EXCEPTION 'F2 cutover: a written credit still read missing'; END IF;
END $$;

-- 7. Trade invoices: owed when live with a real line. The sync switch is off, so
--    the installed triggers write nothing here.
INSERT INTO public.jobs (id, org_id, job_number, type, status, created_at) VALUES
  ('00000000-0000-4000-8000-0000000f2cb1', '00000000-0000-4000-8000-0000000f2c01', 'ZZTEST-F2-JOB', 'fencing', 'accepted',
   '2026-09-01T00:00:00Z');
INSERT INTO public.trade_invoices (id, org_id, status, subtotal_ex, gst, total_inc, net_pay, super_amount, week_start,
  gst_on, super_rate, gross_earned, super_basis) VALUES
  ('00000000-0000-4000-8000-0000000f2ca3', '00000000-0000-4000-8000-0000000f2c01', 'approved', 200, 0, 200, 188, 24, DATE '2026-10-12', false, 0.12, 200, NULL),
  ('00000000-0000-4000-8000-0000000f2ca4', '00000000-0000-4000-8000-0000000f2c01', 'draft', 200, 0, 200, 188, 24, DATE '2026-10-12', false, 0.12, 200, NULL),
  ('00000000-0000-4000-8000-0000000f2ca5', '00000000-0000-4000-8000-0000000f2c01', 'ops-reject', 200, 0, 200, 188, 24, DATE '2026-10-12', false, 0.12, 200, NULL),
  ('00000000-0000-4000-8000-0000000f2ca6', '00000000-0000-4000-8000-0000000f2c01', 'approved', 0, 0, 0, 0, 0, DATE '2026-10-12', false, 0.12, 0, NULL);
INSERT INTO public.trade_invoice_lines (id, trade_invoice_id, job_id, line_type, description, line_total_ex, total_hours) VALUES
  ('00000000-0000-4000-8000-0000000f2cc3', '00000000-0000-4000-8000-0000000f2ca3', '00000000-0000-4000-8000-0000000f2cb1', 'labour', 'Work', 200, 4),
  ('00000000-0000-4000-8000-0000000f2cc4', '00000000-0000-4000-8000-0000000f2ca4', '00000000-0000-4000-8000-0000000f2cb1', 'labour', 'Work', 200, 4),
  ('00000000-0000-4000-8000-0000000f2cc5', '00000000-0000-4000-8000-0000000f2ca5', '00000000-0000-4000-8000-0000000f2cb1', 'labour', 'Work', 200, 4);
DO $$
DECLARE c jsonb := public.job_cost_events_cutover_check('00000000-0000-4000-8000-0000000f2c01');
BEGIN
  IF c->>'trade_invoices_missing_cost_lines' <> '1' THEN
    RAISE EXCEPTION 'F2 cutover: trade invoices measured wrong: %', c; END IF;
END $$;
SELECT public.job_cost_lines_upsert_documents(jsonb_build_array(jsonb_build_object(
  'org_id', '00000000-0000-4000-8000-0000000f2c01', 'document_kind', 'trade_invoice',
  'document_id', '00000000-0000-4000-8000-0000000f2ca3', 'document_date', '2026-10-12', 'document_status', 'approved',
  'live', true, 'party_kind', 'trade',
  'lines', jsonb_build_array(jsonb_build_object('line_key', '00000000-0000-4000-8000-0000000f2cc3', 'line_no', 1,
    'kind', 'trade_line', 'lane', 'labour', 'amount_ex', 200, 'is_actual', true)))));
-- As the trade sync places it: on the job, so both readers hold the same cost.
SELECT public.job_cost_lines_set_state(l.id, 'on_job', jsonb_build_array(jsonb_build_object('target', 'job',
  'job_id', '00000000-0000-4000-8000-0000000f2cb1', 'amount_ex', 200)), 'source', NULL, NULL)
FROM public.job_cost_lines l WHERE l.org_id = '00000000-0000-4000-8000-0000000f2c01'
  AND l.document_id = '00000000-0000-4000-8000-0000000f2ca3';

-- 8. Job Profit differences: a counted cost line the legacy view does not hold,
--    dated before the cutoff, moves the job over every date but not since.
DO $$
DECLARE c jsonb := public.job_cost_events_cutover_check('00000000-0000-4000-8000-0000000f2c01');
BEGIN
  IF NOT (c->>'ready')::boolean THEN RAISE EXCEPTION 'F2 cutover: a clean org did not read ready: %', c; END IF;
END $$;
SELECT public.job_cost_lines_upsert_documents(jsonb_build_array(jsonb_build_object(
  'org_id', '00000000-0000-4000-8000-0000000f2c01', 'document_kind', 'xero_bill', 'document_id', 'ZZTEST-F2-NOSRC',
  'document_date', '2026-09-15', 'document_status', 'PAID', 'live', true, 'party_kind', 'supplier',
  'lines', jsonb_build_array(jsonb_build_object('line_key', 'zz-f2-ns', 'line_no', 1, 'kind', 'supplier_bill',
    'lane', 'materials', 'amount_ex', 75.5, 'is_actual', true)))));
SELECT public.job_cost_lines_set_state(l.id, 'on_job', jsonb_build_array(jsonb_build_object('target', 'job',
  'job_id', '00000000-0000-4000-8000-0000000f2cb1', 'amount_ex', 75.5)), 'source', NULL, NULL)
FROM public.job_cost_lines l WHERE l.org_id = '00000000-0000-4000-8000-0000000f2c01' AND l.document_id = 'ZZTEST-F2-NOSRC';
DO $$
DECLARE c jsonb := public.job_cost_events_cutover_check('00000000-0000-4000-8000-0000000f2c01'); d jsonb;
BEGIN
  d := c->'profit_diffs';
  IF d->>'differing_jobs_count' <> '1' OR d->>'differing_jobs_count_since_cutoff' <> '0'
     OR d->'jobs'->0->>'job_id' <> '00000000-0000-4000-8000-0000000f2cb1'
     OR (d->'jobs'->0->>'lines_total_ex')::numeric - (d->'jobs'->0->>'legacy_total_ex')::numeric <> 75.5
     OR (d->'jobs'->0->>'lines_lines')::int - (d->'jobs'->0->>'legacy_lines')::int <> 1
     OR (c->>'ready')::boolean OR NOT (c->>'ready_except_profit_diffs')::boolean THEN
    RAISE EXCEPTION 'F2 cutover: profit differences measured wrong: %', c; END IF;
  BEGIN
    PERFORM public.job_cost_events_cutover_complete('00000000-0000-4000-8000-0000000f2c01');
    RAISE EXCEPTION 'F2 cutover: complete did not refuse a profit difference';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'cutover_preconditions_not_met' THEN RAISE; END IF;
  END;
  IF EXISTS (SELECT 1 FROM public.job_cost_events_cutover WHERE completed_at IS NOT NULL) THEN
    RAISE EXCEPTION 'F2 cutover: a refusal stamped the marker'; END IF;
END $$;

-- 9. Allowed by the owner: every stamp written once, the switch still off, and
--    Job Profit still reads the legacy view.
DO $$
DECLARE r jsonb; m public.job_cost_events_cutover%ROWTYPE; again jsonb;
BEGIN
  r := public.job_cost_events_cutover_complete('00000000-0000-4000-8000-0000000f2c01', DATE '2026-10-01', true);
  SELECT * INTO m FROM public.job_cost_events_cutover WHERE singleton;
  IF NOT (r->>'completed')::boolean OR (r->>'switch_on')::boolean OR NOT (r->>'allowed_profit_diff')::boolean
     OR m.bills_backfilled_at IS NULL OR m.credits_backfilled_at IS NULL OR m.trade_backfilled_at IS NULL
     OR m.trade_triggers_installed_at IS NULL OR m.completed_at IS NULL THEN
    RAISE EXCEPTION 'F2 cutover: completion did not stamp: % %', r, to_jsonb(m); END IF;
  IF EXISTS (SELECT 1 FROM public.feature_flags WHERE flag_name = 'job_cost_events_from_cost_lines_v1' AND enabled) THEN
    RAISE EXCEPTION 'F2 cutover: completion turned the switch on'; END IF;
  IF EXISTS (SELECT 1 FROM public.v_job_cost_events WHERE job_id = '00000000-0000-4000-8000-0000000f2cb1'
      AND cost_line_id IS NOT NULL) THEN
    RAISE EXCEPTION 'F2 cutover: Job Profit read cost lines with the switch off'; END IF;
  again := public.job_cost_events_cutover_complete('00000000-0000-4000-8000-0000000f2c01', DATE '2026-10-01', true);
  IF again->'marker' IS DISTINCT FROM r->'marker' THEN
    RAISE EXCEPTION 'F2 cutover: a second completion moved a stamp'; END IF;
END $$;

-- 10. Bad arguments refuse before anything is read.
DO $$
BEGIN
  BEGIN
    PERFORM public.job_cost_events_cutover_check(NULL);
    RAISE EXCEPTION 'F2 cutover: a null org was measured';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  BEGIN
    PERFORM public.job_cost_events_cutover_complete('00000000-0000-4000-8000-0000000f2c01', DATE '2026-10-01', NULL);
    RAISE EXCEPTION 'F2 cutover: a null allow flag was taken';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
END $$;

SELECT 'PASS F2 cutover: measured, refused, stamped once, switch untouched';
ROLLBACK;
