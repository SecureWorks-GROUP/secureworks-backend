-- Save the exact main body after 210101 so the contract proves the entire delta.
CREATE TABLE IF NOT EXISTS public.fact_read_state_preimage (definition text NOT NULL);
TRUNCATE public.fact_read_state_preimage;
INSERT INTO public.fact_read_state_preimage
SELECT pg_get_functiondef('public.context_worker_state()'::regprocedure);
