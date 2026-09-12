\set ON_ERROR_STOP on
set role service_role;
do $$
declare
  org uuid='00000000-0000-4000-8000-000000000071';
  job uuid='10000000-0000-4071-8000-000000000001';
  request uuid='20000000-0000-4071-8000-000000000001';
  event_id uuid;
  event_payload jsonb;
  source text;
  canonical_source text;
  malformed_source text;
  mixed_source text;
  canonical_fact jsonb;
  canonical_event jsonb;
  probe jsonb;
begin
  insert into jobs(id,org_id,status,accepted_at,scope_json,pricing_json) values(job,org,'accepted',now(),'{}','{}');
  source=dispatch_source_version(org,job);
  perform dispatch_commit(org,job,0,request,'strict-lineage','fixture','note_upsert',source,'{"allocations":[],"notes":[{"id":"30000000-0000-4071-8000-000000000001","text":"Strict lineage"}]}');
  select id,payload into event_id,event_payload from business_events where correlation_id=request;
  if event_id is null then raise exception 'canonical dispatch event missing'; end if;
  canonical_source=dispatch_source_version(org,job);
  insert into job_context(id,job_id,kind,value,provenance,correlation_id) values(
    event_id,job,'note',
    jsonb_build_object('text','Dispatch working review state. Not a claim that an order was sent, purchased, delivered or paid.','command',event_payload->>'command','plan_version',event_payload->'plan_version','source_version',event_payload->>'source_version','state',event_payload->'state','source_refs',jsonb_build_array(jsonb_build_object('table','business_events','id',event_id::text))),
    jsonb_build_object('extractor','dispatch_working_state_v1','writer_role','dispatch_working_state_projector','untrusted',false,'lifecycle','active','source_event_ids',jsonb_build_array(event_id::text),'evidence_role','human_working_state','provider_action',false,'validity_basis','ongoing','derivation',jsonb_build_object('owner','dispatch','own_only',true,'event_id',request,'request_id',request,'org_id',org,'job_id',job,'plan_version',event_payload->'plan_version','source_event_ids',jsonb_build_array(event_id::text),'rule_version','dispatch_working_state_v1'),'safety',jsonb_build_object('memory_trusted',true,'action_safe',false,'state_change_safe',false,'outbound_safe',false)),
    request
  );
  if not exists(select 1 from current_job_context_facts where id=event_id and job_id=job) then raise exception 'general context lost own working state'; end if;
  if exists(select 1 from dispatch_context_facts_for_source(org,job,100) where id=event_id) then raise exception 'strict own-only fact remained in dispatch source reader'; end if;
  if dispatch_source_version(org,job)<>canonical_source then raise exception 'strict own-only fact invalidated dispatch source'; end if;
  select to_jsonb(c) into canonical_fact from current_job_context_facts c where id=event_id;
  select to_jsonb(b) into canonical_event from business_events b where id=event_id;
  foreach probe in array array[
    jsonb_set(canonical_fact,'{provenance,derivation,org_id}','"00000000-0000-4000-8000-000000000072"'),
    jsonb_set(canonical_fact,'{provenance,derivation,job_id}','"10000000-0000-4071-8000-000000000099"'),
    jsonb_set(canonical_fact,'{provenance,derivation,request_id}','"20000000-0000-4071-8000-000000000099"'),
    jsonb_set(canonical_fact,'{provenance,derivation,plan_version}','2'::jsonb),
    jsonb_set(canonical_fact,'{value,source_version}','"wrong-source"'),
    jsonb_set(canonical_fact,'{value,state,notes,0,text}','"mutated state"'),
    jsonb_set(canonical_fact,'{provenance,source_event_ids}',jsonb_build_array(event_id::text,gen_random_uuid()::text)),
    jsonb_set(canonical_fact,'{provenance,derivation,source_event_ids}',jsonb_build_array(event_id::text,gen_random_uuid()::text)),
    jsonb_set(canonical_fact,'{source_event_ids}',jsonb_build_array(event_id::text,gen_random_uuid()::text),true)
  ] loop
    if dispatch_is_own_plan_source(null,null,probe) then raise exception 'mutated fact accepted as own-only'; end if;
  end loop;
  foreach probe in array array[
    jsonb_set(canonical_event,'{payload,org_id}','"00000000-0000-4000-8000-000000000072"'),
    jsonb_set(canonical_event,'{payload,job_id}','"10000000-0000-4071-8000-000000000099"'),
    jsonb_set(canonical_event,'{correlation_id}','"20000000-0000-4071-8000-000000000099"'),
    jsonb_set(canonical_event,'{payload,plan_version}','2'::jsonb),
    jsonb_set(canonical_event,'{payload,source_version}','"wrong-source"'),
    jsonb_set(canonical_event,'{payload,state,notes,0,text}','"mutated state"')
  ] loop
    if dispatch_is_own_plan_source(event_id,probe,null) then raise exception 'mutated event accepted as own-only'; end if;
  end loop;
  insert into job_context(id,job_id,kind,value,provenance,correlation_id) values(
    gen_random_uuid(),job,'note','{"text":"Malformed dispatch-tagged upstream fact","source_refs":[{"table":"business_events","id":"not-a-uuid"}]}',
    '{"derivation":{"owner":"dispatch","own_only":true,"source_event_ids":["not-a-uuid"]},"source_event_ids":["not-a-uuid"],"evidence_role":"human_working_state","provider_action":false}',
    request
  );
  perform count(*) from dispatch_context_facts_for_source(org,job,100);
  malformed_source=dispatch_source_version(org,job);
  if malformed_source=canonical_source then raise exception 'malformed dispatch-tagged fact was hidden'; end if;
  insert into job_context(id,job_id,kind,value,provenance,correlation_id) values(
    gen_random_uuid(),job,'note',
    jsonb_build_object('text','Mixed dispatch and upstream fact','source_refs',jsonb_build_array(jsonb_build_object('table','business_events','id',event_id::text))),
    jsonb_build_object('source_event_ids',jsonb_build_array(event_id::text),'evidence_role','human_working_state','provider_action',false,'derivation',jsonb_build_object('owner','dispatch','own_only',false,'event_id',request,'request_id',request,'org_id',org,'job_id',job,'plan_version',1,'source_event_ids',jsonb_build_array(event_id::text))),
    request
  );
  mixed_source=dispatch_source_version(org,job);
  if mixed_source=malformed_source then raise exception 'mixed dispatch-tagged fact was hidden'; end if;
end $$;

do $$
declare
  org uuid='00000000-0000-4000-8000-000000000001';
  external_job uuid='10000000-0000-4071-8000-000000000002';
  malformed_job uuid='10000000-0000-4071-8000-000000000003';
  external_event uuid='20000000-0000-4071-8000-000000000002';
  malformed_event uuid='20000000-0000-4071-8000-000000000003';
  result jsonb;
begin
  insert into jobs(id,org_id,status,accepted_at,scope_json,pricing_json) values(external_job,org,'accepted',now(),'{}','{}'),(malformed_job,org,'accepted',now(),'{}','{}');
  insert into business_events(id,event_type,source,entity_type,entity_id,correlation_id,job_id,match_status,match_method,payload,metadata)
    values(external_event,'po.reply.received','ops-api','job',external_job::text,external_event,external_job::text,'matched','direct_job_id',jsonb_build_object('job_id',external_job),jsonb_build_object('derivation',jsonb_build_object('owner','dispatch')));
  result=dispatch_enqueue_from_business_event(external_event);
  if result->>'queued'<>'true' then raise exception 'owner tag alone suppressed external enqueue'; end if;
  insert into business_events(id,event_type,source,entity_type,entity_id,correlation_id,job_id,match_status,match_method,payload,metadata)
    values(malformed_event,'dispatch.plan.changed','ops-api','dispatch_plan',malformed_job::text,malformed_event,malformed_job::text,'matched','direct_job_id',jsonb_build_object('job_id',malformed_job),jsonb_build_object('derivation',jsonb_build_object('owner','dispatch')));
  result=dispatch_enqueue_from_business_event(malformed_event);
  if result->>'reason'='dispatch_echo' then raise exception 'malformed dispatch event accepted as echo'; end if;
end $$;
reset role;
