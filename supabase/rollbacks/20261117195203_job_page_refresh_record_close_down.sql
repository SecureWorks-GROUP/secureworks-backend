SELECT public.context_ledger_record_close_remove();
DROP FUNCTION public.context_ledger_record_close_install();
DROP FUNCTION public.context_ledger_record_close_remove();
DROP FUNCTION public.context_ledger_record_close_withdraw_trg();
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
