-- Dispatch is a review workbench. These records confer no send/purchase authority.
create table public.dispatch_plans (
  org_id uuid not null,
  job_id uuid not null references public.jobs(id),
  version bigint not null default 0,
  state jsonb not null default '{"groups":[],"requirements":[],"notes":[],"drafts":[],"movements":[],"communication_links":[],"allocations":[],"receipts":[]}',
  source_version text not null default '',
  updated_at timestamptz not null default now(),
  primary key (org_id, job_id)
);
create table public.dispatch_commands (
  org_id uuid not null,
  request_id uuid not null,
  job_id uuid not null,
  request_hash text not null,
  actor text not null,
  command text not null,
  result jsonb not null,
  created_at timestamptz not null default now(),
  primary key (org_id, request_id)
);
-- Supply references existing PO lines; stock entries require explicit audited custody.
create table public.dispatch_supply_lots (
  org_id uuid not null,
  id text not null,
  source_ref jsonb not null,
  source_version text not null,
  quantity numeric not null check (quantity >= 0),
  unit text not null,
  updated_at timestamptz not null default now(),
  primary key (org_id,id)
);
create table public.dispatch_reservations (
  org_id uuid not null,
  job_id uuid not null,
  id uuid not null,
  requirement_id uuid not null,
  supply_id text not null,
  quantity numeric not null check (quantity > 0),
  primary key(org_id,id),
  foreign key(org_id,job_id) references public.dispatch_plans(org_id,job_id),
  foreign key(org_id,supply_id) references public.dispatch_supply_lots(org_id,id)
);
create index dispatch_reservations_supply on public.dispatch_reservations(org_id,supply_id);
create table public.dispatch_tasks (
  org_id uuid not null,
  job_id uuid not null,
  source_version text not null,
  plan_version bigint not null,
  status text not null default 'pending' check(status in ('pending','running','done','failed','deferred','exhausted')),
  attempts integer not null default 0,
  available_at timestamptz not null default now(),
  lease_until timestamptz,
  lease_token uuid,
  last_error text,
  result jsonb,
  updated_at timestamptz not null default now(),
  primary key(org_id,job_id,source_version,plan_version)
);
create index dispatch_tasks_due on public.dispatch_tasks(org_id,status,available_at);
create table public.dispatch_task_source_failures (
  org_id uuid not null,
  job_id uuid not null,
  status text not null default 'deferred' check(status in ('deferred','resolved')),
  attempts integer not null default 0,
  last_error text,
  first_failed_at timestamptz not null default now(),
  last_failed_at timestamptz not null default now(),
  resolved_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key(org_id,job_id)
);
create table public.dispatch_task_retry_audit (
  org_id uuid not null,
  request_id uuid not null,
  job_id uuid not null,
  source_version text,
  plan_version bigint,
  request_hash text not null,
  actor text not null,
  reason text,
  result jsonb not null,
  created_at timestamptz not null default now(),
  primary key(org_id,request_id)
);
create table public.dispatch_reconcile_cursors (
  org_id uuid not null,
  name text not null default 'eligible_jobs',
  cursor_job_id uuid,
  updated_at timestamptz not null default now(),
  primary key(org_id,name)
);
alter table public.dispatch_plans enable row level security;
alter table public.dispatch_commands enable row level security;
alter table public.dispatch_supply_lots enable row level security;
alter table public.dispatch_reservations enable row level security;
alter table public.dispatch_tasks enable row level security;
alter table public.dispatch_task_source_failures enable row level security;
alter table public.dispatch_task_retry_audit enable row level security;
alter table public.dispatch_reconcile_cursors enable row level security;
revoke all on public.dispatch_plans, public.dispatch_commands, public.dispatch_supply_lots, public.dispatch_reservations, public.dispatch_tasks, public.dispatch_task_source_failures, public.dispatch_task_retry_audit, public.dispatch_reconcile_cursors from anon, authenticated;
grant all on public.dispatch_plans, public.dispatch_commands, public.dispatch_supply_lots, public.dispatch_reservations, public.dispatch_tasks, public.dispatch_task_source_failures, public.dispatch_task_retry_audit, public.dispatch_reconcile_cursors to service_role;

-- Database-owned revision covers source owners; Dispatch never edits these tables.
create function public.dispatch_order_reservations(p_org uuid,p_job uuid)
returns table(supply_id text,reserved_quantity numeric) language sql stable security invoker set search_path=public,pg_temp as $$
  select r.supply_id,sum(r.quantity)
  from dispatch_reservations r
  join dispatch_supply_lots l on l.org_id=r.org_id and l.id=r.supply_id
  join purchase_orders p on p.id::text=l.source_ref->>'po_id' and p.org_id=r.org_id
  where r.org_id=p_org and p.job_id=p_job and l.source_ref->>'kind'='purchase_order_line'
  group by r.supply_id;
$$;
revoke all on function public.dispatch_order_reservations(uuid,uuid) from public,anon,authenticated;
grant execute on function public.dispatch_order_reservations(uuid,uuid) to service_role;

create function public.dispatch_is_own_plan_source(p_event_id uuid default null,p_event jsonb default null,p_fact jsonb default null)
returns boolean language plpgsql stable security invoker set search_path=public,pg_temp as $$
declare
  event_doc jsonb;
  fact_doc jsonb;
  source_id_text text;
  source_id uuid;
  uuid_re text='^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$';
  int_re text='^[1-9][0-9]*$';
  org_text text;
  job_text text;
  request_text text;
  plan_text text;
  event_id_text text;
  org_uuid uuid;
  job_uuid uuid;
begin
  event_doc=p_event;
  fact_doc=p_fact;
  if event_doc is null and fact_doc is not null then
    if jsonb_typeof(fact_doc) is distinct from 'object' then return false; end if;
    if jsonb_typeof(fact_doc#>'{value,source_refs}') is distinct from 'array'
      or jsonb_array_length(fact_doc#>'{value,source_refs}')<>1
      or fact_doc#>>'{value,source_refs,0,table}' is distinct from 'business_events'
      or jsonb_typeof(fact_doc#>'{provenance,source_event_ids}') is distinct from 'array'
      or jsonb_array_length(fact_doc#>'{provenance,source_event_ids}')<>1
      or jsonb_typeof(fact_doc#>'{provenance,derivation,source_event_ids}') is distinct from 'array'
      or jsonb_array_length(fact_doc#>'{provenance,derivation,source_event_ids}')<>1
    then
      return false;
    end if;
    source_id_text=fact_doc#>>'{value,source_refs,0,id}';
    if source_id_text is null or source_id_text !~ uuid_re then return false; end if;
    if fact_doc#>>'{provenance,source_event_ids,0}' is distinct from source_id_text
      or fact_doc#>>'{provenance,derivation,source_event_ids,0}' is distinct from source_id_text
    then return false; end if;
    source_id=source_id_text::uuid;
    select to_jsonb(b) into event_doc from business_events b where b.id=source_id;
    if event_doc is null then return false; end if;
  end if;
  if event_doc is null or jsonb_typeof(event_doc) is distinct from 'object' then return false; end if;
  event_id_text=event_doc->>'id';
  org_text=event_doc#>>'{payload,org_id}';
  job_text=event_doc#>>'{payload,job_id}';
  request_text=event_doc->>'correlation_id';
  plan_text=event_doc#>>'{payload,plan_version}';
  if event_id_text is null or event_id_text !~ uuid_re
    or org_text is null or org_text !~ uuid_re
    or job_text is null or job_text !~ uuid_re
    or request_text is null or request_text !~ uuid_re
    or plan_text is null or plan_text !~ int_re
    or nullif(event_doc->>'occurred_at','') is null
  then return false; end if;
  org_uuid=org_text::uuid;
  job_uuid=job_text::uuid;
  if p_event_id is not null and event_id_text is distinct from p_event_id::text then return false; end if;
  if event_doc->>'event_type' is distinct from 'dispatch.plan.changed'
    or event_doc->>'source' is distinct from 'ops-api'
    or event_doc->>'entity_type' is distinct from 'dispatch_plan'
    or event_doc->>'entity_id' is distinct from job_text
    or event_doc->>'job_id' is distinct from job_text
    or event_doc->>'match_status' is distinct from 'matched'
    or event_doc->>'match_method' is distinct from 'direct_job_id'
    or event_doc#>>'{payload,contract_version}' is distinct from 'dispatch-context/v1'
    or jsonb_typeof(event_doc#>'{payload,state}') is distinct from 'object'
    or nullif(event_doc#>>'{payload,command}','') is null
    or nullif(event_doc#>>'{payload,source_version}','') is null
    or event_doc#>>'{metadata,evidence_role}' is distinct from 'human_working_state'
    or event_doc#>'{metadata,provider_action}' is distinct from 'false'::jsonb
    or jsonb_typeof(event_doc#>'{metadata,source_ref}') is distinct from 'object'
    or event_doc#>>'{metadata,source_ref,table}' is distinct from 'dispatch_plans'
    or event_doc#>>'{metadata,source_ref,org_id}' is distinct from org_text
    or event_doc#>>'{metadata,source_ref,job_id}' is distinct from job_text
    or event_doc#>>'{metadata,source_ref,version}' is distinct from plan_text
    or jsonb_typeof(event_doc#>'{metadata,derivation}') is distinct from 'object'
    or event_doc#>>'{metadata,derivation,owner}' is distinct from 'dispatch'
    or event_doc#>>'{metadata,derivation,event_id}' is distinct from request_text
    or event_doc#>>'{metadata,derivation,plan_version}' is distinct from plan_text
  then return false; end if;
  if not exists(select 1 from jobs j where j.id=job_uuid and j.org_id=org_uuid) then return false; end if;
  if not exists(
    select 1 from dispatch_commands dc
    where dc.org_id=org_uuid
      and dc.job_id=job_uuid
      and dc.request_id=request_text::uuid
      and dc.command=event_doc#>>'{payload,command}'
      and dc.result#>>'{version}'=plan_text
      and dc.result#>>'{source_version}'=event_doc#>>'{payload,source_version}'
      and dc.result#>'{state}' is not distinct from event_doc#>'{payload,state}'
  ) then return false; end if;
  if fact_doc is not null then
    if fact_doc->>'job_id' is distinct from job_text
      or fact_doc->>'kind' is distinct from 'note'
      or fact_doc#>>'{provenance,derivation,owner}' is distinct from 'dispatch'
      or fact_doc#>'{provenance,derivation,own_only}' is distinct from 'true'::jsonb
      or fact_doc#>>'{provenance,derivation,event_id}' is distinct from request_text
      or fact_doc#>>'{provenance,derivation,request_id}' is distinct from request_text
      or fact_doc#>>'{provenance,derivation,org_id}' is distinct from org_text
      or fact_doc#>>'{provenance,derivation,job_id}' is distinct from job_text
      or fact_doc#>>'{provenance,derivation,plan_version}' is distinct from plan_text
      or fact_doc->>'id' is distinct from event_id_text
      or fact_doc->>'correlation_id' is distinct from request_text
      or fact_doc#>>'{value,text}' is distinct from 'Dispatch working review state. Not a claim that an order was sent, purchased, delivered or paid.'
      or fact_doc#>>'{value,command}' is distinct from event_doc#>>'{payload,command}'
      or fact_doc#>>'{value,source_version}' is distinct from event_doc#>>'{payload,source_version}'
      or fact_doc#>>'{value,plan_version}' is distinct from plan_text
      or fact_doc#>'{value,state}' is distinct from event_doc#>'{payload,state}'
      or fact_doc#>>'{provenance,extractor}' is distinct from 'dispatch_working_state_v1'
      or fact_doc#>>'{provenance,writer_role}' is distinct from 'dispatch_working_state_projector'
      or fact_doc#>'{provenance,untrusted}' is distinct from 'false'::jsonb
      or fact_doc#>>'{provenance,lifecycle}' is distinct from 'active'
      or fact_doc#>>'{provenance,validity_basis}' is distinct from 'ongoing'
      or fact_doc#>>'{provenance,derivation,rule_version}' is distinct from 'dispatch_working_state_v1'
      or fact_doc#>'{provenance,safety}' is distinct from '{"memory_trusted":true,"action_safe":false,"state_change_safe":false,"outbound_safe":false}'::jsonb
      or jsonb_typeof(fact_doc#>'{provenance,derivation,source_event_ids}') is distinct from 'array'
      or jsonb_array_length(fact_doc#>'{provenance,derivation,source_event_ids}')<>1
      or fact_doc#>>'{provenance,derivation,source_event_ids,0}' is distinct from event_id_text
      or jsonb_typeof(fact_doc#>'{provenance,source_event_ids}') is distinct from 'array'
      or jsonb_array_length(fact_doc#>'{provenance,source_event_ids}')<>1
      or fact_doc#>>'{provenance,source_event_ids,0}' is distinct from event_id_text
      or (fact_doc ? 'source_event_ids' and (jsonb_typeof(fact_doc->'source_event_ids') is distinct from 'array' or jsonb_array_length(fact_doc->'source_event_ids')<>1 or fact_doc#>>'{source_event_ids,0}' is distinct from event_id_text))
      or jsonb_typeof(fact_doc#>'{value,source_refs}') is distinct from 'array'
      or jsonb_array_length(fact_doc#>'{value,source_refs}')<>1
      or fact_doc#>>'{value,source_refs,0,table}' is distinct from 'business_events'
      or fact_doc#>>'{value,source_refs,0,id}' is distinct from event_id_text
      or fact_doc#>>'{provenance,evidence_role}' is distinct from 'human_working_state'
      or fact_doc#>'{provenance,provider_action}' is distinct from 'false'::jsonb
    then return false; end if;
  end if;
  return true;
exception when others then
  return false;
end $$;
revoke all on function public.dispatch_is_own_plan_source(uuid,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.dispatch_is_own_plan_source(uuid,jsonb,jsonb) to service_role;

create function public.dispatch_context_facts_for_source(p_org uuid,p_job uuid,p_limit integer default 1000)
returns setof public.current_job_context_facts language sql stable security invoker set search_path=public,pg_temp as $$
  select c.* from current_job_context_facts c
  where c.job_id=p_job
    and exists(select 1 from jobs j where j.id=p_job and j.org_id=p_org)
    and not dispatch_is_own_plan_source(null,null,to_jsonb(c))
  order by c.id
  limit case when p_limit is null then null else least(greatest(p_limit,1),1000) end
$$;
revoke all on function public.dispatch_context_facts_for_source(uuid,uuid,integer) from public,anon,authenticated;
grant execute on function public.dispatch_context_facts_for_source(uuid,uuid,integer) to service_role;

create function public.dispatch_source_version(p_org uuid,p_job uuid)
returns text language sql stable security invoker set search_path=public,pg_temp as $$
 select md5(jsonb_build_object(
 'job',jsonb_build_object('scope',j.scope_json,'pricing',j.pricing_json,'accepted',j.accepted_at,'status',j.status,'address',j.site_address,'scheduled',j.scheduled_at),
 'purchase_orders',(select coalesce(jsonb_agg(to_jsonb(p) order by p.id),'[]') from purchase_orders p where p.job_id=j.id),
 'allocated_supply',(select coalesce(jsonb_agg(jsonb_build_object('reservation',jsonb_build_object('id',r.id,'requirement_id',r.requirement_id,'supply_id',r.supply_id,'quantity',r.quantity),'lot',jsonb_build_object('id',l.id,'source_ref',l.source_ref,'source_version',l.source_version,'quantity',l.quantity,'unit',l.unit)) order by r.id),'[]') from dispatch_reservations r join dispatch_supply_lots l on l.org_id=r.org_id and l.id=r.supply_id where r.org_id=j.org_id and r.job_id=j.id),
 'prepared_reservations',(select coalesce(jsonb_agg(to_jsonb(r) order by r.supply_id),'[]') from dispatch_order_reservations(j.org_id,j.id) r),
 'referenced_purchase_orders',(select coalesce(jsonb_agg(to_jsonb(p) order by p.id),'[]') from purchase_orders p where p.org_id=j.org_id and p.id in (select (l.source_ref->>'po_id')::uuid from dispatch_reservations r join dispatch_supply_lots l on l.org_id=r.org_id and l.id=r.supply_id where r.org_id=j.org_id and r.job_id=j.id and l.source_ref->>'kind'='purchase_order_line' and l.source_ref->>'po_id' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$')),
 'documents',(select coalesce(jsonb_agg(to_jsonb(d) order by d.id),'[]') from job_documents d where d.job_id=j.id),
 'communications',(select coalesce(jsonb_agg(to_jsonb(c) order by c.id),'[]') from po_communications c where c.job_id=j.id),
 'media',(select coalesce(jsonb_agg(to_jsonb(m) order by m.id),'[]') from job_media m where m.job_id=j.id),
 'assignments',(select coalesce(jsonb_agg(to_jsonb(a) order by a.id),'[]') from job_assignments a where a.job_id=j.id),
 'context',(select coalesce(jsonb_agg(to_jsonb(c) order by c.id),'[]') from dispatch_context_facts_for_source(j.org_id,j.id,null) c)
 )::text) from jobs j where j.id=p_job and j.org_id=p_org;
$$;
revoke all on function public.dispatch_source_version(uuid,uuid) from public,anon,authenticated;
grant execute on function public.dispatch_source_version(uuid,uuid) to service_role;

-- All aggregate writes and reservations share an org lock: two jobs cannot reserve
-- the same final unit, nor can a concurrent stale editor overwrite newer work.
create function public.dispatch_commit(p_org uuid,p_job uuid,p_expected bigint,p_request uuid,
  p_hash text,p_actor text,p_command text,p_source text,p_state jsonb,p_lots jsonb default '[]',p_task jsonb default null)
returns jsonb language plpgsql security invoker set search_path = public, pg_temp as $$
declare prior dispatch_commands; plan dispatch_plans; a jsonb; lot jsonb; cap numeric; used numeric; result jsonb; draft jsonb; order_id uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended('dispatch:'||p_org::text,0));
  select * into prior from dispatch_commands where org_id=p_org and request_id=p_request;
  if found then
    if prior.request_hash <> p_hash or prior.job_id <> p_job then raise exception 'idempotency_conflict' using errcode='40001'; end if;
    return prior.result;
  end if;
  if p_task is not null and not exists(select 1 from dispatch_tasks where org_id=p_org and job_id=p_job and source_version=p_task->>'source_version' and plan_version=(p_task->>'plan_version')::bigint and lease_token=(p_task->>'lease_token')::uuid and status='running' and lease_until>now()) then raise exception 'task_lease_lost' using errcode='40001'; end if;
  if not exists(select 1 from jobs where id=p_job and org_id=p_org) then raise exception 'job_not_found'; end if;
  if dispatch_source_version(p_org,p_job) is distinct from p_source then raise exception 'source_conflict' using errcode='40001'; end if;
  insert into dispatch_plans(org_id,job_id) values(p_org,p_job) on conflict do nothing;
  select * into plan from dispatch_plans where org_id=p_org and job_id=p_job for update;
  if plan.version <> p_expected then raise exception 'version_conflict' using errcode='40001'; end if;
  if exists(select 1 from dispatch_executions e where e.org_id=p_org and e.job_id=p_job and e.status='sending'
    and (select value from jsonb_array_elements(p_state->'drafts') where value->>'id'=e.draft_id::text)
      is distinct from (select value from jsonb_array_elements(plan.state->'drafts') where value->>'id'=e.draft_id::text))
  then raise exception 'draft_send_in_progress' using errcode='40001'; end if;

  for lot in select value from jsonb_array_elements(coalesce(p_lots,'[]'::jsonb)) loop
    if lot#>>'{source_ref,kind}'='purchase_order_line' then
      if (lot->>'id') is distinct from 'po:'||(lot#>>'{source_ref,po_id}')::uuid::text||':'||(lot#>>'{source_ref,index}')::integer::text
        or (lot#>>'{source_ref,index}')::integer < 0
      then raise exception 'noncanonical_supply_identity' using errcode='40001'; end if;
    end if;
    if lot#>>'{source_ref,kind}'='purchase_order_line' and not exists(
      select 1 from purchase_orders where id=(lot#>>'{source_ref,po_id}')::uuid and org_id=p_org
      and status in ('submitted','authorised','sent','confirmed','delivered','billed')
      and line_items->(lot#>>'{source_ref,index}')::integer = lot->'source_snapshot'
      and line_items=lot#>'{source_ref,po_lines}'
    ) then raise exception 'supply_source_changed' using errcode='40001'; end if;
    if lot#>>'{source_ref,kind}'='purchase_order_line' and exists(
      select 1 from dispatch_reservations r join dispatch_supply_lots l on l.org_id=r.org_id and l.id=r.supply_id
      where r.org_id=p_org and l.source_ref->>'po_id'=lot#>>'{source_ref,po_id}'
      and l.source_ref->'po_lines' is distinct from lot#>'{source_ref,po_lines}'
    ) then raise exception 'po_revision_requires_reconciliation' using errcode='40001'; end if;
    if coalesce((select sum(quantity) from dispatch_reservations where org_id=p_org and supply_id=lot->>'id'),0)>(lot->>'quantity')::numeric then raise exception 'count_below_reserved' using errcode='40001'; end if;
    if exists(select 1 from dispatch_supply_lots l where l.org_id=p_org and l.id=lot->>'id' and l.source_version<>lot->>'source_version')
      and exists(select 1 from dispatch_reservations r where r.org_id=p_org and r.supply_id=lot->>'id')
    then raise exception 'supply_revision_requires_reconciliation' using errcode='40001'; end if;
    insert into dispatch_supply_lots(org_id,id,source_ref,source_version,quantity,unit)
      values(p_org,lot->>'id',lot->'source_ref',lot->>'source_version',(lot->>'quantity')::numeric,lot->>'unit')
      on conflict(org_id,id) do update set source_ref=excluded.source_ref,source_version=excluded.source_version,
        quantity=excluded.quantity,unit=excluded.unit,updated_at=now();
  end loop;
  delete from dispatch_reservations where org_id=p_org and job_id=p_job;
  for a in select value from jsonb_array_elements(coalesce(p_state->'allocations','[]'::jsonb)) loop
    if exists(select 1 from dispatch_supply_lots l where l.org_id=p_org and l.id=a->>'supply_id' and l.source_ref->>'kind'='purchase_order_line'
      and (l.id is distinct from 'po:'||(l.source_ref->>'po_id')::uuid::text||':'||(l.source_ref->>'index')::integer::text or (l.source_ref->>'index')::integer<0))
    then raise exception 'noncanonical_supply_identity' using errcode='40001'; end if;
    if not exists(select 1 from dispatch_supply_lots where org_id=p_org and id=a->>'supply_id' and unit=a->>'unit') then raise exception 'supply_unit_mismatch'; end if;
    select quantity into cap from dispatch_supply_lots where org_id=p_org and id=a->>'supply_id';
    if not found then raise exception 'supply_unverified'; end if;
    select coalesce(sum(quantity),0) into used from dispatch_reservations where org_id=p_org and supply_id=a->>'supply_id';
    if used+(a->>'quantity')::numeric > cap then raise exception 'supply_overallocated' using errcode='40001'; end if;
    insert into dispatch_reservations(org_id,job_id,id,requirement_id,supply_id,quantity)
      values(p_org,p_job,(a->>'id')::uuid,(a->>'requirement_id')::uuid,a->>'supply_id',(a->>'quantity')::numeric);
  end loop;
  if p_command='order_prepare' then
    for draft in select value from jsonb_array_elements(coalesce(p_state->'order_drafts','[]'::jsonb)) where value->>'id'=p_state->>'prepared_order_id' loop
      order_id=(draft->>'id')::uuid;
      if exists(select 1 from purchase_orders where id=order_id and (org_id<>p_org or job_id<>p_job or status<>'draft' or reference is distinct from 'dispatch:'||order_id::text or xero_po_id is not null)) then raise exception 'order_not_editable'; end if;
      insert into purchase_orders(id,org_id,job_id,po_number,supplier_name,xero_contact_id,status,line_items,subtotal,tax,total,delivery_date,reference,notes)
        values(order_id,p_org,p_job,'PO-D-'||order_id::text,draft->>'supplier_name',draft->>'xero_contact_id','draft',draft->'line_items',null,null,null,(draft->>'delivery_date')::date,'dispatch:'||order_id::text,draft->>'po_notes')
      on conflict(id) do update set supplier_name=excluded.supplier_name,xero_contact_id=excluded.xero_contact_id,line_items=excluded.line_items,delivery_date=excluded.delivery_date,notes=excluded.notes,subtotal=null,tax=null,total=null,updated_at=now();
    end loop;
  end if;
  p_source=dispatch_source_version(p_org,p_job);
  update dispatch_plans set version=version+1,state=p_state,source_version=p_source,updated_at=now()
    where org_id=p_org and job_id=p_job returning * into plan;
  result=jsonb_build_object('version',plan.version,'source_version',p_source,'state',p_state,'live_actions_enabled',false);
  insert into dispatch_commands(org_id,request_id,job_id,request_hash,actor,command,result)
    values(p_org,p_request,p_job,p_hash,p_actor,p_command,result);
  if p_command<>'assess' then
  insert into business_events(event_type,source,entity_type,entity_id,correlation_id,job_id,match_status,match_method,payload,metadata)
    values('dispatch.plan.changed','ops-api','dispatch_plan',p_job::text,p_request,p_job::text,
      'matched','direct_job_id',
      jsonb_build_object('contract_version','dispatch-context/v1','org_id',p_org,'job_id',p_job,'plan_version',plan.version,'source_version',p_source,'command',p_command,'state',p_state),
      jsonb_build_object('source_ref',jsonb_build_object('table','dispatch_plans','org_id',p_org,'job_id',p_job,'version',plan.version),'evidence_role','human_working_state','provider_action',false,'derivation',jsonb_build_object('owner','dispatch','event_id',p_request,'plan_version',plan.version)));
  end if;
  return result;
end $$;
revoke all on function public.dispatch_commit(uuid,uuid,bigint,uuid,text,text,text,text,jsonb,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.dispatch_commit(uuid,uuid,bigint,uuid,text,text,text,text,jsonb,jsonb,jsonb) to service_role;

create function public.dispatch_enqueue_job(p_org uuid,p_job uuid,p_reason text default 'manual')
returns jsonb language plpgsql security invoker set search_path=public,pg_temp as $$
declare source text; plan_rev bigint; task_row dispatch_tasks; inserted integer;
begin
  if not exists(select 1 from jobs where id=p_job and org_id=p_org) then raise exception 'job_not_found'; end if;
  source=dispatch_source_version(p_org,p_job);
  if source is null then raise exception 'source_unavailable'; end if;
  select coalesce(version,0) into plan_rev from dispatch_plans where org_id=p_org and job_id=p_job;
  if plan_rev is null then plan_rev=0; end if;
  if exists(select 1 from dispatch_plans where org_id=p_org and job_id=p_job and state#>>'{assessment,source_version}'=source and coalesce((state#>>'{assessment,stale}')::boolean,false)=false) then
    return jsonb_build_object('queued',false,'job_id',p_job,'source_version',source,'plan_version',plan_rev,'reason','assessment_current');
  end if;
  insert into dispatch_tasks(org_id,job_id,source_version,plan_version)
    values(p_org,p_job,source,plan_rev)
  on conflict(org_id,job_id,source_version,plan_version) do update set
    status=case
      when dispatch_tasks.status='done' then 'done'
      when dispatch_tasks.attempts>=5 then 'exhausted'
      else 'pending'
    end,
    available_at=case when dispatch_tasks.status='done' or dispatch_tasks.attempts>=5 then dispatch_tasks.available_at else now() end,
    lease_until=case when dispatch_tasks.status='done' or dispatch_tasks.attempts>=5 then dispatch_tasks.lease_until else null end,
    lease_token=case when dispatch_tasks.status='done' or dispatch_tasks.attempts>=5 then dispatch_tasks.lease_token else null end,
    updated_at=now()
  where not (dispatch_tasks.status='running' and dispatch_tasks.lease_until>now());
  get diagnostics inserted = row_count;
  select * into task_row from dispatch_tasks where org_id=p_org and job_id=p_job and source_version=source and plan_version=plan_rev;
  update dispatch_task_source_failures set status='resolved',resolved_at=now(),updated_at=now() where org_id=p_org and job_id=p_job and status='deferred';
  return jsonb_build_object('queued',task_row.status in ('pending','running'),'job_id',p_job,'source_version',source,'plan_version',plan_rev,'status',task_row.status,'reason',case when task_row.status='exhausted' then 'task_exhausted' when task_row.status='done' then 'already_done' else p_reason end);
end $$;
revoke all on function public.dispatch_enqueue_job(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.dispatch_enqueue_job(uuid,uuid,text) to service_role;

create function public.dispatch_enqueue_from_business_event(p_event_id uuid)
returns jsonb language plpgsql security invoker set search_path=public,pg_temp as $$
declare e business_events; target_job uuid; payload_job uuid; target_org uuid;
begin
  select * into e from business_events where id=p_event_id;
  if not found then raise exception 'business_event_not_found'; end if;
  if dispatch_is_own_plan_source(e.id,to_jsonb(e),null) then return jsonb_build_object('queued',false,'reason','dispatch_echo'); end if;
  if e.match_status is not null and e.match_status<>'matched' then return jsonb_build_object('queued',false,'reason','unmatched_source'); end if;
  begin
    target_job=nullif(e.job_id,'')::uuid;
    payload_job=nullif(e.payload->>'job_id','')::uuid;
  exception when invalid_text_representation then return jsonb_build_object('queued',false,'reason','invalid_job_id'); end;
  if target_job is not null and payload_job is not null and target_job<>payload_job then return jsonb_build_object('queued',false,'reason','job_id_mismatch'); end if;
  target_job=coalesce(target_job,payload_job);
  if target_job is null then return jsonb_build_object('queued',false,'reason','missing_job_id'); end if;
  select org_id into target_org from jobs where id=target_job;
  if target_org is null then return jsonb_build_object('queued',false,'reason','job_not_found'); end if;
  if (e.metadata->>'org_id' is not null and e.metadata->>'org_id'<>target_org::text)
    or (e.payload->>'org_id' is not null and e.payload->>'org_id'<>target_org::text)
    or (e.metadata#>>'{source_ref,org_id}' is not null and e.metadata#>>'{source_ref,org_id}'<>target_org::text)
    or (e.payload#>>'{source_ref,org_id}' is not null and e.payload#>>'{source_ref,org_id}'<>target_org::text)
  then return jsonb_build_object('queued',false,'reason','org_mismatch'); end if;
  return dispatch_enqueue_job(target_org,target_job,'business_event:'||p_event_id::text);
end $$;
revoke all on function public.dispatch_enqueue_from_business_event(uuid) from public,anon,authenticated;
grant execute on function public.dispatch_enqueue_from_business_event(uuid) to service_role;

create function public.dispatch_business_event_enqueue_trigger()
returns trigger language plpgsql security invoker set search_path=public,pg_temp as $$
begin
  perform dispatch_enqueue_from_business_event(new.id);
  return new;
exception when others then
  raise warning 'dispatch business_event enqueue failed for %: %', new.id, sqlerrm;
  return new;
end $$;
revoke all on function public.dispatch_business_event_enqueue_trigger() from public,anon,authenticated;
create trigger dispatch_business_events_enqueue after insert on public.business_events
for each row execute function public.dispatch_business_event_enqueue_trigger();

create function public.dispatch_reconcile_eligible_jobs(p_org uuid,p_limit integer default 25)
returns jsonb language plpgsql security invoker set search_path=public,pg_temp as $$
declare cursor_id uuid; job_ids uuid[]; jid uuid; queued jsonb='[]'::jsonb; failures jsonb='[]'::jsonb; limit_n integer; wrapped boolean=false; item jsonb; err text;
begin
  limit_n=greatest(1,least(coalesce(p_limit,25),25));
  insert into dispatch_reconcile_cursors(org_id,name) values(p_org,'eligible_jobs') on conflict do nothing;
  select cursor_job_id into cursor_id from dispatch_reconcile_cursors where org_id=p_org and name='eligible_jobs' for update;
  select coalesce(array_agg(id order by id),'{}'::uuid[]) into job_ids from (
    select id from dispatch_eligible_jobs where org_id=p_org and (cursor_id is null or id>cursor_id) order by id limit limit_n
  ) s;
  if coalesce(array_length(job_ids,1),0)=0 and cursor_id is not null then
    wrapped=true;
    select coalesce(array_agg(id order by id),'{}'::uuid[]) into job_ids from (
      select id from dispatch_eligible_jobs where org_id=p_org order by id limit limit_n
    ) s;
  end if;
  foreach jid in array job_ids loop
    begin
      item=dispatch_enqueue_job(p_org,jid,'eligible_reconcile');
      queued=queued||item;
    exception when others then
      err=sqlerrm;
      insert into dispatch_task_source_failures(org_id,job_id,status,attempts,last_error,last_failed_at,updated_at)
        values(p_org,jid,'deferred',1,err,now(),now())
      on conflict(org_id,job_id) do update set
        status='deferred',
        attempts=dispatch_task_source_failures.attempts+1,
        last_error=excluded.last_error,
        last_failed_at=now(),
        resolved_at=null,
        updated_at=now();
      item=jsonb_build_object('queued',false,'job_id',jid,'status','deferred','reason','source_unavailable','error',err);
      queued=queued||item;
      failures=failures||item;
    end;
  end loop;
  update dispatch_reconcile_cursors set cursor_job_id=case when coalesce(array_length(job_ids,1),0)=0 then cursor_id else job_ids[array_length(job_ids,1)] end,updated_at=now() where org_id=p_org and name='eligible_jobs';
  return jsonb_build_object('queued',queued,'count',coalesce(array_length(job_ids,1),0),'failures',failures,'failure_count',jsonb_array_length(failures),'cursor_job_id',(select cursor_job_id from dispatch_reconcile_cursors where org_id=p_org and name='eligible_jobs'),'wrapped',wrapped,'live_actions_enabled',false);
end $$;
revoke all on function public.dispatch_reconcile_eligible_jobs(uuid,integer) from public,anon,authenticated;
grant execute on function public.dispatch_reconcile_eligible_jobs(uuid,integer) to service_role;

create function public.dispatch_claim_tasks(p_org uuid,p_limit integer default 10)
returns setof public.dispatch_tasks language plpgsql security invoker set search_path=public,pg_temp as $$
begin
  update dispatch_tasks set status='exhausted',lease_until=null,lease_token=null,updated_at=now()
  where org_id=p_org and attempts>=5 and (status in ('pending','failed','deferred') or (status='running' and lease_until<now()));
  return query update dispatch_tasks set status='running',lease_token=gen_random_uuid(),attempts=attempts+1,lease_until=now()+interval '2 minutes',updated_at=now()
  where (dispatch_tasks.org_id,dispatch_tasks.job_id,dispatch_tasks.source_version,dispatch_tasks.plan_version) in (
    select org_id,job_id,source_version,plan_version from dispatch_tasks
    where org_id=p_org and available_at<=now() and attempts<5
      and (status in ('pending','failed','deferred') or (status='running' and lease_until<now()))
    order by available_at for update skip locked limit greatest(1,least(p_limit,25))
  ) returning *;
end $$;
revoke all on function public.dispatch_claim_tasks(uuid,integer) from public,anon,authenticated;
grant execute on function public.dispatch_claim_tasks(uuid,integer) to service_role;

create function public.dispatch_finalize_task(p_org uuid,p_job uuid,p_source_version text,p_plan_version bigint,p_lease_token uuid,p_status text,p_result jsonb default '{}'::jsonb,p_error text default null,p_available_at timestamptz default null)
returns jsonb language plpgsql security invoker set search_path=public,pg_temp as $$
declare task_row dispatch_tasks; next_status text;
begin
  if p_status not in ('done','failed','deferred') then raise exception 'invalid_task_status'; end if;
  select * into task_row from dispatch_tasks where org_id=p_org and job_id=p_job and source_version=p_source_version and plan_version=p_plan_version and lease_token=p_lease_token and status='running' and lease_until>now() for update;
  if not found then raise exception 'task_lease_lost' using errcode='40001'; end if;
  next_status=case when p_status='failed' and task_row.attempts>=5 then 'exhausted' else p_status end;
  update dispatch_tasks set status=next_status,result=p_result,last_error=p_error,lease_until=null,lease_token=null,available_at=coalesce(p_available_at,case when next_status in ('failed','deferred') then now()+interval '1 minute' else available_at end),updated_at=now()
    where org_id=p_org and job_id=p_job and source_version=p_source_version and plan_version=p_plan_version
    returning * into task_row;
  return to_jsonb(task_row);
end $$;
revoke all on function public.dispatch_finalize_task(uuid,uuid,text,bigint,uuid,text,jsonb,text,timestamptz) from public,anon,authenticated;
grant execute on function public.dispatch_finalize_task(uuid,uuid,text,bigint,uuid,text,jsonb,text,timestamptz) to service_role;

create function public.dispatch_list_tasks(p_org uuid,p_status text default null,p_limit integer default 25,p_offset integer default 0)
returns jsonb language sql stable security invoker set search_path=public,pg_temp as $$
  with bounds as (
    select greatest(1,least(coalesce(p_limit,25),100)) as limit_n, greatest(0,coalesce(p_offset,0)) as offset_n
  ), task_page as (
      select * from dispatch_tasks
      where org_id=p_org and (p_status is null or status=p_status)
      order by updated_at desc,job_id,source_version,plan_version
      limit (select limit_n+1 from bounds)
      offset (select offset_n from bounds)
  ), failure_page as (
      select * from dispatch_task_source_failures
      where org_id=p_org and (p_status is null or status=p_status)
      order by updated_at desc,job_id
      limit (select limit_n+1 from bounds)
      offset (select offset_n from bounds)
  )
  select jsonb_build_object(
    'items',coalesce((select jsonb_agg(to_jsonb(t) order by t.updated_at desc,t.job_id,t.source_version,t.plan_version) from (select * from task_page order by updated_at desc,job_id,source_version,plan_version limit (select limit_n from bounds)) t),'[]'::jsonb),
    'has_more',((select count(*) from task_page)>(select limit_n from bounds)),
    'next_offset',case when (select count(*) from task_page)>(select limit_n from bounds) then (select offset_n+limit_n from bounds) else null end,
    'source_failures',coalesce((select jsonb_agg(to_jsonb(f) order by f.updated_at desc,f.job_id) from (select * from failure_page order by updated_at desc,job_id limit (select limit_n from bounds)) f),'[]'::jsonb),
    'source_failures_has_more',((select count(*) from failure_page)>(select limit_n from bounds)),
    'source_failures_next_offset',case when (select count(*) from failure_page)>(select limit_n from bounds) then (select offset_n+limit_n from bounds) else null end,
    'limit',(select limit_n from bounds),
    'offset',(select offset_n from bounds),
    'live_actions_enabled',false
  );
$$;
revoke all on function public.dispatch_list_tasks(uuid,text,integer,integer) from public,anon,authenticated;
grant execute on function public.dispatch_list_tasks(uuid,text,integer,integer) to service_role;

create function public.dispatch_retry_task(p_org uuid,p_job uuid,p_source_version text default null,p_plan_version bigint default null,p_request uuid default gen_random_uuid(),p_actor text default 'system',p_reason text default null)
returns jsonb language plpgsql security invoker set search_path=public,pg_temp as $$
declare prior dispatch_task_retry_audit; request_hash text; task_row dispatch_tasks; result jsonb; err text;
begin
  perform pg_advisory_xact_lock(hashtextextended('dispatch:'||p_org::text,0));
  if not exists(select 1 from jobs where id=p_job and org_id=p_org) then raise exception 'job_not_found'; end if;
  request_hash=md5(jsonb_build_object('job_id',p_job,'source_version',p_source_version,'plan_version',p_plan_version,'reason',p_reason)::text);
  select * into prior from dispatch_task_retry_audit where org_id=p_org and request_id=p_request;
  if found then
    if prior.request_hash<>request_hash or prior.job_id<>p_job then raise exception 'idempotency_conflict' using errcode='40001'; end if;
    return prior.result;
  end if;
  if p_source_version is null or p_plan_version is null then
    begin
      result=dispatch_enqueue_job(p_org,p_job,coalesce(p_reason,'manual_retry'));
    exception when others then
      err=sqlerrm;
      insert into dispatch_task_source_failures(org_id,job_id,status,attempts,last_error,last_failed_at,updated_at)
        values(p_org,p_job,'deferred',1,err,now(),now())
      on conflict(org_id,job_id) do update set
        status='deferred',
        attempts=dispatch_task_source_failures.attempts+1,
        last_error=excluded.last_error,
        last_failed_at=now(),
        resolved_at=null,
        updated_at=now();
      result=jsonb_build_object('retried',false,'queued',false,'job_id',p_job,'status','deferred','reason','source_unavailable','error',err,'live_actions_enabled',false);
    end;
    insert into dispatch_task_retry_audit(org_id,request_id,job_id,source_version,plan_version,request_hash,actor,reason,result)
      values(p_org,p_request,p_job,p_source_version,p_plan_version,request_hash,p_actor,p_reason,result);
    return result;
  end if;
  select * into task_row from dispatch_tasks where org_id=p_org and job_id=p_job and source_version=p_source_version and plan_version=p_plan_version for update;
  if not found then raise exception 'task_not_found'; end if;
  if task_row.status='done' then
    result=jsonb_build_object('retried',false,'reason','already_done','task',to_jsonb(task_row),'live_actions_enabled',false);
  elsif task_row.status='running' and task_row.lease_until>now() then
    result=jsonb_build_object('retried',false,'reason','lease_active','task',to_jsonb(task_row),'live_actions_enabled',false);
  else
    update dispatch_tasks set status='pending',attempts=0,available_at=now(),lease_until=null,lease_token=null,last_error=null,updated_at=now()
      where org_id=p_org and job_id=p_job and source_version=p_source_version and plan_version=p_plan_version
      returning * into task_row;
    result=jsonb_build_object('retried',true,'task',to_jsonb(task_row),'live_actions_enabled',false);
  end if;
  insert into dispatch_task_retry_audit(org_id,request_id,job_id,source_version,plan_version,request_hash,actor,reason,result)
    values(p_org,p_request,p_job,p_source_version,p_plan_version,request_hash,p_actor,p_reason,result);
  return result;
end $$;
revoke all on function public.dispatch_retry_task(uuid,uuid,text,bigint,uuid,text,text) from public,anon,authenticated;
grant execute on function public.dispatch_retry_task(uuid,uuid,text,bigint,uuid,text,text) to service_role;

-- Population does not depend on deposits, an order or an installation date.
create view public.dispatch_eligible_jobs with (security_invoker=true) as
select j.*,
  case when j.accepted_at is not null or exists(select 1 from job_documents d where d.job_id=j.id and d.type='quote' and d.accepted_at is not null and d.superseded_at is null)
    then 'accepted' else 'unresolved' end as dispatch_eligibility
from jobs j
where j.status not in ('archived','cancelled','deleted') and (
 j.accepted_at is not null
 or exists(select 1 from job_documents d where d.job_id=j.id and d.type='quote' and d.accepted_at is not null and d.superseded_at is null)
 or j.status in ('partially_accepted','accepted','deposit','awaiting_deposit','approvals','order_materials','processing','awaiting_supplier','order_confirmed','schedule_install','scheduled','in_progress','rectification','complete','final_payment','invoiced','get_review')
);
revoke all on public.dispatch_eligible_jobs from anon,authenticated;
grant select on public.dispatch_eligible_jobs to service_role;

create table public.dispatch_release_controls(org_id uuid primary key,communications_enabled boolean not null default false);
create table public.dispatch_executions(
 org_id uuid not null, id uuid not null, job_id uuid not null, draft_id uuid not null,
 content_hash text not null,source_version text not null,snapshot jsonb not null,
 status text not null check(status in ('claimed','provider_draft_ready','accepted_not_delivered','outcome_unknown','not_sent')),
 receipt jsonb, last_error text, created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
 primary key(org_id,id)
);
alter table public.dispatch_release_controls enable row level security;
alter table public.dispatch_executions enable row level security;
revoke all on public.dispatch_release_controls,public.dispatch_executions from anon,authenticated;
grant all on public.dispatch_release_controls,public.dispatch_executions to service_role;
create function public.dispatch_claim_execution(p_org uuid,p_job uuid,p_draft uuid,p_approval uuid,p_hash text,p_source text)
returns jsonb language plpgsql security invoker set search_path=public,pg_temp as $$
declare d jsonb; prior dispatch_executions;
begin
 perform pg_advisory_xact_lock(hashtextextended('dispatch:'||p_org::text,0));
 select * into prior from dispatch_executions where org_id=p_org and id=p_approval;
 if found then return jsonb_build_object('claimed',false,'action',to_jsonb(prior)); end if;
 if not exists(select 1 from dispatch_release_controls where org_id=p_org and communications_enabled) then return jsonb_build_object('claimed',false,'action',jsonb_build_object('id',p_approval,'status','held')); end if;
 select value into d from dispatch_plans p cross join lateral jsonb_array_elements(p.state->'drafts')
 where p.org_id=p_org and p.job_id=p_job and value->>'id'=p_draft::text;
 if d is null or d->>'content_hash' is distinct from p_hash or d#>>'{approval,id}' is distinct from p_approval::text
   or d#>>'{approval,content_hash}' is distinct from p_hash or d#>>'{approval,source_version}' is distinct from p_source
   or d#>>'{approval,communications_approved}' is distinct from 'true'
   or ((d->>'po_id' is not null or d->>'purchase_commitment' is distinct from 'false') and d#>>'{approval,purchase_approved}' is distinct from 'true')
   or dispatch_source_version(p_org,p_job) is distinct from p_source
 then raise exception 'draft_approval_changed' using errcode='40001'; end if;
 if exists(select 1 from dispatch_executions where org_id=p_org and draft_id=p_draft and status in ('claimed','provider_draft_ready','sending','accepted_not_delivered','outcome_unknown')) then raise exception 'draft_already_executed_or_uncertain' using errcode='40001'; end if;
 insert into dispatch_executions(org_id,id,job_id,draft_id,content_hash,source_version,snapshot,status)
 values(p_org,p_approval,p_job,p_draft,p_hash,p_source,d,'claimed') returning * into prior;
 return jsonb_build_object('claimed',true,'action',to_jsonb(prior));
end $$;
revoke all on function public.dispatch_claim_execution(uuid,uuid,uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function public.dispatch_claim_execution(uuid,uuid,uuid,uuid,text,text) to service_role;

alter table public.dispatch_executions drop constraint dispatch_executions_status_check;
alter table public.dispatch_executions add constraint dispatch_executions_status_check check(status in ('claimed','provider_draft_ready','sending','accepted_not_delivered','outcome_unknown','not_sent'));
create function public.dispatch_begin_send(p_org uuid,p_action uuid)
returns jsonb language plpgsql security invoker set search_path=public,pg_temp as $$
declare a dispatch_executions; d jsonb;
begin
 perform pg_advisory_xact_lock(hashtextextended('dispatch:'||p_org::text,0));
 select * into a from dispatch_executions where org_id=p_org and id=p_action for update;
 if not found or a.status not in ('provider_draft_ready','sending') then return jsonb_build_object('allowed',false,'reason','not_ready');end if;
 select value into d from dispatch_plans p cross join lateral jsonb_array_elements(p.state->'drafts') where p.org_id=p_org and p.job_id=a.job_id and value->>'id'=a.draft_id::text;
 if not exists(select 1 from dispatch_release_controls where org_id=p_org and communications_enabled)
 or d->>'content_hash' is distinct from a.content_hash
 or d->'approval' is distinct from a.snapshot->'approval'
 or ((d->>'po_id' is not null or d->>'purchase_commitment' is distinct from 'false') and d#>>'{approval,purchase_approved}' is distinct from 'true')
 or dispatch_source_version(p_org,a.job_id) is distinct from a.source_version then
  update dispatch_executions set status='not_sent',last_error='Approval, source or release changed during preparation',updated_at=now() where org_id=p_org and id=p_action;
  return jsonb_build_object('allowed',false,'reason','approval_source_or_release_changed');
 end if;
 update dispatch_executions set status='sending',updated_at=now() where org_id=p_org and id=p_action;
 return jsonb_build_object('allowed',true);
end $$;
revoke all on function public.dispatch_begin_send(uuid,uuid) from public,anon,authenticated;
grant execute on function public.dispatch_begin_send(uuid,uuid) to service_role;

create function public.dispatch_record_execution_readback(p_org uuid,p_action uuid,p_expected_status text,p_expected_receipt jsonb,p_expected_source text,p_readback jsonb)
returns jsonb language plpgsql security invoker set search_path=public,pg_temp as $$
declare a dispatch_executions; merged jsonb; next_status text; sent_exact boolean;
begin
 perform pg_advisory_xact_lock(hashtextextended('dispatch:'||p_org::text,0));
 select * into a from dispatch_executions where org_id=p_org and id=p_action for update;
 if not found then return jsonb_build_object('recorded',false,'reason','not_found','readback_required',true); end if;
 if a.status is distinct from p_expected_status or a.receipt is distinct from p_expected_receipt or a.source_version is distinct from p_expected_source then
  return jsonb_build_object('recorded',false,'reason','stale_action','action',to_jsonb(a),'readback_required',a.status='outcome_unknown');
 end if;
 merged=coalesce(a.receipt,'{}'::jsonb)||jsonb_build_object('readback',p_readback);
 sent_exact=a.status='outcome_unknown'
  and p_readback->>'verified'='true'
  and p_readback->>'is_draft'='false'
  and p_readback->>'id'=a.receipt->>'draft_id'
  and coalesce(p_readback->>'sent_at','')<>'';
 next_status=case when sent_exact then 'accepted_not_delivered' else a.status end;
 update dispatch_executions set status=next_status,receipt=merged,updated_at=now(),last_error=case when sent_exact then null else last_error end where org_id=p_org and id=p_action returning * into a;
 return jsonb_build_object('recorded',true,'action',to_jsonb(a),'readback_required',a.status='outcome_unknown');
end $$;
revoke all on function public.dispatch_record_execution_readback(uuid,uuid,text,jsonb,text,jsonb) from public,anon,authenticated;
grant execute on function public.dispatch_record_execution_readback(uuid,uuid,text,jsonb,text,jsonb) to service_role;
