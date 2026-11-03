-- After the down migration: the five bodies are the live ones of 3 Nov 2026 again and the helper is gone.
DO $$
DECLARE problems text[]:='{}'; x record;
BEGIN
 FOR x IN SELECT * FROM (VALUES
  ('public.resolve_context_attribution(public.business_events,boolean,boolean)','2ccef791fca954bfe1fcbb4e0de5f8a2'),
  ('public.context_redecide_one(uuid,text,jsonb)','3c79bd64e707a5f5a4bd92a5d67a0aca'),
  ('public.context_redecide_resting(text,timestamptz,uuid)','6dccf6320f1fffa4a4c385e23ba9de88'),
  ('public.context_reconsider_eligible(public.business_events,uuid)','375857877700389aa8f6f730095b8800'),
  ('public.context_reconsider_contact(text,timestamptz,text,uuid)','75aea904fb88a526ee6aed68b4d592b9')
 ) AS t(sig,want) LOOP
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure(x.sig)) IS DISTINCT FROM x.want THEN problems:=problems||x.sig; END IF;
  IF coalesce(obj_description(to_regprocedure(x.sig),'pg_proc'),'') LIKE '%C2 known contacts (20261104095000)%' THEN problems:=problems||(x.sig||' comment'); END IF;
 END LOOP;
 IF to_regprocedure('public.context_empty_row_job(public.business_events)') IS NOT NULL THEN problems:=problems||'context_empty_row_job still exists'::text; END IF;
 IF cardinality(problems)>0 THEN RAISE EXCEPTION 'c2k rollback: %',array_to_string(problems,'; '); END IF;
END $$;
-- The restored ladder decides an empty call as before: empty, on no job.
BEGIN;
UPDATE public.feature_flags SET enabled=true WHERE flag_name='context_unlinked_rules_v1';
INSERT INTO public.jobs(id,org_id,job_number,status,type,ghl_contact_id,created_at,metadata)
VALUES('7c2a0000-0000-4000-8000-000000000001','00000000-0000-0000-0000-000000000001','SWF-998899','scheduled','fencing','c2k-rb-contact','2026-09-01Z','{}');
DO $$
DECLARE e public.business_events;
BEGIN
 INSERT INTO public.business_events(event_type,source,channel,direction,occurred_at,event_at,contact_id,payload)
 VALUES('client.call_complete','ghl-webhook-receiver','call','inbound','2026-09-20Z','2026-09-20Z','c2k-rb-contact','{}') RETURNING * INTO e;
 IF e.job_id IS NOT NULL OR e.attribution_status<>'empty' THEN RAISE EXCEPTION 'c2k rollback: an empty call must stay on no job, got % %',e.attribution_status,e.job_id; END IF;
END $$;
ROLLBACK;
