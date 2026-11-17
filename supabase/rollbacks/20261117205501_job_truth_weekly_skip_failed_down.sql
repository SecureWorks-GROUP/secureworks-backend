-- FU15 rollback: restore the previous draw without touching kept samples.
SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.job_truth_weekly_draw(p_week date DEFAULT NULL,p_limit integer DEFAULT 20)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE
 v_week date := coalesce(p_week,date_trunc('week',now() AT TIME ZONE 'Australia/Perth')::date);
 v_job uuid; v_page jsonb; v_story jsonb; v_notes jsonb; v_ids jsonb := '[]'::jsonb; BEGIN
 IF p_limit IS NULL OR p_limit NOT BETWEEN 5 AND 20 THEN RAISE EXCEPTION 'weekly_draw_bad_limit'; END IF;
 -- Serialise only draws for this week. No business writer uses this lock.
 PERFORM pg_advisory_xact_lock(173701,v_week - DATE '2000-01-01');
 IF EXISTS (SELECT 1 FROM public.job_truth_weekly_samples WHERE week=v_week) THEN
   RETURN jsonb_build_object('outcome','already_drawn','week',v_week);
 END IF;
 -- Keep-ready ids join jobs_pkey, job_pages_pkey and job_change_marks_pkey.
 -- Random order scans the eligible set once, only on the explicit weekly draw.
 FOR v_job IN
   SELECT j.id FROM public.job_pages_keep_ready_set() AS k(id)
   JOIN public.jobs j ON j.id=k.id
   JOIN public.job_pages p ON p.job_id=j.id AND p.status='ready'
   JOIN public.job_change_marks m ON m.job_id=j.id
   WHERE m.last_marked_at >= now() - interval '28 days' AND j.job_number NOT LIKE 'ZZTEST%'
   ORDER BY random() LIMIT p_limit
 LOOP
   PERFORM public.job_page_refresh(v_job);
   SELECT page INTO v_page FROM public.job_pages WHERE job_id=v_job AND status='ready';
   IF NOT FOUND THEN RAISE EXCEPTION 'weekly_draw_page_unavailable'; END IF;
   v_story := public.job_truth_story_sentences(v_page #> '{story_text,text,sections}');
   -- context_ledger_generations_one_live is unique for this job and status.
   v_notes := public.job_truth_notes_of((SELECT id FROM public.context_ledger_generations
     WHERE job_id=v_job AND status='live'));
   INSERT INTO public.job_truth_weekly_samples(week,job_id,page,story,notes,story_total,notes_total)
   VALUES(v_week,v_job,v_page,v_story,v_notes,jsonb_array_length(v_story),jsonb_array_length(v_notes));
   v_ids := v_ids || jsonb_build_array(v_job);
 END LOOP;
 RETURN jsonb_build_object('outcome','drawn','week',v_week,'jobs',jsonb_array_length(v_ids),'job_ids',v_ids);
END $fn$;
