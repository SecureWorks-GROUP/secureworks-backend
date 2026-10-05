-- Party roles fixtures. Earlier registered cases supply jobs, job_contacts,
-- business_events, the ladder and its insert trigger, users (id, org_id,
-- name, role, phone) and suppliers (id, name, email). This adds the live
-- columns they omit (users.email, suppliers.phone) and makesafe_companies,
-- with the live column names and types the migration's guard pins.
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS email text;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS phone text;
ALTER TABLE public.suppliers ADD COLUMN IF NOT EXISTS phone text;
CREATE TABLE IF NOT EXISTS public.makesafe_companies (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 org_id uuid,
 slug text NOT NULL UNIQUE,
 name text NOT NULL,
 sender_patterns text[] NOT NULL DEFAULT '{}',
 invoice_email text,
 report_recipient text,
 active boolean NOT NULL DEFAULT true
);
