-- Keep the exact live predecessor for delta and rollback checks.
CREATE TABLE IF NOT EXISTS public.worker_mark_reads_preimage (definition text NOT NULL);
TRUNCATE public.worker_mark_reads_preimage;
INSERT INTO public.worker_mark_reads_preimage
SELECT pg_get_functiondef('public.context_worker_state()'::regprocedure);
