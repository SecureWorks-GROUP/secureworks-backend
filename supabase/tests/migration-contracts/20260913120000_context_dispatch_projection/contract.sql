-- Dispatch-owned predicate, verbatim from
-- /private/tmp/dispatch-core-20260912/supabase/migrations/20260912150402_dispatch_workbench.sql
-- at 7c0adfaa. Snapshot e32c1d6e was not in this clone. CIO does not own this function.
CREATE OR REPLACE FUNCTION public.dispatch_source_version(p_org uuid,p_job uuid)
RETURNS text LANGUAGE sql STABLE SECURITY INVOKER SET search_path=public,pg_temp AS $$
 SELECT md5(jsonb_build_object(
  'job',jsonb_build_object('scope',j.scope_json,'pricing',j.pricing_json,'accepted',j.accepted_at,'status',j.status,'address',j.site_address,'scheduled',j.scheduled_at),
  'purchase_orders',(SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY p.id),'[]') FROM purchase_orders p WHERE p.job_id=j.id),
  'documents',(SELECT coalesce(jsonb_agg(to_jsonb(d) ORDER BY d.id),'[]') FROM job_documents d WHERE d.job_id=j.id),
  'communications',(SELECT coalesce(jsonb_agg(to_jsonb(c) ORDER BY c.id),'[]') FROM po_communications c WHERE c.job_id=j.id),
  'media',(SELECT coalesce(jsonb_agg(to_jsonb(m) ORDER BY m.id),'[]') FROM job_media m WHERE m.job_id=j.id),
  'assignments',(SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY a.id),'[]') FROM job_assignments a WHERE a.job_id=j.id),
  'context',(SELECT coalesce(jsonb_agg(to_jsonb(c) ORDER BY c.id),'[]') FROM current_job_context_facts c WHERE c.job_id=j.id AND c.provenance#>>'{derivation,owner}' IS DISTINCT FROM 'dispatch')
 )::text) FROM jobs j WHERE j.id=p_job AND j.org_id=p_org;
$$;

BEGIN;
DO $$
DECLARE
 org_a uuid:='00000000-0000-4000-8000-0000000000aa';
 org_b uuid:='00000000-0000-4000-8000-0000000000bb';
 job_a uuid:='aa000000-0000-4000-8000-0000000000aa';
 job_b uuid:='bb000000-0000-4000-8000-0000000000bb';
 fact_id uuid:='cc000000-0000-4000-8000-0000000000cc';
 req uuid:='dd000000-0000-4000-8000-0000000000dd';
 ev_old uuid:='ee000000-0000-4000-8000-000000000001';
 ev_new uuid:='ee000000-0000-4000-8000-0000000000ff';
 ev_unproven uuid:='ee000000-0000-4000-8000-0000000000ee';
 before text; after_own text; after_rev text; other text;
BEGIN
 INSERT INTO public.jobs(id,org_id,status,type,job_number) VALUES
  (job_a,org_a,'accepted','patio','DISP-A'),
  (job_b,org_b,'accepted','patio','DISP-B');
 INSERT INTO public.job_context(id,job_id,kind,value,provenance)
  VALUES(fact_id,job_a,'note','{"text":"deliver Monday"}','{"derivation":{"owner":"supplier"}}');
 before:=public.dispatch_source_version(org_a,job_a);

 -- Unproven emit (no match_status/method) must not appear on the view.
 INSERT INTO public.business_events(id,job_id,event_type,payload,metadata,match_status,match_method)
  VALUES(ev_unproven,job_a::text,'dispatch.plan.changed',
   jsonb_build_object('org_id',org_a,'job_id',job_a,'plan_version',9,'command','save','state','{}'),
   jsonb_build_object('evidence_role','human_working_state','provider_action',false,'derivation',jsonb_build_object('owner','dispatch','event_id',req,'plan_version',9)),
   NULL,NULL);
 IF EXISTS(SELECT 1 FROM public.current_job_context_facts WHERE id=ev_unproven) THEN
  RAISE EXCEPTION 'unproven dispatch event was projected';
 END IF;
 IF public.dispatch_source_version(org_a,job_a) IS DISTINCT FROM before THEN
  RAISE EXCEPTION 'unproven emit changed real dispatch_source_version';
 END IF;

 -- Attributed own event: general query exposes it; source hash ignores owner=dispatch.
 INSERT INTO public.business_events(id,job_id,event_type,source,entity_type,entity_id,payload,metadata,match_status,match_method,attribution_status,event_at,attribution_confidence,correlation_id)
  VALUES(ev_old,job_a,'dispatch.plan.changed','ops-api','dispatch_plan',job_a::text,
   jsonb_build_object('contract_version','dispatch-context/v1','org_id',org_a,'job_id',job_a,'plan_version',1,'command','save','state',jsonb_build_object('requirements',jsonb_build_array(jsonb_build_object('id','r1')),'notes',jsonb_build_array(),'drafts',jsonb_build_array()),'body','Dispatch plan save'),
   jsonb_build_object('source_ref',jsonb_build_object('table','dispatch_plans','org_id',org_a,'job_id',job_a,'version',1),'evidence_role','human_working_state','provider_action',false,'derivation',jsonb_build_object('owner','dispatch','event_id',req,'plan_version',1)),
   'matched','direct_job_id','direct',now(),1,req);
 INSERT INTO public.business_events(id,job_id,event_type,source,entity_type,entity_id,payload,metadata,match_status,match_method,attribution_status,event_at,attribution_confidence,correlation_id)
  VALUES(ev_new,job_a,'dispatch.plan.changed','ops-api','dispatch_plan',job_a::text,
   jsonb_build_object('contract_version','dispatch-context/v1','org_id',org_a,'job_id',job_a,'plan_version',3,'command','save','state',jsonb_build_object('requirements',jsonb_build_array(jsonb_build_object('id','r3')),'notes',jsonb_build_array(jsonb_build_object('text','site note')),'drafts',jsonb_build_array()),'body','Dispatch plan save'),
   jsonb_build_object('source_ref',jsonb_build_object('table','dispatch_plans','org_id',org_a,'job_id',job_a,'version',3),'evidence_role','human_working_state','provider_action',false,'derivation',jsonb_build_object('owner','dispatch','event_id',req,'plan_version',3)),
   'matched','direct_job_id','direct',now(),1,req);
 IF NOT EXISTS(SELECT 1 FROM public.current_job_context_facts WHERE job_id=job_a AND provenance#>>'{derivation,owner}'='dispatch' AND value->>'plan_version'='3') THEN
  RAISE EXCEPTION 'latest attributed dispatch working-state missing from general job query';
 END IF;
 IF EXISTS(SELECT 1 FROM public.current_job_context_facts WHERE job_id=job_a AND provenance#>>'{derivation,owner}'='dispatch' AND value->>'plan_version'='1') THEN
  RAISE EXCEPTION 'stale plan_version remained current';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM public.current_job_context_facts WHERE job_id=job_a AND value->'state'->'notes'@>'[{"text":"site note"}]' AND jsonb_typeof(value->'state')='object') THEN
  RAISE EXCEPTION 'projected value dropped payload.state';
 END IF;
 after_own:=public.dispatch_source_version(org_a,job_a);
 IF after_own IS DISTINCT FROM before THEN
  RAISE EXCEPTION 'own dispatch echo changed real dispatch_source_version';
 END IF;

 -- Same-ID external revision must change the full-row hash.
 UPDATE public.job_context SET value='{"text":"delivery cancelled"}',provenance='{"derivation":{"owner":"supplier"},"rev":2}' WHERE id=fact_id;
 after_rev:=public.dispatch_source_version(org_a,job_a);
 IF after_rev IS NOT DISTINCT FROM after_own THEN
  RAISE EXCEPTION 'same-ID external revision was invisible to real dispatch_source_version';
 END IF;

 -- Tenant: org B must not see org A dispatch projection.
 IF public.context_dispatch_current(org_b,job_a) IS NOT NULL THEN
  RAISE EXCEPTION 'tenant boundary leaked dispatch current state';
 END IF;
 IF EXISTS(SELECT 1 FROM public.current_job_context_facts c JOIN public.jobs j ON j.id=c.job_id WHERE c.job_id=job_a AND j.org_id=org_b) THEN
  RAISE EXCEPTION 'tenant-crossed job facts';
 END IF;
 other:=public.dispatch_source_version(org_b,job_b);
 IF other IS NULL THEN
  RAISE EXCEPTION 'tenant job B should still have a source version';
 END IF;
 IF public.dispatch_source_version(org_b,job_a) IS NOT NULL THEN
  RAISE EXCEPTION 'org B read of job A was not tenant-scoped';
 END IF;

 -- Malformed uuid must be excluded, not throw across all job queries.
 INSERT INTO public.business_events(id,job_id,event_type,source,entity_type,entity_id,payload,metadata,match_status,match_method,attribution_status,event_at,attribution_confidence,correlation_id)
  VALUES('ee000000-0000-4000-8000-0000000000a1',job_a,'dispatch.plan.changed','ops-api','dispatch_plan',job_a::text,
   jsonb_build_object('contract_version','dispatch-context/v1','org_id','not-a-uuid','job_id',job_a,'plan_version',4,'command','save','state','{}','body','x'),
   jsonb_build_object('source_ref',jsonb_build_object('table','dispatch_plans','org_id',org_a,'job_id',job_a,'version',4),'evidence_role','human_working_state','provider_action',false,'derivation',jsonb_build_object('owner','dispatch','event_id',req,'plan_version',4)),
   'matched','direct_job_id','direct',now(),1,req);
 PERFORM 1 FROM public.current_job_context_facts WHERE job_id=job_a;
 IF EXISTS(SELECT 1 FROM public.current_job_context_facts WHERE id='ee000000-0000-4000-8000-0000000000a1') THEN
  RAISE EXCEPTION 'malformed org_id was projected';
 END IF;

 -- Missing request / zero plan_version must not be admitted.
 INSERT INTO public.business_events(id,job_id,event_type,source,entity_type,entity_id,payload,metadata,match_status,match_method,attribution_status,event_at,attribution_confidence,correlation_id)
  VALUES('ee000000-0000-4000-8000-0000000000a2',job_a,'dispatch.plan.changed','ops-api','dispatch_plan',job_a::text,
   jsonb_build_object('contract_version','dispatch-context/v1','org_id',org_a,'job_id',job_a,'plan_version',0,'command','save','state','{}','body','x'),
   jsonb_build_object('source_ref',jsonb_build_object('table','dispatch_plans','org_id',org_a,'job_id',job_a,'version',0),'evidence_role','human_working_state','provider_action',false,'derivation',jsonb_build_object('owner','dispatch','event_id',req,'plan_version',0)),
   'matched','direct_job_id','direct',now(),1,NULL);
 IF EXISTS(SELECT 1 FROM public.current_job_context_facts WHERE id='ee000000-0000-4000-8000-0000000000a2') THEN
  RAISE EXCEPTION 'null request or zero plan_version was projected';
 END IF;

 -- Retracted source must leave the projector.
 INSERT INTO public.business_events(id,job_id,event_type,source,entity_type,entity_id,payload,metadata,match_status,match_method,attribution_status,event_at,attribution_confidence,correlation_id)
  VALUES('ee000000-0000-4000-8000-0000000000a3',job_b,'dispatch.plan.changed','ops-api','dispatch_plan',job_b::text,
   jsonb_build_object('contract_version','dispatch-context/v1','org_id',org_b,'job_id',job_b,'plan_version',1,'command','save','state',jsonb_build_object('notes',jsonb_build_array()),'body','x'),
   jsonb_build_object('source_ref',jsonb_build_object('table','dispatch_plans','org_id',org_b,'job_id',job_b,'version',1),'evidence_role','human_working_state','provider_action',false,'derivation',jsonb_build_object('owner','dispatch','event_id',req,'plan_version',1),'retracted','true'),
   'matched','direct_job_id','direct',now(),1,req);
 IF EXISTS(SELECT 1 FROM public.current_job_context_facts WHERE job_id=job_b AND provenance#>>'{derivation,owner}'='dispatch') THEN
  RAISE EXCEPTION 'retracted dispatch event remained visible';
 END IF;

 -- Wrong producer identity is excluded.
 INSERT INTO public.business_events(id,job_id,event_type,source,entity_type,entity_id,payload,metadata,match_status,match_method,attribution_status,event_at,attribution_confidence,correlation_id)
  VALUES('ee000000-0000-4000-8000-0000000000a4',job_b,'dispatch.plan.changed','ghl','dispatch_plan',job_b::text,
   jsonb_build_object('contract_version','dispatch-context/v1','org_id',org_b,'job_id',job_b,'plan_version',2,'command','save','state','{}','body','x'),
   jsonb_build_object('source_ref',jsonb_build_object('table','dispatch_plans','org_id',org_b,'job_id',job_b,'version',2),'evidence_role','human_working_state','provider_action',false,'derivation',jsonb_build_object('owner','dispatch','event_id',req,'plan_version',2)),
   'matched','direct_job_id','direct',now(),1,req);
 IF EXISTS(SELECT 1 FROM public.current_job_context_facts WHERE id='ee000000-0000-4000-8000-0000000000a4') THEN
  RAISE EXCEPTION 'non-ops-api producer was projected';
 END IF;

 INSERT INTO public.business_events(id,job_id,event_type,source,entity_type,entity_id,payload,metadata,match_status,match_method,attribution_status,event_at,attribution_confidence,correlation_id)
  VALUES('ee000000-0000-4000-8000-0000000000a5',job_a::text,'dispatch.plan.changed','ops-api','dispatch_plan',job_a::text,
   jsonb_build_object('contract_version','dispatch-context/v1','org_id',org_a,'job_id',job_a,'plan_version','999999999999999999999','command','save','state',jsonb_build_object('x',1),'body','x'),
   jsonb_build_object('source_ref',jsonb_build_object('table','dispatch_plans','org_id',org_a,'job_id',job_a,'version','999999999999999999999'),'evidence_role','human_working_state','provider_action',false,'derivation',jsonb_build_object('owner','dispatch','event_id',req,'plan_version','999999999999999999999')),
   'matched','direct_job_id','direct',now(),1,req);
 PERFORM 1 FROM public.current_job_context_facts;
 IF EXISTS(SELECT 1 FROM public.current_job_context_facts WHERE id='ee000000-0000-4000-8000-0000000000a5') THEN
  RAISE EXCEPTION 'overflow plan_version poisoned projection';
 END IF;
 IF pg_typeof((SELECT job_id FROM public.current_job_context_facts WHERE id=ev_new))::text IS DISTINCT FROM 'uuid' THEN
  RAISE EXCEPTION 'projected job_id is not uuid';
 END IF;
END $$;
ROLLBACK;
