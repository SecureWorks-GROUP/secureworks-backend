-- The company flashing library for the Scope Engine patio tool (T99, W23; 1 Nov 2026).
--
-- Flashings drawn in the patio tool's flashing designer, kept for every job in folders and groups, so a drawing made
-- on one job is used again on the next. One row per drawing: its folder, an optional group, its name, the drawing
-- (scope-engine-v2 FoldedProfile: the fold line's points in mm, the colour face, the edge it was drawn against) and
-- the flat sheet it is folded from (a catalogue product key). No prices, customers or jobs are held here.
--
-- Access: signed-in staff in the scoping roles of their own org read it, add to it and edit or put away its rows.
-- The public (anon) key cannot reach it. Nobody deletes through the API: a row is put away with archived_at, so the
-- library stays a reference. The org, the author and the times are set by the database, not by the page, and an
-- update keeps the org and the author (the column grants refuse them, and so does the update policy).
-- The roles are catalogue_prices' scoping roles that a user can hold: admin, ops_manager, estimator. ('owner' is in
-- catalogue_prices' list but is not a users role: users_role_check, 20260322000005_fix_user_roles.sql.)
-- One drawing a name per folder and group: an active row's folder, group and name, ignoring case and outer spaces,
-- are unique in its org; a row put away frees its name.
--
-- Undo (while the table is new; it loses the library's rows):
--   drop table if exists public.flashing_library;
--   drop function if exists public.flashing_library_author(uuid, uuid);
--   drop function if exists public.flashing_library_touch();

create table if not exists public.flashing_library (
  org_id       uuid        not null default public.auth_org_id() references public.organisations (id),
  id           uuid        not null default gen_random_uuid(),
  folder       text        not null constraint flashing_library_folder_check check (length(btrim(folder)) between 1 and 80),
  group_name   text        constraint flashing_library_group_name_check check (group_name is null or length(btrim(group_name)) between 1 and 80),
  name         text        not null constraint flashing_library_name_check check (length(btrim(name)) between 1 and 120),
  profile      jsonb       not null constraint flashing_library_profile_check check (
                 jsonb_typeof(profile) = 'object'
                 and case when jsonb_typeof(profile -> 'points') = 'array'
                          then jsonb_array_length(profile -> 'points') between 2 and 200
                          else false end
                 and pg_column_size(profile) <= 65536
               ),
  material_key text        constraint flashing_library_material_key_check check (material_key is null or length(material_key) <= 200),
  created_by   uuid        not null default auth.uid(),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  archived_at  timestamptz,
  primary key (org_id, id)
);

create index if not exists flashing_library_listing
  on public.flashing_library (org_id, folder, group_name, name)
  where archived_at is null;

create unique index if not exists flashing_library_one_active_name
  on public.flashing_library (org_id, lower(btrim(folder)), lower(btrim(coalesce(group_name, ''))), lower(btrim(name)))
  where archived_at is null;

create or replace function public.flashing_library_touch()
returns trigger language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.updated_at := now();
  new.created_at := old.created_at;
  return new;
end;
$$;

-- The stored author of a row, for the update policy (a policy cannot read its own table: that recurses). Security
-- definer so it reads the stored row past row level security, as catalogue_prices_staff_load does; search_path
-- pinned. Because it reads past row level security, it applies the read policy's own test itself: it answers only to
-- a caller in a scoping role (admin, ops_manager, estimator), for a row in the caller's own org, and null to anyone
-- else. Crew and sales in the same org cannot read the table, so they get null for any id, as does another org.
create or replace function public.flashing_library_author(p_org uuid, p_id uuid)
returns uuid language sql stable security definer
set search_path = public, pg_temp
as $$
  select f.created_by from public.flashing_library f
  where f.org_id = p_org and f.id = p_id and f.org_id = public.auth_org_id()
    and exists (
      select 1 from public.users u
      where u.id = auth.uid() and lower(u.role) in ('admin', 'ops_manager', 'estimator')
    );
$$;

revoke all on function public.flashing_library_author(uuid, uuid) from public;
revoke all on function public.flashing_library_author(uuid, uuid) from anon;
grant execute on function public.flashing_library_author(uuid, uuid) to authenticated;

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
      where u.id = auth.uid() and lower(u.role) in ('admin', 'ops_manager', 'estimator')
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
      where u.id = auth.uid() and lower(u.role) in ('admin', 'ops_manager', 'estimator')
    )
  );

drop policy if exists flashing_library_staff_edit on public.flashing_library;
create policy flashing_library_staff_edit on public.flashing_library
  for update to authenticated
  using (
    org_id = public.auth_org_id()
    and exists (
      select 1 from public.users u
      where u.id = auth.uid() and lower(u.role) in ('admin', 'ops_manager', 'estimator')
    )
  )
  -- The row stays in the editor's org under its author (the stored row's, read by flashing_library_author), so an
  -- update that changes created_by is refused even if its column grant were widened.
  with check (
    org_id = public.auth_org_id()
    and created_by = public.flashing_library_author(org_id, id)
  );

revoke all on public.flashing_library from anon;
revoke all on public.flashing_library from authenticated;
grant select on public.flashing_library to authenticated;
grant insert (folder, group_name, name, profile, material_key) on public.flashing_library to authenticated;
grant update (folder, group_name, name, profile, material_key, archived_at) on public.flashing_library to authenticated;
