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
  status text not null default 'pending' check(status in ('pending','running','done','failed')),
  attempts integer not null default 0,
  available_at timestamptz not null default now(),
  lease_until timestamptz,
  lease_token uuid,
  last_error text,
  updated_at timestamptz not null default now(),
  primary key(org_id,job_id,source_version,plan_version)
);
create index dispatch_tasks_due on public.dispatch_tasks(org_id,status,available_at);
alter table public.dispatch_plans enable row level security;
alter table public.dispatch_commands enable row level security;
alter table public.dispatch_supply_lots enable row level security;
alter table public.dispatch_reservations enable row level security;
alter table public.dispatch_tasks enable row level security;
revoke all on public.dispatch_plans, public.dispatch_commands, public.dispatch_supply_lots, public.dispatch_reservations, public.dispatch_tasks from anon, authenticated;
grant all on public.dispatch_plans, public.dispatch_commands, public.dispatch_supply_lots, public.dispatch_reservations, public.dispatch_tasks to service_role;

-- Database-owned revision covers source owners; Dispatch never edits these tables.
create function public.dispatch_source_version(p_org uuid,p_job uuid)
returns text language sql stable security invoker set search_path=public,pg_temp as $$
 select md5(jsonb_build_object(
 'job',jsonb_build_object('scope',j.scope_json,'pricing',j.pricing_json,'accepted',j.accepted_at,'status',j.status,'address',j.site_address,'scheduled',j.scheduled_at),
 'purchase_orders',(select coalesce(jsonb_agg(to_jsonb(p) order by p.id),'[]') from purchase_orders p where p.job_id=j.id),
 'documents',(select coalesce(jsonb_agg(to_jsonb(d) order by d.id),'[]') from job_documents d where d.job_id=j.id),
 'communications',(select coalesce(jsonb_agg(to_jsonb(c) order by c.id),'[]') from po_communications c where c.job_id=j.id),
 'media',(select coalesce(jsonb_agg(to_jsonb(m) order by m.id),'[]') from job_media m where m.job_id=j.id),
 'assignments',(select coalesce(jsonb_agg(to_jsonb(a) order by a.id),'[]') from job_assignments a where a.job_id=j.id),
 'context',(select coalesce(jsonb_agg(to_jsonb(c) order by c.id),'[]') from current_job_context_facts c where c.job_id=j.id)
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
  for lot in select value from jsonb_array_elements(p_lots) loop
    if lot#>>'{source_ref,kind}'='purchase_order_line' and not exists(
      select 1 from purchase_orders where id=(lot#>>'{source_ref,po_id}')::uuid and org_id=p_org
      and status in ('submitted','authorised','billed')
      and line_items->(lot#>>'{source_ref,index}')::integer = lot->'source_snapshot'
    ) then raise exception 'supply_source_changed' using errcode='40001'; end if;
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
  for a in select value from jsonb_array_elements(p_state->'allocations') loop
    if not exists(select 1 from dispatch_supply_lots where org_id=p_org and id=a->>'supply_id' and unit=a->>'unit') then raise exception 'supply_unit_mismatch'; end if;
    select quantity into cap from dispatch_supply_lots where org_id=p_org and id=a->>'supply_id';
    if not found then raise exception 'supply_unverified'; end if;
    select coalesce(sum(quantity),0) into used from dispatch_reservations where org_id=p_org and supply_id=a->>'supply_id';
    if used+(a->>'quantity')::numeric > cap then raise exception 'supply_overallocated' using errcode='40001'; end if;
    insert into dispatch_reservations(org_id,job_id,id,requirement_id,supply_id,quantity)
      values(p_org,p_job,(a->>'id')::uuid,(a->>'requirement_id')::uuid,a->>'supply_id',(a->>'quantity')::numeric);
  end loop;
  if p_command='order_prepare' then
    for draft in select value from jsonb_array_elements(p_state->'order_drafts') where value->>'id'=p_state->>'prepared_order_id' loop
      order_id=(draft->>'id')::uuid;
      if exists(select 1 from purchase_orders where id=order_id and (org_id<>p_org or job_id<>p_job or status<>'draft' or reference is distinct from 'dispatch:'||order_id::text or xero_po_id is not null)) then raise exception 'order_not_editable'; end if;
      insert into purchase_orders(id,org_id,job_id,po_number,supplier_name,xero_contact_id,status,line_items,subtotal,tax,total,delivery_date,reference,notes)
        values(order_id,p_org,p_job,'PO-D-'||order_id::text,draft->>'supplier_name',draft->>'xero_contact_id','draft',draft->'line_items',null,null,null,(draft->>'delivery_date')::date,'dispatch:'||order_id::text,'Delivery: '||(draft->>'delivery_address')||E'\n'||coalesce(draft->>'notes',''))
      on conflict(id) do update set supplier_name=excluded.supplier_name,line_items=excluded.line_items,delivery_date=excluded.delivery_date,notes=excluded.notes,subtotal=null,tax=null,total=null,updated_at=now();
    end loop;
    p_source=dispatch_source_version(p_org,p_job);
  end if;
  update dispatch_plans set version=version+1,state=p_state,source_version=p_source,updated_at=now()
    where org_id=p_org and job_id=p_job returning * into plan;
  result=jsonb_build_object('version',plan.version,'source_version',p_source,'state',p_state,'live_actions_enabled',false);
  insert into dispatch_commands(org_id,request_id,job_id,request_hash,actor,command,result)
    values(p_org,p_request,p_job,p_hash,p_actor,p_command,result);
  return result;
end $$;
revoke all on function public.dispatch_commit(uuid,uuid,bigint,uuid,text,text,text,text,jsonb,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.dispatch_commit(uuid,uuid,bigint,uuid,text,text,text,text,jsonb,jsonb,jsonb) to service_role;

create function public.dispatch_claim_tasks(p_org uuid,p_limit integer default 10)
returns setof public.dispatch_tasks language sql security invoker set search_path=public,pg_temp as $$
  update dispatch_tasks set status='running',lease_token=gen_random_uuid(),attempts=attempts+1,lease_until=now()+interval '2 minutes',updated_at=now()
  where (org_id,job_id,source_version,plan_version) in (
    select org_id,job_id,source_version,plan_version from dispatch_tasks
    where org_id=p_org and available_at<=now() and attempts<5
      and (status in ('pending','failed') or (status='running' and lease_until<now()))
    order by available_at for update skip locked limit greatest(1,least(p_limit,25))
  ) returning *;
$$;
revoke all on function public.dispatch_claim_tasks(uuid,integer) from public,anon,authenticated;
grant execute on function public.dispatch_claim_tasks(uuid,integer) to service_role;

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
