-- Contract for 20261006014000_context_job_story: the story is read-only and
-- service-role only, and its rules hold on synthetic jobs: ledger items attach to
-- record loops by about_key, an R5 candidate is promoted only by a reply-owed item
-- and otherwise says why it is a check, closing evidence is never a closure, a stale
-- citation hides its item and asks for a rebuild, crew and automated texts are never
-- what we told the customer, Perth weekdays match their dates, money is per party,
-- a shadow generation shows only when asked, changes start after p_since, and how
-- far the reader has read is the ledger's own count (rows that landed after the
-- shown generation's evidence_until), never the fact pass's.
-- Every fixture row is synthetic and rolled back; user triggers are off for it.

DO $shape$
DECLARE f text; p record;
BEGIN
 FOREACH f IN ARRAY ARRAY['public.context_job_story_facts(uuid,timestamptz)','public.context_job_story_ledger(uuid,uuid,timestamptz)',
   'public.context_job_story_meta(uuid,timestamptz)','public.context_job_story(uuid,timestamptz,uuid,timestamptz,boolean)',
   'public.context_client_story(uuid,timestamptz)','public.context_story_scorecard(timestamptz)',
   'public.context_story_scorecard_jobs(uuid,integer)'] LOOP
  SELECT pr.prosecdef, pr.provolatile, pr.proconfig INTO p FROM pg_proc pr WHERE pr.oid = to_regprocedure(f);
  IF p IS NULL THEN RAISE EXCEPTION 'story contract: % missing', f; END IF;
  IF NOT p.prosecdef OR p.provolatile <> 's' OR NOT ('search_path=public, pg_temp' = ANY (p.proconfig)) THEN
   RAISE EXCEPTION 'story contract: % must be STABLE SECURITY DEFINER with search_path public, pg_temp', f;
  END IF;
  IF has_function_privilege('anon', f, 'EXECUTE') OR has_function_privilege('authenticated', f, 'EXECUTE')
     OR NOT has_function_privilege('service_role', f, 'EXECUTE') THEN
   RAISE EXCEPTION 'story contract: % access wrong', f;
  END IF;
  IF obj_description(to_regprocedure(f), 'pg_proc') NOT LIKE 'Job story (20261006014000)%' THEN
   RAISE EXCEPTION 'story contract: % comment does not name the slice', f;
  END IF;
 END LOOP;
 SELECT pr.prosecdef, pr.proconfig INTO p FROM pg_proc pr
 WHERE pr.oid = to_regprocedure('public.context_job_story_assemble(jsonb,jsonb,jsonb,jsonb,timestamptz,timestamptz)');
 IF p.prosecdef OR p.proconfig IS NOT NULL THEN RAISE EXCEPTION 'story contract: the assembler must stay pure and inlinable'; END IF;
 IF has_function_privilege('anon', 'public.context_job_story_assemble(jsonb,jsonb,jsonb,jsonb,timestamptz,timestamptz)', 'EXECUTE') THEN
  RAISE EXCEPTION 'story contract: the assembler is callable by anon';
 END IF;
END $shape$;

-- The assembler reads no table: with no record, no ledger and no meta it still answers.
DO $pure$
DECLARE s jsonb;
BEGIN
 s := public.context_job_story_assemble('{"id":"x","status":"quoted","type":"fencing","created_at":"2026-10-01T00:00:00Z"}'::jsonb,
                                        '{}'::jsonb, NULL, NULL, '2026-10-07 02:00Z', NULL);
 IF s->'meta'->'ledger'->>'status' <> 'none' OR jsonb_array_length(s->'loops') <> 0 OR s->'now'->>'whose_move' <> 'nobody'
    OR s->'now'->>'phase' <> 'quote' THEN
  RAISE EXCEPTION 'story contract: empty assembly wrong: %', s->'now';
 END IF;
 -- meta.ledger carries the reader's own freshness; the fact pass's unread count is gone.
 IF (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(s->'meta'->'ledger') k)
    <> ARRAY['evidence_until','generation_id','hidden_items','items','needs_rebuild','reader','stale','status','unread_rows']
    OR s->'meta'->'ledger'->'unread_rows' <> 'null'::jsonb OR (s->'meta'->'ledger'->>'stale')::boolean
    OR (s->'meta'->'ledger'->>'needs_rebuild')::boolean OR s->'meta' ? 'unread_rows' THEN
  RAISE EXCEPTION 'story contract: meta.ledger shape wrong: %', s->'meta';
 END IF;
 -- A shadow that is not shown (the ledger read gives a JSON null generation) is not
 -- live yet; the story never claims to show it and counts nothing unread.
 s := public.context_job_story_assemble('{"id":"x","status":"quoted","type":"fencing","created_at":"2026-10-01T00:00:00Z"}'::jsonb,
        '{}'::jsonb, '{"status":"shadow","generation":null,"items":[],"transitions":[],"unread_rows":null,"unread_ids":null}'::jsonb,
        '{"unread_rows":7}'::jsonb, '2026-10-07 02:00Z', NULL);
 IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(s->'not_known') k WHERE k->>'what' LIKE '%ledger for this job is not live yet%')
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(s->'not_known') k WHERE k->>'what' LIKE 'This story shows a shadow reading%'
                                                                          OR k->>'what' LIKE '%not been read by the reader yet.')
    OR s->'meta'->'ledger'->>'status' <> 'shadow' OR s->'meta'->'ledger'->'generation_id' <> 'null'::jsonb
    OR s->'meta'->'ledger'->'unread_rows' <> 'null'::jsonb THEN
  RAISE EXCEPTION 'story contract: an unshown shadow must read not live yet: % %', s->'not_known', s->'meta'->'ledger';
 END IF;
END $pure$;
BEGIN;
SET LOCAL session_replication_role = replica;

INSERT INTO public.jobs (id, org_id, job_number, status, type, client_email, ghl_contact_id, pricing_json, created_at)
VALUES ('a0000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000aa', 'SWF-T0001', 'accepted', 'fencing',
        'cust.a@example.test', 'ctA', '{"totalIncGST": 11000}', '2026-09-01 01:00Z'),
       ('a0000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-0000000000aa', 'SWMS-T0002', 'processing', 'makesafe',
        NULL, NULL, '{}', '2026-09-01 01:00Z'),
       ('a0000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-0000000000aa', 'SWF-T0003', 'quoted', 'fencing',
        'cust.c@example.test', 'ctC', '{"totalIncGST": 5000}', '2026-09-01 01:00Z');

-- Job A messages: customer text, our workflow follow-up (never a reply), a crew alert (internal),
-- a missed call from the customer, and a text to the customer recorded only after the replay instant.
INSERT INTO public.business_events (id, job_id, event_type, source, channel, direction, contact_id, payload, metadata, body_preview, occurred_at, recorded_at, event_at, attribution_status)
VALUES
 ('b0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', 'client.reply', 'ghl', 'sms', 'inbound', 'ctA',
  '{"body":"Can you come Monday?"}', '{"party_roles":{"counterpart_role":"customer","sender_role":"customer"}}', NULL,
  '2026-10-01 01:00Z', '2026-10-01 01:00Z', '2026-10-01 01:00Z', 'direct'),
 ('b0000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000001', 'client.sms_out', 'ghl', 'sms', 'outbound', 'ctA',
  '{"body":"Reminder: your quote is waiting","sent_by_kind":"workflow"}', '{"party_roles":{"counterpart_role":"customer"}}', NULL,
  '2026-10-02 01:00Z', '2026-10-02 01:00Z', '2026-10-02 01:00Z', 'direct'),
 ('b0000000-0000-4000-8000-000000000003', 'a0000000-0000-4000-8000-000000000001', 'client.sms_out', 'ops-api', 'sms', 'outbound', 'ctCrew',
  '{"body":"New job assigned: SWF-T0001"}', '{"recipient_role":"crew","party_roles":{"counterpart_role":"crew"}}', NULL,
  '2026-10-03 01:00Z', '2026-10-03 01:00Z', '2026-10-03 01:00Z', 'direct'),
 ('b0000000-0000-4000-8000-000000000004', 'a0000000-0000-4000-8000-000000000001', 'client.call_logged', 'ghl', 'call', 'inbound', 'ctA',
  '{"body":"Call. Provider status: no-answer. Duration: 0 seconds"}', '{}', NULL,
  '2026-10-04 01:00Z', '2026-10-04 01:00Z', '2026-10-04 01:00Z', 'direct'),
 ('b0000000-0000-4000-8000-000000000005', 'a0000000-0000-4000-8000-000000000001', 'client.sms_out', 'ghl', 'sms', 'outbound', 'ctA',
  '{"body":"Sorry we missed you, Monday works"}', '{"party_roles":{"counterpart_role":"customer"}}', NULL,
  '2026-10-08 01:00Z', '2026-10-08 01:00Z', '2026-10-05 01:00Z', 'direct');

-- Job A money: overdue part-paid invoice, a deleted one, a stale draft, a supplier bill, and a
-- second payer's paid invoice settled partly by an earlier overpayment.
INSERT INTO public.xero_invoices (org_id, id, job_id, xero_invoice_id, xero_contact_id, contact_name, invoice_number, invoice_type, status, reference,
  total, amount_due, amount_paid, invoice_date, due_date, raw_json, created_at)
VALUES
 ('00000000-0000-4000-8000-0000000000aa', 'c0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', 'x1', 'xc1', 'Payer One', 'INV-9001', 'ACCREC', 'AUTHORISED', 'SWF-T0001',
  1100, 800, 300, '2026-09-20', '2026-10-01',
  '{"Status":"AUTHORISED","Payments":[{"Amount":300,"Date":"/Date(1790294400000+0000)/"}],"AmountCredited":0}', '2026-09-20 01:00Z'),
 ('00000000-0000-4000-8000-0000000000aa', 'c0000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000001', 'x2', 'xc1', 'Payer One', 'INV-9002', 'ACCREC', 'DELETED', 'SWF-T0001',
  500, 0, 0, '2026-09-21', '2026-10-05', '{"Status":"DELETED"}', '2026-09-21 01:00Z'),
 ('00000000-0000-4000-8000-0000000000aa', 'c0000000-0000-4000-8000-000000000003', 'a0000000-0000-4000-8000-000000000001', 'x3', 'xc1', 'Payer One', 'INV-9003', 'ACCREC', 'DRAFT', 'SWF-T0001',
  2000, 2000, 0, '2026-10-03', '2026-10-17', '{"Status":"DRAFT"}', '2026-10-03 01:00Z'),
 ('00000000-0000-4000-8000-0000000000aa', 'c0000000-0000-4000-8000-000000000004', 'a0000000-0000-4000-8000-000000000001', 'x4', 'xs1', 'A Supplier', 'BILL-1', 'ACCPAY', 'AUTHORISED', NULL,
  400, 400, 0, '2026-09-25', '2026-09-30', '{"Status":"AUTHORISED"}', '2026-09-25 01:00Z'),
 ('00000000-0000-4000-8000-0000000000aa', 'c0000000-0000-4000-8000-000000000005', 'a0000000-0000-4000-8000-000000000001', 'x5', 'xc2', 'Payer Two', 'INV-9005', 'ACCREC', 'PAID', 'SWF-T0001',
  1000, 0, 900, '2026-09-22', '2026-09-29',
  '{"Status":"PAID","Payments":[{"Amount":900,"Date":"/Date(1790380800000+0000)/"}],"Overpayments":[{"AppliedAmount":100,"Date":"/Date(1790380800000+0000)/"}],"AmountCredited":100}',
  '2026-09-22 01:00Z'),
 -- Job B: Xero columns say PAID while the raw copy still says AUTHORISED with no payments
 ('00000000-0000-4000-8000-0000000000aa', 'c0000000-0000-4000-8000-000000000006', 'a0000000-0000-4000-8000-000000000002', 'x6', 'xc9', 'A Builder', 'INV-9006', 'ACCREC', 'PAID', 'SWMS-T0002',
  500, 0, 500, '2026-09-10', '2026-09-24', '{"Status":"AUTHORISED","Payments":[],"AmountCredited":0}', '2026-09-10 01:00Z');
UPDATE public.xero_invoices SET fully_paid_on = '2026-09-15' WHERE id = 'c0000000-0000-4000-8000-000000000006';

INSERT INTO public.job_documents (id, job_id, type, quote_number, version, created_at, sent_at, accepted_at)
VALUES ('d0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', 'quote', 'Q-9001', 1,
        '2026-09-10 01:00Z', '2026-09-10 01:10Z', '2026-09-12 01:00Z'),
       ('d0000000-0000-4000-8000-000000000003', 'a0000000-0000-4000-8000-000000000003', 'quote', 'Q-9003', 1,
        '2026-09-25 01:00Z', '2026-09-25 01:10Z', NULL);

-- Job B: a passed booking, an observer mirror of it, and a make-safe pack sent.
INSERT INTO public.job_assignments (id, job_id, role, scheduled_date, assignment_type, status, crew_name, confirmation_status, is_ghost, created_at)
VALUES ('e0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000002', 'lead_installer', '2026-10-02', 'install', 'scheduled', 'Crew One', 'tentative', false, '2026-09-28 01:00Z'),
       ('e0000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000002', 'observer', '2026-10-01', 'install', 'scheduled', NULL, 'confirmed', true, '2026-09-28 01:00Z');
INSERT INTO public.job_events (id, job_id, event_type, detail_json, created_at)
VALUES ('f0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000002', 'makesafe_pack_sent_at_derived', '{}', '2026-10-03 01:00Z'),
       -- Job C: status ping-pong within ten minutes folds into one row
       ('f0000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000003', 'status_changed', '{"new_status":"awaiting_deposit"}', '2026-09-26 02:00Z'),
       ('f0000000-0000-4000-8000-000000000003', 'a0000000-0000-4000-8000-000000000003', 'status_changed', '{"new_status":"quoted"}', '2026-09-26 02:03Z'),
       ('f0000000-0000-4000-8000-000000000004', 'a0000000-0000-4000-8000-000000000003', 'status_changed', '{"new_status":"awaiting_deposit"}', '2026-09-26 02:05Z');

-- Job C: the customer's email exists only in the legacy inbox (no business_events copy).
INSERT INTO public.inbox_events (id, job_id, from_email, subject, body_preview, received_at, graph_message_id, mailbox)
VALUES ('aa000000-0000-4000-8000-000000000001', NULL, 'Cust.C@example.test', 'Quote question', 'Does the price include the gate?',
        '2026-10-03 01:00Z', 'g-legacy-1', 'admin@example.test'),
       ('aa000000-0000-4000-8000-000000000002', NULL, 'cust.c@example.test', 'Automatic reply: away', 'I am away',
        '2026-10-04 01:00Z', 'g-legacy-2', 'admin@example.test');


-- Story extras: a promise we made earlier, a quote sent after it, a row since moved to
-- another job, a second job of the same client, a future booking, and the ledger.
INSERT INTO public.business_events (id, job_id, event_type, source, channel, direction, contact_id, payload, metadata, occurred_at, recorded_at, event_at, attribution_status)
VALUES
 ('b0000000-0000-4000-8000-000000000006', 'a0000000-0000-4000-8000-000000000001', 'client.sms_out', 'ghl', 'sms', 'outbound', 'ctA',
  '{"body":"I will send the quote for the rest of the fence tomorrow","sent_by_kind":"staff_app"}', '{"party_roles":{"counterpart_role":"customer","sender_role":"staff"}}',
  '2026-09-30 01:00Z', '2026-09-30 01:00Z', '2026-09-30 01:00Z', 'direct'),
 ('b0000000-0000-4000-8000-000000000007', 'a0000000-0000-4000-8000-000000000003', 'client.reply', 'ghl', 'sms', 'inbound', 'ctC',
  '{"body":"The side gate sticks"}', '{"party_roles":{"counterpart_role":"customer","sender_role":"customer"}}',
  '2026-09-29 01:00Z', '2026-09-29 01:00Z', '2026-09-29 01:00Z', 'direct');
INSERT INTO public.job_documents (id, job_id, type, quote_number, version, created_at, sent_at)
VALUES ('d0000000-0000-4000-8000-000000000004', 'a0000000-0000-4000-8000-000000000001', 'quote', 'Q-9004', 1, '2026-10-03 01:00Z', '2026-10-03 01:05Z');
INSERT INTO public.job_assignments (id, job_id, role, scheduled_date, assignment_type, status, crew_name, confirmation_status, is_ghost, created_at)
VALUES ('e0000000-0000-4000-8000-000000000003', 'a0000000-0000-4000-8000-000000000001', 'lead_installer', '2026-10-08', 'install', 'scheduled', 'Crew One', 'confirmed', false, '2026-10-02 01:00Z');
INSERT INTO public.jobs (id, org_id, job_number, status, type, client_email, ghl_contact_id, pricing_json, created_at)
VALUES ('a0000000-0000-4000-8000-000000000004', '00000000-0000-4000-8000-0000000000aa', 'SWF-T0004', 'complete', 'fencing',
        NULL, 'ctA', '{}', '2026-06-01 01:00Z');

INSERT INTO public.context_ledger_generations (id, job_id, kind, status, reader, evidence_until, promoted_at, created_at)
VALUES ('9a000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', 'backfill', 'live', 'luna-ledger:v1',
        '2026-10-05 00:00Z', '2026-10-05 01:00Z', '2026-10-05 00:30Z'),
       ('9a000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000001', 'rebuild', 'shadow', 'luna-ledger:v2',
        '2026-10-06 00:00Z', NULL, '2026-10-06 00:30Z');
INSERT INTO public.context_ledger_items (id, generation_id, job_id, item_key, item_type, status, from_role, from_name, to_role, to_name, what, about_key,
  modality, phase, opened_at, opened_by, closes_on, blocks, needs_reply, written_by)
VALUES
 ('9b000000-0000-4000-8000-000000000001', '9a000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001',
  'request:booking:2026-10-12:aaaaaaaaaaaa', 'request', 'open', 'customer', 'Cust A', 'us', NULL, 'Customer asks whether we can come Monday',
  'booking:2026-10-12', NULL, 'scheduled', '2026-10-01 01:00Z',
  '[{"table":"business_events","id":"b0000000-0000-4000-8000-000000000001","excerpt":"Can you come Monday?"}]', 'reply', 'none', true, 'model:luna-ledger:v1'),
 ('9b000000-0000-4000-8000-000000000002', '9a000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001',
  'claim:invoice:inv-9001:bbbbbbbbbbbb', 'claim', 'open', 'customer', 'Cust A', 'us', NULL, 'Customer says the balance of INV-9001 will be paid next week',
  'invoice:inv-9001', NULL, 'payment', '2026-10-01 01:00Z',
  '[{"table":"business_events","id":"b0000000-0000-4000-8000-000000000001","excerpt":"Can you come Monday?"}]', 'payment', 'none', false, 'model:luna-ledger:v1'),
 ('9b000000-0000-4000-8000-000000000003', '9a000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001',
  'commitment:quote:rest-of-fence:cccccccccccc', 'commitment', 'open', 'us', 'Office', 'customer', 'Cust A', 'Send the quote for the rest of the fence',
  'quote:rest-of-fence', NULL, 'quote', '2026-09-30 01:00Z',
  '[{"table":"business_events","id":"b0000000-0000-4000-8000-000000000006","excerpt":"I will send the quote for the rest of the fence tomorrow"}]', 'quote_sent', 'none', false, 'model:luna-ledger:v1'),
 ('9b000000-0000-4000-8000-000000000004', '9a000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001',
  'issue:defect:side-gate:dddddddddddd', 'issue', 'open', 'customer', 'Cust A', 'us', NULL, 'The side gate sticks',
  'defect:side-gate', NULL, 'rectification', '2026-09-29 01:00Z',
  '[{"table":"business_events","id":"b0000000-0000-4000-8000-000000000007","excerpt":"The side gate sticks"}]', 'work_done', 'none', false, 'model:luna-ledger:v1'),
 ('9b000000-0000-4000-8000-000000000005', '9a000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001',
  'agreement:preference:gate-colour:eeeeeeeeeeee', 'agreement', 'info', 'customer', 'Cust A', 'us', NULL, 'Gate to be painted black',
  'preference:gate-colour', 'agreed', 'quote', '2026-09-30 01:00Z',
  '[{"table":"business_events","id":"b0000000-0000-4000-8000-000000000006","excerpt":"I will send the quote"}]', 'none', 'none', false, 'model:luna-ledger:v1'),
 ('9b000000-0000-4000-8000-000000000006', '9a000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001',
  'phase_note:none:ffffffffffff', 'phase_note', 'info', 'us', NULL, NULL, NULL, 'Quote revised after the customer asked for a lower fence',
  NULL, NULL, 'quote', '2026-09-30 01:00Z',
  '[{"table":"business_events","id":"b0000000-0000-4000-8000-000000000006","excerpt":"I will send"}]', 'none', 'none', false, 'model:luna-ledger:v1'),
 ('9b000000-0000-4000-8000-000000000008', '9a000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001',
  'commitment:quote:q-9004:999999999999', 'commitment', 'open', 'us', 'Office', 'customer', 'Cust A', 'Send quote Q-9004',
  'quote:q-9004', NULL, 'quote', '2026-09-30 01:00Z',
  '[{"table":"business_events","id":"b0000000-0000-4000-8000-000000000006","excerpt":"I will send the quote"}]', 'quote_sent', 'none', false, 'model:luna-ledger:v1'),
 ('9b000000-0000-4000-8000-000000000007', '9a000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000001',
  'phase_note:none:111111111111', 'phase_note', 'info', 'us', NULL, NULL, NULL, 'Shadow reading note',
  NULL, NULL, 'quote', '2026-09-30 01:00Z',
  '[{"table":"business_events","id":"b0000000-0000-4000-8000-000000000006","excerpt":"I will send"}]', 'none', 'none', false, 'model:luna-ledger:v2');
INSERT INTO public.context_ledger_transitions (item_id, generation_id, job_id, from_status, to_status, at, by, reason)
VALUES ('9b000000-0000-4000-8000-000000000001', '9a000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001',
        NULL, 'open', '2026-10-05 01:00Z', 'model:luna-ledger:v1', 'Opened from the customer text');

-- Job D: a live reading up to 3 Oct. The customer's first text landed before it; a
-- second text written on 2 Oct landed only on 4 Oct (captured late), with a copy one
-- minute later. The reader has read one message and not the second; the copy is the
-- same message. Admissible evidence rows (the store's definition), every time fixed.
INSERT INTO public.jobs (id, org_id, job_number, status, type, client_email, ghl_contact_id, pricing_json, created_at)
VALUES ('a0000000-0000-4000-8000-000000000005', '00000000-0000-4000-8000-0000000000aa', 'SWF-T0005', 'accepted', 'fencing',
        NULL, 'ctD', '{}', '2026-09-01 01:00Z');
INSERT INTO public.business_events (id, job_id, event_type, source, channel, direction, contact_id, payload, metadata, occurred_at,
  recorded_at, event_at, context_captured_at, attributed_at, attribution_status, attribution_confidence)
VALUES
 ('b0000000-0000-4000-8000-000000000011', 'a0000000-0000-4000-8000-000000000005', 'client.reply', 'ghl', 'sms', 'inbound', 'ctD',
  '{"body":"When will the posts arrive?"}', '{"party_roles":{"counterpart_role":"customer","sender_role":"customer"}}',
  '2026-10-01 01:00Z', '2026-10-01 01:00Z', '2026-10-01 01:00Z', '2026-10-01 01:00Z', '2026-10-01 01:00Z', 'direct', 1),
 ('b0000000-0000-4000-8000-000000000012', 'a0000000-0000-4000-8000-000000000005', 'client.reply', 'ghl', 'sms', 'inbound', 'ctD',
  '{"body":"Any news on the posts?"}', '{"party_roles":{"counterpart_role":"customer","sender_role":"customer"}}',
  '2026-10-02 01:00Z', '2026-10-04 01:00Z', '2026-10-02 01:00Z', '2026-10-04 01:00Z', '2026-10-04 01:00Z', 'direct', 1),
 ('b0000000-0000-4000-8000-000000000013', 'a0000000-0000-4000-8000-000000000005', 'client.reply', 'ghl', 'sms', 'inbound', 'ctD',
  '{"body":"Any news on the posts?"}', '{"party_roles":{"counterpart_role":"customer","sender_role":"customer"}}',
  '2026-10-02 01:01Z', '2026-10-04 01:01Z', '2026-10-02 01:01Z', '2026-10-04 01:01Z', '2026-10-04 01:01Z', 'direct', 1);
INSERT INTO public.context_ledger_generations (id, job_id, kind, status, reader, evidence_until, promoted_at, created_at)
VALUES ('9a000000-0000-4000-8000-000000000005', 'a0000000-0000-4000-8000-000000000005', 'backfill', 'live', 'luna-ledger:v1',
        '2026-10-03 00:00Z', '2026-10-03 01:00Z', '2026-10-03 00:30Z');

DO $story$
DECLARE
 a uuid := 'a0000000-0000-4000-8000-000000000001'; b uuid := 'a0000000-0000-4000-8000-000000000002';
 c uuid := 'a0000000-0000-4000-8000-000000000003'; asof timestamptz := '2026-10-07 02:00Z';
 s jsonb; t jsonb; n integer;
BEGIN
 s := public.context_job_story(a, asof);
 IF s->>'version' <> 'job-story-v1' THEN RAISE EXCEPTION 'story contract: version %', s->>'version'; END IF;
 IF s::text ~ '[—–]' THEN RAISE EXCEPTION 'story contract: em or en dash in the story'; END IF;
 IF length(s->'now'->>'line') > 400 THEN RAISE EXCEPTION 'story contract: now line longer than 400'; END IF;
 -- Perth weekday matches the date
 IF s->'now'->'next'->>'day' <> 'Thu 8 Oct' OR position('booked Thu 8 Oct' IN s->'now'->>'line') = 0 THEN
  RAISE EXCEPTION 'story contract: next visit day wrong: % / %', s->'now'->'next'->>'day', s->'now'->>'line';
 END IF;
 IF s->'now'->>'phase' <> 'scheduled' OR s->'now'->>'whose_move' <> 'us' THEN
  RAISE EXCEPTION 'story contract: phase or whose move wrong: % %', s->'now'->>'phase', s->'now'->>'whose_move';
 END IF;
 -- R5 promoted by the ledger request that cites it, ranked first, and the request is not listed twice
 t := s->'loops'->0;
 IF t->>'key' <> 'R5_customer_wrote_last:b0000000-0000-4000-8000-000000000001' OR position('come Monday' IN t->>'why') = 0 THEN
  RAISE EXCEPTION 'story contract: R5 must be promoted to the top loop by the ledger request: %', t;
 END IF;
 -- every loop names its object, so a reader can attach its items to it
 IF t->>'about_key' IS DISTINCT FROM 'contact:customer-reply'
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(s->'loops') l WHERE NOT l ? 'about_key')
    OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(s->'loops') l WHERE l->>'key' LIKE 'R1_overdue:%' AND l->>'about_key' = 'invoice:inv-9001')
    OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(s->'loops') l WHERE l->>'source' = 'ledger' AND l->>'about_key' = 'quote:rest-of-fence') THEN
  RAISE EXCEPTION 'story contract: loops must carry about_key: %', s->'loops';
 END IF;
 SELECT count(*) INTO n FROM jsonb_array_elements(s->'loops') l WHERE l->>'key' LIKE 'request:%' OR l->>'key' LIKE 'claim:%';
 IF n <> 0 THEN RAISE EXCEPTION 'story contract: a ledger item about a record loop''s object was listed twice'; END IF;
 SELECT count(*) INTO n FROM jsonb_array_elements(s->'loops') l WHERE l->>'key' LIKE 'R1_overdue:%' AND position('paid next week' IN l->>'why') > 0;
 IF n <> 1 THEN RAISE EXCEPTION 'story contract: the invoice claim must attach to the overdue loop by about_key'; END IF;
 -- closing evidence is shown, never a closure, and only for the exact object: the
 -- quote Q-9004 sent after the promise closes the promise about quote:q-9004, never
 -- the one about the not-yet-numbered quote:rest-of-fence
 SELECT l INTO t FROM jsonb_array_elements(s->'loops') l WHERE l->>'key' LIKE 'commitment:quote:q-9004:%';
 IF t->>'status' <> 'closing_evidence' OR t->'closing_evidence'->0->>'id' <> 'd0000000-0000-4000-8000-000000000004' THEN
  RAISE EXCEPTION 'story contract: quote sent after the promise must show as closing evidence: %', t;
 END IF;
 SELECT l INTO t FROM jsonb_array_elements(s->'loops') l WHERE l->>'key' LIKE 'commitment:quote:rest-of-fence:%';
 IF t->>'status' <> 'open' OR t->'closing_evidence' <> 'null'::jsonb THEN
  RAISE EXCEPTION 'story contract: a slug must never match another quote by prefix: %', t;
 END IF;
 -- the item citing a row that moved to another job is hidden, counted and named
 IF (s->'meta'->'ledger'->>'hidden_items')::int <> 1 OR NOT (s->'meta'->'ledger'->>'stale')::boolean
    OR s::text LIKE '%side gate%' THEN
  RAISE EXCEPTION 'story contract: stale citation must hide the item: %', s->'meta'->'ledger';
 END IF;
 SELECT count(*) INTO n FROM jsonb_array_elements(s->'not_known') k WHERE k->>'what' LIKE '%needs a rebuild%';
 IF n <> 1 THEN RAISE EXCEPTION 'story contract: not_known must say the story needs a rebuild'; END IF;
 -- job A's messages are not ledger evidence (no attribution confidence), so its reader has nothing unread:
 -- stale only because it needs a rebuild
 IF (s->'meta'->'ledger'->>'unread_rows')::int IS DISTINCT FROM 0 OR NOT (s->'meta'->'ledger'->>'needs_rebuild')::boolean
    OR s->'meta' ? 'unread_rows' THEN
  RAISE EXCEPTION 'story contract: job A ledger freshness wrong: %', s->'meta'->'ledger';
 END IF;
 SELECT count(*) INTO n FROM jsonb_array_elements(s->'not_known') k WHERE k->>'what' LIKE '%not been read by the reader yet.';
 IF n <> 0 THEN RAISE EXCEPTION 'story contract: nothing is unread on job A: %', s->'not_known'; END IF;
 SELECT count(*) INTO n FROM jsonb_array_elements(s->'not_known') k WHERE k->>'what' = 'Phone calls that were not recorded are not here.';
 IF n <> 1 THEN RAISE EXCEPTION 'story contract: not_known must always name unrecorded calls'; END IF;
 -- what we told the customer is never a crew alert or an automated text
 IF s->'last_exchange'->'we_told_customer'->>'id' <> 'b0000000-0000-4000-8000-000000000006'
    OR s->'last_exchange'->'internal'->>'id' <> 'b0000000-0000-4000-8000-000000000003' THEN
  RAISE EXCEPTION 'story contract: last exchange wrong: %', s->'last_exchange';
 END IF;
 -- money per party, credit and overpayment
 IF jsonb_array_length(s->'money'->'parties') <> 2 OR position('credited $100.00' IN s->'money'->>'line') = 0
    OR (s->'money'->'not_yet_invoiced'->>'amount')::numeric <> 8900 THEN
  RAISE EXCEPTION 'story contract: money wrong: %', s->'money'->>'line';
 END IF;
 IF jsonb_array_length(s->'agreements') <> 1 OR jsonb_array_length(s->'phase_notes') <> 1
    OR (s->'handling'->'commitments'->>'open')::int <> 2 THEN
  RAISE EXCEPTION 'story contract: agreements, phase notes or commitments wrong';
 END IF;
 IF s->'changes' <> 'null'::jsonb THEN RAISE EXCEPTION 'story contract: changes must be null without p_since'; END IF;
 SELECT count(*) INTO n FROM jsonb_array_elements(s->'timeline') x WHERE x->>'kind' = 'booking_mirror';
 IF n <> 0 THEN RAISE EXCEPTION 'story contract: observer mirrors do not belong in the story timeline'; END IF;

 -- the records alone (for the reader's own prompt): no ledger anywhere, so R5 waits as a check
 s := public.context_job_story(a, asof, NULL, NULL, true);
 IF s->'meta'->'ledger'->>'status' <> 'none' OR (s->'meta'->'ledger'->>'items')::int <> 0
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(s->'loops') l WHERE l->>'source' IN ('ledger', 'person'))
    OR jsonb_array_length(s->'agreements') <> 0 OR jsonb_array_length(s->'phase_notes') <> 0 OR jsonb_array_length(s->'events') <> 0
    OR s::text LIKE '%paid next week%' OR s::text LIKE '%painted black%' OR s::text LIKE '%Shadow reading note%'
    OR s::text LIKE '%Send the quote for the rest%' OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(s->'checks') k WHERE k->>'rule' = 'R5_customer_wrote_last') THEN
  RAISE EXCEPTION 'story contract: record_only must carry no ledger: % / %', s->'meta'->'ledger', s->'loops';
 END IF;

 -- a shadow generation asked for by id: R5 is demoted because the reader saw it and wrote no request
 s := public.context_job_story(a, asof, '9a000000-0000-4000-8000-000000000002');
 IF s->'meta'->'ledger'->>'status' <> 'shadow' OR s->'phase_notes'->0->>'what' <> 'Shadow reading note' THEN
  RAISE EXCEPTION 'story contract: p_generation_id must show that generation: %', s->'meta'->'ledger';
 END IF;
 SELECT count(*) INTO n FROM jsonb_array_elements(s->'loops') l WHERE l->>'key' LIKE 'R5_%';
 IF n <> 0 THEN RAISE EXCEPTION 'story contract: R5 must stay a candidate without a reply-owed item'; END IF;
 SELECT count(*) INTO n FROM jsonb_array_elements(s->'checks') k
 WHERE k->>'rule' = 'R5_customer_wrote_last' AND k->>'what' LIKE 'Customer wrote last; the reader judged no reply is needed.%';
 IF n <> 1 THEN RAISE EXCEPTION 'story contract: demoted R5 must say the reader judged no reply needed: %', s->'checks'; END IF;

 -- changes since an instant: the ledger transition after it
 s := public.context_job_story(a, asof, NULL, '2026-10-04 12:00Z');
 SELECT count(*) INTO n FROM jsonb_array_elements(s->'changes') x WHERE x->>'kind' = 'ledger_open';
 IF n <> 1 THEN RAISE EXCEPTION 'story contract: changes must carry the ledger transition: %', s->'changes'; END IF;
 SELECT count(*) INTO n FROM jsonb_array_elements(s->'changes') x WHERE (x->>'at')::timestamptz <= '2026-10-04 12:00Z';
 IF n <> 0 THEN RAISE EXCEPTION 'story contract: changes before p_since leaked'; END IF;

 -- no ledger at all: say so; the make-safe whose pack went out reads complete
 s := public.context_job_story(b, asof);
 IF s->'meta'->'ledger'->>'status' <> 'none' OR s->'now'->>'phase' <> 'complete' OR s->'now'->>'phase_since' <> '2026-10-03' THEN
  RAISE EXCEPTION 'story contract: job B ledger or phase wrong: % % %', s->'meta'->'ledger'->>'status', s->'now'->>'phase', s->'now'->>'phase_since';
 END IF;
 SELECT count(*) INTO n FROM jsonb_array_elements(s->'not_known') k WHERE k->>'what' LIKE 'No reader has read this job%';
 IF n <> 1 THEN RAISE EXCEPTION 'story contract: a job with no ledger must say the words are not read'; END IF;
 SELECT count(*) INTO n FROM jsonb_array_elements(s->'checks') k WHERE k->>'rule' = 'C1_status_lags_work';
 IF n <> 1 THEN RAISE EXCEPTION 'story contract: status lag check missing on job B'; END IF;
 s := public.context_job_story(c, asof);
 SELECT count(*) INTO n FROM jsonb_array_elements(s->'checks') k
 WHERE k->>'rule' = 'C11_customer_mail_unanswered' AND k->>'what' LIKE 'Customer wrote last; not yet read by the reader.%';
 IF n <> 1 THEN RAISE EXCEPTION 'story contract: unread candidate must say not yet read: %', s->'checks'; END IF;
 IF public.context_job_story(gen_random_uuid(), asof) IS NOT NULL THEN RAISE EXCEPTION 'story contract: unknown job must give NULL'; END IF;

 -- Ledger freshness is the reader's own: one message landed after the live reading
 -- (its copy listed, not counted), so the story is stale without needing a rebuild,
 -- says so, and does not claim the reader judged the late message.
 s := public.context_job_story('a0000000-0000-4000-8000-000000000005', asof);
 IF (s->'meta'->'ledger'->>'unread_rows')::int IS DISTINCT FROM 1 OR NOT (s->'meta'->'ledger'->>'stale')::boolean
    OR (s->'meta'->'ledger'->>'needs_rebuild')::boolean OR (s->'meta'->'ledger'->>'hidden_items')::int <> 0
    OR s->'meta'->'ledger'->>'evidence_until' IS NULL OR s->'meta' ? 'unread_rows' THEN
  RAISE EXCEPTION 'story contract: job D ledger freshness wrong: %', s->'meta'->'ledger';
 END IF;
 SELECT count(*) INTO n FROM jsonb_array_elements(s->'not_known') k
 WHERE k->>'what' = '1 newer message on this job has not been read by the reader yet.';
 IF n <> 1 THEN RAISE EXCEPTION 'story contract: not_known must name the unread message: %', s->'not_known'; END IF;
 SELECT count(*) INTO n FROM jsonb_array_elements(s->'checks') k
 WHERE k->>'rule' = 'R5_customer_wrote_last' AND k->>'what' LIKE 'Customer wrote last; not yet read by the reader.%';
 IF n <> 1 THEN RAISE EXCEPTION 'story contract: a message the reader has not read is never judged by it: %', s->'checks'; END IF;
 t := public.context_job_story_ledger('a0000000-0000-4000-8000-000000000005', NULL, asof);
 IF t->'unread_ids' <> '["b0000000-0000-4000-8000-000000000012", "b0000000-0000-4000-8000-000000000013"]'::jsonb THEN
  RAISE EXCEPTION 'story contract: unread ids wrong: %', t->'unread_ids';
 END IF;
 -- Replayed before the late message landed: nothing unread, not stale, and the
 -- message the reader did read is judged by it.
 s := public.context_job_story('a0000000-0000-4000-8000-000000000005', '2026-10-03 12:00Z');
 IF (s->'meta'->'ledger'->>'unread_rows')::int IS DISTINCT FROM 0 OR (s->'meta'->'ledger'->>'stale')::boolean THEN
  RAISE EXCEPTION 'story contract: job D before the late message wrong: %', s->'meta'->'ledger';
 END IF;
 SELECT count(*) INTO n FROM jsonb_array_elements(s->'checks') k
 WHERE k->>'rule' = 'R5_customer_wrote_last' AND k->>'what' LIKE 'Customer wrote last; the reader judged no reply is needed.%';
 IF n <> 1 THEN RAISE EXCEPTION 'story contract: a message the reader read is judged by it: %', s->'checks'; END IF;
 -- No generation shown: no unread count at all (not zero), and the reader is never asked.
 t := public.context_job_story_ledger(b, NULL, asof);
 IF t->'unread_rows' <> 'null'::jsonb OR t->'unread_ids' <> 'null'::jsonb OR t->'generation' <> 'null'::jsonb THEN
  RAISE EXCEPTION 'story contract: no generation must give no unread count: %', t;
 END IF;

 -- the client story: both jobs of the CRM contact, the standing preference, money across jobs
 s := public.context_client_story(a, asof);
 IF s->'identity'->>'basis' <> 'ghl_contact_id' OR jsonb_array_length(s->'jobs') <> 2 OR jsonb_array_length(s->'preferences') <> 1
    OR (s->'money'->>'owing')::numeric <> 800 THEN
  RAISE EXCEPTION 'story contract: client story wrong: % jobs, % preferences, owing %', jsonb_array_length(s->'jobs'),
   jsonb_array_length(s->'preferences'), s->'money'->>'owing';
 END IF;
 s := public.context_client_story(b, asof);
 SELECT count(*) INTO n FROM jsonb_array_elements(s->'not_known') k WHERE k->>'what' LIKE 'This job has no CRM contact and no client email%';
 IF n <> 1 THEN RAISE EXCEPTION 'story contract: a job with no identity must say so'; END IF;

 -- scorecard shape
 s := public.context_story_scorecard(asof);
 IF jsonb_array_length(s->'rows') <> 14 THEN RAISE EXCEPTION 'story contract: scorecard needs rows 1 to 14'; END IF;
 s := public.context_story_scorecard_jobs(NULL, 2);
 IF jsonb_array_length(s->'jobs') <> 2 OR s->>'next' IS NULL THEN RAISE EXCEPTION 'story contract: scorecard jobs paging wrong: %', s; END IF;
 IF EXISTS (SELECT 1 FROM jsonb_array_elements(s->'jobs') x WHERE jsonb_typeof(x->'ledger_needs_person') <> 'boolean') THEN
  RAISE EXCEPTION 'story contract: scorecard job rows must say whether the ledger needs a person: %', s;
 END IF;
END $story$;
ROLLBACK;
