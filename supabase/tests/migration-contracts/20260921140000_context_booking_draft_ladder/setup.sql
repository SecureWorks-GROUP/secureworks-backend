-- Prior registered fixtures supply jobs, business_events, contact_matches,
-- B2 attribution, and B3 persist. These columns are the name-only control
-- and the mint's optional display copy.
ALTER TABLE public.jobs
 ADD COLUMN IF NOT EXISTS client_name text,
 ADD COLUMN IF NOT EXISTS client_phone text,
 ADD COLUMN IF NOT EXISTS client_email text,
 ADD COLUMN IF NOT EXISTS site_address text,
 ADD COLUMN IF NOT EXISTS site_suburb text,
 ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
 ADD COLUMN IF NOT EXISTS ghl_contact_id text;
