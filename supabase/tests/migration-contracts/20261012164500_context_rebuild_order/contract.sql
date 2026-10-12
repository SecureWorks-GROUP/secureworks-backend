-- Contract for 20261012164500_context_rebuild_order: the owner's go of 12 Oct 2026. Among the
-- rebuilds due for a changed reader, the job whose customer wrote most recently is listed first.
-- Failing first: section 1 runs first, reads only the due list, which exists before this
-- migration, and fails on its earlier body (break-contract.sql runs this migration's rollback and
-- expects section 1's order check to fail).
--  1. The order (instants relative to now, since the judge judges now). Thirteen jobs:
--     * reader-change rebuilds (a live reading by the earlier reader, everything read unless said):
--       the customer's call yesterday (F), text 2 days ago (A), email 3 days ago (G), text 20 days
--       ago with our own text 18 hours ago (B); never a customer message: our own text not read yet (C); a
--       supplier's mail, a crew member's text and a marked copy of a customer text an hour ago (E);
--       our own text 5 days ago (D);
--     * two updates (U2 waiting 3 hours, U1 waiting 1 hour), a late-evidence rebuild (L), two jobs
--       never read (N1 newest evidence a day ago, its customer's text 10 days ago; N2 its customer's
--       text 4 days ago) and a failed-check rebuild (K, its customer's text 6 hours ago).
--     The list: U2, U1, L (priority 1), N1, N2 (priority 2), then F, A, G, B and after them C, E, K,
--     D in the order they had. The earlier order was U2, U1, L, N1, N2, C, E, K, B, F, A, G, D.
--     Every due job is listed once with the kind, reason and priority the judge gives it; a short
--     page is the head of the long one.
--  2. Shape and access: flags, grants, the columns returned, the slice names first, the body.
--  3. Re-applying changes nothing.
--  4. The service role reads the list in a fresh session with the table grants production has.
-- Every fixture row is synthetic and rolled back; user triggers are off for the message rows.
\set ON_ERROR_STOP on

CREATE FUNCTION pg_temp.ro_assert(p_ok boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'rebuild order contract: %', p_msg; END IF; END $$;
CREATE FUNCTION pg_temp.ro_job(p_number text, p_email text DEFAULT NULL) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE j uuid := gen_random_uuid();
BEGIN
 INSERT INTO public.jobs (id, org_id, status, type, job_number, client_name, client_email, ghl_contact_id, site_suburb, metadata, pricing_json,
  created_at)
 VALUES (j, '00000000-0000-0000-0000-000000000001', 'scheduled', 'fencing', p_number, 'Pat Example', p_email, 'ghl-' || p_number,
  'Testville', '{}', '{}', now() - interval '60 days');
 RETURN j;
END $$;
-- A placed evidence row: its own time p_at, landed (captured, recorded and placed) at p_landed. The
-- who-to-whom labels say whose it is: p_sender wrote it, and p_counterpart is the other party.
CREATE FUNCTION pg_temp.ro_ev(p_job uuid, p_type text, p_channel text, p_direction text, p_body text, p_at timestamptz,
 p_landed timestamptz DEFAULT NULL, p_sender text DEFAULT 'customer', p_counterpart text DEFAULT 'customer', p_payload jsonb DEFAULT '{}',
 p_metadata jsonb DEFAULT '{}')
RETURNS uuid LANGUAGE plpgsql SET session_replication_role = replica AS $$
DECLARE v uuid := gen_random_uuid(); roles jsonb;
BEGIN
 roles := jsonb_build_object('version', 'party_roles_v2', 'sender_role', p_sender, 'counterpart_role', p_counterpart,
  'basis', 'job_customer', 'audience', CASE WHEN p_counterpart = 'crew' THEN 'internal' ELSE p_counterpart END);
 INSERT INTO public.business_events (id, job_id, event_type, source, channel, direction, contact_id, payload, metadata, occurred_at, event_at,
  recorded_at, context_captured_at, attribution_status, attribution_step, attribution_confidence, attributed_at, match_method)
 SELECT v, p_job, p_type, 'ledger_contract', p_channel, p_direction,
  CASE WHEN p_counterpart = 'customer' AND p_channel <> 'email' THEN jb.ghl_contact_id END,
  jsonb_build_object('body', p_body) || p_payload,
  jsonb_build_object('written_as', 'service_role', 'party_roles', roles) || p_metadata,
  p_at, p_at, coalesce(p_landed, p_at), coalesce(p_landed, p_at), 'direct', 1, 1, coalesce(p_landed, p_at), 'direct_job_id'
 FROM public.jobs jb WHERE jb.id = p_job;
 RETURN v;
END $$;
-- A reading: its status, its reader, how far it read, when it was made, and whether it passed its checks.
CREATE FUNCTION pg_temp.ro_gen(p_job uuid, p_status text, p_reader text, p_until timestamptz, p_made timestamptz, p_passed boolean DEFAULT true)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v uuid;
BEGIN
 INSERT INTO public.context_ledger_generations (job_id, kind, status, reader, evidence_until, promoted_at, created_at, finished_at, updated_at,
  checks)
 VALUES (p_job, 'backfill', p_status, p_reader, p_until, CASE WHEN p_status = 'live' THEN p_made END, p_made, p_made, p_made,
  jsonb_build_object('passed', p_passed, 'store', jsonb_build_object('pass', p_passed)))
 RETURNING id INTO v;
 RETURN v;
END $$;
-- The ledger live with the new reader, every lane on, no rollout list, the backfill hours open.
CREATE FUNCTION pg_temp.ro_live() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 UPDATE public.context_ledger_settings SET mode = 'live', calls_per_day = 50, reader = 'luna-ledger:v3', job_ids = NULL,
  backfill_from_hour = NULL, backfill_to_hour = NULL;
 UPDATE public.automation_switches SET capture = true, attribution = true, extraction = true, all_stop = false WHERE id = 1;
END $$;
-- The thirteen jobs of section 1 (the rollback contract builds its own two).
CREATE FUNCTION pg_temp.ro_fixture() RETURNS void LANGUAGE plpgsql AS $$
DECLARE h uuid; old constant text := 'luna-ledger:v2'; cur constant text := 'luna-ledger:v3';
BEGIN
 PERFORM pg_temp.ro_live();
 -- F: the customer's call yesterday; the earlier reader read it
 h := pg_temp.ro_job('SWF-97306');
 PERFORM pg_temp.ro_ev(h, 'client.call_logged', 'call', 'inbound', 'Inbound call. Provider status: completed', now() - interval '1 day', NULL,
  'customer', 'customer', '{"call_status":"completed"}');
 PERFORM pg_temp.ro_gen(h, 'live', old, now() - interval '12 hours', now() - interval '12 hours');
 -- A: the customer's text 2 days ago
 h := pg_temp.ro_job('SWF-97301');
 PERFORM pg_temp.ro_ev(h, 'client.reply', 'sms', 'inbound', 'The plinths are not set below the paving as quoted', now() - interval '2 days');
 PERFORM pg_temp.ro_gen(h, 'live', old, now() - interval '12 hours', now() - interval '12 hours');
 -- G: the customer's email from the client's address 3 days ago
 h := pg_temp.ro_job('SWF-97307', 'g7@example.test');
 PERFORM pg_temp.ro_ev(h, 'client.email_in', 'email', 'inbound', 'Three panels are loose near the letterbox', now() - interval '3 days', NULL,
  'customer', 'customer', '{"from":"g7@example.test","subject":"Fence defects"}');
 PERFORM pg_temp.ro_gen(h, 'live', old, now() - interval '12 hours', now() - interval '12 hours');
 -- B: the customer's text 20 days ago, our own text 18 hours ago (newer evidence than F's, A's or G's
 -- customer message is; the earlier order put it ahead of all three)
 h := pg_temp.ro_job('SWF-97302');
 PERFORM pg_temp.ro_ev(h, 'client.reply', 'sms', 'inbound', 'Thanks, the fence looks good', now() - interval '20 days');
 PERFORM pg_temp.ro_ev(h, 'client.sms_out', 'sms', 'outbound', 'Glad to hear it', now() - interval '18 hours', NULL, 'staff');
 PERFORM pg_temp.ro_gen(h, 'live', old, now() - interval '12 hours', now() - interval '12 hours');
 -- C: no customer message ever; our own text landed 3 hours ago, after its reading (a row not read:
 -- the earlier order put it first of the rebuilds, and it still leads the quiet ones)
 h := pg_temp.ro_job('SWF-97303');
 PERFORM pg_temp.ro_ev(h, 'client.sms_out', 'sms', 'outbound', 'Your install is booked', now() - interval '6 days', NULL, 'staff');
 PERFORM pg_temp.ro_gen(h, 'live', old, now() - interval '12 hours', now() - interval '12 hours');
 PERFORM pg_temp.ro_ev(h, 'client.sms_out', 'sms', 'outbound', 'See you tomorrow', now() - interval '3 hours', NULL, 'staff');
 -- E: inbound an hour ago, none of it the customer's: a supplier's mail, a crew member's text and a
 -- marked copy of a customer text; all read
 h := pg_temp.ro_job('SWF-97305');
 PERFORM pg_temp.ro_ev(h, 'supplier.email_in', 'email', 'inbound', 'Invoice attached for the sheets', now() - interval '1 hour', NULL,
  'supplier', 'supplier', '{"from":"accounts@supplier.example.test","subject":"Invoice"}');
 PERFORM pg_temp.ro_ev(h, 'client.reply', 'sms', 'inbound', 'On site now', now() - interval '1 hour', NULL, 'crew', 'crew');
 PERFORM pg_temp.ro_ev(h, 'client.reply', 'sms', 'inbound', 'Still waiting on the fix', now() - interval '1 hour', NULL, 'customer', 'customer',
  '{}', '{"duplicate_of":"9c0b0000-0000-4000-8000-0000000000ff"}');
 PERFORM pg_temp.ro_gen(h, 'live', old, now() - interval '30 minutes', now() - interval '30 minutes');
 -- D: only our own text 5 days ago
 h := pg_temp.ro_job('SWF-97304');
 PERFORM pg_temp.ro_ev(h, 'client.sms_out', 'sms', 'outbound', 'Your quote is attached', now() - interval '5 days', NULL, 'staff');
 PERFORM pg_temp.ro_gen(h, 'live', old, now() - interval '12 hours', now() - interval '12 hours');
 -- U2 and U1: readings by the new reader with a customer text not read, since 3 hours and 1 hour ago
 h := pg_temp.ro_job('SWF-97312');
 PERFORM pg_temp.ro_ev(h, 'client.reply', 'sms', 'inbound', 'An older message', now() - interval '3 days');
 PERFORM pg_temp.ro_gen(h, 'live', cur, now() - interval '1 day', now() - interval '1 day');
 PERFORM pg_temp.ro_ev(h, 'client.reply', 'sms', 'inbound', 'A message not read', now() - interval '3 hours');
 h := pg_temp.ro_job('SWF-97311');
 PERFORM pg_temp.ro_ev(h, 'client.reply', 'sms', 'inbound', 'An older message', now() - interval '3 days');
 PERFORM pg_temp.ro_gen(h, 'live', cur, now() - interval '1 day', now() - interval '1 day');
 PERFORM pg_temp.ro_ev(h, 'client.reply', 'sms', 'inbound', 'A message not read', now() - interval '1 hour');
 -- L: a customer text from 20 days back loaded 4 hours ago (late evidence)
 h := pg_temp.ro_job('SWF-97315');
 PERFORM pg_temp.ro_ev(h, 'client.reply', 'sms', 'inbound', 'An older message', now() - interval '3 days');
 PERFORM pg_temp.ro_gen(h, 'live', cur, now() - interval '1 day', now() - interval '1 day');
 PERFORM pg_temp.ro_ev(h, 'client.reply', 'sms', 'inbound', 'A message loaded late', now() - interval '20 days', now() - interval '4 hours');
 -- N1 and N2: never read. N1's customer wrote 10 days ago and we texted a day ago; N2's customer
 -- wrote 4 days ago: newest evidence first puts N1 ahead, the customer's newest message would not
 h := pg_temp.ro_job('SWF-97313');
 PERFORM pg_temp.ro_ev(h, 'client.reply', 'sms', 'inbound', 'Can you quote a side fence?', now() - interval '10 days');
 PERFORM pg_temp.ro_ev(h, 'client.sms_out', 'sms', 'outbound', 'Quote sent', now() - interval '1 day', NULL, 'staff');
 h := pg_temp.ro_job('SWF-97314');
 PERFORM pg_temp.ro_ev(h, 'client.reply', 'sms', 'inbound', 'Can you quote a gate?', now() - interval '4 days');
 -- K: its only reading is by the new reader and failed its checks; its customer wrote 6 hours ago
 -- (after every reader-change rebuild's customer did), and the reading read that
 h := pg_temp.ro_job('SWF-97316');
 PERFORM pg_temp.ro_ev(h, 'client.reply', 'sms', 'inbound', 'When can you come back?', now() - interval '6 hours');
 PERFORM pg_temp.ro_gen(h, 'shadow', cur, now() - interval '5 hours', now() - interval '5 hours', false);
END $$;

-- 1. The order.
BEGIN;
DO $order$
DECLARE got text[]; want constant text[] := ARRAY['SWF-97312', 'SWF-97311', 'SWF-97315', 'SWF-97313', 'SWF-97314',
  'SWF-97306', 'SWF-97301', 'SWF-97307', 'SWF-97302', 'SWF-97303', 'SWF-97305', 'SWF-97316', 'SWF-97304'];
 bad text;
BEGIN
 PERFORM pg_temp.ro_fixture();
 -- the fixture is what it says: what the judge finds due, why, and at which priority
 SELECT string_agg(concat_ws(' ', jb.job_number, jd.kind, jd.reason, jd.priority::text), ', ' ORDER BY jb.job_number COLLATE "C") INTO bad
 FROM public.jobs jb CROSS JOIN LATERAL public.context_ledger_judge(ARRAY[jb.id]) jd
 WHERE jb.job_number LIKE 'SWF-973%' AND NOT coalesce(jd.due AND concat_ws(' ', jd.kind, jd.reason, jd.priority::text) = CASE
   WHEN jb.job_number IN ('SWF-97311', 'SWF-97312') THEN 'update new_evidence 1'
   WHEN jb.job_number = 'SWF-97315' THEN 'rebuild late_evidence 1'
   WHEN jb.job_number IN ('SWF-97313', 'SWF-97314') THEN 'backfill never_read 2'
   WHEN jb.job_number = 'SWF-97316' THEN 'rebuild checks_failed 3'
   ELSE 'rebuild reader_changed 3' END, false);
 PERFORM pg_temp.ro_assert(bad IS NULL AND (SELECT count(*) FROM public.jobs jb WHERE jb.job_number LIKE 'SWF-973%') = 13,
  'fixture: the judge finds something else due: ' || coalesce(bad, 'a job is missing'));
 SELECT array_agg(jb.job_number ORDER BY x.ord) INTO got
 FROM public.context_ledger_due(200) WITH ORDINALITY x(job_id, kind, reason, priority, newest_evidence_at, ord)
 JOIN public.jobs jb ON jb.id = x.job_id WHERE jb.job_number LIKE 'SWF-973%';
 -- (the earlier order: SWF-97312, SWF-97311, SWF-97315, SWF-97313, SWF-97314, then SWF-97303,
 -- SWF-97305, SWF-97316, SWF-97302, SWF-97306, SWF-97301, SWF-97307, SWF-97304)
 PERFORM pg_temp.ro_assert(got = want,
  'among the reader-change rebuilds the job whose customer wrote most recently comes first, and every other row keeps its place: '
  || array_to_string(got, ','));
 -- every due job is listed once, with the kind, reason, priority and newest evidence the judge gives it
 SELECT string_agg(jb.job_number, ', ' ORDER BY jb.job_number COLLATE "C") INTO bad
 FROM public.jobs jb CROSS JOIN LATERAL public.context_ledger_judge(ARRAY[jb.id]) jd
 WHERE jb.job_number LIKE 'SWF-973%'
  AND (SELECT count(*) FROM public.context_ledger_due(200) d WHERE d.job_id = jb.id
        AND (d.kind, d.reason, d.priority) = (jd.kind, jd.reason, jd.priority)
        AND d.newest_evidence_at IS NOT DISTINCT FROM jd.newest_evidence_at) <> 1;
 PERFORM pg_temp.ro_assert(bad IS NULL, 'a due job is not listed once as the judge judged it: ' || bad);
 -- a short page is the head of the long one (the worker reads the first rows of the list)
 PERFORM pg_temp.ro_assert(
  (SELECT array_agg(x.job_id ORDER BY x.ord) FROM public.context_ledger_due(7) WITH ORDINALITY x(job_id, kind, reason, priority, newest_evidence_at, ord))
  = (SELECT array_agg(x.job_id ORDER BY x.ord) FROM public.context_ledger_due(200) WITH ORDINALITY x(job_id, kind, reason, priority, newest_evidence_at, ord)
     WHERE x.ord <= 7), 'a short page is not the head of the list');
 -- a customer's newer message moves a reader-change rebuild up at once, with nothing else changed:
 -- D's customer writes now (a row its reading has not read; it is still a reader-change rebuild)
 PERFORM pg_temp.ro_ev((SELECT jb.id FROM public.jobs jb WHERE jb.job_number = 'SWF-97304'), 'client.reply', 'sms', 'inbound',
  'Can someone call me about the gate?', now() - interval '1 minute');
 SELECT array_agg(jb.job_number ORDER BY x.ord) INTO got
 FROM public.context_ledger_due(200) WITH ORDINALITY x(job_id, kind, reason, priority, newest_evidence_at, ord)
 JOIN public.jobs jb ON jb.id = x.job_id WHERE jb.job_number LIKE 'SWF-973%' AND x.reason = 'reader_changed';
 PERFORM pg_temp.ro_assert(got = ARRAY['SWF-97304', 'SWF-97306', 'SWF-97301', 'SWF-97307', 'SWF-97302', 'SWF-97303', 'SWF-97305'],
  'a job whose customer has just written is the first reader-change rebuild: ' || array_to_string(got, ','));
END $order$;
ROLLBACK;

-- 2. Shape and access.
DO $shape$
DECLARE sig constant text := 'public.context_ledger_due(integer)'; p record; c text;
BEGIN
 SELECT pr.prosecdef, pr.provolatile, pr.proconfig, md5(pr.prosrc) AS m, pg_get_function_result(pr.oid) AS res,
  (SELECT l.lanname FROM pg_language l WHERE l.oid = pr.prolang) AS lang
 INTO p FROM pg_proc pr WHERE pr.oid = to_regprocedure(sig);
 PERFORM pg_temp.ro_assert(p.prosecdef AND p.provolatile = 's' AND p.lang = 'sql' AND p.proconfig = ARRAY['search_path=public, pg_temp'],
  'the due list must stay stable SQL, security definer, search_path pinned: ' || to_jsonb(p)::text);
 PERFORM pg_temp.ro_assert(p.res = 'TABLE(job_id uuid, kind text, reason text, priority integer, newest_evidence_at timestamp with time zone)',
  'the due list''s columns changed: ' || p.res);
 PERFORM pg_temp.ro_assert(p.m = '874180d1d58ffc8a35cbe167b9f33d6d', 'the live body is not this migration''s: ' || p.m);
 PERFORM pg_temp.ro_assert(NOT has_function_privilege('anon', sig, 'EXECUTE') AND NOT has_function_privilege('authenticated', sig, 'EXECUTE')
  AND NOT has_function_privilege('public', sig, 'EXECUTE') AND has_function_privilege('service_role', sig, 'EXECUTE'),
  'the due list must be the service role''s only');
 c := obj_description(to_regprocedure(sig), 'pg_proc');
 PERFORM pg_temp.ro_assert(c LIKE 'Context ledger store (20261006013000): (scoping pipeline, 20261009133000) (finished wake, 20261012093500) (rebuild order, 20261012164500) %Earlier (finished wake): %Earlier (scoping pipeline): %(notes freshness, 20261009132000) %',
  'the comment must name the earlier slices first, then this one, and keep what they said');
END $shape$;

-- 3. Re-applying the migration changes nothing (its guard accepts its own body).
BEGIN;
CREATE TEMP TABLE rebuild_order_md5 AS
 SELECT md5(p.prosrc) AS m, obj_description(p.oid, 'pg_proc') AS c FROM pg_proc p WHERE p.oid = to_regprocedure('public.context_ledger_due(integer)');
\ir ../../../migrations/20261012164500_context_rebuild_order.sql
DO $again$
BEGIN
 IF (SELECT count(*) FROM rebuild_order_md5) <> 1 OR EXISTS (SELECT 1 FROM rebuild_order_md5 x, pg_proc p
       WHERE p.oid = to_regprocedure('public.context_ledger_due(integer)')
        AND (md5(p.prosrc) IS DISTINCT FROM x.m OR obj_description(p.oid, 'pg_proc') IS DISTINCT FROM x.c)) THEN
  RAISE EXCEPTION 'rebuild order contract: a re-apply must change nothing';
 END IF;
 IF NOT has_function_privilege('service_role', 'public.context_ledger_due(integer)', 'EXECUTE')
    OR has_function_privilege('anon', 'public.context_ledger_due(integer)', 'EXECUTE')
    OR has_function_privilege('authenticated', 'public.context_ledger_due(integer)', 'EXECUTE') THEN
  RAISE EXCEPTION 'rebuild order contract: a re-apply must leave the access as it was';
 END IF;
END $again$;
ROLLBACK;

-- 4. The service role reads the list: a fresh session, so no plan cached earlier hides a missing
-- grant, and the table grants production gives the service role. The order reads the record layer's
-- message helper, whose crew and staff template helper (context_internal_text_role) 20261005090000
-- revoked from the service role, so a list that ran as its caller would be refused.
\c
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL session_replication_role = replica;
UPDATE public.context_ledger_settings SET mode = 'live', calls_per_day = 50, reader = 'luna-ledger:v3', job_ids = NULL,
 backfill_from_hour = NULL, backfill_to_hour = NULL;
UPDATE public.automation_switches SET capture = true, attribution = true, extraction = true, all_stop = false WHERE id = 1;
INSERT INTO public.jobs (id, org_id, job_number, status, type, client_name, ghl_contact_id, pricing_json, metadata, created_at)
VALUES ('9c000000-0000-4000-8000-000000000401', '00000000-0000-0000-0000-000000000001', 'SWF-97401', 'scheduled', 'fencing', 'Order SR', 'ct97401', '{}', '{}', now() - interval '60 days'),
       ('9c000000-0000-4000-8000-000000000402', '00000000-0000-0000-0000-000000000001', 'SWF-97402', 'scheduled', 'fencing', 'Order SR Two', 'ct97402', '{}', '{}', now() - interval '60 days');
INSERT INTO public.business_events (id, job_id, event_type, source, channel, direction, contact_id, payload, metadata, occurred_at, recorded_at, event_at,
  context_captured_at, attribution_status, attribution_step, attribution_confidence, attributed_at, match_method)
VALUES
 -- one: the customer's text 2 days ago; two: our own text a day ago (newer evidence, no customer message)
 ('9c0b0000-0000-4000-8000-000000000401', '9c000000-0000-4000-8000-000000000401', 'client.reply', 'ledger_contract', 'sms', 'inbound', 'ct97401',
  '{"body":"The fence is leaning, can someone come out?"}',
  '{"written_as":"service_role","party_roles":{"version":"party_roles_v2","counterpart_role":"customer","sender_role":"customer","basis":"job_customer","audience":"customer"}}',
  now() - interval '2 days', now() - interval '2 days', now() - interval '2 days', now() - interval '2 days', 'direct', 1, 1, now() - interval '2 days', 'direct_job_id'),
 ('9c0b0000-0000-4000-8000-000000000402', '9c000000-0000-4000-8000-000000000402', 'client.sms_out', 'ledger_contract', 'sms', 'outbound', 'ct97402',
  '{"body":"Your install is booked"}',
  '{"written_as":"service_role","party_roles":{"version":"party_roles_v2","counterpart_role":"customer","sender_role":"staff","basis":"job_customer","audience":"customer"}}',
  now() - interval '1 day', now() - interval '1 day', now() - interval '1 day', now() - interval '1 day', 'direct', 1, 1, now() - interval '1 day', 'direct_job_id');
INSERT INTO public.context_ledger_generations (job_id, kind, status, reader, evidence_until, promoted_at, created_at, finished_at, updated_at, checks)
SELECT j.id, 'backfill', 'live', 'luna-ledger:v2', now() - interval '12 hours', now() - interval '12 hours', now() - interval '12 hours',
 now() - interval '12 hours', now() - interval '12 hours', '{"passed":true,"store":{"pass":true}}'
FROM public.jobs j WHERE j.job_number IN ('SWF-97401', 'SWF-97402');
GRANT SELECT ON ALL TABLES IN SCHEMA public TO service_role;
SET LOCAL ROLE service_role;
DO $service$
DECLARE got text;
BEGIN
 IF has_function_privilege('service_role', 'public.context_internal_text_role(public.business_events)', 'EXECUTE') THEN
  RAISE EXCEPTION 'rebuild order contract: the ladder helper is meant to stay revoked from the service role here';
 END IF;
 BEGIN
  SELECT string_agg(concat_ws(' ', jb.job_number, x.reason), ', ' ORDER BY x.ord) INTO got
  FROM public.context_ledger_due(200) WITH ORDINALITY x(job_id, kind, reason, priority, newest_evidence_at, ord)
  JOIN public.jobs jb ON jb.id = x.job_id WHERE jb.job_number LIKE 'SWF-974%';
  IF got IS DISTINCT FROM 'SWF-97401 reader_changed, SWF-97402 reader_changed' THEN
   RAISE EXCEPTION 'rebuild order contract: the service role read the list wrong: %', got;
  END IF;
 EXCEPTION WHEN insufficient_privilege THEN
  RAISE EXCEPTION 'rebuild order contract: the service role must read the due list: % (%)', SQLERRM, SQLSTATE;
 END;
END $service$;
RESET ROLE;
ROLLBACK;
