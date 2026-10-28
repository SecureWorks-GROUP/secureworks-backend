-- Put the fencing-only CHECK back: a patio mint must then fail the contract.
ALTER TABLE public.fence_job_mint_requests DROP CONSTRAINT fence_job_mint_requests_type_check;
ALTER TABLE public.fence_job_mint_requests ADD CONSTRAINT fence_job_mint_requests_type_check CHECK (type = 'fencing');
