-- ============================================================
-- SecureWorks WA — Supabase Schema
-- Migration 001: Core tables, RLS, storage buckets
-- ============================================================

-- Enable UUID generation
create extension if not exists "uuid-ossp";

-- ────────────────────────────────────────────────────────────
-- ORGANISATIONS
-- ────────────────────────────────────────────────────────────
create table organisations (
  id          uuid primary key default uuid_generate_v4(),
  name        text not null,
  abn         text,
  phone       text,
  email       text,
  logo_url    text,
  settings_json jsonb default '{}'::jsonb,
  created_at  timestamptz default now(),
  updated_at  timestamptz default now()
);

-- Seed a default org for SecureWorks
insert into organisations (id, name, abn, email) values (
  '00000000-0000-0000-0000-000000000001',
  'SecureWorks WA Pty Ltd',
  '64689223416',
  'admin@secureworkswa.com.au'
);

-- ────────────────────────────────────────────────────────────
-- USERS  (extends Supabase auth.users)
-- ────────────────────────────────────────────────────────────
create table users (
  id          uuid primary key references auth.users(id) on delete cascade,
  org_id      uuid not null references organisations(id) on delete cascade,
  name        text not null,
  email       text not null,
  phone       text,
  role        text not null default 'estimator'
              check (role in ('admin', 'estimator', 'installer')),
  avatar_url  text,
  created_at  timestamptz default now(),
  updated_at  timestamptz default now()
);

create index idx_users_org on users(org_id);

-- ────────────────────────────────────────────────────────────
-- JOBS  (the central entity)
-- ────────────────────────────────────────────────────────────
create table jobs (
  id              uuid primary key default uuid_generate_v4(),
  org_id          uuid not null references organisations(id) on delete cascade,
  created_by      uuid references users(id) on delete set null,
  status          text not null default 'draft'
                  check (status in (
                    'draft', 'quoted', 'accepted', 'scheduled',
                    'in_progress', 'complete', 'invoiced', 'cancelled'
                  )),
  type            text not null default 'patio'
                  check (type in ('fencing', 'patio', 'combo')),
  -- Client details
  client_name     text,
  client_phone    text,
  client_email    text,
  -- Site details
  site_address    text,
  site_suburb     text,
  site_lat        double precision,
  site_lng        double precision,
  -- The big one: entire scoping tool state
  scope_json      jsonb default '{}'::jsonb,
  -- Pricing snapshot (frozen when quote generated)
  pricing_json    jsonb default '{}'::jsonb,
  -- Notes
  notes           text,
  -- GHL link
  ghl_contact_id  text,
  -- Timestamps
  quoted_at       timestamptz,
  accepted_at     timestamptz,
  scheduled_at    timestamptz,
  completed_at    timestamptz,
  created_at      timestamptz default now(),
  updated_at      timestamptz default now()
);

create index idx_jobs_org on jobs(org_id);
create index idx_jobs_status on jobs(status);
create index idx_jobs_created on jobs(created_at desc);
create index idx_jobs_ghl on jobs(ghl_contact_id) where ghl_contact_id is not null;

-- ────────────────────────────────────────────────────────────
-- JOB DOCUMENTS  (versioned PDFs)
-- ────────────────────────────────────────────────────────────
create table job_documents (
  id                  uuid primary key default uuid_generate_v4(),
  job_id              uuid not null references jobs(id) on delete cascade,
  type                text not null
                      check (type in ('quote', 'material_order', 'work_order', 'sheets_order', 'variation')),
  version             int not null default 1,
  pdf_url             text,
  data_snapshot_json  jsonb,
  created_by          uuid references users(id) on delete set null,
  sent_to_client      boolean default false,
  sent_at             timestamptz,
  viewed_at           timestamptz,
  accepted_at         timestamptz,
  declined_at         timestamptz,
  -- Unique link token for client-facing pages
  share_token         text unique default encode(gen_random_bytes(16), 'hex'),
  created_at          timestamptz default now()
);

create index idx_job_docs_job on job_documents(job_id);
create index idx_job_docs_token on job_documents(share_token);

-- ────────────────────────────────────────────────────────────
-- JOB MEDIA  (photos & videos)
-- ────────────────────────────────────────────────────────────
create table job_media (
  id              uuid primary key default uuid_generate_v4(),
  job_id          uuid not null references jobs(id) on delete cascade,
  phase           text not null default 'scope'
                  check (phase in ('scope', 'in_progress', 'completion')),
  type            text not null default 'photo'
                  check (type in ('photo', 'video')),
  storage_url     text not null,
  thumbnail_url   text,
  label           text,
  notes           text,
  lat             double precision,
  lng             double precision,
  taken_at        timestamptz,
  uploaded_by     uuid references users(id) on delete set null,
  created_at      timestamptz default now()
);

create index idx_job_media_job on job_media(job_id);

-- ────────────────────────────────────────────────────────────
-- JOB EVENTS  (audit trail / activity log)
-- ────────────────────────────────────────────────────────────
create table job_events (
  id          uuid primary key default uuid_generate_v4(),
  job_id      uuid not null references jobs(id) on delete cascade,
  user_id     uuid references users(id) on delete set null,
  event_type  text not null,
  detail_json jsonb default '{}'::jsonb,
  created_at  timestamptz default now()
);

create index idx_job_events_job on job_events(job_id);
create index idx_job_events_type on job_events(event_type);

-- ────────────────────────────────────────────────────────────
-- JOB ASSIGNMENTS  (installer scheduling)
-- ────────────────────────────────────────────────────────────
create table job_assignments (
  id              uuid primary key default uuid_generate_v4(),
  job_id          uuid not null references jobs(id) on delete cascade,
  user_id         uuid not null references users(id) on delete cascade,
  role            text not null default 'lead_installer'
                  check (role in ('lead_installer', 'helper', 'estimator')),
  scheduled_date  date,
  notes           text,
  created_at      timestamptz default now(),
  unique(job_id, user_id)
);

create index idx_job_assign_user on job_assignments(user_id);
create index idx_job_assign_date on job_assignments(scheduled_date);

-- ────────────────────────────────────────────────────────────
-- AUTO-UPDATE updated_at TRIGGER
-- ────────────────────────────────────────────────────────────
create or replace function update_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger trg_organisations_updated before update on organisations
  for each row execute function update_updated_at();

create trigger trg_users_updated before update on users
  for each row execute function update_updated_at();

create trigger trg_jobs_updated before update on jobs
  for each row execute function update_updated_at();

-- ════════════════════════════════════════════════════════════
-- ROW LEVEL SECURITY
-- ════════════════════════════════════════════════════════════

alter table organisations enable row level security;
alter table users enable row level security;
alter table jobs enable row level security;
alter table job_documents enable row level security;
alter table job_media enable row level security;
alter table job_events enable row level security;
alter table job_assignments enable row level security;

-- Helper: get the org_id for the current auth user
create or replace function auth_org_id()
returns uuid as $$
  select org_id from users where id = auth.uid();
$$ language sql security definer stable;

-- Helper: get the role for the current auth user
create or replace function auth_role()
returns text as $$
  select role from users where id = auth.uid();
$$ language sql security definer stable;

-- ── Organisations: users can read their own org ──
create policy "Users can view own org"
  on organisations for select
  using (id = auth_org_id());

create policy "Admins can update own org"
  on organisations for update
  using (id = auth_org_id() and auth_role() = 'admin');

-- ── Users: can view team members in same org ──
create policy "Users can view team"
  on users for select
  using (org_id = auth_org_id());

create policy "Users can update own profile"
  on users for update
  using (id = auth.uid());

create policy "Admins can manage users"
  on users for all
  using (org_id = auth_org_id() and auth_role() = 'admin');

-- ── Jobs: org-scoped access ──
create policy "Users can view org jobs"
  on jobs for select
  using (org_id = auth_org_id());

create policy "Estimators+ can create jobs"
  on jobs for insert
  with check (org_id = auth_org_id() and auth_role() in ('admin', 'estimator'));

create policy "Estimators+ can update jobs"
  on jobs for update
  using (org_id = auth_org_id() and auth_role() in ('admin', 'estimator'));

create policy "Admins can delete jobs"
  on jobs for delete
  using (org_id = auth_org_id() and auth_role() = 'admin');

-- ── Job Documents: org-scoped via job ──
create policy "Users can view job docs"
  on job_documents for select
  using (exists (select 1 from jobs where jobs.id = job_documents.job_id and jobs.org_id = auth_org_id()));

create policy "Estimators+ can create docs"
  on job_documents for insert
  with check (exists (select 1 from jobs where jobs.id = job_documents.job_id and jobs.org_id = auth_org_id()));

create policy "Estimators+ can update docs"
  on job_documents for update
  using (exists (select 1 from jobs where jobs.id = job_documents.job_id and jobs.org_id = auth_org_id()));

-- Public read for client-facing quote pages (via share_token)
create policy "Public can view shared docs"
  on job_documents for select
  using (share_token is not null and sent_to_client = true);

-- ── Job Media: org-scoped via job ──
create policy "Users can view job media"
  on job_media for select
  using (exists (select 1 from jobs where jobs.id = job_media.job_id and jobs.org_id = auth_org_id()));

create policy "Users can upload media"
  on job_media for insert
  with check (exists (select 1 from jobs where jobs.id = job_media.job_id and jobs.org_id = auth_org_id()));

create policy "Users can delete own media"
  on job_media for delete
  using (uploaded_by = auth.uid());

-- ── Job Events: org-scoped via job ──
create policy "Users can view job events"
  on job_events for select
  using (exists (select 1 from jobs where jobs.id = job_events.job_id and jobs.org_id = auth_org_id()));

create policy "Users can create events"
  on job_events for insert
  with check (exists (select 1 from jobs where jobs.id = job_events.job_id and jobs.org_id = auth_org_id()));

-- ── Job Assignments: org-scoped via job ──
create policy "Users can view assignments"
  on job_assignments for select
  using (exists (select 1 from jobs where jobs.id = job_assignments.job_id and jobs.org_id = auth_org_id()));

create policy "Admins can manage assignments"
  on job_assignments for all
  using (exists (select 1 from jobs where jobs.id = job_assignments.job_id and jobs.org_id = auth_org_id()) and auth_role() = 'admin');

-- ════════════════════════════════════════════════════════════
-- STORAGE BUCKETS  (run via Supabase dashboard or API)
-- ════════════════════════════════════════════════════════════

-- Create storage buckets
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values
  ('job-photos', 'job-photos', false, 10485760, array['image/jpeg', 'image/png', 'image/webp']),
  ('job-videos', 'job-videos', false, 104857600, array['video/mp4', 'video/quicktime', 'video/webm']),
  ('job-pdfs',   'job-pdfs',   false, 20971520, array['application/pdf'])
on conflict (id) do nothing;

-- Storage policies: org members can read/write their org's files
-- Files are stored as: {org_id}/{job_id}/{filename}
create policy "Org members can read photos"
  on storage.objects for select
  using (bucket_id = 'job-photos' and (storage.foldername(name))[1] = auth_org_id()::text);

create policy "Org members can upload photos"
  on storage.objects for insert
  with check (bucket_id = 'job-photos' and (storage.foldername(name))[1] = auth_org_id()::text);

create policy "Org members can delete photos"
  on storage.objects for delete
  using (bucket_id = 'job-photos' and (storage.foldername(name))[1] = auth_org_id()::text);

create policy "Org members can read videos"
  on storage.objects for select
  using (bucket_id = 'job-videos' and (storage.foldername(name))[1] = auth_org_id()::text);

create policy "Org members can upload videos"
  on storage.objects for insert
  with check (bucket_id = 'job-videos' and (storage.foldername(name))[1] = auth_org_id()::text);

create policy "Org members can read PDFs"
  on storage.objects for select
  using (bucket_id = 'job-pdfs' and (storage.foldername(name))[1] = auth_org_id()::text);

create policy "Org members can upload PDFs"
  on storage.objects for insert
  with check (bucket_id = 'job-pdfs' and (storage.foldername(name))[1] = auth_org_id()::text);

-- ════════════════════════════════════════════════════════════
-- VIEWS  (convenience queries)
-- ════════════════════════════════════════════════════════════

-- Pipeline summary: count of jobs at each status
create or replace view pipeline_summary as
select
  org_id,
  status,
  count(*) as job_count,
  coalesce(sum((pricing_json->>'totalIncGST')::numeric), 0) as total_value
from jobs
group by org_id, status;

-- Upcoming schedule: next 14 days
create or replace view upcoming_schedule as
select
  ja.scheduled_date,
  j.id as job_id,
  j.type,
  j.client_name,
  j.site_suburb,
  j.status,
  u.name as assigned_to,
  ja.role
from job_assignments ja
join jobs j on j.id = ja.job_id
join users u on u.id = ja.user_id
where ja.scheduled_date >= current_date
  and ja.scheduled_date <= current_date + interval '14 days'
order by ja.scheduled_date, j.client_name;
