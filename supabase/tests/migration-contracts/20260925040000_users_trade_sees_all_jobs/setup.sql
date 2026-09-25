-- public.users already exists from earlier registered cases (id, org_id,
-- name, role, managed_verticals). The fixtures below exist BEFORE the
-- migration runs, because its backfill only acts on pre-existing rows.
INSERT INTO public.users (id, org_id, name, role, managed_verticals) VALUES
  ('f5000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-0000000000aa', 'Admin (contract)', 'admin', ARRAY['fencing']::text[]),
  ('f5000000-0000-4000-8000-000000000002', 'e0000000-0000-4000-8000-0000000000aa', 'Owner (contract)', 'owner', ARRAY[]::text[]),
  ('f5000000-0000-4000-8000-000000000003', 'e0000000-0000-4000-8000-0000000000aa', 'Ops manager (contract)', 'ops_manager', ARRAY[]::text[]),
  ('f5000000-0000-4000-8000-000000000004', 'e0000000-0000-4000-8000-0000000000aa', 'Lead installer (contract)', 'lead_installer', ARRAY['fencing']::text[]),
  ('f5000000-0000-4000-8000-000000000005', 'e0000000-0000-4000-8000-0000000000aa', 'Crew (contract)', 'crew', ARRAY['makesafe']::text[]),
  ('f5000000-0000-4000-8000-000000000006', 'e0000000-0000-4000-8000-0000000000aa', 'No role (contract)', NULL, ARRAY[]::text[]);
