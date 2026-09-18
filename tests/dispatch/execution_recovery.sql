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
 exception when serialization_failure then
  if sqlerrm<>'draft_already_executed_or_uncertain' then raise; end if;
 end;
end $$;


do $$
declare
 org uuid='00000000-0000-4000-8000-000000000081';
 action uuid='60000000-0000-4000-8000-000000000081';
 job uuid='10000000-0000-4000-8000-000000000081';
 draft uuid='50000000-0000-4000-8000-000000000081';
 result jsonb;
 source text;
begin
 insert into dispatch_executions(org_id,id,job_id,draft_id,content_hash,source_version,snapshot,status,lease_token,lease_until)
 values(org,action,job,draft,'hash-81','source-81','{}','claimed','80000000-0000-4000-8000-000000000081',now()-interval '1 second');
 result=dispatch_get_execution(org,action);
 if result->>'status'<>'outcome_unknown' or result->>'receipt' is not null or result->>'lease_until' is not null then
  raise exception 'expired claimed execution was not made conservatively unknown';
 end if;
 result=dispatch_record_execution_progress(org,action,'claimed',null,'source-81','80000000-0000-4000-8000-000000000081','provider_draft_ready',jsonb_build_object('mailbox','ops@example.test','draft_id','late-native-81'),'late provider preparation returned after lease expiry');
 if result->>'recorded'<>'true' or result#>>'{action,status}'<>'outcome_unknown' or result#>>'{action,receipt,draft_id}'<>'late-native-81' or result->>'readback_required'<>'true' then
  raise exception 'late preparation receipt was not retained as unknown';
 end if;
 begin
  insert into dispatch_release_controls(org_id,communications_enabled) values(org,true);
  insert into jobs(id,org_id,status,accepted_at,scope_json,pricing_json) values(job,org,'accepted',now(),'{}','{}');
  source=dispatch_source_version(org,job);
  insert into dispatch_plans(org_id,job_id,state,source_version)
  values(org,job,jsonb_build_object('drafts',jsonb_build_array(jsonb_build_object('id',draft,'content_hash','hash-81','source_version',source,'purchase_commitment',false,'approval',jsonb_build_object('id','60000000-0000-4000-8000-000000000082','content_hash','hash-81','source_version',source,'communications_approved',true)))),source);
  perform dispatch_claim_execution(org,job,draft,'60000000-0000-4000-8000-000000000082','hash-81',source);
  raise exception 'duplicate claim after expired unknown execution was allowed';
 exception when serialization_failure then
  if sqlerrm<>'draft_already_executed_or_uncertain' then raise; end if;
 end;
end $$;

do $$
declare
 org uuid='00000000-0000-4000-8000-000000000083';
 action uuid='60000000-0000-4000-8000-000000000083';
 job uuid='10000000-0000-4000-8000-000000000083';
 draft uuid='50000000-0000-4000-8000-000000000083';
 receipt jsonb=jsonb_build_object('mailbox','ops@example.test','draft_id','immutable-draft-83','change_key','ck1');
 result jsonb;
begin
 insert into dispatch_executions(org_id,id,job_id,draft_id,content_hash,source_version,snapshot,status,receipt,lease_token,lease_until)
 values(org,action,job,draft,'hash-83','source-83','{}','provider_draft_ready',receipt,'80000000-0000-4000-8000-000000000083',now()-interval '1 second');
 result=dispatch_begin_send(org,action,'80000000-0000-4000-8000-000000000083');
 if result->>'allowed'<>'false' or result#>>'{action,status}'<>'outcome_unknown' or result#>>'{action,receipt,draft_id}'<>'immutable-draft-83' or result#>>'{action,lease_until}' is not null then
  raise exception 'expired prepared execution did not preserve provider receipt as unknown';
 end if;
end $$;

do $$
declare
 org uuid='00000000-0000-4000-8000-000000000084';
 action uuid='60000000-0000-4000-8000-000000000084';
 job uuid='10000000-0000-4000-8000-000000000084';
 draft uuid='50000000-0000-4000-8000-000000000084';
 receipt jsonb=jsonb_build_object('mailbox','ops@example.test','draft_id','immutable-draft-84','change_key','ck1');
 result jsonb;
begin
 insert into dispatch_executions(org_id,id,job_id,draft_id,content_hash,source_version,snapshot,status,receipt,lease_token,lease_until,last_error)
 values(org,action,job,draft,'hash-84','source-84','{}','sending',receipt,'80000000-0000-4000-8000-000000000084',now()+interval '1 minute','provider send in progress');
 result=dispatch_record_execution_readback(org,action,'sending',receipt,'source-84',jsonb_build_object('verified',true,'id','immutable-draft-84','is_draft',false,'sent_at','2026-09-13T01:00:00Z','delivered',null));
 if result->>'recorded'<>'true' or result#>>'{action,status}'<>'accepted_not_delivered' or result#>>'{action,receipt,readback,delivered}' is not null or result->>'readback_required'<>'false' then
  raise exception 'active sending sent readback did not resolve as accepted not delivered';
 end if;
end $$;

do $$
declare
 org uuid='00000000-0000-4000-8000-000000000085';
 action uuid='60000000-0000-4000-8000-000000000085';
 job uuid='10000000-0000-4000-8000-000000000085';
 draft uuid='50000000-0000-4000-8000-000000000085';
 receipt jsonb=jsonb_build_object('mailbox','ops@example.test','draft_id','immutable-draft-85','change_key','ck1');
 expired jsonb;
 result jsonb;
begin
 insert into dispatch_executions(org_id,id,job_id,draft_id,content_hash,source_version,snapshot,status,receipt,lease_token,lease_until,last_error)
 values(org,action,job,draft,'hash-85','source-85','{}','sending',receipt,'80000000-0000-4000-8000-000000000085',now()-interval '1 second','provider send in progress');
 expired=dispatch_get_execution(org,action);
 if expired->>'status'<>'outcome_unknown' or expired#>>'{receipt,draft_id}'<>'immutable-draft-85' then
  raise exception 'expired sending execution did not become recoverable unknown';
 end if;
 result=dispatch_record_execution_readback(org,action,'outcome_unknown',receipt,'source-85',jsonb_build_object('verified',true,'id','immutable-draft-85','is_draft',false,'sent_at','2026-09-13T01:00:00Z','delivered',null));
 if result->>'recorded'<>'true' or result#>>'{action,status}'<>'accepted_not_delivered' or result#>>'{action,receipt,readback,delivered}' is not null then
  raise exception 'expired sending sent readback did not resolve without delivery claim';
 end if;
 result=dispatch_record_execution_progress(org,action,'sending',receipt,'source-85','80000000-0000-4000-8000-000000000085','outcome_unknown',receipt,'late provider timeout');
 if result->>'recorded'<>'false' or result->>'reason'<>'stale_action' then
  raise exception 'late process error was not fenced after readback recovery';
 end if;
 result=dispatch_record_execution_progress(org,action,'sending',receipt,'source-85','80000000-0000-4000-8000-000000000085','accepted_not_delivered',receipt||jsonb_build_object('provider_accepted',true),'late provider success');
 if result->>'recorded'<>'false' or result->>'reason'<>'stale_action' then
  raise exception 'late process success was not fenced after readback recovery';
 end if;
 if (select status from dispatch_executions where org_id=org and id=action)<>'accepted_not_delivered' then
  raise exception 'late process result overwrote readback-recovered outcome';
 end if;
end $$;

reset role;
