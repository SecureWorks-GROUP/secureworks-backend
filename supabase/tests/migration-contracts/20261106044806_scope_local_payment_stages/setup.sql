-- Supabase-style default grants must not survive on these private records or
-- expose internal producers as callable service-role RPCs.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO service_role;
CREATE TABLE IF NOT EXISTS public.job_assignments(id uuid PRIMARY KEY DEFAULT gen_random_uuid());
ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS pricing_json jsonb;
ALTER TABLE public.job_assignments
  ADD COLUMN IF NOT EXISTS job_id uuid,
  ADD COLUMN IF NOT EXISTS user_id uuid,
  ADD COLUMN IF NOT EXISTS scheduled_date date,
  ADD COLUMN IF NOT EXISTS status text,
  ADD COLUMN IF NOT EXISTS is_ghost boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS role text,
  ADD COLUMN IF NOT EXISTS assignment_type text;
CREATE TABLE IF NOT EXISTS public.council_submissions(id uuid PRIMARY KEY DEFAULT gen_random_uuid());
ALTER TABLE public.council_submissions
  ADD COLUMN IF NOT EXISTS org_id uuid,
  ADD COLUMN IF NOT EXISTS job_id uuid,
  ADD COLUMN IF NOT EXISTS steps jsonb;
