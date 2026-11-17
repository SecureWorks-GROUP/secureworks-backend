DROP FUNCTION IF EXISTS public.job_page_ack(uuid,bigint,timestamptz,bigint[]);
DROP FUNCTION IF EXISTS public.job_pages_next_due();
DROP FUNCTION IF EXISTS public.job_change_marks_fold(integer);
-- Undo the safety follow-up without throwing away pending append-only marks.
SET LOCAL lock_timeout='5s';
DO $undo$ BEGIN
 IF to_regclass('public.job_change_marks_base') IS NOT NULL THEN
  CREATE TEMP TABLE job_marks_rollback AS SELECT * FROM public.job_change_marks;
  DROP VIEW public.job_change_marks;
  ALTER TABLE public.job_change_marks_base RENAME TO job_change_marks;
  ALTER TABLE public.job_change_marks DROP COLUMN folded_event_count, DROP COLUMN page_pending;
  INSERT INTO public.job_change_marks AS m
   SELECT * FROM job_marks_rollback
   ON CONFLICT(job_id) DO UPDATE SET mark_version=EXCLUDED.mark_version,
    first_marked_at=EXCLUDED.first_marked_at,last_marked_at=EXCLUDED.last_marked_at,
    sources=EXCLUDED.sources,page_done_at=EXCLUDED.page_done_at,
    notes_done_at=EXCLUDED.notes_done_at,story_done_at=EXCLUDED.story_done_at;
  -- Collapsed tokens may exceed the last sequence value. Keep future legacy tokens ahead.
  PERFORM setval('public.job_change_mark_version',greatest(
   (SELECT last_value FROM public.job_change_mark_version),
   coalesce((SELECT max(mark_version) FROM public.job_change_marks),1)));
  DROP TABLE job_marks_rollback;
  DROP TABLE public.job_change_mark_events,public.job_notes_marks_seen;
 END IF;
END $undo$;
CREATE OR REPLACE FUNCTION public.job_mark_changed(p_job_id uuid, p_source text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE v_src text := coalesce(nullif(btrim(p_source), ''), 'unknown');
BEGIN
 IF p_job_id IS NULL THEN RETURN; END IF;
 INSERT INTO public.job_change_marks AS m (job_id, sources) VALUES (p_job_id, ARRAY[v_src])
 ON CONFLICT (job_id) DO UPDATE SET
  first_marked_at = CASE WHEN (m.page_done_at IS NOT NULL AND m.page_done_at >= m.last_marked_at)
                         OR EXISTS (SELECT 1 FROM public.job_page_marks_seen s
                                    WHERE s.job_id=m.job_id AND s.mark_version=m.mark_version)
                         THEN clock_timestamp() ELSE m.first_marked_at END,
  sources = CASE WHEN (m.page_done_at IS NOT NULL AND m.page_done_at >= m.last_marked_at)
                         OR EXISTS (SELECT 1 FROM public.job_page_marks_seen s
                                    WHERE s.job_id=m.job_id AND s.mark_version=m.mark_version) THEN ARRAY[v_src]
                 WHEN v_src = ANY(m.sources) THEN m.sources ELSE m.sources || v_src END,
  last_marked_at = clock_timestamp(),
  mark_version = nextval('public.job_change_mark_version');
EXCEPTION WHEN foreign_key_violation THEN RETURN;
END $fn$;

REVOKE ALL ON FUNCTION public.job_mark_changed(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.job_mark_changed(uuid, text) TO service_role;

-- The notes reader has read every mark up to p_until: set its done column to each such row's last_marked_at.
-- Returns how many rows it moved.
CREATE OR REPLACE FUNCTION public.job_marks_notes_seen(p_until timestamptz) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE v_count integer;
BEGIN
 UPDATE public.job_change_marks SET notes_done_at = last_marked_at
  WHERE last_marked_at <= p_until AND (notes_done_at IS NULL OR last_marked_at > notes_done_at);
 GET DIAGNOSTICS v_count = ROW_COUNT;
 RETURN v_count;
END $fn$;

REVOKE ALL ON FUNCTION public.job_marks_notes_seen(timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.job_marks_notes_seen(timestamptz) TO service_role;
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

CREATE OR REPLACE FUNCTION public.job_pages_nightly(p_limit integer DEFAULT 200) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $fn$
DECLARE v_id uuid; v_marked integer := 0; v_deleted integer;
BEGIN
 FOR v_id IN SELECT k.id FROM public.job_pages_keep_ready_set() AS k(id)
  LEFT JOIN public.job_pages p ON p.job_id=k.id
  WHERE p.job_id IS NULL OR p.page_version < public.job_page_version() OR p.status='failed'
  ORDER BY k.id LIMIT greatest(0,least(coalesce(p_limit,200),200))
 LOOP
  PERFORM public.job_mark_changed(v_id,'status');
  v_marked := v_marked + 1;
 END LOOP;
 DELETE FROM public.job_pages WHERE job_id NOT IN (SELECT public.job_pages_keep_ready_set())
  AND built_at < now() - interval '7 days';
 GET DIAGNOSTICS v_deleted = ROW_COUNT;
 RETURN jsonb_build_object('marked',v_marked,'deleted',v_deleted);
END $fn$;

CREATE OR REPLACE FUNCTION public.job_mark_changed_trg() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE
 v_source text := TG_ARGV[0];
 v_col text := coalesce(TG_ARGV[1], 'job_id');
 v_new jsonb; v_old jsonb; v_new_id uuid; v_old_id uuid;
 c_skip constant text[] := ARRAY['updated_at','created_at','synced_at','last_synced_at','raw_json'];
BEGIN
 IF TG_OP <> 'DELETE' THEN v_new := to_jsonb(NEW); v_new_id := nullif(v_new ->> v_col, '')::uuid; END IF;
 IF TG_OP <> 'INSERT' THEN v_old := to_jsonb(OLD); v_old_id := nullif(v_old ->> v_col, '')::uuid; END IF;
 IF TG_OP = 'UPDATE' AND (v_new - c_skip) IS NOT DISTINCT FROM (v_old - c_skip) THEN RETURN NULL; END IF;
 IF TG_TABLE_NAME = 'xero_invoices' AND TG_OP = 'UPDATE'
    AND ((v_new ->> 'status') IS DISTINCT FROM (v_old ->> 'status')
      OR (v_new ->> 'amount_paid') IS DISTINCT FROM (v_old ->> 'amount_paid')) THEN
  v_source := 'payment';
 END IF;
 PERFORM public.job_mark_changed(v_new_id, v_source);
 IF v_old_id IS DISTINCT FROM v_new_id THEN PERFORM public.job_mark_changed(v_old_id, v_source); END IF;
 RETURN NULL;
END $fn$;
