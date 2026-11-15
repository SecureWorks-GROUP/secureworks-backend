-- Job story: the first written story of a job (15 Nov 2026).
--
-- Why: context_job_story_enqueue_changed (20261028190000) only looks at jobs that already hold a
-- current story. A first story was only ever written when a person asked for one, so on 15 Nov
-- 2026 production held no current story at all (3 texts ever, all superseded) while 538 live jobs
-- had live AI notes. This adds the one rule for "this job has never had its story written": the
-- worker calls it each tick beside the changed-jobs rule. It changes no existing function.
--
-- The rule: the switch (context_job_story_text_v1) is on; fewer than backfill_open_max requests are
-- open, so first stories never crowd a real change; the job is live (never a holding job), holds no
-- current story and no open request, has live AI notes, has no request that closed failed inside
-- failed_backoff_hours or since its notes last changed (a job the writer cannot do is tried again
-- only when its notes move), and the lead rule still monitors it. Most recently read first.

DO $guard$
BEGIN
  IF to_regprocedure('public.context_job_story_text_policy()') IS NULL
     OR to_regprocedure('public.context_job_story_book_policy()') IS NULL
     OR to_regprocedure('public.context_job_story_text_on()') IS NULL
     OR to_regprocedure('public.context_lead_monitored_jobs(uuid[], timestamp with time zone)') IS NULL
     OR to_regclass('public.context_job_story_requests') IS NULL
     OR to_regclass('public.context_job_story_texts') IS NULL
     OR to_regclass('public.context_ledger_generations') IS NULL THEN
    RAISE EXCEPTION 'context_story_first_stories_preimage_mismatch: the saved job story, the lead rule or the ledger store is missing';
  END IF;
END
$guard$;

CREATE OR REPLACE FUNCTION public.context_job_story_enqueue_first(p_limit integer DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE pol jsonb := public.context_job_story_text_policy(); bpol jsonb := public.context_job_story_book_policy();
 v_cap integer; v_limit integer; v_failed interval; v_open integer; v_cand uuid[]; v_ids jsonb;
BEGIN
 IF NOT public.context_job_story_text_on() THEN
  RETURN jsonb_build_object('outcome', 'off', 'queued', 0, 'job_ids', '[]'::jsonb);
 END IF;
 v_cap := (pol ->> 'enqueue_per_call')::integer;
 v_limit := least(greatest(coalesce(p_limit, v_cap), 0), v_cap);
 SELECT count(*)::integer INTO v_open FROM public.context_job_story_requests q WHERE q.done_at IS NULL;
 -- First stories fill only the room real changes leave.
 v_limit := least(v_limit, (bpol ->> 'backfill_open_max')::integer - v_open);
 IF v_limit <= 0 THEN
  RETURN jsonb_build_object('outcome', 'queued', 'queued', 0, 'job_ids', '[]'::jsonb, 'candidates', 0);
 END IF;
 v_failed := make_interval(hours => (bpol ->> 'failed_backoff_hours')::integer);
 -- Every candidate is kept (no limit here), so a lead the rule refuses below never holds the head of the order.
 SELECT array_agg(c.job_id ORDER BY c.evidence_until DESC NULLS LAST, c.job_id) INTO v_cand
 FROM (
  SELECT g.job_id, max(g.evidence_until) AS evidence_until, max(g.updated_at) AS read_at
  FROM public.context_ledger_generations g
  JOIN public.jobs jb ON jb.id = g.job_id
  WHERE g.status = 'live'
    AND jb.status::text NOT IN ('cancelled', 'draft', 'archived', 'complete', 'completed', 'lost')
    AND lower(coalesce(jb.metadata ->> 'do_not_schedule', '')) <> 'true'
    AND NOT EXISTS (SELECT 1 FROM public.context_job_story_texts t WHERE t.job_id = g.job_id AND t.status = 'current')
    AND NOT EXISTS (SELECT 1 FROM public.context_job_story_requests q WHERE q.job_id = g.job_id AND q.done_at IS NULL)
  GROUP BY g.job_id
 ) c
 WHERE NOT EXISTS (SELECT 1 FROM public.context_job_story_requests q
                   WHERE q.job_id = c.job_id AND q.outcome = 'failed'
                     AND (q.done_at > now() - v_failed OR q.done_at >= c.read_at));
 IF v_cand IS NULL THEN
  RETURN jsonb_build_object('outcome', 'queued', 'queued', 0, 'job_ids', '[]'::jsonb, 'candidates', 0);
 END IF;
 WITH kept AS (
  SELECT k.job_id, k.ord
  FROM unnest(v_cand) WITH ORDINALITY AS k(job_id, ord)
  WHERE k.job_id IN (SELECT m.job_id FROM public.context_lead_monitored_jobs(v_cand, now()) m WHERE m.monitored)
  ORDER BY k.ord
  LIMIT v_limit),
 ins AS (
  INSERT INTO public.context_job_story_requests (job_id, requested_by, reason)
  SELECT kept.job_id, 'luna-story-first', 'job_changed' FROM kept
  ON CONFLICT (job_id) WHERE done_at IS NULL DO NOTHING
  RETURNING job_id)
 SELECT coalesce(jsonb_agg(ins.job_id ORDER BY ins.job_id), '[]'::jsonb) INTO v_ids FROM ins;
 RETURN jsonb_build_object('outcome', 'queued', 'queued', jsonb_array_length(v_ids), 'job_ids', v_ids, 'candidates', cardinality(v_cand));
END
$function$;

COMMENT ON FUNCTION public.context_job_story_enqueue_first(integer) IS
'Job story first stories (20261115091000): the one rule for "this job has never had its story written" (the worker calls it each tick beside context_job_story_enqueue_changed). Queues reason job_changed, requested_by luna-story-first, for at most p_limit (default and most enqueue_per_call) jobs and never past backfill_open_max open requests: a live job (never a holding job) with live AI notes, no current story, no open request, no request closed failed inside failed_backoff_hours or since its notes last changed, monitored by the lead rule (context_lead_monitored_jobs, asked for every candidate so a refused lead never holds the head of the order). Most recently read first. {outcome off|queued, queued, job_ids, candidates}. Service role only.';

REVOKE ALL ON FUNCTION public.context_job_story_enqueue_first(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.context_job_story_enqueue_first(integer) TO service_role;
