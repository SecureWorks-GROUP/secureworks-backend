\set ON_ERROR_STOP on
do $$ begin
  if not exists(select 1 from pg_roles where rolname='anon') or not exists(select 1 from pg_roles where rolname='authenticated') or not exists(select 1 from pg_roles where rolname='service_role') then
    raise exception 'required Supabase roles missing';
  end if;
end $$;
create table jobs(id uuid primary key,org_id uuid,status text,accepted_at timestamptz,scope_json jsonb,pricing_json jsonb,site_address text,scheduled_at timestamptz);
create table job_documents(id uuid primary key,job_id uuid references jobs,type text,accepted_at timestamptz,superseded_at timestamptz);
create table purchase_orders(id uuid primary key,org_id uuid,job_id uuid references jobs,line_items jsonb,status text,po_number text,supplier_name text,xero_contact_id text,subtotal numeric,tax numeric,total numeric,delivery_date date,reference text,notes text,xero_po_id text,updated_at timestamptz);
create table job_context(id uuid primary key,job_id uuid references jobs,kind text,value jsonb,provenance jsonb,correlation_id uuid,created_at timestamptz not null default now(),updated_at timestamptz not null default now());
create table job_temporary_context(id uuid primary key,job_id uuid references jobs,kind text,value jsonb,provenance jsonb,correlation_id uuid,expires_at timestamptz not null,created_at timestamptz not null default now(),updated_at timestamptz not null default now());
create table contact_matches(id uuid primary key default gen_random_uuid(),ghl_contact_id text,job_id uuid references jobs);
\if :{?APPLY_LUNA}
\else
create view current_job_context_facts as
select id,job_id,kind,value,provenance,correlation_id,created_at,updated_at,null::timestamptz as expires_at,'job_context'::text as _context_store from job_context
union all
select id,job_id,kind,value,provenance,correlation_id,created_at,updated_at,expires_at,'job_temporary_context'::text as _context_store from job_temporary_context where expires_at>now();
\endif
create table po_communications(id uuid primary key,job_id uuid references jobs);
create table job_media(id uuid primary key,job_id uuid references jobs);
create table job_assignments(id uuid primary key,job_id uuid references jobs);
grant all on po_communications,job_media,job_assignments to service_role;
grant all on jobs,job_documents,purchase_orders,job_context,job_temporary_context,contact_matches to service_role;
\if :{?APPLY_LUNA}
\else
grant all on current_job_context_facts to service_role;
\endif
insert into jobs(id,org_id,status,accepted_at,scope_json,pricing_json) values('10000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001','accepted',now(),'{}','{}'),('10000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000001','scheduled',null,'{}','{}'),('10000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000002','accepted',now(),'{}','{}');

create table business_events(id uuid primary key default gen_random_uuid(),event_type text,source text,entity_type text,entity_id text,correlation_id uuid,job_id text,match_status text,match_method text,payload jsonb,metadata jsonb,occurred_at timestamptz not null default now());
grant all on business_events to service_role;
