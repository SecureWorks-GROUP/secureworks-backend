DROP TRIGGER IF EXISTS context_job_created_reconsider ON public.jobs;
DROP TRIGGER IF EXISTS context_attribute_business_event ON public.business_events;
DROP FUNCTION public.context_extraction_candidates(integer);
DROP FUNCTION public.context_extraction_events(uuid,integer);
DROP FUNCTION public.attribute_context_event_with_luna(uuid,uuid,numeric);
DROP FUNCTION public.context_job_created_reconsider();
DROP FUNCTION public.rerun_context_attribution(integer,text);
DROP FUNCTION public.attribute_business_event();
DROP FUNCTION public.resolve_context_attribution(public.business_events);
DROP FUNCTION public.context_attribution_jobs(text);
DROP FUNCTION public.context_contact_jobs(text);
DROP FUNCTION public.context_event_text(public.business_events);
-- Keep captured evidence, attribution and thread custody for audit. Rollback disables new writers.
