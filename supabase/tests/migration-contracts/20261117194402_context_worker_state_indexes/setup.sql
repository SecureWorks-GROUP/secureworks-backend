-- Keep the exact preceding state body for delta and rollback assertions.
CREATE TABLE IF NOT EXISTS public.worker_state_followup_preimage (definition text NOT NULL);
TRUNCATE public.worker_state_followup_preimage;
INSERT INTO public.worker_state_followup_preimage
SELECT pg_get_functiondef('public.context_worker_state()'::regprocedure);
