-- Contract: 20261009132000_context_notes_freshness. Every fixture write is rolled back. Job numbers,
-- names and words are synthetic; the shapes are the 9 Oct audit's: SWF-261459 (the customer's call
-- landed after the reading had read the job, and the go-live sweep put the reading live with it
-- unread), SWP-261405 (an update failed its checks, then a call waited out the backoff) and SWB-26073
-- (rows loaded late). The judge, the due list and the sweep judge now, so their fixtures are placed
-- relative to now; the story is read as of a fixed instant over fixed dates. Evidence rows are
-- written with session_replication_role replica, so each states exactly the columns the store reads.
--
--  1. Shape: the rule (plain SQL, inlined, service role only) and the four replaced bodies (definer,
--     search path, volatility, grants, comments keep their slice names first).
--  2. The rule: an automated row is never unread; a row landed after the reading's evidence_until
--     is, one landed at or before it is not; a reading with no evidence_until has read nothing.
--  3. The sweep: a shadow with a row it has not read stays shadow (unread_rows); our automated
--     reminder or a late copy of a row it read does not hold it; beside a live reading the live one
--     stays; with no live reading the judge asks for the shadow's update, and finish promotes it then.
--  4. The judge: an update held by the backoff for a row that landed after the last failed read is
--     due at once (SWP-261405); one that landed before it, an automated one, a build that lost its
--     lease and a never-read job's backfill still back off; a waiting shadow with a row it has not
--     read answers no rebuild of the live reading, one with none (or only automated ones) still does.
--  5. The finish path is unchanged: a build that saw a row land while it ran goes live, and the judge
--     has it updated at once.
--  6. The due order: within a priority the updates first, each group by the longest wait for a row
--     not read.
--  7. The story: unread_rows, stale and the not-known line count the rule's rows; an automated row
--     alone leaves the notes fresh; a copy is listed but not counted.
--  8. Re-applying the migration changes nothing.
\set ON_ERROR_STOP on

CREATE FUNCTION pg_temp.nf_assert(p_ok boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'notes freshness contract: %', p_msg; END IF; END $$;
CREATE FUNCTION pg_temp.nf_today() RETURNS date LANGUAGE sql AS $$ SELECT (now() AT TIME ZONE 'Australia/Perth')::date $$;
CREATE FUNCTION pg_temp.nf_job(p_number text, p_status text DEFAULT 'scheduled', p_id uuid DEFAULT NULL,
 p_created timestamptz DEFAULT now() - interval '60 days') RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE j uuid := coalesce(p_id, gen_random_uuid());
BEGIN
 INSERT INTO public.jobs (id, org_id, status, type, job_number, client_name, client_email, ghl_contact_id, site_suburb, metadata, pricing_json,
  created_at)
 VALUES (j, '00000000-0000-0000-0000-000000000001', p_status, 'fencing', p_number, 'Pat Example', NULL, 'ghl-' || p_number,
  'Testville', '{}', '{}', p_created);
 RETURN j;
END $$;
-- A placed evidence row: its own time p_at, landed (captured, recorded and placed) at p_landed.
CREATE FUNCTION pg_temp.nf_ev(p_job uuid, p_type text, p_channel text, p_direction text, p_body text, p_at timestamptz,
 p_landed timestamptz DEFAULT NULL, p_sender text DEFAULT 'customer', p_payload jsonb DEFAULT '{}', p_id uuid DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql SET session_replication_role = replica AS $$
DECLARE v uuid := coalesce(p_id, gen_random_uuid()); roles jsonb;
BEGIN
 roles := jsonb_build_object('version', 'party_roles_v2', 'sender_role', p_sender,
  'recipient_role', CASE WHEN p_sender = 'customer' THEN 'staff' ELSE 'customer' END,
  'counterpart_role', 'customer', 'basis', 'job_customer', 'audience', 'customer');
 INSERT INTO public.business_events (id, job_id, event_type, source, channel, direction, payload, metadata, occurred_at, event_at,
  recorded_at, context_captured_at, attribution_status, attribution_step, attribution_confidence, attributed_at, match_method)
 VALUES (v, p_job, p_type, 'ledger_contract', p_channel, p_direction, jsonb_build_object('body', p_body) || p_payload,
  jsonb_build_object('written_as', 'service_role', 'party_roles', roles),
  p_at, p_at, coalesce(p_landed, p_at), coalesce(p_landed, p_at), 'direct', 1, 1, coalesce(p_landed, p_at), 'direct_job_id');
 RETURN v;
END $$;
CREATE FUNCTION pg_temp.nf_move(p_event uuid, p_job uuid) RETURNS void LANGUAGE sql SET session_replication_role = replica AS $$
 UPDATE public.business_events SET job_id = p_job WHERE id = p_event $$;
-- A reading: its status, how far it read, when it was made, and whether it passed its checks.
CREATE FUNCTION pg_temp.nf_gen(p_job uuid, p_status text, p_until timestamptz, p_made timestamptz, p_passed boolean DEFAULT true,
 p_reader text DEFAULT 'luna-ledger:v2') RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v uuid;
BEGIN
 INSERT INTO public.context_ledger_generations (job_id, kind, status, reader, evidence_until, promoted_at, created_at, finished_at, updated_at,
  checks)
 VALUES (p_job, 'backfill', p_status, p_reader, p_until, CASE WHEN p_status = 'live' THEN p_made END, p_made, p_made, p_made,
  jsonb_build_object('passed', p_passed, 'store', jsonb_build_object('pass', p_passed)))
 RETURNING id INTO v;
 RETURN v;
END $$;
CREATE FUNCTION pg_temp.nf_item(p_gen uuid, p_key text, p_cite uuid) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v uuid;
BEGIN
 INSERT INTO public.context_ledger_items (generation_id, job_id, item_key, item_type, status, from_role, what, opened_at, opened_by,
  written_by, person_locked)
 SELECT p_gen, g.job_id, p_key, 'request', 'open', 'customer', 'Fixture item ' || p_key, now() - interval '5 days',
  jsonb_build_array(jsonb_build_object('table', 'business_events', 'id', p_cite::text, 'excerpt', 'x')), 'model:luna-ledger:v2', false
 FROM public.context_ledger_generations g WHERE g.id = p_gen
 RETURNING id INTO v;
 RETURN v;
END $$;
-- An ended ledger run (a read that finished or failed).
CREATE FUNCTION pg_temp.nf_run(p_job uuid, p_status text, p_error text, p_started timestamptz, p_finished timestamptz) RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE v uuid; s integer;
BEGIN
 SELECT coalesce(max(run_seq), 0) + 1 INTO s FROM public.context_extraction_runs
 WHERE job_id = p_job AND run_date = pg_temp.nf_today() AND phase = 'ledger';
 INSERT INTO public.context_extraction_runs (job_id, run_date, phase, status, lease_token, lease_expires_at, run_seq, started_at, finished_at)
 VALUES (p_job, pg_temp.nf_today(), 'ledger', p_status, gen_random_uuid(), NULL, s, p_started, p_finished)
 RETURNING id INTO v;
 UPDATE public.context_extraction_runs SET error = p_error WHERE id = v;
 RETURN v;
END $$;
-- The ledger live with the current reader, every lane on, no rollout list, the backfill hours open.
CREATE FUNCTION pg_temp.nf_live() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 UPDATE public.context_ledger_settings SET mode = 'live', calls_per_day = 50, reader = 'luna-ledger:v2', job_ids = NULL,
  backfill_from_hour = NULL, backfill_to_hour = NULL;
 UPDATE public.automation_switches SET capture = true, attribution = true, extraction = true, all_stop = false WHERE id = 1;
END $$;

-- 1. Shape.
DO $shape$
DECLARE x record; p record; line text; plan text := '';
 rule constant text := 'public.context_ledger_row_unread(timestamptz,boolean,timestamptz)';
BEGIN
 PERFORM pg_temp.nf_assert(to_regprocedure(rule) IS NOT NULL, 'the rule is missing');
 SELECT pr.prosecdef, pr.provolatile, pr.proconfig, pr.prolang INTO p FROM pg_proc pr WHERE pr.oid = to_regprocedure(rule);
 PERFORM pg_temp.nf_assert(NOT p.prosecdef AND p.proconfig IS NULL AND p.provolatile = 'i'
  AND p.prolang = (SELECT l.oid FROM pg_language l WHERE l.lanname = 'sql'), 'the rule must be plain immutable SQL with no SET and no definer');
 PERFORM pg_temp.nf_assert(has_function_privilege('service_role', rule, 'EXECUTE') AND NOT has_function_privilege('anon', rule, 'EXECUTE')
  AND NOT has_function_privilege('authenticated', rule, 'EXECUTE')
  AND NOT EXISTS (SELECT 1 FROM pg_proc pp, aclexplode(coalesce(pp.proacl, acldefault('f', pp.proowner))) a
                  WHERE pp.oid = to_regprocedure(rule) AND a.grantee = 0 AND a.privilege_type = 'EXECUTE'), 'the rule is service role only');
 PERFORM pg_temp.nf_assert(obj_description(to_regprocedure(rule), 'pg_proc') LIKE 'Notes freshness (20261009132000): %', 'the rule''s comment marker');
 -- the rule is inlined where it is read: no call to it is left in a plan
 FOR line IN EXECUTE 'EXPLAIN (VERBOSE) SELECT e.id FROM public.business_events e '
   || 'WHERE public.context_ledger_row_unread(e.recorded_at, e.direction = ''outbound'', e.occurred_at)' LOOP
  plan := plan || line || ' ';
 END LOOP;
 PERFORM pg_temp.nf_assert(plan NOT LIKE '%context_ledger_row_unread%', 'the rule is not inlined: ' || plan);
 FOR x IN SELECT * FROM (VALUES
   ('public.context_ledger_judge(uuid[])', 's',
    'Context ledger store (20261006013000), story safety (20261006040000): %(notes freshness, 20261009132000) %Earlier (lead cutoff, 20261007010000) %'),
   ('public.context_ledger_due(integer)', 's', 'Context ledger store (20261006013000): %(notes freshness, 20261009132000) %Earlier: %'),
   ('public.context_ledger_promote_shadow(text,uuid[],integer)', 'v',
    'Context ledger store (20261006013000): (notes freshness, 20261009132000) %Earlier: bulk go-live.%'),
   ('public.context_job_story_ledger(uuid,uuid,timestamptz)', 's',
    'Job story (20261006014000), story fixes (20261006033000), story safety (20261006040000): (notes freshness, 20261009132000) %Earlier (eighth review) %')
 ) v(sig, vol, cmt) LOOP
  SELECT pr.prosecdef, pr.provolatile, pr.proconfig INTO p FROM pg_proc pr WHERE pr.oid = to_regprocedure(x.sig);
  PERFORM pg_temp.nf_assert(p.prosecdef AND p.proconfig = ARRAY['search_path=public, pg_temp'] AND p.provolatile = x.vol,
   x.sig || ' must stay a definer with search_path public, pg_temp and volatility ' || x.vol);
  PERFORM pg_temp.nf_assert(has_function_privilege('service_role', x.sig, 'EXECUTE') AND NOT has_function_privilege('anon', x.sig, 'EXECUTE')
   AND NOT has_function_privilege('authenticated', x.sig, 'EXECUTE'), x.sig || ' access wrong');
  PERFORM pg_temp.nf_assert(coalesce(obj_description(to_regprocedure(x.sig), 'pg_proc'), '') LIKE x.cmt,
   x.sig || ' comment must keep its slice names first and name notes freshness');
 END LOOP;
END $shape$;

-- 2. The rule.
DO $rule$
DECLARE t constant timestamptz := '2026-09-10 00:00Z';
BEGIN
 PERFORM pg_temp.nf_assert(public.context_ledger_row_unread(t + interval '1 second', false, t), 'a row landed after the reading is unread');
 PERFORM pg_temp.nf_assert(public.context_ledger_row_unread(t + interval '1 second', NULL, t), 'a row not known to be automated is unread');
 PERFORM pg_temp.nf_assert(NOT public.context_ledger_row_unread(t, false, t), 'a row landed at the reading''s evidence_until was read');
 PERFORM pg_temp.nf_assert(NOT public.context_ledger_row_unread(t - interval '1 day', false, t), 'a row landed before was read');
 PERFORM pg_temp.nf_assert(NOT public.context_ledger_row_unread(t + interval '1 day', true, t), 'an automated row is never unread');
 PERFORM pg_temp.nf_assert(public.context_ledger_row_unread(t, false, NULL), 'a reading with no evidence_until has read nothing');
 PERFORM pg_temp.nf_assert(NOT public.context_ledger_row_unread(t, true, NULL), 'an automated row is never unread, even then');
END $rule$;

-- 3. The go-live sweep.
BEGIN;
DO $sweep$
DECLARE a uuid; b uuid; c uuid; d uuid; ga uuid; gb uuid; gc uuid; gd uuid; gdl uuid; v jsonb; jd record; cl jsonb; fin jsonb;
BEGIN
 PERFORM pg_temp.nf_live();
 -- A, SWF-261459's shape: a passing shadow that read the job to two days ago, then the customer's call
 -- (its transcript landed a day ago, two hours after the call).
 a := pg_temp.nf_job('SWF-99101');
 PERFORM pg_temp.nf_ev(a, 'client.reply', 'sms', 'inbound', 'Can you send the quote for the side fence?', now() - interval '3 days');
 ga := pg_temp.nf_gen(a, 'shadow', now() - interval '2 days', now() - interval '2 days');
 PERFORM pg_temp.nf_ev(a, 'call.transcript_completed', 'call', 'inbound', 'Please send the deposit invoice and call me back about the install date',
  now() - interval '26 hours', now() - interval '24 hours');
 -- B: a passing shadow whose only newer row is our automated reminder email (a workflow email is
 -- evidence, marked automated; a workflow text is not evidence at all, being status only).
 b := pg_temp.nf_job('SWF-99102');
 PERFORM pg_temp.nf_ev(b, 'client.reply', 'sms', 'inbound', 'Is Thursday still fine for the install?', now() - interval '3 days');
 gb := pg_temp.nf_gen(b, 'shadow', now() - interval '2 days', now() - interval '2 days');
 PERFORM pg_temp.nf_ev(b, 'client.email_out', 'email', 'outbound', 'Reminder: your install is booked for Thursday', now() - interval '1 day', NULL,
  'staff', '{"sent_by_kind":"workflow"}');
 PERFORM pg_temp.nf_assert(EXISTS (SELECT 1 FROM public.context_ledger_evidence_rows(ARRAY[b], now()) r
  WHERE r.automated AND r.landed_at > now() - interval '2 days'), 'fixture: the reminder is automated evidence');
 -- C: a passing shadow whose only newer row is a late copy of a message it read (the same words 30 seconds apart).
 c := pg_temp.nf_job('SWF-99103');
 PERFORM pg_temp.nf_ev(c, 'client.reply', 'sms', 'inbound', 'Please use the side gate on the day', now() - interval '3 days');
 gc := pg_temp.nf_gen(c, 'shadow', now() - interval '2 days', now() - interval '2 days');
 PERFORM pg_temp.nf_ev(c, 'client.reply', 'sms', 'inbound', 'Please use the side gate on the day', now() - interval '3 days' + interval '30 seconds',
  now() - interval '1 day');
 -- D: a live reading, and a newer passing shadow with a row landed after it.
 d := pg_temp.nf_job('SWF-99104');
 PERFORM pg_temp.nf_ev(d, 'client.reply', 'sms', 'inbound', 'We would like the gate painted black', now() - interval '6 days');
 gdl := pg_temp.nf_gen(d, 'live', now() - interval '5 days', now() - interval '5 days');
 gd := pg_temp.nf_gen(d, 'shadow', now() - interval '2 days', now() - interval '2 days');
 PERFORM pg_temp.nf_ev(d, 'client.reply', 'sms', 'inbound', 'Actually make the gate white instead', now() - interval '1 day');
 v := public.context_ledger_promote_shadow('rule:notes-freshness-contract', ARRAY[a, b, c, d]);
 PERFORM pg_temp.nf_assert(v ->> 'outcome' = 'done' AND (v ->> 'promoted')::int = 2 AND (v ->> 'skipped')::int = 2
  AND v -> 'skipped_reasons' = '{"unread_rows": 2}'::jsonb
  AND (SELECT status FROM public.context_ledger_generations WHERE id = ga) = 'shadow'
  AND (SELECT status FROM public.context_ledger_generations WHERE id = gd) = 'shadow',
  'the sweep must hold a shadow with a row it has not read: ' || v::text);
 PERFORM pg_temp.nf_assert((SELECT array_agg(x ->> 'generation_id' ORDER BY x ->> 'generation_id') FROM jsonb_array_elements(v -> 'promoted_generations') x)
  = (SELECT array_agg(i::text ORDER BY i::text) FROM unnest(ARRAY[gb, gc]) i)
  AND (SELECT status FROM public.context_ledger_generations WHERE id = gb) = 'live'
  AND (SELECT status FROM public.context_ledger_generations WHERE id = gc) = 'live',
  'an automated reminder or a late copy of a row it read never holds a shadow back: ' || v::text);
 PERFORM pg_temp.nf_assert((SELECT status FROM public.context_ledger_generations WHERE id = gdl) = 'live'
  AND (SELECT array_agg(x ->> 'job_id' ORDER BY x ->> 'job_id') FROM jsonb_array_elements(v -> 'skipped_generations') x
       WHERE x ->> 'reason' = 'unread_rows') = (SELECT array_agg(i::text ORDER BY i::text) FROM unnest(ARRAY[a, d]) i),
  'beside a held shadow the live reading stays: ' || v::text);
 -- With no live reading the held shadow is the job's current reading: the judge asks for its update,
 -- the update reads the call, and finish puts it live then.
 SELECT * INTO jd FROM public.context_ledger_judge(ARRAY[a]);
 PERFORM pg_temp.nf_assert(jd.due AND jd.kind = 'update' AND jd.reason = 'new_evidence' AND jd.generation_id = ga AND jd.priority = 1,
  'the held shadow is updated first: ' || to_jsonb(jd)::text);
 cl := public.context_ledger_claim(a, 'update', pg_temp.nf_today());
 PERFORM pg_temp.nf_assert(cl ->> 'outcome' = 'claimed' AND (cl ->> 'generation_id')::uuid = ga, 'the update claims the held shadow: ' || cl::text);
 fin := public.context_ledger_finish((cl ->> 'run_id')::uuid, (cl ->> 'lease_token')::uuid, ga, 'updated',
  jsonb_build_object('model', 'gpt-6-luna', 'evidence_until', now() - interval '1 minute', 'evidence_rows', 1, 'chunks', 1, 'calls', 1));
 PERFORM pg_temp.nf_assert(fin ->> 'outcome' = 'updated' AND (fin ->> 'promoted')::boolean
  AND (SELECT status FROM public.context_ledger_generations WHERE id = ga) = 'live', 'finish puts it live once it has read the call: ' || fin::text);
 PERFORM pg_temp.nf_assert(NOT coalesce((SELECT j2.due FROM public.context_ledger_judge(ARRAY[a]) j2), true), 'nothing is left unread');
 -- A repeat sweep: still only the shadow beside the live reading is held.
 v := public.context_ledger_promote_shadow('rule:notes-freshness-contract', ARRAY[a, d]);
 PERFORM pg_temp.nf_assert((v ->> 'promoted')::int = 0 AND v -> 'skipped_reasons' = '{"no_shadow": 1, "unread_rows": 1}'::jsonb,
  'a repeat sweep: ' || v::text);
END $sweep$;
ROLLBACK;

-- 4. The judge.
BEGIN;
DO $judge$
DECLARE e1 uuid; e2 uuid; e3 uuid; e4 uuid; e5 uuid; f1 uuid; f2 uuid; f3 uuid; o uuid; mv uuid; gl uuid; r uuid; jd record; cl jsonb; k integer;
BEGIN
 PERFORM pg_temp.nf_live();
 -- E1, SWP-261405's shape: a live reading read to three hours ago; an update that failed its checks
 -- ended an hour ago (a 2-hour backoff runs to an hour from now); our call's transcript landed half an
 -- hour ago. The update is due at once.
 e1 := pg_temp.nf_job('SWF-99201');
 PERFORM pg_temp.nf_ev(e1, 'client.reply', 'sms', 'inbound', 'Can you confirm the fan bracket colour?', now() - interval '1 day');
 PERFORM pg_temp.nf_gen(e1, 'live', now() - interval '3 hours', now() - interval '1 day');
 PERFORM pg_temp.nf_run(e1, 'done', 'checks_failed', now() - interval '70 minutes', now() - interval '1 hour');
 PERFORM pg_temp.nf_ev(e1, 'call.transcript_completed', 'call', 'outbound', 'I will send you a photo of the fan bracket today',
  now() - interval '40 minutes', now() - interval '30 minutes', 'staff');
 PERFORM pg_temp.nf_assert((SELECT f.backoff_until > now() FROM public.context_ledger_failures(ARRAY[e1]) f), 'fixture: the backoff still runs');
 SELECT * INTO jd FROM public.context_ledger_judge(ARRAY[e1]);
 PERFORM pg_temp.nf_assert(jd.due AND jd.kind = 'update' AND jd.reason = 'new_evidence' AND jd.blocked_reason IS NULL,
  'an update of a row that landed after the failed read is never held by the backoff: ' || to_jsonb(jd)::text);
 cl := public.context_ledger_claim(e1, 'update', pg_temp.nf_today());
 PERFORM pg_temp.nf_assert(cl ->> 'outcome' = 'claimed', 'and the claim agrees: ' || cl::text);
 -- E2: the same, but the only row not read landed before the failed read ended: it waits out the backoff.
 e2 := pg_temp.nf_job('SWF-99202');
 PERFORM pg_temp.nf_ev(e2, 'client.reply', 'sms', 'inbound', 'Can you confirm the fan bracket colour?', now() - interval '1 day');
 PERFORM pg_temp.nf_gen(e2, 'live', now() - interval '3 hours', now() - interval '1 day');
 PERFORM pg_temp.nf_run(e2, 'done', 'checks_failed', now() - interval '70 minutes', now() - interval '1 hour');
 PERFORM pg_temp.nf_ev(e2, 'client.reply', 'sms', 'inbound', 'White would be better than black', now() - interval '100 minutes', now() - interval '90 minutes');
 SELECT * INTO jd FROM public.context_ledger_judge(ARRAY[e2]);
 PERFORM pg_temp.nf_assert(NOT jd.due AND jd.kind = 'update' AND jd.blocked_reason = 'backoff',
  'a row that landed before the failed read ended waits out the backoff: ' || to_jsonb(jd)::text);
 -- E3: only our automated reminder email landed since: it waits too.
 e3 := pg_temp.nf_job('SWF-99203');
 PERFORM pg_temp.nf_ev(e3, 'client.reply', 'sms', 'inbound', 'Can you confirm the fan bracket colour?', now() - interval '1 day');
 PERFORM pg_temp.nf_gen(e3, 'live', now() - interval '3 hours', now() - interval '1 day');
 PERFORM pg_temp.nf_run(e3, 'done', 'checks_failed', now() - interval '70 minutes', now() - interval '1 hour');
 PERFORM pg_temp.nf_ev(e3, 'client.email_out', 'email', 'outbound', 'Reminder: your install is booked for Friday', now() - interval '30 minutes', NULL,
  'staff', '{"sent_by_kind":"workflow"}');
 SELECT * INTO jd FROM public.context_ledger_judge(ARRAY[e3]);
 PERFORM pg_temp.nf_assert(NOT jd.due AND jd.kind = 'update' AND jd.blocked_reason = 'backoff',
  'an automated row alone waits out the backoff: ' || to_jsonb(jd)::text);
 -- E4: a build that lost its lease in the last 2 hours still holds the job, even for a new row.
 e4 := pg_temp.nf_job('SWF-99204');
 PERFORM pg_temp.nf_ev(e4, 'client.reply', 'sms', 'inbound', 'Can you confirm the fan bracket colour?', now() - interval '1 day');
 PERFORM pg_temp.nf_gen(e4, 'live', now() - interval '3 hours', now() - interval '1 day');
 r := pg_temp.nf_run(e4, 'failed', 'lease_expired', now() - interval '50 minutes', now() - interval '20 minutes');
 INSERT INTO public.context_ledger_generations (job_id, kind, status, reader, run_id, created_at, updated_at)
 VALUES (e4, 'rebuild', 'building', 'luna-ledger:v2', r, now() - interval '50 minutes', now() - interval '50 minutes');
 PERFORM pg_temp.nf_ev(e4, 'client.reply', 'sms', 'inbound', 'White would be better than black', now() - interval '10 minutes');
 SELECT * INTO jd FROM public.context_ledger_judge(ARRAY[e4]);
 PERFORM pg_temp.nf_assert(NOT jd.due AND jd.blocked_reason = 'backoff', 'a build that lost its lease still holds the job: ' || to_jsonb(jd)::text);
 -- E5: a job never read, whose read failed an hour ago, with a message since: a backfill backs off as before.
 e5 := pg_temp.nf_job('SWF-99205');
 PERFORM pg_temp.nf_ev(e5, 'client.reply', 'sms', 'inbound', 'Can you confirm the fan bracket colour?', now() - interval '1 day');
 PERFORM pg_temp.nf_run(e5, 'failed', 'model_timeout', now() - interval '70 minutes', now() - interval '1 hour');
 PERFORM pg_temp.nf_ev(e5, 'client.reply', 'sms', 'inbound', 'White would be better than black', now() - interval '10 minutes');
 SELECT * INTO jd FROM public.context_ledger_judge(ARRAY[e5]);
 PERFORM pg_temp.nf_assert(NOT jd.due AND jd.kind = 'backfill' AND jd.blocked_reason = 'backoff',
  'a backfill backs off as before: ' || to_jsonb(jd)::text);

 -- F1..F3: a live reading with a moved citation, and a newer passing shadow by the current reader.
 o := pg_temp.nf_job('SWF-99209', 'complete');
 FOR k IN 1 .. 3 LOOP
  r := pg_temp.nf_job('SWF-9920' || (5 + k));
  mv := pg_temp.nf_ev(r, 'client.reply', 'sms', 'inbound', 'This message belongs on the other job', now() - interval '6 days');
  PERFORM pg_temp.nf_ev(r, 'client.reply', 'sms', 'inbound', 'This message stays on this job', now() - interval '6 days');
  gl := pg_temp.nf_gen(r, 'live', now() - interval '5 days', now() - interval '5 days');
  PERFORM pg_temp.nf_item(gl, 'request:none:' || repeat(k::text, 12), mv);
  PERFORM pg_temp.nf_move(mv, o);
  PERFORM pg_temp.nf_gen(r, 'shadow', now() - interval '2 days', now() - interval '2 days');
  IF k = 1 THEN
   f1 := r;  -- the customer wrote after the shadow's reading
   PERFORM pg_temp.nf_ev(r, 'client.reply', 'sms', 'inbound', 'Can we start a week later?', now() - interval '1 day');
  ELSIF k = 2 THEN
   f2 := r;  -- nothing after it
  ELSE
   f3 := r;  -- only our automated reminder email after it
   PERFORM pg_temp.nf_ev(r, 'client.email_out', 'email', 'outbound', 'Reminder: your install is booked for Monday', now() - interval '1 day', NULL,
    'staff', '{"sent_by_kind":"workflow"}');
  END IF;
 END LOOP;
 SELECT * INTO jd FROM public.context_ledger_judge(ARRAY[f1]);
 PERFORM pg_temp.nf_assert(jd.due AND jd.kind = 'rebuild' AND jd.reason = 'citation_moved',
  'a waiting shadow with a row it has not read answers nothing: the live reading is rebuilt: ' || to_jsonb(jd)::text);
 SELECT * INTO jd FROM public.context_ledger_judge(ARRAY[f2]);
 PERFORM pg_temp.nf_assert(NOT jd.due AND jd.kind IS NULL AND jd.blocked_reason IS NULL,
  'a waiting shadow that read every row still answers the rebuild: ' || to_jsonb(jd)::text);
 SELECT * INTO jd FROM public.context_ledger_judge(ARRAY[f3]);
 PERFORM pg_temp.nf_assert(jd.due AND jd.kind = 'update' AND jd.reason = 'new_evidence',
  'an automated row never stops a shadow answering (the live reading is only updated): ' || to_jsonb(jd)::text);
END $judge$;
ROLLBACK;

-- 5. The finish path is unchanged (owned by open PR #999's slice): a build that saw a row land while
-- it ran goes live, and the judge has it updated at once.
BEGIN;
DO $finish$
DECLARE g uuid; cl jsonb; fin jsonb; jd record; t jsonb;
BEGIN
 PERFORM pg_temp.nf_live();
 g := pg_temp.nf_job('SWF-99301');
 PERFORM pg_temp.nf_ev(g, 'client.reply', 'sms', 'inbound', 'When will the posts go in?', now() - interval '2 days');
 cl := public.context_ledger_claim(g, 'backfill', pg_temp.nf_today());
 PERFORM pg_temp.nf_assert(cl ->> 'outcome' = 'claimed', 'fixture claim: ' || cl::text);
 -- the read began ten minutes ago, and the customer wrote five minutes ago, while it ran
 UPDATE public.context_extraction_runs SET started_at = now() - interval '10 minutes' WHERE id = (cl ->> 'run_id')::uuid;
 PERFORM pg_temp.nf_ev(g, 'client.reply', 'sms', 'inbound', 'Also, can we move it to Friday?', now() - interval '5 minutes');
 fin := public.context_ledger_finish((cl ->> 'run_id')::uuid, (cl ->> 'lease_token')::uuid, (cl ->> 'generation_id')::uuid, 'built',
  jsonb_build_object('model', 'gpt-6-luna', 'evidence_until', now() - interval '1 minute', 'evidence_rows', 0, 'chunks', 0, 'calls', 0));
 PERFORM pg_temp.nf_assert(fin ->> 'outcome' = 'built' AND (fin ->> 'promoted')::boolean
  AND (fin ->> 'evidence_until')::timestamptz = now() - interval '10 minutes', 'the build goes live as before: ' || fin::text);
 SELECT * INTO jd FROM public.context_ledger_judge(ARRAY[g]);
 PERFORM pg_temp.nf_assert(jd.due AND jd.kind = 'update' AND jd.reason = 'new_evidence' AND jd.priority = 1,
  'and the row that landed while it ran is read next: ' || to_jsonb(jd)::text);
 t := public.context_job_story_ledger(g, NULL, now());
 PERFORM pg_temp.nf_assert((t ->> 'unread_rows')::int = 1, 'the story says the notes have not read it: ' || (t ->> 'unread_rows'));
END $finish$;
ROLLBACK;

-- 6. The due order.
BEGIN;
DO $order$
DECLARE h uuid; o uuid; mv uuid; gl uuid; got text[];
BEGIN
 PERFORM pg_temp.nf_live();
 -- H1 has waited since three hours ago (a newer row an hour ago too), H2 since two hours ago, H3
 -- since half an hour ago (all updates); H4 has a moved citation and nothing unread; H5 was never
 -- read.
 h := pg_temp.nf_job('SWF-99401');
 PERFORM pg_temp.nf_ev(h, 'client.reply', 'sms', 'inbound', 'An older message', now() - interval '3 days');
 PERFORM pg_temp.nf_gen(h, 'live', now() - interval '1 day', now() - interval '2 days');
 PERFORM pg_temp.nf_ev(h, 'client.reply', 'sms', 'inbound', 'The first message not read', now() - interval '3 hours');
 PERFORM pg_temp.nf_ev(h, 'client.reply', 'sms', 'inbound', 'The second message not read', now() - interval '1 hour');
 h := pg_temp.nf_job('SWF-99402');
 PERFORM pg_temp.nf_ev(h, 'client.reply', 'sms', 'inbound', 'An older message', now() - interval '3 days');
 PERFORM pg_temp.nf_gen(h, 'live', now() - interval '1 day', now() - interval '2 days');
 PERFORM pg_temp.nf_ev(h, 'client.reply', 'sms', 'inbound', 'A message not read', now() - interval '2 hours');
 h := pg_temp.nf_job('SWF-99403');
 PERFORM pg_temp.nf_ev(h, 'client.reply', 'sms', 'inbound', 'An older message', now() - interval '3 days');
 PERFORM pg_temp.nf_gen(h, 'live', now() - interval '1 day', now() - interval '2 days');
 PERFORM pg_temp.nf_ev(h, 'client.reply', 'sms', 'inbound', 'A message not read', now() - interval '30 minutes');
 h := pg_temp.nf_job('SWF-99404'); o := pg_temp.nf_job('SWF-99409', 'complete');
 mv := pg_temp.nf_ev(h, 'client.reply', 'sms', 'inbound', 'This message belongs on the other job', now() - interval '6 days');
 PERFORM pg_temp.nf_ev(h, 'client.reply', 'sms', 'inbound', 'This message stays on this job', now() - interval '6 days');
 gl := pg_temp.nf_gen(h, 'live', now() - interval '5 days', now() - interval '5 days');
 PERFORM pg_temp.nf_item(gl, 'request:none:444444444444', mv);
 PERFORM pg_temp.nf_move(mv, o);
 h := pg_temp.nf_job('SWF-99405');
 PERFORM pg_temp.nf_ev(h, 'client.reply', 'sms', 'inbound', 'A job never read', now() - interval '1 day');
 -- H6: a rebuild (a message from 20 days back loaded four hours ago: late evidence) has waited
 -- longest of all, yet the updates go first within the priority
 h := pg_temp.nf_job('SWF-99406');
 PERFORM pg_temp.nf_ev(h, 'client.reply', 'sms', 'inbound', 'An older message', now() - interval '3 days');
 PERFORM pg_temp.nf_gen(h, 'live', now() - interval '1 day', now() - interval '2 days');
 PERFORM pg_temp.nf_ev(h, 'client.reply', 'sms', 'inbound', 'A message loaded late', now() - interval '20 days', now() - interval '4 hours');
 PERFORM pg_temp.nf_assert((SELECT jd.due AND jd.kind = 'rebuild' AND jd.reason = 'late_evidence' FROM public.context_ledger_judge(ARRAY[h]) jd),
  'fixture: H6 is a late-evidence rebuild');
 SELECT array_agg(jb.job_number ORDER BY x.ord) INTO got
 FROM public.context_ledger_due(200) WITH ORDINALITY x(job_id, kind, reason, priority, newest_evidence_at, ord)
 JOIN public.jobs jb ON jb.id = x.job_id WHERE jb.job_number LIKE 'SWF-994%';
 -- (newest evidence first, as before, would give SWF-99403, SWF-99401, SWF-99402, SWF-99406, SWF-99404)
 PERFORM pg_temp.nf_assert(got = ARRAY['SWF-99401', 'SWF-99402', 'SWF-99403', 'SWF-99406', 'SWF-99404', 'SWF-99405'],
  'within a priority the updates first, each group by the longest wait for a row not read: ' || array_to_string(got, ','));
END $order$;
ROLLBACK;

-- 7. The story.
BEGIN;
DO $story$
DECLARE s constant uuid := 'f9b00000-0000-4000-8000-000000000001'; e3 constant uuid := 'f9b10000-0000-4000-8000-000000000003';
 e4 constant uuid := 'f9b10000-0000-4000-8000-000000000004'; t jsonb; st jsonb;
 line constant text := '1 newer message on this job has not been read by the reader yet.';
BEGIN
 PERFORM pg_temp.nf_job('SWF-99501', 'scheduled', s, '2026-08-01 00:00Z');
 PERFORM pg_temp.nf_ev(s, 'client.reply', 'sms', 'inbound', 'Can the fence be 1.8 m high?', '2026-09-08 02:00Z');
 INSERT INTO public.context_ledger_generations (job_id, kind, status, reader, evidence_until, promoted_at, created_at, finished_at, updated_at, checks)
 VALUES (s, 'backfill', 'live', 'luna-ledger:v2', '2026-09-10 00:00Z', '2026-09-10 01:00Z', '2026-09-10 00:30Z', '2026-09-10 00:40Z',
  '2026-09-10 01:00Z', '{"passed": true, "store": {"pass": true}}');
 -- our automated reminder email after the reading, then the customer's new message and its late copy
 PERFORM pg_temp.nf_ev(s, 'client.email_out', 'email', 'outbound', 'Reminder: your install is booked for Monday', '2026-09-12 02:00Z', NULL,
  'staff', '{"sent_by_kind":"workflow"}');
 PERFORM pg_temp.nf_ev(s, 'client.reply', 'sms', 'inbound', 'Can we make it 2.1 m instead?', '2026-09-14 02:00Z', NULL, 'customer', '{}', e3);
 PERFORM pg_temp.nf_ev(s, 'client.reply', 'sms', 'inbound', 'Can we make it 2.1 m instead?', '2026-09-14 02:00:40Z', '2026-09-14 03:00Z',
  'customer', '{}', e4);
 -- as of 13 Sep only the automated reminder landed after the reading: the notes are fresh
 PERFORM pg_temp.nf_assert((SELECT count(*) FROM public.context_ledger_evidence_rows(ARRAY[s], '2026-09-13 00:00Z') r WHERE r.automated) = 1,
  'fixture: the reminder is automated evidence');
 t := public.context_job_story_ledger(s, NULL, '2026-09-13 00:00Z');
 PERFORM pg_temp.nf_assert((t ->> 'unread_rows')::int = 0 AND t -> 'unread_ids' = '[]'::jsonb, 'an automated row alone is not unread: ' || t::text);
 st := public.context_job_story(s, '2026-09-13 00:00Z');
 PERFORM pg_temp.nf_assert((st -> 'meta' -> 'ledger' ->> 'unread_rows')::int = 0 AND NOT (st -> 'meta' -> 'ledger' ->> 'stale')::boolean
  AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(st -> 'not_known') k WHERE k ->> 'what' LIKE '%not been read by the reader yet.'),
  'an automated row alone leaves the notes fresh: ' || (st -> 'meta' -> 'ledger')::text);
 -- as of 20 Sep the customer's message is unread: one message (its copy listed, not counted), stale, and the line
 t := public.context_job_story_ledger(s, NULL, '2026-09-20 00:00Z');
 PERFORM pg_temp.nf_assert((t ->> 'unread_rows')::int = 1 AND t -> 'unread_ids' = jsonb_build_array(e3::text, e4::text),
  'the customer''s message is unread, its copy listed: ' || t::text);
 st := public.context_job_story(s, '2026-09-20 00:00Z');
 PERFORM pg_temp.nf_assert((st -> 'meta' -> 'ledger' ->> 'unread_rows')::int = 1 AND (st -> 'meta' -> 'ledger' ->> 'stale')::boolean
  AND EXISTS (SELECT 1 FROM jsonb_array_elements(st -> 'not_known') k WHERE k ->> 'what' = line),
  'the card says the notes have not read the newest message: ' || (st -> 'meta' -> 'ledger')::text || ' / ' || (st -> 'not_known')::text);
END $story$;
ROLLBACK;

-- 8. Re-applying the migration changes nothing. A later scoping pipeline body is first returned
-- to this migration's judge and due bodies inside the rolled-back transaction.
SELECT to_regprocedure('public.context_lead_window_hours(text)') IS NOT NULL AS scoping_pipeline_live \gset
BEGIN;
\if :scoping_pipeline_live
\ir ../../../rollbacks/20261009133000_context_scoping_pipeline_down.sql
\endif
CREATE TEMP TABLE notes_freshness_md5 AS
 SELECT p.oid::regprocedure::text AS sig, md5(p.prosrc) AS m, obj_description(p.oid, 'pg_proc') AS c FROM pg_proc p
 WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('context_ledger_row_unread', 'context_ledger_judge', 'context_ledger_due',
  'context_ledger_promote_shadow', 'context_job_story_ledger');
\ir ../../../migrations/20261009132000_context_notes_freshness.sql
DO $again$
BEGIN
 IF (SELECT count(*) FROM notes_freshness_md5) <> 5 OR EXISTS (SELECT 1 FROM notes_freshness_md5 x JOIN pg_proc p ON p.oid = x.sig::regprocedure
       WHERE md5(p.prosrc) IS DISTINCT FROM x.m OR obj_description(p.oid, 'pg_proc') IS DISTINCT FROM x.c) THEN
  RAISE EXCEPTION 'notes freshness contract: a re-apply must change nothing';
 END IF;
 IF EXISTS (SELECT 1 FROM (VALUES
     ('public.context_ledger_row_unread(timestamptz,boolean,timestamptz)', 'a684b7d9c649cfa8424e4cb0a928c2ef'),
     ('public.context_ledger_judge(uuid[])', 'e0809f08f49e10d500464b2c57e60461'),
     ('public.context_ledger_due(integer)', '306bab3434fca5b6ced5f1d040f5cad1'),
     ('public.context_ledger_promote_shadow(text,uuid[],integer)', 'f3a73161410c6da869af7652235d43c5'),
     ('public.context_job_story_ledger(uuid,uuid,timestamptz)', 'b27d9f6c0abdd7174f38b0ed5e1ac5f0')) v(sig, m)
   WHERE (SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure(v.sig)) IS DISTINCT FROM v.m) THEN
  RAISE EXCEPTION 'notes freshness contract: the live bodies are not this migration''s';
 END IF;
END $again$;
ROLLBACK;
