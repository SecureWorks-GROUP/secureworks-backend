-- Rollback of B0 (20260924183000_context_unlinked_census). B0 added only
-- read-only functions and three jobs indexes and wrote no row, so the rollback
-- drops exactly those objects. Nothing else changes.
SET LOCAL lock_timeout = '5s';
DROP FUNCTION IF EXISTS public.context_unlinked_rows(text,text,text,timestamptz,timestamptz,uuid,integer,integer);
DROP FUNCTION IF EXISTS public.context_unlinked_census(integer,text,timestamptz,uuid);
DROP FUNCTION IF EXISTS public.context_census_reasons(text[],text[],uuid[]);
DROP FUNCTION IF EXISTS public.context_bucket_reason(public.business_events);
DROP FUNCTION IF EXISTS public.context_bucket_reason_detail(public.business_events,jsonb);
DROP FUNCTION IF EXISTS public.context_live_site_index(text[]);
DROP FUNCTION IF EXISTS public.context_bucket_text(public.business_events);
DROP FUNCTION IF EXISTS public.context_contact_for_key(text,text);
DROP FUNCTION IF EXISTS public.context_event_identity(public.business_events);
DROP FUNCTION IF EXISTS public.context_event_sender_kind(public.business_events);
DROP FUNCTION IF EXISTS public.context_ref_jobs(text[]);
DROP FUNCTION IF EXISTS public.context_job_ref_tokens(text);
DROP FUNCTION IF EXISTS public.context_address_loose_keys(text);
DROP FUNCTION IF EXISTS public.context_address_key(text);
DROP FUNCTION IF EXISTS public.context_address_mentions(text);
DROP FUNCTION IF EXISTS public.context_street_type(text);
DROP FUNCTION IF EXISTS public.context_email_key(text);
DROP FUNCTION IF EXISTS public.context_phone_key(text);
DROP INDEX IF EXISTS public.jobs_context_job_number_upper;
DROP INDEX IF EXISTS public.jobs_context_phone_right9;
DROP INDEX IF EXISTS public.jobs_context_email_lower;
