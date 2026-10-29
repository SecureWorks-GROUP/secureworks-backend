-- Contract for 20261029093000_materials_ai_two_keys (TP-03, TP-21).
--
-- Synthetic jobs and bills, no customer data. Everything rolls back.
--
--   SWF-29001, SWP-29002, SWF-29003  live jobs.
--   TK-NONE   no hard clue, AI 0.95 on SWF-29001: held; the check agrees: placed.
--   TK-DIS    no hard clue, AI 0.95 on SWF-29001: held; the check names
--             SWP-29002: left for a person with both answers.
--   TK-UNS    no hard clue: held; the check is unsure: left for a person.
--   TK-JOB    "SWF 29001" in the reference: placed at once, key job_number.
--   TK-LINE   "SWP29002" in line 2: placed at once, key job_number (line 2).
--   TK-TWIN   "SWP-29001" (another prefix, same digits) on the bill, AI picks
--             SWF-29001: no job number key, held.
--   TK-PO     "PO1000777" in the reference, PO-1000777 is on SWP-29002: placed
--             at once, key purchase_order.
--   TK-POX    a PO of SWF-29003 on the bill, AI picks SWP-29002: held.
--   TK-SUP    supplier C-SUP has a person-placed bill on SWF-29003: placed at
--             once, key same_supplier.
--   TK-SUPAI  supplier C-AI has only an unchecked AI placement on SWF-29003
--             (TK-OLD, before two keys): it does not vouch, held.
--   TK-BAR    held at 0.91; the bar rises to 0.95 before the check agrees:
--             left for a person.
--   TK-CHG    held; a person places it before the check agrees: the person's
--             placement stands, the held row is refused.
--   TK-NJR    office bill filed not job related (not gated), key ai_confidence.
--   TK-OLD    placed live before two keys, no clue: listed in
--             v_materials_ai_placed_without_key.
--   TK-OLDJ   placed live before two keys, job number on the bill: not listed.
--   TK-OLDC   placed live before two keys, second check agreed: not listed.

\set ON_ERROR_STOP on

BEGIN;

UPDATE public.materials_ai_settings
   SET enabled = true, confidence_bar = 0.900, second_check_sample = 0, second_check_over_ex = 100000, reread_after_days = 14
 WHERE id;

INSERT INTO public.jobs (id, org_id, status, type, job_number, legacy, metadata, pricing_json, expected_costs, created_at, client_name, site_suburb) VALUES
  ('b2000000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000001', 'accepted', 'fencing', 'SWF-29001', false, '{}', '{}', NULL, '2026-07-01T00:00:00Z', 'Key Client One', 'Keyville'),
  ('b2000000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000001', 'accepted', 'patio', 'SWP-29002', false, '{}', '{}', NULL, '2026-07-01T00:00:00Z', 'Key Client Two', 'Keyton'),
  ('b2000000-0000-4000-8000-000000000003', '00000000-0000-0000-0000-000000000001', 'accepted', 'fencing', 'SWF-29003', false, '{}', '{}', NULL, '2026-07-01T00:00:00Z', 'Key Client Three', 'Keyburn');

INSERT INTO public.purchase_orders (id, po_number, job_id, xero_contact_id, supplier_name, subtotal, status) VALUES
  ('b2000000-0000-4000-8000-0000000000a1', 'PO-1000777', 'b2000000-0000-4000-8000-000000000002', 'C-STEEL', 'Key Steel', 300, 'sent'),
  ('b2000000-0000-4000-8000-0000000000a2', 'PO-1000888', 'b2000000-0000-4000-8000-000000000003', 'C-STEEL', 'Key Steel', 300, 'sent');

INSERT INTO public.xero_invoices (org_id, xero_invoice_id, invoice_number, invoice_type, status, contact_name, sub_total, total, invoice_date, reference, line_items, raw_json, job_id)
SELECT '00000000-0000-0000-0000-000000000001', b.id, 'TKB-' || b.id, 'ACCPAY', 'AUTHORISED', b.supplier, b.amount, b.amount * 1.1, '2026-08-21', b.ref,
       b.lines::jsonb, '{"LineAmountTypes": "Exclusive"}', NULL
  FROM (VALUES
    ('TK-NONE', 'Key Steel', 300, NULL, '[{"Description": "Fence posts", "AccountCode": "310", "LineAmount": 300}]'),
    ('TK-DIS', 'Key Steel', 310, NULL, '[{"Description": "Fence rails", "AccountCode": "310", "LineAmount": 310}]'),
    ('TK-UNS', 'Key Steel', 320, NULL, '[{"Description": "Fence caps", "AccountCode": "310", "LineAmount": 320}]'),
    ('TK-JOB', 'Key Steel', 330, 'Order for SWF 29001', '[{"Description": "Fence sheets", "AccountCode": "310", "LineAmount": 330}]'),
    ('TK-LINE', 'Key Steel', 340, 'Order 55', '[{"Description": "Delivery", "AccountCode": "310", "LineAmount": 40}, {"Description": "Beams SWP29002", "AccountCode": "310", "LineAmount": 300}]'),
    ('TK-TWIN', 'Key Steel', 350, 'SWP-29001', '[{"Description": "Fence sheets", "AccountCode": "310", "LineAmount": 350}]'),
    ('TK-PO', 'Key Steel', 360, 'PO1000777', '[{"Description": "Beams", "AccountCode": "310", "LineAmount": 360}]'),
    ('TK-POX', 'Key Steel', 370, 'PO-1000888', '[{"Description": "Beams", "AccountCode": "310", "LineAmount": 370}]'),
    ('TK-SUP-PRIOR', 'Key Sup', 100, NULL, '[{"Description": "Gravel", "AccountCode": "310", "LineAmount": 100}]'),
    ('TK-SUP', 'Key Sup', 380, NULL, '[{"Description": "Gravel", "AccountCode": "310", "LineAmount": 380}]'),
    ('TK-OLD', 'Key AI', 390, NULL, '[{"Description": "Sand", "AccountCode": "310", "LineAmount": 390}]'),
    ('TK-SUPAI', 'Key AI', 400, NULL, '[{"Description": "Sand", "AccountCode": "310", "LineAmount": 400}]'),
    ('TK-BAR', 'Key Steel', 410, NULL, '[{"Description": "Screws", "AccountCode": "310", "LineAmount": 410}]'),
    ('TK-CHG', 'Key Steel', 420, NULL, '[{"Description": "Bolts", "AccountCode": "310", "LineAmount": 420}]'),
    ('TK-NJR', 'Key Office', 30, NULL, '[{"Description": "Printer paper", "AccountCode": "400", "LineAmount": 30}]'),
    ('TK-OLDJ', 'Key Steel', 430, 'SWF-29003', '[{"Description": "Posts", "AccountCode": "310", "LineAmount": 430}]'),
    ('TK-OLDC', 'Key Steel', 440, NULL, '[{"Description": "Posts", "AccountCode": "310", "LineAmount": 440}]')
  ) b(id, supplier, amount, ref, lines);

INSERT INTO public.materials_reconciliation_queue (xero_invoice_id, invoice_number, contact_name, xero_contact_id, sub_total, total, invoice_date, status)
SELECT x.xero_invoice_id, x.invoice_number, x.contact_name,
       -- One Xero contact per bill, so no bill vouches for another by accident;
       -- only the two supplier cases share one.
       CASE WHEN x.contact_name = 'Key Sup' THEN 'C-SUP' WHEN x.contact_name = 'Key AI' THEN 'C-AI' ELSE 'C-' || x.xero_invoice_id END,
       x.sub_total, x.total, x.invoice_date,
       CASE WHEN x.xero_invoice_id IN ('TK-SUP-PRIOR', 'TK-OLD', 'TK-OLDJ', 'TK-OLDC') THEN 'assigned' ELSE 'open' END
  FROM public.xero_invoices x WHERE x.xero_invoice_id LIKE 'TK-%';
UPDATE public.materials_reconciliation_queue SET assigned_by = 'person@example.test' WHERE xero_invoice_id = 'TK-SUP-PRIOR';
UPDATE public.materials_reconciliation_queue SET assigned_by = 'ai:old-model' WHERE xero_invoice_id IN ('TK-OLD', 'TK-OLDJ', 'TK-OLDC');

INSERT INTO public.job_materials_facts (xero_invoice_id, invoice_number, xero_contact_id, job_id, job_number, lane, kind, amount_ex_gst, confidence, automation_source, fact_date) VALUES
  ('TK-SUP-PRIOR', 'TKB-TK-SUP-PRIOR', 'C-SUP', 'b2000000-0000-4000-8000-000000000003', 'SWF-29003', 'materials', 'actual', 100, 'high_manual', 'manual_queue', '2026-08-01'),
  ('TK-OLD', 'TKB-TK-OLD', 'C-AI', 'b2000000-0000-4000-8000-000000000003', 'SWF-29003', 'materials', 'actual', 390, 'medium', 'agent_ai', '2026-08-01'),
  ('TK-OLDJ', 'TKB-TK-OLDJ', 'C-TK-OLDJ', 'b2000000-0000-4000-8000-000000000003', 'SWF-29003', 'materials', 'actual', 430, 'medium', 'agent_ai', '2026-08-01'),
  ('TK-OLDC', 'TKB-TK-OLDC', 'C-TK-OLDC', 'b2000000-0000-4000-8000-000000000001', 'SWF-29001', 'materials', 'actual', 440, 'medium', 'agent_ai', '2026-08-01');

-- Three placements made live before two keys (agreed_keys NULL).
INSERT INTO public.materials_ai_placements (xero_invoice_id, invoice_number, contact_name, amount_ex, decision, job_id, job_number, confidence, bar, reason, model, outcome, second_check_status, created_at) VALUES
  ('TK-OLD', 'TKB-TK-OLD', 'Key AI', 390, 'job', 'b2000000-0000-4000-8000-000000000003', 'SWF-29003', 0.93, 0.9, 'Sand near the job date.', 'old-model', 'placed', 'not_needed', '2026-10-28T10:00:00Z'),
  ('TK-OLDJ', 'TKB-TK-OLDJ', 'Key Steel', 430, 'job', 'b2000000-0000-4000-8000-000000000003', 'SWF-29003', 0.97, 0.9, 'Reference names the job.', 'old-model', 'placed', 'not_needed', '2026-10-28T10:00:00Z'),
  ('TK-OLDC', 'TKB-TK-OLDC', 'Key Steel', 440, 'job', 'b2000000-0000-4000-8000-000000000001', 'SWF-29001', 0.92, 0.9, 'Posts for the fence.', 'old-model', 'placed', 'agreed', '2026-10-28T10:00:00Z');

DO $$
DECLARE
  c uuid;
  v jsonb;
  r record;
  pid uuid;
  n integer;
  ids text[];
BEGIN
  c := public.materials_ai_reserve_call('place', 'test-model', 12);
  IF c IS NULL THEN RAISE EXCEPTION 'reserve: no call'; END IF;

  -- ── No hard clue, high confidence: held, not placed ──
  v := public.materials_ai_apply(c, 'test-model', '{"xero_invoice_id":"TK-NONE","decision":"job","job_number":"SWF-29001","confidence":0.95,"reason":"Posts near the job date.","evidence":["supplier history"]}');
  IF v ->> 'outcome' <> 'held_for_check' OR v ->> 'second_check' <> 'due' OR v -> 'keys' <> '["ai_confidence"]'::jsonb THEN
    RAISE EXCEPTION 'TK-NONE apply: %', v;
  END IF;
  pid := (v ->> 'placement_id')::uuid;
  IF EXISTS (SELECT 1 FROM public.job_materials_facts WHERE xero_invoice_id = 'TK-NONE') THEN RAISE EXCEPTION 'TK-NONE placed while held'; END IF;
  SELECT * INTO r FROM public.materials_reconciliation_queue WHERE xero_invoice_id = 'TK-NONE';
  IF r.status <> 'open' OR r.assigned_by IS NOT NULL THEN RAISE EXCEPTION 'TK-NONE queue moved while held: % %', r.status, r.assigned_by; END IF;
  SELECT * INTO r FROM public.materials_ai_placements WHERE id = pid;
  IF r.held_at IS NULL OR r.second_check_status <> 'due' OR r.agreed_keys <> ARRAY['ai_confidence'] OR r.job_number <> 'SWF-29001' THEN
    RAISE EXCEPTION 'TK-NONE row: % % % %', r.held_at, r.second_check_status, r.agreed_keys, r.job_number;
  END IF;
  IF EXISTS (SELECT 1 FROM public.job_events WHERE job_id = 'b2000000-0000-4000-8000-000000000001' AND event_type = 'materials_bill_assigned') THEN
    RAISE EXCEPTION 'TK-NONE job event while held';
  END IF;
  -- A second answer for a held bill is refused; the batch does not read it again.
  v := public.materials_ai_apply(c, 'test-model', '{"xero_invoice_id":"TK-NONE","decision":"job","job_number":"SWF-29001","confidence":0.99,"reason":"again"}');
  IF v ->> 'outcome' <> 'refused' OR v ->> 'refusal' <> 'waiting for the second check' THEN RAISE EXCEPTION 'TK-NONE twice: %', v; END IF;
  DELETE FROM public.materials_ai_placements WHERE xero_invoice_id = 'TK-NONE' AND outcome = 'refused';
  UPDATE public.materials_ai_placements SET created_at = now() - interval '30 days' WHERE id = pid;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(public.materials_ai_bill_batch(20)) e WHERE e ->> 'xero_invoice_id' = 'TK-NONE') THEN
    RAISE EXCEPTION 'held bill read again';
  END IF;
  -- A held_placement_id the database did not release is an error.
  BEGIN
    PERFORM public.materials_ai_apply(c, 'test-model', jsonb_build_object('xero_invoice_id', 'TK-NONE', 'decision', 'job',
      'job_number', 'SWF-29001', 'confidence', 0.95, 'reason', 'forged', 'held_placement_id', pid));
    RAISE EXCEPTION 'forged held_placement_id accepted';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE 'materials_ai_apply: held_placement_id is not%' THEN RAISE; END IF;
  END;
  -- The blind check lists the held bill first, without the first answer.
  v := public.materials_ai_second_check_due(1);
  IF jsonb_array_length(v) <> 1 OR v -> 0 ->> 'placement_id' <> pid::text OR v -> 0 ? 'job_number' OR v -> 0 ? 'reason' THEN
    RAISE EXCEPTION 'second check due: %', v;
  END IF;

  -- ── The check agrees: placed, two keys named ──
  v := public.materials_ai_record_second_check(pid, '{"decision":"job","job_number":"swf-29001","confidence":0.9,"reason":"agree","model":"claude"}');
  IF NOT (v ->> 'agreed')::boolean OR v ->> 'outcome' <> 'placed' OR NOT (v ->> 'held')::boolean THEN RAISE EXCEPTION 'TK-NONE check: %', v; END IF;
  SELECT * INTO r FROM public.materials_ai_placements WHERE id = pid;
  IF r.outcome <> 'placed' OR r.second_check_status <> 'agreed' OR r.agreed_keys <> ARRAY['ai_confidence', 'second_check']
     OR r.held_at IS NULL OR r.second_check ->> 'model' <> 'claude' THEN
    RAISE EXCEPTION 'TK-NONE placed row: % % % %', r.outcome, r.second_check_status, r.agreed_keys, r.second_check;
  END IF;
  SELECT * INTO r FROM public.job_materials_facts WHERE xero_invoice_id = 'TK-NONE';
  IF r.automation_source <> 'agent_ai' OR r.job_number <> 'SWF-29001' OR r.amount_ex_gst <> 300 OR r.assigned_by <> 'ai:test-model' THEN
    RAISE EXCEPTION 'TK-NONE fact: % % % %', r.automation_source, r.job_number, r.amount_ex_gst, r.assigned_by;
  END IF;
  IF (SELECT status FROM public.materials_reconciliation_queue WHERE xero_invoice_id = 'TK-NONE') <> 'assigned' THEN RAISE EXCEPTION 'TK-NONE queue'; END IF;
  SELECT detail_json INTO v FROM public.job_events
   WHERE job_id = 'b2000000-0000-4000-8000-000000000001' AND event_type = 'materials_bill_assigned' AND detail_json ->> 'xero_invoice_id' = 'TK-NONE';
  IF v -> 'keys' <> '["ai_confidence", "second_check"]'::jsonb OR v ->> 'placement_id' <> pid::text THEN RAISE EXCEPTION 'TK-NONE event: %', v; END IF;
  IF (SELECT count(*) FROM public.materials_ai_placements WHERE xero_invoice_id = 'TK-NONE') <> 1 THEN RAISE EXCEPTION 'TK-NONE: one audit row from hold to place'; END IF;
  -- A second record is idempotent and places nothing more.
  v := public.materials_ai_record_second_check(pid, '{"decision":"job","job_number":"SWF-29001","model":"claude"}');
  IF NOT (v ->> 'idempotent')::boolean THEN RAISE EXCEPTION 'TK-NONE re-record: %', v; END IF;
  -- Undo still takes it back.
  v := public.materials_ai_undo(pid, 'person@example.test', 'check');
  IF NOT (v ->> 'ok')::boolean OR EXISTS (SELECT 1 FROM public.job_materials_facts WHERE xero_invoice_id = 'TK-NONE') THEN
    RAISE EXCEPTION 'TK-NONE undo: %', v;
  END IF;

  -- ── The check disagrees: left for a person with both answers ──
  v := public.materials_ai_apply(c, 'test-model', '{"xero_invoice_id":"TK-DIS","decision":"job","job_number":"SWF-29001","confidence":0.95,"reason":"Rails near the job date."}');
  IF v ->> 'outcome' <> 'held_for_check' THEN RAISE EXCEPTION 'TK-DIS apply: %', v; END IF;
  pid := (v ->> 'placement_id')::uuid;
  v := public.materials_ai_record_second_check(pid, '{"decision":"job","job_number":"SWP-29002","confidence":0.8,"reason":"Rails were for the patio.","model":"claude"}');
  IF (v ->> 'agreed')::boolean OR v ->> 'outcome' <> 'left_for_person' THEN RAISE EXCEPTION 'TK-DIS check: %', v; END IF;
  SELECT * INTO r FROM public.materials_ai_placements WHERE id = pid;
  IF r.outcome <> 'left_for_person' OR r.second_check_status <> 'disagreed' OR r.job_number <> 'SWF-29001' OR r.reason <> 'Rails near the job date.'
     OR r.second_check ->> 'job_number' <> 'SWP-29002' OR r.second_check ->> 'reason' <> 'Rails were for the patio.' THEN
    RAISE EXCEPTION 'TK-DIS row (both answers): % % % %', r.outcome, r.second_check_status, r.job_number, r.second_check;
  END IF;
  IF EXISTS (SELECT 1 FROM public.job_materials_facts WHERE xero_invoice_id = 'TK-DIS')
     OR (SELECT status FROM public.materials_reconciliation_queue WHERE xero_invoice_id = 'TK-DIS') <> 'open' THEN
    RAISE EXCEPTION 'TK-DIS moved';
  END IF;
  UPDATE public.materials_ai_placements SET created_at = now() - interval '30 days' WHERE id = pid;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(public.materials_ai_bill_batch(20)) e WHERE e ->> 'xero_invoice_id' = 'TK-DIS') THEN
    RAISE EXCEPTION 'disagreed bill read again';
  END IF;
  v := public.materials_ai_apply(c, 'test-model', '{"xero_invoice_id":"TK-DIS","decision":"job","job_number":"SWF-29001","confidence":0.99,"reason":"again"}');
  IF v ->> 'refusal' <> 'the second check disagreed: a person decides this bill' THEN RAISE EXCEPTION 'TK-DIS again: %', v; END IF;

  -- ── The check is unsure: left for a person ──
  v := public.materials_ai_apply(c, 'test-model', '{"xero_invoice_id":"TK-UNS","decision":"job","job_number":"SWF-29001","confidence":0.95,"reason":"Caps."}');
  pid := (v ->> 'placement_id')::uuid;
  v := public.materials_ai_record_second_check(pid, '{"decision":"unsure","confidence":0.4,"reason":"Could be any fence.","model":"claude"}');
  IF v ->> 'outcome' <> 'left_for_person' OR EXISTS (SELECT 1 FROM public.job_materials_facts WHERE xero_invoice_id = 'TK-UNS') THEN
    RAISE EXCEPTION 'TK-UNS: %', v;
  END IF;

  -- ── Job number on the bill: placed at once, keys recorded ──
  v := public.materials_ai_apply(c, 'test-model', '{"xero_invoice_id":"TK-JOB","decision":"job","job_number":"SWF-29001","confidence":0.95,"reason":"Reference names the job."}');
  IF v ->> 'outcome' <> 'placed' OR v -> 'keys' <> '["ai_confidence", "job_number"]'::jsonb OR v ->> 'second_check' <> 'not_needed' THEN
    RAISE EXCEPTION 'TK-JOB: %', v;
  END IF;
  SELECT * INTO r FROM public.materials_ai_placements WHERE id = (v ->> 'placement_id')::uuid;
  IF r.agreed_keys <> ARRAY['ai_confidence', 'job_number'] OR r.key_evidence ->> 'job_number' <> 'SWF-29001 in reference' OR r.held_at IS NOT NULL THEN
    RAISE EXCEPTION 'TK-JOB row: % % %', r.agreed_keys, r.key_evidence, r.held_at;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.job_materials_facts WHERE xero_invoice_id = 'TK-JOB' AND automation_source = 'agent_ai' AND job_number = 'SWF-29001') THEN
    RAISE EXCEPTION 'TK-JOB fact';
  END IF;
  v := public.materials_ai_apply(c, 'test-model', '{"xero_invoice_id":"TK-LINE","decision":"job","job_number":"SWP-29002","confidence":0.92,"reason":"Line 2 names the job."}');
  IF v ->> 'outcome' <> 'placed' OR (SELECT key_evidence ->> 'job_number' FROM public.materials_ai_placements WHERE id = (v ->> 'placement_id')::uuid) <> 'SWP-29002 in line 2' THEN
    RAISE EXCEPTION 'TK-LINE: %', v;
  END IF;
  -- Another prefix with the same digits is not this job's number.
  v := public.materials_ai_apply(c, 'test-model', '{"xero_invoice_id":"TK-TWIN","decision":"job","job_number":"SWF-29001","confidence":0.95,"reason":"Digits match."}');
  IF v ->> 'outcome' <> 'held_for_check' THEN RAISE EXCEPTION 'TK-TWIN: %', v; END IF;

  -- ── PO on the bill: placed at once ──
  v := public.materials_ai_apply(c, 'test-model', '{"xero_invoice_id":"TK-PO","decision":"job","job_number":"SWP-29002","confidence":0.93,"reason":"Our PO."}');
  IF v ->> 'outcome' <> 'placed' OR v -> 'keys' <> '["ai_confidence", "purchase_order"]'::jsonb THEN RAISE EXCEPTION 'TK-PO: %', v; END IF;
  IF (SELECT key_evidence ->> 'purchase_order' FROM public.materials_ai_placements WHERE id = (v ->> 'placement_id')::uuid) <> 'PO-1000777 on the bill' THEN
    RAISE EXCEPTION 'TK-PO evidence';
  END IF;
  -- A PO of another job is no key for this one.
  v := public.materials_ai_apply(c, 'test-model', '{"xero_invoice_id":"TK-POX","decision":"job","job_number":"SWP-29002","confidence":0.95,"reason":"Beams."}');
  IF v ->> 'outcome' <> 'held_for_check' THEN RAISE EXCEPTION 'TK-POX: %', v; END IF;

  -- ── Same supplier already placed on the job by a person: placed at once ──
  v := public.materials_ai_apply(c, 'test-model', '{"xero_invoice_id":"TK-SUP","decision":"job","job_number":"SWF-29003","confidence":0.91,"reason":"Gravel again."}');
  IF v ->> 'outcome' <> 'placed' OR v -> 'keys' <> '["ai_confidence", "same_supplier"]'::jsonb THEN RAISE EXCEPTION 'TK-SUP: %', v; END IF;
  IF (SELECT key_evidence ->> 'same_supplier' FROM public.materials_ai_placements WHERE id = (v ->> 'placement_id')::uuid) <> 'TKB-TK-SUP-PRIOR (manual_queue)' THEN
    RAISE EXCEPTION 'TK-SUP evidence';
  END IF;
  -- An unchecked AI placement of the same supplier does not vouch.
  v := public.materials_ai_apply(c, 'test-model', '{"xero_invoice_id":"TK-SUPAI","decision":"job","job_number":"SWF-29003","confidence":0.95,"reason":"Sand again."}');
  IF v ->> 'outcome' <> 'held_for_check' THEN RAISE EXCEPTION 'TK-SUPAI: %', v; END IF;

  -- ── The bar rises while the bill waits: left for a person ──
  v := public.materials_ai_apply(c, 'test-model', '{"xero_invoice_id":"TK-BAR","decision":"job","job_number":"SWF-29001","confidence":0.91,"reason":"Screws."}');
  IF v ->> 'outcome' <> 'held_for_check' THEN RAISE EXCEPTION 'TK-BAR apply: %', v; END IF;
  pid := (v ->> 'placement_id')::uuid;
  UPDATE public.materials_ai_settings SET confidence_bar = 0.950 WHERE id;
  v := public.materials_ai_record_second_check(pid, '{"decision":"job","job_number":"SWF-29001","model":"claude"}');
  SELECT * INTO r FROM public.materials_ai_placements WHERE id = pid;
  IF v ->> 'outcome' <> 'left_for_person' OR r.refusal NOT LIKE 'the confidence bar rose to 0.950%' OR EXISTS (SELECT 1 FROM public.job_materials_facts WHERE xero_invoice_id = 'TK-BAR') THEN
    RAISE EXCEPTION 'TK-BAR: % %', v, r.refusal;
  END IF;
  UPDATE public.materials_ai_settings SET confidence_bar = 0.900 WHERE id;

  -- ── A person places the bill while it waits: the person's placement stands ──
  v := public.materials_ai_apply(c, 'test-model', '{"xero_invoice_id":"TK-CHG","decision":"job","job_number":"SWF-29001","confidence":0.95,"reason":"Bolts."}');
  pid := (v ->> 'placement_id')::uuid;
  UPDATE public.materials_reconciliation_queue SET status = 'assigned', assigned_by = 'person@example.test', assigned_job_id = 'b2000000-0000-4000-8000-000000000002'
   WHERE xero_invoice_id = 'TK-CHG';
  INSERT INTO public.job_materials_facts (xero_invoice_id, job_id, job_number, lane, kind, amount_ex_gst, confidence, automation_source, fact_date)
  VALUES ('TK-CHG', 'b2000000-0000-4000-8000-000000000002', 'SWP-29002', 'materials', 'actual', 420, 'high_manual', 'manual_queue', '2026-08-21');
  v := public.materials_ai_record_second_check(pid, '{"decision":"job","job_number":"SWF-29001","model":"claude"}');
  SELECT * INTO r FROM public.materials_ai_placements WHERE id = pid;
  IF v ->> 'outcome' <> 'refused' OR r.refusal <> 'after the second check agreed: already assigned' THEN RAISE EXCEPTION 'TK-CHG: % %', v, r.refusal; END IF;
  SELECT count(*) AS n, min(automation_source) AS src, min(job_number) AS job INTO r FROM public.job_materials_facts WHERE xero_invoice_id = 'TK-CHG';
  IF r.n <> 1 OR r.src <> 'manual_queue' OR r.job <> 'SWP-29002' THEN RAISE EXCEPTION 'TK-CHG person row moved: % % %', r.n, r.src, r.job; END IF;

  -- ── Filing not job related is not gated, and names its one key ──
  v := public.materials_ai_apply(c, 'test-model', '{"xero_invoice_id":"TK-NJR","decision":"not_job_related","confidence":0.97,"reason":"Office paper."}');
  IF v ->> 'outcome' <> 'filed_not_job_related' OR v -> 'keys' <> '["ai_confidence"]'::jsonb THEN RAISE EXCEPTION 'TK-NJR: %', v; END IF;

  -- ── Bills placed live before two keys: counted, never moved ──
  SELECT array_agg(xero_invoice_id ORDER BY xero_invoice_id) INTO ids FROM public.v_materials_ai_placed_without_key WHERE xero_invoice_id LIKE 'TK-%';
  IF ids IS DISTINCT FROM ARRAY['TK-OLD'] THEN RAISE EXCEPTION 'placed without key: %', ids; END IF;
  IF NOT (SELECT placed_before_two_keys FROM public.v_materials_ai_placed_without_key WHERE xero_invoice_id = 'TK-OLD') THEN
    RAISE EXCEPTION 'TK-OLD not marked before two keys';
  END IF;
  v := public.materials_ai_placed_without_key_count();
  IF (v ->> 'placed_without_key')::int < 1 OR (v ->> 'never_checked')::int < 1 OR (v ->> 'placed_without_key_ex')::numeric < 390 THEN
    RAISE EXCEPTION 'count: %', v;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.job_materials_facts WHERE xero_invoice_id = 'TK-OLD' AND automation_source = 'agent_ai')
     OR (SELECT outcome FROM public.materials_ai_placements WHERE xero_invoice_id = 'TK-OLD') <> 'placed' THEN
    RAISE EXCEPTION 'TK-OLD moved';
  END IF;

  -- ── Status: every 20261028173000 key, plus the held bills and the keys ──
  v := public.materials_ai_status();
  IF NOT (v ?& ARRAY['enabled', 'confidence_bar', 'daily_call_cap', 'calls_today', 'placed', 'placed_ex', 'placed_installer',
                     'filed_not_job_related', 'filed_ex', 'undone', 'left_for_person_open', 'second_check', 'bills_to_place_open',
                     'bills_to_place_open_ex', 'bar_history', 'held_for_check', 'held_for_check_ex', 'placed_keys', 'placed_before_two_keys']) THEN
    RAISE EXCEPTION 'status keys: %', v;
  END IF;
  -- Held now: TK-TWIN, TK-POX, TK-SUPAI.
  IF (v ->> 'held_for_check')::int <> 3 OR (v ->> 'held_for_check_ex')::numeric <> 1120 OR (v -> 'second_check' ->> 'held_due')::int <> 3
     OR (v ->> 'held_then_left_for_person')::int <> 3 OR (v -> 'placed_keys' ->> 'job_number')::int <> 2
     OR (v -> 'placed_keys' ->> 'purchase_order')::int <> 1 OR (v -> 'placed_keys' ->> 'same_supplier')::int <> 1
     OR (v ->> 'placed_before_two_keys')::int < 3 THEN
    RAISE EXCEPTION 'status: %', v;
  END IF;
  SELECT count(*) INTO n FROM public.materials_reconciliation_queue WHERE xero_invoice_id IN ('TK-TWIN', 'TK-POX', 'TK-SUPAI') AND status = 'open';
  IF n <> 3 THEN RAISE EXCEPTION 'held bills not open: %', n; END IF;
END $$;

-- Read only, service role only.
DO $$
BEGIN
  IF has_function_privilege('authenticated', 'public.materials_ai_hard_keys(text, uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.materials_ai_placed_without_key_count()', 'EXECUTE')
     OR has_table_privilege('authenticated', 'public.v_materials_ai_placed_without_key', 'SELECT') THEN
    RAISE EXCEPTION 'two keys reachable by authenticated';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.materials_ai_placed_without_key_count()', 'EXECUTE') THEN
    RAISE EXCEPTION 'count not reachable by service_role';
  END IF;
END $$;

ROLLBACK;
