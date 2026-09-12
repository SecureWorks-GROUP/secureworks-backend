BEGIN;
DO $$
DECLARE
 org_a uuid:='00000000-0000-4000-8000-0000000000aa';
 job_a uuid:='aa000000-0000-4000-8000-0000000000aa';
 req uuid:='dd000000-0000-4000-8000-0000000000dd';
 ev uuid:='ee000000-0000-4000-8000-0000000000ff';
 poison uuid:='ee000000-0000-4000-8000-0000000000aa';
 n int;
BEGIN
 INSERT INTO public.jobs(id,org_id,status,type,job_number) VALUES (job_a,org_a,'accepted','patio','SAFE-A');
 -- Canonical column is TEXT; store uuid as text.
 INSERT INTO public.business_events(id,job_id,event_type,source,entity_type,entity_id,payload,metadata,match_status,match_method,attribution_status,event_at,attribution_confidence,correlation_id)
  VALUES(ev,job_a::text,'dispatch.plan.changed','ops-api','dispatch_plan',job_a::text,
   jsonb_build_object('contract_version','dispatch-context/v1','org_id',org_a,'job_id',job_a,'plan_version',2,'command','save','state',jsonb_build_object('notes',jsonb_build_array(jsonb_build_object('text','ok'))),'body','x'),
   jsonb_build_object('source_ref',jsonb_build_object('table','dispatch_plans','org_id',org_a,'job_id',job_a,'version',2),'evidence_role','human_working_state','provider_action',false,'derivation',jsonb_build_object('owner','dispatch','event_id',req,'plan_version',2)),
   'matched','direct_job_id','direct',now(),1,req);

 INSERT INTO public.business_events(id,job_id,event_type,source,entity_type,entity_id,payload,metadata,match_status,match_method,attribution_status,event_at,attribution_confidence,correlation_id)
  VALUES(poison,job_a::text,'dispatch.plan.changed','ops-api','dispatch_plan',job_a::text,
   jsonb_build_object('contract_version','dispatch-context/v1','org_id',org_a,'job_id',job_a,'plan_version','999999999999999999999','command','save','state',jsonb_build_object('notes','[]'::jsonb),'body','x'),
   jsonb_build_object('source_ref',jsonb_build_object('table','dispatch_plans','org_id',org_a,'job_id',job_a,'version','999999999999999999999'),'evidence_role','human_working_state','provider_action',false,'derivation',jsonb_build_object('owner','dispatch','event_id',req,'plan_version','999999999999999999999')),
   'matched','direct_job_id','direct',now(),1,req);

 -- One malicious version must not poison reads of the job or the whole view.
 SELECT count(*) INTO n FROM public.current_job_context_facts WHERE job_id=job_a;
 IF n IS NULL THEN RAISE EXCEPTION 'job facts read failed'; END IF;
 IF EXISTS(SELECT 1 FROM public.current_job_context_facts WHERE id=poison) THEN
  RAISE EXCEPTION 'overflow plan_version was projected';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM public.current_job_context_facts WHERE id=ev AND job_id=job_a AND jsonb_typeof(value->'state')='object') THEN
  RAISE EXCEPTION 'canonical uuid join lost the valid TEXT job_id event';
 END IF;
 IF pg_typeof((SELECT job_id FROM public.current_job_context_facts WHERE id=ev))::text IS DISTINCT FROM 'uuid' THEN
  RAISE EXCEPTION 'projected job_id is not uuid';
 END IF;
END $$;
ROLLBACK;
