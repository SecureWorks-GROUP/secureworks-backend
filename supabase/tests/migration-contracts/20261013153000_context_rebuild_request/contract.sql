-- Contract for 20261013153000_context_rebuild_request: an operator can ask for one job's notes to be
-- read again whole, once. Failing first: section 1 opens on the judge's word for a job with a
-- request on file (break-contract.sql stops the judge hearing of requests and expects that check
-- to fail).
--  1. Once. A job with a current reading and nothing to read is not due; a request makes it due a
--     rebuild (reason rebuild_requested, priority 3) and puts it on the due list; a second ask while
--     it is pending files nothing; the claim takes it as any rebuild; the reading it causes answers
--     it, and the job is not due again. A later ask is a new request.
--  2. A request never takes the place of a read the job is due anyway: a new message is still an
--     update, a job never read still a first read, a changed reader and a failed check still their
--     own rebuilds; and a whole reading made for any of those answers the request too.
--  3. Every block holds a requested rebuild: the ledger or the lane off, not in the rollout, not
--     live, a holding job, a lead no longer followed up, no evidence, busy, the backfill hours. The
--     claim answers not_due (or off) with the block.
--  4. A failed read leaves it pending behind the store's backoff, then due again; a stop that is
--     released never counts; three failed whole readings and it is given up. A reading that fails
--     its checks is one of them, and so is one held as thin, which the second read settles.
--  5. No request on file: the judge and the due list answer exactly as the earlier body does, over
--     a job of every reason (this migration's own rollback puts the earlier body back to compare).
--  6. Shape and access: flags, columns, comment, grants, the table closed to all but the service
--     role's read; bad arguments are refused and file nothing.
--  7. Re-applying changes nothing and keeps a request on file.
--  8. The roles, in a fresh session: the service role asks and reads; anon and authenticated cannot.
-- Every fixture row is synthetic and rolled back; user triggers are off for the message rows. A
-- request is filed through the door and then dated a day back, as one filed before any reading it
-- causes is claimed (inside one transaction now() stands still).
\set ON_ERROR_STOP on

CREATE FUNCTION pg_temp.rr_assert(p_ok boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'rebuild request contract: %', p_msg; END IF; END $$;
CREATE FUNCTION pg_temp.rr_job(p_number text, p_status text DEFAULT 'scheduled', p_metadata jsonb DEFAULT '{}') RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE j uuid := gen_random_uuid();
BEGIN
 INSERT INTO public.jobs (id, org_id, status, type, job_number, client_name, client_email, ghl_contact_id, site_suburb, metadata, pricing_json,
  created_at)
 VALUES (j, '00000000-0000-0000-0000-000000000001', p_status, 'fencing', p_number, 'Pat Example', NULL, 'ghl-' || p_number,
  'Testville', p_metadata, '{}', now() - interval '60 days');
 RETURN j;
END $$;
-- A placed evidence row: the customer's text at p_at, landed (captured, recorded and placed) then.
CREATE FUNCTION pg_temp.rr_ev(p_job uuid, p_body text, p_at timestamptz) RETURNS uuid
LANGUAGE plpgsql SET session_replication_role = replica AS $$
DECLARE v uuid := gen_random_uuid();
BEGIN
 INSERT INTO public.business_events (id, job_id, event_type, source, channel, direction, contact_id, payload, metadata, occurred_at, event_at,
  recorded_at, context_captured_at, attribution_status, attribution_step, attribution_confidence, attributed_at, match_method)
 SELECT v, p_job, 'client.reply', 'ledger_contract', 'sms', 'inbound', jb.ghl_contact_id, jsonb_build_object('body', p_body),
  jsonb_build_object('written_as', 'service_role', 'party_roles', jsonb_build_object('version', 'party_roles_v2', 'sender_role', 'customer',
   'counterpart_role', 'customer', 'basis', 'job_customer', 'audience', 'customer')),
  p_at, p_at, p_at, p_at, 'direct', 1, 1, p_at, 'direct_job_id'
 FROM public.jobs jb WHERE jb.id = p_job;
 RETURN v;
END $$;
-- A reading: its status, its reader, how far it read, when it was made, and whether it passed its checks.
CREATE FUNCTION pg_temp.rr_gen(p_job uuid, p_status text, p_reader text, p_until timestamptz, p_made timestamptz, p_passed boolean DEFAULT true)
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
-- A job with the customer's text 5 days ago and a live reading by the current reader made 2 days
-- ago that read it: nothing is due.
CREATE FUNCTION pg_temp.rr_read_job(p_number text, p_status text DEFAULT 'scheduled', p_metadata jsonb DEFAULT '{}') RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE j uuid := pg_temp.rr_job(p_number, p_status, p_metadata);
BEGIN
 PERFORM pg_temp.rr_ev(j, 'When can you start?', now() - interval '5 days');
 PERFORM pg_temp.rr_gen(j, 'live', 'luna-ledger:v3', now() - interval '2 days', now() - interval '2 days');
 RETURN j;
END $$;
-- The ledger live with the current reader, every lane on, no rollout list, the backfill hours open.
CREATE FUNCTION pg_temp.rr_live() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 UPDATE public.context_ledger_settings SET mode = 'live', calls_per_day = 50, reader = 'luna-ledger:v3', job_ids = NULL,
  backfill_from_hour = NULL, backfill_to_hour = NULL;
 UPDATE public.automation_switches SET capture = true, attribution = true, extraction = true, all_stop = false WHERE id = 1;
END $$;
-- An operator's ask through the door, then dated a day back. Returns the door's answer.
CREATE FUNCTION pg_temp.rr_ask(p_job uuid, p_why text DEFAULT 'read before the reader fix') RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE a jsonb := public.context_ledger_request_rebuild(p_job, 'contract operator', p_why);
BEGIN
 UPDATE public.context_ledger_rebuild_requests SET requested_at = now() - interval '1 day'
 WHERE id = (a ->> 'request_id')::uuid AND a ->> 'outcome' = 'requested';
 RETURN a;
END $$;
-- The judge's word for one job: due, kind, reason, priority, block.
CREATE FUNCTION pg_temp.rr_word(p_job uuid) RETURNS text LANGUAGE sql AS $$
 SELECT concat_ws(' ', CASE WHEN d.due THEN 'due' ELSE 'not_due' END, coalesce(d.kind, '-'), coalesce(d.reason, '-'),
  coalesce(d.priority::text, '-'), coalesce(d.blocked_reason, '-'))
 FROM public.context_ledger_judge(ARRAY[p_job]) d $$;
-- Where the job's requests stand, oldest first: state and failed reads of each.
CREATE FUNCTION pg_temp.rr_state(p_job uuid) RETURNS text LANGUAGE sql AS $$
 SELECT coalesce(string_agg(s.state || ' ' || s.failed_reads, ', ' ORDER BY s.requested_at, s.request_id), 'none')
 FROM public.context_ledger_rebuild_request_state(ARRAY[p_job]) s $$;
CREATE FUNCTION pg_temp.rr_claim(p_job uuid, p_kind text) RETURNS jsonb LANGUAGE sql AS $$
 SELECT public.context_ledger_claim(p_job, p_kind, (now() AT TIME ZONE 'Australia/Perth')::date) $$;
-- Close a claimed read. built: a clean whole reading (no evidence rows stated, so no note is needed);
-- checks: a whole reading the reader refused all ten of its own proposals on; else failed with p_how.
CREATE FUNCTION pg_temp.rr_finish(p_claim jsonb, p_how text) RETURNS jsonb LANGUAGE sql AS $$
 SELECT public.context_ledger_finish((p_claim ->> 'run_id')::uuid, (p_claim ->> 'lease_token')::uuid, (p_claim ->> 'generation_id')::uuid,
  CASE WHEN p_how IN ('built', 'checks') THEN 'built' WHEN p_how = 'updated' THEN 'updated' ELSE 'failed' END,
  CASE WHEN p_how IN ('built', 'updated') THEN jsonb_build_object('evidence_until', now(), 'evidence_rows', 0)
       WHEN p_how = 'checks' THEN jsonb_build_object('evidence_until', now(), 'evidence_rows', 0,
        'checks', jsonb_build_object('proposed', 10, 'refused_local', 10))
       ELSE jsonb_build_object('failure', p_how) END) $$;
-- Time passes for the job's ended reads, so a backoff they earned has run out.
CREATE FUNCTION pg_temp.rr_later(p_job uuid, p_by interval) RETURNS void LANGUAGE sql AS $$
 UPDATE public.context_extraction_runs SET finished_at = finished_at - p_by
 WHERE job_id = p_job AND phase = 'ledger' AND status IN ('done', 'failed') $$;

-- 1. Once.
BEGIN;
DO $once$
DECLARE a uuid; ask jsonb; c jsonb; f jsonb; n integer; gen uuid;
BEGIN
 PERFORM pg_temp.rr_live();
 a := pg_temp.rr_read_job('SWF-96101');
 PERFORM pg_temp.rr_assert(pg_temp.rr_word(a) = 'not_due - - - -', 'a job read by the current reader with nothing new is not due: ' || pg_temp.rr_word(a));
 PERFORM pg_temp.rr_assert((SELECT count(*) = 0 FROM public.context_ledger_rebuild_requests), 'no request is on file before one is asked for');
 ask := pg_temp.rr_ask(a);
 PERFORM pg_temp.rr_assert(pg_temp.rr_word(a) = 'due rebuild rebuild_requested 3 -',
  'a job with a request on file is due a rebuild, reason rebuild_requested, priority 3: ' || pg_temp.rr_word(a));
 PERFORM pg_temp.rr_assert(ask ->> 'outcome' = 'requested' AND (ask ->> 'due')::boolean AND ask ->> 'kind' = 'rebuild'
  AND ask ->> 'due_reason' = 'rebuild_requested' AND ask -> 'blocked_reason' = 'null'::jsonb AND (ask ->> 'failed_reads')::integer = 0,
  'the door answers requested with the judge''s word: ' || ask::text);
 PERFORM pg_temp.rr_assert((SELECT q.job_id = a AND q.requested_by = 'contract operator' AND q.reason = 'read before the reader fix'
  FROM public.context_ledger_rebuild_requests q WHERE q.id = (ask ->> 'request_id')::uuid), 'the request records the job, who asked and why');
 PERFORM pg_temp.rr_assert(pg_temp.rr_state(a) = 'pending 0', 'the request is pending: ' || pg_temp.rr_state(a));
 PERFORM pg_temp.rr_assert((SELECT count(*) = 1 AND bool_and(x.kind = 'rebuild' AND x.reason = 'rebuild_requested' AND x.priority = 3)
  FROM public.context_ledger_due(200) x WHERE x.job_id = a), 'the due list names the requested rebuild');
 -- a second ask while it is pending files nothing
 ask := public.context_ledger_request_rebuild(a, 'someone else', 'asked again') || jsonb_build_object('first', ask ->> 'request_id');
 PERFORM pg_temp.rr_assert(ask ->> 'outcome' = 'already_requested' AND ask ->> 'request_id' = ask ->> 'first'
  AND (SELECT count(*) = 1 FROM public.context_ledger_rebuild_requests WHERE job_id = a), 'a pending request is not given a second: ' || ask::text);
 -- the claim: only the kind the judge names
 c := pg_temp.rr_claim(a, 'update');
 PERFORM pg_temp.rr_assert(c ->> 'outcome' = 'not_due' AND c ->> 'kind' = 'rebuild', 'an update is not what is due: ' || c::text);
 c := pg_temp.rr_claim(a, 'rebuild');
 PERFORM pg_temp.rr_assert(c ->> 'outcome' = 'claimed' AND c ->> 'kind' = 'rebuild' AND c ->> 'reason' = 'rebuild_requested'
  AND c ->> 'generation_status' = 'building' AND c ->> 'reader' = 'luna-ledger:v3', 'the claim takes the requested rebuild: ' || c::text);
 gen := (c ->> 'generation_id')::uuid;
 PERFORM pg_temp.rr_assert(pg_temp.rr_word(a) = 'not_due rebuild rebuild_requested 3 busy', 'being read: busy: ' || pg_temp.rr_word(a));
 PERFORM pg_temp.rr_assert(pg_temp.rr_claim(a, 'rebuild') ->> 'outcome' = 'busy', 'a second claim while it is read answers busy');
 PERFORM pg_temp.rr_assert(pg_temp.rr_state(a) = 'pending 0', 'a reading still building answers nothing: ' || pg_temp.rr_state(a));
 -- the reading it caused answers it
 f := pg_temp.rr_finish(c, 'built');
 PERFORM pg_temp.rr_assert(f ->> 'outcome' = 'built' AND (f ->> 'promoted')::boolean, 'the rebuild goes live: ' || f::text);
 PERFORM pg_temp.rr_assert(pg_temp.rr_word(a) = 'not_due - - - -', 'read once: the job is not due again: ' || pg_temp.rr_word(a));
 PERFORM pg_temp.rr_assert((SELECT s.state = 'read' AND s.read_generation_id = gen AND s.read_at IS NOT NULL AND s.failed_reads = 0
  FROM public.context_ledger_rebuild_request_state(ARRAY[a]) s), 'the request is read, by the reading it caused: ' || pg_temp.rr_state(a));
 PERFORM pg_temp.rr_assert(NOT EXISTS (SELECT 1 FROM public.context_ledger_due(200) x WHERE x.job_id = a), 'a read request leaves the due list');
 c := pg_temp.rr_claim(a, 'rebuild');
 PERFORM pg_temp.rr_assert(c ->> 'outcome' = 'not_due', 'nothing more to claim: ' || c::text);
 SELECT count(*) INTO n FROM public.context_ledger_generations g WHERE g.job_id = a;
 PERFORM pg_temp.rr_assert(n = 2, 'one reading was made for the request, no more: ' || n);
 -- still read after a later reading retires the one that answered it
 UPDATE public.context_ledger_generations SET status = 'retired', retired_at = now() WHERE id = gen;
 PERFORM pg_temp.rr_gen(a, 'live', 'luna-ledger:v3', now(), now());
 PERFORM pg_temp.rr_assert(pg_temp.rr_state(a) = 'read 0' AND pg_temp.rr_word(a) = 'not_due - - - -',
  'a request stays read once its reading is retired: ' || pg_temp.rr_state(a) || ' / ' || pg_temp.rr_word(a));
 -- a later ask is a new request (asked now, after every reading so far)
 ask := public.context_ledger_request_rebuild(a, 'contract operator', 'once more');
 PERFORM pg_temp.rr_assert(ask ->> 'outcome' = 'requested' AND (ask ->> 'due')::boolean AND ask ->> 'due_reason' = 'rebuild_requested'
  AND pg_temp.rr_state(a) = 'read 0, pending 0', 'a later ask is a new request, due once more: ' || ask::text || ' / ' || pg_temp.rr_state(a));
END $once$;
ROLLBACK;

-- 2. A request never takes the place of a read the job is due anyway, and any whole reading answers it.
BEGIN;
DO $own$
DECLARE u uuid; n uuid; r uuid; k uuid; c jsonb; f jsonb;
BEGIN
 PERFORM pg_temp.rr_live();
 -- U: a new message since the reading: still an update, at once; the rebuild follows it
 u := pg_temp.rr_read_job('SWF-96201');
 PERFORM pg_temp.rr_ev(u, 'Any news on the start date?', now() - interval '1 hour');
 PERFORM pg_temp.rr_ask(u);
 PERFORM pg_temp.rr_assert(pg_temp.rr_word(u) = 'due update new_evidence 1 -', 'a new message is still an update: ' || pg_temp.rr_word(u));
 c := pg_temp.rr_claim(u, 'update');
 f := pg_temp.rr_finish(c, 'updated');
 PERFORM pg_temp.rr_assert(c ->> 'outcome' = 'claimed' AND f ->> 'outcome' = 'updated', 'the update is read: ' || c::text || f::text);
 PERFORM pg_temp.rr_assert(pg_temp.rr_state(u) = 'pending 0' AND pg_temp.rr_word(u) = 'due rebuild rebuild_requested 3 -',
  'an update answers no request: the rebuild is due after it: ' || pg_temp.rr_state(u) || ' / ' || pg_temp.rr_word(u));
 -- N: never read: still a first read, and that reading answers the request
 n := pg_temp.rr_job('SWF-96202');
 PERFORM pg_temp.rr_ev(n, 'Can I get a quote?', now() - interval '3 days');
 PERFORM pg_temp.rr_ask(n);
 PERFORM pg_temp.rr_assert(pg_temp.rr_word(n) = 'due backfill never_read 2 -', 'a job never read is still a first read: ' || pg_temp.rr_word(n));
 c := pg_temp.rr_claim(n, 'backfill');
 f := pg_temp.rr_finish(c, 'built');
 PERFORM pg_temp.rr_assert(pg_temp.rr_state(n) = 'read 0' AND pg_temp.rr_word(n) = 'not_due - - - -',
  'the first read answers the request: ' || pg_temp.rr_state(n) || ' / ' || pg_temp.rr_word(n));
 -- R: read by the earlier reader: still a reader-change rebuild, and that reading answers the request
 r := pg_temp.rr_job('SWF-96203');
 PERFORM pg_temp.rr_ev(r, 'Thanks, see you Monday', now() - interval '5 days');
 PERFORM pg_temp.rr_gen(r, 'live', 'luna-ledger:v2', now() - interval '2 days', now() - interval '2 days');
 PERFORM pg_temp.rr_ask(r);
 PERFORM pg_temp.rr_assert(pg_temp.rr_word(r) = 'due rebuild reader_changed 3 -', 'a changed reader keeps its own reason: ' || pg_temp.rr_word(r));
 c := pg_temp.rr_claim(r, 'rebuild');
 PERFORM pg_temp.rr_assert(c ->> 'reason' = 'reader_changed', 'claimed for the reader change: ' || c::text);
 f := pg_temp.rr_finish(c, 'built');
 PERFORM pg_temp.rr_assert(pg_temp.rr_state(r) = 'read 0' AND pg_temp.rr_word(r) = 'not_due - - - -',
  'a rebuild claimed for another reason answers the request too: ' || pg_temp.rr_state(r) || ' / ' || pg_temp.rr_word(r));
 -- K: its only reading failed its checks: still a failed-check rebuild
 k := pg_temp.rr_job('SWF-96204');
 PERFORM pg_temp.rr_ev(k, 'Is the gate included?', now() - interval '5 days');
 PERFORM pg_temp.rr_gen(k, 'shadow', 'luna-ledger:v3', now() - interval '2 days', now() - interval '2 days', false);
 PERFORM pg_temp.rr_ask(k);
 PERFORM pg_temp.rr_assert(pg_temp.rr_word(k) = 'due rebuild checks_failed 3 -', 'a failed check keeps its own reason: ' || pg_temp.rr_word(k));
 -- a reading made before the request answers nothing, passing or live
 PERFORM pg_temp.rr_assert(pg_temp.rr_state(k) = 'pending 0', 'a reading made before the request is not counted: ' || pg_temp.rr_state(k));
END $own$;
ROLLBACK;

-- 3. Every block holds a requested rebuild.
BEGIN;
DO $blocks$
DECLARE a uuid; done_job uuid; hold uuid; bare uuid; lead uuid; u uuid; ask jsonb; c jsonb; h integer;
BEGIN
 PERFORM pg_temp.rr_live();
 a := pg_temp.rr_read_job('SWF-96301');
 PERFORM pg_temp.rr_ask(a);
 PERFORM pg_temp.rr_assert(pg_temp.rr_word(a) = 'due rebuild rebuild_requested 3 -', 'due before any block: ' || pg_temp.rr_word(a));
 -- not live: a finished job whose customer has been quiet
 done_job := pg_temp.rr_job('SWF-96302', 'complete');
 PERFORM pg_temp.rr_ev(done_job, 'All done, thank you', now() - interval '50 days');
 PERFORM pg_temp.rr_gen(done_job, 'live', 'luna-ledger:v3', now() - interval '40 days', now() - interval '40 days');
 ask := pg_temp.rr_ask(done_job);
 PERFORM pg_temp.rr_assert(ask ->> 'outcome' = 'requested' AND NOT (ask ->> 'due')::boolean AND ask ->> 'blocked_reason' = 'not_live',
  'the door says what holds the job: ' || ask::text);
 PERFORM pg_temp.rr_assert(pg_temp.rr_word(done_job) = 'not_due rebuild rebuild_requested 3 not_live', 'not live: ' || pg_temp.rr_word(done_job));
 c := pg_temp.rr_claim(done_job, 'rebuild');
 PERFORM pg_temp.rr_assert(c ->> 'outcome' = 'not_due' AND c ->> 'reason' = 'not_live', 'the claim answers not_due, not_live: ' || c::text);
 -- a holding job
 hold := pg_temp.rr_read_job('SWF-96303', 'scheduled', '{"do_not_schedule": "true"}');
 PERFORM pg_temp.rr_ask(hold);
 PERFORM pg_temp.rr_assert(pg_temp.rr_word(hold) = 'not_due rebuild rebuild_requested 3 holding_job', 'a holding job: ' || pg_temp.rr_word(hold));
 -- no evidence
 bare := pg_temp.rr_job('SWF-96304');
 PERFORM pg_temp.rr_gen(bare, 'live', 'luna-ledger:v3', now() - interval '2 days', now() - interval '2 days');
 PERFORM pg_temp.rr_ask(bare);
 PERFORM pg_temp.rr_assert(pg_temp.rr_word(bare) = 'not_due rebuild rebuild_requested 3 no_evidence', 'no evidence: ' || pg_temp.rr_word(bare));
 -- a lead no longer followed up: still at quoted, the quote sent 60 days ago, nothing since
 lead := pg_temp.rr_job('SWF-96305', 'quoted');
 UPDATE public.jobs SET quoted_at = now() - interval '60 days', created_at = now() - interval '90 days' WHERE id = lead;
 PERFORM pg_temp.rr_ev(lead, 'I will think about it', now() - interval '59 days');
 PERFORM pg_temp.rr_gen(lead, 'live', 'luna-ledger:v3', now() - interval '50 days', now() - interval '50 days');
 PERFORM pg_temp.rr_ask(lead);
 PERFORM pg_temp.rr_assert(pg_temp.rr_word(lead) = 'not_due rebuild rebuild_requested 3 lead_not_monitored',
  'a lead no longer followed up: ' || pg_temp.rr_word(lead));
 -- none of them is on the due list; the job with no block is
 PERFORM pg_temp.rr_assert((SELECT array_agg(x.job_id) = ARRAY[a] FROM public.context_ledger_due(200) x
  WHERE x.job_id IN (a, done_job, hold, bare, lead)), 'only the job with no block is on the due list');
 -- outside the backfill hours a requested rebuild waits; an update never does
 u := pg_temp.rr_read_job('SWF-96306');
 PERFORM pg_temp.rr_ev(u, 'Any news?', now() - interval '1 hour');
 PERFORM pg_temp.rr_ask(u);
 h := extract(hour FROM now() AT TIME ZONE 'Australia/Perth')::integer;
 UPDATE public.context_ledger_settings SET backfill_from_hour = (h + 2) % 24, backfill_to_hour = (h + 3) % 24;
 PERFORM pg_temp.rr_assert(pg_temp.rr_word(a) = 'not_due rebuild rebuild_requested 3 outside_window', 'outside the backfill hours: ' || pg_temp.rr_word(a));
 PERFORM pg_temp.rr_assert(pg_temp.rr_word(u) = 'due update new_evidence 1 -', 'an update is never held by the hours: ' || pg_temp.rr_word(u));
 c := pg_temp.rr_claim(a, 'rebuild');
 PERFORM pg_temp.rr_assert(c ->> 'outcome' = 'not_due' AND c ->> 'reason' = 'outside_window', 'the claim waits for the hours: ' || c::text);
 UPDATE public.context_ledger_settings SET backfill_from_hour = NULL, backfill_to_hour = NULL;
 -- not in the rollout
 UPDATE public.context_ledger_settings SET job_ids = ARRAY[u];
 PERFORM pg_temp.rr_assert(pg_temp.rr_word(a) = 'not_due rebuild rebuild_requested 3 not_in_rollout', 'not in the rollout: ' || pg_temp.rr_word(a));
 UPDATE public.context_ledger_settings SET job_ids = NULL;
 -- the lane off, then the ledger off: the claim answers off
 UPDATE public.automation_switches SET extraction = false WHERE id = 1;
 PERFORM pg_temp.rr_assert(pg_temp.rr_word(a) = 'not_due rebuild rebuild_requested 3 lane_off', 'the lane off: ' || pg_temp.rr_word(a));
 PERFORM pg_temp.rr_assert(pg_temp.rr_claim(a, 'rebuild') ->> 'outcome' = 'off', 'the claim answers off with the lane off');
 UPDATE public.automation_switches SET extraction = true WHERE id = 1;
 UPDATE public.context_ledger_settings SET mode = 'off';
 PERFORM pg_temp.rr_assert(pg_temp.rr_word(a) = 'not_due rebuild rebuild_requested 3 ledger_off', 'the ledger off: ' || pg_temp.rr_word(a));
 PERFORM pg_temp.rr_assert(NOT EXISTS (SELECT 1 FROM public.context_ledger_due(200)), 'the due list is empty with the ledger off');
 -- every request waited: none was answered or lost while blocked
 PERFORM pg_temp.rr_live();
 PERFORM pg_temp.rr_assert((SELECT count(*) = 6 AND bool_and(s.state = 'pending') FROM public.context_ledger_rebuild_request_state(NULL) s),
  'a blocked request stays pending');
 PERFORM pg_temp.rr_assert(pg_temp.rr_word(a) = 'due rebuild rebuild_requested 3 -', 'due again once nothing holds it: ' || pg_temp.rr_word(a));
END $blocks$;
ROLLBACK;

-- 4. A failed read leaves it; three and it is given up; a released stop never counts.
BEGIN;
DO $failed$
DECLARE a uuid; b uuid; t uuid; ev uuid; lv uuid; c jsonb; f jsonb; g1 uuid; g2 uuid;
BEGIN
 PERFORM pg_temp.rr_live();
 a := pg_temp.rr_read_job('SWF-96401');
 PERFORM pg_temp.rr_ask(a);
 -- a stop (the day's budget) is released: not a failure, no backoff, due at once
 c := pg_temp.rr_claim(a, 'rebuild');
 f := pg_temp.rr_finish(c, 'ledger_budget');
 PERFORM pg_temp.rr_assert((f ->> 'released')::boolean AND pg_temp.rr_state(a) = 'pending 0'
  AND pg_temp.rr_word(a) = 'due rebuild rebuild_requested 3 -', 'a released stop never counts: ' || pg_temp.rr_state(a) || ' / ' || pg_temp.rr_word(a));
 -- the first failed read: pending behind the backoff, then due again
 c := pg_temp.rr_claim(a, 'rebuild');
 f := pg_temp.rr_finish(c, 'model_error');
 PERFORM pg_temp.rr_assert(pg_temp.rr_state(a) = 'pending 1' AND pg_temp.rr_word(a) = 'not_due rebuild rebuild_requested 3 backoff',
  'a failed read leaves the request pending behind the backoff: ' || pg_temp.rr_state(a) || ' / ' || pg_temp.rr_word(a));
 c := pg_temp.rr_claim(a, 'rebuild');
 PERFORM pg_temp.rr_assert(c ->> 'outcome' = 'not_due' AND c ->> 'reason' = 'backoff', 'the claim waits out the backoff: ' || c::text);
 PERFORM pg_temp.rr_later(a, interval '3 hours');
 PERFORM pg_temp.rr_assert(pg_temp.rr_word(a) = 'due rebuild rebuild_requested 3 -', 'due again after the backoff: ' || pg_temp.rr_word(a));
 -- the second: a reading that fails its checks counts too
 c := pg_temp.rr_claim(a, 'rebuild');
 f := pg_temp.rr_finish(c, 'checks');
 PERFORM pg_temp.rr_assert(f ->> 'outcome' = 'built' AND NOT (f ->> 'passed')::boolean AND NOT (f ->> 'promoted')::boolean,
  'the reading fails its checks: ' || f::text);
 PERFORM pg_temp.rr_assert(pg_temp.rr_state(a) = 'pending 2' AND pg_temp.rr_word(a) = 'not_due rebuild rebuild_requested 3 backoff',
  'a reading that fails its checks leaves it pending: ' || pg_temp.rr_state(a) || ' / ' || pg_temp.rr_word(a));
 PERFORM pg_temp.rr_later(a, interval '2 days');
 PERFORM pg_temp.rr_assert(pg_temp.rr_word(a) = 'due rebuild rebuild_requested 3 -', 'due a third time: ' || pg_temp.rr_word(a));
 -- the third: given up, and not for the backoff
 c := pg_temp.rr_claim(a, 'rebuild');
 f := pg_temp.rr_finish(c, 'model_error');
 PERFORM pg_temp.rr_later(a, interval '30 days');
 PERFORM pg_temp.rr_assert(pg_temp.rr_state(a) = 'gave_up 3' AND pg_temp.rr_word(a) = 'not_due - - - -',
  'three failed readings and the request is given up: ' || pg_temp.rr_state(a) || ' / ' || pg_temp.rr_word(a));
 PERFORM pg_temp.rr_assert(pg_temp.rr_claim(a, 'rebuild') ->> 'outcome' = 'not_due', 'nothing to claim once given up');
 PERFORM pg_temp.rr_assert(NOT EXISTS (SELECT 1 FROM public.context_ledger_due(200) x WHERE x.job_id = a), 'a request given up leaves the due list');
 -- a new ask after that is a new request
 PERFORM pg_temp.rr_assert(public.context_ledger_request_rebuild(a, 'contract operator', 'try again') ->> 'outcome' = 'requested'
  AND pg_temp.rr_state(a) = 'gave_up 3, pending 0', 'an ask after a request was given up is a new one: ' || pg_temp.rr_state(a));

 -- a lost lease counts: the claim that finds it fails the reading, and the job backs off
 b := pg_temp.rr_read_job('SWF-96402');
 PERFORM pg_temp.rr_ask(b);
 c := pg_temp.rr_claim(b, 'rebuild');
 UPDATE public.context_extraction_runs SET lease_expires_at = now() - interval '3 hours' WHERE id = (c ->> 'run_id')::uuid;
 UPDATE public.context_ledger_generations SET updated_at = now() - interval '3 hours' WHERE id = (c ->> 'generation_id')::uuid;
 c := pg_temp.rr_claim(b, 'rebuild');
 PERFORM pg_temp.rr_assert(pg_temp.rr_state(b) = 'pending 1', 'a reading that lost its lease is a failed read: ' || pg_temp.rr_state(b) || ' ' || c::text);

 -- held as thin (20261012110000): a 12-note live reading, a requested rebuild with none. Held: the
 -- request waits and the live notes stay; the second read settles it and answers the request.
 t := pg_temp.rr_job('SWF-96403');
 ev := pg_temp.rr_ev(t, 'Please use the taller posts', now() - interval '5 days');
 lv := pg_temp.rr_gen(t, 'live', 'luna-ledger:v3', now() - interval '2 days', now() - interval '2 days');
 INSERT INTO public.context_ledger_items (generation_id, job_id, item_key, item_type, status, from_role, what, opened_at, opened_by, written_by)
 SELECT lv, t, 'request:none:' || lpad(k::text, 11, '0'), 'request', 'open', 'customer', 'Fixture note ' || k, now() - interval '5 days',
  jsonb_build_array(jsonb_build_object('table', 'business_events', 'id', ev::text, 'excerpt', 'Please use the taller posts')), 'model:luna-ledger:v3'
 FROM generate_series(1, 12) k;
 PERFORM pg_temp.rr_assert(pg_temp.rr_word(t) = 'not_due - - - -', 'a 12-note reading with nothing new is not due: ' || pg_temp.rr_word(t));
 PERFORM pg_temp.rr_ask(t);
 c := pg_temp.rr_claim(t, 'rebuild');
 g1 := (c ->> 'generation_id')::uuid;
 f := pg_temp.rr_finish(c, 'built');
 PERFORM pg_temp.rr_assert(f #>> '{thin_rebuild,state}' = 'held' AND NOT (f ->> 'promoted')::boolean, 'the thin rebuild is held: ' || f::text);
 PERFORM pg_temp.rr_assert(pg_temp.rr_state(t) = 'pending 1' AND pg_temp.rr_word(t) = 'not_due rebuild rebuild_requested 3 backoff'
  AND (SELECT g.status = 'live' FROM public.context_ledger_generations g WHERE g.id = lv),
  'a held reading leaves the request pending and the live notes live: ' || pg_temp.rr_state(t) || ' / ' || pg_temp.rr_word(t));
 PERFORM pg_temp.rr_later(t, interval '3 hours');
 PERFORM pg_temp.rr_assert(pg_temp.rr_word(t) = 'due rebuild rebuild_requested 3 -', 'due the second read: ' || pg_temp.rr_word(t));
 c := pg_temp.rr_claim(t, 'rebuild');
 g2 := (c ->> 'generation_id')::uuid;
 f := pg_temp.rr_finish(c, 'built');
 PERFORM pg_temp.rr_assert(f #>> '{thin_rebuild,state}' = 'confirmed' AND (f ->> 'promoted')::boolean, 'the second thin read settles it: ' || f::text);
 PERFORM pg_temp.rr_assert((SELECT s.state = 'read' AND s.read_generation_id = g2 FROM public.context_ledger_rebuild_request_state(ARRAY[t]) s)
  AND pg_temp.rr_word(t) = 'not_due - - - -', 'the settled reading answers the request: ' || pg_temp.rr_state(t) || ' / ' || pg_temp.rr_word(t));
END $failed$;
ROLLBACK;

-- 5. No request on file: the judge and the due list answer exactly as the earlier body does. A job
-- of every reason; this migration's rollback puts the earlier judge back inside the transaction.
BEGIN;
DO $fixture$
DECLARE j uuid;
BEGIN
 PERFORM pg_temp.rr_live();
 PERFORM pg_temp.rr_read_job('SWF-96501');                                             -- current: nothing due
 j := pg_temp.rr_read_job('SWF-96502');                                                -- an update
 PERFORM pg_temp.rr_ev(j, 'Any news?', now() - interval '1 hour');
 j := pg_temp.rr_job('SWF-96503');                                                     -- never read
 PERFORM pg_temp.rr_ev(j, 'Can I get a quote?', now() - interval '3 days');
 j := pg_temp.rr_job('SWF-96504');                                                     -- a changed reader
 PERFORM pg_temp.rr_ev(j, 'See you Monday', now() - interval '5 days');
 PERFORM pg_temp.rr_gen(j, 'live', 'luna-ledger:v2', now() - interval '2 days', now() - interval '2 days');
 j := pg_temp.rr_job('SWF-96505');                                                     -- a failed check
 PERFORM pg_temp.rr_ev(j, 'Is the gate included?', now() - interval '5 days');
 PERFORM pg_temp.rr_gen(j, 'shadow', 'luna-ledger:v3', now() - interval '2 days', now() - interval '2 days', false);
 j := pg_temp.rr_job('SWF-96506');                                                     -- late evidence
 PERFORM pg_temp.rr_ev(j, 'An old voicemail', now() - interval '40 days');
 UPDATE public.business_events SET recorded_at = now() - interval '1 hour', context_captured_at = now() - interval '1 hour',
  attributed_at = now() - interval '1 hour' WHERE job_id = j;
 PERFORM pg_temp.rr_ev(j, 'Read long ago', now() - interval '50 days');
 PERFORM pg_temp.rr_gen(j, 'live', 'luna-ledger:v3', now() - interval '2 days', now() - interval '2 days');
 j := pg_temp.rr_job('SWF-96507', 'complete');                                         -- not live
 PERFORM pg_temp.rr_ev(j, 'All done, thank you', now() - interval '50 days');
 PERFORM pg_temp.rr_gen(j, 'live', 'luna-ledger:v3', now() - interval '40 days', now() - interval '40 days');
 PERFORM pg_temp.rr_read_job('SWF-96508', 'scheduled', '{"do_not_schedule": "true"}'); -- a holding job
 PERFORM pg_temp.rr_assert((SELECT count(*) = 0 FROM public.context_ledger_rebuild_requests), 'no request is on file');
END $fixture$;
CREATE TEMP TABLE rr_judged ON COMMIT DROP AS
 SELECT jb.job_number, to_jsonb(d) AS word FROM public.jobs jb CROSS JOIN LATERAL public.context_ledger_judge(ARRAY[jb.id]) d
 WHERE jb.job_number LIKE 'SWF-965%';
CREATE TEMP TABLE rr_judged_set ON COMMIT DROP AS
 SELECT jb.job_number, to_jsonb(d) AS word
 FROM public.context_ledger_judge(ARRAY(SELECT x.id FROM public.jobs x WHERE x.job_number LIKE 'SWF-965%')) d
 JOIN public.jobs jb ON jb.id = d.job_id;
CREATE TEMP TABLE rr_listed ON COMMIT DROP AS
 SELECT x.ord, jb.job_number, x.kind, x.reason, x.priority, x.newest_evidence_at
 FROM public.context_ledger_due(200) WITH ORDINALITY x(job_id, kind, reason, priority, newest_evidence_at, ord)
 JOIN public.jobs jb ON jb.id = x.job_id;
DO $covers$
DECLARE got text;
BEGIN
 SELECT string_agg(concat_ws(' ', r.job_number, coalesce(r.word ->> 'reason', '-'), coalesce(r.word ->> 'blocked_reason', '-')), ', ' ORDER BY r.job_number)
 INTO got FROM rr_judged r;
 PERFORM pg_temp.rr_assert(got = 'SWF-96501 - -, SWF-96502 new_evidence -, SWF-96503 never_read -, SWF-96504 reader_changed -, '
  || 'SWF-96505 checks_failed -, SWF-96506 late_evidence -, SWF-96507 - not_live, SWF-96508 - holding_job',
  'the fixture must hold a job of every reason: ' || got);
END $covers$;
-- (held notes, 20261015100000) replaced the judge, the item check, the story's ledger read, the packet and
-- the story since: its down goes first, inside this transaction only.
SELECT to_regprocedure('public.context_ledger_held_cite(uuid,jsonb)') IS NOT NULL AS held_notes_live \gset
\if :held_notes_live
\ir ../../../rollbacks/20261015100000_context_held_notes_down.sql
\endif
\ir ../../../rollbacks/20261013153000_context_rebuild_request_down.sql
DO $same$
DECLARE diff text;
BEGIN
 PERFORM pg_temp.rr_assert((SELECT md5(p.prosrc) = '902eaf18e7fd84e05d0db5ffa6e67de1' FROM pg_proc p
  WHERE p.oid = to_regprocedure('public.context_ledger_judge(uuid[])')), 'the earlier judge is in place for the comparison');
 SELECT string_agg(r.job_number, ', ' ORDER BY r.job_number) INTO diff
 FROM rr_judged r JOIN public.jobs jb ON jb.job_number = r.job_number
 CROSS JOIN LATERAL public.context_ledger_judge(ARRAY[jb.id]) d WHERE to_jsonb(d) IS DISTINCT FROM r.word;
 PERFORM pg_temp.rr_assert(diff IS NULL AND (SELECT count(*) = 8 FROM rr_judged), 'with no request the judge answers as the earlier body does, job by job: ' || coalesce(diff, ''));
 SELECT string_agg(jb.job_number, ', ' ORDER BY jb.job_number) INTO diff
 FROM public.context_ledger_judge(ARRAY(SELECT x.id FROM public.jobs x WHERE x.job_number LIKE 'SWF-965%')) d
 JOIN public.jobs jb ON jb.id = d.job_id FULL JOIN rr_judged_set r ON r.job_number = jb.job_number
 WHERE to_jsonb(d) IS DISTINCT FROM r.word;
 PERFORM pg_temp.rr_assert(diff IS NULL AND (SELECT count(*) = 8 FROM rr_judged_set), 'with no request the judge answers as the earlier body does, as a set: ' || coalesce(diff, ''));
 PERFORM pg_temp.rr_assert(NOT EXISTS (
   (SELECT * FROM rr_listed EXCEPT SELECT x.ord, jb.job_number, x.kind, x.reason, x.priority, x.newest_evidence_at
     FROM public.context_ledger_due(200) WITH ORDINALITY x(job_id, kind, reason, priority, newest_evidence_at, ord) JOIN public.jobs jb ON jb.id = x.job_id)
   UNION ALL
   (SELECT x.ord, jb.job_number, x.kind, x.reason, x.priority, x.newest_evidence_at
     FROM public.context_ledger_due(200) WITH ORDINALITY x(job_id, kind, reason, priority, newest_evidence_at, ord) JOIN public.jobs jb ON jb.id = x.job_id
    EXCEPT SELECT * FROM rr_listed)) AND (SELECT count(*) = 5 FROM rr_listed),
  'with no request the due list is the earlier one, row for row and in order');
END $same$;
ROLLBACK;

-- 6. Shape and access.
DO $shape$
DECLARE judge constant text := 'public.context_ledger_judge(uuid[])'; st constant text := 'public.context_ledger_rebuild_request_state(uuid[])';
 door constant text := 'public.context_ledger_request_rebuild(uuid,text,text)'; tbl constant regclass := 'public.context_ledger_rebuild_requests';
 p record; c text; f text; r text; v text;
BEGIN
 SELECT pr.prosecdef, pr.provolatile, pr.proconfig, md5(pr.prosrc) AS m, pg_get_function_result(pr.oid) AS res,
  (SELECT l.lanname FROM pg_language l WHERE l.oid = pr.prolang) AS lang
 INTO p FROM pg_proc pr WHERE pr.oid = to_regprocedure(judge);
 PERFORM pg_temp.rr_assert(p.prosecdef AND p.provolatile = 's' AND p.lang = 'sql' AND p.proconfig = ARRAY['search_path=public, pg_temp'],
  'the judge must stay stable SQL, security definer, search_path pinned: ' || to_jsonb(p)::text);
 PERFORM pg_temp.rr_assert(p.res = 'TABLE(job_id uuid, due boolean, kind text, reason text, priority integer, newest_evidence_at timestamp with time zone, '
  || 'evidence_rows integer, generation_id uuid, blocked_reason text)', 'the judge''s columns changed: ' || p.res);
 -- (held notes, 20261015100000, keeps this body and adds the held-note exemption to its moved citations)
 PERFORM pg_temp.rr_assert(p.m = ANY(ARRAY['92367db74677cd38612394056aac07fa', '2483ad58fdea93abcb1ca5f4d87658ee']),
  'the live judge is not this migration''s or its held-notes successor''s: ' || p.m);
 c := obj_description(to_regprocedure(judge), 'pg_proc');
 PERFORM pg_temp.rr_assert(c LIKE 'Context ledger store (20261006013000), story safety (20261006040000): (scoping pipeline, 20261009133000) '
  || '(finished wake, 20261012093500) (rebuild request, 20261013153000) %Earlier (finished wake): The owner''s 12 Oct 2026 ruling: %Earlier (scoping pipeline): %'
  AND c LIKE '%(lead cutoff, 20261007010000) %', 'the judge''s comment must name the earlier slices first, then this one, and keep what they said');
 SELECT pr.prosecdef, pr.provolatile, pr.proconfig, (SELECT l.lanname FROM pg_language l WHERE l.oid = pr.prolang) AS lang,
  pg_get_function_result(pr.oid) AS res INTO p FROM pg_proc pr WHERE pr.oid = to_regprocedure(st);
 PERFORM pg_temp.rr_assert(p.prosecdef AND p.provolatile = 's' AND p.lang = 'sql' AND p.proconfig = ARRAY['search_path=public, pg_temp'],
  'the state read must be stable SQL, security definer, search_path pinned: ' || to_jsonb(p)::text);
 PERFORM pg_temp.rr_assert(p.res = 'TABLE(request_id uuid, job_id uuid, requested_by text, reason text, requested_at timestamp with time zone, '
  || 'state text, failed_reads integer, read_generation_id uuid, read_at timestamp with time zone)', 'the state read''s columns: ' || p.res);
 SELECT pr.prosecdef, pr.provolatile, pr.proconfig, pg_get_function_result(pr.oid) AS res INTO p FROM pg_proc pr WHERE pr.oid = to_regprocedure(door);
 PERFORM pg_temp.rr_assert(p.prosecdef AND p.provolatile = 'v' AND p.res = 'jsonb' AND p.proconfig = ARRAY['search_path=public, pg_temp'],
  'the door must be security definer with search_path pinned and answer jsonb: ' || to_jsonb(p)::text);
 FOREACH f IN ARRAY ARRAY[judge, st, door] LOOP
  PERFORM pg_temp.rr_assert(NOT has_function_privilege('anon', f, 'EXECUTE') AND NOT has_function_privilege('authenticated', f, 'EXECUTE')
   AND NOT has_function_privilege('public', f, 'EXECUTE') AND has_function_privilege('service_role', f, 'EXECUTE'),
   f || ' must be the service role''s only');
 END LOOP;
 FOREACH f IN ARRAY ARRAY[st, door] LOOP
  PERFORM pg_temp.rr_assert(obj_description(to_regprocedure(f), 'pg_proc') LIKE 'Rebuild request (20261013153000): %', f || ' comment marker');
 END LOOP;
 -- the table: this migration's, row security on with no policy, closed to all but the service role's read
 PERFORM pg_temp.rr_assert(obj_description(tbl, 'pg_class') LIKE 'Rebuild request (20261013153000): %', 'the table''s comment marker');
 PERFORM pg_temp.rr_assert((SELECT k.relrowsecurity FROM pg_class k WHERE k.oid = tbl)
  AND NOT EXISTS (SELECT 1 FROM pg_policy y WHERE y.polrelid = tbl), 'the table has row security on and no policy');
 FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'public', 'service_role'] LOOP
  FOREACH v IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] LOOP
   PERFORM pg_temp.rr_assert(has_table_privilege(r, tbl, v) = (r = 'service_role' AND v = 'SELECT'), format('%s %s on the requests table', r, v));
  END LOOP;
 END LOOP;
 PERFORM pg_temp.rr_assert((SELECT count(*) = 0 FROM public.context_ledger_rebuild_requests), 'the migration files no request');
 PERFORM pg_temp.rr_assert((SELECT s.mode = 'off' AND s.calls_per_day = 0 FROM public.context_ledger_settings s), 'ledger settings changed');
END $shape$;
-- Bad arguments are refused and file nothing; an unknown job is refused by name.
BEGIN;
DO $args$
DECLARE a uuid := pg_temp.rr_job('SWF-96601'); x record; ans jsonb;
BEGIN
 FOR x IN SELECT * FROM (VALUES (NULL::uuid, 'who', 'why'), (a, NULL, 'why'), (a, '   ', 'why'), (a, 'who', NULL), (a, 'who', ''),
   (a, repeat('w', 121), 'why'), (a, 'who', repeat('y', 601))) v(job, who, why) LOOP
  BEGIN
   PERFORM public.context_ledger_request_rebuild(x.job, x.who, x.why);
   RAISE EXCEPTION 'rebuild request contract: a bad argument must be refused (%, %, %)', x.job, left(x.who, 10), left(x.why, 10);
  EXCEPTION WHEN raise_exception THEN
   IF SQLERRM <> 'context_ledger_request_rebuild_invalid' THEN RAISE; END IF;
  END;
 END LOOP;
 ans := public.context_ledger_request_rebuild(gen_random_uuid(), 'who', 'why');
 PERFORM pg_temp.rr_assert(ans = '{"outcome": "refused", "reason": "unknown_job"}'::jsonb, 'an unknown job is refused: ' || ans::text);
 PERFORM pg_temp.rr_assert((SELECT count(*) = 0 FROM public.context_ledger_rebuild_requests), 'a refused ask files nothing');
 ans := public.context_ledger_request_rebuild(a, '  who  ', '  why  ');
 PERFORM pg_temp.rr_assert((SELECT q.requested_by = 'who' AND q.reason = 'why' FROM public.context_ledger_rebuild_requests q), 'who and why are trimmed');
END $args$;
ROLLBACK;

-- 7. Re-applying the migration changes nothing (its guard accepts its own bodies) and keeps a request.
BEGIN;
-- (held notes, 20261015100000) replaced the judge since: its down goes first, inside this transaction only.
SELECT to_regprocedure('public.context_ledger_held_cite(uuid,jsonb)') IS NOT NULL AS held_notes_live \gset
\if :held_notes_live
\ir ../../../rollbacks/20261015100000_context_held_notes_down.sql
\endif
SELECT pg_temp.rr_live();
SELECT pg_temp.rr_ask(pg_temp.rr_read_job('SWF-96701')) ->> 'request_id' AS kept \gset
CREATE TEMP TABLE rr_md5 ON COMMIT DROP AS
 SELECT p.oid::regprocedure::text AS sig, md5(p.prosrc) AS m, obj_description(p.oid, 'pg_proc') AS c, p.proacl::text AS acl FROM pg_proc p
 WHERE p.pronamespace = 'public'::regnamespace
  AND p.proname IN ('context_ledger_judge', 'context_ledger_rebuild_request_state', 'context_ledger_request_rebuild');
\ir ../../../migrations/20261013153000_context_rebuild_request.sql
DO $again$
BEGIN
 IF (SELECT count(*) FROM rr_md5) <> 3 OR EXISTS (SELECT 1 FROM rr_md5 x JOIN pg_proc p ON p.oid = x.sig::regprocedure
       WHERE md5(p.prosrc) IS DISTINCT FROM x.m OR obj_description(p.oid, 'pg_proc') IS DISTINCT FROM x.c OR p.proacl::text IS DISTINCT FROM x.acl) THEN
  RAISE EXCEPTION 'rebuild request contract: a re-apply must change nothing';
 END IF;
 IF has_table_privilege('service_role', 'public.context_ledger_rebuild_requests', 'INSERT')
    OR has_table_privilege('authenticated', 'public.context_ledger_rebuild_requests', 'SELECT')
    OR NOT has_table_privilege('service_role', 'public.context_ledger_rebuild_requests', 'SELECT') THEN
  RAISE EXCEPTION 'rebuild request contract: a re-apply must leave the table''s access as it was';
 END IF;
END $again$;
SELECT pg_temp.rr_assert((SELECT count(*) = 1 FROM public.context_ledger_rebuild_requests q WHERE q.id = :'kept'::uuid),
 'a re-apply keeps the requests on file');
ROLLBACK;

-- 8. The roles: a fresh session, so no plan cached earlier hides a missing grant, and the table
-- grants production gives the service role. The service role asks and reads; it cannot write the
-- table itself; anon and authenticated can do neither.
\c
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL session_replication_role = replica;
UPDATE public.context_ledger_settings SET mode = 'live', calls_per_day = 50, reader = 'luna-ledger:v3', job_ids = NULL,
 backfill_from_hour = NULL, backfill_to_hour = NULL;
UPDATE public.automation_switches SET capture = true, attribution = true, extraction = true, all_stop = false WHERE id = 1;
INSERT INTO public.jobs (id, org_id, job_number, status, type, client_name, ghl_contact_id, pricing_json, metadata, created_at)
VALUES ('9d000000-0000-4000-8000-000000000801', '00000000-0000-0000-0000-000000000001', 'SWF-96801', 'scheduled', 'fencing', 'Request SR', 'ct96801', '{}', '{}', now() - interval '60 days');
INSERT INTO public.business_events (id, job_id, event_type, source, channel, direction, contact_id, payload, metadata, occurred_at, recorded_at, event_at,
  context_captured_at, attribution_status, attribution_step, attribution_confidence, attributed_at, match_method)
VALUES ('9d0b0000-0000-4000-8000-000000000801', '9d000000-0000-4000-8000-000000000801', 'client.reply', 'ledger_contract', 'sms', 'inbound', 'ct96801',
  '{"body":"When can you start?"}',
  '{"written_as":"service_role","party_roles":{"version":"party_roles_v2","counterpart_role":"customer","sender_role":"customer","basis":"job_customer","audience":"customer"}}',
  now() - interval '5 days', now() - interval '5 days', now() - interval '5 days', now() - interval '5 days', 'direct', 1, 1, now() - interval '5 days', 'direct_job_id');
INSERT INTO public.context_ledger_generations (job_id, kind, status, reader, evidence_until, promoted_at, created_at, finished_at, updated_at, checks)
VALUES ('9d000000-0000-4000-8000-000000000801', 'backfill', 'live', 'luna-ledger:v3', now() - interval '2 days', now() - interval '2 days',
 now() - interval '2 days', now() - interval '2 days', now() - interval '2 days', '{"passed":true,"store":{"pass":true}}');
GRANT SELECT ON ALL TABLES IN SCHEMA public TO service_role;
SET LOCAL ROLE service_role;
DO $service$
DECLARE j constant uuid := '9d000000-0000-4000-8000-000000000801'; ans jsonb; got text;
BEGIN
 BEGIN
  ans := public.context_ledger_request_rebuild(j, 'service role', 'asked through the door');
  SELECT string_agg(s.state, ',') INTO got FROM public.context_ledger_rebuild_request_state(ARRAY[j]) s;
  IF ans ->> 'outcome' IS DISTINCT FROM 'requested' OR ans ->> 'due_reason' IS DISTINCT FROM 'rebuild_requested' OR got IS DISTINCT FROM 'pending'
     OR (SELECT count(*) FROM public.context_ledger_rebuild_requests) <> 1
     OR (SELECT d.reason FROM public.context_ledger_judge(ARRAY[j]) d) IS DISTINCT FROM 'rebuild_requested'
     OR NOT EXISTS (SELECT 1 FROM public.context_ledger_due(200) x WHERE x.job_id = j AND x.reason = 'rebuild_requested') THEN
   RAISE EXCEPTION 'rebuild request contract: the service role asked and read wrong: % / %', ans, got;
  END IF;
 EXCEPTION WHEN insufficient_privilege THEN
  RAISE EXCEPTION 'rebuild request contract: the service role must ask and read: % (%)', SQLERRM, SQLSTATE;
 END;
 BEGIN
  INSERT INTO public.context_ledger_rebuild_requests (job_id, requested_by, reason) VALUES (j, 'service role', 'straight in');
  RAISE EXCEPTION 'rebuild request contract: the service role must not write the table itself';
 EXCEPTION WHEN insufficient_privilege THEN NULL;
 END;
 BEGIN
  DELETE FROM public.context_ledger_rebuild_requests;
  RAISE EXCEPTION 'rebuild request contract: the service role must not delete from the table itself';
 EXCEPTION WHEN insufficient_privilege THEN NULL;
 END;
END $service$;
RESET ROLE;
DO $others$
DECLARE j constant uuid := '9d000000-0000-4000-8000-000000000801'; r text; n integer;
BEGIN
 FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
  EXECUTE format('SET LOCAL ROLE %I', r);
  BEGIN
   PERFORM public.context_ledger_request_rebuild(j, 'not staff', 'should be refused');
   RAISE EXCEPTION 'rebuild request contract: % must not ask', r;
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
   PERFORM 1 FROM public.context_ledger_rebuild_request_state(NULL);
   RAISE EXCEPTION 'rebuild request contract: % must not read where requests stand', r;
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
   SELECT count(*) INTO n FROM public.context_ledger_rebuild_requests;
   RAISE EXCEPTION 'rebuild request contract: % must not read the table (% rows)', r, n;
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  RESET ROLE;
 END LOOP;
 IF (SELECT count(*) FROM public.context_ledger_rebuild_requests) <> 1 THEN
  RAISE EXCEPTION 'rebuild request contract: only the service role''s own ask is on file';
 END IF;
END $others$;
ROLLBACK;
