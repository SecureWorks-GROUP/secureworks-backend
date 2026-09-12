\set ON_ERROR_STOP on
set role service_role;
do $$
declare org uuid='00000000-0000-4000-8000-000000000001'; foreign_org uuid='00000000-0000-4000-8000-000000000002'; job uuid='10000000-0000-4000-8000-000000000050'; wrong_job uuid='10000000-0000-4000-8000-000000000051'; source text; lineage_source text; event_row business_events; fact_id uuid=gen_random_uuid(); wrong_fact_id uuid=gen_random_uuid(); luna jsonb; persisted_provenance jsonb;
begin
  if to_regprocedure('public.persist_luna_context_revision(text,text,jsonb,text,jsonb)') is null then raise exception 'luna writer contract missing'; end if;
  insert into jobs(id,org_id,status,accepted_at,scope_json,pricing_json) values(job,org,'accepted',now(),'{}','{}'),(wrong_job,foreign_org,'accepted',now(),'{}','{}');
  source=dispatch_source_version(org,job);
  perform dispatch_commit(org,job,0,'20000000-0000-4000-8000-000000000020','lineage-hash','fixture','note_upsert',source,'{"allocations":[],"notes":[{"id":"30000000-0000-4000-8000-000000000020","text":"Lineage fixture"}]}');
  select * into event_row from business_events where correlation_id='20000000-0000-4000-8000-000000000020';
  if event_row.match_status<>'matched' or event_row.match_method<>'direct_job_id' then raise exception 'dispatch event lacks direct attribution'; end if;
  if event_row.metadata->>'evidence_role'<>'human_working_state' or event_row.metadata->'provider_action'<>'false'::jsonb or event_row.metadata#>>'{derivation,owner}'<>'dispatch' then raise exception 'dispatch event provenance changed'; end if;
  if exists(select 1 from dispatch_tasks where org_id=org and job_id=job) then raise exception 'dispatch event echoed into queue'; end if;
  lineage_source=dispatch_source_version(org,job);
  execute 'select public.persist_luna_context_revision($1,$2,$3,$4,$5)'
    into luna using 'business_events',event_row.id::text,to_jsonb(event_row),'job_context',
    jsonb_build_object('id',fact_id,'job_id',job,'kind','dispatch_lineage_fixture','value',jsonb_build_object('source_refs',jsonb_build_array(jsonb_build_object('table','business_events','id',event_row.id::text))),'correlation_id',event_row.correlation_id,'provenance',jsonb_build_object('extractor','context-luna-subscription:v1','source_event_ids',jsonb_build_array(event_row.id::text),'writer_role','classifier','untrusted',false,'derivation',event_row.metadata->'derivation','safety',jsonb_build_object('memory_trusted',true,'action_safe',false,'state_change_safe',false,'outbound_safe',false)));
  if luna->>'outcome' not in ('inserted','idempotent') then raise exception 'luna writer rejected dispatch event'; end if;
  select provenance into persisted_provenance from job_context where id=fact_id;
  if persisted_provenance#>>'{derivation,owner}'<>'dispatch' then raise exception 'luna fact lost dispatch derivation'; end if;
  if dispatch_source_version(org,job)<>lineage_source then raise exception 'dispatch-derived Luna fact invalidated source'; end if;
  begin
    execute 'select public.persist_luna_context_revision($1,$2,$3,$4,$5)'
      using 'business_events',event_row.id::text,to_jsonb(event_row),'job_context',
      jsonb_build_object('id',wrong_fact_id,'job_id',wrong_job,'kind','dispatch_lineage_fixture','value',jsonb_build_object('source_refs',jsonb_build_array(jsonb_build_object('table','business_events','id',event_row.id::text))),'correlation_id',event_row.correlation_id,'provenance',jsonb_build_object('extractor','context-luna-subscription:v1','source_event_ids',jsonb_build_array(event_row.id::text),'writer_role','classifier','untrusted',false,'derivation',event_row.metadata->'derivation','safety',jsonb_build_object('memory_trusted',true,'action_safe',false,'state_change_safe',false,'outbound_safe',false)));
    raise exception 'luna writer accepted wrong job fact';
  exception when raise_exception then
    if sqlerrm<>'luna_fact_source_mismatch' then raise; end if;
  end;
  begin
    perform dispatch_commit(org,wrong_job,0,gen_random_uuid(),'foreign-job','fixture','note_upsert',dispatch_source_version(foreign_org,wrong_job),'{"allocations":[]}');
    raise exception 'foreign org dispatch commit accepted';
  exception when raise_exception then
    if sqlerrm<>'job_not_found' then raise; end if;
  end;
end $$;
do $$
declare org uuid='00000000-0000-4000-8000-000000000001'; j1 uuid='10000000-0000-4000-8000-000000000031'; j2 uuid='10000000-0000-4000-8000-000000000032'; po uuid='70000000-0000-4000-8000-000000000031'; lines jsonb='[{"description":"Cross job fixture","quantity":10,"unit":"each"}]'; lot jsonb; st jsonb; before text; after text;
begin
  insert into jobs(id,org_id,status,accepted_at,scope_json,pricing_json) values(j1,org,'accepted',now(),'{}','{}'),(j2,org,'accepted',now(),'{}','{}');
  insert into purchase_orders(id,org_id,job_id,status,line_items) values(po,org,j1,'confirmed',lines);
  lot=jsonb_build_object('id','po:'||po||':0','quantity',10,'unit','each','source_version','A','source_snapshot',lines->0,'source_ref',jsonb_build_object('kind','purchase_order_line','po_id',po,'index',0,'po_lines',lines));
  st=jsonb_build_object('allocations',jsonb_build_array(jsonb_build_object('id','30000000-0000-4000-8000-000000000031','requirement_id','40000000-0000-4000-8000-000000000031','supply_id','po:'||po||':0','quantity',6,'unit','each')));
  perform dispatch_commit(org,j2,0,gen_random_uuid(),'cross-job','fixture','allocation_upsert',dispatch_source_version(org,j2),st,jsonb_build_array(lot));
  before=dispatch_source_version(org,j2);
  update purchase_orders set line_items='[{"description":"Cross job fixture","quantity":5,"unit":"each"}]'::jsonb where id=po;
  after=dispatch_source_version(org,j2);
  if before=after then raise exception 'referenced PO drift did not alter source revision'; end if;
end $$;
do $$
declare org uuid='00000000-0000-4000-8000-000000000001'; job uuid='10000000-0000-4000-8000-000000000002'; ext_event uuid=gen_random_uuid(); echo_event uuid=gen_random_uuid(); mismatch_event uuid=gen_random_uuid(); before_count integer; after_count integer; result jsonb;
begin
  delete from dispatch_tasks where org_id=org and job_id=job;
  before_count=(select count(*) from dispatch_tasks where org_id=org and job_id=job);
  insert into business_events(id,event_type,source,entity_type,entity_id,job_id,match_status,match_method,payload,metadata) values(ext_event,'po.reply.received','ops-api','job',job::text,job::text,'matched','direct_job_id',jsonb_build_object('job_id',job),'{}');
  after_count=(select count(*) from dispatch_tasks where org_id=org and job_id=job);
  if after_count<=before_count then raise exception 'external business event did not enqueue dispatch'; end if;
  insert into business_events(id,event_type,source,entity_type,entity_id,job_id,match_status,match_method,payload,metadata) values(echo_event,'dispatch.plan.changed','ops-api','dispatch_plan',job::text,job::text,'matched','direct_job_id',jsonb_build_object('job_id',job),jsonb_build_object('derivation',jsonb_build_object('owner','dispatch')));
  if (select count(*) from dispatch_tasks where org_id=org and job_id=job)>after_count then raise exception 'dispatch echo enqueued itself'; end if;
  result=dispatch_enqueue_from_business_event(ext_event);
  if result->>'queued' not in ('false','true') then raise exception 'event enqueue result malformed'; end if;
  insert into business_events(id,event_type,source,entity_type,entity_id,job_id,match_status,match_method,payload,metadata) values(mismatch_event,'po.reply.received','ops-api','job',job::text,job::text,'matched','direct_job_id',jsonb_build_object('job_id',job,'source_ref',jsonb_build_object('org_id','00000000-0000-4000-8000-000000000002')),'{}');
  result=dispatch_enqueue_from_business_event(mismatch_event);
  if result->>'reason'<>'org_mismatch' then raise exception 'foreign source org enqueued dispatch'; end if;
end $$;
do $$
declare org uuid='00000000-0000-4000-8000-000000000040'; first_job uuid='10000000-0000-4040-8000-000000000001'; r1 jsonb; r2 jsonb; r3 jsonb; changed_source text;
begin
  for i in 1..30 loop
    insert into jobs(id,org_id,status,accepted_at,scope_json,pricing_json) values(('10000000-0000-4040-8000-'||lpad(i::text,12,'0'))::uuid,org,'accepted',now(),'{}','{}');
  end loop;
  r1=dispatch_reconcile_eligible_jobs(org,25);
  if (r1->>'count')::integer<>25 then raise exception 'first reconcile was not bounded at 25'; end if;
  r2=dispatch_reconcile_eligible_jobs(org,25);
  if (r2->>'count')::integer<>5 then raise exception 'second reconcile missed remaining eligible jobs'; end if;
  update jobs set scope_json='{"late":"source change"}' where id=first_job;
  changed_source=dispatch_source_version(org,first_job);
  r3=dispatch_reconcile_eligible_jobs(org,25);
  if (r3->>'wrapped')<>'true' or (r3->>'count')::integer<>25 then raise exception 'eligible reconcile did not wrap around'; end if;
  if not exists(select 1 from dispatch_tasks where org_id=org and job_id=first_job and source_version=changed_source) then raise exception 'wraparound missed late source change'; end if;
end $$;
do $$
declare org uuid='00000000-0000-4000-8000-000000000001'; job uuid='10000000-0000-4000-8000-000000000060'; source text; result jsonb;
begin
  insert into jobs(id,org_id,status,accepted_at,scope_json,pricing_json) values(job,org,'accepted',now(),'{}','{}');
  insert into dispatch_plans(org_id,job_id,state,source_version) values(org,job,jsonb_build_object('assessment',jsonb_build_object('source_version',dispatch_source_version(org,job),'stale',false)),dispatch_source_version(org,job));
  result=dispatch_enqueue_job(org,job,'fresh-skip');
  if result->>'reason'<>'assessment_current' or exists(select 1 from dispatch_tasks where org_id=org and job_id=job) then raise exception 'current assessment was requeued'; end if;
end $$;
do $$
declare org uuid='00000000-0000-4000-8000-000000000001'; job uuid='10000000-0000-4000-8000-000000000061'; source text; lot jsonb; allocation jsonb;
begin
  insert into jobs(id,org_id,status,accepted_at,scope_json,pricing_json) values(job,org,'accepted',now(),'{}','{}');
  source=dispatch_source_version(org,job);
  lot='{"id":"stock:zero","quantity":0,"unit":"each","source_ref":{"kind":"stock"},"source_version":"zero"}'::jsonb;
  perform dispatch_commit(org,job,0,gen_random_uuid(),'zero-stock','fixture','allocation_upsert',source,'{"allocations":[]}',jsonb_build_array(lot));
  if (select quantity from dispatch_supply_lots where org_id=org and id='stock:zero')<>0 then raise exception 'unreserved zero stock not persisted'; end if;
  source=dispatch_source_version(org,job);
  lot='{"id":"stock:reserved","quantity":5,"unit":"each","source_ref":{"kind":"stock"},"source_version":"five"}'::jsonb;
  allocation=jsonb_build_object('allocations',jsonb_build_array(jsonb_build_object('id','30000000-0000-4000-8000-000000000061','requirement_id','40000000-0000-4000-8000-000000000061','supply_id','stock:reserved','quantity',4,'unit','each')));
  perform dispatch_commit(org,job,1,gen_random_uuid(),'reserve-stock','fixture','allocation_upsert',source,allocation,jsonb_build_array(lot));
  begin
    perform dispatch_commit(org,job,2,gen_random_uuid(),'reserved-zero','fixture','allocation_upsert',dispatch_source_version(org,job),allocation,jsonb_build_array(jsonb_set(lot,'{quantity}','0'::jsonb)));
    raise exception 'reserved stock reduced below reservation';
  exception when serialization_failure then null; end;
end $$;
do $$
declare org uuid='00000000-0000-4000-8000-000000000001'; job uuid='10000000-0000-4000-8000-000000000002'; source text; draft uuid='60000000-0000-4000-8000-000000000041'; approval uuid='60000000-0000-4000-8000-000000000042'; okdraft uuid='60000000-0000-4000-8000-000000000043'; okapproval uuid='60000000-0000-4000-8000-000000000044'; result jsonb;
begin
  insert into dispatch_release_controls values(org,true) on conflict(org_id) do update set communications_enabled=true;
  source=dispatch_source_version(org,job);
  update dispatch_plans set state=jsonb_build_object('drafts',jsonb_build_array(jsonb_build_object('id',draft,'content_hash','exact-unlinked','source_version',source,'body','Supplier commitment fixture','approval',jsonb_build_object('id',approval,'content_hash','exact-unlinked','source_version',source,'communications_approved',true)))) where org_id=org and job_id=job;
  begin
    perform dispatch_claim_execution(org,job,draft,approval,'exact-unlinked',source);
    raise exception 'unclassified supplier commitment bypassed purchase approval';
  exception when serialization_failure then null; end;
  update dispatch_plans set state=jsonb_build_object('drafts',jsonb_build_array(jsonb_build_object('id',okdraft,'content_hash','exact-info','source_version',source,'body','Information only fixture','purchase_commitment',false,'approval',jsonb_build_object('id',okapproval,'content_hash','exact-info','source_version',source,'communications_approved',true)))) where org_id=org and job_id=job;
  result=dispatch_claim_execution(org,job,okdraft,okapproval,'exact-info',source);
  if result->>'claimed'<>'true' then raise exception 'explicit non-purchase draft refused'; end if;
end $$;
reset role;
