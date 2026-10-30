-- TP-16: a successful story supersedes older failures for automatic correction.
-- Same-time/newer failures retain the existing backoff; no policy, grants, rows or schedules change.
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';
DO $$ DECLARE h text; BEGIN SELECT md5(prosrc) INTO h FROM pg_proc WHERE oid=to_regprocedure('public.context_job_story_enqueue_changed(integer)'); IF h IS NULL OR h NOT IN ('b0d7b0c0d3b99759c37814a68fab6b17','f4c040642a58cf9e5c281c76d94abecb') THEN RAISE EXCEPTION 'story_requeue_preimage_mismatch: %',h; END IF; END $$;
CREATE OR REPLACE FUNCTION public.context_job_story_enqueue_changed(p_limit integer DEFAULT NULL::integer)
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
  SELECT t.job_id, t.checked_at, NOT coalesce(t.checks ? 'money_sig', false) AS backfill,
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

;
COMMENT ON FUNCTION public.context_job_story_enqueue_changed(integer) IS 'Story money book (20261028190000), job story text (20261009100000): the one rule for "something new happened" (SQL decides what is due; the worker calls it each tick): queues reason job_changed, requested_by luna-story-writer, for at most p_limit (default and most enqueue_per_call, 5) jobs: a current story written more than min_rewrite_minutes ago, no open request, a live job (not cancelled, draft, archived, complete, completed or lost, never a holding job) or one complete, completed or archived whose completion (jobs.completed_at) or newest client sign-off is inside after_done_days (30) (no lead: the lead rule is not asked), a live one monitored by the lead rule (context_lead_monitored_jobs, read only for the live jobs the cheap signals keep, all of them, so a refused lead never holds the head of the order), no request for it closed failed inside failed_backoff_hours (24) at or after the current successful story; older failures do not suppress a later successful story, and something newer than the story covers: the job''s status differs from the story''s; its AI reading (context_job_story_reading) is another generation or reads to another evidence_until; a customer invoice or quote row was touched since checked_at and the record signature (context_job_story_record_sig) differs; its money signature (context_job_story_money_sig) differs from the story''s checks.money_sig; with no AI reading, a message row (not a copy) recorded since checked_at and quiet for quiet_minutes; or the story was written without the Money block (no checks.money_sig), only while fewer than backfill_open_max (10) requests are open. Real changes first, then the rewrites without the block, oldest checked first. {outcome off|queued, queued, job_ids, candidates}. Service role only.';
