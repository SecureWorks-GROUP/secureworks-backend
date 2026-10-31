-- The company flashing library for the Scope Engine patio tool (T99, W23; 1 Nov 2026).
--
-- Flashings drawn in the patio tool's flashing designer, kept for every job in folders and groups, so a drawing made
-- on one job is used again on the next. One row per drawing: its folder, an optional group, its name, the drawing
-- (scope-engine-v2 FoldedProfile: the fold line's points in mm, the colour face, the edge it was drawn against) and
-- the flat sheet it is folded from (a catalogue product key). No prices, customers or jobs are held here.
--
-- Access: signed-in staff in the scoping roles of their own org read it, add to it and edit or put away its rows.
-- The public (anon) key cannot reach it. Nobody deletes through the API: a row is put away with archived_at, so the
-- library stays a reference. The org, the author and the times are set by the database, not by the page.
-- The roles match catalogue_prices (admin, owner, ops_manager, estimator).

create table if not exists public.flashing_library (
  org_id       uuid        not null default public.auth_org_id(),
  id           uuid        not null default gen_random_uuid(),
  folder       text        not null check (length(btrim(folder)) between 1 and 80),
  group_name   text        check (group_name is null or length(btrim(group_name)) between 1 and 80),
  name         text        not null check (length(btrim(name)) between 1 and 120),
  profile      jsonb       not null check (
                 jsonb_typeof(profile) = 'object'
                 and case when jsonb_typeof(profile -> 'points') = 'array'
                          then jsonb_array_length(profile -> 'points') between 2 and 200
                          else false end
                 and pg_column_size(profile) <= 65536
               ),
  material_key text        check (material_key is null or length(material_key) <= 200),
  created_by   uuid        not null default auth.uid(),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  archived_at  timestamptz,
  primary key (org_id, id)
);

create index if not exists flashing_library_listing
  on public.flashing_library (org_id, folder, group_name, name)
  where archived_at is null;

create or replace function public.flashing_library_touch()
returns trigger language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists flashing_library_touch on public.flashing_library;
create trigger flashing_library_touch
  before update on public.flashing_library
  for each row execute function public.flashing_library_touch();

alter table public.flashing_library enable row level security;

drop policy if exists flashing_library_staff_read on public.flashing_library;
create policy flashing_library_staff_read on public.flashing_library
  for select to authenticated
  using (
    org_id = public.auth_org_id()
    and exists (
      select 1 from public.users u
      where u.id = auth.uid() and lower(u.role) in ('admin', 'owner', 'ops_manager', 'estimator')
    )
  );

drop policy if exists flashing_library_staff_add on public.flashing_library;
create policy flashing_library_staff_add on public.flashing_library
  for insert to authenticated
  with check (
    org_id = public.auth_org_id()
    and created_by = auth.uid()
    and archived_at is null
    and exists (
      select 1 from public.users u
      where u.id = auth.uid() and lower(u.role) in ('admin', 'owner', 'ops_manager', 'estimator')
    )
  );

drop policy if exists flashing_library_staff_edit on public.flashing_library;
create policy flashing_library_staff_edit on public.flashing_library
  for update to authenticated
  using (
    org_id = public.auth_org_id()
    and exists (
      select 1 from public.users u
      where u.id = auth.uid() and lower(u.role) in ('admin', 'owner', 'ops_manager', 'estimator')
    )
  )
  with check (org_id = public.auth_org_id());

revoke all on public.flashing_library from anon;
revoke all on public.flashing_library from authenticated;
grant select on public.flashing_library to authenticated;
grant insert (folder, group_name, name, profile, material_key) on public.flashing_library to authenticated;
grant update (folder, group_name, name, profile, material_key, archived_at) on public.flashing_library to authenticated;
