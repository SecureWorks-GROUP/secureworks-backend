-- After the down migration (which checks the two restored md5 values itself):
-- the copies function is gone, grants are service role only, and a row marked
-- as a copy is admissible again (the pre-W9 rule never read duplicate_of).
DO $$
DECLARE f regprocedure;
BEGIN
 IF to_regprocedure('public.context_ghl_message_copies(jsonb)') IS NOT NULL THEN RAISE EXCEPTION 'capture copies rollback left context_ghl_message_copies'; END IF;
 FOREACH f IN ARRAY ARRAY['public.context_event_source_admissible(public.business_events)','public.capture_ghl_history_event(jsonb)',
  'public.context_job_record_messages(uuid[],timestamptz)','public.context_job_story_meta(uuid,timestamptz)']::regprocedure[] LOOP
  IF has_function_privilege('anon',f,'EXECUTE') OR has_function_privilege('authenticated',f,'EXECUTE') OR NOT has_function_privilege('service_role',f,'EXECUTE')
  THEN RAISE EXCEPTION 'capture copies rollback grants on %',f; END IF;
 END LOOP;
END $$;

BEGIN;
DO $$
DECLARE j uuid:=gen_random_uuid(); e uuid; r public.business_events; n integer;
BEGIN
 INSERT INTO public.jobs(id,org_id,status,type,job_number,metadata,created_at)
  VALUES(j,'00000000-0000-0000-0000-000000000001','scheduled','fencing','CC-RB','{}',now()-interval '30 days');
 INSERT INTO public.business_events(job_id,match_method,direction,channel,event_type,source,payload,occurred_at,event_at)
  VALUES(j,'direct_job_id','inbound','sms','client.sms_in','copies_contract','{"body":"Rollback copy"}',now()-interval '1 hour',now()-interval '1 hour')
  RETURNING id INTO e;
 UPDATE public.business_events SET metadata=coalesce(metadata,'{}'::jsonb)||jsonb_build_object('duplicate_of',gen_random_uuid()) WHERE id=e;
 SELECT * INTO r FROM public.business_events WHERE id=e;
 IF NOT public.context_event_source_admissible(r) THEN RAISE EXCEPTION 'capture copies rollback: a marked row must be admissible again under the old rule'; END IF;
 SELECT count(*) INTO n FROM public.context_job_record_messages(ARRAY[j]) m WHERE m.source_id=e::text;
 IF n<>1 THEN RAISE EXCEPTION 'capture copies rollback: the restored record must show a marked row again, got %',n; END IF;
 IF (public.context_job_story_meta(j)->'lanes'->>'texts')::integer<>1 THEN
  RAISE EXCEPTION 'capture copies rollback: the restored story lanes must count a marked row again'; END IF;
END $$;
ROLLBACK;
