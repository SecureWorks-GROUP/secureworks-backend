-- Let the browser read the Dispatch stage; the contract must then fail on the privilege check.
GRANT SELECT ON TABLE public.job_dispatch_state TO authenticated;
