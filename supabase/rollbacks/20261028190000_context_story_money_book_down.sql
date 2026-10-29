-- Rollback of 20261028190000_context_story_money_book: the job story's Money block is removed.
--
-- The seven story text functions it replaced go back to the 20261009100000 bodies and comments,
-- byte for byte (the policy with calls_per_day 80, the staff read, the request, the sweep, the
-- writer's input, the claim state and the finish), and the five functions and two indexes it added
-- are dropped. No row is touched: saved stories
-- keep their words and checks (a story written with the Money block reads stale against the
-- story-digest-v1 hash, so it is rewritten without it once the sweep next finds something new).
--
-- Refuses unless every replaced body is this migration's or already 20261009100000's (a second
-- run changes nothing).
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $guard$
DECLARE problems text[] := '{}'; x record; live text;
BEGIN
 FOR x IN SELECT * FROM (VALUES
  ('public.context_job_story_text_policy()', ARRAY['b263f36187edbfa9e49f6ddf0333c7d3', '27ac61c4fee7d15d3b71356271295eab']),
  ('public.context_job_story_request(uuid,text,text)', ARRAY['7b08a13cc6477ae00194acd6d96f8539', '7a75f855aafb50a8821a106ff64ba173']),
  ('public.context_job_story_enqueue_changed(integer)', ARRAY['700761eeee2696d31131e07ae46e5ee3', 'b0d7b0c0d3b99759c37814a68fab6b17']),
  ('public.context_job_story_claim_state(uuid)', ARRAY['b70b21fa1fa0cea3acf60ba382008f48', '2f53d49dc49e9382d2ff3c6d98714761']),
  ('public.context_job_story_request_finish(uuid,uuid,text,text,timestamptz)', ARRAY['d63337ed4159fa2d2f66ac7481d58afe', '032099f4f543efc989788613af6255b8']),
  ('public.context_job_story_writer_input(uuid)', ARRAY['3ba2c297f97483afccffd83d3d8f4cb2', '13097e3cc7abebfdeabff122bee66e1a']),
  ('public.context_job_story_text_get(uuid,jsonb,boolean)', ARRAY['ecf91571c4e75613c05bce5aaa3a9146', '3cea9dd6df2d2f00660ccd8438637385'])
 ) v(sig, accepted) LOOP
  SELECT md5(p.prosrc) INTO live FROM pg_proc p WHERE p.oid = to_regprocedure(x.sig);
  IF live IS NULL OR NOT live = ANY (x.accepted) THEN
   problems := problems || format('%s md5 %s', x.sig, coalesce(live, '<missing>'));
  END IF;
 END LOOP;
 -- The two functions this migration added and this rollback drops: only its own body (or none,
 -- a second run). A later body (job profit TP-13, 20261029160000) would be dropped without a word.
 FOR x IN SELECT * FROM (VALUES
  ('public.context_job_story_money_sig(uuid)', 'dea95169f891563e26f40b1c340897b9'),
  ('public.context_job_story_book(uuid,timestamptz)', 'bd9484273117b728d1d7c021ea6ca4c1')
 ) v(sig, own) LOOP
  SELECT md5(p.prosrc) INTO live FROM pg_proc p WHERE p.oid = to_regprocedure(x.sig);
  IF live IS NOT NULL AND live <> x.own THEN
   problems := problems || format('%s md5 %s', x.sig, live);
  END IF;
 END LOOP;
 IF cardinality(problems) > 0 THEN
  RAISE EXCEPTION 'context_story_money_book_down_refused: %; a later body is live, roll that back first', array_to_string(problems, '; ');
 END IF;
END $guard$;

-- 1. The seven bodies back (20261009100000), byte for byte.
CREATE OR REPLACE FUNCTION public.context_job_story_text_policy()
RETURNS jsonb
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog
AS $fn$
 SELECT jsonb_build_object(
  'flag', 'context_job_story_text_v1',
  -- story model calls a Perth day (one per write, one more for a strict retry)
  'calls_per_day', 80,
  -- a claimed request is the worker's for this long
  'lease_minutes', 15,
  -- a story under this age that is still fresh is not rewritten (asked or not),
  -- and the sweep leaves a story this young alone
  'min_rewrite_minutes', 10,
  -- with no live AI reading, a new message wakes a rewrite only after this quiet time
  'quiet_minutes', 15,
  -- job_changed requests the sweep queues a call, at most
  'enqueue_per_call', 5,
  -- counted attempts before a request closes failed (max_attempts)
  'max_attempts', 3,
  -- the wait after the first and the second counted failure, in minutes
  'retry_minutes', jsonb_build_array(30, 120),
  -- the digest of the card the freshness hash reads (context_job_story_card_hash)
  'digest', 'story-digest-v1',
  -- who a job_changed request is requested by
  'writer', 'luna-story-writer')
$fn$;
COMMENT ON FUNCTION public.context_job_story_text_policy() IS
 'Job story text (20261009100000): every number of the saved job story: calls_per_day 80 (story model calls a Perth day), lease_minutes 15, min_rewrite_minutes 10, quiet_minutes 15, enqueue_per_call 5, max_attempts 3, retry_minutes [30, 120], digest story-digest-v1, writer luna-story-writer. Changed only by migration. Service role only.';

CREATE OR REPLACE FUNCTION public.context_job_story_text_get(p_job_id uuid, p_card jsonb DEFAULT NULL, p_check boolean DEFAULT true)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $fn$
DECLARE t public.context_job_story_texts; r public.context_job_story_requests; v_card jsonb; v_hash text; v_status text;
 v_fail_error text; v_fail_at timestamptz;
BEGIN
 IF p_job_id IS NULL OR NOT EXISTS (SELECT 1 FROM public.jobs jb WHERE jb.id = p_job_id) THEN
  RETURN NULL;
 END IF;
 SELECT * INTO t FROM public.context_job_story_texts x WHERE x.job_id = p_job_id AND x.status = 'current';
 IF coalesce(p_check, true) THEN
  -- the card the caller just read, else built now (only when there is a story to compare)
  v_card := coalesce(p_card, CASE WHEN t.id IS NOT NULL THEN public.context_job_story(p_job_id, now()) END);
  -- a card that is not this job's is no answer
  IF v_card IS NOT NULL AND (v_card #>> '{job,id}') IS DISTINCT FROM p_job_id::text THEN
   v_card := NULL;
  END IF;
  v_hash := public.context_job_story_card_hash(v_card);
 END IF;
 v_status := CASE WHEN t.id IS NULL THEN 'none' WHEN v_hash IS NULL THEN 'unchecked'
                  WHEN v_hash = t.card_hash THEN 'fresh' ELSE 'stale' END;
 SELECT * INTO r FROM public.context_job_story_requests q WHERE q.job_id = p_job_id AND q.done_at IS NULL;
 SELECT q.error, q.done_at INTO v_fail_error, v_fail_at FROM public.context_job_story_requests q
 WHERE q.job_id = p_job_id AND q.outcome = 'failed' AND q.done_at > coalesce(t.written_at, '-infinity'::timestamptz)
 ORDER BY q.done_at DESC, q.id DESC LIMIT 1;
 RETURN jsonb_build_object(
  'version', 'job-story-text-v1',
  'job_id', p_job_id,
  'status', v_status,
  'card_hash', v_hash,
  'text', CASE WHEN t.id IS NOT NULL THEN jsonb_build_object('id', t.id, 'written_at', t.written_at, 'checked_at', t.checked_at,
           'evidence_until', t.evidence_until, 'generation_id', t.generation_id, 'card_hash', t.card_hash, 'model', t.model,
           'sections', t.sections,
           'inputs', CASE WHEN jsonb_typeof(t.checks -> 'inputs') = 'object' THEN t.checks -> 'inputs' ELSE '{}'::jsonb END) END,
  'writer', jsonb_build_object(
   'on', public.context_job_story_text_on(),
   'open_request', CASE WHEN r.id IS NOT NULL THEN jsonb_build_object('id', r.id, 'reason', r.reason, 'requested_at', r.requested_at,
                    'picked_at', r.picked_at, 'attempts', r.attempts, 'next_attempt_at', r.next_attempt_at) END,
   'last_failure', CASE WHEN v_fail_at IS NOT NULL THEN jsonb_build_object('error', v_fail_error, 'at', v_fail_at) END));
END $fn$;
COMMENT ON FUNCTION public.context_job_story_text_get(uuid, jsonb, boolean) IS
 'Job story text (20261009100000): the saved story of one job for the staff door (ops-api job_overview): {version job-story-text-v1, job_id, status, card_hash, text, writer}. status: none (no story), fresh (its card_hash equals the hash of the card now), stale, or unchecked (not compared: p_check false, or no card of this job). p_card: the job-story-v1 card the caller has just read (hashed as it is; a card of another job is ignored); null builds context_job_story(job, now()) when there is a story to compare. text: {id, written_at, checked_at, evidence_until, generation_id, card_hash, model, sections, inputs (the writer''s input counts)} or null. writer: {on (the switch), open_request {id, reason, requested_at, picked_at, attempts, next_attempt_at} or null, last_failure {error, at} newer than the story, or null}. NULL for an unknown job. Read only. Service role only.';

CREATE OR REPLACE FUNCTION public.context_job_story_request(p_job_id uuid, p_by text, p_reason text DEFAULT 'asked')
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $fn$
DECLARE pol jsonb := public.context_job_story_text_policy(); r public.context_job_story_requests; t public.context_job_story_texts;
 v_card jsonb; v_monitored boolean; v_id uuid; v_at timestamptz;
BEGIN
 IF p_job_id IS NULL OR p_by IS NULL OR p_by !~ '^[A-Za-z0-9_.:@-]{1,128}$' OR p_reason IS NULL OR p_reason NOT IN ('asked', 'job_changed')
  OR NOT EXISTS (SELECT 1 FROM public.jobs jb WHERE jb.id = p_job_id) THEN
  RAISE EXCEPTION 'context_job_story_request_invalid' USING ERRCODE = '22023';
 END IF;
 IF NOT public.context_job_story_text_on() THEN
  RETURN jsonb_build_object('outcome', 'off');
 END IF;
 -- one decision at a time per job
 PERFORM pg_advisory_xact_lock(20261009, hashtext(p_job_id::text));
 SELECT * INTO r FROM public.context_job_story_requests q WHERE q.job_id = p_job_id AND q.done_at IS NULL;
 IF r.id IS NOT NULL THEN
  RETURN jsonb_build_object('outcome', 'already_open', 'request_id', r.id, 'requested_at', r.requested_at, 'reason', r.reason);
 END IF;
 IF p_reason = 'job_changed' THEN
  SELECT m.monitored INTO v_monitored FROM public.context_lead_monitored_jobs(ARRAY[p_job_id], now()) m;
  IF NOT coalesce(v_monitored, false) OR EXISTS (SELECT 1 FROM public.jobs jb WHERE jb.id = p_job_id
     AND (jb.status::text IN ('cancelled', 'draft', 'archived', 'complete', 'completed', 'lost')
          OR coalesce(jb.metadata ->> 'do_not_schedule', '') IN ('true', '1'))) THEN
   RETURN jsonb_build_object('outcome', 'not_live');
  END IF;
 END IF;
 SELECT * INTO t FROM public.context_job_story_texts x WHERE x.job_id = p_job_id AND x.status = 'current';
 IF t.id IS NOT NULL AND t.written_at > now() - make_interval(mins => (pol ->> 'min_rewrite_minutes')::integer) THEN
  v_card := public.context_job_story(p_job_id, now());
  IF v_card IS NOT NULL AND public.context_job_story_card_hash(v_card) = t.card_hash THEN
   RETURN jsonb_build_object('outcome', 'recent', 'text_id', t.id, 'written_at', t.written_at);
  END IF;
 END IF;
 INSERT INTO public.context_job_story_requests (job_id, requested_by, reason) VALUES (p_job_id, p_by, p_reason)
 RETURNING id, requested_at INTO v_id, v_at;
 RETURN jsonb_build_object('outcome', 'queued', 'request_id', v_id, 'requested_at', v_at, 'reason', p_reason);
END $fn$;
COMMENT ON FUNCTION public.context_job_story_request(uuid, text, text) IS
 'Job story text (20261009100000): asks for a job''s story to be written or rewritten: {outcome queued|already_open|recent|off|not_live, request_id, requested_at, reason}. off while the switch is off (nothing written); already_open returns the open request (idempotent; one open a job); recent while the current story is under min_rewrite_minutes old and its card_hash still equals the hash of the card now (the card is built once, only then); job_changed only for a live, monitored job (context_lead_monitored_jobs; else not_live), asked on any job. p_by: user:<id> from the verified session, or a server caller''s actor (letters, digits and _ . : @ -, 1 to 128). Raises context_job_story_request_invalid for bad arguments or an unknown job. Takes the job''s advisory lock (20261009). Service role only.';

CREATE OR REPLACE FUNCTION public.context_job_story_enqueue_changed(p_limit integer DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $fn$
DECLARE pol jsonb := public.context_job_story_text_policy(); v_cap integer; v_limit integer; v_rewrite interval; v_quiet interval;
 v_cand uuid[]; v_jobs uuid[]; v_ids jsonb;
BEGIN
 IF NOT public.context_job_story_text_on() THEN
  RETURN jsonb_build_object('outcome', 'off', 'queued', 0, 'job_ids', '[]'::jsonb);
 END IF;
 v_cap := (pol ->> 'enqueue_per_call')::integer;
 v_limit := least(greatest(coalesce(p_limit, v_cap), 0), v_cap);
 IF v_limit = 0 THEN
  RETURN jsonb_build_object('outcome', 'queued', 'queued', 0, 'job_ids', '[]'::jsonb, 'candidates', 0);
 END IF;
 v_rewrite := make_interval(mins => (pol ->> 'min_rewrite_minutes')::integer);
 v_quiet := make_interval(mins => (pol ->> 'quiet_minutes')::integer);
 -- 1. Cheap signals first: a current story older than the rewrite floor, no open request, a live job, and
 --    something newer than the story covers: the job's status, its AI reading (a new generation, or the
 --    same one read further), its customer invoices' money or its quotes' times (only when a row was
 --    touched since, then confirmed by the record signature), or, with no AI reading at all, a message
 --    row recorded since that has been quiet for quiet_minutes. Oldest checked first.
 SELECT array_agg(c.job_id ORDER BY c.checked_at, c.job_id) INTO v_cand
 FROM (
  SELECT t.job_id, t.checked_at
  FROM public.context_job_story_texts t
  JOIN public.jobs jb ON jb.id = t.job_id
  LEFT JOIN LATERAL public.context_job_story_reading(t.job_id) lg ON true
  WHERE t.status = 'current'
    AND t.written_at <= now() - v_rewrite
    AND NOT EXISTS (SELECT 1 FROM public.context_job_story_requests q WHERE q.job_id = t.job_id AND q.done_at IS NULL)
    AND jb.status::text NOT IN ('cancelled', 'draft', 'archived', 'complete', 'completed', 'lost')
    AND coalesce(jb.metadata ->> 'do_not_schedule', '') NOT IN ('true', '1')
    AND (jb.status::text IS DISTINCT FROM t.job_status
         OR lg.generation_id IS DISTINCT FROM t.generation_id
         OR date_trunc('milliseconds', lg.evidence_until) IS DISTINCT FROM date_trunc('milliseconds', t.evidence_until)
         OR ((EXISTS (SELECT 1 FROM public.xero_invoices x WHERE x.job_id = t.job_id AND x.updated_at > t.checked_at)
              OR EXISTS (SELECT 1 FROM public.job_documents d WHERE d.job_id = t.job_id AND d.type = 'quote'
                         AND greatest(d.sent_at, d.accepted_at, d.declined_at, d.superseded_at) > t.checked_at))
             AND public.context_job_story_record_sig(t.job_id) IS DISTINCT FROM t.record_sig)
         OR (lg.generation_id IS NULL AND EXISTS (
              SELECT 1 FROM public.business_events e
              WHERE e.job_id = t.job_id
                AND (e.channel IN ('sms', 'email', 'call', 'note', 'whatsapp', 'chat')
                     OR e.event_type IN ('client.reply', 'client.email_in', 'client.email_out', 'client.sms_in', 'client.sms_out',
                       'client.call_complete', 'client.call_logged', 'call.transcript_completed', 'client.message_in',
                       'supplier.email_in', 'ghl.note_added', 'note.added'))
                AND e.metadata #>> '{duplicate_of}' IS NULL
                AND coalesce(e.recorded_at, e.occurred_at) > t.checked_at
                AND coalesce(e.recorded_at, e.occurred_at) <= now() - v_quiet)))
  ORDER BY t.checked_at, t.job_id
  LIMIT v_limit * 10
 ) c;
 IF v_cand IS NULL THEN
  RETURN jsonb_build_object('outcome', 'queued', 'queued', 0, 'job_ids', '[]'::jsonb, 'candidates', 0);
 END IF;
 -- 2. Then the lead rule, for the survivors only: a lead no longer followed up is never rewritten by itself.
 SELECT array_agg(m.job_id ORDER BY array_position(v_cand, m.job_id)) INTO v_jobs
 FROM public.context_lead_monitored_jobs(v_cand, now()) m WHERE m.monitored;
 WITH ins AS (
  INSERT INTO public.context_job_story_requests (job_id, requested_by, reason)
  SELECT j.job_id, pol ->> 'writer', 'job_changed'
  FROM unnest(coalesce(v_jobs, '{}'::uuid[])) WITH ORDINALITY AS j(job_id, ord)
  WHERE j.ord <= v_limit
  ON CONFLICT (job_id) WHERE done_at IS NULL DO NOTHING
  RETURNING job_id)
 SELECT coalesce(jsonb_agg(ins.job_id ORDER BY ins.job_id), '[]'::jsonb) INTO v_ids FROM ins;
 RETURN jsonb_build_object('outcome', 'queued', 'queued', jsonb_array_length(v_ids), 'job_ids', v_ids, 'candidates', cardinality(v_cand));
END $fn$;
COMMENT ON FUNCTION public.context_job_story_enqueue_changed(integer) IS
 'Job story text (20261009100000): the one rule for "something new happened" (SQL decides what is due; the worker calls it each tick): queues reason job_changed, requested_by luna-story-writer, for at most p_limit (default and most enqueue_per_call, 5) jobs: a current story written more than min_rewrite_minutes ago, no open request, a live job (not cancelled, draft, archived, complete, completed or lost, never a holding job), monitored by the lead rule (context_lead_monitored_jobs, read only for the jobs the cheap signals keep), and something newer than the story covers: the job''s status differs from the story''s; its AI reading (context_job_story_reading) is another generation or reads to another evidence_until; a customer invoice or quote row was touched since checked_at and the record signature (context_job_story_record_sig) differs; or, with no AI reading, a message row (not a copy) recorded since checked_at and quiet for quiet_minutes. Oldest checked first. {outcome off|queued, queued, job_ids, candidates}. Service role only.';

CREATE OR REPLACE FUNCTION public.context_job_story_writer_input(p_job_id uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $fn$
DECLARE v_status text; v_card jsonb; t public.context_job_story_texts;
BEGIN
 SELECT jb.status::text INTO v_status FROM public.jobs jb WHERE jb.id = p_job_id;
 IF NOT FOUND THEN
  RETURN NULL;
 END IF;
 v_card := public.context_job_story(p_job_id, now());
 SELECT * INTO t FROM public.context_job_story_texts x WHERE x.job_id = p_job_id AND x.status = 'current';
 RETURN jsonb_build_object(
  'version', 'story-writer-input-v1',
  'job_id', p_job_id,
  'as_of', now(),
  'job_status', v_status,
  'card', v_card,
  'card_hash', public.context_job_story_card_hash(v_card),
  'current', CASE WHEN t.id IS NOT NULL THEN jsonb_build_object('text_id', t.id, 'card_hash', t.card_hash,
              'written_at', t.written_at, 'checked_at', t.checked_at) END,
  'notes', public.context_job_story_ledger(p_job_id, NULL, now()),
  -- call transcripts on the job: never prompt text (speakers unlabelled, names misheard)
  'transcript_row_ids', coalesce((SELECT jsonb_agg(e.id::text ORDER BY e.id) FROM public.business_events e
                                  WHERE e.job_id = p_job_id AND e.event_type = 'call.transcript_completed'), '[]'::jsonb));
END $fn$;
COMMENT ON FUNCTION public.context_job_story_writer_input(uuid) IS
 'Job story text (20261009100000): everything the story writer reads, from one snapshot (STABLE): {version story-writer-input-v1, job_id, as_of, job_status, card (context_job_story(job, now())), card_hash (context_job_story_card_hash of that card), current {text_id, card_hash, written_at, checked_at} or null, notes (context_job_story_ledger(job, null, now()): the live AI reading with every citation re-checked), transcript_row_ids (the job''s call.transcript_completed rows: their words are never prompt text)}. NULL for an unknown job. Read only. Service role only.';

CREATE OR REPLACE FUNCTION public.context_job_story_claim_state(p_job_id uuid)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $fn$
 SELECT jsonb_build_object(
  'job_status', (SELECT jb.status::text FROM public.jobs jb WHERE jb.id = p_job_id),
  'record_sig', public.context_job_story_record_sig(p_job_id),
  'generation_id', (SELECT r.generation_id FROM public.context_job_story_reading(p_job_id) r),
  'evidence_until', (SELECT r.evidence_until FROM public.context_job_story_reading(p_job_id) r))
$fn$;
COMMENT ON FUNCTION public.context_job_story_claim_state(uuid) IS
 'Job story text (20261009100000): the job as a claim finds it: {job_status, record_sig (context_job_story_record_sig), generation_id and evidence_until (context_job_story_reading)}. Kept on the request; the story saved or confirmed unchanged by it carries these, so the sweep wakes only for what changed after the claim. Service role only.';

CREATE OR REPLACE FUNCTION public.context_job_story_request_finish(p_request_id uuid, p_lease_token uuid, p_outcome text,
 p_error text DEFAULT NULL, p_retry_at timestamptz DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $fn$
DECLARE pol jsonb := public.context_job_story_text_policy(); r public.context_job_story_requests; v_stop boolean; v_attempts integer;
 v_retry timestamptz; v_waits jsonb; v_text uuid;
 stops constant text[] := ARRAY['story_off', 'story_budget', 'model_cap', 'cap', 'paused', 'model_admission_paused', 'switch_off',
  'rate_limited', 'auth_required', 'worker_stopping'];
BEGIN
 IF p_request_id IS NULL OR p_lease_token IS NULL OR p_outcome IS NULL OR p_outcome NOT IN ('unchanged', 'failed', 'released')
  OR (p_error IS NOT NULL AND p_error !~ '^[a-z0-9_]{1,64}$') OR (p_outcome = 'failed' AND p_error IS NULL) THEN
  RAISE EXCEPTION 'context_job_story_finish_invalid' USING ERRCODE = '22023';
 END IF;
 SELECT * INTO r FROM public.context_job_story_requests q WHERE q.id = p_request_id FOR UPDATE;
 IF r.id IS NULL OR r.done_at IS NOT NULL OR r.lease_token IS DISTINCT FROM p_lease_token
  OR r.lease_expires_at IS NULL OR r.lease_expires_at <= now() THEN
  RETURN jsonb_build_object('outcome', 'lease_lost');
 END IF;
 IF p_outcome = 'unchanged' THEN
  -- the story still says what the card says: it now covers the claim, and the job as the claim found it
  UPDATE public.context_job_story_texts t SET
   checked_at = greatest(t.checked_at, r.picked_at),
   job_status = coalesce(r.claimed_state ->> 'job_status', t.job_status),
   record_sig = coalesce(r.claimed_state ->> 'record_sig', t.record_sig),
   generation_id = CASE WHEN r.claimed_state ? 'generation_id' THEN (r.claimed_state ->> 'generation_id')::uuid ELSE t.generation_id END,
   evidence_until = CASE WHEN r.claimed_state ? 'evidence_until' THEN (r.claimed_state ->> 'evidence_until')::timestamptz ELSE t.evidence_until END
  WHERE t.job_id = r.job_id AND t.status = 'current'
  RETURNING t.id INTO v_text;
  UPDATE public.context_job_story_requests SET done_at = now(), outcome = 'unchanged', error = NULL, lease_token = NULL, lease_expires_at = NULL
  WHERE id = r.id;
  RETURN jsonb_build_object('outcome', 'closed', 'closed_as', 'unchanged', 'text_id', v_text);
 END IF;
 IF p_outcome = 'failed' THEN
  UPDATE public.context_job_story_requests SET done_at = now(), outcome = 'failed', error = p_error, lease_token = NULL, lease_expires_at = NULL
  WHERE id = r.id;
  RETURN jsonb_build_object('outcome', 'closed', 'closed_as', 'failed', 'error', p_error);
 END IF;
 -- released: a stop (the switch, the budget, a pause, a login, a rate limit, the worker stopping) is no
 -- attempt and waits 5 minutes unless told when; any other error counts and waits retry_minutes
 v_stop := p_error IS NOT NULL AND p_error = ANY (stops);
 v_attempts := r.attempts + CASE WHEN v_stop THEN 0 ELSE 1 END;
 v_waits := pol -> 'retry_minutes';
 v_retry := CASE
  WHEN p_retry_at IS NOT NULL THEN least(greatest(p_retry_at, now()), now() + interval '2 days')
  WHEN v_stop THEN now() + interval '5 minutes'
  ELSE now() + make_interval(mins => (v_waits ->> (least(greatest(v_attempts, 1), jsonb_array_length(v_waits)) - 1))::integer) END;
 UPDATE public.context_job_story_requests SET attempts = v_attempts, next_attempt_at = v_retry, error = p_error,
  lease_token = NULL, lease_expires_at = NULL
 WHERE id = r.id;
 RETURN jsonb_build_object('outcome', 'released', 'attempts', v_attempts, 'next_attempt_at', v_retry, 'counted', NOT v_stop);
END $fn$;
COMMENT ON FUNCTION public.context_job_story_request_finish(uuid, uuid, text, text, timestamptz) IS
 'Job story text (20261009100000): ends a claimed request without a save. unchanged: the card''s hash equals the current story''s, so the story stays and now covers the claim (checked_at moves to picked_at; job_status, record_sig, generation_id and evidence_until become the claim''s), and the request closes unchanged. failed: closes with p_error (a code). released: clears the lease for a retry; a stop (story_off, story_budget, model_cap, cap, paused, model_admission_paused, switch_off, rate_limited, auth_required, worker_stopping) is not counted and waits 5 minutes, any other error counts an attempt and waits retry_minutes (30, then 120); p_retry_at, when given, is the wait (clamped to now .. now plus 2 days). {outcome closed|released|lease_lost, ...}. Raises context_job_story_finish_invalid for bad arguments. Service role only.';

-- 2. The functions and indexes this migration added.
DROP INDEX IF EXISTS public.context_story_mrq_suggested_open;
DROP INDEX IF EXISTS public.context_story_trade_lines_job;
DROP FUNCTION IF EXISTS public.context_job_story_full_hash(jsonb);
DROP FUNCTION IF EXISTS public.context_job_story_book(uuid, timestamptz);
DROP FUNCTION IF EXISTS public.context_job_story_money_sig(uuid);
DROP FUNCTION IF EXISTS public.context_job_story_money_words(numeric);
DROP FUNCTION IF EXISTS public.context_job_story_book_policy();

-- 3. Proof.
DO $verify$
DECLARE x record; live text;
BEGIN
 FOR x IN SELECT * FROM (VALUES
  ('public.context_job_story_text_policy()', 'b263f36187edbfa9e49f6ddf0333c7d3'),
  ('public.context_job_story_request(uuid,text,text)', '7b08a13cc6477ae00194acd6d96f8539'),
  ('public.context_job_story_enqueue_changed(integer)', '700761eeee2696d31131e07ae46e5ee3'),
  ('public.context_job_story_claim_state(uuid)', 'b70b21fa1fa0cea3acf60ba382008f48'),
  ('public.context_job_story_request_finish(uuid,uuid,text,text,timestamptz)', 'd63337ed4159fa2d2f66ac7481d58afe'),
  ('public.context_job_story_writer_input(uuid)', '3ba2c297f97483afccffd83d3d8f4cb2'),
  ('public.context_job_story_text_get(uuid,jsonb,boolean)', 'ecf91571c4e75613c05bce5aaa3a9146')
 ) v(sig, want) LOOP
  SELECT md5(p.prosrc) INTO live FROM pg_proc p WHERE p.oid = to_regprocedure(x.sig);
  IF live IS DISTINCT FROM x.want THEN
   RAISE EXCEPTION 'context_story_money_book_down_mismatch: % md5 %', x.sig, coalesce(live, '<missing>');
  END IF;
 END LOOP;
 IF to_regprocedure('public.context_job_story_book(uuid,timestamptz)') IS NOT NULL THEN
  RAISE EXCEPTION 'context_story_money_book_down_mismatch: the book is still there';
 END IF;
END $verify$;
