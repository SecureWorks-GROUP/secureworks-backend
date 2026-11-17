-- Retain the exact predecessor; the helper delta must not rewrite the RPC.
CREATE TABLE IF NOT EXISTS public.worker_facts_due_preimage (state_definition text, helper_definition text);
TRUNCATE public.worker_facts_due_preimage;
INSERT INTO public.worker_facts_due_preimage SELECT
  pg_get_functiondef('public.context_worker_state()'::regprocedure),
  pg_get_functiondef('public.context_worker_facts_present()'::regprocedure);
