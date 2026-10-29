-- Down for 20261029200000_context_job_picture.sql.
--
-- The bill placer's candidate list goes back to 20261028173000's body byte for
-- byte (its own liveness rule and its eight keys, without the picture's
-- fields), and the job picture is dropped. Nothing else changed, so nothing
-- else moves. The jarvis bill prompt prints only the eight keys, so it reads
-- the same either way. Refuses when a later migration has since replaced the
-- candidate body: roll that one back first.

DO $guard$
DECLARE live text;
BEGIN
  SELECT md5(p.prosrc) INTO live FROM pg_proc p WHERE p.oid = to_regprocedure('public.materials_ai_candidate_jobs(date,date)');
  IF live IS NULL OR live NOT IN ('f7b28babf31d9fb0e937e82e35745cf2', '191fff3225a1ac8c03f6e631cea025d2') THEN
    RAISE EXCEPTION 'context_job_picture_down_preimage_mismatch: public.materials_ai_candidate_jobs(date,date) md5 %; roll the later migration back first',
      coalesce(live, '<missing>');
  END IF;
END $guard$;

CREATE OR REPLACE FUNCTION public.materials_ai_candidate_jobs(p_from date, p_to date)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT COALESCE(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
           'job_id', j.id,
           'job_number', j.job_number,
           'type', j.type,
           'status', j.status,
           'client', left(j.client_name, 120),
           'site', left(concat_ws(', ', NULLIF(btrim(j.site_address), ''), NULLIF(btrim(j.site_suburb), '')), 200),
           'created', j.created_at::date,
           'scheduled', (SELECT min(a.scheduled_date) FROM public.job_assignments a
                          WHERE a.job_id = j.id AND COALESCE(a.status, '') <> 'cancelled'))) ORDER BY j.job_number), '[]'::jsonb)
    FROM public.jobs j
   WHERE j.job_number IS NOT NULL
     AND lower(COALESCE(j.status, '')) NOT IN ('cancelled', 'lost')
     AND lower(COALESCE(j.metadata ->> 'do_not_schedule', '')) <> 'true'
     -- Made before the bill (plus a week: a bill can arrive dated before the card)
     AND j.created_at < (COALESCE(p_to, current_date) + 7)
     -- and alive around it: made in the half year before it, or booked on site
     -- from two months before to four months after it, or still open today.
     -- updated_at is not used: any later touch moves it, so every finished job
     -- would read as alive and the list would hold the whole company.
     AND (j.created_at >= (COALESCE(p_from, current_date) - 180)
          OR EXISTS (SELECT 1 FROM public.job_assignments a
                      WHERE a.job_id = j.id AND COALESCE(a.status, '') <> 'cancelled'
                        AND a.scheduled_date BETWEEN (COALESCE(p_from, current_date) - 60) AND (COALESCE(p_to, current_date) + 120))
          OR lower(COALESCE(j.status, '')) NOT IN ('archived', 'complete', 'completed', 'invoiced', 'final_payment', 'get_review', 'draft'))
$$;
REVOKE ALL ON FUNCTION public.materials_ai_candidate_jobs(date, date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.materials_ai_candidate_jobs(date, date) TO service_role;
COMMENT ON FUNCTION public.materials_ai_candidate_jobs(date, date) IS NULL;

DROP FUNCTION IF EXISTS public.context_job_picture(uuid[], text[], text[]);
