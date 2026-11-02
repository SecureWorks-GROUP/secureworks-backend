-- TP-15/TP-16: transaction timestamps cannot prove which ledger contents a saved story covers.
-- Separate story witness; financial reader signature, source facts and money policy stay unchanged.
-- The claim's witness is persisted on save/unchanged; late commits remain due under existing gates.
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';
DO $patch$ BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('public.context_job_story_claim_state(uuid)')) = '30ec2722e096d24f11bb057e0c977f68'
 AND (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('public.context_job_story_text_save(uuid,uuid,uuid,jsonb,text,timestamp with time zone,uuid,text,text,jsonb)')) = 'e6340b260c0b7f54bc676ad17e381ce9'
 AND (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('public.context_job_story_request_finish(uuid,uuid,text,text,timestamp with time zone)')) = '5ac979250977d293fcc99559e79daaea'
 AND (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('public.context_job_story_enqueue_changed(integer)')) = 'dd2fa73b0f81ebfa586179dcb1adca2d'
 AND (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('public.context_job_story_ledger_sig(uuid)')) = '4beb600043f868e7ec57d4db847890e8' THEN RETURN; END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('public.context_job_story_enqueue_changed(integer)')) IS DISTINCT FROM '143a88acac3b0fd0e894f127eebed188' THEN RAISE EXCEPTION 'story_ledger_witness_preimage_mismatch: context_job_story_enqueue_changed'; END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('public.context_job_story_claim_state(uuid)')) IS DISTINCT FROM '2f53d49dc49e9382d2ff3c6d98714761' THEN RAISE EXCEPTION 'story_ledger_witness_preimage_mismatch: context_job_story_claim_state'; END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('public.context_job_story_text_save(uuid,uuid,uuid,jsonb,text,timestamp with time zone,uuid,text,text,jsonb)')) IS DISTINCT FROM 'bafcdef63d08ec0dfe750ef07768abcb' THEN RAISE EXCEPTION 'story_ledger_witness_preimage_mismatch: context_job_story_text_save'; END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('public.context_job_story_request_finish(uuid,uuid,text,text,timestamp with time zone)')) IS DISTINCT FROM '032099f4f543efc989788613af6255b8' THEN RAISE EXCEPTION 'story_ledger_witness_preimage_mismatch: context_job_story_request_finish'; END IF;
 IF to_regprocedure('public.context_job_story_ledger_sig(uuid)') IS NOT NULL THEN RAISE EXCEPTION 'story_ledger_witness_helper_exists'; END IF;
 EXECUTE $ddl$CREATE OR REPLACE FUNCTION public.context_job_story_ledger_sig(p_job_id uuid)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $function$
 SELECT md5(jsonb_build_object('generation_id', r.generation_id, 'items', coalesce((
  SELECT jsonb_agg((to_jsonb(li) - 'created_at' - 'updated_at' - 'opened_at' - 'closed_at') ||
   jsonb_build_object('opened_at', to_char(li.opened_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US'),
                      'closed_at', to_char(li.closed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US'))
   ORDER BY li.item_key COLLATE "C")
  FROM public.context_ledger_items li WHERE li.job_id = p_job_id AND li.generation_id = r.generation_id
 ), '[]'::jsonb))::text)
 FROM (SELECT (SELECT x.generation_id FROM public.context_job_story_reading(p_job_id) x) AS generation_id) r
$function$;
$ddl$;
 REVOKE ALL ON FUNCTION public.context_job_story_ledger_sig(uuid) FROM PUBLIC, anon, authenticated;
 GRANT EXECUTE ON FUNCTION public.context_job_story_ledger_sig(uuid) TO service_role;
 EXECUTE $ddl$CREATE OR REPLACE FUNCTION public.context_job_story_claim_state(p_job_id uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
 SELECT jsonb_build_object(
  'job_status', (SELECT jb.status::text FROM public.jobs jb WHERE jb.id = p_job_id),
  'record_sig', public.context_job_story_record_sig(p_job_id),
  'generation_id', (SELECT r.generation_id FROM public.context_job_story_reading(p_job_id) r),
  'evidence_until', (SELECT r.evidence_until FROM public.context_job_story_reading(p_job_id) r),
  'money_sig', public.context_job_story_money_sig(p_job_id),
  'ledger_sig', public.context_job_story_ledger_sig(p_job_id))
$function$
$ddl$;
 EXECUTE $ddl$CREATE OR REPLACE FUNCTION public.context_job_story_text_save(p_request_id uuid, p_lease_token uuid, p_job_id uuid, p_sections jsonb, p_card_hash text, p_evidence_until timestamp with time zone, p_generation_id uuid, p_model text, p_prompt_sha256 text, p_checks jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE r public.context_job_story_requests; v_problem text; v_old uuid; v_new uuid; v_checks jsonb := coalesce(p_checks, '{}'::jsonb);
BEGIN
 IF p_request_id IS NULL OR p_lease_token IS NULL OR p_job_id IS NULL THEN
  RETURN jsonb_build_object('outcome', 'refused', 'reason', 'ids_required');
 END IF;
 -- the job's lock first (as a request takes it), then the request row
 PERFORM pg_advisory_xact_lock(20261009, hashtext(p_job_id::text));
 SELECT * INTO r FROM public.context_job_story_requests q WHERE q.id = p_request_id FOR UPDATE;
 IF r.id IS NULL OR r.done_at IS NOT NULL OR r.lease_token IS DISTINCT FROM p_lease_token
  OR r.lease_expires_at IS NULL OR r.lease_expires_at <= now() THEN
  RETURN jsonb_build_object('outcome', 'lease_lost');
 END IF;
 IF r.job_id <> p_job_id THEN
  RETURN jsonb_build_object('outcome', 'refused', 'reason', 'job_mismatch');
 END IF;
 v_problem := public.context_job_story_sections_problem(p_sections);
 IF v_problem IS NOT NULL THEN
  RETURN jsonb_build_object('outcome', 'refused', 'reason', 'sections_invalid', 'problem', v_problem);
 END IF;
 IF p_card_hash IS NULL OR p_card_hash !~ '^[0-9a-f]{32}$' THEN
  RETURN jsonb_build_object('outcome', 'refused', 'reason', 'card_hash_invalid');
 END IF;
 IF p_model IS NULL OR p_model !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$' THEN
  RETURN jsonb_build_object('outcome', 'refused', 'reason', 'model_invalid');
 END IF;
 IF p_prompt_sha256 IS NOT NULL AND p_prompt_sha256 !~ '^[0-9a-f]{64}$' THEN
  RETURN jsonb_build_object('outcome', 'refused', 'reason', 'prompt_sha256_invalid');
 END IF;
 -- The claim's content witness covers only what the writer could have read. Never acknowledge
 -- a correction that committed during generation by recomputing this at save time.
 IF jsonb_typeof(v_checks) = 'object' THEN
  v_checks := v_checks - 'ledger_sig';
  IF r.claimed_state ->> 'ledger_sig' ~ '^[0-9a-f]{32}$' THEN
   v_checks := v_checks || jsonb_build_object('ledger_sig', r.claimed_state ->> 'ledger_sig');
  END IF;
 END IF;
 v_problem := public.context_job_story_checks_problem(v_checks);
 IF v_problem IS NOT NULL THEN
  RETURN jsonb_build_object('outcome', 'refused', 'reason', 'checks_invalid', 'problem', v_problem);
 END IF;
 UPDATE public.context_job_story_texts SET status = 'superseded', superseded_at = now()
 WHERE job_id = p_job_id AND status = 'current'
 RETURNING id INTO v_old;
 INSERT INTO public.context_job_story_texts (job_id, request_id, checked_at, evidence_until, generation_id, job_status, record_sig,
  card_hash, model, prompt_sha256, sections, checks)
 VALUES (p_job_id, r.id, r.picked_at,
  coalesce(p_evidence_until, (r.claimed_state ->> 'evidence_until')::timestamptz),
  coalesce(p_generation_id, (r.claimed_state ->> 'generation_id')::uuid),
  coalesce(r.claimed_state ->> 'job_status', (SELECT jb.status::text FROM public.jobs jb WHERE jb.id = p_job_id)),
  r.claimed_state ->> 'record_sig',
  p_card_hash, p_model, p_prompt_sha256, p_sections, v_checks)
 RETURNING id INTO v_new;
 UPDATE public.context_job_story_requests SET done_at = now(), outcome = 'written', error = NULL, lease_token = NULL, lease_expires_at = NULL
 WHERE id = r.id;
 RETURN jsonb_build_object('outcome', 'saved', 'text_id', v_new, 'superseded_id', v_old);
END $function$
$ddl$;
 EXECUTE $ddl$CREATE OR REPLACE FUNCTION public.context_job_story_request_finish(p_request_id uuid, p_lease_token uuid, p_outcome text, p_error text DEFAULT NULL::text, p_retry_at timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
   evidence_until = CASE WHEN r.claimed_state ? 'evidence_until' THEN (r.claimed_state ->> 'evidence_until')::timestamptz ELSE t.evidence_until END,
   -- a story written with the Money block now covers the money as the claim found it (a change the
   -- book does not print, a bill paid, leaves the words as they are and must not wake it again)
   checks = CASE WHEN t.checks ? 'money_sig' AND r.claimed_state ->> 'money_sig' ~ '^[0-9a-f]{32}$'
                 THEN jsonb_set(t.checks, '{money_sig}', r.claimed_state -> 'money_sig') ELSE t.checks END - 'ledger_sig'
            || CASE WHEN r.claimed_state ->> 'ledger_sig' ~ '^[0-9a-f]{32}$'
                    THEN jsonb_build_object('ledger_sig', r.claimed_state ->> 'ledger_sig') ELSE '{}'::jsonb END
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
END $function$
$ddl$;
 EXECUTE $ddl$CREATE OR REPLACE FUNCTION public.context_job_story_enqueue_changed(p_limit integer DEFAULT NULL::integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE pol jsonb := public.context_job_story_text_policy(); bpol jsonb := public.context_job_story_book_policy(); v_cap integer; v_limit integer;
 v_rewrite interval; v_quiet interval; v_after interval; v_failed interval; v_open integer; v_cand uuid[]; v_done uuid[]; v_jobs uuid[];
 v_ids jsonb;
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
 v_after := make_interval(days => (bpol ->> 'after_done_days')::integer);
 v_failed := make_interval(hours => (bpol ->> 'failed_backoff_hours')::integer);
 SELECT count(*)::integer INTO v_open FROM public.context_job_story_requests q WHERE q.done_at IS NULL;
 -- 1. Cheap signals first: a current story older than the rewrite floor, no open request, a live job
 --    (or one complete, completed or archived inside after_done_days of its completion or client
 --    sign-off, when its last costs land), and something newer than the story covers: the job's
 --    status, its AI reading (a new generation, or the same one read further), its customer
 --    invoices' money or its quotes' times (only when a row was touched since, then confirmed by the
 --    record signature), its money (the money signature differs from the one the story was written
 --    with: a bill, crew line, order, credit or sign-off placed or removed), or, with no AI reading at
 --    all, a message row recorded since that has been quiet for quiet_minutes. A story written without
 --    the Money block (no checks.money_sig) is rewritten only while fewer than backfill_open_max
 --    requests are open, and after every real change. A job whose request closed failed inside
 --    failed_backoff_hours is left alone unless a later successful story supersedes that failure. Every candidate is kept (no limit here), so a job the lead
 --    rule refuses below can never hold the head of the order.
 SELECT array_agg(c.job_id ORDER BY c.backfill, c.checked_at, c.job_id),
        array_agg(c.job_id) FILTER (WHERE c.finished) INTO v_cand, v_done
 FROM (
  SELECT t.job_id, t.checked_at, (NOT coalesce(t.checks ? 'money_sig', false) OR NOT coalesce(t.checks ->> 'ledger_sig' ~ '^[0-9a-f]{32}$', false)) AS backfill,
         jb.status::text IN ('archived', 'complete', 'completed') AS finished
  FROM public.context_job_story_texts t
  JOIN public.jobs jb ON jb.id = t.job_id
  LEFT JOIN LATERAL public.context_job_story_reading(t.job_id) lg ON true
  WHERE t.status = 'current'
    AND t.written_at <= now() - v_rewrite
    AND NOT EXISTS (SELECT 1 FROM public.context_job_story_requests q WHERE q.job_id = t.job_id AND q.done_at IS NULL)
    AND NOT EXISTS (SELECT 1 FROM public.context_job_story_requests q
                    WHERE q.job_id = t.job_id AND q.outcome = 'failed' AND q.done_at > now() - v_failed AND q.done_at >= t.written_at)
    AND (jb.status::text NOT IN ('cancelled', 'draft', 'archived', 'complete', 'completed', 'lost')
         OR (jb.status::text IN ('archived', 'complete', 'completed')
             AND greatest(jb.completed_at, (SELECT max(s.created_at) FROM public.job_client_signoffs s WHERE s.job_id = t.job_id))
                 > now() - v_after))
    AND coalesce(jb.metadata ->> 'do_not_schedule', '') NOT IN ('true', '1')
    AND (jb.status::text IS DISTINCT FROM t.job_status
         OR lg.generation_id IS DISTINCT FROM t.generation_id
         OR date_trunc('milliseconds', lg.evidence_until) IS DISTINCT FROM date_trunc('milliseconds', t.evidence_until)
         OR (coalesce(t.checks ->> 'ledger_sig' ~ '^[0-9a-f]{32}$', false)
             AND public.context_job_story_ledger_sig(t.job_id) IS DISTINCT FROM t.checks ->> 'ledger_sig')
         OR (NOT coalesce(t.checks ->> 'ledger_sig' ~ '^[0-9a-f]{32}$', false)
             AND v_open < (bpol ->> 'backfill_open_max')::integer)
         OR EXISTS (SELECT 1 FROM public.context_ledger_items li
                    WHERE li.job_id = t.job_id AND li.generation_id = lg.generation_id
                      AND greatest(li.created_at, li.updated_at) > t.checked_at)
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
                AND coalesce(e.recorded_at, e.occurred_at) <= now() - v_quiet))
         OR (coalesce(t.checks ? 'money_sig', false)
             AND public.context_job_story_money_sig(t.job_id) IS DISTINCT FROM t.checks ->> 'money_sig')
         OR (NOT coalesce(t.checks ? 'money_sig', false) AND v_open < (bpol ->> 'backfill_open_max')::integer))
  ) c;
 IF v_cand IS NULL THEN
  RETURN jsonb_build_object('outcome', 'queued', 'queued', 0, 'job_ids', '[]'::jsonb, 'candidates', 0);
 END IF;
 -- 2. Then the lead rule, for the live survivors only: a lead no longer followed up is never rewritten
 --    by itself. A finished job inside after_done_days is no lead and keeps its 30 days.
 SELECT array_agg(k.job_id ORDER BY k.ord) INTO v_jobs
 FROM unnest(v_cand) WITH ORDINALITY AS k(job_id, ord)
 WHERE k.job_id = ANY (coalesce(v_done, '{}'::uuid[]))
    OR k.job_id IN (SELECT m.job_id FROM public.context_lead_monitored_jobs(
         ARRAY(SELECT x FROM unnest(v_cand) x WHERE NOT x = ANY (coalesce(v_done, '{}'::uuid[]))), now()) m WHERE m.monitored);
 WITH ins AS (
  INSERT INTO public.context_job_story_requests (job_id, requested_by, reason)
  SELECT j.job_id, pol ->> 'writer', 'job_changed'
  FROM unnest(coalesce(v_jobs, '{}'::uuid[])) WITH ORDINALITY AS j(job_id, ord)
  WHERE j.ord <= v_limit
  ON CONFLICT (job_id) WHERE done_at IS NULL DO NOTHING
  RETURNING job_id)
 SELECT coalesce(jsonb_agg(ins.job_id ORDER BY ins.job_id), '[]'::jsonb) INTO v_ids FROM ins;
 RETURN jsonb_build_object('outcome', 'queued', 'queued', jsonb_array_length(v_ids), 'job_ids', v_ids, 'candidates', cardinality(v_cand));
END $function$
$ddl$;
END $patch$;
