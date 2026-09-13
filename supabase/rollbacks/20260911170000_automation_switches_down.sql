-- Explicit operator rollback only: restore scheduled commands, retain operator history.
SELECT * FROM public.automation_switch_unwrap_cron_jobs();
UPDATE public.automation_switches SET all_stop=true,updated_at=now(),note='B1 rolled back; retained for audit';
-- Keep the fail-closed helper for any not-yet-rolled-back callers.
