-- Stop new work while retaining the budget, receipts and attempts for audit.
UPDATE public.automation_switches SET extraction=false,attribution=false,updated_at=now(),note='B1 run ledger rollback';
REVOKE EXECUTE ON FUNCTION public.claim_context_extraction_run(uuid,date,text),public.claim_context_pass(date),public.renew_context_pass(date,uuid) FROM service_role;
-- No tables dropped: future replay must not mistake already processed evidence for new.
