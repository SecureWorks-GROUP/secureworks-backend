-- Deliberately let the service role write a raise straight into the table,
-- past raise_job_labour_cap (which checks the approver, the company and the
-- budget): the contract must fail.
GRANT INSERT ON TABLE public.job_labour_cap_raises TO service_role;
