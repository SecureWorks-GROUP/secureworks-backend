-- Prerequisites for 20261019130000_context_ledger_same_payer_close. It reads jobs, job_contacts,
-- xero_invoices, job_events, business_events, makesafe_job_details, makesafe_companies,
-- job_closeout_state, feature_flags and the context ledger tables, which the earlier registered
-- setups and migrations create, except one live column the contract stack never gained:
-- makesafe_job_details.requesting_company_id (production carries it, a uuid naming the
-- makesafe_companies row; see AGENTS.md "A Wrong Column Name Reads As No Data").
ALTER TABLE public.makesafe_job_details ADD COLUMN IF NOT EXISTS requesting_company_id uuid;
