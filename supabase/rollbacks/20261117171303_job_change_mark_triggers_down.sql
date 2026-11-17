-- Remove an explicitly installed trigger set before removing its definitions.
SET LOCAL lock_timeout = '5s';
SELECT public.job_change_mark_triggers_remove();
DROP FUNCTION IF EXISTS public.job_change_mark_triggers_install();
DROP FUNCTION IF EXISTS public.job_change_mark_triggers_remove();
DROP FUNCTION IF EXISTS public.job_mark_changed_trg();
