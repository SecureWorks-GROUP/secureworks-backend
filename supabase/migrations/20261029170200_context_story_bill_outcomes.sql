-- The job story card carries each placed supplier bill's H7 outcome (INT-10 follow-on), 29 Oct 2026.
--
-- Why. Finance's H7 read (20261029170000 cfo_bill_cost_outcomes, 20261029170100
-- context_job_bill_outcomes) says, for each supplier bill placed on a job, where the engine counts
-- its cost. ops-api job_overview shows it as `bills`, but the job story card the writer reads did
-- not carry it, so a written story could not say a bill counts on another job, or that where it
-- counts is not known.
--
-- What it adds:
--  1. context_job_story_bill_outcomes(job): the card's bill_outcomes block. It reads
--     context_job_bill_outcomes(job) and nothing else, applies the ops-api reader's refusals (shape,
--     contract version cfo-bill-cost-outcome-v1, no number and no money-named key anywhere) and
--     passes on, per bill, where_counted, the reason code, bill_state and mirror_bill. Unknown stays
--     "unknown: <reason>"; a refused or failed read is a block with status refused, never "no
--     bills". NULL for a job with no placed bill, so that card reads exactly as before.
--  2. Replaced (four bodies of 20261028190000, each a few lines):
--     context_job_story_writer_input: card.bill_outcomes beside card.book.
--     context_job_story_full_hash: a card with bill_outcomes folds in its digest
--      (story-digest-v1+story-book-v1+story-bills-v1); every other card hashes exactly as before.
--     context_job_story_text_get and context_job_story_request: compare the card with that block.
--
-- What moves. context_job_story_card_hash (story-digest-v1) is unchanged. The freshness hash a saved
-- story is compared with (context_job_story_full_hash, since 20261028190000) moves once for every job
-- with a placed supplier bill, so each such saved story reads stale once; a job with none is
-- unchanged. The sweep (context_job_story_enqueue_changed) is not changed: a stale read alone queues
-- nothing; the story is rewritten at its next wake (a bill placed or changed on the job moves the
-- money signature) or when a person presses Rewrite. The stories switch (context_job_story_text_v1)
-- is off today, so no model call is made until it is on.
--
-- Writes no table, column, row, index, trigger or cron job. Service role only.
--
-- Rollback: supabase/rollbacks/20261029170200_context_story_bill_outcomes_down.sql (the four bodies
-- back byte for byte, the block function dropped).
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- 0. Guard. Reports every problem at once.
DO $guard$
DECLARE problems text[] := '{}'; x record; live text;
BEGIN
 -- The replaced bodies: 20261028190000's, or this migration's (a re-apply).
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
 -- Read, never replaced: the H7 read and the story pieces the bodies call.
 IF to_regprocedure('public.context_job_bill_outcomes(uuid)') IS NULL
    OR coalesce(obj_description(to_regprocedure('public.context_job_bill_outcomes(uuid)'), 'pg_proc'), '') NOT LIKE 'Context H7 read, INT-10 (20261029170100)%' THEN
  problems := problems || 'public.context_job_bill_outcomes(uuid) (20261029170100) missing'::text;
 END IF;
 IF to_regprocedure('public.context_job_story_book(uuid,timestamptz)') IS NULL OR to_regprocedure('public.context_job_story_card_hash(jsonb)') IS NULL
    OR to_regprocedure('public.context_job_story(uuid,timestamptz,uuid,timestamptz,boolean)') IS NULL THEN
  problems := problems || 'the job story (20261006014000) or its money book (20261028190000) is missing'::text;
 END IF;
 IF to_regprocedure('public.context_job_story_bill_outcomes(uuid)') IS NOT NULL
    AND coalesce(obj_description(to_regprocedure('public.context_job_story_bill_outcomes(uuid)'), 'pg_proc'), '') NOT LIKE 'Story bill outcomes (20261029170200)%' THEN
  problems := problems || 'public.context_job_story_bill_outcomes(uuid) exists and is not this migration''s'::text;
 END IF;
 IF cardinality(problems) > 0 THEN
  RAISE EXCEPTION 'context_story_bill_outcomes_preimage_mismatch: %; read the live definitions before replacing them',
   array_to_string(problems, '; ');
 END IF;
END $guard$;

-- 1. The block: each placed supplier bill's H7 outcome, from the H7 read only, with no amount.
CREATE OR REPLACE FUNCTION public.context_job_story_bill_outcomes(p_job_id uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE
AS $fn$
DECLARE v_read jsonb; v_refused text; v_bills jsonb;
BEGIN
 IF p_job_id IS NULL THEN
  RETURN NULL;
 END IF;
 BEGIN
  v_read := public.context_job_bill_outcomes(p_job_id);
 EXCEPTION WHEN OTHERS THEN
  -- the read failed: the card says so, never "no bills" (a cancelled statement is not caught)
  v_refused := 'read_failed';
 END;
 -- the consumer's rules (ops-api job_bill_outcomes_read.ts): the shape, the producer's contract
 -- version, and no amount anywhere (no number, no money-named key)
 IF v_refused IS NULL THEN
  v_refused := CASE
   WHEN jsonb_typeof(v_read) IS DISTINCT FROM 'object' OR v_read ->> 'shape' IS DISTINCT FROM 'context-job-bill-outcomes-v1' THEN 'invalid_shape'
   WHEN v_read ->> 'contract_version' IS DISTINCT FROM 'cfo-bill-cost-outcome-v1'
     OR v_read -> 'contract_versions_agree' IS DISTINCT FROM 'true'::jsonb THEN 'contract_mismatch'
   WHEN jsonb_path_exists(v_read, 'lax $.** ? (@.type() == "number")')
     OR jsonb_path_exists(v_read, 'lax $.** ? (@.type() == "object").keyvalue() ? (@.key like_regex "(_ex|_inc|amount|total|price|cost|owing|paid)" flag "i")')
     THEN 'amount_present'
   WHEN jsonb_typeof(v_read -> 'bills') IS DISTINCT FROM 'array' THEN 'invalid_shape'
   WHEN EXISTS (SELECT 1 FROM jsonb_array_elements(v_read -> 'bills') e
                WHERE jsonb_typeof(e.value) IS DISTINCT FROM 'object' OR coalesce(e.value ->> 'xero_invoice_id', '') = '') THEN 'invalid_shape'
  END;
 END IF;
 IF v_refused IS NOT NULL THEN
  RETURN jsonb_build_object('version', 'story-bill-outcomes-v1', 'job_id', p_job_id, 'source', 'context_job_bill_outcomes',
   'contract_version', CASE WHEN jsonb_typeof(v_read -> 'contract_version') = 'string' THEN v_read ->> 'contract_version' END,
   'status', 'refused', 'refused', v_refused, 'outcome', 'unknown: ' || v_refused, 'bills', '[]'::jsonb,
   'digest', md5('story-bill-outcomes-v1|refused|' || v_refused));
 END IF;
 SELECT jsonb_agg(x.o ORDER BY x.k1 COLLATE "C", x.k2 COLLATE "C") INTO v_bills
 FROM (
  SELECT jsonb_build_object(
    'xero_invoice_id', b.v ->> 'xero_invoice_id',
    'invoice_number', b.v ->> 'invoice_number',
    'supplier', b.v ->> 'supplier',
    'bill_status', b.v ->> 'bill_status',
    'where_counted', b.wc,
    'reason', b.reason,
    'bill_state', b.bs,
    'mirror_bill', CASE WHEN jsonb_typeof(b.v -> 'mirror_bill') = 'boolean' THEN b.v -> 'mirror_bill' ELSE 'null'::jsonb END,
    'held_reason', b.v ->> 'held_reason',
    'other_jobs', (SELECT coalesce(jsonb_agg(jsonb_build_object('job_number', oj.value ->> 'job_number', 'counts', oj.value ->> 'counts')
                                  ORDER BY oj.value ->> 'job_number' COLLATE "C", oj.value ->> 'job_id' COLLATE "C"), '[]'::jsonb)
                   FROM jsonb_array_elements(CASE WHEN jsonb_typeof(b.v -> 'other_jobs') = 'array' THEN b.v -> 'other_jobs' ELSE '[]'::jsonb END) oj),
    -- unknown and held name their reason: "unknown: <reason>", never a count
    'outcome', CASE WHEN b.wc IN ('unknown', 'held') THEN b.wc || ': ' || b.reason ELSE b.wc END) AS o,
   coalesce(b.v ->> 'invoice_number', '') AS k1, coalesce(b.v ->> 'xero_invoice_id', '') AS k2
  FROM (
   -- the reason: CFO's code for this job (here.reason), held_reason when held; when where the bill counts
   -- is unknown, why: here.reason when the placement here is unknown, else bill_state_unknown (CFO's
   -- bill_state), not_placed_here (no placement on this job) or where_counted_unknown (a value this
   -- card does not know, or "here" without a counted placement here)
   SELECT e.value AS v, w.wc, s.bs,
          CASE WHEN w.wc = 'held' THEN coalesce(e.value ->> 'held_reason', 'reason_not_given')
               WHEN w.wc <> 'unknown' THEN e.value #>> '{here,reason}'
               WHEN e.value #>> '{here,counts}' = 'unknown' THEN coalesce(e.value #>> '{here,reason}', 'reason_not_given')
               WHEN s.bs = 'unknown' THEN 'bill_state_unknown'
               WHEN jsonb_typeof(e.value -> 'here') IS DISTINCT FROM 'object' THEN 'not_placed_here'
               ELSE 'where_counted_unknown' END AS reason
   FROM jsonb_array_elements(v_read -> 'bills') e
   -- CFO's bill_state as it stands; a state this card does not know reads unknown, never counted
   CROSS JOIN LATERAL (SELECT CASE WHEN e.value ->> 'bill_state' IN ('unknown', 'voided', 'trade_mirror', 'held', 'not_job_related',
                                   'overhead', 'not_counted', 'over_counted', 'counted_in_full', 'counted_in_part')
                                   THEN e.value ->> 'bill_state' ELSE 'unknown' END AS bs) s
   -- where it counts, normalised as the ops-api reader does: unknown with no placement here or an
   -- unknown one, and "here" only with a counted placement here
   CROSS JOIN LATERAL (SELECT CASE
     WHEN e.value ->> 'where_counted' NOT IN ('here', 'elsewhere', 'here_and_elsewhere', 'no_job', 'trade_app', 'held')
       OR e.value ->> 'where_counted' IS NULL THEN 'unknown'
     WHEN jsonb_typeof(e.value -> 'here') IS DISTINCT FROM 'object'
       OR e.value #>> '{here,counts}' IS NULL OR e.value #>> '{here,counts}' NOT IN ('counted', 'not_counted', 'held') THEN 'unknown'
     WHEN e.value ->> 'where_counted' IN ('here', 'here_and_elsewhere') AND e.value #>> '{here,counts}' <> 'counted' THEN 'unknown'
     ELSE e.value ->> 'where_counted' END AS wc) w
  ) b
 ) x;
 IF v_bills IS NULL THEN
  -- no placed bill: no block, so the card reads exactly as before
  RETURN NULL;
 END IF;
 RETURN jsonb_build_object('version', 'story-bill-outcomes-v1', 'job_id', p_job_id, 'source', 'context_job_bill_outcomes',
  'contract_version', v_read ->> 'contract_version', 'status', 'ok', 'refused', NULL, 'outcome', NULL, 'bills', v_bills,
  -- the stable facts only: where each bill counts and why, never its Xero status (a payment moves nothing)
  'digest', md5((SELECT jsonb_agg(b - 'invoice_number' - 'supplier' - 'bill_status' - 'outcome'
                                  ORDER BY b ->> 'xero_invoice_id' COLLATE "C")
                 FROM jsonb_array_elements(v_bills) b)::text));
END $fn$;
COMMENT ON FUNCTION public.context_job_story_bill_outcomes(uuid) IS
 'Story bill outcomes (20261029170200): the job story card''s bill_outcomes block: for each supplier bill placed on the job, where Finance''s engine counts its cost, read only through the H7 read context_job_bill_outcomes(job) (CFO''s rule, 20261029170000), never re-derived: {version story-bill-outcomes-v1, job_id, source, contract_version, status ok|refused, refused (read_failed, invalid_shape, contract_mismatch or amount_present, the ops-api reader''s rules), outcome ("unknown: <code>" when refused), bills, digest}. Each bill: xero_invoice_id, invoice_number, supplier, bill_status, where_counted (here, elsewhere, here_and_elsewhere, no_job, trade_app, held or unknown, normalised as the ops-api reader does: unknown with no placement here or an unknown one, any other value, or here without a counted placement here), reason (here.reason; held_reason when held; when unknown, why: here.reason for an unknown placement here, else bill_state_unknown, not_placed_here or where_counted_unknown), bill_state (CFO''s; a state this card does not know reads unknown), mirror_bill, held_reason, other_jobs [{job_number, counts}], outcome (where_counted, or "unknown: <reason>" / "held: <reason>"). No amount: a read carrying a number or a money-named key is refused whole. Bills in invoice number then bill id order, C collation. digest: md5 of the bills less invoice number, supplier, Xero status and outcome words, so a payment never moves it. NULL when the job has no placed bill (the card reads exactly as before). Read only. Service role only.';

-- 2. What a saved story is fresh against: the card's digest, the book's and, when the card has one, the bill outcomes block's.
CREATE OR REPLACE FUNCTION public.context_job_story_full_hash(p_card jsonb)
RETURNS text
LANGUAGE sql STABLE STRICT
AS $fn$
 -- (story bill outcomes, 20261029170200) a card carrying bill_outcomes (a job with placed supplier
 -- bills) also folds in that block's digest; any other card hashes exactly as before
 SELECT CASE WHEN jsonb_typeof(p_card -> 'bill_outcomes') = 'object'
   THEN md5('story-digest-v1+story-book-v1+story-bills-v1|' || coalesce(public.context_job_story_card_hash(p_card), '') || '|'
            || coalesce(p_card #>> '{book,digest}', 'none') || '|' || coalesce(p_card #>> '{bill_outcomes,digest}', 'none'))
   ELSE md5('story-digest-v1+story-book-v1|' || coalesce(public.context_job_story_card_hash(p_card), '') || '|'
            || coalesce(p_card #>> '{book,digest}', 'none')) END
$fn$;
COMMENT ON FUNCTION public.context_job_story_full_hash(jsonb) IS
 'Story money book (20261028190000): the hash a saved story is fresh against (story-digest-v1+story-book-v1): md5 of the card''s story-digest-v1 hash (context_job_story_card_hash) and the book''s digest (card.book.digest, none without one). A money change the book shows makes the story stale; the clock alone never does. Null for a null card. Service role only. Story bill outcomes (20261029170200): a card with bill_outcomes (context_job_story_bill_outcomes: only a job with placed supplier bills has one) hashes as story-digest-v1+story-book-v1+story-bills-v1, folding in bill_outcomes.digest, so a change in where a placed bill counts makes the story stale; a card without it hashes exactly as before.';

-- 3. The staff read: freshness compares the card with its bill outcomes block.
CREATE OR REPLACE FUNCTION public.context_job_story_text_get(p_job_id uuid, p_card jsonb DEFAULT NULL, p_check boolean DEFAULT true)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $fn$
DECLARE t public.context_job_story_texts; r public.context_job_story_requests; v_card jsonb; v_hash text; v_status text;
 v_fail_error text; v_fail_at timestamptz; v_book jsonb; v_bills jsonb;
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
 -- (story bill outcomes, 20261029170200) compared only when there is a story: with none the status is
 -- none whatever the card says, so neither the card, its bill read nor a hash is worked out (card_hash null)
 IF coalesce(p_check, true) AND t.id IS NOT NULL THEN
  -- the card the caller just read, else built now
  v_card := coalesce(p_card, public.context_job_story(p_job_id, now()));
  -- a card that is not this job's is no answer
  IF v_card IS NOT NULL AND (v_card #>> '{job,id}') IS DISTINCT FROM p_job_id::text THEN
   v_card := NULL;
  END IF;
  IF v_card IS NOT NULL THEN
   v_card := v_card || jsonb_build_object('book', v_book);
   -- (story bill outcomes, 20261029170200) where each placed bill counts, as the writer's card carries it:
   -- p_card's own block when it is this job's, else read once here; none for a job with no placed bill
   IF jsonb_typeof(p_card -> 'bill_outcomes') = 'object' AND (p_card #>> '{bill_outcomes,job_id}') = p_job_id::text THEN
    v_bills := p_card -> 'bill_outcomes';
   ELSE
    v_bills := public.context_job_story_bill_outcomes(p_job_id);
   END IF;
   v_card := v_card - 'bill_outcomes';
   IF v_bills IS NOT NULL THEN
    v_card := v_card || jsonb_build_object('bill_outcomes', v_bills);
   END IF;
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
 'Story money book (20261028190000), job story text (20261009100000): the saved story of one job for the staff door (ops-api job_overview): {version job-story-text-v1, job_id, status, card_hash, text, writer, money}. status: none (no story), fresh (its card_hash equals context_job_story_full_hash of the card now with its book), stale, or unchecked (not compared: p_check false, or no card of this job). p_card: the job-story-v1 card the caller has just read (a card of another job is ignored); null builds context_job_story(job, now()) when there is a story to compare; the book is p_card.book when it is this job''s, else built once (context_job_story_book). text: {id, written_at, checked_at, evidence_until, generation_id, card_hash, model, sections, inputs} or null. writer: {on, open_request {id, reason, requested_at, picked_at, attempts, next_attempt_at} or null, last_failure {error, at} newer than the story, or null}. money: the book''s {version, source, lines, complete, incomplete_line}, shown word for word under the story. NULL for an unknown job. Read only. Service role only. Story bill outcomes (20261029170200): freshness compares the card with its bill_outcomes block too (p_cards when it is this jobs, else context_job_story_bill_outcomes, read only when a card is compared); a job with no story compares nothing (status none, card_hash null), so its bills are not read; the answers keys are unchanged.';

-- 4. Ask for a story: "recent" compares the card with its book and bill outcomes block.
CREATE OR REPLACE FUNCTION public.context_job_story_request(p_job_id uuid, p_by text, p_reason text DEFAULT 'asked')
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $fn$
DECLARE pol jsonb := public.context_job_story_text_policy(); r public.context_job_story_requests; t public.context_job_story_texts;
 v_card jsonb; v_monitored boolean; v_id uuid; v_at timestamptz; v_bills jsonb;
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
  -- (story bill outcomes, 20261029170200) the card as the writer reads it: with its book and, for a job
  -- with placed bills, its bill_outcomes block
  IF v_card IS NOT NULL THEN
   v_bills := public.context_job_story_bill_outcomes(p_job_id);
   v_card := v_card || jsonb_build_object('book', public.context_job_story_book(p_job_id, now()))
             || CASE WHEN v_bills IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('bill_outcomes', v_bills) END;
  END IF;
  IF v_card IS NOT NULL
     AND public.context_job_story_full_hash(v_card) = t.card_hash THEN
   RETURN jsonb_build_object('outcome', 'recent', 'text_id', t.id, 'written_at', t.written_at);
  END IF;
 END IF;
 INSERT INTO public.context_job_story_requests (job_id, requested_by, reason) VALUES (p_job_id, p_by, p_reason)
 RETURNING id, requested_at INTO v_id, v_at;
 RETURN jsonb_build_object('outcome', 'queued', 'request_id', v_id, 'requested_at', v_at, 'reason', p_reason);
END $fn$;
COMMENT ON FUNCTION public.context_job_story_request(uuid, text, text) IS
 'Story money book (20261028190000), job story text (20261009100000): asks for a job''s story to be written or rewritten: {outcome queued|already_open|recent|off|not_live, request_id, requested_at, reason}. off while the switch is off (nothing written); already_open returns the open request (idempotent; one open a job); recent while the current story is under min_rewrite_minutes old and its card_hash still equals the full hash of the card now with its book (context_job_story_full_hash; built once, only then); job_changed only for a live, monitored job (context_lead_monitored_jobs; else not_live), asked on any job. p_by: user:<id> from the verified session, or a server caller''s actor (letters, digits and _ . : @ -, 1 to 128). Raises context_job_story_request_invalid for bad arguments or an unknown job. Takes the job''s advisory lock (20261009). Service role only. Story bill outcomes (20261029170200): "recent" compares the full hash of the card with its book and, for a job with placed bills, its bill_outcomes block.';

-- 5. What the writer reads: the card with its book and, when the job has a placed bill, its bill outcomes.
CREATE OR REPLACE FUNCTION public.context_job_story_writer_input(p_job_id uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $fn$
DECLARE v_status text; v_card jsonb; t public.context_job_story_texts; v_bills jsonb;
BEGIN
 SELECT jb.status::text INTO v_status FROM public.jobs jb WHERE jb.id = p_job_id;
 IF NOT FOUND THEN
  RETURN NULL;
 END IF;
 v_card := public.context_job_story(p_job_id, now());
 -- (20261028190000) the Money block and the job lines from Job Profit: the writer shows the book, never sums
 IF v_card IS NOT NULL THEN
  v_card := v_card || jsonb_build_object('book', public.context_job_story_book(p_job_id, now()));
  -- (story bill outcomes, 20261029170200) where each placed supplier bill's cost counts, read from the
  -- H7 read (context_job_bill_outcomes) and carrying no amount; only when the job has a placed bill
  v_bills := public.context_job_story_bill_outcomes(p_job_id);
  IF v_bills IS NOT NULL THEN
   v_card := v_card || jsonb_build_object('bill_outcomes', v_bills);
  END IF;
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
 'Story money book (20261028190000), job story text (20261009100000): everything the story writer reads, from one snapshot (STABLE): {version story-writer-input-v2, job_id, as_of, job_status, card (context_job_story(job, now()) with book: context_job_story_book(job, now()), the Money block and job lines from Job Profit), card_hash (context_job_story_full_hash of that card), current {text_id, card_hash, written_at, checked_at} or null, notes (context_job_story_ledger(job, null, now()): the live AI reading with every citation re-checked), transcript_row_ids (the job''s call.transcript_completed rows: their words are never prompt text)}. NULL for an unknown job. Read only. Service role only. Story bill outcomes (20261029170200): the card also carries bill_outcomes (context_job_story_bill_outcomes) when the job has a placed supplier bill: each bills where_counted, reason, bill_state and mirror_bill from the H7 read, with no amount; card_hash folds in its digest. The version stays story-writer-input-v2 (a field added, none renamed).';

-- 6. Access: service role only, every function (CREATE OR REPLACE keeps a replaced function's grants; said again).
DO $grants$
DECLARE f text;
BEGIN
 FOREACH f IN ARRAY ARRAY['public.context_job_story_bill_outcomes(uuid)', 'public.context_job_story_full_hash(jsonb)',
   'public.context_job_story_text_get(uuid,jsonb,boolean)', 'public.context_job_story_request(uuid,text,text)',
   'public.context_job_story_writer_input(uuid)'] LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', f);
  EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f);
 END LOOP;
END $grants$;

-- 7. Proof in the same transaction.
DO $verify$
DECLARE x record; live text;
BEGIN
 FOR x IN SELECT * FROM (VALUES
  ('public.context_job_story_full_hash(jsonb)', 'a444e315f8aedc2af5de37f80c3e95ce'),
  ('public.context_job_story_text_get(uuid,jsonb,boolean)', 'ac51513f6164fa256011d67c1bd82b10'),
  ('public.context_job_story_request(uuid,text,text)', 'd3e09e9e36875955de47438509f40a3c'),
  ('public.context_job_story_writer_input(uuid)', '88d5ccf04d40e8cd8e6c7cee87e84f0b')
 ) v(sig, want) LOOP
  SELECT md5(p.prosrc) INTO live FROM pg_proc p WHERE p.oid = to_regprocedure(x.sig);
  IF live IS DISTINCT FROM x.want THEN
   RAISE EXCEPTION 'context_story_bill_outcomes_body_mismatch: % md5 %', x.sig, coalesce(live, '<missing>');
  END IF;
 END LOOP;
 -- a card without the block hashes exactly as 20261028190000's body did; one with it moves with its digest
 IF public.context_job_story_full_hash('{"job":{"id":"x","status":"quoted"},"book":{"digest":"a"}}'::jsonb)
    IS DISTINCT FROM md5('story-digest-v1+story-book-v1|' || public.context_job_story_card_hash('{"job":{"id":"x","status":"quoted"},"book":{"digest":"a"}}'::jsonb) || '|a')
    OR public.context_job_story_full_hash('{"job":{"id":"x"},"book":{"digest":"a"},"bill_outcomes":{"digest":"p"}}'::jsonb)
       IS NOT DISTINCT FROM public.context_job_story_full_hash('{"job":{"id":"x"},"book":{"digest":"a"},"bill_outcomes":{"digest":"q"}}'::jsonb) THEN
  RAISE EXCEPTION 'context_story_bill_outcomes_hash_mismatch: the freshness hash does not follow the bill outcomes block as it should';
 END IF;
END $verify$;
