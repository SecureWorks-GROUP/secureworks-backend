-- B0 setup. Earlier registered fixtures supply jobs (job_number, status,
-- archived, metadata, client_phone, client_email, ghl_contact_id,
-- site_address), business_events (with context_captured_at, recorded_at and
-- candidate_job_ids), contact_matches (phone, email), job_contacts
-- (client_email), xero_invoices, purchase_orders, the P1a candidate functions
-- and K1's context_event_is_ours. Add only the live columns this case reads
-- that the fixtures omit, as read from production 23 Sep 2026:
-- job_contacts.client_phone and job_contacts.ghl_contact_id.
ALTER TABLE public.job_contacts ADD COLUMN IF NOT EXISTS client_phone text,
 ADD COLUMN IF NOT EXISTS ghl_contact_id text;
