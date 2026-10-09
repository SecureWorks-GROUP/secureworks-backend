-- makesafe_companies as live, on top of the narrow table earlier cases declare
-- (20261005200000_context_party_roles). Adds only the live columns those cases
-- omit. The live parsing-rule coverage CHECK is asserted on the row in
-- contract.sql rather than installed here, because earlier contracts insert
-- fixture builders without parsing rules.
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
ALTER TABLE public.makesafe_companies
  ADD COLUMN IF NOT EXISTS safety_requirements text,
  ADD COLUMN IF NOT EXISTS special_instructions text,
  ADD COLUMN IF NOT EXISTS external_links jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS parsing_rules jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS billing_rules jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
