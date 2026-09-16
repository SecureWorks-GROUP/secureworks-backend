-- Disable v2 admissions, preserve all fact/revision history and the filtered view.
-- Re-enabling the old unfiltered view would resurrect retired or expired memory.
UPDATE public.automation_switches SET extraction=false,updated_at=now(),note='B3 custody rollback';
REVOKE EXECUTE ON FUNCTION public.persist_luna_context_revision(uuid,uuid,uuid,jsonb,jsonb,jsonb,jsonb,text,integer) FROM service_role;
DROP TRIGGER IF EXISTS context_fact_stamp_trust ON public.job_context;
DROP TRIGGER IF EXISTS context_fact_stamp_trust ON public.job_temporary_context;
-- Old five-argument source custody RPC remains installed with its original gates.
-- Columns, backfilled trust/expiry values and the nine-kind check stay: they are additive audit truth.
