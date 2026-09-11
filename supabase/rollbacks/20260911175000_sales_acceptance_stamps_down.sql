-- Preserve all acquired timestamp evidence during rollback. Only retire the new
-- automatic writer; do not erase history or the provenance explaining estimates.
DROP TRIGGER IF EXISTS jobs_preserve_first_acceptance_stamp ON public.jobs;
DROP FUNCTION IF EXISTS public.preserve_first_acceptance_stamp();
