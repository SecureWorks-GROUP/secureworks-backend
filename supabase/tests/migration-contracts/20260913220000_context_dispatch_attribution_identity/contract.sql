BEGIN;
DO $$
DECLARE
  org_a uuid:='00000000-0000-4000-8000-0000000000aa';
  org_b uuid:='00000000-0000-4000-8000-0000000000bb';
  job_a uuid:='aa000000-0000-4000-8000-0000000000aa';
  ev uuid:='ee000000-0000-4000-8000-0000000000d1';
  ev_bad uuid:='ee000000-0000-4000-8000-0000000000d2';
  rec public.business_events;
BEGIN
  INSERT INTO public.jobs(id,org_id,status,type,job_number)
   VALUES(job_a,org_a,'accepted','patio','JOINT-DISPATCH-ATTR')
   ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.business_events(
    id,job_id,event_type,source,entity_type,entity_id,payload,metadata,
    match_status,match_method,event_at,correlation_id
  ) VALUES(
    ev, job_a::text, 'dispatch.plan.changed','ops-api','dispatch_plan',job_a::text,
    jsonb_build_object('contract_version','dispatch-context/v1','org_id',org_a,'job_id',job_a,'plan_version',1,'command','note_upsert','state',jsonb_build_object('notes',jsonb_build_array(jsonb_build_object('text','Producer-shaped')))),
    jsonb_build_object('evidence_role','human_working_state','provider_action',false,'derivation',jsonb_build_object('owner','dispatch','event_id',ev,'plan_version',1)),
    'matched','direct_job_id', now(), ev
  );
  SELECT * INTO rec FROM public.business_events WHERE id=ev;
  IF rec.match_method IS DISTINCT FROM 'direct_job_id' OR rec.match_status IS DISTINCT FROM 'matched' THEN
    RAISE EXCEPTION 'dispatch identity rewritten: method=% status=%', rec.match_method, rec.match_status;
  END IF;
  IF rec.event_at IS NULL THEN RAISE EXCEPTION 'event_at dropped'; END IF;
  IF rec.job_id::text IS DISTINCT FROM job_a::text THEN RAISE EXCEPTION 'job_id dropped'; END IF;

  INSERT INTO public.business_events(
    id,job_id,event_type,source,entity_type,entity_id,payload,metadata,
    match_status,match_method,event_at,correlation_id
  ) VALUES(
    ev_bad, job_a::text, 'dispatch.plan.changed','ops-api','dispatch_plan',job_a::text,
    jsonb_build_object('contract_version','dispatch-context/v1','org_id',org_b,'job_id',job_a,'plan_version',1,'command','note_upsert','state',jsonb_build_object('notes',jsonb_build_array())),
    jsonb_build_object('evidence_role','human_working_state','provider_action',false),
    'matched','direct_job_id', now(), ev_bad
  );
  SELECT * INTO rec FROM public.business_events WHERE id=ev_bad;
  IF rec.match_method IS DISTINCT FROM 'none' OR rec.job_id IS NOT NULL THEN
    RAISE EXCEPTION 'foreign org dispatch identity was kept';
  END IF;
END $$;
ROLLBACK;
