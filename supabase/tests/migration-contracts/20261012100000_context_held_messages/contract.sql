-- Held messages contract: a message placed on no job is read on every job it could belong to, marked
-- job not certain, and nothing about its placement changes. The fixture is SWF-261469's shape with
-- the one thing that job does not have: a second job for the same customer, so her texts fit both.
-- Job numbers, contacts, addresses and words are synthetic. Every fixture is dated at a fixed
-- instant in September and October 2026 and every read is as of a fixed instant, so no answer
-- depends on the clock of the run. Rows are written with session_replication_role replica (no
-- ladder, no who-to-whom stamping), so each states exactly the columns the reads take. Every fixture
-- write is rolled back.
--
--  1. Shape: the two new functions and the two replaced ones (definer and search path, grants,
--     comments).
--  2. The held rows: which rows are a job's (on no job, unplaced or waiting on the review, the job
--     among the candidates, a worded message), which never are (placed, retracted, a marked copy,
--     status-only, not a message, unworded, another writer's, landed later, not this job's
--     candidate), and what each carries.
--  3. The packet: held is context beside the evidence, never in it; a rebuild's and an update's
--     rows; the caps.
--  4. Nothing is placed, counted or citable: the rows stay as they were, the evidence rows and the
--     citation check answer as before.
--  5. The story: held_messages on every candidate job, newest first, marked; none on a job with no
--     held message; none in the records-only read.
--  6. Re-applying the migration changes nothing.
\set ON_ERROR_STOP on

-- 1. Shape.
DO $shape$
DECLARE f text; p record;
BEGIN
 FOREACH f IN ARRAY ARRAY['public.context_ledger_held_rows(uuid[],timestamptz)', 'public.context_job_story_held(uuid,timestamptz)',
  'public.context_ledger_packet(uuid,timestamptz,timestamptz)', 'public.context_job_story(uuid,timestamptz,uuid,timestamptz,boolean)'] LOOP
  IF to_regprocedure(f) IS NULL THEN RAISE EXCEPTION 'held messages contract: % missing', f; END IF;
  IF NOT has_function_privilege('service_role', f, 'EXECUTE') OR has_function_privilege('anon', f, 'EXECUTE')
     OR has_function_privilege('authenticated', f, 'EXECUTE')
     OR EXISTS (SELECT 1 FROM pg_proc pp, aclexplode(coalesce(pp.proacl, acldefault('f', pp.proowner))) a
                WHERE pp.oid = to_regprocedure(f) AND a.grantee = 0 AND a.privilege_type = 'EXECUTE') THEN
   RAISE EXCEPTION 'held messages contract: % must be executable by the service role only', f;
  END IF;
  SELECT pp.prosecdef, pp.provolatile, pp.proconfig INTO p FROM pg_proc pp WHERE pp.oid = to_regprocedure(f);
  IF NOT p.prosecdef OR p.provolatile <> 's' OR p.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp'] THEN
   RAISE EXCEPTION 'held messages contract: % must be a STABLE definer with search_path public, pg_temp', f;
  END IF;
 END LOOP;
 FOR p IN SELECT * FROM (VALUES
   ('public.context_ledger_held_rows(uuid[],timestamptz)', 'Held messages (20261012100000): %'),
   ('public.context_job_story_held(uuid,timestamptz)', 'Held messages (20261012100000): %'),
   ('public.context_ledger_packet(uuid,timestamptz,timestamptz)',
    'Context ledger store (20261006013000), ledger reader fixes (20261007150000): (held messages, 20261012100000) %'),
   ('public.context_job_story(uuid,timestamptz,uuid,timestamptz,boolean)',
    'Job story (20261006014000), lead cutoff (20261007010000): (story settled notes, 20261011120000) (held messages, 20261012100000) %')) v(sig, cmt) LOOP
  IF coalesce(obj_description(to_regprocedure(p.sig), 'pg_proc'), '') NOT LIKE p.cmt THEN
   RAISE EXCEPTION 'held messages contract: the % comment does not keep its slices first', p.sig;
  END IF;
 END LOOP;
END $shape$;

BEGIN;
-- The later story-card read changes are reversed only inside this contract's transaction.
SELECT to_regprocedure('public.context_job_story_payment_terms(jsonb)') IS NOT NULL AS story_card_causes_live \gset
\if :story_card_causes_live
-- (held notes, 20261015100000) replaced the judge, the item check, the story's ledger read, the packet and
-- the story since: its down goes first, inside this transaction only.
SELECT to_regprocedure('public.context_ledger_held_cite(uuid,jsonb)') IS NOT NULL AS held_notes_live \gset
\if :held_notes_live
\ir ../../../rollbacks/20261015100000_context_held_notes_down.sql
\endif
\ir ../../../rollbacks/20261014120000_context_story_card_causes_down.sql
\endif
SET LOCAL session_replication_role = replica;
CREATE FUNCTION pg_temp.hm_assert(p_ok boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'held messages contract: %', p_msg; END IF; END $$;
-- The ids of a JSON list of rows, in the list's own order.
CREATE FUNCTION pg_temp.hm_ids(p_rows jsonb) RETURNS text LANGUAGE sql AS $$
 SELECT coalesce(string_agg(right(x ->> 'id', 2), ',' ORDER BY o), '') FROM jsonb_array_elements(p_rows) WITH ORDINALITY y(x, o) $$;
-- A who-to-whom stamp as the classifier writes it for a customer with several jobs.
CREATE FUNCTION pg_temp.hm_roles(p_direction text) RETURNS jsonb LANGUAGE sql AS $$
 SELECT jsonb_build_object('party_roles', jsonb_build_object('version', 'party_roles_v4', 'basis', 'any_job_customer',
  'counterpart_role', 'customer', 'audience', 'customer',
  'sender_role', CASE WHEN p_direction = 'inbound' THEN 'customer' ELSE 'staff' END,
  'recipient_role', CASE WHEN p_direction = 'inbound' THEN 'staff' ELSE 'customer' END)) $$;

-- A: SWF-261469's shape (fencing, installed, in dispute). B: the same customer's second fence, quoted.
-- C: another customer with one job and no held message. D and F: two jobs at one address, another
-- customer's each. E: a third job of A's customer, never A's candidate here.
INSERT INTO public.jobs (id, org_id, job_number, status, type, client_name, client_email, ghl_contact_id, pricing_json, created_at, updated_at)
VALUES ('72000000-0000-4000-8000-000000261469', '00000000-0000-4000-8000-0000000000aa', 'SWF-961469', 'in_progress', 'fencing', 'Held HM',
        'held.hm@example.test', 'ct-hm-a', '{}', '2026-09-22 00:00Z', '2026-09-22 00:00Z'),
       ('72000000-0000-4000-8000-000000261470', '00000000-0000-4000-8000-0000000000aa', 'SWF-961470', 'quoted', 'fencing', 'Held HM',
        'held.hm@example.test', 'ct-hm-a', '{}', '2026-10-01 00:00Z', '2026-10-01 00:00Z'),
       ('72000000-0000-4000-8000-000000261471', '00000000-0000-4000-8000-0000000000aa', 'SWF-961471', 'in_progress', 'fencing', 'Single HM',
        'single.hm@example.test', 'ct-hm-c', '{}', '2026-09-22 00:00Z', '2026-09-22 00:00Z'),
       ('72000000-0000-4000-8000-000000261472', '00000000-0000-4000-8000-0000000000aa', 'SWP-961472', 'in_progress', 'patio', 'Address HM',
        'address.hm@example.test', 'ct-hm-d', '{}', '2026-09-22 00:00Z', '2026-09-22 00:00Z'),
       ('72000000-0000-4000-8000-000000261473', '00000000-0000-4000-8000-0000000000aa', 'SWF-961473', 'accepted', 'fencing', 'Held HM',
        'held.hm@example.test', 'ct-hm-a', '{}', '2026-10-02 00:00Z', '2026-10-02 00:00Z'),
       ('72000000-0000-4000-8000-000000261474', '00000000-0000-4000-8000-0000000000aa', 'SWF-961474', 'quoted', 'fencing', 'Other Address HM',
        'other.address.hm@example.test', 'ct-hm-f', '{}', '2026-09-22 00:00Z', '2026-09-22 00:00Z');

INSERT INTO public.business_events (id, job_id, event_type, source, channel, direction, contact_id, provider_message_id, payload, metadata,
  occurred_at, recorded_at, event_at, context_captured_at, attribution_status, attribution_confidence, attributed_at, candidate_job_ids)
VALUES
 -- 01 on job A, as before: evidence, never held
 ('72b00000-0000-4000-8000-000000000001', '72000000-0000-4000-8000-000000261469', 'client.sms_in', 'ghl', 'sms', 'inbound', 'ct-hm-a', 'ghl:hm-01',
  '{"body":"Is Friday still on for the install?"}', '{"written_as":"service_role"}',
  '2026-10-08 01:00Z', '2026-10-08 01:00Z', '2026-10-08 01:00Z', '2026-10-08 01:00Z', 'direct', 1, '2026-10-08 01:00Z', NULL),
 -- 02 her text that fits both of her jobs: held
 ('72b00000-0000-4000-8000-000000000002', NULL, 'client.sms_in', 'ghl', 'sms', 'inbound', 'ct-hm-a', 'ghl:hm-02',
  '{"body":"When are you coming back to finish?"}', '{"written_as":"service_role","placement_rule":"review_several"}'::jsonb || pg_temp.hm_roles('inbound'),
  '2026-10-09 02:00Z', '2026-10-09 02:00Z', '2026-10-09 02:00Z', '2026-10-09 02:00Z', 'unplaced', NULL, NULL,
  ARRAY['72000000-0000-4000-8000-000000261469', '72000000-0000-4000-8000-000000261470']::uuid[]),
 -- 03 our reply to it: held
 ('72b00000-0000-4000-8000-000000000003', NULL, 'client.sms_out', 'ghl', 'sms', 'outbound', 'ct-hm-a', 'ghl:hm-03',
  '{"body":"We will be back Monday morning."}', '{"written_as":"service_role","placement_rule":"review_several"}'::jsonb || pg_temp.hm_roles('outbound'),
  '2026-10-09 03:00Z', '2026-10-09 03:00Z', '2026-10-09 03:00Z', '2026-10-09 03:00Z', 'unplaced', NULL, NULL,
  ARRAY['72000000-0000-4000-8000-000000261469', '72000000-0000-4000-8000-000000261470']::uuid[]),
 -- 04 a later text of hers, waiting on the placement review: held
 ('72b00000-0000-4000-8000-000000000004', NULL, 'client.sms_in', 'ghl', 'sms', 'inbound', 'ct-hm-a', 'ghl:hm-04',
  '{"body":"Also can you bring the gate latch?"}', '{"written_as":"service_role","placement_rule":"review_recent_other_job"}'::jsonb || pg_temp.hm_roles('inbound'),
  '2026-10-10 01:00Z', '2026-10-10 01:00Z', '2026-10-10 01:00Z', '2026-10-10 01:00Z', 'pending_luna', NULL, NULL,
  ARRAY['72000000-0000-4000-8000-000000261469', '72000000-0000-4000-8000-000000261470']::uuid[]),
 -- 05 sent before the read, landed after it: held only once it has landed
 ('72b00000-0000-4000-8000-000000000005', NULL, 'client.sms_in', 'ghl', 'sms', 'inbound', 'ct-hm-a', 'ghl:hm-05',
  '{"body":"Any update on Monday?"}', '{"written_as":"service_role","placement_rule":"review_several"}'::jsonb || pg_temp.hm_roles('inbound'),
  '2026-10-11 03:00Z', '2026-10-11 05:00Z', '2026-10-11 03:00Z', '2026-10-11 05:00Z', 'unplaced', NULL, NULL,
  ARRAY['72000000-0000-4000-8000-000000261469', '72000000-0000-4000-8000-000000261470']::uuid[]),
 -- 06 retracted: never
 ('72b00000-0000-4000-8000-000000000006', NULL, 'client.sms_in', 'ghl', 'sms', 'inbound', 'ct-hm-a', 'ghl:hm-06',
  '{"body":"Sent to the wrong number, ignore."}', '{"written_as":"service_role","placement_rule":"review_several","retracted":"true"}',
  '2026-10-09 04:00Z', '2026-10-09 04:00Z', '2026-10-09 04:00Z', '2026-10-09 04:00Z', 'unplaced', NULL, NULL,
  ARRAY['72000000-0000-4000-8000-000000261469', '72000000-0000-4000-8000-000000261470']::uuid[]),
 -- 07 a marked copy of 02: never
 ('72b00000-0000-4000-8000-000000000007', NULL, 'client.sms_in', 'ghl_sms_copy', 'sms', 'inbound', 'ct-hm-a', 'ghl:hm-07',
  '{"body":"When are you coming back to finish?"}', '{"written_as":"service_role","placement_rule":"review_several","duplicate_of":"72b00000-0000-4000-8000-000000000002"}',
  '2026-10-09 02:00Z', '2026-10-09 02:01Z', '2026-10-09 02:00Z', '2026-10-09 02:01Z', 'unplaced', NULL, NULL,
  ARRAY['72000000-0000-4000-8000-000000261469', '72000000-0000-4000-8000-000000261470']::uuid[]),
 -- 08 a workflow text (status-only): never
 ('72b00000-0000-4000-8000-000000000008', NULL, 'client.sms_out', 'ghl', 'sms', 'outbound', 'ct-hm-a', 'ghl:hm-08',
  '{"body":"Thanks for choosing us.","sent_by_kind":"workflow"}', '{"written_as":"service_role","placement_rule":"review_several"}',
  '2026-10-09 05:00Z', '2026-10-09 05:00Z', '2026-10-09 05:00Z', '2026-10-09 05:00Z', 'unplaced', NULL, NULL,
  ARRAY['72000000-0000-4000-8000-000000261469', '72000000-0000-4000-8000-000000261470']::uuid[]),
 -- 09 not a message (a make-safe reconcile row): never
 ('72b00000-0000-4000-8000-000000000009', NULL, 'makesafe.reconcile.ambiguous', 'makesafe-reconcile', NULL, 'system', NULL, NULL,
  '{"body":"Two cards share this reference."}', '{"written_as":"service_role","placement_rule":"multi_ref"}',
  '2026-10-09 06:00Z', '2026-10-09 06:00Z', '2026-10-09 06:00Z', '2026-10-09 06:00Z', 'unplaced', NULL, NULL,
  ARRAY['72000000-0000-4000-8000-000000261469', '72000000-0000-4000-8000-000000261470']::uuid[]),
 -- 10 fits her other two jobs, not A: never on A, held on B
 ('72b00000-0000-4000-8000-000000000010', NULL, 'client.sms_in', 'ghl', 'sms', 'inbound', 'ct-hm-a', 'ghl:hm-10',
  '{"body":"Can the second fence be cream?"}', '{"written_as":"service_role","placement_rule":"review_several"}'::jsonb || pg_temp.hm_roles('inbound'),
  '2026-10-09 07:00Z', '2026-10-09 07:00Z', '2026-10-09 07:00Z', '2026-10-09 07:00Z', 'unplaced', NULL, NULL,
  ARRAY['72000000-0000-4000-8000-000000261470', '72000000-0000-4000-8000-000000261473']::uuid[]),
 -- 11 no words: never
 ('72b00000-0000-4000-8000-000000000011', NULL, 'client.sms_in', 'ghl', 'sms', 'inbound', 'ct-hm-a', 'ghl:hm-11',
  '{"body":""}', '{"written_as":"service_role","placement_rule":"review_several"}',
  '2026-10-09 08:00Z', '2026-10-09 08:00Z', '2026-10-09 08:00Z', '2026-10-09 08:00Z', 'unplaced', NULL, NULL,
  ARRAY['72000000-0000-4000-8000-000000261469', '72000000-0000-4000-8000-000000261470']::uuid[]),
 -- 12 not our own writer's row: never
 ('72b00000-0000-4000-8000-000000000012', NULL, 'client.sms_in', 'ghl', 'sms', 'inbound', 'ct-hm-a', 'ghl:hm-12',
  '{"body":"Written through a browser session."}', '{"written_as":"authenticated","placement_rule":"review_several"}',
  '2026-10-09 09:00Z', '2026-10-09 09:00Z', '2026-10-09 09:00Z', '2026-10-09 09:00Z', 'unplaced', NULL, NULL,
  ARRAY['72000000-0000-4000-8000-000000261469', '72000000-0000-4000-8000-000000261470']::uuid[]),
 -- 13 an email from an address that fits two jobs at one site, from neither job's customer
 ('72b00000-0000-4000-8000-000000000013', NULL, 'client.email_in', 'graph', 'email', 'inbound', NULL, 'graph:hm-13',
  '{"body":"The side gate will be unlocked on Tuesday.","subject":"Access on Tuesday","from":"Strata Office <strata.hm@example.test>"}',
  '{"written_as":"service_role","placement_rule":"site_address_several"}',
  '2026-10-09 10:00Z', '2026-10-09 10:00Z', '2026-10-09 10:00Z', '2026-10-09 10:00Z', 'unplaced', NULL, NULL,
  ARRAY['72000000-0000-4000-8000-000000261472', '72000000-0000-4000-8000-000000261474']::uuid[]),
 -- 14 a long call recording of hers that fits both jobs: held, its words capped for the reader
 ('72b00000-0000-4000-8000-000000000014', NULL, 'call.transcript_completed', 'ghl-call-transcript', 'call', 'inbound', 'ct-hm-a', 'ghltx:hm-14',
  jsonb_build_object('ghl_call_id', 'hm-14', 'transcript', repeat('She asked when the fence would be finished. ', 100)),
  '{"written_as":"service_role","placement_rule":"review_several"}'::jsonb || pg_temp.hm_roles('inbound'),
  '2026-10-10 02:00Z', '2026-10-10 02:10Z', '2026-10-10 02:00Z', '2026-10-10 02:10Z', 'unplaced', NULL, NULL,
  ARRAY['72000000-0000-4000-8000-000000261469', '72000000-0000-4000-8000-000000261470']::uuid[]);

-- The rows as they stand before any read, to prove afterwards that nothing moved.
CREATE TEMP TABLE hm_before ON COMMIT DROP AS
 SELECT e.id, md5(to_jsonb(e)::text) AS m FROM public.business_events e WHERE e.id::text LIKE '72b00000-%';

DO $held$
DECLARE
 a constant uuid := '72000000-0000-4000-8000-000000261469'; b constant uuid := '72000000-0000-4000-8000-000000261470';
 c constant uuid := '72000000-0000-4000-8000-000000261471'; d constant uuid := '72000000-0000-4000-8000-000000261472';
 asof constant timestamptz := '2026-10-11T04:00:00Z'; later constant timestamptz := '2026-10-11T06:00:00Z';
 r record; p jsonb; u jsonb; s jsonb; h jsonb; x jsonb; n int;
BEGIN
 -- 2. The held rows. Job A: 02, 03, 04 and 14, oldest first; nothing else.
 PERFORM pg_temp.hm_assert((SELECT string_agg(right(t.src_id::text, 2), ',' ORDER BY t.at, t.src_id)
   FROM public.context_ledger_held_rows(ARRAY[a], asof) t) = '02,03,04,14', 'job A holds 02, 03, 04 and 14, oldest first');
 -- once 05 has landed it is held too
 PERFORM pg_temp.hm_assert((SELECT string_agg(right(t.src_id::text, 2), ',' ORDER BY t.at, t.src_id)
   FROM public.context_ledger_held_rows(ARRAY[a], later) t) = '02,03,04,14,05', 'a row is held once it has landed');
 -- job B: the same four, and 10, which never fits A
 PERFORM pg_temp.hm_assert((SELECT string_agg(right(t.src_id::text, 2), ',' ORDER BY t.at, t.src_id)
   FROM public.context_ledger_held_rows(ARRAY[b], asof) t) = '02,03,10,04,14', 'job B holds the same rows and its own');
 -- a customer with one job and no held message has none; two jobs asked for at once, each its own
 PERFORM pg_temp.hm_assert((SELECT count(*) FROM public.context_ledger_held_rows(ARRAY[c], asof)) = 0, 'a job with no held message has none');
 PERFORM pg_temp.hm_assert((SELECT count(*) FILTER (WHERE t.job_id = a) = 4 AND count(*) FILTER (WHERE t.job_id = b) = 5 AND count(*) = 9
   FROM public.context_ledger_held_rows(ARRAY[a, b, c], asof) t), 'each job asked for gets its own rows, a shared row once for each');
 -- what a row carries
 SELECT * INTO r FROM public.context_ledger_held_rows(ARRAY[a], asof) t WHERE right(t.src_id::text, 2) = '02';
 PERFORM pg_temp.hm_assert(r.src_table = 'business_events' AND r.channel = 'sms' AND r.kind = 'client.sms_in' AND r.direction = 'inbound'
   AND r.body = 'When are you coming back to finish?' AND r.sender = 'Held HM' AND r.sender_role = 'customer'
   AND r.role_basis = 'any_job_customer' AND r.same_contact AND NOT r.ours AND NOT r.automated
   AND r.held_rule = 'review_several' AND r.held_status = 'unplaced' AND r.candidate_jobs = 2 AND r.other_jobs = ARRAY['SWF-961470'],
   format('row 02 on job A: %s', to_jsonb(r)));
 SELECT * INTO r FROM public.context_ledger_held_rows(ARRAY[b], asof) t WHERE right(t.src_id::text, 2) = '02';
 PERFORM pg_temp.hm_assert(r.other_jobs = ARRAY['SWF-961469'] AND r.same_contact, 'on job B the same row names job A as the other');
 SELECT * INTO r FROM public.context_ledger_held_rows(ARRAY[a], asof) t WHERE right(t.src_id::text, 2) = '03';
 PERFORM pg_temp.hm_assert(r.ours AND r.direction = 'outbound' AND r.recipient = 'Held HM', format('our reply 03: %s', to_jsonb(r)));
 SELECT * INTO r FROM public.context_ledger_held_rows(ARRAY[a], asof) t WHERE right(t.src_id::text, 2) = '04';
 PERFORM pg_temp.hm_assert(r.held_status = 'pending_luna' AND r.held_rule = 'review_recent_other_job', 'a row waiting on the review is held too');
 -- the address-held email is not from job D's customer
 SELECT * INTO r FROM public.context_ledger_held_rows(ARRAY[d], asof) t;
 PERFORM pg_temp.hm_assert(right(r.src_id::text, 2) = '13' AND NOT r.same_contact AND r.held_rule = 'site_address_several'
   AND r.subject = 'Access on Tuesday' AND r.other_jobs = ARRAY['SWF-961474'], format('the address-held email on job D: %s', to_jsonb(r)));

 -- 3. The packet. A rebuild: held is the four, oldest first, beside the evidence and never in it.
 p := public.context_ledger_packet(a, NULL, asof);
 h := p -> 'held';
 PERFORM pg_temp.hm_assert(p ->> 'version' = 'ledger-packet-v1' AND h ->> 'certainty' = 'job_not_certain'
   AND (h ->> 'total')::int = 4 AND (h ->> 'new')::int = 4 AND (h ->> 'not_shown')::int = 0
   AND pg_temp.hm_ids(h -> 'rows') = '02,03,04,14', format('the packet holds the four, oldest first: %s', h - 'rows'));
 PERFORM pg_temp.hm_assert(pg_temp.hm_ids(p -> 'evidence') = '01' AND (p ->> 'evidence_rows')::int = 1
   AND (p ->> 'evidence_until')::timestamptz = '2026-10-08 01:00Z',
   format('the evidence is the placed row alone, and its counts and newest time are its own: %s %s', p -> 'evidence_rows', p -> 'evidence_until'));
 SELECT y INTO x FROM jsonb_array_elements(h -> 'rows') y WHERE right(y ->> 'id', 2) = '02';
 PERFORM pg_temp.hm_assert(x ->> 'table' = 'business_events' AND x ->> 'placed_on' = 'none' AND x ->> 'certainty' = 'job_not_certain'
   AND (x ->> 'from_this_customer')::boolean AND x ->> 'held_rule' = 'review_several' AND (x ->> 'candidate_jobs')::int = 2
   AND x -> 'other_jobs' = '["SWF-961470"]'::jsonb AND x ->> 'text' = 'When are you coming back to finish?'
   AND NOT (x ->> 'already_read')::boolean AND x ->> 'sender_role' = 'customer' AND x ->> 'sender' = 'Held HM',
   format('a held packet row is marked job not certain: %s', x));
 -- a long recording's words are capped at 3,000 characters, a text's at 1,500
 SELECT y INTO x FROM jsonb_array_elements(h -> 'rows') y WHERE right(y ->> 'id', 2) = '14';
 PERFORM pg_temp.hm_assert(length(x ->> 'text') = 3000, 'a held recording is capped at 3,000 characters');
 -- an update: only what landed after since, with the newest given before to read it by
 u := public.context_ledger_packet(a, '2026-10-10T01:30:00Z', asof) -> 'held';
 PERFORM pg_temp.hm_assert((u ->> 'total')::int = 4 AND (u ->> 'new')::int = 1 AND (u ->> 'not_shown')::int = 0
   AND pg_temp.hm_ids(u -> 'rows') = '02,03,04,14'
   AND (SELECT bool_and((y ->> 'already_read')::boolean = (right(y ->> 'id', 2) <> '14')) FROM jsonb_array_elements(u -> 'rows') y),
   format('an update is given the new row and the ones before it marked already read: %s', u));
 -- an update with nothing new is given none
 u := public.context_ledger_packet(a, '2026-10-10T03:00:00Z', asof) -> 'held';
 PERFORM pg_temp.hm_assert((u ->> 'total')::int = 4 AND (u ->> 'new')::int = 0 AND (u ->> 'not_shown')::int = 4
   AND u -> 'rows' = '[]'::jsonb, format('an update with no new held row is given none: %s', u));
 -- a job with none: an empty section, and the rest of its packet as it was
 u := public.context_ledger_packet(c, NULL, asof);
 PERFORM pg_temp.hm_assert(u -> 'held' = '{"certainty":"job_not_certain","total":0,"new":0,"not_shown":0,"rows":[]}'::jsonb
   AND u ? 'siblings' AND u ? 'open_items' AND u ? 'parties', format('a job with no held message: %s', u -> 'held'));
 -- a rebuild is given the newest 40: 45 more of her texts held on A
 INSERT INTO public.business_events (id, job_id, event_type, source, channel, direction, contact_id, payload, metadata,
   occurred_at, recorded_at, event_at, context_captured_at, attribution_status, candidate_job_ids)
 SELECT ('72b10000-0000-4000-8000-0000000001' || lpad(g::text, 2, '0'))::uuid, NULL, 'client.sms_in', 'ghl', 'sms', 'inbound', 'ct-hm-a',
   jsonb_build_object('body', 'Earlier text ' || g), '{"written_as":"service_role","placement_rule":"review_several"}',
   '2026-10-01 00:00Z'::timestamptz + g * interval '1 hour', '2026-10-01 00:00Z'::timestamptz + g * interval '1 hour',
   '2026-10-01 00:00Z'::timestamptz + g * interval '1 hour', '2026-10-01 00:00Z'::timestamptz + g * interval '1 hour', 'unplaced', ARRAY[a, b]
 FROM generate_series(1, 45) g;
 u := public.context_ledger_packet(a, NULL, asof) -> 'held';
 PERFORM pg_temp.hm_assert((u ->> 'total')::int = 49 AND (u ->> 'not_shown')::int = 9 AND jsonb_array_length(u -> 'rows') = 40
   AND u -> 'rows' -> 0 ->> 'text' = 'Earlier text 10' AND right(u -> 'rows' -> 39 ->> 'id', 2) = '14',
   format('a rebuild is given the newest 40 of 49, oldest first: %s', u - 'rows'));
 -- and the story shows the newest 25 of them
 s := public.context_job_story(a, asof) -> 'held_messages';
 PERFORM pg_temp.hm_assert((s ->> 'count')::int = 49 AND (s ->> 'shown')::int = 25 AND jsonb_array_length(s -> 'items') = 25
   AND right(s -> 'items' -> 0 ->> 'id', 2) = '14' AND s -> 'items' -> 24 ->> 'text' = 'Earlier text 25',
   format('the story shows the newest 25 of 49, newest first: %s', s - 'items'));
 DELETE FROM public.business_events e WHERE e.id::text LIKE '72b10000-%';

 -- 4. Nothing is placed, counted or citable.
 PERFORM pg_temp.hm_assert((SELECT string_agg(right(t.src_id::text, 2), ',' ORDER BY t.at, t.src_id)
   FROM public.context_ledger_evidence_rows(ARRAY[a], asof) t) = '01', 'the evidence rows are the placed row alone');
 x := public.context_ledger_cite(a, '{"table":"business_events","id":"72b00000-0000-4000-8000-000000000002","excerpt":"When are you coming back to finish?"}');
 PERFORM pg_temp.hm_assert(NOT (x ->> 'ok')::boolean AND x ->> 'code' = 'citation_off_job', format('a held row is never citable: %s', x));
 PERFORM pg_temp.hm_assert((SELECT count(*) FROM public.context_unplaced_for_job(a) t WHERE t.id::text LIKE '72b00000-%') = 11,
   'the placement queue still holds every row it held (the story''s unplaced count is its own)');

 -- 5. The story. Job A: her messages, newest first, every one marked.
 s := public.context_job_story(a, asof);
 h := s -> 'held_messages';
 PERFORM pg_temp.hm_assert(s ->> 'version' = 'job-story-v1' AND h ->> 'label' = 'From this customer, job not certain'
   AND h ->> 'certainty' = 'job_not_certain' AND (h ->> 'count')::int = 4 AND (h ->> 'shown')::int = 4
   AND pg_temp.hm_ids(h -> 'items') = '14,04,03,02' AND h -> 'other_jobs' = '["SWF-961470"]'::jsonb
   AND (h ->> 'newest_at')::timestamptz = '2026-10-10 02:00Z' AND (h ->> 'oldest_at')::timestamptz = '2026-10-09 02:00Z'
   AND (h ->> 'newest_customer_at')::timestamptz = '2026-10-10 02:00Z' AND h ->> 'why' LIKE 'These messages are placed on no job%',
   format('job A''s story carries her held messages, newest first: %s', h - 'items'));
 SELECT y INTO x FROM jsonb_array_elements(h -> 'items') y WHERE right(y ->> 'id', 2) = '02';
 PERFORM pg_temp.hm_assert(x ->> 't' = 'business_events' AND NOT (x ->> 'job_certain')::boolean
   AND x ->> 'label' = 'from this customer, job not certain' AND (x ->> 'from_this_customer')::boolean
   AND x ->> 'text' = 'When are you coming back to finish?' AND NOT (x ->> 'cut')::boolean AND x ->> 'from' = 'Held HM'
   AND x ->> 'held_rule' = 'review_several' AND x ->> 'held_because' = 'the customer has several jobs'
   AND (x ->> 'candidate_jobs')::int = 2 AND x -> 'other_jobs' = '["SWF-961470"]'::jsonb, format('a held story item: %s', x));
 SELECT y INTO x FROM jsonb_array_elements(h -> 'items') y WHERE right(y ->> 'id', 2) = '14';
 PERFORM pg_temp.hm_assert(length(x ->> 'text') = 400 AND (x ->> 'cut')::boolean, 'a long held message is cut at 400 characters and says so');
 PERFORM pg_temp.hm_assert((SELECT y ->> 'held_because' FROM jsonb_array_elements(h -> 'items') y WHERE right(y ->> 'id', 2) = '04')
   = 'the customer has another recent job', 'each rule is said in words');
 -- held_messages is the one key added: every other part is the assembler's, as on a job with none
 PERFORM pg_temp.hm_assert((SELECT array_agg(k ORDER BY k COLLATE "C") FROM jsonb_object_keys(s - 'held_messages') k)
   = (SELECT array_agg(k ORDER BY k COLLATE "C") FROM jsonb_object_keys(public.context_job_story(c, asof)) k)
   AND NOT (s -> 'meta') ? 'held_messages', 'held_messages is the one key added');
 -- job B: the same messages, naming job A, and its own
 h := public.context_job_story(b, asof) -> 'held_messages';
 PERFORM pg_temp.hm_assert((h ->> 'count')::int = 5 AND pg_temp.hm_ids(h -> 'items') = '14,04,10,03,02'
   AND h -> 'other_jobs' = '["SWF-961469", "SWF-961473"]'::jsonb, format('job B''s story carries the same messages: %s', h - 'items'));
 -- the address-held email is not called this customer's
 h := public.context_job_story(d, asof) -> 'held_messages';
 PERFORM pg_temp.hm_assert(h ->> 'label' = 'May be about this job, job not certain' AND (h ->> 'count')::int = 1
   AND h -> 'items' -> 0 ->> 'label' = 'may be about this job, job not certain' AND NOT (h -> 'items' -> 0 ->> 'from_this_customer')::boolean
   AND h -> 'items' -> 0 ->> 'held_because' = 'the address fits several jobs' AND h -> 'items' -> 0 ->> 'subject' = 'Access on Tuesday'
   AND h -> 'newest_customer_at' = 'null'::jsonb, format('the address-held email on job D: %s', h));
 -- a job with no held message reads exactly as before: no key at all
 s := public.context_job_story(c, asof);
 PERFORM pg_temp.hm_assert(s ->> 'version' = 'job-story-v1' AND NOT s ? 'held_messages', 'a job with no held message has no held_messages key');
 PERFORM pg_temp.hm_assert(public.context_job_story_held(c, asof) IS NULL, 'and the helper answers null for it');
 -- the records-only read the reader's own prompt takes never carries them
 s := public.context_job_story(a, asof, NULL, NULL, true);
 PERFORM pg_temp.hm_assert(s ->> 'version' = 'job-story-v1' AND NOT s ? 'held_messages', 'the records-only read carries no held message');
 -- an unknown job is still null
 PERFORM pg_temp.hm_assert(public.context_job_story('72000000-0000-4000-8000-00000000dead', asof) IS NULL, 'an unknown job is null');

 -- 4 again, after every read: no row moved, was placed or was changed.
 PERFORM pg_temp.hm_assert(NOT EXISTS (SELECT 1 FROM hm_before t JOIN public.business_events e ON e.id = t.id WHERE md5(to_jsonb(e)::text) <> t.m)
   AND (SELECT count(*) FROM public.business_events e WHERE e.id::text LIKE '72b00000-%') = (SELECT count(*) FROM hm_before)
   AND (SELECT count(*) FROM public.business_events e WHERE e.id::text LIKE '72b00000-%' AND e.job_id IS NOT NULL) = 1,
   'no row was placed or changed by any read');
END $held$;
ROLLBACK;

-- 6. Re-applying the migration changes nothing (its guard accepts its own bodies).
BEGIN;
-- The later story-card read changes are reversed only inside this contract's transaction.
SELECT to_regprocedure('public.context_job_story_payment_terms(jsonb)') IS NOT NULL AS story_card_causes_live \gset
\if :story_card_causes_live
-- (held notes, 20261015100000) replaced the judge, the item check, the story's ledger read, the packet and
-- the story since: its down goes first, inside this transaction only.
SELECT to_regprocedure('public.context_ledger_held_cite(uuid,jsonb)') IS NOT NULL AS held_notes_live \gset
\if :held_notes_live
\ir ../../../rollbacks/20261015100000_context_held_notes_down.sql
\endif
\ir ../../../rollbacks/20261014120000_context_story_card_causes_down.sql
\endif
CREATE TEMP TABLE held_messages_md5 AS
 SELECT p.oid::regprocedure::text AS sig, md5(p.prosrc) AS m, obj_description(p.oid, 'pg_proc') AS c FROM pg_proc p
 WHERE p.oid IN (to_regprocedure('public.context_ledger_held_rows(uuid[],timestamptz)'), to_regprocedure('public.context_job_story_held(uuid,timestamptz)'),
                 to_regprocedure('public.context_ledger_packet(uuid,timestamptz,timestamptz)'),
                 to_regprocedure('public.context_job_story(uuid,timestamptz,uuid,timestamptz,boolean)'));
\ir ../../../migrations/20261012100000_context_held_messages.sql
DO $again$
BEGIN
 IF EXISTS (SELECT 1 FROM held_messages_md5 t JOIN pg_proc p ON p.oid = to_regprocedure(t.sig)
            WHERE md5(p.prosrc) IS DISTINCT FROM t.m OR obj_description(p.oid, 'pg_proc') IS DISTINCT FROM t.c)
    OR (SELECT count(*) FROM held_messages_md5) <> 4 THEN
  RAISE EXCEPTION 'held messages contract: re-applying changed a body or comment';
 END IF;
END $again$;
ROLLBACK;
