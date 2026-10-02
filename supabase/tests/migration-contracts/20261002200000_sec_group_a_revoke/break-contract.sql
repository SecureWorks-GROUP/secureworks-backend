-- Deliberately reopen one function to the public key; contract.sql must fail.
GRANT EXECUTE ON FUNCTION public.get_job_financials(uuid) TO anon;
