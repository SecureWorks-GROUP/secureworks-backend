-- Retain named judgments and pending transport receipts; stop automatic sampling.
REVOKE EXECUTE ON FUNCTION public.context_accuracy_draw(date),public.record_context_accuracy_verdict(date,uuid,text,text,uuid,boolean) FROM service_role;
-- Read-only status, current facts and existing tripwire holds remain available.
