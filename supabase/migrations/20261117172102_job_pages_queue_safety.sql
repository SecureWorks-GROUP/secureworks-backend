-- P0-01.1 follow-up: failed builds yield the queue; business marks never upsert.
-- Definitions/storage only. No trigger or schedule is installed here.
SET LOCAL lock_timeout = '5s';

-- Preserve pre-install marks and their version coordinates. A view keeps the public
-- read shape while all new marks go to an append-only heap, with no unique key or
-- foreign key: neither another marker nor a writer of jobs can hold a row it needs.
DO $move$ BEGIN
 IF to_regclass('public.job_change_marks_base') IS NULL THEN
  ALTER TABLE public.job_change_marks RENAME TO job_change_marks_base;
 END IF;
END $move$;

CREATE TABLE IF NOT EXISTS public.job_change_mark_events (
 job_id uuid NOT NULL,
 mark_version bigint NOT NULL DEFAULT nextval('public.job_change_mark_version'),
 marked_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 source text NOT NULL
);
CREATE INDEX IF NOT EXISTS job_change_mark_events_job ON public.job_change_mark_events(job_id);
ALTER TABLE public.job_change_mark_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.job_change_mark_events FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON public.job_change_mark_events TO service_role;

CREATE TABLE IF NOT EXISTS public.job_notes_marks_seen (
 job_id uuid PRIMARY KEY REFERENCES public.jobs(id) ON DELETE CASCADE,
 notes_done_at timestamptz NOT NULL
);
ALTER TABLE public.job_notes_marks_seen ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.job_notes_marks_seen FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.job_notes_marks_seen TO service_role;

CREATE OR REPLACE VIEW public.job_change_marks AS
 WITH event_totals AS (
  SELECT e.job_id,count(*) AS n,max(e.mark_version) AS newest_version,
   min(e.marked_at) AS first_at,max(e.marked_at) AS last_at
  FROM public.job_change_mark_events e GROUP BY e.job_id
 ), combined AS (
  SELECT coalesce(b.job_id,e.job_id) AS job_id,
   -- Max alone loses a mark when a lower sequence commits after a higher one.
   -- Adding the visible event count makes that late commit change the token too.
   -- The legacy token stays unchanged when there are no append-only events.
   greatest(coalesce(b.mark_version,0),coalesce(e.newest_version,0))+coalesce(e.n,0) AS mark_version,
   least(b.first_marked_at,e.first_at) AS first_at,
   greatest(b.last_marked_at,e.last_at) AS last_marked_at,
   b.sources,b.last_marked_at AS base_last,
   greatest(b.page_done_at,s.page_done_at) AS page_done_at,
   greatest(b.notes_done_at,n.notes_done_at) AS notes_done_at,
   greatest(b.story_done_at,s.story_done_at) AS story_done_at
  FROM public.job_change_marks_base b FULL JOIN event_totals e USING(job_id)
  LEFT JOIN public.job_page_marks_seen s ON s.job_id=coalesce(b.job_id,e.job_id)
  LEFT JOIN public.job_notes_marks_seen n ON n.job_id=coalesce(b.job_id,e.job_id)
 )
 SELECT c.job_id,c.mark_version,
  coalesce((SELECT min(e.marked_at) FROM public.job_change_mark_events e
   WHERE e.job_id=c.job_id AND e.marked_at>c.page_done_at),c.first_at) AS first_marked_at,
  c.last_marked_at,
  ARRAY(SELECT src FROM (
   SELECT u.src,min(u.at) AS first_at FROM (
    SELECT unnest(c.sources) AS src,c.base_last AS at
     WHERE c.page_done_at IS NULL OR c.base_last>c.page_done_at
    UNION ALL
    SELECT e.source,e.marked_at FROM public.job_change_mark_events e
     WHERE e.job_id=c.job_id AND (c.page_done_at IS NULL OR e.marked_at>c.page_done_at)
   ) u GROUP BY u.src
  ) sources ORDER BY first_at,src COLLATE "C") AS sources,
  c.page_done_at,c.notes_done_at,c.story_done_at
 FROM combined c JOIN public.jobs j ON j.id=c.job_id;
REVOKE ALL ON public.job_change_marks FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.job_change_marks TO service_role;
COMMENT ON VIEW public.job_change_marks IS
 'One row per job that changed. Collapsed append-only marks; page consumers acknowledge the observed version separately.';

CREATE OR REPLACE FUNCTION public.job_mark_changed(p_job_id uuid,p_source text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $fn$ BEGIN
 -- Plain MVCC existence read, deliberately not a foreign-key check or row lock.
 INSERT INTO public.job_change_mark_events(job_id,source)
 SELECT p_job_id,coalesce(nullif(btrim(p_source),''),'unknown')
 WHERE p_job_id IS NOT NULL AND EXISTS(SELECT 1 FROM public.jobs WHERE id=p_job_id);
END $fn$;
REVOKE ALL ON FUNCTION public.job_mark_changed(uuid,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.job_mark_changed(uuid,text) TO service_role;

CREATE OR REPLACE FUNCTION public.job_marks_notes_seen(p_until timestamptz) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $fn$
DECLARE v_count integer;
/* function block */ BEGIN
 INSERT INTO public.job_notes_marks_seen(job_id,notes_done_at)
 SELECT job_id,last_marked_at FROM public.job_change_marks
 WHERE last_marked_at<=p_until AND (notes_done_at IS NULL OR last_marked_at>notes_done_at)
 ON CONFLICT(job_id) DO UPDATE SET notes_done_at=greatest(job_notes_marks_seen.notes_done_at,EXCLUDED.notes_done_at);
 GET DIAGNOSTICS v_count=ROW_COUNT;
 RETURN v_count;
END $fn$;
REVOKE ALL ON FUNCTION public.job_marks_notes_seen(timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.job_marks_notes_seen(timestamptz) TO service_role;

CREATE OR REPLACE FUNCTION public.job_page_refresh(p_job_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE
 v_t0 timestamptz; v_covers timestamptz; v_version bigint; v_card jsonb; v_text jsonb; v_page jsonb;
 v_ms integer; v_outcome text := 'built';
 /* build block */ BEGIN
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
 /* build block */ BEGIN
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
 /* build block */ BEGIN
   IF v_text ->> 'status' = 'stale' THEN
    PERFORM public.context_job_story_request(p_job_id,'job-page-refresh','job_changed');
   END IF;
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
 EXCEPTION WHEN OTHERS OR query_canceled THEN
  v_outcome := 'failed';
  v_ms := (extract(epoch FROM clock_timestamp() - v_t0) * 1000)::integer;
  INSERT INTO public.job_pages (job_id,page,built_at,build_ms,status,error)
  VALUES (p_job_id,'{"version":"job-page-v1","failed":true}'::jsonb,v_t0,v_ms,'failed',left(SQLSTATE || ' ' || SQLERRM,200))
  ON CONFLICT (job_id) DO UPDATE SET status='failed',error=EXCLUDED.error,built_at=EXCLUDED.built_at,build_ms=EXCLUDED.build_ms;
 END;
 -- Failure clears only the version captured before the build, even after timeout.
 -- No re-read of the newer version here: concurrent changes must stay due.
 IF v_outcome='failed' AND v_version IS NOT NULL THEN
  INSERT INTO public.job_page_marks_seen(job_id,mark_version,page_done_at,story_done_at)
  VALUES(p_job_id,v_version,v_covers,v_covers)
  ON CONFLICT(job_id) DO UPDATE SET mark_version=EXCLUDED.mark_version,
   page_done_at=EXCLUDED.page_done_at,story_done_at=EXCLUDED.story_done_at;
 END IF;
 RETURN jsonb_build_object('outcome',v_outcome,'build_ms',v_ms);
END $fn$;

