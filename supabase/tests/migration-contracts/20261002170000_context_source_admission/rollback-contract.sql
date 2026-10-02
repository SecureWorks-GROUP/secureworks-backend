-- After the down migration: both readers are their pre-image bodies again (the
-- down migration checks the md5 itself), the rule is gone, and the batch
-- again returns a row whose payload names another job.
DO $$
DECLARE j uuid:=gen_random_uuid(); k uuid:=gen_random_uuid(); e uuid;
BEGIN
 IF to_regprocedure('public.context_event_source_admissible(public.business_events)') IS NOT NULL
 THEN RAISE EXCEPTION 'source admission rollback left the rule'; END IF;
 IF has_function_privilege('anon','public.context_unread_rows(uuid[])','EXECUTE')
  OR NOT has_function_privilege('service_role','public.context_catchup_eligible_rows(uuid[])','EXECUTE')
 THEN RAISE EXCEPTION 'source admission rollback grants'; END IF;
 INSERT INTO public.jobs(id,org_id,status,type,job_number) VALUES(j,'00000000-0000-0000-0000-000000000001','scheduled','fencing','SA-RB-'||j),
  (k,'00000000-0000-0000-0000-000000000001','scheduled','fencing','SA-RB-'||k);
 INSERT INTO public.business_events(job_id,match_method,direction,event_type,payload,occurred_at,event_at)
  VALUES(j,'direct_job_id','inbound','client.sms_in',jsonb_build_object('body','Other job','job_id',k::text),now(),now()) RETURNING id INTO e;
 IF NOT EXISTS(SELECT 1 FROM public.context_extraction_events(j,25) b WHERE b.id=e) THEN RAISE EXCEPTION 'source admission rollback batch is not the pre-image read'; END IF;
 DELETE FROM public.business_events WHERE id=e;
 DELETE FROM public.jobs WHERE id IN (j,k);
END $$;
