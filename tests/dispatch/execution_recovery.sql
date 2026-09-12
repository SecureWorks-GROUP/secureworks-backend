\set ON_ERROR_STOP on
set role service_role;

do $$
declare
 org uuid='00000000-0000-4000-8000-000000000071';
 action uuid='60000000-0000-4000-8000-000000000071';
 job uuid='10000000-0000-4000-8000-000000000071';
 draft uuid='50000000-0000-4000-8000-000000000071';
 receipt jsonb=jsonb_build_object('mailbox','ops@example.test','draft_id','immutable-draft-71','change_key','ck1');
 result jsonb;
begin
 insert into dispatch_executions(org_id,id,job_id,draft_id,content_hash,source_version,snapshot,status,receipt,last_error)
 values(org,action,job,draft,'hash-71','source-71','{}','outcome_unknown',receipt,'timeout after provider call');
 result=dispatch_record_execution_readback(org,action,'outcome_unknown',receipt,'source-71',jsonb_build_object('verified',true,'id','immutable-draft-71','is_draft',false,'sent_at','2026-09-13T01:00:00Z','delivered',null));
 if result->>'recorded'<>'true' or result#>>'{action,status}'<>'accepted_not_delivered' or result->>'readback_required'<>'false' then
  raise exception 'verified immutable sent readback did not resolve to accepted_not_delivered';
 end if;
 if (select e.receipt#>>'{readback,id}' from dispatch_executions e where e.org_id=org and e.id=action)<>'immutable-draft-71' then
  raise exception 'readback evidence not persisted';
 end if;
 if (select last_error from dispatch_executions where org_id=org and id=action) is not null then
  raise exception 'accepted readback retained stale provider error';
 end if;
end $$;

do $$
declare
 org uuid='00000000-0000-4000-8000-000000000072';
 action uuid='60000000-0000-4000-8000-000000000072';
 job uuid='10000000-0000-4000-8000-000000000072';
 draft uuid='50000000-0000-4000-8000-000000000072';
 receipt jsonb=jsonb_build_object('mailbox','ops@example.test','draft_id','immutable-draft-72','change_key','ck1');
 result jsonb;
begin
 insert into dispatch_executions(org_id,id,job_id,draft_id,content_hash,source_version,snapshot,status,receipt,last_error)
 values(org,action,job,draft,'hash-72','source-72','{}','outcome_unknown',receipt,'needs recovery');
 result=dispatch_record_execution_readback(org,action,'outcome_unknown',receipt,'source-72',jsonb_build_object('verified',true,'id','immutable-draft-72','is_draft',true,'sent_at',null,'delivered',null));
 if result->>'recorded'<>'true' or result#>>'{action,status}'<>'outcome_unknown' or result->>'readback_required'<>'true' then
  raise exception 'still-draft readback changed execution outcome';
 end if;
 result=dispatch_record_execution_readback(org,action,'outcome_unknown',(receipt||jsonb_build_object('readback',jsonb_build_object('verified',true,'id','immutable-draft-72','is_draft',true,'sent_at',null,'delivered',null))),'source-72',jsonb_build_object('verified',false,'status',404));
 if result->>'recorded'<>'true' or result#>>'{action,status}'<>'outcome_unknown' or result->>'readback_required'<>'true' then
  raise exception '404 readback changed execution outcome';
 end if;
end $$;

do $$
declare
 org uuid='00000000-0000-4000-8000-000000000073';
 action uuid='60000000-0000-4000-8000-000000000073';
 job uuid='10000000-0000-4000-8000-000000000073';
 draft uuid='50000000-0000-4000-8000-000000000073';
 receipt jsonb=jsonb_build_object('mailbox','ops@example.test','draft_id','immutable-draft-73','change_key','ck1');
 result jsonb;
begin
 insert into dispatch_executions(org_id,id,job_id,draft_id,content_hash,source_version,snapshot,status,receipt,last_error)
 values(org,action,job,draft,'hash-73','source-73','{}','outcome_unknown',receipt,'needs recovery');
 update dispatch_executions set status='not_sent' where org_id=org and id=action;
 result=dispatch_record_execution_readback(org,action,'outcome_unknown',receipt,'source-73',jsonb_build_object('verified',true,'id','immutable-draft-73','is_draft',false,'sent_at','2026-09-13T01:00:00Z','delivered',null));
 if result->>'recorded'<>'false' or result->>'reason'<>'stale_action' then
  raise exception 'stale readback was not fenced';
 end if;
 if (select status from dispatch_executions where org_id=org and id=action)<>'not_sent' then
  raise exception 'stale readback overwrote concurrent status';
 end if;
end $$;

do $$
declare
 org uuid='00000000-0000-4000-8000-000000000074';
 job uuid='10000000-0000-4000-8000-000000000074';
 draft uuid='50000000-0000-4000-8000-000000000074';
 action uuid='60000000-0000-4000-8000-000000000074';
 approval uuid='60000000-0000-4000-8000-000000000075';
 source text;
begin
 insert into jobs(id,org_id,status,accepted_at,scope_json,pricing_json) values(job,org,'accepted',now(),'{}','{}');
 source=dispatch_source_version(org,job);
 insert into dispatch_release_controls(org_id,communications_enabled) values(org,true);
 insert into dispatch_plans(org_id,job_id,state,source_version)
 values(org,job,jsonb_build_object('drafts',jsonb_build_array(jsonb_build_object('id',draft,'content_hash','hash-74','source_version',source,'purchase_commitment',false,'approval',jsonb_build_object('id',approval,'content_hash','hash-74','source_version',source,'communications_approved',true)))),source);
 insert into dispatch_executions(org_id,id,job_id,draft_id,content_hash,source_version,snapshot,status,receipt)
 values(org,action,job,draft,'hash-74',source,'{}','outcome_unknown',jsonb_build_object('mailbox','ops@example.test','draft_id','immutable-draft-74'));
 begin
  perform dispatch_claim_execution(org,job,draft,approval,'hash-74',source);
  raise exception 'duplicate uncertain execution claim allowed';
 exception when serialization_failure then null; end;
end $$;

reset role;
