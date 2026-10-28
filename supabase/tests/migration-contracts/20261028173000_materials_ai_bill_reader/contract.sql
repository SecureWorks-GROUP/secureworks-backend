-- Contract for 20261028173000_materials_ai_bill_reader.
--
-- Synthetic jobs and bills, no customer data. Everything rolls back.
--
--   AI-J1   patio job, complete, invoiced 7,000 ex.
--   AI-J2   fencing job, accepted.  AI-DEAD cancelled.  AI-HOLD holding job.
--   AI-INST installer bill (301) 600 ex, in Bills to place.
--   AI-MAT  materials bill 2,000 ex, in Bills to place.
--   AI-LOW  materials bill 90 ex: the AI is not sure enough.
--   AI-NJR  office bill 40 ex: not job related.
--   AI-HELD duplicate supplier document: held for a person.
--   AI-MIR  trade app mirror.
--   AI-PER  placed by a person.
--   AI-RULE installer bill a rule placed on AI-J2 (installer_confirm).
--
-- Expected: the batch reads the open, unheld bills biggest first; an installer
-- bill the AI places counts as labour (JP-12 replaced, owner 28 Oct 2026);
-- below the bar a bill is left for a person; a held, mirrored, person-placed
-- or undone bill is refused; Undo takes the AI's row off and the bill is never
-- read again; the second check raises the bar once a day.

\set ON_ERROR_STOP on

BEGIN;

INSERT INTO public.jobs (id, org_id, status, type, job_number, legacy, metadata, pricing_json, expected_costs, created_at, client_name, site_suburb) VALUES
  ('a1000000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000001', 'complete', 'patio', 'AI-J1', false, '{}', '{}', NULL, '2026-07-01T00:00:00Z', 'Test Client One', 'Testville'),
  ('a1000000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000001', 'accepted', 'fencing', 'AI-J2', false, '{}', '{}', NULL, '2026-07-01T00:00:00Z', 'Test Client Two', 'Sampleton'),
  ('a1000000-0000-4000-8000-000000000008', '00000000-0000-0000-0000-000000000001', 'cancelled', 'fencing', 'AI-DEAD', false, '{}', '{}', NULL, '2026-07-01T00:00:00Z', NULL, NULL),
  ('a1000000-0000-4000-8000-000000000009', '00000000-0000-0000-0000-000000000001', 'complete', 'fencing', 'AI-HOLD', false, '{"do_not_schedule": "true"}', '{}', NULL, '2026-07-01T00:00:00Z', NULL, NULL);

INSERT INTO public.xero_invoices (org_id, xero_invoice_id, invoice_number, invoice_type, status, contact_name, sub_total, total, invoice_date, line_items, raw_json, job_id) VALUES
  ('00000000-0000-0000-0000-000000000001', 'S-AI1', 'INV-AI-1', 'ACCREC', 'AUTHORISED', 'AI Customer', 7000, 7700, '2026-08-20',
   '[{"Description": "Patio", "AccountCode": "200", "LineAmount": 7000, "TaxAmount": 700}]', '{"LineAmountTypes": "Exclusive"}', 'a1000000-0000-4000-8000-000000000001'),
  ('00000000-0000-0000-0000-000000000001', 'AI-INST', 'AIB-10001', 'ACCPAY', 'AUTHORISED', 'AI Installer', 600, 660, '2026-08-22',
   '[{"Description": "Patio install Testville", "AccountCode": "301", "LineAmount": 600, "TaxAmount": 60}]', '{"LineAmountTypes": "Exclusive"}', NULL),
  ('00000000-0000-0000-0000-000000000001', 'AI-MAT', 'AIB-10002', 'ACCPAY', 'PAID', 'AI Steel', 2000, 2200, '2026-08-21',
   '[{"Description": "Roof sheets", "AccountCode": "310", "LineAmount": 2000, "TaxAmount": 200}]', '{"LineAmountTypes": "Exclusive"}', NULL),
  ('00000000-0000-0000-0000-000000000001', 'AI-LOW', 'AIB-10003', 'ACCPAY', 'AUTHORISED', 'AI Steel', 90, 99, '2026-08-21',
   '[{"Description": "Screws", "AccountCode": "310", "LineAmount": 90, "TaxAmount": 9}]', '{"LineAmountTypes": "Exclusive"}', NULL),
  ('00000000-0000-0000-0000-000000000001', 'AI-NJR', 'AIB-10004', 'ACCPAY', 'AUTHORISED', 'AI Office', 40, 44, '2026-08-21',
   '[{"Description": "Printer paper", "AccountCode": "400", "LineAmount": 40, "TaxAmount": 4}]', '{"LineAmountTypes": "Exclusive"}', NULL),
  ('00000000-0000-0000-0000-000000000001', 'AI-HELD', 'AIB-10005', 'ACCPAY', 'AUTHORISED', 'AI Steel', 5000, 5500, '2026-08-21',
   '[{"Description": "Posts", "AccountCode": "310", "LineAmount": 5000, "TaxAmount": 500}]', '{"LineAmountTypes": "Exclusive"}', NULL),
  ('00000000-0000-0000-0000-000000000001', 'AI-MIR', 'AIB-10006', 'ACCPAY', 'PAID', 'AI Trade', 300, 300, '2026-08-21',
   '[{"Description": "Week | SW - FENCING", "AccountCode": "306", "LineAmount": 300}]', '{"LineAmountTypes": "Exclusive"}', NULL),
  ('00000000-0000-0000-0000-000000000001', 'AI-PER', 'AIB-10007', 'ACCPAY', 'AUTHORISED', 'AI Steel', 70, 77, '2026-08-21',
   '[{"Description": "Caps", "AccountCode": "310", "LineAmount": 70, "TaxAmount": 7}]', '{"LineAmountTypes": "Exclusive"}', NULL),
  ('00000000-0000-0000-0000-000000000001', 'AI-RULE', 'AIB-10008', 'ACCPAY', 'AUTHORISED', 'AI Installer', 400, 440, '2026-08-23',
   '[{"Description": "Install", "AccountCode": "306", "LineAmount": 400, "TaxAmount": 40}]', '{"LineAmountTypes": "Exclusive"}', NULL);

INSERT INTO public.materials_reconciliation_queue (xero_invoice_id, invoice_number, contact_name, sub_total, total, invoice_date, status, suggestion_reason, suggested_job_id, suggested_job_number) VALUES
  ('AI-INST', 'AIB-10001', 'AI Installer', 600, 660, '2026-08-22', 'open', NULL, NULL, NULL),
  ('AI-MAT', 'AIB-10002', 'AI Steel', 2000, 2200, '2026-08-21', 'open', NULL, NULL, NULL),
  ('AI-LOW', 'AIB-10003', 'AI Steel', 90, 99, '2026-08-21', 'open', NULL, NULL, NULL),
  ('AI-NJR', 'AIB-10004', 'AI Office', 40, 44, '2026-08-21', 'open', NULL, NULL, NULL),
  ('AI-HELD', 'AIB-10005', 'AI Steel', 5000, 5500, '2026-08-21', 'open', 'duplicate_document', NULL, NULL),
  ('AI-MIR', 'AIB-10006', 'AI Trade', 300, 300, '2026-08-21', 'open', NULL, NULL, NULL),
  ('AI-PER', 'AIB-10007', 'AI Steel', 70, 77, '2026-08-21', 'assigned', NULL, NULL, NULL),
  ('AI-RULE', 'AIB-10008', 'AI Installer', 400, 440, '2026-08-23', 'open', 'installer_confirm', 'a1000000-0000-4000-8000-000000000002', 'AI-J2');

INSERT INTO public.job_materials_facts (xero_invoice_id, job_id, job_number, lane, kind, amount_ex_gst, confidence, automation_source, fact_date) VALUES
  ('AI-PER', 'a1000000-0000-4000-8000-000000000002', 'AI-J2', 'materials', 'actual', 70, 'high_manual', 'manual_queue', '2026-08-21'),
  ('AI-RULE', 'a1000000-0000-4000-8000-000000000002', 'AI-J2', 'labour', 'actual', 400, 'high', 'xero_ref_link', '2026-08-23');

DO $$
DECLARE
  v jsonb;
  ids text[];
  c uuid;
  r record;
  n integer;
  pid uuid;
BEGIN
  -- Batch: open, unheld, not mirrored, not a person's, biggest first.
  v := public.materials_ai_bill_batch(20);
  SELECT array_agg(e ->> 'xero_invoice_id' ORDER BY ord) INTO ids
    FROM jsonb_array_elements(v) WITH ORDINALITY t(e, ord)
   WHERE e ->> 'xero_invoice_id' LIKE 'AI-%';
  IF ids IS DISTINCT FROM ARRAY['AI-MAT', 'AI-INST', 'AI-RULE', 'AI-LOW', 'AI-NJR'] THEN
    RAISE EXCEPTION 'batch: %', ids;
  END IF;
  SELECT e INTO v FROM jsonb_array_elements(public.materials_ai_bill_batch(20)) e WHERE e ->> 'xero_invoice_id' = 'AI-RULE';
  IF NOT (v ->> 'installer')::boolean OR v -> 'machine_suggestion' ->> 'job_number' <> 'AI-J2'
     OR jsonb_array_length(v -> 'lines') <> 1 THEN
    RAISE EXCEPTION 'batch evidence: %', v;
  END IF;

  -- Candidate jobs: live and recent, never cancelled or holding.
  v := public.materials_ai_candidate_jobs('2026-08-21', '2026-08-23');
  SELECT array_agg(e ->> 'job_number' ORDER BY e ->> 'job_number') INTO ids
    FROM jsonb_array_elements(v) e WHERE e ->> 'job_number' LIKE 'AI-%';
  IF ids IS DISTINCT FROM ARRAY['AI-J1', 'AI-J2'] THEN RAISE EXCEPTION 'candidates: %', ids; END IF;

  c := public.materials_ai_reserve_call('place', 'test-model', 5);
  IF c IS NULL THEN RAISE EXCEPTION 'reserve: no call'; END IF;
  UPDATE public.materials_ai_settings SET second_check_sample = 0, second_check_over_ex = 1000 WHERE id;

  -- Installer bill placed by the AI: counts as labour.
  v := public.materials_ai_apply(c, 'test-model', '{"xero_invoice_id":"AI-INST","decision":"job","job_number":"AI-J1","confidence":0.95,"reason":"Install at Testville, the job''s suburb.","evidence":["line: Patio install Testville"]}');
  IF v ->> 'outcome' <> 'placed' OR v ->> 'second_check' <> 'due' THEN RAISE EXCEPTION 'apply AI-INST: %', v; END IF;
  -- Materials bill, under the second-check amount on an open job... AI-J1 is complete, so due.
  v := public.materials_ai_apply(c, 'test-model', '{"xero_invoice_id":"AI-MAT","decision":"job","job_id":"a1000000-0000-4000-8000-000000000001","confidence":0.9,"reason":"Roof sheets for the patio."}');
  IF v ->> 'outcome' <> 'placed' THEN RAISE EXCEPTION 'apply AI-MAT: %', v; END IF;
  SELECT * INTO r FROM public.job_materials_facts WHERE xero_invoice_id = 'AI-INST';
  IF r.automation_source <> 'agent_ai' OR r.lane <> 'labour' OR r.amount_ex_gst <> 600 OR r.assigned_by <> 'ai:test-model' THEN
    RAISE EXCEPTION 'AI-INST fact: % % % %', r.automation_source, r.lane, r.amount_ex_gst, r.assigned_by;
  END IF;
  SELECT * INTO r FROM public.v_job_profit WHERE job_number = 'AI-J1';
  IF NOT r.margin_ok OR r.profit_ex <> 4400 OR r.actual_labour_ex <> 600 OR r.actual_materials_ex <> 2000
     OR 'installer_bill_unconfirmed' = ANY (COALESCE(r.completeness, '{}'::text[])) THEN
    RAISE EXCEPTION 'AI-J1 profit: margin_ok %, profit %, labour %, materials %, completeness %',
      r.margin_ok, r.profit_ex, r.actual_labour_ex, r.actual_materials_ex, r.completeness;
  END IF;
  SELECT * INTO r FROM public.v_bill_allocation_balance WHERE xero_invoice_id = 'AI-INST';
  IF NOT r.balanced OR r.installer_unconfirmed THEN
    RAISE EXCEPTION 'AI-INST balance: % %', r.balanced, r.installer_unconfirmed;
  END IF;
  SELECT count(*) INTO n FROM public.job_events
   WHERE job_id = 'a1000000-0000-4000-8000-000000000001' AND event_type = 'materials_bill_assigned' AND detail_json ->> 'source' = 'agent_ai';
  IF n <> 2 THEN RAISE EXCEPTION 'job events: %', n; END IF;

  -- Below the bar: left for a person, still open.
  v := public.materials_ai_apply(c, 'test-model', '{"xero_invoice_id":"AI-LOW","decision":"job","job_number":"AI-J2","confidence":0.6,"reason":"Same supplier as AI-J2 last week, nothing else."}');
  IF v ->> 'outcome' <> 'left_for_person' THEN RAISE EXCEPTION 'apply AI-LOW: %', v; END IF;
  IF (SELECT status FROM public.materials_reconciliation_queue WHERE xero_invoice_id = 'AI-LOW') <> 'open'
     OR EXISTS (SELECT 1 FROM public.job_materials_facts WHERE xero_invoice_id = 'AI-LOW') THEN
    RAISE EXCEPTION 'AI-LOW moved';
  END IF;

  -- Not job related: filed.
  v := public.materials_ai_apply(c, 'test-model', '{"xero_invoice_id":"AI-NJR","decision":"not_job_related","confidence":0.97,"reason":"Office paper."}');
  IF v ->> 'outcome' <> 'filed_not_job_related' THEN RAISE EXCEPTION 'apply AI-NJR: %', v; END IF;

  -- The rule's installer row is replaced by the AI's.
  v := public.materials_ai_apply(c, 'test-model', '{"xero_invoice_id":"AI-RULE","decision":"job","job_number":"AI-J2","confidence":0.92,"reason":"Rule and work order agree."}');
  IF v ->> 'outcome' <> 'placed' THEN RAISE EXCEPTION 'apply AI-RULE: %', v; END IF;
  SELECT count(*) AS n, min(automation_source) AS src INTO r FROM public.job_materials_facts WHERE xero_invoice_id = 'AI-RULE';
  IF r.n <> 1 OR r.src <> 'agent_ai' THEN RAISE EXCEPTION 'AI-RULE facts: % %', r.n, r.src; END IF;

  -- Refusals.
  v := public.materials_ai_apply(c, 'test-model', '{"xero_invoice_id":"AI-HELD","decision":"job","job_number":"AI-J2","confidence":0.99,"reason":"x"}');
  IF v ->> 'outcome' <> 'refused' OR v ->> 'refusal' NOT LIKE 'held for a person%' THEN RAISE EXCEPTION 'AI-HELD: %', v; END IF;
  v := public.materials_ai_apply(c, 'test-model', '{"xero_invoice_id":"AI-MIR","decision":"job","job_number":"AI-J2","confidence":0.99,"reason":"x"}');
  IF v ->> 'outcome' <> 'refused' OR v ->> 'refusal' NOT LIKE 'a trade app invoice%' THEN RAISE EXCEPTION 'AI-MIR: %', v; END IF;
  v := public.materials_ai_apply(c, 'test-model', '{"xero_invoice_id":"AI-PER","decision":"job","job_number":"AI-J1","confidence":0.99,"reason":"x"}');
  IF v ->> 'outcome' <> 'refused' THEN RAISE EXCEPTION 'AI-PER: %', v; END IF;
  v := public.materials_ai_apply(c, 'test-model', '{"xero_invoice_id":"AI-MAT","decision":"job","job_number":"AI-J2","confidence":0.99,"reason":"x"}');
  IF v ->> 'outcome' <> 'refused' THEN RAISE EXCEPTION 'AI-MAT twice: %', v; END IF;
  UPDATE public.materials_reconciliation_queue SET status = 'open' WHERE xero_invoice_id = 'AI-LOW';
  v := public.materials_ai_apply(c, 'test-model', '{"xero_invoice_id":"AI-LOW","decision":"job","job_number":"AI-DEAD","confidence":0.99,"reason":"x"}');
  IF v ->> 'refusal' <> 'job is cancelled' THEN RAISE EXCEPTION 'AI-DEAD: %', v; END IF;
  v := public.materials_ai_apply(c, 'test-model', '{"xero_invoice_id":"AI-LOW","decision":"job","job_number":"AI-HOLD","confidence":0.99,"reason":"x"}');
  IF v ->> 'refusal' <> 'a holding job' THEN RAISE EXCEPTION 'AI-HOLD: %', v; END IF;

  -- Undo: the AI's row comes off, the bill reopens, and the AI never reads it again.
  SELECT id INTO pid FROM public.materials_ai_placements WHERE xero_invoice_id = 'AI-MAT' AND outcome = 'placed';
  v := public.materials_ai_undo(pid, 'person@example.test', 'Wrong job');
  IF NOT (v ->> 'ok')::boolean THEN RAISE EXCEPTION 'undo: %', v; END IF;
  IF EXISTS (SELECT 1 FROM public.job_materials_facts WHERE xero_invoice_id = 'AI-MAT') THEN RAISE EXCEPTION 'undo left the fact'; END IF;
  SELECT * INTO r FROM public.materials_reconciliation_queue WHERE xero_invoice_id = 'AI-MAT';
  IF r.status <> 'open' OR r.suggestion_reason <> 'ai_undone' OR r.assigned_by IS NOT NULL THEN
    RAISE EXCEPTION 'undo queue: % % %', r.status, r.suggestion_reason, r.assigned_by;
  END IF;
  v := public.materials_ai_undo(pid, 'person@example.test', NULL);
  IF NOT (v ->> 'idempotent')::boolean THEN RAISE EXCEPTION 'undo twice: %', v; END IF;
  UPDATE public.materials_reconciliation_queue SET suggestion_reason = NULL WHERE xero_invoice_id = 'AI-MAT'; -- the sync blanks it
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(public.materials_ai_bill_batch(20)) e WHERE e ->> 'xero_invoice_id' = 'AI-MAT') THEN
    RAISE EXCEPTION 'undone bill read again';
  END IF;
  v := public.materials_ai_apply(c, 'test-model', '{"xero_invoice_id":"AI-MAT","decision":"job","job_number":"AI-J1","confidence":0.99,"reason":"x"}');
  IF v ->> 'refusal' <> 'a person undid an AI placement on this bill' THEN RAISE EXCEPTION 'undone re-place: %', v; END IF;
  SELECT * INTO r FROM public.v_job_profit WHERE job_number = 'AI-J1';
  IF r.actual_materials_ex <> 0 THEN RAISE EXCEPTION 'materials after undo: %', r.actual_materials_ex; END IF;

  -- A person changed the bill after the AI: Undo refuses, the person's decision stands.
  UPDATE public.materials_reconciliation_queue SET assigned_by = 'person@example.test' WHERE xero_invoice_id = 'AI-NJR';
  SELECT id INTO pid FROM public.materials_ai_placements WHERE xero_invoice_id = 'AI-NJR' AND outcome = 'filed_not_job_related';
  BEGIN
    PERFORM public.materials_ai_undo(pid, 'person@example.test', NULL);
    RAISE EXCEPTION 'undo over a person did not refuse';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE 'undo_refused: bill % was changed by a person%' THEN RAISE; END IF;
  END;

  -- Second check: due rows listed; agreement recorded.
  v := public.materials_ai_second_check_due(20);
  IF jsonb_array_length(v) <> 1 THEN RAISE EXCEPTION 'second check due: %', v; END IF;
  SELECT id INTO pid FROM public.materials_ai_placements WHERE xero_invoice_id = 'AI-INST' AND outcome = 'placed';
  v := public.materials_ai_record_second_check(pid, '{"decision":"job","job_number":"ai-j1","confidence":0.9,"reason":"agree","model":"claude"}');
  IF NOT (v ->> 'agreed')::boolean THEN RAISE EXCEPTION 'second check agree: %', v; END IF;
  IF (SELECT second_check_status FROM public.materials_ai_placements WHERE id = pid) <> 'agreed' THEN RAISE EXCEPTION 'not agreed'; END IF;

  -- Ten disagreements in a day raise the bar once by 0.03.
  INSERT INTO public.materials_ai_placements (xero_invoice_id, decision, reason, model, outcome, second_check_status)
  SELECT 'AI-SYN-' || g, 'not_job_related', 'synthetic', 'test-model', 'filed_not_job_related', 'due' FROM generate_series(1, 11) g;
  FOR pid IN SELECT id FROM public.materials_ai_placements WHERE xero_invoice_id LIKE 'AI-SYN-%' LOOP
    PERFORM public.materials_ai_record_second_check(pid, '{"decision":"job","job_number":"AI-J2","model":"claude"}');
  END LOOP;
  SELECT * INTO r FROM public.materials_ai_settings WHERE id;
  IF r.confidence_bar <> 0.930 OR jsonb_array_length(r.bar_history) <> 1 THEN
    RAISE EXCEPTION 'bar: % %', r.confidence_bar, r.bar_history;
  END IF;

  v := public.materials_ai_status();
  IF (v ->> 'placed')::int < 2 OR (v ->> 'undone')::int <> 1 OR (v ->> 'placed_installer')::int < 2 THEN
    RAISE EXCEPTION 'status: %', v;
  END IF;

  -- The daily cap.
  UPDATE public.materials_ai_settings SET daily_call_cap = 1 WHERE id;
  IF public.materials_ai_reserve_call('place', 'test-model', 1) IS NOT NULL THEN RAISE EXCEPTION 'cap not kept'; END IF;
  UPDATE public.materials_ai_settings SET enabled = false, daily_call_cap = 300 WHERE id;
  IF public.materials_ai_reserve_call('place', 'test-model', 1) IS NOT NULL THEN RAISE EXCEPTION 'off not kept'; END IF;
  IF public.materials_ai_apply(c, 'test-model', '{"xero_invoice_id":"AI-LOW","decision":"job","job_number":"AI-J2","confidence":0.99,"reason":"x"}') ->> 'outcome' <> 'off' THEN
    RAISE EXCEPTION 'off apply';
  END IF;
END $$;

-- The AI never writes to a person's bill even by the source check.
DO $$
BEGIN
  IF has_function_privilege('authenticated', 'public.materials_ai_apply(uuid, text, jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION 'apply reachable by authenticated';
  END IF;
END $$;

ROLLBACK;
