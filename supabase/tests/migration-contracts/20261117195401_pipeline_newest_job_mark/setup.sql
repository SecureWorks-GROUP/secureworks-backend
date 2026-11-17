-- Minimal prerequisites for this single-folder local contract. The registered
-- stack already provides these relations; never replace its real definitions.
DO $roles$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role; END IF;
END $roles$;
CREATE TABLE IF NOT EXISTS public.jobs (
 id uuid PRIMARY KEY, org_id uuid NOT NULL, type text, status text, job_number text
);
CREATE TABLE IF NOT EXISTS public.job_change_mark_events (
 job_id uuid NOT NULL, marked_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 source text NOT NULL, page_pending boolean NOT NULL DEFAULT true
);
