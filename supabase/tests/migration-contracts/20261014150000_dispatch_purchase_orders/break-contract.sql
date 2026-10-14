-- Let the browser read the held drafts; the contract must then fail on the privilege check.
GRANT SELECT ON TABLE public.job_order_emails TO authenticated;
