-- L1 reads jobs.metadata (holding marker), xero_invoices (type and number) and
-- purchase_orders. Earlier registered fixtures create all three; add only the
-- columns this case relies on in case a narrower fixture won the CREATE race.
ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
 ADD COLUMN IF NOT EXISTS ghl_contact_id text;
ALTER TABLE public.xero_invoices ADD COLUMN IF NOT EXISTS invoice_number text,
 ADD COLUMN IF NOT EXISTS invoice_type text, ADD COLUMN IF NOT EXISTS job_id uuid;
CREATE TABLE IF NOT EXISTS public.purchase_orders(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),job_id uuid,po_number text);
-- Start from production's pre-image: the live body, not the repository body.
\ir production-preimage.sql
