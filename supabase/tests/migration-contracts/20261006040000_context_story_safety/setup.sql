-- Prerequisites for 20261006040000_context_story_safety: the CRM conversation
-- cache, as it is live (one row per CRM contact; its messages a JSON array, each
-- message with its own id and timestamp). Every other table and column the new
-- bodies read comes from earlier registered setups: jobs.xero_contact_id and
-- deposit_invoice_id, xero_invoices.line_items and job_contact_id, job_contacts,
-- makesafe_job_details.requesting_company_name, ghl message ids on business_events.
CREATE TABLE IF NOT EXISTS public.ghl_conversation_cache (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid,
  contact_id text NOT NULL,
  messages jsonb NOT NULL DEFAULT '[]'::jsonb,
  message_count integer DEFAULT 0,
  synced_at timestamptz DEFAULT now(),
  created_at timestamptz DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS ghl_conversation_cache_contact_uidx ON public.ghl_conversation_cache (contact_id);
CREATE INDEX IF NOT EXISTS idx_ghl_conv_job ON public.ghl_conversation_cache (job_id);
