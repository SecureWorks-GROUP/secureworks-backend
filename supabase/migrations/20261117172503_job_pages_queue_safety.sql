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
 source text NOT NULL,
 page_pending boolean NOT NULL DEFAULT true
);
CREATE INDEX IF NOT EXISTS job_change_mark_events_job ON public.job_change_mark_events(job_id);
ALTER TABLE public.job_change_mark_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.job_change_mark_events FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.job_change_mark_events TO service_role;

-- Only background readers update these flags. A marker only INSERTs a new heap row.
ALTER TABLE public.job_change_marks_base ADD COLUMN IF NOT EXISTS folded_event_count bigint NOT NULL DEFAULT 0;
ALTER TABLE public.job_change_marks_base ADD COLUMN IF NOT EXISTS page_pending boolean NOT NULL DEFAULT true;
CREATE INDEX IF NOT EXISTS job_change_mark_events_due ON public.job_change_mark_events(marked_at,job_id) WHERE page_pending;
CREATE INDEX IF NOT EXISTS job_change_mark_events_fold ON public.job_change_mark_events(mark_version) WHERE NOT page_pending;
CREATE INDEX IF NOT EXISTS job_change_marks_base_due ON public.job_change_marks_base(first_marked_at,job_id) WHERE page_pending;

CREATE TABLE IF NOT EXISTS public.job_notes_marks_seen (
 job_id uuid PRIMARY KEY REFERENCES public.jobs(id) ON DELETE CASCADE,
 notes_done_at timestamptz NOT NULL
);
ALTER TABLE public.job_notes_marks_seen ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.job_notes_marks_seen FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.job_notes_marks_seen TO service_role;

CREATE OR REPLACE VIEW public.job_change_marks AS
 SELECT j.id AS job_id,
  -- Folded count plus live count detects even a lower sequence committing late.
  greatest(coalesce(b.mark_version,0),coalesce(e.newest_version,0))
   +coalesce(b.folded_event_count,0)+e.n AS mark_version,
  coalesce(e.first_pending,b.first_marked_at,e.first_at) AS first_marked_at,
  greatest(b.last_marked_at,e.last_at) AS last_marked_at,
  ARRAY(SELECT src FROM (
   SELECT u.src,min(u.at) AS first_at FROM (
    SELECT unnest(b.sources) AS src,b.last_marked_at AS at WHERE b.page_pending
    UNION ALL
    SELECT x.source,x.marked_at FROM public.job_change_mark_events x
     WHERE x.job_id=j.id AND x.page_pending
   ) u GROUP BY u.src
  ) sources ORDER BY first_at,src COLLATE "C") AS sources,
  greatest(b.page_done_at,s.page_done_at) AS page_done_at,
  greatest(b.notes_done_at,n.notes_done_at) AS notes_done_at,
  greatest(b.story_done_at,s.story_done_at) AS story_done_at
 FROM public.jobs j
 LEFT JOIN public.job_change_marks_base b ON b.job_id=j.id
 LEFT JOIN public.job_page_marks_seen s ON s.job_id=j.id
 LEFT JOIN public.job_notes_marks_seen n ON n.job_id=j.id
 CROSS JOIN LATERAL (
  SELECT count(*) AS n,max(x.mark_version) AS newest_version,
   min(x.marked_at) AS first_at,max(x.marked_at) AS last_at,
   min(x.marked_at) FILTER(WHERE x.page_pending) AS first_pending
  FROM public.job_change_mark_events x WHERE x.job_id=j.id
 ) e
 WHERE b.job_id IS NOT NULL OR e.n>0;
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

-- The captured event array is a snapshot identity set, not a sequence high-water mark.
CREATE OR REPLACE FUNCTION public.job_page_ack(p_job_id uuid,p_version bigint,p_covers timestamptz,p_events bigint[]) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $ack$
/* acknowledgement block */ BEGIN
 IF p_version IS NULL THEN RETURN; END IF;
 INSERT INTO public.job_page_marks_seen(job_id,mark_version,page_done_at,story_done_at)
 VALUES(p_job_id,p_version,p_covers,p_covers)
 ON CONFLICT(job_id) DO UPDATE SET mark_version=EXCLUDED.mark_version,
  page_done_at=EXCLUDED.page_done_at,story_done_at=EXCLUDED.story_done_at;
 UPDATE public.job_change_mark_events SET page_pending=false
  WHERE job_id=p_job_id AND mark_version=ANY(p_events) AND page_pending;
 UPDATE public.job_change_marks_base SET page_pending=false WHERE job_id=p_job_id AND page_pending;
END $ack$;
REVOKE ALL ON FUNCTION public.job_page_ack(uuid,bigint,timestamptz,bigint[]) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.job_page_ack(uuid,bigint,timestamptz,bigint[]) TO service_role;

CREATE OR REPLACE FUNCTION public.job_page_refresh(p_job_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE
 v_t0 timestamptz; v_covers timestamptz; v_version bigint; v_card jsonb; v_text jsonb; v_page jsonb;
 v_ms integer; v_outcome text := 'built'; v_events bigint[]; v_error text;
 /* build block */ BEGIN
 IF NOT EXISTS (SELECT 1 FROM public.jobs WHERE id = p_job_id) THEN
  RETURN jsonb_build_object('outcome','no_job');
 END IF;
 -- Only page builders use this nonblocking lock. Business writes never acquire it.
 IF NOT pg_try_advisory_xact_lock(20261118, hashtext(p_job_id::text)) THEN
  RETURN '{"outcome":"busy"}'::jsonb;
 END IF;
 v_t0 := clock_timestamp();
 /* build block */ BEGIN
 -- Version and visible event identities share ONE snapshot. A later low-sequence
 -- commit cannot be acknowledged by a timestamp or a max(sequence) cutoff.
 SELECT m.last_marked_at,m.mark_version,
  ARRAY(SELECT e.mark_version FROM public.job_change_mark_events e WHERE e.job_id=p_job_id)
 INTO v_covers,v_version,v_events FROM public.job_change_marks m WHERE m.job_id=p_job_id;
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
 /* build block */ BEGIN
   IF v_text ->> 'status' = 'stale' THEN
    PERFORM public.context_job_story_request(p_job_id,'job-page-refresh','job_changed');
   END IF;
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  PERFORM public.job_page_ack(p_job_id,v_version,v_covers,v_events);
 EXCEPTION WHEN OTHERS OR query_canceled THEN
  v_outcome := 'failed';
  v_error := left(SQLSTATE || ' ' || SQLERRM,200);
  v_ms := (extract(epoch FROM clock_timestamp() - v_t0) * 1000)::integer;
  -- A cancellation during the initial read also yields. This indexed retry runs
  -- after PostgreSQL has delivered the cancellation, before any build is retried.
  IF v_version IS NULL THEN
   SELECT m.last_marked_at,m.mark_version,
    ARRAY(SELECT e.mark_version FROM public.job_change_mark_events e WHERE e.job_id=p_job_id)
   INTO v_covers,v_version,v_events FROM public.job_change_marks m WHERE m.job_id=p_job_id;
  END IF;
  INSERT INTO public.job_pages (job_id,page,built_at,build_ms,status,error)
  VALUES (p_job_id,'{"version":"job-page-v1","failed":true}'::jsonb,v_t0,v_ms,'failed',v_error)
  ON CONFLICT (job_id) DO UPDATE SET status='failed',error=EXCLUDED.error,built_at=EXCLUDED.built_at,build_ms=EXCLUDED.build_ms;

  PERFORM public.job_page_ack(p_job_id,v_version,v_covers,v_events);
 END;
 RETURN jsonb_build_object('outcome',v_outcome,'build_ms',v_ms);
END $fn$;


-- Two ordered partial-index probes. No GROUP BY or sum over the event history.
CREATE OR REPLACE FUNCTION public.job_pages_next_due() RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $due$
 SELECT q.job_id FROM (
  (SELECT e.job_id,e.marked_at AS first_at FROM public.job_change_mark_events e
   WHERE e.page_pending AND EXISTS(SELECT 1 FROM public.jobs j WHERE j.id=e.job_id)
   ORDER BY e.marked_at,e.job_id LIMIT 1)
  UNION ALL
  (SELECT b.job_id,b.first_marked_at FROM public.job_change_marks_base b
   WHERE b.page_pending ORDER BY b.first_marked_at,b.job_id LIMIT 1)
 ) q ORDER BY q.first_at,q.job_id LIMIT 1
$due$;
REVOKE ALL ON FUNCTION public.job_pages_next_due() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.job_pages_next_due() TO service_role;

CREATE OR REPLACE FUNCTION public.job_pages_refresh_due(p_limit integer DEFAULT 5) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $fn$
DECLARE v_id uuid; v_result jsonb; v_left bigint;
/* queue block */ BEGIN
 IF NOT pg_try_advisory_xact_lock(20261118,1) THEN RETURN '{"outcome":"busy"}'::jsonb; END IF;
 /* pick block */ BEGIN
  IF coalesce(p_limit,1)>0 THEN v_id:=public.job_pages_next_due(); END IF;
 EXCEPTION WHEN query_canceled THEN
  RETURN jsonb_build_object('outcome','timed_out','refreshed',0,'failed',0,'left',NULL);
 END;
 IF v_id IS NOT NULL THEN v_result:=public.job_page_refresh(v_id); END IF;
 -- A trailing count timeout must never roll back the page or its acknowledgement.
 /* count block */ BEGIN
  SELECT count(*) INTO v_left FROM (
   SELECT e.job_id FROM public.job_change_mark_events e WHERE e.page_pending
    AND EXISTS(SELECT 1 FROM public.jobs j WHERE j.id=e.job_id)
   UNION
   SELECT b.job_id FROM public.job_change_marks_base b WHERE b.page_pending
  ) due;
 EXCEPTION WHEN query_canceled THEN v_left:=NULL;
 END;
 RETURN jsonb_build_object('outcome','ran','refreshed',CASE WHEN v_result->>'outcome'='built' THEN 1 ELSE 0 END,
  'failed',CASE WHEN v_result->>'outcome'='failed' THEN 1 ELSE 0 END,'left',v_left);
END $fn$;

-- Bounded compaction, called only by nightly. Page builders and the fold share a
-- nonblocking advisory lock; marker INSERTs acquire neither it nor any shared row.
CREATE OR REPLACE FUNCTION public.job_change_marks_fold(p_limit integer DEFAULT 10000) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $fold$
DECLARE v_ids bigint[]; v_job uuid; v_count integer:=0; v_n integer;
/* fold block */ BEGIN
 SELECT array_agg(mark_version) INTO v_ids FROM (
  SELECT e.mark_version FROM public.job_change_mark_events e WHERE NOT e.page_pending
  ORDER BY e.mark_version LIMIT greatest(0,least(coalesce(p_limit,10000),10000))
 ) bounded;
 FOR v_job IN SELECT DISTINCT e.job_id FROM public.job_change_mark_events e
  WHERE NOT e.page_pending AND e.mark_version=ANY(v_ids) ORDER BY e.job_id
 LOOP
  IF NOT pg_try_advisory_xact_lock(20261118,hashtext(v_job::text)) THEN CONTINUE; END IF;
  WITH removed AS (
   DELETE FROM public.job_change_mark_events e WHERE e.job_id=v_job
    AND NOT e.page_pending AND e.mark_version=ANY(v_ids)
   RETURNING e.*
  ), totals AS (
   SELECT count(*) AS n,max(mark_version) AS newest,min(marked_at) AS first_at,max(marked_at) AS last_at
   FROM removed
  )
  INSERT INTO public.job_change_marks_base AS b
   (job_id,mark_version,folded_event_count,first_marked_at,last_marked_at,sources,page_pending,page_done_at,story_done_at)
  SELECT v_job,t.newest,t.n,t.first_at,t.last_at,'{}',false,s.page_done_at,s.story_done_at
  FROM totals t LEFT JOIN public.job_page_marks_seen s ON s.job_id=v_job
  WHERE t.n>0 AND EXISTS(SELECT 1 FROM public.jobs WHERE id=v_job)
  ON CONFLICT(job_id) DO UPDATE SET mark_version=greatest(b.mark_version,EXCLUDED.mark_version),
   folded_event_count=b.folded_event_count+EXCLUDED.folded_event_count,
   last_marked_at=greatest(b.last_marked_at,EXCLUDED.last_marked_at),
   page_done_at=greatest(b.page_done_at,EXCLUDED.page_done_at),
   story_done_at=greatest(b.story_done_at,EXCLUDED.story_done_at);
  GET DIAGNOSTICS v_n=ROW_COUNT;
  v_count:=v_count+v_n;
 END LOOP;
 RETURN v_count;
END $fold$;
REVOKE ALL ON FUNCTION public.job_change_marks_fold(integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.job_change_marks_fold(integer) TO service_role;

CREATE OR REPLACE FUNCTION public.job_pages_nightly(p_limit integer DEFAULT 200) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $fn$
DECLARE v_id uuid; v_marked integer:=0; v_deleted integer; v_folded integer;
/* nightly block */ BEGIN
 v_folded:=public.job_change_marks_fold(10000);
 FOR v_id IN SELECT k.id FROM public.job_pages_keep_ready_set() AS k(id)
  LEFT JOIN public.job_pages p ON p.job_id=k.id
  WHERE p.job_id IS NULL OR p.page_version<public.job_page_version() OR p.status='failed'
  ORDER BY k.id LIMIT greatest(0,least(coalesce(p_limit,200),200))
 LOOP
  PERFORM public.job_mark_changed(v_id,'status'); v_marked:=v_marked+1;
 END LOOP;
 DELETE FROM public.job_pages WHERE job_id NOT IN (SELECT public.job_pages_keep_ready_set())
  AND built_at<now()-interval '7 days';
 GET DIAGNOSTICS v_deleted=ROW_COUNT;
 RETURN jsonb_build_object('marked',v_marked,'deleted',v_deleted,'folded_jobs',v_folded);
END $fn$;

-- Invalid text job ids are not markable. Catch each cast independently so a move
-- from a valid job to malformed data still marks the valid old job.
CREATE OR REPLACE FUNCTION public.job_mark_changed_trg() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $fn$
DECLARE v_source text:=TG_ARGV[0]; v_col text:=coalesce(TG_ARGV[1],'job_id');
 v_new jsonb; v_old jsonb; v_new_id uuid; v_old_id uuid;
 c_skip constant text[]:=ARRAY['updated_at','created_at','synced_at','last_synced_at','raw_json'];
/* trigger block */ BEGIN
 IF TG_OP<>'DELETE' THEN
  v_new:=to_jsonb(NEW);
  /* cast block */ BEGIN v_new_id:=nullif(v_new->>v_col,'')::uuid;
  EXCEPTION WHEN invalid_text_representation THEN v_new_id:=NULL; END;
 END IF;
 IF TG_OP<>'INSERT' THEN
  v_old:=to_jsonb(OLD);
  /* cast block */ BEGIN v_old_id:=nullif(v_old->>v_col,'')::uuid;
  EXCEPTION WHEN invalid_text_representation THEN v_old_id:=NULL; END;
 END IF;
 IF TG_OP='UPDATE' AND (v_new-c_skip) IS NOT DISTINCT FROM (v_old-c_skip) THEN RETURN NULL; END IF;
 IF TG_TABLE_NAME='xero_invoices' AND TG_OP='UPDATE'
  AND ((v_new->>'status') IS DISTINCT FROM (v_old->>'status')
   OR (v_new->>'amount_paid') IS DISTINCT FROM (v_old->>'amount_paid')) THEN v_source:='payment'; END IF;
 PERFORM public.job_mark_changed(v_new_id,v_source);
 IF v_old_id IS DISTINCT FROM v_new_id THEN PERFORM public.job_mark_changed(v_old_id,v_source); END IF;
 RETURN NULL;
END $fn$;
