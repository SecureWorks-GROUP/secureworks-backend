-- P4-02.3: switch-off parity; trigger installation remains director-run.
CREATE OR REPLACE FUNCTION public.job_page_refresh(p_job_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE
 v_t0 timestamptz; v_covers timestamptz; v_version bigint; v_card jsonb; v_text jsonb; v_page jsonb;
 v_ms integer; v_outcome text := 'built'; v_events bigint[]; v_error text; v_close jsonb; v_item jsonb; v_close_on boolean := false;
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
 -- Off retains the existing page/response exactly. No candidate read or queue write.
 /* switch block */ BEGIN
  v_close_on := coalesce((SELECT enabled FROM public.feature_flags WHERE flag_name='context_record_close_v1'),false);
 EXCEPTION WHEN OTHERS THEN v_close_on := false; END;
 IF v_close_on THEN
  /* record block */ BEGIN
   v_close := public.context_ledger_close_on_records(p_job_id);
  EXCEPTION WHEN OTHERS THEN v_close := jsonb_build_object('error',left(SQLERRM,200)); END;
  IF v_close->>'wrote'='true' THEN
   FOR v_item IN SELECT value FROM jsonb_array_elements(coalesce(v_close->'ambiguous_items','[]')) LOOP
    /* reconcile block */ BEGIN
     PERFORM public.context_reconcile_raise('open_item_check',p_job_id,v_item->>'item_id',
      'An open note may already be settled: more than one record fits. Pick the record or leave it open.',v_item->'candidates');
    EXCEPTION WHEN OTHERS THEN NULL; END;
   END LOOP;
  END IF;
 END IF;
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
 RETURN jsonb_build_object('outcome',v_outcome,'build_ms',v_ms)
  || CASE WHEN v_close_on THEN jsonb_build_object('record_close',v_close-'ambiguous_items') ELSE '{}'::jsonb END;
END $fn$;

CREATE OR REPLACE FUNCTION public.context_ledger_record_close_withdraw_trg() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $fn$
/* withdraw block */ BEGIN
 /* isolated block */ BEGIN
  IF coalesce((SELECT enabled FROM public.feature_flags WHERE flag_name='context_record_close_v1'),false) THEN
   PERFORM public.context_reconcile_withdraw('open_item_check',NEW.id::text,'note_no_longer_open');
  END IF;
 EXCEPTION WHEN OTHERS THEN NULL; END;
 RETURN NULL;
END $fn$;
CREATE OR REPLACE FUNCTION public.context_ledger_record_close_install() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $fn$
/* install block */ BEGIN
 DROP TRIGGER IF EXISTS context_ledger_record_close_withdraw ON public.context_ledger_items;
 CREATE TRIGGER context_ledger_record_close_withdraw AFTER UPDATE OF status ON public.context_ledger_items
 FOR EACH ROW WHEN (OLD.status='open' AND NEW.status<>'open')
 EXECUTE FUNCTION public.context_ledger_record_close_withdraw_trg();
END $fn$;
CREATE OR REPLACE FUNCTION public.context_ledger_record_close_remove() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $fn$
/* remove block */ BEGIN
 DROP TRIGGER IF EXISTS context_ledger_record_close_withdraw ON public.context_ledger_items;
END $fn$;
REVOKE ALL ON FUNCTION public.context_ledger_record_close_withdraw_trg(),public.context_ledger_record_close_install(),public.context_ledger_record_close_remove() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.context_ledger_record_close_withdraw_trg(),public.context_ledger_record_close_install(),public.context_ledger_record_close_remove() TO service_role;
