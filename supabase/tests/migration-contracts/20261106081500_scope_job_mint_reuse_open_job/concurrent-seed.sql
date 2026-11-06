-- Committed fixtures for the concurrent sessions; concurrent-check.sql removes them.
INSERT INTO public.organisations (id, name) VALUES ('00000000-0000-4000-8000-0000000000e1', 'Concurrent mint org')
  ON CONFLICT (id) DO NOTHING;
INSERT INTO public.users (id, org_id, name) VALUES
  ('00000000-0000-4000-8000-0000000000f1', '00000000-0000-4000-8000-0000000000e1', 'Concurrent scoper')
  ON CONFLICT (id) DO NOTHING;
