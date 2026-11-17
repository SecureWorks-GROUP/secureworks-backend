-- P0-01.1: a stored page with the mark read before its build.
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS public.job_pages (
 job_id uuid PRIMARY KEY REFERENCES public.jobs(id) ON DELETE CASCADE,
 page jsonb NOT NULL,
 card_hash text,
 built_at timestamptz NOT NULL,
 covers_marked_at timestamptz,
 covers_mark_version bigint,
 build_ms integer NOT NULL,
 page_version integer NOT NULL DEFAULT 1,
 kept_ready boolean NOT NULL DEFAULT true,
 status text NOT NULL DEFAULT 'ready' CHECK (status IN ('ready','failed')),
 error text
);
ALTER TABLE public.job_pages ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.job_pages FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.job_pages TO service_role;

CREATE OR REPLACE FUNCTION public.job_page_version() RETURNS integer
LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
 SELECT 1
$fn$;

CREATE OR REPLACE FUNCTION public.job_page_refresh(p_job_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE
 v_t0 timestamptz; v_covers timestamptz; v_version bigint; v_card jsonb; v_text jsonb; v_page jsonb;
 v_ms integer; v_outcome text := 'built';
BEGIN
 IF NOT EXISTS (SELECT 1 FROM public.jobs WHERE id = p_job_id) THEN
  RETURN jsonb_build_object('outcome','no_job');
 END IF;
 -- Only page builders use this nonblocking lock. Business writes never acquire it.
 IF NOT pg_try_advisory_xact_lock(20261118, hashtext(p_job_id::text)) THEN
  RETURN '{"outcome":"busy"}'::jsonb;
 END IF;
 v_t0 := clock_timestamp();
 -- MVCC read, no row lock. Nothing below writes job_change_marks.
 SELECT last_marked_at,mark_version INTO v_covers,v_version
 FROM public.job_change_marks WHERE job_id = p_job_id;
 BEGIN
  v_card := public.context_job_story(p_job_id);
  v_text := public.context_job_story_text_get(p_job_id, v_card, true);
  v_page := jsonb_build_object('version','job-page-v1','as_at',v_t0,'card',v_card,'story_text',v_text,
   'notes',NULL,'invoices',NULL,'bills',NULL,'matching',NULL,'profit',NULL,
   'summary',jsonb_build_object('phase',v_card #>> '{now,phase}', 'now_line',left(v_card #>> '{now,line}',200),
    'whose_move',v_card #> '{now,whose_move}',
    'open_items',CASE WHEN jsonb_typeof(v_card -> 'loops') = 'array' THEN jsonb_array_length(v_card -> 'loops') ELSE 0 END,
    'loops',CASE WHEN jsonb_typeof(v_card -> 'loops') = 'array' THEN v_card -> 'loops' ELSE '[]'::jsonb END));
  v_ms := (extract(epoch FROM clock_timestamp() - v_t0) * 1000)::integer;
  -- Compare-and-save the observed version. An in-flight or later business commit leaves a
  -- newer version due, even if it lands immediately after this comparison. No mark-row CAS
  -- UPDATE: that would still lock business writes until the caller's transaction commits.
  INSERT INTO public.job_pages (job_id,page,card_hash,built_at,covers_marked_at,covers_mark_version,build_ms,page_version,status,error)
  SELECT p_job_id,v_page,v_text ->> 'card_hash',v_t0,v_covers,v_version,v_ms,public.job_page_version(),'ready',NULL
  WHERE (SELECT mark_version FROM public.job_change_marks WHERE job_id=p_job_id) IS NOT DISTINCT FROM v_version
  ON CONFLICT (job_id) DO UPDATE SET page=EXCLUDED.page,card_hash=EXCLUDED.card_hash,
   built_at=EXCLUDED.built_at,covers_marked_at=EXCLUDED.covers_marked_at,
   covers_mark_version=EXCLUDED.covers_mark_version,build_ms=EXCLUDED.build_ms,
   page_version=EXCLUDED.page_version,status=EXCLUDED.status,error=NULL;
  IF NOT FOUND THEN RETURN jsonb_build_object('outcome','changed','build_ms',v_ms); END IF;
  IF v_version IS NOT NULL THEN
   INSERT INTO public.job_page_marks_seen (job_id,mark_version,page_done_at,story_done_at)
   SELECT p_job_id,v_version,v_covers,v_covers
   WHERE (SELECT mark_version FROM public.job_change_marks WHERE job_id=p_job_id)=v_version
   ON CONFLICT (job_id) DO UPDATE SET mark_version=EXCLUDED.mark_version,
    page_done_at=EXCLUDED.page_done_at,story_done_at=EXCLUDED.story_done_at;
  END IF;
  BEGIN
   IF v_text ->> 'status' = 'stale' THEN
    PERFORM public.context_job_story_request(p_job_id,'job-page-refresh','job_changed');
   END IF;
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
 EXCEPTION WHEN OTHERS THEN
  v_outcome := 'failed';
  v_ms := (extract(epoch FROM clock_timestamp() - v_t0) * 1000)::integer;
  INSERT INTO public.job_pages (job_id,page,built_at,build_ms,status,error)
  VALUES (p_job_id,'{"version":"job-page-v1","failed":true}'::jsonb,v_t0,v_ms,'failed',left(SQLSTATE || ' ' || SQLERRM,200))
  ON CONFLICT (job_id) DO UPDATE SET status='failed',error=EXCLUDED.error,built_at=EXCLUDED.built_at,build_ms=EXCLUDED.build_ms;
 END;
 -- A failed build acknowledges nothing; the observed version remains due.
 RETURN jsonb_build_object('outcome',v_outcome,'build_ms',v_ms);
END $fn$;

CREATE OR REPLACE FUNCTION public.job_pages_refresh_due(p_limit integer DEFAULT 5) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE v_start timestamptz := clock_timestamp(); v_id uuid; v_result jsonb; v_left bigint;
BEGIN
 IF NOT pg_try_advisory_xact_lock(20261118,1) THEN RETURN '{"outcome":"busy"}'::jsonb; END IF;
 -- One job per call and therefore per scheduled transaction, even for a legacy limit of 5.
 -- Never start another build with a nearly spent 45-second cron statement budget.
 SELECT m.job_id INTO v_id FROM public.job_change_marks m
 LEFT JOIN public.job_page_marks_seen s ON s.job_id=m.job_id
 WHERE s.mark_version IS DISTINCT FROM m.mark_version
 ORDER BY m.first_marked_at,m.job_id LIMIT CASE WHEN coalesce(p_limit,1)>0 THEN 1 ELSE 0 END;
 IF v_id IS NOT NULL AND clock_timestamp()-v_start < interval '5 seconds' THEN
  v_result := public.job_page_refresh(v_id);
 END IF;
 SELECT count(*) INTO v_left FROM public.job_change_marks m
 LEFT JOIN public.job_page_marks_seen s ON s.job_id=m.job_id
 WHERE s.mark_version IS DISTINCT FROM m.mark_version;
 RETURN jsonb_build_object('outcome','ran','refreshed',CASE WHEN v_result->>'outcome'='built' THEN 1 ELSE 0 END,
  'failed',CASE WHEN v_result->>'outcome'='failed' THEN 1 ELSE 0 END,'left',v_left);
END $fn$;

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

REVOKE ALL ON FUNCTION public.job_page_version() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.job_page_version() TO service_role;
REVOKE ALL ON FUNCTION public.job_page_refresh(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.job_page_refresh(uuid) TO service_role;
REVOKE ALL ON FUNCTION public.job_pages_refresh_due(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.job_pages_refresh_due(integer) TO service_role;
REVOKE ALL ON FUNCTION public.job_page_get(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.job_page_get(uuid) TO service_role;
