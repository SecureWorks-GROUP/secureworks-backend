\set ON_ERROR_STOP on
set role service_role;
do $$
declare
  org uuid='00000000-0000-4070-8000-000000000001';
  job uuid='10000000-0000-4070-8000-000000000001';
  token uuid;
  result jsonb;
  listed jsonb;
begin
  insert into jobs(id,org_id,status,accepted_at,scope_json,pricing_json)
    values(job,org,'accepted',now(),'{}','{}');
  insert into dispatch_tasks(org_id,job_id,source_version,plan_version,status,attempts,last_error)
    values(org,job,'exhaust-me',0,'failed',5,'five failures');
  if (select count(*) from dispatch_claim_tasks(org,10))<>0 then raise exception 'exhausted task was claimed'; end if;
  if (select status from dispatch_tasks where org_id=org and job_id=job and source_version='exhaust-me')<>'exhausted' then raise exception 'five-attempt task not exhausted'; end if;
  listed=dispatch_list_tasks(org,'exhausted',10,0);
  if jsonb_array_length(listed->'items')<>1 then raise exception 'exhausted task absent from paginated status'; end if;
  if listed->>'has_more'<>'false' or listed->>'next_offset' is not null then raise exception 'single-page task status pagination was wrong'; end if;
  insert into dispatch_tasks(org_id,job_id,source_version,plan_version,status,attempts,last_error,updated_at)
    values(org,job,'page-b',0,'exhausted',5,'page',now()),(org,job,'page-a',0,'exhausted',5,'page',now());
  listed=dispatch_list_tasks(org,'exhausted',2,0);
  if jsonb_array_length(listed->'items')<>2 or listed->>'has_more'<>'true' or (listed->>'next_offset')::integer<>2 then raise exception 'bounded task status pagination metadata was wrong'; end if;
  delete from dispatch_tasks where org_id=org and job_id=job and source_version in ('page-a','page-b');
  result=dispatch_retry_task(org,job,'exhaust-me',0,'20000000-0000-4070-8000-000000000001','fixture','operator retry');
  if result->>'retried'<>'true' then raise exception 'exhausted task was not retried'; end if;
  if (select attempts from dispatch_tasks where org_id=org and job_id=job and source_version='exhaust-me')<>0 then raise exception 'retry did not reset attempts'; end if;
  if dispatch_retry_task(org,job,'exhaust-me',0,'20000000-0000-4070-8000-000000000001','fixture','operator retry')<>result then raise exception 'retry idempotency did not return original result'; end if;
  if (select count(*) from dispatch_task_retry_audit where org_id=org and request_id='20000000-0000-4070-8000-000000000001')<>1 then raise exception 'retry audit was duplicated'; end if;
  select lease_token into token from dispatch_claim_tasks(org,10) limit 1;
  if token is null then raise exception 'retried task was not claimable'; end if;
  result=dispatch_retry_task(org,job,'exhaust-me',0,'20000000-0000-4070-8000-000000000002','fixture','lease retry');
  if result->>'reason'<>'lease_active' then raise exception 'retry bypassed active lease'; end if;
  update dispatch_tasks set lease_until=now()-interval '1 second' where org_id=org and job_id=job and source_version='exhaust-me';
  begin
    perform dispatch_finalize_task(org,job,'exhaust-me',0,token,'failed','{"status":"failed"}','expired');
    raise exception 'expired lease finalized task';
  exception when serialization_failure then null; end;
  select lease_token into token from dispatch_claim_tasks(org,10) limit 1;
  if token is null then raise exception 'expired retried task was not reclaimable'; end if;
  update dispatch_tasks set attempts=5 where org_id=org and job_id=job and source_version='exhaust-me';
  result=dispatch_finalize_task(org,job,'exhaust-me',0,token,'failed','{"status":"failed"}','still broken');
  if result->>'status'<>'exhausted' then raise exception 'final failure did not exhaust task'; end if;
end $$;
reset role;
create function public.dispatch_task_recovery_fail_insert()
returns trigger language plpgsql as $$
begin
  if new.job_id in ('10000000-0000-4072-8000-000000000001','10000000-0000-4072-8000-000000000013') then
    raise exception 'source failure fixture';
  end if;
  return new;
end $$;
create trigger dispatch_task_recovery_fail_insert before insert on dispatch_tasks
for each row execute function public.dispatch_task_recovery_fail_insert();
set role service_role;
do $$
declare
  org uuid='00000000-0000-4072-8000-000000000001';
  first_bad uuid='10000000-0000-4072-8000-000000000001';
  middle_bad uuid='10000000-0000-4072-8000-000000000013';
  last_first_page uuid='10000000-0000-4072-8000-000000000025';
  changed_source text;
  r1 jsonb;
  r2 jsonb;
  r3 jsonb;
  result jsonb;
  listed jsonb;
  i integer;
  jid uuid;
begin
  for i in 1..27 loop
    jid=('10000000-0000-4072-8000-'||lpad(i::text,12,'0'))::uuid;
    insert into jobs(id,org_id,status,accepted_at,scope_json,pricing_json)
      values(jid,org,'accepted',now(),'{}','{}');
  end loop;
  foreach jid in array array[first_bad,middle_bad] loop
    insert into dispatch_plans(org_id,job_id) values(org,jid);
  end loop;
  r1=dispatch_reconcile_eligible_jobs(org,25);
  if (r1->>'count')::integer<>25 then raise exception 'first recovery reconcile was not bounded'; end if;
  if (r1->>'failure_count')::integer<>2 then raise exception 'first and middle source failures were not captured'; end if;
  if (r1->>'cursor_job_id')<>last_first_page::text then raise exception 'cursor did not advance past failed jobs'; end if;
  if (select count(*) from dispatch_task_source_failures where org_id=org and status='deferred')<>2 then raise exception 'deferred source failures not persisted'; end if;
  listed=dispatch_list_tasks(org,'deferred',1,0);
  if jsonb_array_length(listed->'source_failures')<>1 or listed->>'source_failures_has_more'<>'true' or (listed->>'source_failures_next_offset')::integer<>1 then raise exception 'source failure pagination metadata was wrong'; end if;
  if (select count(*) from dispatch_tasks where org_id=org)<>23 then raise exception 'healthy jobs after failures were not enqueued'; end if;
  result=dispatch_retry_task(org,first_bad,null,null,'20000000-0000-4072-8000-000000000001','fixture','still failing retry');
  if result->>'status'<>'deferred' or result->>'reason'<>'source_unavailable' then raise exception 'failing source retry did not return durable deferred result'; end if;
  if (select count(*) from dispatch_task_retry_audit where org_id=org and request_id='20000000-0000-4072-8000-000000000001')<>1 then raise exception 'failing source retry was not audited'; end if;
  if dispatch_retry_task(org,first_bad,null,null,'20000000-0000-4072-8000-000000000001','fixture','still failing retry')<>result then raise exception 'failing source retry idempotency did not return original result'; end if;
  r2=dispatch_reconcile_eligible_jobs(org,25);
  if (r2->>'count')::integer<>2 or (r2->>'failure_count')::integer<>0 then raise exception 'reconcile did not continue after failed jobs'; end if;
end $$;
reset role;
drop trigger dispatch_task_recovery_fail_insert on dispatch_tasks;
drop function public.dispatch_task_recovery_fail_insert();
set role service_role;
do $$
declare
  org uuid='00000000-0000-4072-8000-000000000001';
  first_bad uuid='10000000-0000-4072-8000-000000000001';
  changed_source text;
  r3 jsonb;
begin
  changed_source=dispatch_source_version(org,first_bad);
  perform dispatch_retry_task(org,first_bad,null,null,'20000000-0000-4072-8000-000000000002','fixture','resolved retry');
  r3=dispatch_reconcile_eligible_jobs(org,25);
  if (r3->>'wrapped')<>'true' then raise exception 'reconcile did not wrap for source recovery'; end if;
  if not exists(select 1 from dispatch_tasks where org_id=org and job_id=first_bad and source_version=changed_source) then raise exception 'recovered source job was not enqueued on wrap'; end if;
  if (select status from dispatch_task_source_failures where org_id=org and job_id=first_bad)<>'resolved' then raise exception 'source failure did not resolve after retry'; end if;
end $$;
reset role;
