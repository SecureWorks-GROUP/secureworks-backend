\set ON_ERROR_STOP on
set role service_role;
do $$
declare org uuid='00000000-0000-4000-8000-000000000001'; j1 uuid='10000000-0000-4000-8000-000000000005'; j2 uuid='10000000-0000-4000-8000-000000000006'; po uuid='70000000-0000-4000-8000-000000000002'; lines jsonb='[{"description":"A","quantity":10,"unit":"each"},{"description":"B","quantity":20,"unit":"each"}]'; lot jsonb; st jsonb;
begin
 insert into jobs(id,org_id,status) values(j1,org,'scheduled'),(j2,org,'scheduled');
 insert into purchase_orders(id,org_id,job_id,status,line_items) values(po,org,j1,'confirmed',lines);
 lot=jsonb_build_object('id','po:'||po||':0','quantity',10,'unit','each','source_version','A','source_snapshot',lines->0,'source_ref',jsonb_build_object('kind','purchase_order_line','po_id',po,'index',0,'po_lines',lines));
 st=jsonb_build_object('allocations',jsonb_build_array(jsonb_build_object('id',gen_random_uuid(),'requirement_id',gen_random_uuid(),'supply_id','po:'||po||':0','quantity',8,'unit','each')));
 perform dispatch_commit(org,j1,0,gen_random_uuid(),'first','fixture','allocation_upsert',dispatch_source_version(org,j1),st,jsonb_build_array(lot));
 lines=jsonb_build_array(lines->1,lines->0);update purchase_orders set line_items=lines where id=po;
 lot=jsonb_build_object('id','po:'||po||':1','quantity',10,'unit','each','source_version','A','source_snapshot',lines->1,'source_ref',jsonb_build_object('kind','purchase_order_line','po_id',po,'index',1,'po_lines',lines));
 st=jsonb_build_object('allocations',jsonb_build_array(jsonb_build_object('id',gen_random_uuid(),'requirement_id',gen_random_uuid(),'supply_id','po:'||po||':1','quantity',8,'unit','each')));
 begin
  perform dispatch_commit(org,j2,0,gen_random_uuid(),'second','fixture','allocation_upsert',dispatch_source_version(org,j2),st,jsonb_build_array(lot));
  raise exception 'reordered physical supply double counted';
 exception when serialization_failure then null;end;
 if (select sum(quantity) from dispatch_reservations where supply_id like 'po:'||po||':%')<>8 then raise exception 'physical capacity changed';end if;
end $$;
-- Default DB hold and one durable action identity, entirely without a provider.
do $$ declare org uuid='00000000-0000-4000-8000-000000000001'; job uuid='10000000-0000-4000-8000-000000000002'; draft uuid=gen_random_uuid(); approval uuid=gen_random_uuid(); source text; result jsonb;
begin
 source=dispatch_source_version(org,job);
 update dispatch_plans set state=jsonb_build_object('drafts',jsonb_build_array(jsonb_build_object('id',draft,'content_hash','exact','source_version',source,'body','Exact approved fixture','purchase_commitment',false,'approval',jsonb_build_object('id',approval,'content_hash','exact','source_version',source,'communications_approved',true)))) where org_id=org and job_id=job;
 result=dispatch_claim_execution(org,job,draft,approval,'exact',source);
 if result#>>'{action,status}'<>'held' then raise exception 'missing default hold';end if;
 insert into dispatch_release_controls values(org,true);
 result=dispatch_claim_execution(org,job,draft,approval,'exact',source);
 if result->>'claimed'<>'true' then raise exception 'approved claim failed';end if;
 result=dispatch_claim_execution(org,job,draft,approval,'exact',source);
 if result->>'claimed'<>'false' then raise exception 'duplicate claim allowed';end if;
 if (select count(*) from dispatch_executions)<>1 then raise exception 'execution identity duplicated';end if;
end $$;
reset role;
set role service_role;
do $$ declare a dispatch_executions; source text; changed jsonb; result jsonb;
begin
 select * into a from dispatch_executions limit 1;
 update dispatch_executions set status='provider_draft_ready' where id=a.id;
 update dispatch_release_controls set communications_enabled=false where org_id=a.org_id;
 result=dispatch_begin_send(a.org_id,a.id);
 if result->>'allowed'<>'false' then raise exception 'late release hold ignored';end if;
 update dispatch_release_controls set communications_enabled=true where org_id=a.org_id;
 update dispatch_executions set status='provider_draft_ready' where id=a.id;
 result=dispatch_begin_send(a.org_id,a.id);
 if result->>'allowed'<>'true' then raise exception 'exact final claim failed';end if;
 select state into changed from dispatch_plans where org_id=a.org_id and job_id=a.job_id;
 changed=jsonb_set(changed,'{drafts,0,body}','"changed during send"');
 begin
  perform dispatch_commit(a.org_id,a.job_id,1,gen_random_uuid(),'send-edit','fixture','draft_upsert',dispatch_source_version(a.org_id,a.job_id),changed);
  raise exception 'in-flight draft edit allowed';
 exception when serialization_failure then null;end;
end $$;
reset role;
set role service_role;
do $$ declare org uuid='00000000-0000-4000-8000-000000000001';job uuid='10000000-0000-4000-8000-000000000001';before text;
begin
before=dispatch_source_version(org,job);
insert into job_context(id,job_id,kind,value,provenance) values(gen_random_uuid(),job,'workflow_state','{"note":"Own Dispatch projection"}','{"derivation":{"owner":"dispatch","plan_version":1}}');
 if before=dispatch_source_version(org,job) then raise exception 'owner tag alone was hidden from source review';end if;
 before=dispatch_source_version(org,job);
 insert into job_context(id,job_id,kind,value,provenance) values(gen_random_uuid(),job,'instruction','{"note":"External access constraint"}','{"derivation":{"owner":"external_email"}}');
 if before=dispatch_source_version(org,job) then raise exception 'external context failed to invalidate';end if;
end $$;
reset role;
