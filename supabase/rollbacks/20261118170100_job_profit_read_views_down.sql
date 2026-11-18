SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';
DROP VIEW IF EXISTS public.v_job_profit_read, public.v_job_cost_events_read, public.v_job_revenue_events_read;
DROP FUNCTION IF EXISTS public.job_profit_read_rows(), public.job_cost_events_read_rows(), public.job_revenue_events_read_rows();
DROP FUNCTION IF EXISTS public.job_profit_read_as_at(uuid), public.job_profit_read_on();
DO $guard$
/* function block */ BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.job_profit_line_evidence(uuid)'::regprocedure)
    NOT IN ('e07cf775a74cda10cca2e40d4bafc540','07898420ba1e0119b410b4e1447bd3fa') THEN RAISE EXCEPTION 'job_profit_read_single_evidence_preimage'; END IF;
END $guard$;
CREATE OR REPLACE FUNCTION public.job_profit_line_evidence(p_job_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
SELECT m.result FROM public.job_profit_line_evidence_many(ARRAY[p_job_id]) m;
$fn$;
DROP FUNCTION IF EXISTS public.job_profit_read_stored_evidence(uuid[]);
DO $page_guard$
/* function block */ BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.job_page_get(uuid)'::regprocedure) NOT IN ('4fad727218d2eda48113c658512f86b9','e63a7bd0a521e83c5f57f3d51da85129')
  THEN RAISE EXCEPTION 'job_profit_read_page_get_preimage'; END IF;
END $page_guard$;
CREATE OR REPLACE FUNCTION public.job_page_get(p_job_id uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE p public.job_pages;
BEGIN
 SELECT * INTO p FROM public.job_pages WHERE job_id=p_job_id;
 IF NOT FOUND THEN
  PERFORM public.job_page_refresh(p_job_id);
  UPDATE public.job_pages SET kept_ready=false WHERE job_id=p_job_id;
  SELECT * INTO p FROM public.job_pages WHERE job_id=p_job_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
 END IF;
 RETURN p.page || jsonb_build_object('as_at',p.built_at,'status',p.status,'kept_ready',p.kept_ready,
  'page_version',p.page_version,'stale',EXISTS (SELECT 1 FROM public.job_change_marks m
   WHERE m.job_id=p_job_id AND m.mark_version IS DISTINCT FROM p.covers_mark_version));
END $fn$;
DROP FUNCTION IF EXISTS public.job_profit_page_refresh(uuid), public.job_profit_page_card_for_text(uuid,jsonb);
