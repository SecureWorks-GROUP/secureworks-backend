\set ON_ERROR_STOP on
set role service_role;
select dispatch_commit('00000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001',0,'20000000-0000-4000-8000-000000000001','hash1','fixture','allocation_upsert',dispatch_source_version('00000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001'),'{"allocations":[{"id":"30000000-0000-4000-8000-000000000001","requirement_id":"40000000-0000-4000-8000-000000000001","supply_id":"po:fixture:0","quantity":6,"unit":"each"}]}','[{"id":"po:fixture:0","quantity":10,"unit":"each","source_ref":{"kind":"fixture"},"source_version":"v1"}]');
do $$ begin
 if (select version from dispatch_plans where job_id='10000000-0000-4000-8000-000000000001')<>1 then raise exception 'persistence failure'; end if;
 if (select sum(quantity) from dispatch_reservations)<>6 then raise exception 'reservation failure'; end if;
end $$;
-- Exact replay is idempotent even after the source changes.
select dispatch_commit('00000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001',0,'20000000-0000-4000-8000-000000000001','hash1','fixture','allocation_upsert','old','{}');
do $$ begin
 if (select version from dispatch_plans where job_id='10000000-0000-4000-8000-000000000001')<>1 then raise exception 'replay bumped version'; end if;
 begin
  perform dispatch_commit('00000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000002',0,'20000000-0000-4000-8000-000000000002','hash2','fixture','allocation_upsert',dispatch_source_version('00000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000002'),'{"allocations":[{"id":"30000000-0000-4000-8000-000000000002","requirement_id":"40000000-0000-4000-8000-000000000002","supply_id":"po:fixture:0","quantity":5,"unit":"each"}]}');
  raise exception 'over-allocation accepted';
 exception when serialization_failure then null; end;
 if exists(select 1 from dispatch_plans where job_id='10000000-0000-4000-8000-000000000002') then raise exception 'failed transaction persisted'; end if;
 begin
  perform dispatch_commit('00000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001',0,'20000000-0000-4000-8000-000000000003','h3','fixture','note_upsert',dispatch_source_version('00000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001'),'{"allocations":[]}');
  raise exception 'stale version accepted';
 exception when serialization_failure then null; end;
 begin
  perform dispatch_commit('00000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001',1,'20000000-0000-4000-8000-000000000004','h4','fixture','note_upsert','stale-source','{"allocations":[]}');
  raise exception 'stale source accepted';
 exception when serialization_failure then null; end;
 if (select dispatch_eligibility from dispatch_eligible_jobs where id='10000000-0000-4000-8000-000000000002')<>'unresolved' then raise exception 'stage equated acceptance';end if;
end $$;
reset role;
set role authenticated;
do $$ begin
 begin perform * from dispatch_plans; raise exception 'authenticated bypass'; exception when insufficient_privilege then null; end;
end $$;
reset role;
