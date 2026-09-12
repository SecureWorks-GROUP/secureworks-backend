\set ON_ERROR_STOP on
do $$ begin if not exists(select 1 from pg_roles where rolname='anon') then create role anon; create role authenticated; create role service_role bypassrls; end if; end $$;
create table jobs(id uuid primary key,org_id uuid,status text,accepted_at timestamptz,scope_json jsonb,pricing_json jsonb,site_address text,scheduled_at timestamptz);
create table job_documents(id uuid primary key,job_id uuid references jobs,type text,accepted_at timestamptz,superseded_at timestamptz);
create table purchase_orders(id uuid primary key,org_id uuid,job_id uuid references jobs,line_items jsonb,status text,po_number text,supplier_name text,xero_contact_id text,subtotal numeric,tax numeric,total numeric,delivery_date date,reference text,notes text,xero_po_id text,updated_at timestamptz);
create table current_job_context_facts(id uuid primary key,job_id uuid references jobs,kind text,value jsonb,provenance jsonb);
create table po_communications(id uuid primary key,job_id uuid references jobs);
create table job_media(id uuid primary key,job_id uuid references jobs);
create table job_assignments(id uuid primary key,job_id uuid references jobs);
grant all on po_communications,job_media,job_assignments to service_role;
grant all on jobs,job_documents,purchase_orders,current_job_context_facts to service_role;
insert into jobs(id,org_id,status,accepted_at,scope_json,pricing_json) values('10000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001','accepted',now(),'{}','{}'),('10000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000001','scheduled',null,'{}','{}'),('10000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000002','accepted',now(),'{}','{}');

create table business_events(id uuid primary key default gen_random_uuid(),event_type text,source text,entity_type text,entity_id text,correlation_id uuid,job_id text,payload jsonb,metadata jsonb);
grant all on business_events to service_role;
