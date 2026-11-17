-- FU15: a failed refresh cannot erase the rest of the weekly sample.
-- Definition only. job_truth_weekly_install remains an explicit director step.
SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.job_truth_weekly_draw(p_week date DEFAULT NULL,p_limit integer DEFAULT 20)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE
 v_week date := coalesce(p_week,date_trunc('week',now() AT TIME ZONE 'Australia/Perth')::date);
 v_job uuid; v_page jsonb; v_story jsonb; v_notes jsonb; v_refresh jsonb;
 v_ids jsonb := '[]'::jsonb; v_skipped jsonb := '[]'::jsonb; v_result jsonb; BEGIN
 IF p_limit IS NULL OR p_limit NOT BETWEEN 5 AND 20 THEN RAISE EXCEPTION 'weekly_draw_bad_limit'; END IF;
 -- Serialise only draws for this week. No business writer uses this lock.
 PERFORM pg_advisory_xact_lock(173701,v_week - DATE '2000-01-01');
 IF EXISTS (SELECT 1 FROM public.job_truth_weekly_samples WHERE week=v_week) THEN
   RETURN jsonb_build_object('outcome','already_drawn','week',v_week);
 END IF;
 -- Keep-ready ids join jobs_pkey and job_pages_pkey. job_change_marks is a view:
 -- its per-job reads use jobs_pkey, job_change_marks_pkey (on the base table),
 -- and job_change_mark_events_job. No new population read is added.
 -- Random order scans the eligible set once, only on the explicit weekly draw.
 FOR v_job IN
   SELECT j.id FROM public.job_pages_keep_ready_set() AS k(id)
   JOIN public.jobs j ON j.id=k.id
   JOIN public.job_pages p ON p.job_id=j.id AND p.status='ready'
   JOIN public.job_change_marks m ON m.job_id=j.id
   WHERE m.last_marked_at >= now() - interval '28 days' AND j.job_number NOT LIKE 'ZZTEST%'
   ORDER BY random() LIMIT p_limit
 LOOP
   -- At most p_limit attempts, even if some jobs cannot be sampled. Never keep
   -- an old ready page after a busy, changed, missing or failed refresh.
   /* per-job isolation */ BEGIN
   v_refresh := public.job_page_refresh(v_job);
   IF v_refresh ->> 'outcome' IS DISTINCT FROM 'built' THEN
     v_skipped := v_skipped || jsonb_build_array(v_job);
     CONTINUE;
   END IF;
   SELECT page INTO v_page FROM public.job_pages WHERE job_id=v_job AND status='ready';
   IF NOT FOUND THEN
     v_skipped := v_skipped || jsonb_build_array(v_job);
     CONTINUE;
   END IF;
   v_story := public.job_truth_story_sentences(v_page #> '{story_text,text,sections}');
   -- context_ledger_generations_one_live is unique for this job and status.
   v_notes := public.job_truth_notes_of((SELECT id FROM public.context_ledger_generations
     WHERE job_id=v_job AND status='live'));
   INSERT INTO public.job_truth_weekly_samples(week,job_id,page,story,notes,story_total,notes_total)
   VALUES(v_week,v_job,v_page,v_story,v_notes,jsonb_array_length(v_story),jsonb_array_length(v_notes));
   EXCEPTION WHEN OTHERS OR query_canceled THEN
     -- Roll back only this job's refresh/snapshot. Keep earlier samples and
     -- continue the bounded draw; exception text can contain private content.
     v_skipped := v_skipped || jsonb_build_array(v_job);
     CONTINUE;
   END;
   v_ids := v_ids || jsonb_build_array(v_job);
 END LOOP;
 v_result := jsonb_build_object('outcome','drawn','week',v_week,'jobs',jsonb_array_length(v_ids),'job_ids',v_ids);
 -- Preserve the healthy response exactly. A short draw reports its true count
 -- and the skipped ids; no failed row enters the scoring denominator.
 IF jsonb_array_length(v_skipped)>0 THEN
   v_result := v_result || jsonb_build_object('skipped',jsonb_array_length(v_skipped),'skipped_job_ids',v_skipped);
 END IF;
 RETURN v_result;
END $fn$;
