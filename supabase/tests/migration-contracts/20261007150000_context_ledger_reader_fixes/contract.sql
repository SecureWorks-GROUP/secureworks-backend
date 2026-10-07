-- Contract: 20261007150000_context_ledger_reader_fixes. Every fixture write is rolled back. Job
-- numbers, contacts, addresses, names and words are synthetic; the row shapes are those of the
-- graded rows (7 Oct go-live grade, part A): SWP-26183, SWF-261486, SWP-261178 and SWF-261305 for
-- the customer's call, SWF-261501 and SWMS-261415 for siblings, SWP-26373 for the paid day. Every
-- fixture is dated at a fixed instant in May to September 2026 and every packet is read as of a
-- fixed instant, so no answer depends on the clock of the run. Evidence rows are written with
-- session_replication_role replica, so each states exactly the columns the store reads.
--
--  1. Shape: the five new functions and the four replaced ones (definer and search path, grants,
--     comments), and nothing switched on.
--  2. The customer's call: the four graded transcript shapes are the customer's call; a call row
--     on the job still decides first; the controls stay unknown; the packet gives true, false or
--     "unknown" (never a bare null) and the citation check agrees; the customer's words may be
--     from_role customer.
--  3. The elsewhere rule: the claim pattern (the graded words and their negatives), each row's
--     reason, the item check refusing the four graded claims (elsewhere_unsupported) and accepting
--     one a cited row's placement or role basis supports, a person's item, the packet's elsewhere.
--  4. Siblings: the two graded shapes (a quote sent on the client's other job; an invoice paid on
--     the same work order's other job), never by name alone, never a holding job, never our own
--     address, the same requesting company, as of the packet's instant, at most 8, the limits.
--  5. The paid day: a request made the day its invoice was paid closes on it, in an item and in a
--     transition, whatever the invoice's date; an earlier paid day and an unpaid invoice never; the
--     write reports elsewhere_unsupported.
--  6. Re-applying the migration changes nothing.
\set ON_ERROR_STOP on

CREATE FUNCTION pg_temp.rf_assert(p_ok boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'ledger reader fixes contract: %', p_msg; END IF; END $$;
CREATE FUNCTION pg_temp.rf_job(p_id uuid, p_number text, p_contact text, p_email text, p_created timestamptz,
 p_status text DEFAULT 'quoted', p_type text DEFAULT 'fencing', p_name text DEFAULT 'Pat Example', p_meta jsonb DEFAULT '{}')
RETURNS uuid LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO public.jobs (id, org_id, status, type, job_number, client_name, client_email, ghl_contact_id, site_suburb, metadata, created_at)
 VALUES (p_id, '00000000-0000-0000-0000-000000000001', p_status, p_type, p_number, p_name, p_email, p_contact, 'Testville', p_meta, p_created);
 RETURN p_id;
END $$;
-- A who-to-whom stamp as the classifier writes it (v1 to v3 shapes).
CREATE FUNCTION pg_temp.rf_roles(p_basis text, p_counterpart text DEFAULT 'customer', p_direction text DEFAULT 'inbound') RETURNS jsonb
LANGUAGE sql AS $$
 SELECT jsonb_build_object('version', 'party_roles_v2', 'basis', p_basis, 'counterpart_role', p_counterpart,
  'sender_role', CASE WHEN p_direction = 'inbound' THEN p_counterpart ELSE 'staff' END,
  'recipient_role', CASE WHEN p_direction = 'inbound' THEN 'staff' ELSE p_counterpart END,
  'audience', CASE WHEN p_counterpart = 'customer' THEN 'customer' ELSE 'internal' END) $$;
-- A placed evidence row, every column the store reads stated.
CREATE FUNCTION pg_temp.rf_ev(p_id uuid, p_job uuid, p_type text, p_channel text, p_direction text, p_body text, p_at timestamptz,
 p_roles jsonb DEFAULT NULL, p_contact text DEFAULT NULL, p_source text DEFAULT 'ledger_contract', p_provider text DEFAULT NULL,
 p_payload jsonb DEFAULT '{}', p_status text DEFAULT 'direct')
RETURNS uuid LANGUAGE plpgsql SET session_replication_role = replica AS $$
BEGIN
 INSERT INTO public.business_events (id, job_id, event_type, source, channel, direction, contact_id, provider_message_id, payload, metadata,
  occurred_at, event_at, recorded_at, context_captured_at, attribution_status, attribution_step, attribution_confidence, attributed_at, match_method)
 VALUES (p_id, p_job, p_type, p_source, p_channel, p_direction, p_contact, p_provider, jsonb_build_object('body', p_body) || p_payload,
  jsonb_build_object('written_as', 'service_role') || CASE WHEN p_roles IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('party_roles', p_roles) END,
  p_at, p_at, p_at, p_at, p_status, 1, CASE WHEN p_job IS NULL THEN NULL ELSE 1 END, p_at, CASE WHEN p_job IS NULL THEN NULL ELSE 'direct_job_id' END);
 RETURN p_id;
END $$;
CREATE FUNCTION pg_temp.rf_inbox(p_id uuid, p_job uuid, p_from text, p_subject text, p_body text, p_at timestamptz) RETURNS uuid
LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO public.inbox_events (id, job_id, metadata, received_at, processed_at, graph_message_id, mailbox, subject, body_preview,
  from_email, from_name, to_email, classification)
 VALUES (p_id, p_job, '{}', p_at, p_at, 'g-' || p_id, 'office@secureworkswa.com.au', p_subject, p_body, p_from, 'Sender Name',
  'office@secureworkswa.com.au', 'client_reply');
 RETURN p_id;
END $$;
CREATE FUNCTION pg_temp.rf_cite(p_id uuid, p_excerpt text, p_table text DEFAULT 'business_events') RETURNS jsonb LANGUAGE sql AS $$
 SELECT jsonb_build_array(jsonb_build_object('table', p_table, 'id', p_id::text, 'excerpt', p_excerpt)) $$;
CREATE FUNCTION pg_temp.rf_item(p_type text, p_status text, p_from text, p_what text, p_open jsonb, p_extra jsonb DEFAULT '{}') RETURNS jsonb
LANGUAGE sql AS $$
 SELECT jsonb_build_object('ref', 'r-' || left(md5(p_what), 8), 'item_type', p_type, 'status', p_status, 'from_role', p_from, 'to_role', 'us',
  'what', p_what, 'opened_by', p_open) || p_extra $$;
-- The item check's answer for a model item: ok, or its refusal code.
CREATE FUNCTION pg_temp.rf_check(p_job uuid, p_item jsonb) RETURNS text LANGUAGE sql AS $$
 SELECT CASE WHEN (r ->> 'ok')::boolean THEN 'ok' ELSE r ->> 'code' END FROM (SELECT public.context_ledger_check_item(p_job, p_item, 'model') AS r) x $$;
-- One evidence row of a packet.
CREATE FUNCTION pg_temp.rf_row(p_packet jsonb, p_id uuid) RETURNS jsonb LANGUAGE sql AS $$
 SELECT x FROM jsonb_array_elements(p_packet -> 'evidence') x WHERE x ->> 'id' = p_id::text $$;
CREATE FUNCTION pg_temp.rf_cc(p_id uuid) RETURNS boolean LANGUAGE sql AS $$
 SELECT public.context_ledger_call_customer(e) FROM public.business_events e WHERE e.id = p_id $$;

-- 1. Shape.
DO $c$
DECLARE f text; p record;
BEGIN
 FOREACH f IN ARRAY ARRAY['public.context_ledger_elsewhere_claim(text)', 'public.context_ledger_paid_close_at(timestamptz)',
  'public.context_ledger_work_order_key(text)', 'public.context_ledger_row_elsewhere(uuid,text,uuid)',
  'public.context_ledger_siblings(uuid,timestamptz)', 'public.context_ledger_call_customer(public.business_events)',
  'public.context_ledger_check_item(uuid,jsonb,text,uuid,text)', 'public.context_ledger_write(uuid,uuid,uuid,jsonb,jsonb,text)',
  'public.context_ledger_packet(uuid,timestamptz,timestamptz)'] LOOP
  PERFORM pg_temp.rf_assert(to_regprocedure(f) IS NOT NULL, f || ' missing');
  PERFORM pg_temp.rf_assert(has_function_privilege('service_role', f, 'EXECUTE'), f || ' not executable by service_role');
  PERFORM pg_temp.rf_assert(NOT has_function_privilege('anon', f, 'EXECUTE') AND NOT has_function_privilege('authenticated', f, 'EXECUTE'),
   f || ' executable by anon or authenticated');
  PERFORM pg_temp.rf_assert(NOT EXISTS (SELECT 1 FROM pg_proc pp, aclexplode(coalesce(pp.proacl, acldefault('f', pp.proowner))) a
   WHERE pp.oid = to_regprocedure(f) AND a.grantee = 0 AND a.privilege_type = 'EXECUTE'), f || ' executable by PUBLIC');
 END LOOP;
 -- The new functions run as definer with a fixed path and carry this migration's marker; the
 -- replaced ones keep the store's marker first and name this slice; the call helper stays a plain
 -- helper (no SET, not a definer), as the store's shape contract demands.
 FOR p IN SELECT pp.oid::regprocedure::text AS sig, pp.prosecdef, pp.proconfig, obj_description(pp.oid, 'pg_proc') AS c
  FROM pg_proc pp WHERE pp.pronamespace = 'public'::regnamespace AND pp.proname IN ('context_ledger_elsewhere_claim',
   'context_ledger_paid_close_at', 'context_ledger_work_order_key', 'context_ledger_row_elsewhere', 'context_ledger_siblings') LOOP
  PERFORM pg_temp.rf_assert(p.prosecdef AND p.proconfig = ARRAY['search_path=public, pg_temp'], p.sig || ' must be definer with search_path public, pg_temp');
  PERFORM pg_temp.rf_assert(p.c LIKE 'Ledger reader fixes (20261007150000): %', p.sig || ' comment is not this migration''s');
 END LOOP;
 FOR p IN SELECT pp.oid::regprocedure::text AS sig, pp.proname, pp.prosecdef, pp.proconfig, obj_description(pp.oid, 'pg_proc') AS c
  FROM pg_proc pp WHERE pp.pronamespace = 'public'::regnamespace AND pp.proname IN ('context_ledger_call_customer',
   'context_ledger_check_item', 'context_ledger_write', 'context_ledger_packet') LOOP
  PERFORM pg_temp.rf_assert(p.c LIKE 'Context ledger store (20261006013000), ledger reader fixes (20261007150000): %', p.sig || ' comment');
  IF p.proname = 'context_ledger_call_customer' THEN
   PERFORM pg_temp.rf_assert(NOT p.prosecdef AND p.proconfig IS NULL, p.sig || ' must stay a plain helper');
  ELSE
   PERFORM pg_temp.rf_assert(p.prosecdef AND p.proconfig = ARRAY['search_path=public, pg_temp'], p.sig || ' must stay definer');
  END IF;
 END LOOP;
 -- Nothing switched on: the ledger stays off with no calls.
 PERFORM pg_temp.rf_assert((SELECT mode = 'off' AND calls_per_day = 0 FROM public.context_ledger_settings), 'ledger settings changed');
END $c$;

-- 2. The customer's call.
BEGIN;
DO $c$
DECLARE asof constant timestamptz := '2026-10-07 02:00Z'; pk jsonb; exp record;
 ja uuid := 'f1500000-0000-4000-8000-000000000001'; jbb uuid := 'f1500000-0000-4000-8000-000000000002';
 jc uuid := 'f1500000-0000-4000-8000-000000000003'; jd uuid := 'f1500000-0000-4000-8000-000000000004';
 jd2 uuid := 'f1500000-0000-4000-8000-000000000005'; je uuid := 'f1500000-0000-4000-8000-000000000006';
 jf uuid := 'f1500000-0000-4000-8000-000000000007';
 ta uuid := 'f15b0000-0000-4000-8000-000000000001'; tb1 uuid := 'f15b0000-0000-4000-8000-000000000002';
 cb1 uuid := 'f15b0000-0000-4000-8000-000000000003'; tb2 uuid := 'f15b0000-0000-4000-8000-000000000004';
 tc uuid := 'f15b0000-0000-4000-8000-000000000005'; td uuid := 'f15b0000-0000-4000-8000-000000000006';
 cd uuid := 'f15b0000-0000-4000-8000-000000000007'; e1 uuid := 'f15b0000-0000-4000-8000-000000000008';
 e2 uuid := 'f15b0000-0000-4000-8000-000000000009'; e3 uuid := 'f15b0000-0000-4000-8000-000000000010';
 c3 uuid := 'f15b0000-0000-4000-8000-000000000011'; e4 uuid := 'f15b0000-0000-4000-8000-000000000012';
 c4 uuid := 'f15b0000-0000-4000-8000-000000000013'; e5 uuid := 'f15b0000-0000-4000-8000-000000000014';
BEGIN
 PERFORM pg_temp.rf_job(ja, 'SWP-97001', 'rf-ct-a', 'a@example.test', '2026-05-01 00:00Z', 'scheduled', 'patio');
 PERFORM pg_temp.rf_job(jbb, 'SWF-97002', 'rf-ct-b', 'b@example.test', '2026-09-01 00:00Z');
 PERFORM pg_temp.rf_job(jc, 'SWP-97003', 'rf-ct-c', 'c@example.test', '2026-08-20 00:00Z', 'approvals', 'patio');
 PERFORM pg_temp.rf_job(jd, 'SWF-97004', 'rf-ct-d', 'd@example.test', '2026-08-15 00:00Z', 'scheduled');
 PERFORM pg_temp.rf_job(jd2, 'SWF-97005', 'rf-ct-d', 'd@example.test', '2026-08-16 00:00Z', 'scheduled');
 PERFORM pg_temp.rf_job(je, 'SWF-97006', 'rf-ct-e', 'e@example.test', '2026-08-01 00:00Z');
 PERFORM pg_temp.rf_job(jf, 'SWF-97007', 'rf-ct-f', 'f@example.test', '2026-08-01 00:00Z');
 -- SWP-26183 shape: a transcribe-call transcript (no provider key; its ghl_call_id is
 -- <contact>:<instant> and names no call row), stamped the job's customer on the job's contact.
 PERFORM pg_temp.rf_ev(ta, ja, 'call.transcript_completed', 'call', 'inbound', 'Yes we are happy to go ahead with the patio as quoted',
  '2026-05-08 01:37:38Z', pg_temp.rf_roles('job_customer'), 'rf-ct-a', 'transcribe-call', NULL,
  '{"ghl_call_id":"rf-ct-a:2026-05-08T01:37:38.842Z"}');
 -- SWF-261486 shape: the call's own transcript, linked to its stamped call row, and a second
 -- transcript of the same call from transcribe-call.
 PERFORM pg_temp.rf_ev(cb1, jbb, 'client.call_logged', 'call', 'inbound', 'Call. Provider status: completed. Duration: 120 seconds',
  '2026-09-24 07:58:00Z', pg_temp.rf_roles('job_customer'), 'rf-ct-b', 'ghl', 'ghl:RFCALLB');
 PERFORM pg_temp.rf_ev(tb1, jbb, 'call.transcript_completed', 'call', 'inbound', 'I would like a quote for the side fence please',
  '2026-09-24 07:58:49Z', pg_temp.rf_roles('job_customer'), 'rf-ct-b', 'ghl-call-transcript', 'ghltx:RFCALLB', '{"ghl_call_id":"RFCALLB"}',
  'single_open');
 PERFORM pg_temp.rf_ev(tb2, jbb, 'call.transcript_completed', 'call', 'inbound', 'I would like a quote for the side fence please thanks',
  '2026-09-24 08:02:10Z', pg_temp.rf_roles('job_customer'), 'rf-ct-b', 'transcribe-call', NULL,
  '{"ghl_call_id":"rf-ct-b:2026-09-24T08:02:10.867Z"}', 'single_open');
 -- SWP-261178 shape: transcribe-call, placed by a direct match.
 PERFORM pg_temp.rf_ev(tc, jc, 'call.transcript_completed', 'call', 'inbound', 'Thank you, we will send the form back this week',
  '2026-09-01 03:39:13Z', pg_temp.rf_roles('job_customer'), 'rf-ct-c', 'transcribe-call', NULL,
  '{"ghl_call_id":"rf-ct-c:2026-09-01T03:39:13.856Z"}');
 -- SWF-261305 shape: the call's own transcript on the job (placed by Luna), its call row placed on
 -- no job with basis any_job_customer, because the client has a second job installing that day.
 PERFORM pg_temp.rf_ev(cd, NULL, 'client.call_logged', 'call', 'inbound', 'Call. Provider status: completed. Duration: 90 seconds',
  '2026-10-06 05:32:00Z', pg_temp.rf_roles('any_job_customer'), 'rf-ct-d', 'ghl', 'ghl:RFCALLD', '{}', 'unplaced');
 PERFORM pg_temp.rf_ev(td, jd, 'call.transcript_completed', 'call', 'inbound', 'Just checking you are still coming tomorrow for the fence',
  '2026-10-06 05:33:19Z', pg_temp.rf_roles('job_customer'), 'rf-ct-d', 'ghl-call-transcript', 'ghltx:RFCALLD', '{"ghl_call_id":"RFCALLD"}', 'luna');
 -- Controls. e1: stamped another job's customer (its contact is not this job's); e2: stamped the
 -- job's customer but with no CRM contact (a phone match); e3: a call row on this job stamped a
 -- supplier decides first; e4: its call row sits on another job; e5: no stamp at all.
 PERFORM pg_temp.rf_ev(e1, je, 'call.transcript_completed', 'call', 'inbound', 'Hello I am calling about a quote for my place',
  '2026-09-17 02:00:00Z', pg_temp.rf_roles('any_job_customer'), 'rf-ct-other', 'transcribe-call', NULL,
  '{"ghl_call_id":"rf-ct-other:2026-09-17T02:00:00.000Z"}');
 PERFORM pg_temp.rf_ev(e2, je, 'call.transcript_completed', 'call', 'inbound', 'It is me again about the gate on the side',
  '2026-09-18 02:00:00Z', pg_temp.rf_roles('job_customer'), NULL, 'transcribe-call', NULL, '{"ghl_call_id":"x:2026-09-18T02:00:00.000Z"}');
 PERFORM pg_temp.rf_ev(c3, je, 'client.call_logged', 'call', 'inbound', 'Call. Provider status: completed. Duration: 30 seconds',
  '2026-09-19 01:59:00Z', pg_temp.rf_roles('supplier', 'supplier'), 'rf-ct-supp', 'ghl', 'ghl:RFCALL3');
 PERFORM pg_temp.rf_ev(e3, je, 'call.transcript_completed', 'call', 'inbound', 'Your sheets are ready for pick up from the yard',
  '2026-09-19 02:00:00Z', pg_temp.rf_roles('job_customer'), 'rf-ct-e', 'ghl-call-transcript', 'ghltx:RFCALL3', '{"ghl_call_id":"RFCALL3"}');
 PERFORM pg_temp.rf_ev(c4, jf, 'client.call_logged', 'call', 'inbound', 'Call. Provider status: completed. Duration: 45 seconds',
  '2026-09-20 01:59:00Z', pg_temp.rf_roles('job_customer'), 'rf-ct-f', 'ghl', 'ghl:RFCALL4');
 PERFORM pg_temp.rf_ev(e4, je, 'call.transcript_completed', 'call', 'inbound', 'Can you also look at the back fence when you come',
  '2026-09-20 02:00:00Z', pg_temp.rf_roles('job_customer'), 'rf-ct-e', 'ghl-call-transcript', 'ghltx:RFCALL4', '{"ghl_call_id":"RFCALL4"}');
 PERFORM pg_temp.rf_ev(e5, je, 'call.transcript_completed', 'call', 'inbound', 'Hi there just returning your call about the fence',
  '2026-09-21 02:00:00Z', NULL, NULL, 'transcribe-call', NULL, '{"ghl_call_id":"y:2026-09-21T02:00:00.000Z"}');
 -- The rule, the citation check and the packet agree on every transcript: true, false or unknown.
 FOR exp IN SELECT * FROM (VALUES
   (ja, ta, 'true', 'SWP-26183 shape: a transcribe-call transcript stamped the job''s customer on the job''s contact is the customer''s call'),
   (jbb, tb1, 'true', 'SWF-261486 shape: the call''s own transcript, by its stamped call row'),
   (jbb, tb2, 'true', 'SWF-261486 shape: its second transcript from transcribe-call is the customer''s call too'),
   (jc, tc, 'true', 'SWP-261178 shape: a transcribe-call transcript placed directly is the customer''s call'),
   (jd, td, 'true', 'SWF-261305 shape: its call row unplaced (any_job_customer), the transcript''s own stamp decides'),
   (je, e1, '"unknown"', 'a transcript stamped another job''s customer is unknown, never this job''s customer'),
   (je, e2, '"unknown"', 'a job_customer stamp with no CRM contact is unknown (the job''s own contact decides)'),
   (je, e3, 'false', 'a call row on the job stamped someone else still decides first'),
   (je, e4, 'true', 'a call row on another job does not decide here; the transcript''s own stamp does'),
   (je, e5, '"unknown"', 'an unstamped transcript with no call row is unknown')) v(job, id, want, why) LOOP
  pk := public.context_ledger_packet(exp.job, NULL, asof);
  PERFORM pg_temp.rf_assert(pg_temp.rf_row(pk, exp.id) -> 'call_customer' = exp.want::jsonb,
   format('%s: packet call_customer %s, want %s', exp.why, pg_temp.rf_row(pk, exp.id) -> 'call_customer', exp.want));
  PERFORM pg_temp.rf_assert(pg_temp.rf_cc(exp.id) IS NOT DISTINCT FROM CASE exp.want WHEN 'true' THEN true WHEN 'false' THEN false END,
   format('%s: context_ledger_call_customer %s', exp.why, pg_temp.rf_cc(exp.id)));
  PERFORM pg_temp.rf_assert((public.context_ledger_cite(exp.job, jsonb_build_object('table', 'business_events', 'id', exp.id::text,
    'excerpt', pg_temp.rf_row(pk, exp.id) ->> 'text')) ->> 'customer_sender')::boolean = (exp.want = 'true'),
   format('%s: the citation check disagrees', exp.why));
 END LOOP;
 -- Rows that are not transcripts keep call_customer null; a call row is never "unknown".
 pk := public.context_ledger_packet(jbb, NULL, asof);
 PERFORM pg_temp.rf_assert(pg_temp.rf_row(pk, cb1) -> 'call_customer' = 'null'::jsonb AND pg_temp.rf_row(pk, cb1) ->> 'has_transcript' = 'true',
  'a call log keeps call_customer null: ' || coalesce(pg_temp.rf_row(pk, cb1)::text, '<missing>'));
 -- The customer's own words may now be from_role customer (speaker_not_customer before).
 PERFORM pg_temp.rf_assert(pg_temp.rf_check(ja, pg_temp.rf_item('agreement', 'info', 'customer', 'The customer gave the go-ahead on the patio quote.',
   pg_temp.rf_cite(ta, 'happy to go ahead with the patio'), '{"modality":"agreed"}')) = 'ok',
  'SWP-26183 shape: the customer''s go-ahead on their own call is the customer''s: '
  || pg_temp.rf_check(ja, pg_temp.rf_item('agreement', 'info', 'customer', 'The customer gave the go-ahead on the patio quote.',
   pg_temp.rf_cite(ta, 'happy to go ahead with the patio'), '{"modality":"agreed"}')));
 PERFORM pg_temp.rf_assert(pg_temp.rf_check(jd, pg_temp.rf_item('request', 'open', 'customer', 'The customer asked us to confirm the install day.',
   pg_temp.rf_cite(td, 'still coming tomorrow for the fence'))) = 'ok', 'SWF-261305 shape: the customer''s own call is the customer''s');
 PERFORM pg_temp.rf_assert(pg_temp.rf_check(je, pg_temp.rf_item('request', 'open', 'customer', 'Asked about the side gate.',
   pg_temp.rf_cite(e2, 'about the gate on the side'))) = 'speaker_not_customer', 'an unknown caller is never the customer');
END $c$;
ROLLBACK;

-- 3. The elsewhere rule.
BEGIN;
DO $c$
DECLARE asof constant timestamptz := '2026-10-07 02:00Z'; pk jsonb; exp record; got text;
 ja uuid := 'f1500000-0000-4000-8000-000000000011'; jo uuid := 'f1500000-0000-4000-8000-000000000012';
 jh uuid := 'f1500000-0000-4000-8000-000000000013';
 ta uuid := 'f15b0000-0000-4000-8000-000000000101'; t1 uuid := 'f15b0000-0000-4000-8000-000000000102';
 c1 uuid := 'f15b0000-0000-4000-8000-000000000103'; t2 uuid := 'f15b0000-0000-4000-8000-000000000104';
 c2 uuid := 'f15b0000-0000-4000-8000-000000000105'; d1 uuid := 'f15b0000-0000-4000-8000-000000000106';
 d2 uuid := 'f15b0000-0000-4000-8000-000000000107'; s1 uuid := 'f15b0000-0000-4000-8000-000000000108';
 tx1 uuid := 'f15b0000-0000-4000-8000-000000000109'; ah uuid := 'f15b0000-0000-4000-8000-000000000110';
 m1 uuid := 'f15a0000-0000-4000-8000-000000000101'; m2 uuid := 'f15a0000-0000-4000-8000-000000000102';
 x1 uuid := 'f15c0000-0000-4000-8000-000000000101';
BEGIN
 PERFORM pg_temp.rf_job(ja, 'SWF-97011', 'rf-ct-g', 'g@example.test', '2026-08-01 00:00Z', 'scheduled');
 PERFORM pg_temp.rf_job(jo, 'SWF-97012', 'rf-ct-o', 'o@example.test', '2026-08-01 00:00Z', 'scheduled');
 PERFORM pg_temp.rf_job(jh, 'SWF-97013', 'rf-ct-h', 'h@example.test', '2026-08-01 00:00Z', 'scheduled');
 -- the customer's own transcribe-call transcript (job_customer, the job's contact)
 PERFORM pg_temp.rf_ev(ta, ja, 'call.transcript_completed', 'call', 'inbound', 'We are fine with the black colour for the slats',
  '2026-09-02 01:00:00Z', pg_temp.rf_roles('job_customer'), 'rf-ct-g', 'transcribe-call', NULL, '{"ghl_call_id":"rf-ct-g:2026-09-02T01:00:00.000Z"}');
 -- another job's customer (any_job_customer)
 PERFORM pg_temp.rf_ev(t1, ja, 'call.transcript_completed', 'call', 'inbound', 'Hi it is about my quote for the front fence',
  '2026-09-03 01:00:00Z', pg_temp.rf_roles('any_job_customer'), 'rf-ct-x', 'transcribe-call', NULL, '{"ghl_call_id":"rf-ct-x:2026-09-03T01:00:00.000Z"}');
 -- a transcript whose call row on this job is a supplier's
 PERFORM pg_temp.rf_ev(c1, ja, 'client.call_logged', 'call', 'inbound', 'Call. Provider status: completed. Duration: 50 seconds',
  '2026-09-04 00:59:00Z', pg_temp.rf_roles('supplier', 'supplier'), 'rf-ct-s', 'ghl', 'ghl:RFCALL31');
 PERFORM pg_temp.rf_ev(t2, ja, 'call.transcript_completed', 'call', 'inbound', 'The posts you ordered are in the yard now',
  '2026-09-04 01:00:00Z', NULL, 'rf-ct-s', 'ghl-call-transcript', 'ghltx:RFCALL31', '{"ghl_call_id":"RFCALL31"}');
 -- a transcript whose call row sits on another job
 PERFORM pg_temp.rf_ev(c2, jo, 'client.call_logged', 'call', 'inbound', 'Call. Provider status: completed. Duration: 70 seconds',
  '2026-09-05 00:59:00Z', pg_temp.rf_roles('job_customer'), 'rf-ct-o', 'ghl', 'ghl:RFCALL32');
 PERFORM pg_temp.rf_ev(tx1, ja, 'call.transcript_completed', 'call', 'inbound', 'Please call me back about the colour of the gate',
  '2026-09-05 01:00:00Z', pg_temp.rf_roles('job_customer'), 'rf-ct-g', 'ghl-call-transcript', 'ghltx:RFCALL32', '{"ghl_call_id":"RFCALL32"}');
 -- document text naming another job's number only; and naming this job's and another's
 PERFORM pg_temp.rf_ev(d1, ja, 'document.text_extracted', 'document', 'inbound', 'Order confirmation 4711 reference SWF-97012 panels and posts',
  '2026-09-06 01:00:00Z');
 PERFORM pg_temp.rf_ev(d2, ja, 'document.text_extracted', 'document', 'inbound', 'Order confirmation 4712 reference SWF-97011 and SWF-97012',
  '2026-09-06 02:00:00Z');
 -- our staff's email (our domain)
 PERFORM pg_temp.rf_ev(s1, ja, 'client.email_in', 'email', 'inbound', 'Forwarding the council letter for the record',
  '2026-09-07 01:00:00Z', pg_temp.rf_roles('our_domain', 'staff'), NULL, 'monitor-inbox', NULL, '{"from":"staff@secureworkswa.com.au"}');
 -- a row on a holding job (another job's row is never this job's to judge)
 PERFORM pg_temp.rf_ev(ah, jh, 'client.reply', 'sms', 'inbound', 'Is the gate still coming', '2026-09-07 02:00:00Z',
  pg_temp.rf_roles('job_customer'), 'rf-ct-h');
 -- old-inbox mail: from another address, and from the client's own
 PERFORM pg_temp.rf_inbox(m1, ja, 'agent@realty.example.test', 'Statement', 'Payment statement for the rental property', '2026-09-08 01:00:00Z');
 PERFORM pg_temp.rf_inbox(m2, ja, 'g@example.test', 'Gate colour', 'Black is fine for the gate thanks', '2026-09-08 02:00:00Z');
 INSERT INTO public.xero_invoices (id, org_id, xero_invoice_id, invoice_type, job_id, invoice_number, status, invoice_date, total, created_at, updated_at)
 VALUES (x1, '00000000-0000-0000-0000-000000000001', 'xi-rf-101', 'ACCREC', ja, 'INV-97101', 'AUTHORISED', '2026-09-09', 100, '2026-09-09 01:00Z', '2026-09-09 01:00Z');

 -- The claim pattern: the graded words (and the ways they are written) are claims; other
 -- mentions of another job or someone else are not.
 FOR exp IN SELECT * FROM (VALUES
   ('The call transcript is labelled as not from this job''s customer.', true),
   ('A second transcript of the call is linked to someone other than this job''s customer; it looks like a duplicate that was labelled wrongly.', true),
   ('The call transcript is marked as from another job or a lead, so it appears to belong to another job.', true),
   ('A call transcript is labelled as coming from a customer of another job or a lead.', true),
   ('This email appears to belong to another job.', true),
   ('These texts may relate to the client''s other job.', true),
   ('The order confirmation was misfiled on this job.', true),
   ('The voicemail is from someone other than this customer.', true),
   ('The voicemail is not from this job’s customer.', true),
   ('THIS ROW BELONGS TO ANOTHER JOB', true),
   ('The quote appears to concern a different property.', true),
   ('The crew was booked on another job that day, so the infill waits.', false),
   ('He needed to move on to another job after finishing.', false),
   ('They said they would get someone else if we cannot start soon.', false),
   ('They went with a cheaper quote from someone else.', false),
   ('The work order names the tenants as other contacts.', false),
   ('The payment covered this job together with two other job references.', false),
   ('It is not the customer''s responsibility to remove the old fence.', false),
   ('The booking is recorded as not attended.', false),
   ('Our staff visited the site with another person.', false),
   ('The customer misplaced the gate key.', false),
   ('The customer asked for the gate to be black.', false)) v(what, want) LOOP
  PERFORM pg_temp.rf_assert(public.context_ledger_elsewhere_claim(exp.what) = exp.want,
   format('the claim pattern reads %L as %s', exp.what, NOT exp.want));
 END LOOP;
 PERFORM pg_temp.rf_assert(NOT public.context_ledger_elsewhere_claim(NULL), 'no words are no claim');

 -- Each row's own placement or role basis, and why.
 FOR exp IN SELECT * FROM (VALUES
   ('business_events', ta, NULL::text, 'the customer''s own transcript is nobody else''s'),
   ('business_events', t1, 'role_basis:any_job_customer', 'another job''s customer by its stamp'),
   ('business_events', t2, 'call_not_customer', 'a transcript whose call row on this job is a supplier''s'),
   ('business_events', tx1, 'call_on_other_job', 'a transcript whose call row sits on another job'),
   ('business_events', d1, 'names_other_job:SWF-97012', 'words naming another job''s number only'),
   ('business_events', d2, NULL, 'words naming this job too'),
   ('business_events', s1, 'role_basis:our_domain', 'our own staff'),
   ('business_events', ah, NULL, 'a row on another job is not this job''s to judge'),
   ('inbox_events', m1, 'sender_not_client', 'old-inbox mail from another address'),
   ('inbox_events', m2, NULL, 'old-inbox mail from the client''s address'),
   ('xero_invoices', x1, NULL, 'a record row is this job''s own')) v(t, id, want, why) LOOP
  got := public.context_ledger_row_elsewhere(ja, exp.t, exp.id);
  PERFORM pg_temp.rf_assert(got IS NOT DISTINCT FROM exp.want, format('%s: elsewhere %s, want %s', exp.why, got, exp.want));
 END LOOP;
 -- The packet carries the same reason on each evidence row.
 pk := public.context_ledger_packet(ja, NULL, asof);
 PERFORM pg_temp.rf_assert(pg_temp.rf_row(pk, t1) ->> 'elsewhere' = 'role_basis:any_job_customer' AND pg_temp.rf_row(pk, ta) -> 'elsewhere' = 'null'::jsonb
  AND pg_temp.rf_row(pk, tx1) ->> 'elsewhere' = 'call_on_other_job' AND pg_temp.rf_row(pk, m1) ->> 'elsewhere' = 'sender_not_client'
  AND pg_temp.rf_row(pk, d1) ->> 'elsewhere' = 'names_other_job:SWF-97012' AND pg_temp.rf_row(pk, m2) -> 'elsewhere' = 'null'::jsonb,
  'the packet gives each row its elsewhere: ' || (SELECT string_agg(x ->> 'id' || '=' || coalesce(x ->> 'elsewhere', '-'), ', ') FROM jsonb_array_elements(pk -> 'evidence') x));

 -- The item check: the four graded claims on the customer's own call are refused; a claim a cited
 -- row supports stands; anything else is unchanged.
 FOR exp IN SELECT * FROM (VALUES
   ('event', 'info', 'The caller gave the go-ahead on the quote. The call transcript is labelled as not from this job''s customer.',
    'business_events', ta, 'fine with the black colour', 'elsewhere_unsupported', 'SWP-26183 shape'),
   ('issue', 'open', 'A second transcript of the call is linked to someone other than this job''s customer; it was labelled wrongly.',
    'business_events', ta, 'fine with the black colour', 'elsewhere_unsupported', 'SWF-261486 shape'),
   ('issue', 'open', 'A call transcript is labelled as coming from a customer of another job or a lead, so it appears to belong to another job.',
    'business_events', ta, 'fine with the black colour', 'elsewhere_unsupported', 'SWP-261178 shape'),
   ('issue', 'open', 'The call transcript is marked as from another job or a lead, so it appears to belong to another job.',
    'business_events', ta, 'fine with the black colour', 'elsewhere_unsupported', 'SWF-261305 shape'),
   ('issue', 'open', 'This call appears to belong to another job.', 'business_events', t1, 'about my quote for the front fence', 'ok',
    'another job''s customer by its stamp'),
   ('issue', 'open', 'The call record of this transcript is filed against another job.', 'business_events', tx1,
    'call me back about the colour of the gate', 'ok', 'its call row sits on another job'),
   ('issue', 'open', 'The order confirmation appears to belong to another job.', 'business_events', d1, 'Order confirmation 4711 reference',
    'ok', 'it names another job''s number only'),
   ('issue', 'open', 'This statement appears to belong to another job.', 'inbox_events', m1, 'Payment statement for the rental', 'ok',
    'mail from another address'),
   ('issue', 'open', 'This order confirmation appears to belong to another job.', 'business_events', d2, 'Order confirmation 4712 reference',
    'elsewhere_unsupported', 'it names this job too'),
   ('event', 'info', 'The customer chose black for the slats.', 'business_events', ta, 'fine with the black colour', 'ok', 'no claim'))
   v(typ, st, what, tbl, cite, excerpt, want, why) LOOP
  got := pg_temp.rf_check(ja, pg_temp.rf_item(exp.typ, exp.st, 'unknown', exp.what, pg_temp.rf_cite(exp.cite, exp.excerpt, exp.tbl)));
  PERFORM pg_temp.rf_assert(got = exp.want, format('%s: the item check says %s, want %s', exp.why, got, exp.want));
 END LOOP;
 -- Any cited row counts: the customer's own transcript first, then a row another job's customer sent.
 PERFORM pg_temp.rf_assert(pg_temp.rf_check(ja, pg_temp.rf_item('issue', 'open', 'unknown', 'The second call appears to belong to another job.',
   pg_temp.rf_cite(ta, 'fine with the black colour') || pg_temp.rf_cite(t1, 'about my quote for the front fence'))) = 'ok',
  'a claim stands on any cited row that is someone else''s');
 -- A person's own item is their word.
 PERFORM pg_temp.rf_assert((public.context_ledger_check_item(ja, jsonb_build_object('item_type', 'issue', 'status', 'open', 'from_role', 'us',
   'what', 'This call appears to belong to another job.'), 'person', 'f15e0000-0000-4000-8000-000000000001', 'staff note') ->> 'ok')::boolean,
  'a person''s item saying a row belongs to another job stands');
END $c$;
ROLLBACK;

-- 4. Siblings.
BEGIN;
DO $c$
DECLARE asof constant timestamptz := '2026-10-07 02:00Z'; pk jsonb; sib jsonb; s jsonb; exp record; k integer; got text;
 s1 uuid := 'f1500000-0000-4000-8000-000000000021'; s2 uuid := 'f1500000-0000-4000-8000-000000000022';
 m1 uuid := 'f1500000-0000-4000-8000-000000000023'; m2 uuid := 'f1500000-0000-4000-8000-000000000024';
 m3 uuid := 'f1500000-0000-4000-8000-000000000025'; m4 uuid := 'f1500000-0000-4000-8000-000000000026';
 n1 uuid := 'f1500000-0000-4000-8000-000000000027'; h1 uuid := 'f1500000-0000-4000-8000-000000000028';
 o1 uuid := 'f1500000-0000-4000-8000-000000000029'; o2 uuid := 'f1500000-0000-4000-8000-000000000030';
 late uuid := 'f1500000-0000-4000-8000-000000000031'; kk uuid := 'f1500000-0000-4000-8000-000000000032';
 q1 uuid := 'f15d0000-0000-4000-8000-000000000001'; q2 uuid := 'f15d0000-0000-4000-8000-000000000002';
 q3 uuid := 'f15d0000-0000-4000-8000-000000000003';
BEGIN
 -- SWF-261501 shape: the same CRM contact and client email; the whole-boundary quote went out on
 -- the other job 3 days later (a revision gives its total), and a later revision after as_of.
 PERFORM pg_temp.rf_job(s1, 'SWF-97101', 'rf-ct-s', 's@example.test', '2026-09-20 00:00Z');
 PERFORM pg_temp.rf_job(s2, 'SWF-97102', 'rf-ct-s', 'S@Example.test ', '2026-09-28 00:00Z');
 INSERT INTO public.job_documents (id, job_id, type, quote_number, version, created_at, sent_at, viewed_at, accepted_at, declined_at)
 VALUES (q1, s2, 'quote', 'Q-9701', 1, '2026-10-05 07:00Z', '2026-10-05 07:29:04Z', '2026-10-05 10:23Z', NULL, NULL),
        (q2, s2, 'quote', 'Q-9702', 1, '2026-10-08 07:00Z', '2026-10-08 07:30Z', NULL, NULL, NULL),
        (q3, s1, 'quote', 'Q-9700', 1, '2026-10-02 03:00Z', '2026-10-02 03:16Z', NULL, NULL, NULL);
 INSERT INTO public.quote_revisions (id, job_id, job_document_id, version, totals_snapshot_json, released_via, sent_at)
 VALUES ('f15f0000-0000-4000-8000-000000000001', s2, q1, 1, '{"gst":432.1,"total_ex_gst":4321,"total_inc_gst":4753.1}', 'send-quote',
  '2026-10-05 07:29:04Z');
 -- SWMS-261415 shape: builder work, the same insured's email and the same work order (its PO part
 -- differs); the hire and the collection allowance billed and paid on the other job's invoice.
 PERFORM pg_temp.rf_job(m1, 'SWMS-97201', NULL, 'm@example.test', '2026-09-10 00:00Z', 'processing', 'makesafe');
 PERFORM pg_temp.rf_job(m2, 'SWMS-97202', NULL, 'm@example.test', '2026-08-20 00:00Z', 'archived', 'makesafe');
 PERFORM pg_temp.rf_job(m3, 'SWMS-97203', NULL, 'm3@example.test', '2026-08-21 00:00Z', 'archived', 'makesafe');
 PERFORM pg_temp.rf_job(m4, 'SWMS-97204', NULL, 'm4@example.test', '2026-08-22 00:00Z', 'complete', 'makesafe');
 INSERT INTO public.makesafe_job_details (job_id, requesting_company_slug, external_ref)
 VALUES (m1, 'mlb', 'MLB-11111PO-RET14'), (m2, 'mlb', 'MLB-11111PO-22222'), (m3, 'aj', 'MLB 11111'), (m4, NULL, 'MLB-11111');
 INSERT INTO public.xero_invoices (id, org_id, xero_invoice_id, invoice_type, job_id, invoice_number, reference, status, invoice_date, total,
  amount_due, fully_paid_on, line_items, created_at, updated_at)
 VALUES ('f15c0000-0000-4000-8000-000000000201', '00000000-0000-0000-0000-000000000001', 'xi-rf-201', 'ACCREC', m2, 'INV-97201', 'MLB-11111PO-22222',
   'PAID', '2026-08-26', 1110.5, 0, '2026-09-14',
   '[{"Description":"MLB-11111PO-22222 - temporary fencing make-safe - 2 trades x 3 hours","LineAmount":510},
     {"Description":"MLB-11111PO-22222 - Temporary fencing retrieval, collection and loading allowance - 2 hours","LineAmount":180},
     {"Description":"MLB-11111PO-22222 - Temporary fence hire: 5 panels x $5 per panel per week x 12 weeks","LineAmount":300},
     {"Description":"MLB-11111PO-22222 - Star pickets supplied","LineAmount":94.5},
     {"Description":"Cable ties","LineAmount":"25"},
     {"Description":"Line six","LineAmount":1},
     {"Description":"Line seven is past the six shown","LineAmount":1}]', '2026-08-26 01:00Z', '2026-09-14 01:00Z'),
  ('f15c0000-0000-4000-8000-000000000202', '00000000-0000-0000-0000-000000000001', 'xi-rf-202', 'ACCREC', m2, 'INV-97202', 'MLB-11111PO-22222',
   'DRAFT', '2026-09-01', 50, 50, NULL, '[]', '2026-09-01 01:00Z', '2026-09-01 01:00Z'),
  ('f15c0000-0000-4000-8000-000000000203', '00000000-0000-0000-0000-000000000001', 'xi-rf-203', 'ACCPAY', m2, 'BILL-1', NULL,
   'PAID', '2026-08-25', 400, 0, '2026-08-30', '[]', '2026-08-25 01:00Z', '2026-08-30 01:00Z'),
  ('f15c0000-0000-4000-8000-000000000204', '00000000-0000-0000-0000-000000000001', 'xi-rf-204', 'ACCREC', m2, 'INV-97203', 'MLB-11111PO-22222',
   'VOIDED', '2026-08-24', 80, 0, NULL, '[]', '2026-08-24 01:00Z', '2026-08-24 01:00Z'),
  ('f15c0000-0000-4000-8000-000000000205', '00000000-0000-0000-0000-000000000001', 'xi-rf-205', 'ACCREC', m4, 'INV-97204', 'MLB-11111',
   'AUTHORISED', '2026-10-01', 200, 200, NULL, '[]', '2026-10-01 01:00Z', '2026-10-01 01:00Z');
 -- Never by name alone; never a holding job; never our own address; never a job created after as_of.
 PERFORM pg_temp.rf_job(n1, 'SWF-97103', 'rf-ct-n', 'n@example.test', '2026-09-01 00:00Z', 'quoted', 'fencing', 'Pat Example');
 PERFORM pg_temp.rf_job(h1, 'SWF-97104', 'rf-ct-s', NULL, '2026-09-02 00:00Z', 'quoted', 'fencing', 'Bucket', '{"do_not_schedule":"true"}');
 PERFORM pg_temp.rf_job(o1, 'SWF-97105', 'rf-ct-o1', 'office@secureworkswa.com.au', '2026-09-03 00:00Z');
 PERFORM pg_temp.rf_job(o2, 'SWF-97106', 'rf-ct-o2', 'office@secureworkswa.com.au', '2026-09-04 00:00Z');
 PERFORM pg_temp.rf_job(late, 'SWF-97107', 'rf-ct-s', NULL, '2026-10-09 00:00Z');

 -- SWF-261501 shape.
 pk := public.context_ledger_packet(s1, NULL, asof);
 sib := pk -> 'siblings';
 PERFORM pg_temp.rf_assert(jsonb_array_length(sib -> 'jobs') = 1 AND (sib ->> 'more')::integer = 0,
  'SWF-261501 shape: one sibling, nothing left out: ' || coalesce(sib::text, '<missing>'));
 s := sib -> 'jobs' -> 0;
 PERFORM pg_temp.rf_assert(s ->> 'job_number' = 'SWF-97102' AND s ->> 'status' = 'quoted' AND s ->> 'type' = 'fencing'
  AND s -> 'matched_by' = '["contact","email"]'::jsonb AND s -> 'invoices' = '[]'::jsonb,
  'SWF-261501 shape: the sibling, how it matched: ' || s::text);
 PERFORM pg_temp.rf_assert(jsonb_array_length(s -> 'quotes_sent') = 1 AND s -> 'quotes_sent' -> 0 ->> 'number' = 'Q-9701'
  AND (s -> 'quotes_sent' -> 0 ->> 'sent_at')::timestamptz = '2026-10-05 07:29:04Z'
  AND s -> 'quotes_sent' -> 0 -> 'total_inc_gst' = '4753.1'::jsonb AND s -> 'quotes_sent' -> 0 -> 'accepted_at' = 'null'::jsonb
  AND s -> 'quotes_sent' -> 0 ->> 'version' = '1',
  'SWF-261501 shape: the quote sent on the sibling, by as_of (not the one sent after): ' || (s -> 'quotes_sent')::text);
 -- Read later, the second quote is there too, newest first, its total unknown (no revision).
 sib := public.context_ledger_siblings(s1, '2026-10-09 00:00Z');
 s := (SELECT x FROM jsonb_array_elements(sib -> 'jobs') x WHERE x ->> 'job_number' = 'SWF-97102');
 PERFORM pg_temp.rf_assert(s -> 'quotes_sent' -> 0 ->> 'number' = 'Q-9702' AND s -> 'quotes_sent' -> 0 -> 'total_inc_gst' = 'null'::jsonb
  AND s -> 'quotes_sent' -> 1 ->> 'number' = 'Q-9701', 'quotes newest first, as of the instant, a total only from a revision: ' || sib::text);
 -- The job created after the first instant is listed once it exists; the same client's jobs newest first.
 PERFORM pg_temp.rf_assert((SELECT string_agg(x ->> 'job_number', ',' ORDER BY o) FROM jsonb_array_elements(sib -> 'jobs') WITH ORDINALITY y(x, o))
  = 'SWF-97107,SWF-97102', 'a job created after the instant appears only once it exists, newest first: ' || sib::text);
 -- The sibling sees this job in turn (with its own sent quote).
 sib := public.context_ledger_siblings(s2, asof);
 PERFORM pg_temp.rf_assert(sib -> 'jobs' -> 0 ->> 'job_number' = 'SWF-97101' AND sib -> 'jobs' -> 0 -> 'quotes_sent' -> 0 ->> 'number' = 'Q-9700',
  'siblings are mutual: ' || sib::text);

 -- SWMS-261415 shape.
 sib := public.context_ledger_packet(m1, NULL, asof) -> 'siblings';
 PERFORM pg_temp.rf_assert((SELECT string_agg(x ->> 'job_number' || ':' || (x ->> 'matched_by'), ' ' ORDER BY o)
   FROM jsonb_array_elements(sib -> 'jobs') WITH ORDINALITY y(x, o)) = 'SWMS-97202:["email", "work_order"] SWMS-97204:["work_order"]',
  'SWMS-261415 shape: the same insured''s job on the same work order first, then the work order''s other job (another company''s is not): '
  || sib::text);
 s := sib -> 'jobs' -> 0;
 PERFORM pg_temp.rf_assert(s ->> 'status' = 'archived' AND jsonb_array_length(s -> 'invoices') = 1
  AND s -> 'invoices' -> 0 ->> 'number' = 'INV-97201' AND s -> 'invoices' -> 0 ->> 'status' = 'PAID'
  AND s -> 'invoices' -> 0 ->> 'paid_on' = '2026-09-14' AND s -> 'invoices' -> 0 ->> 'invoice_date' = '2026-08-26'
  AND s -> 'invoices' -> 0 -> 'total' = '1110.5'::jsonb AND s -> 'invoices' -> 0 -> 'amount_due' = '0'::jsonb
  AND s -> 'invoices' -> 0 ->> 'reference' = 'MLB-11111PO-22222',
  'SWMS-261415 shape: only the issued customer invoice (no draft, bill or voided one), paid: ' || (s -> 'invoices')::text);
 PERFORM pg_temp.rf_assert(jsonb_array_length(s -> 'invoices' -> 0 -> 'lines') = 6
  AND s -> 'invoices' -> 0 -> 'lines' -> 1 ->> 'what' = 'MLB-11111PO-22222 - Temporary fencing retrieval, collection and loading allowance - 2 hour'
  AND s -> 'invoices' -> 0 -> 'lines' -> 2 -> 'amount' = '300'::jsonb AND s -> 'invoices' -> 0 -> 'lines' -> 4 -> 'amount' = 'null'::jsonb,
  'SWMS-261415 shape: the hire and the collection are named, 6 lines at most, 90 characters, only numeric amounts: '
  || (s -> 'invoices' -> 0 -> 'lines')::text);
 -- As of before the payment, the paid day is not given.
 sib := public.context_ledger_siblings(m1, '2026-09-10 00:00Z');
 PERFORM pg_temp.rf_assert(sib -> 'jobs' -> 0 -> 'invoices' -> 0 -> 'paid_on' = 'null'::jsonb
  AND (SELECT x -> 'invoices' FROM jsonb_array_elements(sib -> 'jobs') x WHERE x ->> 'job_number' = 'SWMS-97204') = '[]'::jsonb,
  'as of an earlier instant: no paid day before it was paid, no invoice made after: ' || sib::text);

 -- Never by name alone, never a holding job, never our own address.
 PERFORM pg_temp.rf_assert(NOT EXISTS (SELECT 1 FROM jsonb_array_elements(public.context_ledger_siblings(s1, '2026-10-09 00:00Z') -> 'jobs') x
   WHERE x ->> 'job_number' IN ('SWF-97103', 'SWF-97104')), 'a job with the same name only, or a holding job, is no sibling');
 PERFORM pg_temp.rf_assert(public.context_ledger_siblings(o1, asof) -> 'jobs' = '[]'::jsonb, 'two jobs sharing our own address are not siblings');
 PERFORM pg_temp.rf_assert(public.context_ledger_siblings(n1, asof) = '{"jobs": [], "more": 0}'::jsonb, 'no sibling: an empty section');

 -- At most 8: the newest 8 of the same client's jobs, the count of the rest.
 PERFORM pg_temp.rf_job(kk, 'SWF-97300', 'rf-ct-k', NULL, '2026-09-01 00:00Z');
 FOR k IN 1 .. 10 LOOP
  PERFORM pg_temp.rf_job(('f1500000-0000-4000-8000-0000000003' || lpad(k::text, 2, '0'))::uuid, 'SWF-973' || lpad(k::text, 2, '0'),
   'rf-ct-k', NULL, '2026-09-01 00:00Z'::timestamptz + make_interval(days => k));
 END LOOP;
 sib := public.context_ledger_siblings(kk, asof);
 PERFORM pg_temp.rf_assert(jsonb_array_length(sib -> 'jobs') = 8 AND (sib ->> 'more')::integer = 2
  AND sib -> 'jobs' -> 0 ->> 'job_number' = 'SWF-97310' AND sib -> 'jobs' -> 7 ->> 'job_number' = 'SWF-97303',
  'at most 8 siblings, newest first, the rest counted: ' || (SELECT string_agg(x ->> 'job_number', ',') FROM jsonb_array_elements(sib -> 'jobs') x));

 -- The work order key: its letters and digits without a trailing purchase order part.
 FOR exp IN SELECT * FROM (VALUES ('MLB-12345PO-67890', 'MLB12345'), ('MLB-12345PO-RET14', 'MLB12345'), ('mlb-12345po-ret14', 'MLB12345'),
   ('AJBR 70001', 'AJBR70001'), ('AJBR-70001', 'AJBR70001'), ('PO20001', 'PO20001'), ('70001', '70001'), ('MLB-MW-12346PO-67891', 'MLB12346'),
   ('MLB-RR-12345', 'MLB12345'), ('mlb rr 12345', 'MLB12345'),
   ('SPOT12345', 'SPOT12345'), ('1234', NULL), ('ABCDEF', NULL), ('', NULL), (NULL, NULL)) v(ref, want) LOOP
  got := public.context_ledger_work_order_key(exp.ref);
  PERFORM pg_temp.rf_assert(got IS NOT DISTINCT FROM exp.want, format('work order key of %L: %s, want %s', exp.ref, got, exp.want));
 END LOOP;
END $c$;
ROLLBACK;

-- 5. The paid day.
BEGIN;
DO $c$
DECLARE w uuid := 'f1500000-0000-4000-8000-000000000041'; r1 uuid := 'f15b0000-0000-4000-8000-000000000401';
 r2 uuid := 'f15b0000-0000-4000-8000-000000000402'; t1 uuid := 'f15b0000-0000-4000-8000-000000000403';
 xp uuid := 'f15c0000-0000-4000-8000-000000000401'; xa uuid := 'f15c0000-0000-4000-8000-000000000402';
 chk jsonb; cl jsonb; res jsonb; k text; it record;
BEGIN
 UPDATE public.automation_switches SET capture = true, attribution = true, extraction = true, all_stop = false WHERE id = 1;
 UPDATE public.context_ledger_settings SET mode = 'shadow', calls_per_day = 50, reader = 'luna-ledger:v1', job_ids = NULL;
 PERFORM pg_temp.rf_job(w, 'SWP-97401', 'rf-ct-p', 'p@example.test', '2026-05-20 00:00Z', 'scheduled', 'patio');
 -- SWP-26373 shape: our text asking for the upfront payment at 12:16 Perth on 8 Sep; the invoice
 -- raised for it on 29 Sep (dated after the request) was paid in full on 8 Sep.
 PERFORM pg_temp.rf_ev(r1, w, 'client.sms_out', 'sms', 'outbound',
  'Once it is signed and the upfront payment of $1,234.50 is received, I will come out to measure up.', '2026-09-08 04:16:12Z',
  pg_temp.rf_roles('job_customer', 'customer', 'outbound'), 'rf-ct-p');
 PERFORM pg_temp.rf_ev(r2, w, 'client.sms_out', 'sms', 'outbound', 'Just a reminder the balance payment is now due for the rework.',
  '2026-09-09 01:00:00Z', pg_temp.rf_roles('job_customer', 'customer', 'outbound'), 'rf-ct-p');
 PERFORM pg_temp.rf_ev(t1, w, 'call.transcript_completed', 'call', 'inbound', 'We will get the frame finished next week thanks',
  '2026-09-10 01:00:00Z', pg_temp.rf_roles('job_customer'), 'rf-ct-p', 'transcribe-call', NULL, '{"ghl_call_id":"rf-ct-p:2026-09-10T01:00:00.000Z"}');
 INSERT INTO public.xero_invoices (id, org_id, xero_invoice_id, invoice_type, job_id, invoice_number, reference, status, invoice_date, due_date,
  total, amount_due, fully_paid_on, created_at, updated_at)
 VALUES (xp, '00000000-0000-0000-0000-000000000001', 'xi-rf-401', 'ACCREC', w, 'INV-97401', 'SWP-97401-FINBAL50', 'PAID', '2026-09-29', '2026-09-29',
   1234.5, 0, '2026-09-08', '2026-09-29 04:17Z', '2026-09-30 04:49Z'),
        (xa, '00000000-0000-0000-0000-000000000001', 'xi-rf-402', 'ACCREC', w, 'INV-97402', 'SWP-97401-DEP50', 'AUTHORISED', '2026-09-08', '2026-09-15',
   500, 500, NULL, '2026-09-08 05:00Z', '2026-09-08 05:00Z');
 -- The item check: the request made at 12:16 Perth closes on the payment recorded that Perth day,
 -- at the end of that day.
 chk := public.context_ledger_check_item(w, pg_temp.rf_item('request', 'closed', 'us',
  'We asked for the upfront payment before measuring and ordering.', pg_temp.rf_cite(r1, 'the upfront payment of $1,234.50 is received'),
  jsonb_build_object('closes_on', 'payment', 'closed_by', pg_temp.rf_cite(xp, NULL, 'xero_invoices'))), 'model');
 PERFORM pg_temp.rf_assert((chk ->> 'ok')::boolean, 'SWP-26373 shape: a request made the day its invoice was paid closes on the payment: ' || chk::text);
 PERFORM pg_temp.rf_assert((chk #>> '{item,closed_at}')::timestamptz = '2026-09-08 15:59:59Z'
  AND (chk #>> '{item,opened_at}')::timestamptz = '2026-09-08 04:16:12Z',
  'it closes at the end of the paid Perth day, whatever the invoice''s date: ' || chk::text);
 -- A paid day before the request's day still never closes it; an unpaid invoice never does.
 PERFORM pg_temp.rf_assert(pg_temp.rf_check(w, pg_temp.rf_item('request', 'closed', 'us', 'We asked for the balance payment.',
   pg_temp.rf_cite(r2, 'the balance payment is now due'),
   jsonb_build_object('closes_on', 'payment', 'closed_by', pg_temp.rf_cite(xp, NULL, 'xero_invoices')))) = 'closing_before_opening',
  'a payment recorded the day before a request never closes it');
 PERFORM pg_temp.rf_assert(pg_temp.rf_check(w, pg_temp.rf_item('request', 'closed', 'us', 'We asked for the deposit payment.',
   pg_temp.rf_cite(r1, 'the upfront payment of $1,234.50 is received'),
   jsonb_build_object('closes_on', 'payment', 'closed_by', pg_temp.rf_cite(xa, NULL, 'xero_invoices')))) = 'closing_not_issued',
  'an unpaid invoice never closes a payment');
 PERFORM pg_temp.rf_assert(public.context_ledger_paid_close_at(NULL) IS NULL
  AND public.context_ledger_paid_close_at('2026-09-07 16:00Z') = '2026-09-08 15:59:59Z'
  AND public.context_ledger_paid_close_at(now() + interval '3 days') <= now(),
  'the end of the paid Perth day, never after now, nothing without a paid day');
 -- The write: the same rule in a transition, and the elsewhere refusal reported by code.
 cl := public.context_ledger_claim(w, 'backfill', (now() AT TIME ZONE 'Australia/Perth')::date);
 PERFORM pg_temp.rf_assert(cl ->> 'outcome' = 'claimed', 'the paid-day job is claimed: ' || cl::text);
 res := public.context_ledger_write((cl ->> 'run_id')::uuid, (cl ->> 'lease_token')::uuid, (cl ->> 'generation_id')::uuid, jsonb_build_array(
  pg_temp.rf_item('request', 'open', 'us', 'We asked for the upfront payment before measuring and ordering.',
   pg_temp.rf_cite(r1, 'the upfront payment of $1,234.50 is received'), '{"closes_on":"payment","ref":"pay"}'),
  pg_temp.rf_item('issue', 'open', 'unknown', 'The call transcript is labelled as not from this job''s customer.',
   pg_temp.rf_cite(t1, 'get the frame finished next week'), '{"ref":"label"}')), '[]', 'luna-ledger:v1');
 PERFORM pg_temp.rf_assert(EXISTS (SELECT 1 FROM jsonb_array_elements(res -> 'accepted') x WHERE x ->> 'ref' = 'pay')
  AND EXISTS (SELECT 1 FROM jsonb_array_elements(res -> 'refused') x WHERE x ->> 'ref' = 'label' AND x ->> 'code' = 'elsewhere_unsupported'),
  'the write accepts the payment request and refuses the claim on the customer''s own call: ' || res::text);
 k := (SELECT x ->> 'item_key' FROM jsonb_array_elements(res -> 'accepted') x WHERE x ->> 'ref' = 'pay');
 res := public.context_ledger_write((cl ->> 'run_id')::uuid, (cl ->> 'lease_token')::uuid, (cl ->> 'generation_id')::uuid, '[]',
  jsonb_build_array(jsonb_build_object('item_key', k, 'to_status', 'closed', 'evidence', pg_temp.rf_cite(xp, NULL, 'xero_invoices'))),
  'luna-ledger:v1');
 PERFORM pg_temp.rf_assert((res ->> 'transitions_accepted')::integer = 1 AND res -> 'transitions_refused' = '[]'::jsonb,
  'SWP-26373 shape: a transition closes the request on the payment recorded the same Perth day: ' || res::text);
 SELECT i.status, i.closed_at INTO it FROM public.context_ledger_items i WHERE i.generation_id = (cl ->> 'generation_id')::uuid AND i.item_key = k;
 PERFORM pg_temp.rf_assert(it.status = 'closed' AND it.closed_at = '2026-09-08 15:59:59Z', format('closed at the end of the paid day: %s', to_jsonb(it)));
END $c$;
ROLLBACK;

-- 6. Re-applying the migration changes nothing (its guard accepts its own bodies).
BEGIN;
CREATE TEMP TABLE rf_md5 AS
 SELECT p.oid::regprocedure::text AS sig, md5(p.prosrc) AS m, obj_description(p.oid, 'pg_proc') AS c, p.proacl::text AS acl FROM pg_proc p
 WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('context_ledger_call_customer', 'context_ledger_check_item', 'context_ledger_write',
  'context_ledger_packet', 'context_ledger_elsewhere_claim', 'context_ledger_paid_close_at', 'context_ledger_work_order_key',
  'context_ledger_row_elsewhere', 'context_ledger_siblings');
\ir ../../../migrations/20261007150000_context_ledger_reader_fixes.sql
DO $c$ BEGIN
 PERFORM pg_temp.rf_assert((SELECT count(*) FROM rf_md5) = 9, 'nine functions before the re-apply');
 PERFORM pg_temp.rf_assert(NOT EXISTS (SELECT 1 FROM rf_md5 b LEFT JOIN pg_proc p ON p.oid = to_regprocedure(b.sig)
   WHERE p.oid IS NULL OR md5(p.prosrc) <> b.m OR obj_description(p.oid, 'pg_proc') IS DISTINCT FROM b.c OR p.proacl::text IS DISTINCT FROM b.acl),
  're-applying changed a body, comment or grant');
END $c$;
ROLLBACK;
