-- Earlier registered context fixtures supply jobs, business_events, the B1 run
-- ledger (reserve_context_model_call), B2 attribution, the booking-draft
-- candidate list (context_contact_jobs) and F1 (unplaced, candidate_job_ids,
-- context_unplaced_for_job). No extra columns.
--
-- Prove the fixtures leave production's pre-image, as read from production on
-- 23 Sep 2026, so the contract runs against production's starting point.
DO $$
BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('public.reserve_context_model_call(text,uuid,uuid)')) IS DISTINCT FROM '569a31f3e75c7e5e5e75e85cc628adde'
 THEN RAISE EXCEPTION 'a1 setup: reserve_context_model_call is not the production pre-image'; END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('public.context_contact_jobs(text)')) IS DISTINCT FROM '110233fcc96446fdcf1f50d1fa65c43c'
 THEN RAISE EXCEPTION 'a1 setup: context_contact_jobs is not the production pre-image'; END IF;
END $$;

-- Production's attribute_context_event_with_luna(uuid,uuid,numeric) was
-- hand-applied by ledger row 20260914012038 (b2_context_attribution_fns): the
-- repository body minus one comment line, no behaviour difference. Install the
-- live text byte for byte so the guard and the contract meet production's
-- pre-image (md5(prosrc) 48eabf7e132092cd225ff5060ce58846).
CREATE OR REPLACE FUNCTION public.attribute_context_event_with_luna(p_event_id uuid,p_job_id uuid,p_confidence numeric)
RETURNS public.business_events LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $live$
DECLARE e public.business_events; chosen uuid;
BEGIN
 IF NOT public.automation_lane_enabled('attribution') THEN RAISE EXCEPTION 'attribution disabled'; END IF;
 SELECT * INTO e FROM public.business_events WHERE id=p_event_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'event not found'; END IF;
 IF e.attribution_status IS DISTINCT FROM 'pending_luna' THEN RAISE EXCEPTION 'event is not pending Luna'; END IF;
 IF p_job_id IS NOT NULL THEN
  IF p_confidence IS NULL OR p_confidence<0 OR p_confidence>1 OR p_confidence='NaN'::numeric THEN RAISE EXCEPTION 'invalid confidence'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.context_contact_jobs(e.contact_id) WHERE id=p_job_id) THEN RAISE EXCEPTION 'job is not a contact candidate'; END IF;
  chosen:=p_job_id;
  IF nullif(e.thread_key,'') IS NOT NULL THEN
   INSERT INTO public.event_threads(thread_key,job_id,bound_by,source_event_id) VALUES(e.thread_key,p_job_id,'luna',e.id) ON CONFLICT DO NOTHING;
   SELECT job_id INTO chosen FROM public.event_threads WHERE thread_key=e.thread_key;
   IF chosen<>p_job_id THEN p_confidence:=1; END IF;
  END IF;
 END IF;
 UPDATE public.business_events SET job_id=chosen,
 attribution_status=CASE WHEN chosen IS NULL THEN 'admin_bucket' WHEN chosen<>p_job_id THEN 'thread' ELSE 'luna' END,
 attribution_step=CASE WHEN chosen IS NULL THEN 6 WHEN chosen<>p_job_id THEN 2 ELSE 5 END,
 attribution_confidence=CASE WHEN chosen IS NOT NULL THEN p_confidence END,
 attributed_at=CASE WHEN chosen IS NOT NULL THEN clock_timestamp() END,
 attribution_checked_at=clock_timestamp(),match_status=CASE WHEN chosen IS NULL THEN 'unresolved' ELSE 'matched' END,
 match_method=CASE WHEN chosen IS NULL THEN 'none' ELSE 'contact_id' END,
 match_confidence=CASE WHEN chosen IS NOT NULL THEN p_confidence END
 WHERE id=e.id RETURNING * INTO e;
 RETURN e;
END $live$;
DO $$
BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('public.attribute_context_event_with_luna(uuid,uuid,numeric)')) IS DISTINCT FROM '48eabf7e132092cd225ff5060ce58846'
 THEN RAISE EXCEPTION 'a1 setup: attribute_context_event_with_luna is not the production pre-image'; END IF;
END $$;
