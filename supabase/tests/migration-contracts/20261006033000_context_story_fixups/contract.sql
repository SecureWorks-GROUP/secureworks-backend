-- Contract for 20261006033000_context_story_fixups: the story fixes after 972.
--  1. One sort order: every text sort and tiebreak the story outputs is in C (byte)
--     order, so the same story reads the same on every server (production, CI and
--     the reader sort text three different ways).
--  2. C6 names the booked days in date order, each once.
--  2b. R3 lists the other invoices on the draft's reference in C order.
--  3. R7 reads a quote whose every email bounced or failed (never viewed) as not
--     received and our move, never as waiting on the customer's answer; its
--     closes_when says when not received ends, then when the loop closes.
--  4. The app events the ledger store lets close a matter are timeline lines that
--     cite job_events, each with its event_type as its state (not_delivered for a
--     document nobody received), one line per event type, matter and Perth day; a
--     folded clock-off line gives the day's net hours, every stint added.
-- Each section fails on the 972 bodies (sections 1 and 2b on any server whose
-- default collation is not C, like CI's and production's). Every fixture row is
-- synthetic and rolled back; user triggers are off for it.

-- 0. Shape and access: the same five functions, flags and grants, each comment
-- keeping its slice name first.
DO $shape$
DECLARE x record; p record;
BEGIN
 -- (a later slice that replaces a body names itself after these: story safety, 20261006040000)
 FOR x IN SELECT * FROM (VALUES
   ('public.context_job_record_timeline(uuid[],timestamptz)', true, 'Job record (20261006011000), story fixes (20261006033000)%'),
   ('public.context_job_record_loops(uuid[],timestamptz)', true, 'Job record (20261006011000), story fixes (20261006033000)%'),
   ('public.context_job_story_assemble(jsonb,jsonb,jsonb,jsonb,timestamptz,timestamptz)', false, 'Job story (20261006014000), story fixes (20261006033000)%'),
   ('public.context_job_story_ledger(uuid,uuid,timestamptz)', true, 'Job story (20261006014000), story fixes (20261006033000)%'),
   ('public.context_client_story(uuid,timestamptz)', true, 'Job story (20261006014000), story fixes (20261006033000)%')
 ) v(sig, definer, cmt) LOOP
  SELECT pr.prosecdef, pr.provolatile, pr.proconfig INTO p FROM pg_proc pr WHERE pr.oid = to_regprocedure(x.sig);
  IF p IS NULL THEN RAISE EXCEPTION 'story fixes contract: % missing', x.sig; END IF;
  IF p.prosecdef IS DISTINCT FROM x.definer OR p.provolatile <> 's'
     OR (x.definer AND NOT ('search_path=public, pg_temp' = ANY (p.proconfig))) OR (NOT x.definer AND p.proconfig IS NOT NULL) THEN
   RAISE EXCEPTION 'story fixes contract: % flags changed', x.sig;
  END IF;
  IF has_function_privilege('anon', x.sig, 'EXECUTE') OR has_function_privilege('authenticated', x.sig, 'EXECUTE')
     OR NOT has_function_privilege('service_role', x.sig, 'EXECUTE') THEN
   RAISE EXCEPTION 'story fixes contract: % access wrong', x.sig;
  END IF;
  IF coalesce(obj_description(to_regprocedure(x.sig), 'pg_proc'), '') NOT LIKE x.cmt THEN
   RAISE EXCEPTION 'story fixes contract: % comment must keep its slice name first and name the story fixes', x.sig;
  END IF;
 END LOOP;
END $shape$;

-- 1a. One sort order, on the pure assembler. Two paying parties owe the same, two
-- other parties, two customer loops opened at the same instant, two events and
-- two phase notes read from one message, and both "not placed" lines of not_known:
-- each list in C (byte) order. A server sorting in its own language order put
-- "acme" before "Builders", "commitment" before "R7_...", "...:ab:..." before
-- "...:a-b:..." and "12 emails" before "1 message".
DO $sort$
DECLARE s jsonb; s2 jsonb; rec jsonb; led jsonb; tl jsonb;
 job constant jsonb := '{"id":"x","status":"quoted","type":"fencing","created_at":"2026-09-01T00:00:00Z"}';
BEGIN
 rec := '{"money":[
    {"party":"acme fencing","xero_contact_id":"xa","invoiced":500,"paid":500,"credited":0,"owing":0,"overdue":0,"drafts":0,"draft_total":0,"invoices":[{"id":"i-a"}]},
    {"party":"Builders WA","xero_contact_id":"xb","invoiced":700,"paid":700,"credited":0,"owing":0,"overdue":0,"drafts":0,"draft_total":0,"invoices":[{"id":"i-b"}]}],
   "facts":{"parties":[{"id":"p1","name":"alice","role":"neighbour"},{"id":"p2","name":"Bob","role":"neighbour"}]},
   "loops":[{"rule":"R7_quote_waiting","loop_key":"R7_quote_waiting:d1","shown_as":"loop","owner":"customer","counterparty":"us",
             "what":"Quote Q-9 sent and not answered","opened_at":"2026-09-25T01:00:00Z","about_key":"quote:q-9",
             "source_table":"job_documents","source_id":"d1"}]}';
 led := '{"status":"live","generation":{"id":"g1","evidence_until":"2026-10-05T00:00:00Z"},"unread_rows":0,"unread_ids":[],"read_ids":[],
   "transitions":[],"items":[
    {"item_key":"commitment:quote:q-77:aaaaaaaaaaaa","item_type":"commitment","status":"open","from_role":"customer","to_role":"us",
     "what":"Customer will decide on quote Q-77","about_key":"quote:q-77","closes_on":"reply","opened_at":"2026-09-25T01:00:00Z",
     "cites_ok":true,"opened_by":[{"table":"business_events","id":"e1"}]},
    {"item_key":"event:quote:ab:000000000000","item_type":"event","status":"info","from_role":"us","what":"Gate AB measured",
     "opened_at":"2026-09-26T01:00:00Z","cites_ok":true,"opened_by":[{"table":"business_events","id":"e2"}]},
    {"item_key":"event:quote:a-b:000000000001","item_type":"event","status":"info","from_role":"us","what":"Gate A-B measured",
     "opened_at":"2026-09-26T01:00:00Z","cites_ok":true,"opened_by":[{"table":"business_events","id":"e2"}]},
    {"item_key":"phase_note:quote:ab:000000000002","item_type":"phase_note","status":"info","phase":"quote","from_role":"us",
     "what":"Note AB","opened_at":"2026-09-26T01:00:00Z","cites_ok":true,"opened_by":[{"table":"business_events","id":"e2"}]},
    {"item_key":"phase_note:quote:a-b:000000000003","item_type":"phase_note","status":"info","phase":"quote","from_role":"us",
     "what":"Note A-B","opened_at":"2026-09-26T01:00:00Z","cites_ok":true,"opened_by":[{"table":"business_events","id":"e2"}]}]}';
 s := public.context_job_story_assemble(job, rec, led, '{"unplaced":{"count":1},"withheld_mail":{"count":12}}', '2026-10-07 02:00Z', NULL);
 IF (SELECT array_agg(p ->> 'party' ORDER BY o) FROM jsonb_array_elements(s -> 'money' -> 'parties') WITH ORDINALITY x(p, o))
    IS DISTINCT FROM ARRAY['Builders WA', 'acme fencing'] THEN
  RAISE EXCEPTION 'story fixes contract: paying parties owing the same must sort in C order: %', s -> 'money' -> 'parties';
 END IF;
 IF (SELECT array_agg(w ->> 'name' ORDER BY o) FROM jsonb_array_elements(s -> 'who') WITH ORDINALITY x(w, o))
    IS DISTINCT FROM ARRAY['Builders WA', 'acme fencing', 'Bob', 'alice'] THEN
  RAISE EXCEPTION 'story fixes contract: who must sort by kind, then name in C order: %', s -> 'who';
 END IF;
 IF (SELECT array_agg(l ->> 'key' ORDER BY o) FROM jsonb_array_elements(s -> 'loops') WITH ORDINALITY x(l, o))
    IS DISTINCT FROM ARRAY['R7_quote_waiting:d1', 'commitment:quote:q-77:aaaaaaaaaaaa']
    OR (s -> 'loops' -> 0 ->> 'rank')::int <> 1 OR s -> 'now' -> 'next' ->> 'what' <> 'Quote Q-9 sent and not answered' THEN
  RAISE EXCEPTION 'story fixes contract: loops tied on kind and time must rank by key in C order: %', s -> 'loops';
 END IF;
 IF (SELECT array_agg(e ->> 'key' ORDER BY o) FROM jsonb_array_elements(s -> 'events') WITH ORDINALITY x(e, o))
    IS DISTINCT FROM ARRAY['event:quote:a-b:000000000001', 'event:quote:ab:000000000000']
    OR (SELECT array_agg(n ->> 'what' ORDER BY o) FROM jsonb_array_elements(s -> 'phase_notes') WITH ORDINALITY x(n, o))
       IS DISTINCT FROM ARRAY['Note A-B', 'Note AB'] THEN
  RAISE EXCEPTION 'story fixes contract: items read from one message must sort by item key in C order: % / %', s -> 'events', s -> 'phase_notes';
 END IF;
 IF (SELECT array_agg(left(k ->> 'what', 9) ORDER BY o) FROM jsonb_array_elements(s -> 'not_known') WITH ORDINALITY x(k, o)
     WHERE k ->> 'what' LIKE '%from this customer%') IS DISTINCT FROM ARRAY['1 message', '12 emails'] THEN
  RAISE EXCEPTION 'story fixes contract: not_known lines of one kind must sort in C order: %', s -> 'not_known';
 END IF;
 -- The output never depends on the order the record parts came in: two payments of
 -- one invoice on one day, given either way round, read the same in the timeline and
 -- in what changed.
 tl := '[{"at":"2026-10-01T00:00:00Z","perth_date":"2026-10-01","time_basis":"date_only","kind":"payment","what":"Payment $200.00 received on INV-1 (acme fencing)","amount":200,"source_table":"xero_invoices","source_id":"i-a"},
         {"at":"2026-10-01T00:00:00Z","perth_date":"2026-10-01","time_basis":"date_only","kind":"payment","what":"Payment $100.00 received on INV-1 (acme fencing)","amount":100,"source_table":"xero_invoices","source_id":"i-a"}]';
 s := public.context_job_story_assemble(job, rec || jsonb_build_object('timeline', tl), led, NULL, '2026-10-07 02:00Z', '2026-09-30 00:00Z');
 s2 := public.context_job_story_assemble(job, rec || jsonb_build_object('timeline', (SELECT jsonb_agg(e ORDER BY o DESC)
         FROM jsonb_array_elements(tl) WITH ORDINALITY x(e, o))), led, NULL, '2026-10-07 02:00Z', '2026-09-30 00:00Z');
 IF s -> 'timeline' IS DISTINCT FROM s2 -> 'timeline' OR s -> 'changes' IS DISTINCT FROM s2 -> 'changes'
    OR s -> 'timeline' -> 0 ->> 'what' NOT LIKE 'Payment $100.00%' THEN
  RAISE EXCEPTION 'story fixes contract: the timeline and changes must not depend on input order: % / %', s -> 'timeline', s2 -> 'timeline';
 END IF;
END $sort$;

-- 1b. One sort order in what reads tables: the client story's paying parties (two
-- jobs of one CRM contact, two payers owing nothing) and the ledger read's items
-- (two events of one live reading, read from one message).
BEGIN;
SET LOCAL session_replication_role = replica;
INSERT INTO public.jobs (id, org_id, job_number, status, type, client_email, ghl_contact_id, pricing_json, created_at)
VALUES ('33000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000aa', 'SWF-T3301', 'accepted', 'fencing',
        NULL, 'ct33a', '{}', '2026-09-01 01:00Z'),
       ('33000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-0000000000aa', 'SWF-T3302', 'accepted', 'fencing',
        NULL, 'ct33a', '{}', '2026-09-15 01:00Z');
INSERT INTO public.xero_invoices (org_id, id, job_id, xero_invoice_id, xero_contact_id, contact_name, invoice_number, invoice_type, status,
  total, amount_due, amount_paid, invoice_date, due_date, raw_json, created_at)
VALUES ('00000000-0000-4000-8000-0000000000aa', '33a00000-0000-4000-8000-000000000001', '33000000-0000-4000-8000-000000000001', 'x3301',
        'x33a', 'acme fencing', 'INV-3301', 'ACCREC', 'PAID', 500, 0, 500, '2026-09-10', '2026-09-24',
        '{"Status":"PAID","Payments":[],"AmountCredited":0}', '2026-09-10 01:00Z'),
       ('00000000-0000-4000-8000-0000000000aa', '33a00000-0000-4000-8000-000000000002', '33000000-0000-4000-8000-000000000002', 'x3302',
        'x33b', 'Builders WA', 'INV-3302', 'ACCREC', 'PAID', 700, 0, 700, '2026-09-20', '2026-10-04',
        '{"Status":"PAID","Payments":[],"AmountCredited":0}', '2026-09-20 01:00Z');
INSERT INTO public.business_events (id, job_id, event_type, source, channel, direction, contact_id, payload, metadata, occurred_at, recorded_at, event_at, attribution_status)
VALUES ('33b00000-0000-4000-8000-000000000001', '33000000-0000-4000-8000-000000000001', 'client.sms_out', 'ghl', 'sms', 'outbound', 'ct33a',
        '{"body":"We measured both gates today"}', '{"party_roles":{"counterpart_role":"customer","sender_role":"staff"}}',
        '2026-10-01 01:00Z', '2026-10-01 01:00Z', '2026-10-01 01:00Z', 'direct');
INSERT INTO public.context_ledger_generations (id, job_id, kind, status, reader, evidence_until, promoted_at, created_at)
VALUES ('33900000-0000-4000-8000-000000000001', '33000000-0000-4000-8000-000000000001', 'backfill', 'live', 'luna-ledger:v1',
        '2026-10-05 00:00Z', '2026-10-05 01:00Z', '2026-10-05 00:30Z');
INSERT INTO public.context_ledger_items (id, generation_id, job_id, item_key, item_type, status, from_role, to_role, what, about_key,
  phase, opened_at, opened_by, closes_on, blocks, needs_reply, written_by, created_at)
VALUES ('33910000-0000-4000-8000-000000000001', '33900000-0000-4000-8000-000000000001', '33000000-0000-4000-8000-000000000001',
        'event:quote:ab:000000000000', 'event', 'info', 'us', NULL, 'Gate AB measured', 'quote:ab', 'quote', '2026-10-01 01:00Z',
        '[{"table":"business_events","id":"33b00000-0000-4000-8000-000000000001","excerpt":"We measured both gates today"}]',
        'none', 'none', false, 'model:luna-ledger:v1', '2026-10-05 00:30Z'),
       ('33910000-0000-4000-8000-000000000002', '33900000-0000-4000-8000-000000000001', '33000000-0000-4000-8000-000000000001',
        'event:quote:a-b:000000000001', 'event', 'info', 'us', NULL, 'Gate A-B measured', 'quote:a-b', 'quote', '2026-10-01 01:00Z',
        '[{"table":"business_events","id":"33b00000-0000-4000-8000-000000000001","excerpt":"We measured both gates today"}]',
        'none', 'none', false, 'model:luna-ledger:v1', '2026-10-05 00:30Z');
DO $sortdb$
DECLARE s jsonb; t jsonb;
BEGIN
 s := public.context_client_story('33000000-0000-4000-8000-000000000001', '2026-10-07 02:00Z');
 IF s -> 'money' -> 'parties' IS DISTINCT FROM '["Builders WA", "acme fencing"]'::jsonb
    OR (SELECT array_agg(p ->> 'party' ORDER BY o) FROM jsonb_array_elements(s -> 'money' -> 'by_party') WITH ORDINALITY x(p, o))
       IS DISTINCT FROM ARRAY['Builders WA', 'acme fencing'] THEN
  RAISE EXCEPTION 'story fixes contract: the client story''s paying parties must sort in C order: %', s -> 'money';
 END IF;
 t := public.context_job_story_ledger('33000000-0000-4000-8000-000000000001', NULL, '2026-10-07 02:00Z');
 IF (SELECT array_agg(i ->> 'item_key' ORDER BY o) FROM jsonb_array_elements(t -> 'items') WITH ORDINALITY x(i, o))
    IS DISTINCT FROM ARRAY['event:quote:a-b:000000000001', 'event:quote:ab:000000000000'] THEN
  RAISE EXCEPTION 'story fixes contract: the ledger read''s items opened together must sort by item key in C order: %', t -> 'items';
 END IF;
 s := public.context_job_story('33000000-0000-4000-8000-000000000001', '2026-10-07 02:00Z');
 IF (SELECT array_agg(e ->> 'what' ORDER BY o) FROM jsonb_array_elements(s -> 'events') WITH ORDINALITY x(e, o))
    IS DISTINCT FROM ARRAY['Gate A-B measured', 'Gate AB measured'] THEN
  RAISE EXCEPTION 'story fixes contract: the story''s events must keep that order: %', s -> 'events';
 END IF;
END $sortdb$;
ROLLBACK;

-- 2. C6 names the booked days in date order, each once: two crews on Mon 12 Oct
-- and one on Fri 16 Oct were "Fri 16 Oct, Mon 12 Oct" (the order of the words).
BEGIN;
SET LOCAL session_replication_role = replica;
INSERT INTO public.jobs (id, org_id, job_number, status, type, client_email, ghl_contact_id, pricing_json, created_at)
VALUES ('33000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-0000000000aa', 'SWF-T3303', 'scheduled', 'fencing',
        NULL, 'ct33c', '{}', '2026-09-01 01:00Z');
INSERT INTO public.job_assignments (id, job_id, role, scheduled_date, assignment_type, status, crew_name, is_ghost, created_at)
VALUES ('33e00000-0000-4000-8000-000000000031', '33000000-0000-4000-8000-000000000003', 'lead_installer', '2026-10-16', 'install', 'scheduled',
        'Crew A', false, '2026-10-02 01:00Z'),
       ('33e00000-0000-4000-8000-000000000032', '33000000-0000-4000-8000-000000000003', 'lead_installer', '2026-10-12', 'install', 'scheduled',
        'Crew A', false, '2026-10-02 01:00Z'),
       ('33e00000-0000-4000-8000-000000000033', '33000000-0000-4000-8000-000000000003', 'installer', '2026-10-12', 'install', 'scheduled',
        'Crew B', false, '2026-10-02 01:00Z');
INSERT INTO public.business_events (id, job_id, event_type, source, channel, direction, contact_id, payload, metadata, occurred_at, recorded_at, event_at, attribution_status)
VALUES ('33b00000-0000-4000-8000-000000000031', '33000000-0000-4000-8000-000000000003', 'client.reply', 'ghl', 'sms', 'inbound', 'ct33c',
        '{"body":"Can the posts go in first?"}', '{"party_roles":{"counterpart_role":"customer","sender_role":"customer"}}',
        '2026-10-05 01:00Z', '2026-10-05 01:00Z', '2026-10-05 01:00Z', 'direct');
DO $c6$
DECLARE got text;
BEGIN
 SELECT l.what INTO got FROM public.context_job_record_loops(ARRAY['33000000-0000-4000-8000-000000000003'::uuid], '2026-10-07 02:00Z') l
 WHERE l.rule = 'C6_booking_after_customer_word';
 IF got IS NULL OR got NOT LIKE 'Booked Mon 12 Oct, Fri 16 Oct; the customer wrote Mon 5 Oct 09:00 after it was made%' THEN
  RAISE EXCEPTION 'story fixes contract: C6 must name the booked days in date order, each once: %', got;
 END IF;
END $c6$;
ROLLBACK;

-- 2b. R3 names the other invoices on the draft's reference in C (byte) order: two
-- whose numbers differ only in case read "INV-4 ..., inv-3 ..." on every server (a
-- server sorting in its own language order put "inv-3" first).
BEGIN;
SET LOCAL session_replication_role = replica;
INSERT INTO public.jobs (id, org_id, job_number, status, type, client_email, ghl_contact_id, pricing_json, created_at)
VALUES ('33000000-0000-4000-8000-000000000009', '00000000-0000-4000-8000-0000000000aa', 'SWF-T3309', 'invoiced', 'fencing',
        NULL, 'ct33r3', '{}', '2026-09-01 01:00Z');
INSERT INTO public.xero_invoices (org_id, id, job_id, xero_invoice_id, xero_contact_id, contact_name, invoice_number, invoice_type, status, reference,
  total, amount_due, amount_paid, invoice_date, due_date, raw_json, created_at)
VALUES ('00000000-0000-4000-8000-0000000000aa', '33a00000-0000-4000-8000-000000000091', '33000000-0000-4000-8000-000000000009', 'x3391',
        'x33r3', 'Payer R3', 'INV-10', 'ACCREC', 'DRAFT', 'SWF-T3309-DEP50', 500, 500, 0, '2026-09-20', '2026-10-04', '{"Status":"DRAFT"}', '2026-09-20 01:00Z'),
       ('00000000-0000-4000-8000-0000000000aa', '33a00000-0000-4000-8000-000000000092', '33000000-0000-4000-8000-000000000009', 'x3392',
        'x33r3', 'Payer R3', 'inv-3', 'ACCREC', 'PAID', 'SWF-T3309-DEP50', 250, 0, 250, '2026-09-21', '2026-10-05', '{"Status":"PAID"}', '2026-09-21 01:00Z'),
       ('00000000-0000-4000-8000-0000000000aa', '33a00000-0000-4000-8000-000000000093', '33000000-0000-4000-8000-000000000009', 'x3393',
        'x33r3', 'Payer R3', 'INV-4', 'ACCREC', 'AUTHORISED', 'SWF-T3309-DEP50', 250, 250, 0, '2026-09-21', '2026-10-05', '{"Status":"AUTHORISED"}', '2026-09-21 01:00Z');
DO $r3$
DECLARE got text;
BEGIN
 SELECT l.what INTO got FROM public.context_job_record_loops(ARRAY['33000000-0000-4000-8000-000000000009'::uuid], '2026-10-07 02:00Z') l
 WHERE l.rule = 'R3_draft';
 IF got IS NULL OR position('(INV-4 authorised, inv-3 paid on the same reference)' IN got) = 0 THEN
  RAISE EXCEPTION 'story fixes contract: R3 must list the same reference''s invoices in C order: %', got;
 END IF;
END $r3$;
ROLLBACK;

-- 3. R7: a quote whose every email bounced or failed, never viewed, was not
-- received. It says so and is our move; a delivered one still waits on the
-- customer's answer; one bounced then delivered later is not received until the
-- delivered email, as of the replay instant.
BEGIN;
SET LOCAL session_replication_role = replica;
INSERT INTO public.jobs (id, org_id, job_number, status, type, client_email, ghl_contact_id, pricing_json, created_at)
VALUES ('33000000-0000-4000-8000-000000000004', '00000000-0000-4000-8000-0000000000aa', 'SWF-T3304', 'quoted', 'fencing',
        'cust.r7@example.test', 'ct33r4', '{}', '2026-09-01 01:00Z'),
       ('33000000-0000-4000-8000-000000000005', '00000000-0000-4000-8000-0000000000aa', 'SWF-T3305', 'quoted', 'fencing',
        'cust.r7b@example.test', 'ct33r5', '{}', '2026-09-01 01:00Z'),
       ('33000000-0000-4000-8000-000000000006', '00000000-0000-4000-8000-0000000000aa', 'SWF-T3306', 'quoted', 'fencing',
        'cust.r7c@example.test', 'ct33r6', '{}', '2026-09-01 01:00Z');
INSERT INTO public.job_documents (id, job_id, type, quote_number, version, created_at, sent_at)
VALUES ('33d00000-0000-4000-8000-000000000041', '33000000-0000-4000-8000-000000000004', 'quote', 'Q-3304', 1, '2026-09-25 00:55Z', '2026-09-25 01:00Z'),
       ('33d00000-0000-4000-8000-000000000051', '33000000-0000-4000-8000-000000000005', 'quote', 'Q-3305', 1, '2026-09-25 00:55Z', '2026-09-25 01:00Z'),
       ('33d00000-0000-4000-8000-000000000061', '33000000-0000-4000-8000-000000000006', 'quote', 'Q-3306', 1, '2026-09-25 00:55Z', '2026-09-25 01:00Z');
INSERT INTO public.email_events (id, job_id, email_type, recipient, subject, status, sent_at, created_at, metadata)
VALUES ('33c00000-0000-4000-8000-000000000041', '33000000-0000-4000-8000-000000000004', 'quote', 'typo@example.test', 'Your quote', 'bounced',
        '2026-09-25 01:00Z', '2026-09-25 01:00Z', '{"document_id":"33d00000-0000-4000-8000-000000000041"}'),
       ('33c00000-0000-4000-8000-000000000042', '33000000-0000-4000-8000-000000000004', 'quote', 'typo@example.test', 'Your quote', 'failed',
        NULL, '2026-09-26 01:00Z', '{"document_id":"33d00000-0000-4000-8000-000000000041"}'),
       ('33c00000-0000-4000-8000-000000000051', '33000000-0000-4000-8000-000000000005', 'quote', 'cust.r7b@example.test', 'Your quote', 'delivered',
        '2026-09-25 01:00Z', '2026-09-25 01:00Z', '{"document_id":"33d00000-0000-4000-8000-000000000051"}'),
       ('33c00000-0000-4000-8000-000000000061', '33000000-0000-4000-8000-000000000006', 'quote', 'typo@example.test', 'Your quote', 'bounced',
        '2026-09-25 01:00Z', '2026-09-25 01:00Z', '{"document_id":"33d00000-0000-4000-8000-000000000061"}'),
       ('33c00000-0000-4000-8000-000000000062', '33000000-0000-4000-8000-000000000006', 'quote', 'cust.r7c@example.test', 'Your quote', 'delivered',
        '2026-10-04 01:00Z', '2026-10-04 01:00Z', '{"document_id":"33d00000-0000-4000-8000-000000000061"}');
DO $r7$
DECLARE r record; s jsonb;
BEGIN
 SELECT * INTO r FROM public.context_job_record_loops(ARRAY['33000000-0000-4000-8000-000000000004'::uuid], '2026-10-07 02:00Z') l
 WHERE l.rule = 'R7_quote_waiting';
 IF r.owner IS DISTINCT FROM 'us' OR r.counterparty IS DISTINCT FROM 'customer' OR r.shown_as IS DISTINCT FROM 'loop'
    OR r.what IS DISTINCT FROM 'Quote Q-3304 v1 sent Fri 25 Sep 2026 (12 days), but every email of it bounced or failed: not received; no customer message since'
    OR r.why NOT LIKE '%so it was not received' OR r.about_key <> 'quote:q-3304'
    -- it says when not received ends, then when the loop closes (a delivered resend
    -- ends not received; it does not close the loop)
    OR r.closes_when IS DISTINCT FROM 'Not received until an email of it goes out or the customer views it, then it waits on the customer; '
                                      || 'closes on acceptance, decline, a newer version, or a customer message' THEN
  RAISE EXCEPTION 'story fixes contract: a quote nobody received is our move, not the customer''s answer: %', row_to_json(r);
 END IF;
 SELECT * INTO r FROM public.context_job_record_loops(ARRAY['33000000-0000-4000-8000-000000000005'::uuid], '2026-10-07 02:00Z') l
 WHERE l.rule = 'R7_quote_waiting';
 IF r.owner IS DISTINCT FROM 'customer' OR r.counterparty IS DISTINCT FROM 'us'
    OR r.what IS DISTINCT FROM 'Quote Q-3305 v1 sent Fri 25 Sep 2026 (12 days), not viewed; no answer and no customer message since'
    OR r.closes_when IS DISTINCT FROM 'Acceptance, decline, a newer version, or a customer message' THEN
  RAISE EXCEPTION 'story fixes contract: a delivered quote still waits on the customer''s answer: %', row_to_json(r);
 END IF;
 SELECT * INTO r FROM public.context_job_record_loops(ARRAY['33000000-0000-4000-8000-000000000006'::uuid], '2026-10-03 12:00Z') l
 WHERE l.rule = 'R7_quote_waiting';
 IF r.owner IS DISTINCT FROM 'us' OR r.what NOT LIKE '%: not received; no customer message since' THEN
  RAISE EXCEPTION 'story fixes contract: before its resend was delivered the quote was not received: %', row_to_json(r);
 END IF;
 SELECT * INTO r FROM public.context_job_record_loops(ARRAY['33000000-0000-4000-8000-000000000006'::uuid], '2026-10-07 02:00Z') l
 WHERE l.rule = 'R7_quote_waiting';
 IF r.owner IS DISTINCT FROM 'customer' OR r.what LIKE '%not received%'
    OR r.loop_key IS DISTINCT FROM 'R7_quote_waiting:33d00000-0000-4000-8000-000000000061'
    OR r.closes_when IS DISTINCT FROM 'Acceptance, decline, a newer version, or a customer message' THEN
  RAISE EXCEPTION 'story fixes contract: once an email of it was delivered the quote waits on the customer: %', row_to_json(r);
 END IF;
 -- the story: the not-received quote is our move, and the now line says so
 s := public.context_job_story('33000000-0000-4000-8000-000000000004', '2026-10-07 02:00Z');
 IF s -> 'loops' -> 0 ->> 'key' <> 'R7_quote_waiting:33d00000-0000-4000-8000-000000000041' OR s -> 'loops' -> 0 ->> 'owner' <> 'us'
    OR s -> 'now' ->> 'whose_move' <> 'us' OR position('we owe: Quote Q-3304' IN s -> 'now' ->> 'line') = 0
    OR position('not received' IN s -> 'now' ->> 'line') = 0 THEN
  RAISE EXCEPTION 'story fixes contract: the story must say the quote was not received and is our move: % / %', s -> 'loops', s -> 'now';
 END IF;
END $r7$;
ROLLBACK;

-- 4. The app events the ledger store lets close a matter are timeline lines a
-- reader can cite, each with its event_type as its state. The same send logged
-- over and over in a day is one line (citing the newest); a quote nobody received
-- is not_delivered; an app event on no closing list keeps no state; and the store
-- agrees: it accepts each cited event with that kind (closing nothing for the one
-- not received).
BEGIN;
SET LOCAL session_replication_role = replica;
INSERT INTO public.jobs (id, org_id, job_number, status, type, client_email, ghl_contact_id, pricing_json, created_at)
VALUES ('33000000-0000-4000-8000-000000000007', '00000000-0000-4000-8000-0000000000aa', 'SWF-T3307', 'accepted', 'fencing',
        'cust.ae@example.test', 'ct33e', '{}', '2026-09-01 01:00Z');
INSERT INTO public.job_documents (id, job_id, type, quote_number, version, created_at, sent_at)
VALUES ('33d00000-0000-4000-8000-000000000071', '33000000-0000-4000-8000-000000000007', 'quote', 'Q-3371', 1, '2026-09-20 00:55Z', '2026-09-20 01:00Z'),
       ('33d00000-0000-4000-8000-000000000072', '33000000-0000-4000-8000-000000000007', 'quote', 'Q-3372', 1, '2026-09-21 00:55Z', '2026-09-21 01:00Z');
INSERT INTO public.email_events (id, job_id, email_type, recipient, subject, status, sent_at, created_at, metadata)
VALUES ('33c00000-0000-4000-8000-000000000071', '33000000-0000-4000-8000-000000000007', 'quote', 'cust.ae@example.test', 'Your quote', 'delivered',
        '2026-09-20 01:00Z', '2026-09-20 01:00Z', '{"document_id":"33d00000-0000-4000-8000-000000000071"}'),
       ('33c00000-0000-4000-8000-000000000072', '33000000-0000-4000-8000-000000000007', 'quote', 'other@example.test', 'Your quote', 'bounced',
        '2026-09-21 01:00Z', '2026-09-21 01:00Z', '{"document_id":"33d00000-0000-4000-8000-000000000072"}');
INSERT INTO public.job_assignments (id, job_id, role, scheduled_date, assignment_type, status, crew_name, is_ghost, created_at)
VALUES ('33e00000-0000-4000-8000-000000000071', '33000000-0000-4000-8000-000000000007', 'lead_installer', '2026-10-01', 'install', 'complete',
        'Crew E', false, '2026-09-25 01:00Z');
INSERT INTO public.job_events (id, job_id, event_type, detail_json, created_at)
VALUES ('33f00000-0000-4000-8000-000000000001', '33000000-0000-4000-8000-000000000007', 'quote_sent',
        '{"document_id":"33d00000-0000-4000-8000-000000000071","sent_to":"cust.ae@example.test"}', '2026-09-20 01:00Z'),
       ('33f00000-0000-4000-8000-000000000002', '33000000-0000-4000-8000-000000000007', 'quote_sent',
        '{"document_id":"33d00000-0000-4000-8000-000000000072","sent_to":"other@example.test"}', '2026-09-21 01:00Z'),
       ('33f00000-0000-4000-8000-000000000003', '33000000-0000-4000-8000-000000000007', 'acceptance_invoice_sent',
        '{"invoice_number":"INV-3370","xero_invoice_id":"x3370","deposit_amount":500,"branded_email_sent":true,"sms_sent":false}', '2026-09-22 01:00Z'),
       ('33f00000-0000-4000-8000-000000000004', '33000000-0000-4000-8000-000000000007', 'invoice.emailed',
        '{"invoice_number":"INV-3371","to":"cust.ae@example.test","via":"outlook"}', '2026-09-28 01:00Z'),
       ('33f00000-0000-4000-8000-000000000005', '33000000-0000-4000-8000-000000000007', 'payment_link_sent',
        '{"invoice_number":"INV-3371","xero_invoice_id":"x3371","sms_sent":false}', '2026-09-29 01:00Z'),
       ('33f00000-0000-4000-8000-000000000006', '33000000-0000-4000-8000-000000000007', 'payment_link_sent',
        '{"invoice_number":"INV-3371","xero_invoice_id":"x3371","sms_sent":false}', '2026-09-29 02:00Z'),
       ('33f00000-0000-4000-8000-000000000007', '33000000-0000-4000-8000-000000000007', 'payment_link_sent',
        '{"invoice_number":"INV-3371","xero_invoice_id":"x3371","sms_sent":false}', '2026-09-29 03:00Z'),
       ('33f00000-0000-4000-8000-000000000008', '33000000-0000-4000-8000-000000000007', 'payment_link_sent',
        '{"invoice_number":"INV-3371","xero_invoice_id":"x3371","sms_sent":false}', '2026-09-30 01:00Z'),
       ('33f00000-0000-4000-8000-000000000009', '33000000-0000-4000-8000-000000000007', 'clock.clock_on',
        '{"assignment_id":"33e00000-0000-4000-8000-000000000071","event":"clock_on"}', '2026-10-01 00:30Z'),
       ('33f00000-0000-4000-8000-000000000010', '33000000-0000-4000-8000-000000000007', 'clock.clock_off',
        '{"assignment_id":"33e00000-0000-4000-8000-000000000071","event":"clock_off","net_hours":6.5}', '2026-10-01 08:00Z'),
       ('33f00000-0000-4000-8000-000000000011', '33000000-0000-4000-8000-000000000007', 'payment_received',
        '{"invoice_number":"INV-3371","xero_invoice_id":"x3371","amount_paid":1100,"fully_paid_on":"/Date(1790899200000+0000)/","source":"xero_sync"}',
        '2026-10-02 01:00Z'),
       ('33f00000-0000-4000-8000-000000000012', '33000000-0000-4000-8000-000000000007', 'makesafe_report_submitted',
        '{"report_id":"rep-1","labour_hours":3}', '2026-10-03 01:00Z'),
       ('33f00000-0000-4000-8000-000000000013', '33000000-0000-4000-8000-000000000007', 'roof_report_submitted',
        '{"draft_id":"draft-1"}', '2026-10-03 02:00Z'),
       ('33f00000-0000-4000-8000-000000000014', '33000000-0000-4000-8000-000000000007', 'assignment_confirmed',
        '{"scheduled_date":"2026-10-01"}', '2026-09-26 01:00Z'),
       ('33f00000-0000-4000-8000-000000000015', '33000000-0000-4000-8000-000000000007', 'payment_received',
        '{"invoice_number":"INV-3372","xero_invoice_id":"x3372","amount_paid":10}', '2026-10-08 01:00Z'),
       ('33f00000-0000-4000-8000-000000000016', '33000000-0000-4000-8000-000000000007', 'payment_recorded',
        '{"invoice_number":"INV-3371"}', '2026-10-02 02:00Z'),
       -- three clock-offs on one day for one booking: one line with the day's hours, every
       -- stint added (never the newest stint's alone); a day where one stint has no hours
       -- gives none
       ('33f00000-0000-4000-8000-000000000017', '33000000-0000-4000-8000-000000000007', 'clock.clock_off',
        '{"assignment_id":"33e00000-0000-4000-8000-000000000071","event":"clock_off","net_hours":0.22}', '2026-10-02 01:00Z'),
       ('33f00000-0000-4000-8000-000000000018', '33000000-0000-4000-8000-000000000007', 'clock.clock_off',
        '{"assignment_id":"33e00000-0000-4000-8000-000000000071","event":"clock_off","net_hours":0.8}', '2026-10-02 03:00Z'),
       ('33f00000-0000-4000-8000-000000000019', '33000000-0000-4000-8000-000000000007', 'clock.clock_off',
        '{"assignment_id":"33e00000-0000-4000-8000-000000000071","event":"clock_off","net_hours":0.03}', '2026-10-02 05:00Z'),
       ('33f00000-0000-4000-8000-000000000020', '33000000-0000-4000-8000-000000000007', 'clock.clock_off',
        '{"assignment_id":"33e00000-0000-4000-8000-000000000071","event":"clock_off","net_hours":2}', '2026-10-03 01:00Z'),
       ('33f00000-0000-4000-8000-000000000021', '33000000-0000-4000-8000-000000000007', 'clock.clock_off',
        '{"assignment_id":"33e00000-0000-4000-8000-000000000071","event":"clock_off"}', '2026-10-03 03:00Z');
DO $events$
DECLARE j constant uuid := '33000000-0000-4000-8000-000000000007'; asof constant timestamptz := '2026-10-07 02:00Z';
 got text; s jsonb; ln record; chk jsonb;
BEGIN
 SELECT string_agg(right(t.source_id, 2) || '=' || t.kind || '=' || coalesce(t.state, '-'), ' ' ORDER BY t.source_id COLLATE "C") INTO got
 FROM public.context_job_record_timeline(ARRAY[j], asof) t WHERE t.source_table = 'job_events';
 IF got IS DISTINCT FROM '01=quote=quote_sent 02=quote=not_delivered 03=invoice=acceptance_invoice_sent 04=invoice=invoice.emailed '
    || '07=invoice=payment_link_sent 08=invoice=payment_link_sent 09=attendance=clock.clock_on 10=attendance=clock.clock_off '
    || '11=payment=payment_received 12=makesafe=makesafe_report_submitted 13=makesafe=roof_report_submitted '
    || '14=booking_change=- 16=payment=payment_recorded 19=attendance=clock.clock_off 21=attendance=clock.clock_off' THEN
  RAISE EXCEPTION 'story fixes contract: app events on the timeline (kind and state per cited event) wrong: %', got;
 END IF;
 SELECT string_agg(right(t.source_id, 2) || ': ' || t.what, ' | ' ORDER BY t.source_id COLLATE "C") INTO got
 FROM public.context_job_record_timeline(ARRAY[j], asof) t
 WHERE t.source_table = 'job_events' AND right(t.source_id, 2) IN ('01', '02', '03', '04', '07', '08', '09', '10', '11', '12', '13', '16', '19', '21');
 IF got IS DISTINCT FROM
    '01: App recorded quote Q-3371 v1 sent to the customer | '
    || '02: App recorded quote Q-3372 v1 sent to another address, but every email of it bounced or failed: not received | '
    || '03: App recorded deposit invoice INV-3370 sent on acceptance (deposit $500.00); email sent, text not recorded as sent | '
    || '04: App recorded invoice INV-3371 emailed to the customer via outlook | '
    || '07: App recorded a payment link for invoice INV-3371 sent (the text was not recorded as sent); recorded 3 times that day, first at 09:00 | '
    || '08: App recorded a payment link for invoice INV-3371 sent (the text was not recorded as sent) | '
    || '09: Crew clocked on for the Thu 1 Oct 2026 booking | '
    || '10: Crew clocked off for the Thu 1 Oct 2026 booking (6.5 hours net) | '
    || '11: App recorded invoice INV-3371 paid in full ($1,100.00, paid Fri 2 Oct 2026) | '
    || '12: Trade make-safe report submitted | '
    || '13: Trade roof report submitted | '
    || '16: App recorded a payment on invoice INV-3371 | '
    || '19: Crew clocked off for the Thu 1 Oct 2026 booking (1.05 hours net that day, all stints added); recorded 3 times that day, first at 09:00 | '
    || '21: Crew clocked off for the Thu 1 Oct 2026 booking; recorded 2 times that day, first at 09:00' THEN
  RAISE EXCEPTION 'story fixes contract: app event words wrong: %', got;
 END IF;
 -- replayed during the day of repeated sends: only the send by then, its own line
 SELECT string_agg(right(t.source_id, 2) || ': ' || t.what, ' | ') INTO got
 FROM public.context_job_record_timeline(ARRAY[j], '2026-09-29 01:30Z') t WHERE t.source_table = 'job_events' AND t.state = 'payment_link_sent';
 IF got IS DISTINCT FROM '05: App recorded a payment link for invoice INV-3371 sent (the text was not recorded as sent)' THEN
  RAISE EXCEPTION 'story fixes contract: a replay sees only the app events by then: %', got;
 END IF;
 -- the story carries them, cited, with their state
 s := public.context_job_story(j, asof);
 IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(s -> 'timeline') x
                WHERE x ->> 'source_id' = '33f00000-0000-4000-8000-000000000011' AND x ->> 'state' = 'payment_received'
                  AND x -> 'cites' = '[{"t": "job_events", "id": "33f00000-0000-4000-8000-000000000011"}]'::jsonb AND x ->> 'phase' = 'payment')
    OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(s -> 'timeline') x
                   WHERE x ->> 'source_id' = '33f00000-0000-4000-8000-000000000010' AND x ->> 'state' = 'clock.clock_off' AND x ->> 'phase' = 'install') THEN
  RAISE EXCEPTION 'story fixes contract: the story timeline must carry the app events, cited, with their state: %', s -> 'timeline';
 END IF;
 -- the store agrees with every line: it accepts the cited event with that kind, and
 -- that kind closes some matter; the one not received closes nothing
 FOR ln IN SELECT t.source_id, t.state FROM public.context_job_record_timeline(ARRAY[j], asof) t
          WHERE t.source_table = 'job_events' AND t.state IS NOT NULL LOOP
  chk := public.context_ledger_cite(j, jsonb_build_object('table', 'job_events', 'id', ln.source_id));
  IF NOT coalesce((chk ->> 'ok')::boolean, false) THEN
   RAISE EXCEPTION 'story fixes contract: the store refuses the cited app event %: %', ln.source_id, chk;
  END IF;
  IF ln.state = 'not_delivered' THEN
   IF chk ->> 'close_at' IS NOT NULL THEN
    RAISE EXCEPTION 'story fixes contract: the store would let a quote nobody received close a matter: %', chk;
   END IF;
  ELSIF chk ->> 'kind' IS DISTINCT FROM ln.state OR chk ->> 'close_at' IS NULL
     OR NOT EXISTS (SELECT 1 FROM unnest(ARRAY['reply', 'call', 'quote_sent', 'invoice_issued', 'payment', 'booking_made', 'visit',
                                               'work_done', 'record', 'person', 'none']) c
                    WHERE public.context_ledger_job_event_closes(ln.state, c)) THEN
   RAISE EXCEPTION 'story fixes contract: the line''s state % must be the kind the store closes on: %', ln.state, chk;
  END IF;
 END LOOP;
END $events$;
ROLLBACK;

-- 5. Re-applying the migration changes nothing (its guard accepts its own bodies). When
-- story safety (20261006040000) has replaced four of them since, it is rolled back first
-- inside this transaction, so the re-apply starts from this migration's own bodies (and the
-- lead cutoff, 20261007010000, before it).
SELECT coalesce(obj_description(to_regprocedure('public.context_job_record_timeline(uuid[],timestamptz)'), 'pg_proc'), '')
       LIKE '%story safety (20261006040000)%' AS story_safety_live \gset
-- (and the lead cutoff, 20261007010000, which replaced three of story safety's bodies since, first
-- of all: story safety's down refuses while a later body is live)
SELECT coalesce(obj_description(to_regprocedure('public.context_lead_monitored_jobs(uuid[],timestamptz)'), 'pg_proc'), '')
       LIKE 'Lead cutoff (20261007010000)%' AS lead_cutoff_live \gset
BEGIN;
\if :lead_cutoff_live
\ir ../../../rollbacks/20261007010000_context_lead_cutoff_down.sql
\endif
\if :story_safety_live
\ir ../../../rollbacks/20261006040000_context_story_safety_down.sql
\endif
\ir ../../../migrations/20261006033000_context_story_fixups.sql
DO $again$
DECLARE x record; live text;
BEGIN
 FOR x IN SELECT * FROM (VALUES
   ('public.context_job_record_timeline(uuid[],timestamptz)', 'f827ec9418fc843470e793c09a55612e'),
   ('public.context_job_record_loops(uuid[],timestamptz)', '47a6a646655f7110ff52be8e90846599'),
   ('public.context_job_story_assemble(jsonb,jsonb,jsonb,jsonb,timestamptz,timestamptz)', 'aab2d2eb593890b297f6d13a486f6aa0'),
   ('public.context_job_story_ledger(uuid,uuid,timestamptz)', '7754e292f957c722d0fa56a3001f8ffd'),
   ('public.context_client_story(uuid,timestamptz)', 'cc4a2ce461deeb17653cd94b714bbf78')) v(sig, md5) LOOP
  SELECT md5(p.prosrc) INTO live FROM pg_proc p WHERE p.oid = to_regprocedure(x.sig);
  IF live IS DISTINCT FROM x.md5 THEN RAISE EXCEPTION 'story fixes contract: % md5 % after a re-apply (want %)', x.sig, live, x.md5; END IF;
 END LOOP;
END $again$;
ROLLBACK;
