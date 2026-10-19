-- Down for 20261019230000_quote_accept_atomic. Roll send-quote back first (or
-- confirm quote_accept_atomic_v1 is off): it calls these functions. Export
-- quote_acceptance_attempts first: it is dropped. Acceptances committed
-- through the RPC stay (documents, statuses and job_events are not touched).
-- The supersede trigger's strict raise reads quote_option_strict_record_v1;
-- with the row gone it reads off, which is today's behaviour.
DROP FUNCTION IF EXISTS public.quote_acceptance_gaps(interval);
DROP FUNCTION IF EXISTS public.quote_acceptance_finish_downstream(uuid, text);
DROP FUNCTION IF EXISTS public.accept_quote_document_atomic(uuid, timestamptz, text, text, text, jsonb);
DROP FUNCTION IF EXISTS public.quote_acceptance_fingerprint(uuid);
DROP TABLE IF EXISTS public.quote_acceptance_attempts;
DELETE FROM public.feature_flags WHERE flag_name IN ('quote_accept_atomic_v1', 'quote_option_strict_record_v1');
