-- Rollback of 20261029170200_context_story_bill_outcomes: the story card no longer carries bill_outcomes.
--
-- The four functions it replaced go back to the 20261028190000 bodies and comments, byte for byte
-- (the freshness hash, the staff read, the request and the writer's input), and the block function
-- is dropped. No row is touched: a story written with the block reads stale once against the old
-- hash, and is rewritten at its next wake.
--
-- Refuses unless every replaced body is this migration's or already 20261028190000's (a second run
-- changes nothing).
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $guard$
DECLARE problems text[] := '{}'; x record; live text;
BEGIN
 FOR x IN SELECT * FROM (VALUES
  ('public.context_job_story_full_hash(jsonb)', ARRAY['8ae3b1581ba96299ce107410e8ac5b39', 'a444e315f8aedc2af5de37f80c3e95ce']),
  ('public.context_job_story_text_get(uuid,jsonb,boolean)', ARRAY['3cea9dd6df2d2f00660ccd8438637385', 'ac51513f6164fa256011d67c1bd82b10']),
  ('public.context_job_story_request(uuid,text,text)', ARRAY['7a75f855aafb50a8821a106ff64ba173', 'd3e09e9e36875955de47438509f40a3c']),
  ('public.context_job_story_writer_input(uuid)', ARRAY['13097e3cc7abebfdeabff122bee66e1a', '88d5ccf04d40e8cd8e6c7cee87e84f0b'])
 ) v(sig, accepted) LOOP
  SELECT md5(p.prosrc) INTO live FROM pg_proc p WHERE p.oid = to_regprocedure(x.sig);
  IF live IS NULL OR NOT live = ANY (x.accepted) THEN
   problems := problems || format('%s md5 %s', x.sig, coalesce(live, '<missing>'));
  END IF;
 END LOOP;
 IF cardinality(problems) > 0 THEN
  RAISE EXCEPTION 'context_story_bill_outcomes_down_refused: %; a later body is live, roll that back first', array_to_string(problems, '; ');
 END IF;
END $guard$;

-- 1. The four bodies back (20261028190000), byte for byte.
CREATE OR REPLACE FUNCTION public.context_job_story_full_hash(p_card jsonb)
RETURNS text
LANGUAGE sql STABLE STRICT
AS $fn$
 SELECT md5('story-digest-v1+story-book-v1|' || coalesce(public.context_job_story_card_hash(p_card), '') || '|'
            || coalesce(p_card #>> '{book,digest}', 'none'))
$fn$;
COMMENT ON FUNCTION public.context_job_story_full_hash(jsonb) IS
 'Story money book (20261028190000): the hash a saved story is fresh against (story-digest-v1+story-book-v1): md5 of the card''s story-digest-v1 hash (context_job_story_card_hash) and the book''s digest (card.book.digest, none without one). A money change the book shows makes the story stale; the clock alone never does. Null for a null card. Service role only.';

CREATE OR REPLACE FUNCTION public.context_job_story_text_get(p_job_id uuid, p_card jsonb DEFAULT NULL, p_check boolean DEFAULT true)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $fn$
DECLARE t public.context_job_story_texts; r public.context_job_story_requests; v_card jsonb; v_hash text; v_status text;
 v_fail_error text; v_fail_at timestamptz; v_book jsonb;
BEGIN
 IF p_job_id IS NULL OR NOT EXISTS (SELECT 1 FROM public.jobs jb WHERE jb.id = p_job_id) THEN
  RETURN NULL;
 END IF;
 SELECT * INTO t FROM public.context_job_story_texts x WHERE x.job_id = p_job_id AND x.status = 'current';
 -- the card the caller passed carries the book when it came from the writer's input; else it is built once here
 IF jsonb_typeof(p_card -> 'book') = 'object' AND (p_card #>> '{book,job_id}') = p_job_id::text THEN
  v_book := p_card -> 'book';
 ELSE
  v_book := public.context_job_story_book(p_job_id, now());
 END IF;
 IF coalesce(p_check, true) THEN
  -- the card the caller just read, else built now (only when there is a story to compare)
  v_card := coalesce(p_card, CASE WHEN t.id IS NOT NULL THEN public.context_job_story(p_job_id, now()) END);
  -- a card that is not this job's is no answer
  IF v_card IS NOT NULL AND (v_card #>> '{job,id}') IS DISTINCT FROM p_job_id::text THEN
   v_card := NULL;
  END IF;
  IF v_card IS NOT NULL THEN
   v_card := v_card || jsonb_build_object('book', v_book);
  END IF;
  v_hash := public.context_job_story_full_hash(v_card);
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
   'last_failure', CASE WHEN v_fail_at IS NOT NULL THEN jsonb_build_object('error', v_fail_error, 'at', v_fail_at) END),
  -- (20261028190000) the Money block, written by the database from Job Profit, shown word for word under the story
  'money', CASE WHEN v_book IS NOT NULL THEN jsonb_build_object('version', v_book -> 'version', 'source', v_book -> 'source',
            'lines', v_book -> 'lines', 'complete', v_book -> 'complete', 'incomplete_line', v_book -> 'incomplete_line') END);
END $fn$;
COMMENT ON FUNCTION public.context_job_story_text_get(uuid, jsonb, boolean) IS
 'Story money book (20261028190000), job story text (20261009100000): the saved story of one job for the staff door (ops-api job_overview): {version job-story-text-v1, job_id, status, card_hash, text, writer, money}. status: none (no story), fresh (its card_hash equals context_job_story_full_hash of the card now with its book), stale, or unchecked (not compared: p_check false, or no card of this job). p_card: the job-story-v1 card the caller has just read (a card of another job is ignored); null builds context_job_story(job, now()) when there is a story to compare; the book is p_card.book when it is this job''s, else built once (context_job_story_book). text: {id, written_at, checked_at, evidence_until, generation_id, card_hash, model, sections, inputs} or null. writer: {on, open_request {id, reason, requested_at, picked_at, attempts, next_attempt_at} or null, last_failure {error, at} newer than the story, or null}. money: the book''s {version, source, lines, complete, incomplete_line}, shown word for word under the story. NULL for an unknown job. Read only. Service role only.';

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
  IF v_card IS NOT NULL
     AND public.context_job_story_full_hash(v_card || jsonb_build_object('book', public.context_job_story_book(p_job_id, now()))) = t.card_hash THEN
   RETURN jsonb_build_object('outcome', 'recent', 'text_id', t.id, 'written_at', t.written_at);
  END IF;
 END IF;
 INSERT INTO public.context_job_story_requests (job_id, requested_by, reason) VALUES (p_job_id, p_by, p_reason)
 RETURNING id, requested_at INTO v_id, v_at;
 RETURN jsonb_build_object('outcome', 'queued', 'request_id', v_id, 'requested_at', v_at, 'reason', p_reason);
END $fn$;
COMMENT ON FUNCTION public.context_job_story_request(uuid, text, text) IS
 'Story money book (20261028190000), job story text (20261009100000): asks for a job''s story to be written or rewritten: {outcome queued|already_open|recent|off|not_live, request_id, requested_at, reason}. off while the switch is off (nothing written); already_open returns the open request (idempotent; one open a job); recent while the current story is under min_rewrite_minutes old and its card_hash still equals the full hash of the card now with its book (context_job_story_full_hash; built once, only then); job_changed only for a live, monitored job (context_lead_monitored_jobs; else not_live), asked on any job. p_by: user:<id> from the verified session, or a server caller''s actor (letters, digits and _ . : @ -, 1 to 128). Raises context_job_story_request_invalid for bad arguments or an unknown job. Takes the job''s advisory lock (20261009). Service role only.';

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
 -- (20261028190000) the Money block and the job lines from Job Profit: the writer shows the book, never sums
 IF v_card IS NOT NULL THEN
  v_card := v_card || jsonb_build_object('book', public.context_job_story_book(p_job_id, now()));
 END IF;
 SELECT * INTO t FROM public.context_job_story_texts x WHERE x.job_id = p_job_id AND x.status = 'current';
 RETURN jsonb_build_object(
  'version', 'story-writer-input-v2',
  'job_id', p_job_id,
  'as_of', now(),
  'job_status', v_status,
  'card', v_card,
  'card_hash', public.context_job_story_full_hash(v_card),
  'current', CASE WHEN t.id IS NOT NULL THEN jsonb_build_object('text_id', t.id, 'card_hash', t.card_hash,
              'written_at', t.written_at, 'checked_at', t.checked_at) END,
  'notes', public.context_job_story_ledger(p_job_id, NULL, now()),
  -- call transcripts on the job: never prompt text (speakers unlabelled, names misheard)
  'transcript_row_ids', coalesce((SELECT jsonb_agg(e.id::text ORDER BY e.id) FROM public.business_events e
                                  WHERE e.job_id = p_job_id AND e.event_type = 'call.transcript_completed'), '[]'::jsonb));
END $fn$;
COMMENT ON FUNCTION public.context_job_story_writer_input(uuid) IS
 'Story money book (20261028190000), job story text (20261009100000): everything the story writer reads, from one snapshot (STABLE): {version story-writer-input-v2, job_id, as_of, job_status, card (context_job_story(job, now()) with book: context_job_story_book(job, now()), the Money block and job lines from Job Profit), card_hash (context_job_story_full_hash of that card), current {text_id, card_hash, written_at, checked_at} or null, notes (context_job_story_ledger(job, null, now()): the live AI reading with every citation re-checked), transcript_row_ids (the job''s call.transcript_completed rows: their words are never prompt text)}. NULL for an unknown job. Read only. Service role only.';

-- 2. The block function goes.
DROP FUNCTION IF EXISTS public.context_job_story_bill_outcomes(uuid);

-- 3. Proof in the same transaction.
DO $verify$
DECLARE x record; live text;
BEGIN
 FOR x IN SELECT * FROM (VALUES
  ('public.context_job_story_full_hash(jsonb)', '8ae3b1581ba96299ce107410e8ac5b39'),
  ('public.context_job_story_text_get(uuid,jsonb,boolean)', '3cea9dd6df2d2f00660ccd8438637385'),
  ('public.context_job_story_request(uuid,text,text)', '7a75f855aafb50a8821a106ff64ba173'),
  ('public.context_job_story_writer_input(uuid)', '13097e3cc7abebfdeabff122bee66e1a')
 ) v(sig, want) LOOP
  SELECT md5(p.prosrc) INTO live FROM pg_proc p WHERE p.oid = to_regprocedure(x.sig);
  IF live IS DISTINCT FROM x.want THEN
   RAISE EXCEPTION 'context_story_bill_outcomes_down_body_mismatch: % md5 %', x.sig, coalesce(live, '<missing>');
  END IF;
 END LOOP;
END $verify$;
